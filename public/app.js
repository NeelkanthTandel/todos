(() => {
  const $ = id => document.getElementById(id);
  const NS = window.TodoStorage?.config.namespace || "todos";
  const LS_KEY = NS + ".v1";
  const LANES = [
    { k: "h", name: "Boiling over",        short: "Boiling",     sub: "Do it today, ideally",  empty: "Nothing boiling over. Suspicious, but enjoy it." },
    { k: "m", name: "Simmering",           short: "Simmering",   sub: "This week",            empty: "Nothing simmering. The pot is calm." },
    { k: "l", name: "Back burner",         short: "Back burner", sub: "Whenever, really",     empty: "Back burner is clear." },
    { k: "n", name: "Still in the fridge", short: "Fridge",      sub: "Not sorted yet",       empty: "Fridge is empty. Pasted lists land here so you can sort them." },
  ];
  const LANE = Object.fromEntries(LANES.map(l => [l.k, l]));
  const ORDER = LANES.map(l => l.k);

  const ICON = {
    check: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.2 5 8.5l4.5-5"/></svg>',
    cross: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/></svg>',
    move:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3 2 6l3 3M2 6h9M11 13l3-3-3-3M14 10H5"/></svg>',
    wip:   '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="5.6"/><path d="M8 2.4a5.6 5.6 0 0 1 0 11.2z" fill="currentColor" stroke="none"/></svg>',
    grip:  '<svg viewBox="0 0 8 14" fill="currentColor"><circle cx="2" cy="2" r="1.2"/><circle cx="6" cy="2" r="1.2"/><circle cx="2" cy="7" r="1.2"/><circle cx="6" cy="7" r="1.2"/><circle cx="2" cy="12" r="1.2"/><circle cx="6" cy="12" r="1.2"/></svg>',
    plus:  '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M7 2.5v9M2.5 7h9"/></svg>',
    session: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.25"/><path d="m4.75 6.25 2 1.75-2 1.75M8.5 10h2.75"/></svg>',
  };
  function heat(k) {
    if (k === "n") return '<svg class="heat" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M7 1.5v11M2.2 4.2l9.6 5.6M2.2 9.8l9.6-5.6"/></svg>';
    const lvl = { h: 3, m: 2, l: 1 }[k];
    let s = '<svg class="heat" viewBox="0 0 14 13" fill="currentColor">';
    [[0, 8, 5], [5, 4, 9], [10, 0, 13]].forEach(([x, y, h], i) => {
      s += '<rect x="' + x + '" y="' + y + '" width="3.4" height="' + h + '" rx="1" opacity="' + (i < lvl ? 1 : .22) + '"/>';
    });
    return s + "</svg>";
  }

  // ---------- state ----------
  let items = [];               // {id, text, done, prio, created, doneAt?, wip?, session?}
  // A board someone shared with you, while you're looking at it (see "live sharing" below). `items` stays your
  // own list the whole time; the shared board is only ever rendered, never edited.
  let viewing = null;
  const viewItems = () => (viewing ? viewing.items : items);
  let editingId = null, justId = null, enterIds = new Set(), landedId = null;
  const linger = new Map();     // id -> timer: just-done items still shown in lane
  const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } };
  // Every list from outside this tab (localStorage, an imported file, the server) passes through here, so a
  // corrupted or crafted value can't break the page: known fields only, right types, safe unique ids.
  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const num = v => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const SESSION_RE = /^[\w-]{1,64}$/;
  const STATES = { running: "Running", needs_you: "Needs you", your_turn: "Your turn", ended: "Ended" };
  // A todo added from a Claude Code session keeps a link to it: { id, state, project, kind, updatedAt }.
  // Control and bidirectional formatting characters: stripped from names and titles so they can't reorder text.
  const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
  function normSession(s) {
    if (!s || typeof s !== "object" || typeof s.id !== "string" || !SESSION_RE.test(s.id)) return null;
    return {
      id: s.id,
      state: Object.hasOwn(STATES, s.state) ? s.state : "ended",
      project: typeof s.project === "string" ? s.project.trim().slice(0, 120) : "",
      kind: s.kind === "cloud" ? "cloud" : "local",
      updatedAt: Math.min(num(s.updatedAt), Date.now()), // a clock running ahead can't pin a status forever
    };
  }
  function normalize(arr) {
    if (!Array.isArray(arr)) return [];
    const seen = new Set(), out = [];
    for (const t of arr) {
      if (!t || typeof t.id !== "string" || !ID_RE.test(t.id) || seen.has(t.id)) continue;
      if (typeof t.text !== "string" || !t.text.trim()) continue;
      seen.add(t.id);
      const done = t.done === true, created = num(t.created);
      const todo = { id: t.id, text: t.text.trim().slice(0, 500), done, prio: ORDER.includes(t.prio) ? t.prio : "n", created };
      if (done) todo.doneAt = num(t.doneAt) || created;
      else if (t.wip === true) todo.wip = true;
      const session = normSession(t.session);
      if (session) todo.session = session;
      todo.pos = typeof t.pos === "number" && Number.isFinite(t.pos) ? t.pos : null;
      todo.updated = num(t.updated) || todo.doneAt || created;
      out.push(todo);
    }
    // Lists saved before positions existed keep their order: a todo without one goes after the last in its lane.
    const end = {};
    for (const t of out) if (t.pos !== null) end[t.prio] = Math.max(end[t.prio] ?? -Infinity, t.pos);
    for (const t of out) if (t.pos === null) t.pos = end[t.prio] = (end[t.prio] ?? 0) + 1;
    return sortByPos(out);
  }
  // Each lane is ordered by `pos`, then id, so two devices order the same list the same way.
  function sortByPos(list) { return list.sort((a, b) => a.pos - b.pos || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); }
  // Deletions are kept as tombstones { id, deleted: true, updated } for 30 days, so a device that synced late
  // can't bring a deleted todo back.
  const TOMB_TTL = 30 * 864e5;
  function normTombs(arr) {
    const out = new Map();
    for (const r of Array.isArray(arr) ? arr : []) {
      if (r && r.deleted === true && typeof r.id === "string" && ID_RE.test(r.id) && num(r.updated) > 0) out.set(r.id, Math.max(out.get(r.id) || 0, r.updated));
    }
    return out;
  }
  // A list from another device: todos and tombstones, validated, ready for TodoStorage.merge().
  function decodeDoc(arr) {
    if (!Array.isArray(arr)) return [];
    const live = normalize(arr.filter(r => !(r && r.deleted === true)));
    return live.concat([...normTombs(arr)].map(([id, updated]) => ({ id, deleted: true, updated })));
  }
  const TOMBS_KEY = NS + ".tombs";
  let tombs = new Map(); // id -> when it was deleted
  try { items = normalize(JSON.parse(lsGet(LS_KEY) || "[]")); } catch { items = []; }
  try { tombs = normTombs(JSON.parse(lsGet(TOMBS_KEY) || "[]")); } catch {}
  const tombList = () => [...tombs].map(([id, updated]) => ({ id, deleted: true, updated }));
  const docRecords = () => items.concat(tombList());

  // Every save compares the list with the last one saved: a todo that changed gets a new `updated`, and one that's
  // gone leaves a tombstone. That covers every kind of change in one place, undo and redo included.
  let saved = new Map(); // id -> { sig, updated } as last saved or taken from elsewhere
  // A session status change isn't an edit of the todo: device sync merges `session` by its own updatedAt
  // (TodoStorage.merge), so it can't override a real edit made on another device.
  const sigOf = t => { const { updated, session, ...rest } = t; return JSON.stringify(session ? [rest, session.id, session.project, session.kind] : rest); };
  function markSaved() { saved = new Map(items.map(t => [t.id, { sig: sigOf(t), updated: t.updated }])); }
  markSaved();
  function stamp() {
    const now = Date.now(), ids = new Set();
    for (const t of items) {
      ids.add(t.id);
      if (typeof t.pos !== "number" || !Number.isFinite(t.pos)) t.pos = laneEnd(t.prio, t.id);
      const was = saved.get(t.id), sig = sigOf(t);
      if (was && was.sig === sig) { t.updated = was.updated; continue; }
      t.updated = Math.max(now, was ? was.updated + 1 : 0, (tombs.get(t.id) || 0) + 1);
      tombs.delete(t.id);
    }
    for (const [id, was] of saved) if (!ids.has(id)) tombs.set(id, Math.max(now, was.updated + 1));
    for (const [id, at] of tombs) if (now - at > TOMB_TTL) tombs.delete(id);
    markSaved();
  }
  function laneEnd(prio, except) {
    let end = 0;
    for (const t of items) if (t.prio === prio && t.id !== except && typeof t.pos === "number") end = Math.max(end, t.pos);
    return end + 1;
  }
  let pick = ORDER.includes(lsGet(NS + ".pick")) ? lsGet(NS + ".pick") : "n";
  let multiPick = null;

  // ---------- sync ----------
  // localStorage is always written (instant load, works offline). A remote store from storage.js mirrors the list
  // on top of it: the HTTP store in config.js (whole list, newest wins), or device sync over the relay (merged per
  // todo, see TodoStorage.relaySync), which replaces it while it's on.
  const baseRemote = window.TodoStorage?.remote || null;
  let remote = baseRemote, unsubscribe = null;
  const PENDING_KEY = NS + ".pending", SYNCED_KEY = NS + ".synced";
  let docRef = null, writing = false, dirty = false, dragId = null, storageFull = false;
  const setStatus = t => { $("status").textContent = t; };
  setStatus("Saved in this browser");
  // `updated` of the newest list this browser has sent or received; older server replies are stale.
  const syncedAt = () => +lsGet(SYNCED_KEY) || 0;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const backoff = n => Math.min(30000, 1000 * 2 ** n) * (0.75 + Math.random() / 2);
  async function flush() {
    if (!docRef || writing) return;
    const store = docRef;
    writing = true;
    let tries = 0;
    while (dirty && docRef === store) {
      dirty = false;
      const updated = Math.max(Date.now(), syncedAt() + 1);
      try {
        const r = await store.set({ items: store.merges ? docRecords() : items, updated });
        if (docRef !== store) break;
        lsSet(SYNCED_KEY, String(updated));
        if (r && Array.isArray(r.items)) takeRemote(r.items); // it merged in another device's list first
        if (!dirty) { lsSet(PENDING_KEY, ""); setStatus("Synced"); }
        tries = 0;
      } catch (e) {
        if (docRef !== store) break;
        if (e && e.code === "unavailable") { dirty = true; setStatus("Offline. Retrying…"); await sleep(backoff(tries++)); continue; }
        if (e && e.code === "gone") { syncGone(e.status); break; }
        setStatus("Couldn't sync. Saved in this browser."); docRef = null;
      }
    }
    writing = false;
    window.dispatchEvent(new Event("todos:flushed")); // lets tests/smoke.html know a save reached the store
  }
  function save() {
    queued = null; // our own change wins over a list another tab sent mid-drag
    stamp();
    lsSet(TOMBS_KEY, JSON.stringify(tombList()));
    if (!lsSet(LS_KEY, JSON.stringify(items))) {
      setStatus("Browser storage is full. Changes aren't saved.");
      if (!storageFull) toast("Browser storage is full. Export a backup, then clear some done todos.");
      storageFull = true;
    } else storageFull = false;
    scheduleShares();
    if (!remote) return;
    lsSet(PENDING_KEY, "1");
    if (docRef) { dirty = true; setStatus("Saving…"); flush(); }
  }
  // Take a list saved elsewhere (another tab, another device). During a drag the board can't re-render,
  // so it waits for the drop; an open edit keeps what you've typed so far.
  let queued = null, adopting = false;
  function adopt(next, nextTombs) {
    if (dragId) { queued = [next, nextTombs]; return; }
    queued = null;
    next = normalize(next);
    if (nextTombs) { tombs = nextTombs; lsSet(TOMBS_KEY, JSON.stringify(tombList())); }
    // The same todos with their fields in another order (another tab's write-back) is no change: keep undo.
    if (JSON.stringify(next) === JSON.stringify(items) || (window.TodoStorage && TodoStorage.sameDoc(next, items))) { markSaved(); return; }
    const ed = editingId && $("edit-" + editingId);
    const draft = ed && [ed.value, ed.selectionStart, ed.selectionEnd];
    if (editingId && !next.some(t => t.id === editingId)) editingId = null;
    items = next;
    markSaved();
    past.length = 0; future.length = 0; // older snapshots would undo the other tab's work
    lsSet(LS_KEY, JSON.stringify(items));
    scheduleShares();
    adopting = true; render(); adopting = false;
    const ed2 = draft && editingId && $("edit-" + editingId);
    if (ed2) { ed2.value = draft[0]; requestAnimationFrame(() => ed2.setSelectionRange(draft[1], draft[2])); }
  }
  // Device sync: merge another device's list with ours, per todo. If ours had anything theirs didn't, push it.
  function takeRemote(records) {
    const merged = TodoStorage.merge(docRecords(), records);
    adopt(merged.filter(r => !r.deleted), new Map(merged.filter(r => r.deleted).map(r => [r.id, r.updated])));
    // Compared after this device's own 30-day cut, so a tombstone that only another device (with a slower
    // clock) still keeps doesn't count as a difference and get sent back and forth.
    if (!TodoStorage.sameDoc(merged, TodoStorage.merge(records, []))) dirty = true;
  }
  async function connect() {
    const store = remote;
    for (let tries = 0; ; tries++) {
      try {
        const first = await store.get();
        if (remote !== store) return;
        docRef = store;
        if (store.merges) {
          takeRemote(first.items);
          if (dirty) { setStatus("Saving…"); flush(); } else setStatus("Synced");
        } else {
          const has = first && Array.isArray(first.items) && (first.items.length > 0 || num(first.updated) > 0);
          if (has && !(lsGet(PENDING_KEY) && items.length)) {
            lsSet(SYNCED_KEY, String(num(first.updated)));
            adopt(first.items); setStatus("Synced");
          } else if (items.length) { dirty = true; flush(); } // this browser has changes the server hasn't seen
          else setStatus("Synced");
        }
        break;
      } catch (e) {
        if (remote !== store) return;
        if (e && e.code === "gone") { syncGone(e.status); return; }
        if (!(e && e.code === "unavailable")) { setStatus("Couldn't reach server. Saved in this browser."); return; }
        setStatus("Offline. Retrying…"); await sleep(backoff(tries));
      }
    }
    unsubscribe = store.subscribe(data => {
      if (remote !== store || !data) return;
      if (store.merges) {
        if (data.gone) syncGone();
        else if (docRef === store && Array.isArray(data.items)) {
          takeRemote(data.items);
          if (dirty) { setStatus("Saving…"); flush(); }
        }
        window.dispatchEvent(new Event("todos:syncmsg")); // lets tests/smoke.html know a list was handled
        return;
      }
      if (writing || dirty || !docRef || !Array.isArray(data.items)) return;
      if (num(data.updated) <= syncedAt()) return; // nothing newer than what we already have
      lsSet(SYNCED_KEY, String(num(data.updated)));
      adopt(data.items);
    });
  }
  // Swap the remote store (device sync turned on or off).
  function setRemote(store) {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    docRef = null; dirty = false; remote = store;
    if (remote) { setStatus("Connecting…"); connect(); } else setStatus("Saved in this browser");
  }
  if (remote) connect();
  // Another tab of this browser saved: pick up its list.
  window.addEventListener("storage", e => {
    if (e.key !== LS_KEY) return;
    let next, t = null;
    try { next = JSON.parse(e.newValue || "[]"); } catch { return; }
    try { t = normTombs(JSON.parse(lsGet(TOMBS_KEY) || "[]")); } catch {}
    // With device sync every todo carries its change time, so the two tabs' lists merge, even while this tab is
    // still saving or offline.
    // Nothing new is uploaded from here: the other tab uploads its own changes, and if it can't (offline, then
    // closed), they're in this tab's list now and go up with this tab's next save, retry or reload.
    if (remote && remote.merges) {
      const was = dirty, before = docRecords();
      takeRemote(decodeDoc(Array.isArray(next) ? next.concat([...(t || [])].map(([id, updated]) => ({ id, deleted: true, updated }))) : []));
      // Mid-upload, though, the list being sent predates this change: go round once more so it goes up too.
      dirty = was || (writing && !TodoStorage.sameDoc(docRecords(), before));
      return;
    }
    if (writing || dirty) return;
    adopt(next, t);
  });

  // ---------- helpers ----------
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const find = id => items.find(t => t.id === id);
  const announce = msg => { $("live").textContent = ""; requestAnimationFrame(() => { $("live").textContent = msg; }); };
  const inLane = t => !t.done || linger.has(t.id);

  // ---------- list parsing ----------
  const MARKER = /^\s*(?:[-*+•◦▪‣–—>]|\(?\d{1,3}[.):]|\(?[a-zA-Z][.)]|\(?(?:i{1,3}|iv|v|vi{1,3}|ix|x)[.)])\s+/i;
  const BOX = /^\s*\[([ xX✓✔]?)\]\s*/;
  function parse(raw) {
    const lines = raw.replace(/\r\n?/g, "\n").split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length <= 1 && !/^\s*(?:[-*+•◦▪]\s+|\[[ xX]?\]\s*)/.test(raw)) {
      const one = (lines[0] || "").slice(0, 500);
      return one ? [{ text: one, done: false }] : [];
    }
    const out = [];
    for (let l of lines) {
      let done = false;
      for (let i = 0; i < 3; i++) {
        const before = l;
        l = l.replace(MARKER, "");
        const m = l.match(BOX);
        if (m) { done = done || /[xX✓✔]/.test(m[1]); l = l.slice(m[0].length); }
        if (l === before) break;
      }
      l = l.trim();
      if (l) out.push({ text: l.slice(0, 500), done });
    }
    return out;
  }

  // ---------- render ----------
  function buildBoard() {
    $("board").innerHTML = LANES.map(l =>
      '<section class="lane" data-prio="' + l.k + '" aria-labelledby="lane-' + l.k + '">' +
        '<div class="lane-head">' + heat(l.k) +
          '<div class="lane-title"><h2 id="lane-' + l.k + '">' + l.name + '</h2><p>' + l.sub + '</p></div>' +
          '<span class="lane-count" id="count-' + l.k + '">0</span>' +
          '<button class="expand" data-lane="' + l.k + '" aria-pressed="false"></button>' +
        '</div>' +
        '<div class="lane-body"><ul class="items" id="list-' + l.k + '" aria-labelledby="lane-' + l.k + '"></ul>' +
        '<p class="lane-empty" id="empty-' + l.k + '">' + l.empty + '</p></div>' +
      '</section>').join("");
    $("pick").innerHTML = LANES.map((l, i) =>
      '<button type="button" role="radio" data-prio="' + l.k + '" aria-checked="false" title="' + l.name + ' (Alt+' + (i + 1) + ')">' +
      heat(l.k) + '<span>' + l.short + '</span></button>').join("");
  }

  function row(t, inPanel) {
    if (viewing) return viewRow(t, inPanel);
    const li = document.createElement("li");
    li.dataset.id = t.id; li.dataset.prio = t.prio;
    if (t.done) li.classList.add("done");
    if (t.id === justId) li.classList.add("just");
    if (enterIds.has(t.id)) li.classList.add("enter");
    if (t.id === landedId) li.classList.add("landed");
    if (!inPanel && editingId !== t.id) li.draggable = true;

    if (!inPanel) {
      const g = document.createElement("span"); g.className = "grip"; g.setAttribute("aria-hidden", "true"); g.innerHTML = ICON.grip;
      li.append(g);
    }
    const cb = document.createElement("button");
    cb.className = "check"; cb.dataset.act = "toggle";
    cb.setAttribute("role", "checkbox"); cb.setAttribute("aria-checked", String(!!t.done));
    cb.setAttribute("aria-label", (t.done ? "Mark not done: " : "Mark done: ") + t.text);
    cb.innerHTML = ICON.check;
    li.append(cb);

    if (editingId === t.id) {
      const inp = document.createElement("input");
      inp.className = "edit"; inp.id = "edit-" + t.id; inp.value = t.text; inp.maxLength = 500;
      inp.setAttribute("aria-label", "Edit todo");
      li.append(inp);
      requestAnimationFrame(() => { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); });
    } else {
      const txt = document.createElement("button");
      txt.className = "text"; txt.dataset.act = "edit"; txt.setAttribute("aria-label", "Edit: " + t.text);
      const s = document.createElement("span"); s.textContent = t.text; txt.append(s);
      li.append(txt);
    }

    if (t.session && !inPanel) li.append(badge(t.session));
    if (t.wip && !t.done && !inPanel) {
      li.classList.add("wip");
      const chip = document.createElement("button");
      chip.className = "chip"; chip.dataset.act = "wip"; chip.textContent = "In progress";
      chip.title = "Click to stop (S)"; chip.setAttribute("aria-label", "In progress. Click to stop.");
      li.append(chip);
    }
    if (inPanel) {
      const tag = document.createElement("span"); tag.className = "tag";
      tag.innerHTML = heat(t.prio); tag.append(LANE[t.prio].short);
      li.append(tag);
    }
    const acts = document.createElement("div"); acts.className = "acts";
    if (!inPanel) acts.innerHTML =
      (t.done ? "" : '<button class="act' + (t.wip ? " wip-on" : "") + '" data-act="wip" aria-pressed="' + !!t.wip + '" aria-label="' + (t.wip ? "Stop progress: " : "Start: ") + esc(t.text) + '" title="' + (t.wip ? "Stop progress (S)" : "Mark in progress (S)") + '">' + ICON.wip + '</button>') +
      '<button class="act move" data-act="move" aria-haspopup="menu" aria-label="Move: ' + esc(t.text) + '" title="Move to… (1–4)">' + ICON.move + '</button>';
    acts.insertAdjacentHTML("beforeend", '<button class="act del" data-act="delete" aria-label="Delete: ' + esc(t.text) + '" title="Delete">' + ICON.cross + '</button>');
    li.append(acts);
    return li;
  }
  function esc(s) { return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  function render() {
    const all = viewItems();
    for (const l of LANES) {
      const list = all.filter(t => t.prio === l.k && inLane(t));
      $("list-" + l.k).replaceChildren(...list.map(t => row(t, false)));
      $("empty-" + l.k).hidden = list.length > 0;
      $("empty-" + l.k).textContent = viewing ? "Nothing here." : l.empty;
      $("count-" + l.k).textContent = all.filter(t => t.prio === l.k && !t.done).length;
    }
    const open = all.filter(t => !t.done).length;
    const done = all.filter(t => t.done).length;
    $("summary").textContent = all.length ? open + " open" : "";
    $("doneN").textContent = done;
    renderPanel();
    updateTitle();
    justId = null; enterIds = new Set(); landedId = null;
  }

  function dayLabel(ts) {
    const d = new Date(ts), now = new Date();
    const start = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((start(now) - start(d)) / 864e5);
    if (diff <= 0) return "Today";
    if (diff === 1) return "Yesterday";
    return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  }
  function renderPanel() {
    const body = $("panelBody");
    const done = viewItems().filter(t => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    $("clearDone").hidden = done.length === 0 || !!viewing;
    if (!done.length) { body.innerHTML = '<p class="panel-empty">Nothing done yet. Tick a todo and it lands here.</p>'; return; }
    const frag = document.createDocumentFragment();
    let cur = null, ul = null;
    for (const t of done) {
      // A shared board carries no timestamps, so its done todos are one group.
      const lbl = viewing ? "Done on " + possessive(viewing.name) + " board" : dayLabel(t.doneAt || t.created || Date.now());
      if (lbl !== cur) {
        cur = lbl;
        const h = document.createElement("h3"); h.textContent = lbl; frag.append(h);
        ul = document.createElement("ul"); ul.className = "items"; frag.append(ul);
      }
      ul.append(row(t, true));
    }
    body.replaceChildren(frag);
  }

  // ---------- actions ----------
  function add(raw, prio) {
    if (blocked()) return 0;
    const parsed = parse(raw); if (!parsed.length) return 0;
    const before = snap();
    const now = Date.now(), end = laneEnd(prio);
    parsed.forEach((p, i) => {
      const t = { id: uid(), text: p.text, done: p.done, prio, created: now + i };
      if (p.done) t.doneAt = now + i;
      t.pos = end + i;
      items.push(t); enterIds.add(t.id);
    });
    record(parsed.length === 1 ? "add" : "add " + parsed.length + " todos", before);
    save(); render();
    const first = document.querySelector("#list-" + prio + " li.enter");
    if (first) first.scrollIntoView({ block: "nearest" });
    announce(parsed.length === 1 ? "Added to " + LANE[prio].name : "Added " + parsed.length + " todos to " + LANE[prio].name);
    return parsed.length;
  }

  function toggle(id) {
    if (blocked()) return;
    const t = find(id); if (!t) return;
    const before = snap();
    t.done = !t.done;
    record(t.done ? "mark done" : "mark not done", before);
    if (t.done) {
      t.doneAt = Date.now(); justId = id; delete t.wip;
      clearTimeout(linger.get(id));
      linger.set(id, setTimeout(() => {
        const li = document.querySelector('.board li[data-id="' + CSS.escape(id) + '"]');
        if (li) li.classList.add("leaving");
        setTimeout(() => { linger.delete(id); if (!editingId) render(); }, 240);
      }, 900));
      const b = $("doneBtn"); b.classList.remove("bump"); void b.offsetWidth; b.classList.add("bump");
      announce("Marked done");
    } else {
      delete t.doneAt; clearTimeout(linger.get(id)); linger.delete(id);
      landedId = id; announce("Moved back to " + LANE[t.prio].name);
    }
    save(); render();
  }

  function remove(id) {
    if (blocked()) return;
    const i = items.findIndex(t => t.id === id); if (i < 0) return;
    const before = snap();
    items.splice(i, 1); linger.delete(id);
    record("delete", before);
    save(); render();
    toast("Todo deleted", "Undo", undo);
  }

  function moveTo(id, prio, beforeId) {
    if (blocked()) return;
    const t = find(id); if (!t) return;
    const before = snap();
    const from = t.prio; t.prio = prio;
    t.pos = posBefore(prio, beforeId, id);
    sortByPos(items);
    landedId = id;
    record(from !== prio ? "move to " + LANE[prio].name : "reorder", before);
    save(); render();
    if (from !== prio) announce("Moved to " + LANE[prio].name);
  }

  // Where a todo dropped before `beforeId` (or at the end of a lane) goes: halfway between its new neighbours, so a
  // move only changes that one todo and moves made on two devices at once both survive a merge.
  function posBefore(prio, beforeId, id) {
    const lane = items.filter(x => x.prio === prio && x.id !== id);
    const i = beforeId ? lane.findIndex(x => x.id === beforeId) : -1;
    if (i < 0) return lane.length ? lane[lane.length - 1].pos + 1 : 1;
    const hi = lane[i].pos, lo = i > 0 ? lane[i - 1].pos : hi - 1;
    const mid = lo + (hi - lo) / 2;
    if (mid > lo && mid < hi) return mid;
    lane.forEach((x, k) => { x.pos = k + 1; }); // no room left between the two numbers: renumber the lane
    return posBefore(prio, beforeId, id);
  }

  function commitEdit(id, value, cancel) {
    if (blocked()) { editingId = null; render(); return; }
    const t = find(id); editingId = null;
    if (t && !cancel) {
      const v = value.trim();
      if (!v) { render(); remove(id); return; }
      if (v !== t.text) { const before = snap(); t.text = v; record("edit", before); save(); }
    }
    render(); focusRow(id);
  }
  function focusRow(id, sel = ".text") {
    if (viewing) sel = ".act"; // a shared row's only button
    const el = document.querySelector('li[data-id="' + CSS.escape(id) + '"] ' + sel);
    if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: "nearest" }); }
  }

  // ---------- composer ----------
  const input = $("new");
  function effectivePick(n) { return n > 1 ? (multiPick || "n") : pick; }
  function syncInput() {
    input.style.height = "auto";
    input.style.height = input.scrollHeight + "px";
    const n = parse(input.value).length;
    if (n <= 1) multiPick = null;
    const eff = effectivePick(n);
    for (const b of $("pick").children) b.setAttribute("aria-checked", String(b.dataset.prio === eff));
    $("addBtn").disabled = n === 0;
    $("addBtn").textContent = (n > 1 ? "Add " + n : "Add") + (clip ? " from clipboard" : "");
    $("addForm").classList.toggle("tall", input.scrollHeight > 48);
    const m = $("multi");
    if (n > 1) {
      m.hidden = false;
      m.innerHTML = "<b>" + n + " todos</b> found, one per line. They go to " + LANE[eff].name + " unless you pick a heat. Shift+Enter adds a line.";
    } else m.hidden = true;
  }
  function setPick(k) {
    const n = parse(input.value).length;
    if (n > 1) multiPick = k; else { pick = k; lsSet(NS + ".pick", k); }
    syncInput();
  }
  $("pick").addEventListener("click", e => {
    const b = e.target.closest("button[data-prio]"); if (!b) return;
    setPick(b.dataset.prio); input.focus();
  });
  input.addEventListener("input", () => {
    typedAt = performance.now();
    if (clip && input.value !== clip.text) endClip(); // typed over it or deleted it
    syncInput();
  });
  input.addEventListener("focus", () => { typedAt = performance.now(); });
  input.addEventListener("keydown", e => {
    if (clip && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); dismissClip(); announce("Clipboard suggestion dismissed"); return; }
    if (clip && e.key === "Tab" && !e.shiftKey) { e.preventDefault(); endClip(); input.setSelectionRange(input.value.length, input.value.length); return; }
    // Composer empty and the mouse moved onto a todo since you last typed: shortcuts go to that todo.
    if (!input.value && !e.metaKey && !e.ctrlKey && !e.altKey && ptrMovedAt > typedAt && /^([1-4sSxXeE]|Delete|Enter)$/.test(e.key)) {
      const card = hoveredCard();
      if (card && trayAction(card, e.key, true)) { e.preventDefault(); return; }
      const li = e.key !== "Enter" && hoveredRow();
      if (li && rowAction(li, e.key, true)) { e.preventDefault(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("addForm").requestSubmit(); return; }
    if (e.altKey && /^Digit[1-4]$/.test(e.code)) { e.preventDefault(); setPick(ORDER[+e.code.slice(5) - 1]); }
    if (e.key === "Escape") input.blur();
  });
  $("addForm").addEventListener("submit", e => {
    e.preventDefault();
    if (blocked()) return;
    const n0 = parse(input.value).length;
    const prio = effectivePick(n0);
    const n = add(input.value, prio);
    endClip();
    input.value = ""; multiPick = null; syncInput(); input.focus(); typedAt = performance.now();
    if (n > 1) toast("Added " + n + " todos to " + LANE[prio].short, "Undo", undo);
  });

  // ---------- clipboard suggestions (opt-in, Chromium only) ----------
  // Come back to the tab with something new copied and it waits in the composer, selected: Enter adds it,
  // Backspace, Esc or typing dismiss it, Tab keeps it as a draft. Only Chromium can read the clipboard without
  // a click every time, so other browsers never see this. Handled text is remembered as a hash, never as text.
  const CLIP_KEY = NS + ".clip", CLIP_SEEN_KEY = NS + ".clipSeen", CLIP_FRESH_KEY = NS + ".clipFresh";
  const CLIP_EXPIRE = 10 * 60e3; // a copy older than this is stale, like Gboard's clipboard suggestions
  let clipSupported = false, clipBusy = false, clipTimer = null;
  let clip = null; // { hash, text } while a suggestion is showing
  const clipSeen = new Set();
  try { for (const h of JSON.parse(lsGet(CLIP_SEEN_KEY) || "[]")) if (typeof h === "string") clipSeen.add(h); } catch {}
  const clipOn = () => clipSupported && lsGet(CLIP_KEY) === "on";

  async function sha256(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  }
  function rememberClip(hash) {
    clipSeen.delete(hash); clipSeen.add(hash);
    while (clipSeen.size > 50) clipSeen.delete(clipSeen.values().next().value);
    lsSet(CLIP_SEEN_KEY, JSON.stringify([...clipSeen]));
  }
  // When this clipboard text was first seen, so a copy from an hour ago isn't offered after a reload.
  function firstSeen(hash) {
    let fresh = null;
    try { fresh = JSON.parse(lsGet(CLIP_FRESH_KEY) || "null"); } catch {}
    if (!fresh || fresh.hash !== hash || typeof fresh.at !== "number") {
      fresh = { hash, at: Date.now() };
      lsSet(CLIP_FRESH_KEY, JSON.stringify(fresh));
    }
    return fresh.at;
  }
  const composerIdle = () => !input.value && !editingId && !dragId &&
    (document.activeElement === input || document.activeElement === document.body || !document.activeElement);

  async function suggestFromClipboard() {
    try { await lookAtClipboard(); }
    finally { window.dispatchEvent(new Event("todos:clipcheck")); } // lets tests/smoke.html know a check finished
  }
  async function lookAtClipboard() {
    if (viewing || !clipOn() || clipBusy || clip || document.visibilityState !== "visible" || !composerIdle()) return;
    clipBusy = true;
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) return;
      const hash = await sha256(text);
      const age = Date.now() - firstSeen(hash);
      if (clipSeen.has(hash) || age > CLIP_EXPIRE || !TodoClipboard.check(text).ok) return;
      const lower = text.toLowerCase();
      if (items.some(t => t.text.toLowerCase() === lower)) return;
      if (!composerIdle() || viewing) return; // you started something (or switched boards) while we were reading
      showClip(hash, text, CLIP_EXPIRE - age);
    } catch {
      // Not focused, or permission withdrawn: try again next time, unless access is now blocked for good.
      try { if ((await navigator.permissions.query({ name: "clipboard-read" })).state === "denied") setClip("off"); } catch {}
    } finally { clipBusy = false; }
  }
  function showClip(hash, text, ttl) {
    clip = { hash, text };
    input.value = text;
    $("addForm").classList.add("from-clip");
    $("clipNote").hidden = false;
    syncInput();
    input.focus(); input.select();
    announce("Suggested from your clipboard: " + text.slice(0, 80) + ". Enter adds it, Escape dismisses it.");
    clearTimeout(clipTimer);
    clipTimer = setTimeout(() => { if (clip && input.value === clip.text) dismissClip(); }, ttl);
  }
  // The suggestion is over (added, kept as a draft, dismissed or expired): never offer that text again.
  function endClip() {
    if (!clip) return;
    rememberClip(clip.hash);
    clip = null; clearTimeout(clipTimer);
    $("addForm").classList.remove("from-clip");
    $("clipNote").hidden = true;
    syncInput();
  }
  function dismissClip() { endClip(); input.value = ""; syncInput(); }

  function setClip(state) {
    lsSet(CLIP_KEY, state);
    if (state !== "on" && clip) dismissClip();
    const t = $("clipToggle");
    t.hidden = !clipSupported || !lsGet(CLIP_KEY);
    t.textContent = "Clipboard suggestions: " + (state === "on" ? "on" : "off");
    t.setAttribute("aria-pressed", String(state === "on"));
  }
  // Turning it on reads the clipboard once from your click, so the browser asks for permission in context.
  async function enableClip() {
    $("clipOffer").hidden = true;
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (text) rememberClip(await sha256(text)); // you've just pasted or seen this one
      setClip("on");
      toast("Clipboard suggestions are on. Copy something, then come back here.");
    } catch {
      setClip("off");
      toast("Clipboard access wasn't allowed, so suggestions stay off");
    }
    input.focus();
  }
  input.addEventListener("paste", () => { if (!viewing && clipSupported && !lsGet(CLIP_KEY)) $("clipOffer").hidden = false; });
  $("clipOn").addEventListener("click", enableClip);
  $("clipNo").addEventListener("click", () => { $("clipOffer").hidden = true; setClip("off"); input.focus(); });
  $("clipToggle").addEventListener("click", () => {
    if (lsGet(CLIP_KEY) === "on") { setClip("off"); toast("Clipboard suggestions are off"); } else enableClip();
  });
  window.addEventListener("focus", suggestFromClipboard);
  document.addEventListener("visibilitychange", suggestFromClipboard);
  (async () => {
    // Only Chromium knows the "clipboard-read" permission; Firefox and Safari throw here.
    try { await navigator.permissions.query({ name: "clipboard-read" }); clipSupported = !!(navigator.clipboard?.readText && crypto.subtle); } catch {}
    if (clipSupported && lsGet(CLIP_KEY)) setClip(lsGet(CLIP_KEY));
    suggestFromClipboard();
  })();

  // ---------- list interactions ----------
  function onClick(e) {
    const btn = e.target.closest("[data-act]"); if (!btn) return;
    const li = btn.closest("li"); const id = li.dataset.id;
    const act = btn.dataset.act;
    if (viewing) { if (act === "copy") copyToMine([id]); else blocked(); return; }
    if (act === "toggle") { toggle(id); requestAnimationFrame(() => focusRow(id, ".check")); }
    else if (act === "delete") remove(id);
    else if (act === "edit") { editingId = id; render(); }
    else if (act === "move") openMenu(btn, id);
    else if (act === "wip") { toggleWip(id); focusRow(id, ".text"); }
    else if (act === "session") copyResume(id);
  }
  function toggleWip(id) {
    if (blocked()) return;
    const t = find(id); if (!t || t.done) return;
    const before = snap();
    t.wip = !t.wip; if (!t.wip) delete t.wip;
    record(t.wip ? "mark in progress" : "stop progress", before);
    save(); render();
    announce(t.wip ? "Marked in progress" : "No longer in progress");
  }
  function onKey(e) {
    const t = e.target;
    if (t.classList.contains("edit")) {
      const id = t.closest("li").dataset.id;
      if (e.key === "Enter") { e.preventDefault(); commitEdit(id, t.value); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); commitEdit(id, "", true); }
      return;
    }
    const li = t.closest("li[data-id]"); if (!li || e.metaKey || e.ctrlKey || e.altKey) return;
    const inBoard = !!li.closest(".board");
    const k = e.key;
    if (rowAction(li, k, false)) { e.preventDefault(); return; }
    if (k === "ArrowDown" || k === "ArrowUp") {
      e.preventDefault();
      const sib = k === "ArrowDown" ? li.nextElementSibling : li.previousElementSibling;
      if (sib && sib.dataset.id) focusRow(sib.dataset.id, "." + [...t.classList][0]);
    } else if (inBoard && (k === "ArrowLeft" || k === "ArrowRight")) {
      e.preventDefault();
      let i = ORDER.indexOf(li.closest(".lane").dataset.prio);
      for (let step = 0; step < 3; step++) {
        i = (i + (k === "ArrowRight" ? 1 : 3)) % 4;
        const first = $("list-" + ORDER[i]).querySelector("li[data-id]");
        if (first && first.offsetParent) { focusRow(first.dataset.id); break; }
      }
    }
  }
  // One place for row shortcuts, used by a focused row and by the row under the mouse.
  // viaHover: act without moving keyboard focus (so the composer keeps it).
  function rowAction(li, k, viaHover) {
    const id = li.dataset.id;
    const inBoard = !!li.closest(".board");
    if (viewing) {
      if (k === "c" || k === "C") { copyToMine([id]); return true; }
      if (/^([1-4sSxXeE]|Delete|Backspace)$/.test(k)) { blocked(); return true; }
      return false;
    }
    const keep = sel => { if (!viaHover) focusRow(id, sel); };
    if (inBoard && /^[1-4]$/.test(k)) { if (find(id)?.prio !== ORDER[+k - 1]) moveTo(id, ORDER[+k - 1]); keep(); return true; }
    if (inBoard && (k === "s" || k === "S")) { toggleWip(id); keep(); return true; }
    if (k === "x" || k === "X") { toggle(id); keep(".check"); return true; }
    if (k === "e" || k === "E") { editingId = id; render(); return true; }
    if (k === "Delete" || k === "Backspace") {
      const nxt = li.nextElementSibling || li.previousElementSibling;
      remove(id); if (!viaHover && nxt && nxt.dataset.id) focusRow(nxt.dataset.id);
      return true;
    }
    return false;
  }

  // Track where the mouse is, so shortcuts can hit the hovered todo.
  let ptr = null, ptrMovedAt = 0, typedAt = 0;
  document.addEventListener("pointermove", e => {
    if (e.pointerType === "touch") return;
    ptr = { x: e.clientX, y: e.clientY }; ptrMovedAt = performance.now();
  }, { passive: true });
  document.documentElement.addEventListener("pointerleave", () => { ptr = null; });
  window.addEventListener("blur", () => { ptr = null; });
  function hoveredRow() {
    if (!ptr || dragId || editingId) return null;
    const el = document.elementFromPoint(ptr.x, ptr.y);
    const li = el && el.closest("li[data-id]");
    if (!li) return null;
    if (li.closest(".board") && $("panel").classList.contains("open")) return null;
    return li;
  }

  function onBlur(e) {
    if (adopting || !e.target.classList.contains("edit")) return;
    const id = e.target.closest("li")?.dataset.id;
    if (id && editingId === id) commitEdit(id, e.target.value);
  }
  for (const el of [$("board"), $("panelBody")]) {
    el.addEventListener("click", onClick);
    el.addEventListener("keydown", onKey);
    el.addEventListener("focusout", onBlur);
  }

  // ---------- drag & drop ----------
  const board = $("board");
  let ph = null;
  function clearDrag() {
    dragId = null;
    document.querySelectorAll(".lane.over").forEach(l => l.classList.remove("over"));
    document.querySelectorAll("li.dragging").forEach(l => l.classList.remove("dragging"));
    if (ph) { ph.remove(); ph = null; }
  }
  board.addEventListener("dragstart", e => {
    const li = e.target.closest && e.target.closest("li[data-id]");
    if (!li || editingId || viewing) { e.preventDefault(); if (viewing) blocked(); return; }
    dragId = li.dataset.id; closeMenu();
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", find(dragId)?.text || ""); } catch {}
    requestAnimationFrame(() => li.classList.add("dragging"));
  });
  board.addEventListener("dragover", e => {
    if (!dragId) return;
    const lane = e.target.closest(".lane"); if (!lane) return;
    e.preventDefault(); e.dataTransfer.dropEffect = "move";
    document.querySelectorAll(".lane.over").forEach(l => { if (l !== lane) l.classList.remove("over"); });
    lane.classList.add("over");
    const ul = lane.querySelector(".items");
    const rows = [...ul.querySelectorAll("li[data-id]:not(.dragging)")];
    const grid = lane.classList.contains("focus") && getComputedStyle(ul).display === "grid";
    const before = rows.find(r => {
      const b = r.getBoundingClientRect();
      if (!b.height) return false;
      if (!grid) return e.clientY < b.top + b.height / 2;
      return e.clientY < b.top || (e.clientY < b.bottom && e.clientX < b.left + b.width / 2);
    }) || null;
    if (!ph) { ph = document.createElement("li"); ph.className = "ph"; ph.setAttribute("aria-hidden", "true"); }
    if (ph.parentNode !== ul || ph.nextElementSibling !== before) ul.insertBefore(ph, before);
  });
  board.addEventListener("drop", e => {
    if (!dragId || viewing) return;
    const lane = e.target.closest(".lane"); if (!lane) return;
    e.preventDefault();
    let beforeId = null;
    if (ph && ph.parentNode) {
      let n = ph.nextElementSibling;
      while (n && (!n.dataset.id || n.classList.contains("dragging"))) n = n.nextElementSibling;
      beforeId = n ? n.dataset.id : null;
    }
    const id = dragId; clearDrag();
    moveTo(id, lane.dataset.prio, beforeId);
  });
  document.addEventListener("dragend", () => { clearDrag(); if (queued) adopt(...queued); });
  board.addEventListener("dragleave", e => { if (!board.contains(e.relatedTarget)) { document.querySelectorAll(".lane.over").forEach(l => l.classList.remove("over")); if (ph) { ph.remove(); ph = null; } } });

  // ---------- expand a group ----------
  const EXPAND_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9"/></svg>';
  const COLLAPSE_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 6.5h-4v-4M9.5 6.5l4-4M2.5 9.5h4v4M6.5 9.5l-4 4"/></svg>';
  let focusLane = ORDER.includes(lsGet(NS + ".focus")) ? lsGet(NS + ".focus") : null;
  function applyFocus() {
    board.classList.toggle("expanded", !!focusLane);
    for (const lane of board.querySelectorAll(".lane")) {
      const k = lane.dataset.prio, on = k === focusLane;
      lane.classList.toggle("focus", on);
      const b = lane.querySelector(".expand");
      b.setAttribute("aria-pressed", String(on));
      b.innerHTML = on ? COLLAPSE_ICON : EXPAND_ICON;
      b.title = on ? "Collapse (Esc)" : "Expand " + LANE[k].name + " (hover + F)";
      b.setAttribute("aria-label", on ? "Collapse " + LANE[k].name : "Expand " + LANE[k].name);
    }
  }
  function setFocus(k) {
    focusLane = k === focusLane ? null : k;
    lsSet(NS + ".focus", focusLane || "");
    closeMenu(); applyFocus();
    announce(focusLane ? LANE[focusLane].name + " expanded" : "Showing all groups");
  }
  board.addEventListener("click", e => {
    const exp = e.target.closest(".expand");
    if (exp) { setFocus(exp.dataset.lane); return; }
    const head = e.target.closest(".lane-head");
    const lane = head && head.closest(".lane");
    if (lane && focusLane && !lane.classList.contains("focus")) setFocus(lane.dataset.prio);
  });

  // ---------- move menu ----------
  const menu = $("menu");
  let menuFor = null, menuBtn = null;
  function openMenu(btn, id) {
    const t = find(id); if (!t) return;
    menuFor = id; menuBtn = btn;
    menu.innerHTML = '<p>Move to</p>' + LANES.map((l, i) =>
      '<button role="menuitem" data-prio="' + l.k + '"' + (l.k === t.prio ? ' aria-current="true"' : "") + '>' +
      heat(l.k) + '<span>' + l.name + (l.k === t.prio ? " (here)" : "") + '</span><kbd>' + (i + 1) + '</kbd></button>').join("");
    placeMenu(btn);
    (menu.querySelector('button:not([aria-current="true"])') || menu.querySelector("button")).focus();
  }
  function placeMenu(btn) {
    menu.hidden = false;
    const r = btn.getBoundingClientRect(), mw = menu.offsetWidth, mh = menu.offsetHeight;
    let left = Math.min(r.right - mw, window.innerWidth - mw - 8); left = Math.max(8, left);
    let top = r.bottom + 6; if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    menu.style.left = left + "px"; menu.style.top = top + "px";
  }
  function closeMenu(refocus) {
    if (menu.hidden) return;
    menu.hidden = true;
    if (refocus && menuBtn && document.contains(menuBtn)) menuBtn.focus();
    menuFor = null; menuBtn = null;
  }
  menu.addEventListener("click", e => {
    const x = e.target.closest("button[data-export]");
    if (x) { closeMenu(true); exportAs(x.dataset.export); return; }
    if (switcherClick(e)) return;
    const b = e.target.closest("button[data-prio]"); if (!b) return;
    const id = menuFor; closeMenu();
    if (find(id)?.prio !== b.dataset.prio) moveTo(id, b.dataset.prio);
    focusRow(id);
  });
  menu.addEventListener("keydown", e => {
    const btns = [...menu.querySelectorAll("button")];
    const i = btns.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
    else if (/^[1-4]$/.test(e.key)) { e.preventDefault(); btns[+e.key - 1]?.click(); }
    else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
  });
  document.addEventListener("pointerdown", e => { if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('[data-act="move"], #exportBtn, #switchBtn')) closeMenu(); });
  window.addEventListener("resize", () => { closeMenu(); syncInput(); });
  board.addEventListener("scroll", () => closeMenu(), true);

  // ---------- done panel ----------
  const panel = $("panel"), scrim = $("scrim");
  let panelReturn = null;
  function openPanel() {
    panelReturn = document.activeElement;
    panel.inert = false; panel.classList.add("open"); scrim.classList.add("open");
    $("doneBtn").setAttribute("aria-expanded", "true");
    setTimeout(() => $("closePanel").focus(), 50);
  }
  function closePanel() {
    panel.classList.remove("open"); scrim.classList.remove("open"); panel.inert = true;
    $("doneBtn").setAttribute("aria-expanded", "false"); resetClear();
    if (panelReturn && document.contains(panelReturn)) panelReturn.focus();
  }
  $("doneBtn").addEventListener("click", () => panel.classList.contains("open") ? closePanel() : openPanel());
  $("closePanel").addEventListener("click", closePanel);
  scrim.addEventListener("click", closePanel);

  let clearTimer = null;
  function resetClear() { const c = $("clearDone"); c.classList.remove("confirm"); c.textContent = "Clear all"; clearTimeout(clearTimer); }
  $("clearDone").addEventListener("click", () => {
    if (blocked()) return;
    const c = $("clearDone");
    if (!c.classList.contains("confirm")) {
      c.classList.add("confirm"); c.textContent = "Click again to clear";
      clearTimeout(clearTimer); clearTimer = setTimeout(resetClear, 3000); return;
    }
    const before = snap();
    const n = items.filter(t => t.done).length;
    items = items.filter(t => !t.done);
    record("clear done", before);
    save(); render();
    toast(n === 1 ? "Cleared 1 done todo" : "Cleared " + n + " done todos", "Undo", undo);
  });

  // ---------- export: plain text, or a JSON backup ----------
  const EXPORTS = [
    { k: "copy", name: "Copy as text" },
    { k: "txt", name: "Download as text (.txt)" },
    { k: "json", name: "Download backup (.json)" },
  ];
  const SHARE_EXPORTS = [
    { k: "share", name: "Share live link…" },
    { k: "shares", name: "Shared links" },
  ];
  $("exportBtn").addEventListener("click", e => {
    if (!menu.hidden && menuBtn === e.currentTarget) { closeMenu(); return; }
    closeMenu();
    menuFor = null; menuBtn = e.currentTarget;
    // Viewing a shared board: text only (a backup is of your own list). With a relay: live sharing.
    const list = viewing ? EXPORTS.filter(x => x.k !== "json") : EXPORTS.concat(relay ? SHARE_EXPORTS.filter(x => x.k === "share" || ownShares().length) : []);
    menu.innerHTML = '<p>Export</p>' + list.map((x, i) =>
      '<button role="menuitem" data-export="' + x.k + '"><span>' + x.name + '</span><kbd>' + (i + 1) + '</kbd></button>').join("");
    placeMenu(e.currentTarget);
    menu.querySelector("button").focus();
  });
  // Plain text, one group per lane (p1 = Boiling over … p4 = Fridge), numbered. Done todos follow the open ones,
  // struck through with a combining long stroke (U+0336) so it survives being pasted anywhere.
  const strike = s => [...s].map(c => c + "\u0336").join("");
  function asText() {
    const groups = [];
    LANES.forEach((l, i) => {
      const open = viewItems().filter(t => t.prio === l.k && !t.done).map(t => t.text);
      const done = viewItems().filter(t => t.prio === l.k && t.done)
        .sort((a, b) => (a.doneAt || 0) - (b.doneAt || 0)).map(t => strike(t.text));
      const lines = [...open, ...done];
      if (lines.length) groups.push("p" + (i + 1) + "\n\n" + lines.map((x, j) => (j + 1) + ". " + x).join("\n"));
    });
    return groups.join("\n\n\n") + "\n";
  }
  function download(name, type, content) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  async function exportAs(kind) {
    if (kind === "share") { openShareDialog(null); return; }
    if (kind === "shares") { openSharesDialog(); return; }
    const all = viewItems();
    if (!all.length) { toast("Nothing to export yet"); return; }
    if (viewing && kind === "json") return; // a backup is of your own list
    const count = all.length + (all.length === 1 ? " todo" : " todos");
    const day = new Date().toISOString().slice(0, 10);
    if (kind === "copy") {
      const text = asText();
      try { await navigator.clipboard.writeText(text); }
      catch { toast("Couldn't copy. Try Download as text instead."); return; }
      toast("Copied " + count + " as text");
      // Don't offer your own export back as a clipboard suggestion.
      if (crypto.subtle) rememberClip(await sha256(text.trim()));
    } else if (kind === "txt") {
      download("todos-" + day + ".txt", "text/plain;charset=utf-8", asText());
      toast("Exported " + count + " as text");
    } else {
      // File shape: { app: "todos", version: 1, exported, items: Todo[] }. A bare Todo[] imports too.
      download("todos-" + day + ".json", "application/json", JSON.stringify({ app: "todos", version: 1, exported: new Date().toISOString(), items }, null, 2));
      toast("Exported " + count);
    }
  }

  // ---------- import a JSON backup ----------
  const MAX_IMPORT_BYTES = 2e6, MAX_IMPORT_ITEMS = 5000;
  $("importBtn").addEventListener("click", () => { if (!blocked()) $("importFile").click(); });
  $("importFile").addEventListener("change", async e => {
    const file = e.target.files[0]; e.target.value = "";
    if (!file || blocked()) return;
    if (file.size > MAX_IMPORT_BYTES) { toast("That file is too big to import (2 MB max)"); return; }
    let incoming;
    try {
      const data = JSON.parse(await file.text());
      incoming = Array.isArray(data) ? data : data && data.items;
      if (!Array.isArray(incoming)) throw 0;
    } catch { toast("That file isn't a todos export"); return; }
    if (incoming.length > MAX_IMPORT_ITEMS) { toast("That file has more than " + MAX_IMPORT_ITEMS + " todos"); return; }
    const raw = incoming;
    incoming = normalize(incoming);
    if (!incoming.length) { toast("No todos in that file"); return; }
    if (blocked()) return; // switched to a shared board while the file was read
    // Merge by id: a todo in the file replaces the same todo here, everything else is kept.
    const before = snap();
    const byId = new Map(incoming.map(t => [t.id, t]));
    // Todos from a file without positions (older backups) keep their place here, or go to the end of their lane.
    const placed = new Set(raw.filter(t => t && typeof t.pos === "number").map(t => t.id));
    items = items.map(t => {
      const n = byId.get(t.id);
      if (n && !placed.has(n.id)) n.pos = t.pos;
      return n || t;
    });
    const have = new Set(items.map(t => t.id));
    for (const t of incoming) {
      if (have.has(t.id)) continue;
      if (!placed.has(t.id)) t.pos = laneEnd(t.prio);
      items.push(t);
    }
    sortByPos(items);
    record("import", before);
    save(); render();
    toast("Imported " + incoming.length + (incoming.length === 1 ? " todo" : " todos"), "Undo", undo);
  });

  // ---------- Claude Code sessions ----------
  // With the Claude Code plugin connected (claude-plugin/ in the repo), every session sends encrypted events to
  // this board's inbox on the relay (relay.js). A new session waits in the tray as a suggestion; once added, its
  // todo shows the session's live status. Decrypted messages are untrusted: validated strictly, shown as text.
  const INBOX_KEY = NS + ".inbox", SESS_KEY = NS + ".sessions";
  const EVENT_STATE = { start: "your_turn", suggest: "running", running: "running", needs_you: "needs_you", your_turn: "your_turn", ended: "ended" };
  const ENDED_TTL = 24 * 3600e3, IDLE_TTL = 7 * 24 * 3600e3, MAX_SESSIONS = 200;
  const ADD_SESSION = "add Claude session";
  let relay = null, inbox = null, sub = null, trayEdit = null;
  const handled = new Set();

  // Known sessions, newest status per id: normSession() fields plus title, suggested, dismissed, added, startedAt.
  let sessions = loadSessions();
  function loadSessions() {
    const out = new Map();
    try {
      const arr = JSON.parse(lsGet(SESS_KEY) || "[]");
      for (const raw of Array.isArray(arr) ? arr : []) {
        const s = normSession(raw);
        if (!s || out.has(s.id)) continue;
        out.set(s.id, Object.assign(s, {
          title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim().slice(0, 200) : null,
          suggested: raw.suggested === true, dismissed: raw.dismissed === true, added: raw.added === true,
          startedAt: num(raw.startedAt),
        }));
      }
    } catch {}
    return out;
  }
  function saveSessions() {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if ((s.state === "ended" && now - s.updatedAt > ENDED_TTL) || now - s.updatedAt > IDLE_TTL) sessions.delete(id);
    }
    const list = [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS);
    sessions = new Map(list.map(s => [s.id, s]));
    lsSet(SESS_KEY, JSON.stringify(list));
  }

  // One decrypted inbox message from the plugin. Anything unexpected drops the whole message.
  const EVENTS = new Set([...Object.keys(EVENT_STATE), "hello"]);
  function parseMessage(m) {
    if (!m || typeof m !== "object" || Array.isArray(m) || !EVENTS.has(m.event)) return null;
    if (typeof m.sessionId !== "string" || !SESSION_RE.test(m.sessionId)) return null;
    if (typeof m.at !== "number" || !Number.isFinite(m.at) || m.at <= 0) return null;
    if (m.project !== undefined && (typeof m.project !== "string" || m.project.length > 120)) return null;
    if (m.title !== undefined && m.title !== null && (typeof m.title !== "string" || m.title.length > 200)) return null;
    if (m.machine !== undefined && (typeof m.machine !== "string" || m.machine.length > 64)) return null;
    return {
      event: m.event, sessionId: m.sessionId,
      at: Math.min(m.at, Date.now()), // a clock running ahead can't pin a status forever
      project: (m.project || "").replace(CONTROL_RE, "").trim(), title: (m.title || "").replace(CONTROL_RE, "").replace(/\s+/g, " ").trim() || null,
      kind: m.kind === "cloud" ? "cloud" : "local", machine: (m.machine || "").replace(CONTROL_RE, "").trim(),
    };
  }

  function applyMessage(m, wid) {
    if (m.event === "hello") {
      if (inbox && /^[\w-]{1,32}$/.test(wid)) { inbox.machines = Object.assign({}, inbox.machines, { [wid]: m.machine }); saveInbox(); }
      toast("Claude Code connected" + (m.machine ? " on " + m.machine : ""));
      if ($("claudeDialog").open) refreshDialog();
      return;
    }
    let s = sessions.get(m.sessionId);
    if (!s) {
      s = { id: m.sessionId, state: EVENT_STATE[m.event], project: m.project, kind: m.kind, updatedAt: 0,
        title: null, suggested: false, dismissed: false, added: false, startedAt: m.at };
      sessions.set(s.id, s);
    }
    if (m.event === "suggest") {
      if (!s.suggested && !s.added && !s.dismissed && !viewing) announce("Claude session suggested: " + (m.title || "untitled session" + (m.project ? " in " + m.project : "")));
      s.suggested = true; s.title = m.title || s.title; s.startedAt = m.at;
    }
    // Hooks run in parallel, so messages can arrive out of order: the newest one decides the status.
    if (m.at >= s.updatedAt) {
      s.state = EVENT_STATE[m.event]; s.updatedAt = m.at; s.kind = m.kind;
      if (m.project) s.project = m.project;
    }
    saveSessions();
    applySessions(true);
    renderTray();
  }

  // Linked todos follow their session's newest status. That isn't an edit, so it stays out of undo history.
  function applySessions(persist) {
    let changed = false;
    for (const t of items) {
      const s = t.session && sessions.get(t.session.id);
      if (!s || s.updatedAt <= t.session.updatedAt) continue;
      t.session = { id: s.id, state: s.state, project: s.project, kind: s.kind, updatedAt: s.updatedAt };
      changed = true;
    }
    if (changed && persist) { save(); updateBadges(); }
    updateTitle();
  }
  function badge(s) {
    const b = document.createElement("button");
    b.className = "sess"; b.dataset.act = "session"; b.dataset.state = s.state;
    const dot = document.createElement("span"); dot.className = "dot"; dot.setAttribute("aria-hidden", "true");
    b.append(dot, STATES[s.state]);
    b.title = s.kind === "cloud" ? "Cloud session" + (s.project ? " in " + s.project : "") : "Copy claude --resume " + s.id;
    b.setAttribute("aria-label", "Claude session: " + STATES[s.state] + (s.kind === "cloud" ? ". Cloud session" : ". Copy the resume command"));
    return b;
  }
  // Swap badges in place, so a status change doesn't disturb an open edit or a drag.
  function updateBadges() {
    for (const el of document.querySelectorAll("li[data-id] > .sess")) {
      const t = find(el.closest("li").dataset.id);
      if (t && t.session) el.replaceWith(badge(t.session));
    }
  }
  async function copyResume(id) {
    const s = find(id)?.session;
    if (!s) return;
    if (s.kind === "cloud") { toast("Cloud session" + (s.project ? " in " + s.project : "") + ". Open it at claude.ai/code"); return; }
    const cmd = "claude --resume " + s.id;
    try { await navigator.clipboard.writeText(cmd); } catch { toast("Couldn't copy. Run: " + cmd); return; }
    toast("Copied " + cmd);
    if (crypto.subtle) rememberClip(await sha256(cmd)); // not a clipboard suggestion
  }
  function updateTitle() {
    if (viewing) { document.title = possessive(viewing.name) + " todos (shared)"; return; }
    const ids = new Set();
    for (const s of trayList()) if (s.state === "needs_you") ids.add(s.id);
    for (const t of items) if (t.session && !t.done && t.session.state === "needs_you") ids.add(t.session.id);
    document.title = ids.size ? "(" + ids.size + ") Todos" : "Todos";
  }

  // ---------- the tray ----------
  const untitled = s => "Untitled session" + (s.project ? " in " + s.project : "");
  function age(ts) {
    const m = Math.floor((Date.now() - ts) / 60e3);
    if (m < 1) return "just now";
    if (m < 60) return m + " min";
    if (m < 1440) return Math.floor(m / 60) + " h";
    return Math.floor(m / 1440) + " d";
  }
  function trayList() {
    const linked = new Set(items.filter(t => t.session).map(t => t.session.id));
    const now = Date.now();
    return [...sessions.values()]
      .filter(s => s.suggested && !s.dismissed && !s.added && !linked.has(s.id) && !(s.state === "ended" && now - s.updatedAt > ENDED_TTL))
      .sort((a, b) => b.startedAt - a.startedAt);
  }
  function card(s) {
    const li = document.createElement("li");
    li.dataset.session = s.id; li.dataset.state = s.state; li.tabIndex = 0;
    const title = s.title || untitled(s);
    li.setAttribute("aria-label", "Claude session: " + title + ". " + STATES[s.state] + ". Enter adds it to " + LANE.h.name + ", Escape dismisses it.");
    const icon = document.createElement("span"); icon.className = "tray-icon"; icon.setAttribute("aria-hidden", "true"); icon.innerHTML = ICON.session;
    const body = document.createElement("div"); body.className = "tray-body";
    if (trayEdit && trayEdit.id === s.id) {
      const inp = document.createElement("input");
      inp.className = "tray-edit"; inp.value = trayEdit.value; inp.maxLength = 500;
      inp.setAttribute("aria-label", "Edit the title, then Enter adds it");
      inp.addEventListener("input", () => { trayEdit.value = inp.value; });
      body.append(inp);
    } else {
      const t = document.createElement("span"); t.className = "tray-title" + (s.title ? "" : " untitled"); t.textContent = title;
      body.append(t);
    }
    const meta = document.createElement("span"); meta.className = "tray-meta";
    const dot = document.createElement("span"); dot.className = "dot"; dot.setAttribute("aria-hidden", "true");
    meta.append(dot, [STATES[s.state], s.project, (s.kind === "cloud" ? "cloud · " : "") + age(s.startedAt || s.updatedAt)].filter(Boolean).join(" · "));
    body.append(meta);
    const acts = document.createElement("div"); acts.className = "tray-acts";
    const add = document.createElement("button"); add.type = "button"; add.className = "tray-add"; add.dataset.tact = "add";
    add.textContent = "Add"; add.title = "Add to " + LANE.h.name + " (Enter, or 2–4 for another lane)";
    const no = document.createElement("button"); no.type = "button"; no.className = "act"; no.dataset.tact = "dismiss";
    no.innerHTML = ICON.cross; no.title = "Dismiss (Esc)"; no.setAttribute("aria-label", "Dismiss: " + title);
    acts.append(add, no);
    li.append(icon, body, acts);
    return li;
  }
  function renderTray() {
    const list = trayList(), ul = $("trayList");
    const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest("#trayList li");
    const keep = focused && focused.dataset.session;
    ul.replaceChildren(...list.map(card));
    $("tray").hidden = list.length === 0 || !!viewing;
    const again = keep && ul.querySelector('li[data-session="' + CSS.escape(keep) + '"]');
    const edit = trayEdit && ul.querySelector(".tray-edit");
    if (edit) { edit.focus(); edit.setSelectionRange(edit.value.length, edit.value.length); }
    else if (again) again.focus({ preventScroll: true });
    else if (keep) (ul.querySelector("li") || input).focus({ preventScroll: true });
    updateTitle();
  }
  function addSession(id, prio, text) {
    const s = sessions.get(id);
    if (!s || blocked()) return;
    trayEdit = null;
    const before = snap();
    const t = {
      id: uid(), text: (text || s.title || untitled(s)).slice(0, 500), done: false, prio, created: Date.now(),
      session: { id: s.id, state: s.state, project: s.project, kind: s.kind, updatedAt: s.updatedAt },
      pos: laneEnd(prio),
    };
    items.push(t); enterIds.add(t.id);
    s.added = true; saveSessions();
    record(ADD_SESSION, before);
    save(); render(); renderTray();
    toast("Added to " + LANE[prio].short, "Undo", undo);
    announce("Added to " + LANE[prio].name);
  }
  // Undoing an add puts the suggestion back in the tray.
  function unaddSessions() {
    const linked = new Set(items.filter(t => t.session).map(t => t.session.id));
    for (const s of sessions.values()) if (s.added && !linked.has(s.id)) s.added = false;
    saveSessions(); renderTray();
  }
  function dismissSession(id) {
    const s = sessions.get(id);
    if (!s) return;
    if (trayEdit && trayEdit.id === id) trayEdit = null;
    s.dismissed = true; saveSessions(); renderTray();
    toast("Suggestion dismissed", "Undo", () => { s.dismissed = false; sessions.set(s.id, s); saveSessions(); renderTray(); });
    announce("Suggestion dismissed");
  }
  // Card shortcuts, for a focused card and the card under the mouse (like rowAction for todos).
  function trayAction(li, k, viaHover) {
    const id = li.dataset.session;
    if (viewing) return false;
    if (k === "Enter" || k === "1") { addSession(id, "h"); return true; }
    if (/^[2-4]$/.test(k)) { addSession(id, ORDER[+k - 1]); return true; }
    if (k === "e" || k === "E") { trayEdit = { id, value: sessions.get(id)?.title || "" }; renderTray(); return true; }
    if (k === "Escape" || k === "Delete" || k === "Backspace") {
      if (!viaHover) li.focus(); // keeps focus in the tray: renderTray moves it to the next card
      dismissSession(id); return true;
    }
    return false;
  }
  function hoveredCard() {
    if (!ptr || dragId || editingId || trayEdit || viewing) return null;
    const el = document.elementFromPoint(ptr.x, ptr.y);
    return (el && el.closest("#trayList li[data-session]")) || null;
  }
  $("trayList").addEventListener("click", e => {
    const li = e.target.closest("li[data-session]"), b = e.target.closest("[data-tact]");
    if (!li || !b) return;
    if (b.dataset.tact === "add") addSession(li.dataset.session, "h");
    else { li.focus(); dismissSession(li.dataset.session); }
  });
  $("trayList").addEventListener("keydown", e => {
    const li = e.target.closest("li[data-session]");
    if (!li) return;
    if (e.target.classList.contains("tray-edit")) {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); addSession(li.dataset.session, "h", e.target.value.trim()); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); trayEdit = null; li.focus(); renderTray(); }
      return;
    }
    if (e.target !== li || e.metaKey || e.ctrlKey || e.altKey) return; // buttons keep Enter and Space
    if (trayAction(li, e.key, false)) { e.preventDefault(); e.stopPropagation(); }
    else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const sib = e.key === "ArrowRight" ? li.nextElementSibling : li.previousElementSibling;
      if (sib) { e.preventDefault(); sib.focus(); }
    }
  });
  $("trayList").addEventListener("focusout", e => {
    if (trayEdit && e.target.classList.contains("tray-edit") && !e.currentTarget.contains(e.relatedTarget)) { trayEdit = null; renderTray(); }
  });
  setInterval(() => { if (!trayEdit && !$("tray").hidden) renderTray(); }, 60e3); // ages, and ended suggestions expiring

  // ---------- the inbox on the relay ----------
  function loadInbox() {
    try {
      const v = JSON.parse(lsGet(INBOX_KEY) || "null");
      if (v && typeof v.relay === "string" && /^[\w-]{22}$/.test(v.id) && /^[\w-]{43}$/.test(v.key) && typeof v.ownerToken === "string") return v;
    } catch {}
    return null;
  }
  const saveInbox = () => lsSet(INBOX_KEY, JSON.stringify(inbox));
  function startRelay(base, impl) {
    if (sub) { sub.close(); sub = null; }
    relay = TodoRelay.client(Object.assign({ base }, impl));
    $("claudeBtn").hidden = false;
    inbox = loadInbox();
    if (inbox && inbox.relay !== relay.base) inbox = null; // made on a different relay
    if (inbox) follow();
    relayStarted();
  }
  function follow() {
    if (sub) sub.close();
    const ch = inbox;
    sub = relay.subscribe(ch, onRelayEvent, st => {
      // A socket can't say why it failed. If the relay no longer has this inbox (unused for 90 days, say), forget
      // it, so the next Connect makes a new one instead of failing forever.
      if (st === "closed") relay.listWriters(ch).catch(e => { if (e && e.status === 404 && inbox === ch) inboxGone(); });
    });
  }
  function inboxGone() {
    if (sub) { sub.close(); sub = null; }
    inbox = null; lsSet(INBOX_KEY, "");
  }
  async function onRelayEvent(ev) {
    if (ev.type === "deleted") { inboxGone(); return; } // the inbox is gone (expired): the next Connect makes a new one
    if (ev.type === "removed" && typeof ev.id === "string") { handled.add(ev.id); return; } // another tab handled it
    if (ev.type !== "message" || typeof ev.id !== "string" || !/^[\w-]{1,32}$/.test(ev.id) || handled.has(ev.id)) return;
    if (handled.size > 2000) handled.clear();
    handled.add(ev.id);
    const ch = inbox;
    let m = null;
    if (ch && typeof ev.data === "string" && ev.data.length <= 32768) {
      try { m = parseMessage(await TodoRelay.decrypt(ch.key, ev.data)); } catch {}
    }
    if (m && ch === inbox) applyMessage(m, typeof ev.wid === "string" ? ev.wid : "");
    // Handled, or junk we'll never be able to read: either way it's done.
    if (ch) relay.deleteMessage(ch, ev.id).catch(() => { // try once more, or it comes back after a reload
      setTimeout(() => { if (relay && inbox === ch) relay.deleteMessage(ch, ev.id).catch(() => {}); }, 30e3);
    });
    window.dispatchEvent(new Event("todos:relaymsg")); // lets tests/smoke.html know a message was handled
  }
  // Another tab of this browser may have handled messages or made the inbox.
  window.addEventListener("storage", e => {
    if (e.key === SESS_KEY) { sessions = loadSessions(); renderTray(); }
    else if (e.key === INBOX_KEY && relay) {
      const next = loadInbox();
      if (next && next.relay === relay.base && (!inbox || inbox.id !== next.id)) { inbox = next; follow(); }
      else if (next && inbox && next.id === inbox.id) inbox = next;
      else if (!next && inbox) { if (sub) { sub.close(); sub = null; } inbox = null; }
    }
  });

  // ---------- Connect Claude Code (pairing) ----------
  const dlg = $("claudeDialog");
  async function ensureInbox() {
    if (inbox) return inbox;
    const r = await relay.create("inbox");
    if (!r || !/^[\w-]{22}$/.test(r.id) || typeof r.ownerToken !== "string") throw new Error("bad reply");
    inbox = { relay: relay.base, id: r.id, key: TodoRelay.newKey(), ownerToken: r.ownerToken, machines: {} };
    saveInbox(); follow();
    return inbox;
  }
  async function refreshDialog(again) {
    $("claudeErr").hidden = true;
    try {
      const ch = await ensureInbox();
      let reply;
      try { reply = await relay.listWriters(ch); }
      catch (e) {
        // The relay has forgotten this inbox: start a new one (machines connected to the old one must reconnect).
        if (e && e.status === 404 && !again && inbox === ch) { inboxGone(); return refreshDialog(true); }
        throw e;
      }
      const writers = (reply && Array.isArray(reply.writers) ? reply.writers : [])
        .filter(w => w && typeof w.wid === "string" && /^[\w-]{1,32}$/.test(w.wid));
      // One code per machine: reuse the shown code until a machine has connected with it.
      const pending = ch.pending && writers.find(w => w.wid === ch.pending.wid && !w.used);
      if (!pending) {
        const w = await relay.mintWriter(ch);
        if (!w || typeof w.wid !== "string" || !/^[\w-]{43}$/.test(w.token)) throw new Error("bad reply");
        ch.pending = { wid: w.wid, token: w.token }; saveInbox();
      }
      const code = TodoRelay.pairingCode({ relay: ch.relay, channelId: ch.id, key: ch.key, writerToken: ch.pending.token });
      $("claudeCmd").textContent = "/todos:connect " + code;
      $("claudeCopy").disabled = false;
      renderMachines(writers.filter(w => typeof w.used === "number"));
    } catch {
      $("claudeErr").hidden = false;
    }
  }
  function renderMachines(list) {
    const ul = $("claudeMachines"), names = (inbox && inbox.machines) || {};
    if (!list.length) {
      const li = document.createElement("li"); li.className = "muted"; li.textContent = "No machines connected yet.";
      ul.replaceChildren(li); return;
    }
    ul.replaceChildren(...list.map(w => {
      const li = document.createElement("li");
      const name = document.createElement("span"); name.className = "machine";
      const own = Object.hasOwn(names, w.wid) && typeof names[w.wid] === "string" && names[w.wid];
      name.textContent = own || "Paired " + new Date(num(w.created)).toLocaleDateString(undefined, { day: "numeric", month: "short" });
      const when = document.createElement("small"); when.textContent = "active " + (age(w.used) === "just now" ? "just now" : age(w.used) + " ago");
      const b = document.createElement("button"); b.type = "button"; b.className = "ghost-btn"; b.dataset.wid = w.wid;
      b.textContent = "Disconnect"; b.setAttribute("aria-label", "Disconnect " + name.textContent);
      li.append(name, when, b);
      return li;
    }));
  }
  $("claudeBtn").addEventListener("click", () => {
    $("claudeCmd").textContent = "Creating a pairing code…";
    $("claudeCopy").disabled = true;
    $("claudeMachines").replaceChildren();
    dlg.showModal();
    refreshDialog();
  });
  $("claudeClose").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); }); // click outside the box
  $("claudeCopy").addEventListener("click", async () => {
    const cmd = $("claudeCmd").textContent;
    try { await navigator.clipboard.writeText(cmd); } catch { toast("Couldn't copy. Select the command and copy it."); return; }
    $("claudeCopy").textContent = "Copied";
    setTimeout(() => { $("claudeCopy").textContent = "Copy"; }, 1500);
    if (crypto.subtle) rememberClip(await sha256(cmd));
  });
  $("claudeMachines").addEventListener("click", async e => {
    const b = e.target.closest("button[data-wid]");
    if (!b || !inbox) return;
    b.disabled = true;
    try {
      await relay.revokeWriter(inbox, b.dataset.wid);
      if (inbox.machines) delete inbox.machines[b.dataset.wid];
      saveInbox();
      toast("Disconnected. That machine can't send to this board any more.");
    } catch { toast("Couldn't disconnect. Try again."); }
    refreshDialog();
  });

  // ---------- live sharing: your side ----------
  // A share is a `share` channel on the relay holding an encrypted snapshot of (part of) your board. Anyone with
  // the link (channel id + key, after the #, which browsers never send) watches it live. Only this browser has
  // the owner token, so only this browser can change what they see.
  const SHARES_KEY = NS + ".shares", SHARE_NAME_KEY = NS + ".shareName";
  const CHANNEL_RE = /^[\w-]{22}$/, KEY_RE = /^[\w-]{43}$/;
  const SHARE_DEBOUNCE = 1000;
  // No control or bidirectional formatting characters: a name must not be able to reorder the banner around it.
  const cleanName = n => (typeof n === "string" ? n.replace(CONTROL_RE, "")
    .replace(/\s+/g, " ").trim().slice(0, 40) : "");
  const possessive = n => (n || "Someone") + "'s";
  function normOptions(o) {
    o = o && typeof o === "object" ? o : {};
    const lanes = {};
    for (const k of ORDER) lanes[k] = !(o.lanes && o.lanes[k] === false);
    return { open: o.open !== false, done: o.done === true, lanes };
  }
  function loadShares() {
    try {
      const arr = JSON.parse(lsGet(SHARES_KEY) || "[]");
      return (Array.isArray(arr) ? arr : [])
        .filter(x => x && CHANNEL_RE.test(x.id) && KEY_RE.test(x.key) && typeof x.ownerToken === "string" && typeof x.relay === "string")
        .map(x => ({ id: x.id, key: x.key, ownerToken: x.ownerToken, relay: x.relay, name: cleanName(x.name), options: normOptions(x.options),
          createdAt: num(x.createdAt), sent: typeof x.sent === "string" ? x.sent : "" }));
    } catch { return []; }
  }
  let shares = loadShares(), shareTimer = null, shareTries = 0, sharePushing = false;
  const saveShares = () => lsSet(SHARES_KEY, JSON.stringify(shares));
  const ownShares = () => (relay ? shares.filter(x => x.relay === relay.base) : []);
  const shareLink = x => location.origin + location.pathname + "#share=" + x.id + "." + x.key;
  function updateShareStatus() { $("shareStatus").hidden = !ownShares().length; }

  // What a viewer gets: { v: 1, name, at, lanes: [[{ t, d?: 1, w?: 1 }, …] ×4] }. Only the included lanes and
  // todos, and nothing else: no ids, timestamps or Claude session details.
  function snapshot(x) {
    const o = x.options;
    return { v: 1, name: x.name, at: Date.now(), lanes: ORDER.map(k => !o.lanes[k] ? [] : items
      .filter(t => t.prio === k && (t.done ? o.done : o.open))
      .map(t => Object.assign({ t: t.text }, t.done ? { d: 1 } : t.wip ? { w: 1 } : {}))) };
  }
  // After a save, debounced: each share whose snapshot changed gets the new one.
  function scheduleShares(now) {
    if (!relay || !ownShares().length) return;
    clearTimeout(shareTimer);
    shareTimer = setTimeout(pushShares, now ? 0 : SHARE_DEBOUNCE);
  }
  async function pushShares() {
    shareTimer = null;
    if (sharePushing) { scheduleShares(); return; }
    sharePushing = true;
    let retry = false;
    try {
      for (const x of ownShares()) {
        const snap = snapshot(x);
        const hash = await sha256(JSON.stringify([snap.name, snap.lanes]));
        if (hash === x.sent) continue;
        try {
          await relay.putState(x, await TodoRelay.encrypt(x.key, snap));
          x.sent = hash; x.tooBig = false;
          if (shares.includes(x)) saveShares();
        } catch (e) {
          if (!shares.includes(x)) continue; // stopped while this upload was in flight
          const st = e && e.status;
          if (st === 404 || st === 401) { dropShare(x); toast("A shared link expired, so it's no longer live"); }
          else if (st === 413) {
            // Say it once, not on every save; the next change tries again.
            if (!x.tooBig) toast("Too many todos to share live. Include fewer in Shared links.");
            x.tooBig = true; x.sent = hash;
          }
          else retry = true; // offline, rate-limited or the relay is down: try again shortly
        }
      }
    } finally { sharePushing = false; }
    if (retry) { clearTimeout(shareTimer); shareTimer = setTimeout(pushShares, backoff(shareTries++)); }
    else shareTries = 0;
    window.dispatchEvent(new Event("todos:sharepush")); // lets tests/smoke.html know a push finished
  }
  function dropShare(x) {
    shares = shares.filter(s => s.id !== x.id);
    saveShares(); updateShareStatus();
  }
  async function stopSharing(x) {
    try { await relay.remove(x); }
    catch (e) {
      if (!(e && (e.status === 404 || e.status === 401))) { toast("Couldn't stop sharing. Check your connection and try again."); return false; }
    }
    dropShare(x);
    toast("Stopped sharing. That link no longer shows your todos.");
    return true;
  }
  async function copyLink(x) {
    const link = shareLink(x);
    try { await navigator.clipboard.writeText(link); } catch { toast("Couldn't copy. Select the link and copy it."); return; }
    toast("Link copied");
    if (crypto.subtle) rememberClip(await sha256(link)); // not a clipboard suggestion
  }

  // The share dialog: create a link, or change what an existing one includes.
  const shareDlg = $("shareDialog"), sharesDlg = $("sharesDialog");
  let shareEditing = null;
  function openShareDialog(x) {
    if (!relay) return;
    shareEditing = x;
    const o = x ? x.options : normOptions(null);
    $("shareName").value = x ? x.name : cleanName(lsGet(SHARE_NAME_KEY));
    $("shareOpen").checked = o.open; $("shareDone").checked = o.done;
    for (const b of shareDlg.querySelectorAll("input[data-lane]")) b.checked = o.lanes[b.dataset.lane];
    $("shareErr").hidden = true;
    showShareLink();
    if (sharesDlg.open) sharesDlg.close();
    shareDlg.showModal();
    $("shareName").focus();
  }
  function showShareLink() {
    $("shareTitle").textContent = shareEditing ? "Change what's included" : "Share a live link";
    $("shareLinkBox").hidden = !shareEditing;
    $("shareLink").textContent = shareEditing ? shareLink(shareEditing) : "";
    $("shareCreate").textContent = shareEditing ? "Save" : "Create link";
  }
  function readShareForm() {
    const lanes = {};
    for (const b of shareDlg.querySelectorAll("input[data-lane]")) lanes[b.dataset.lane] = b.checked;
    return { name: cleanName($("shareName").value), options: normOptions({ open: $("shareOpen").checked, done: $("shareDone").checked, lanes }) };
  }
  $("shareCreate").addEventListener("click", async () => {
    const f = readShareForm();
    lsSet(SHARE_NAME_KEY, f.name);
    if (shareEditing) {
      Object.assign(shareEditing, f, { sent: "" });
      saveShares(); scheduleShares(true);
      shareDlg.close(); toast("Updated what this link shows");
      return;
    }
    const btn = $("shareCreate");
    btn.disabled = true; $("shareErr").hidden = true;
    try {
      const r = await relay.create("share");
      if (!r || !CHANNEL_RE.test(r.id) || typeof r.ownerToken !== "string") throw new Error("bad reply");
      const x = Object.assign({ id: r.id, key: TodoRelay.newKey(), ownerToken: r.ownerToken, relay: relay.base, createdAt: Date.now(), sent: "" }, f);
      shares.push(x); saveShares(); updateShareStatus();
      shareEditing = x; showShareLink();
      scheduleShares(true);
      $("shareCopy").focus();
      announce("Link created. Anyone with it can see these todos.");
    } catch { $("shareErr").hidden = false; }
    btn.disabled = false;
  });
  $("shareCopy").addEventListener("click", () => { if (shareEditing) copyLink(shareEditing); });
  $("shareClose").addEventListener("click", () => shareDlg.close());

  // Shared links: every active share, with Copy link, Change what's included and Stop sharing.
  function describeShare(o) {
    const what = [o.open && "open", o.done && "done"].filter(Boolean).join(" and ") || "no";
    const lanes = ORDER.filter(k => o.lanes[k]);
    return what[0].toUpperCase() + what.slice(1) + " todos · " +
      (lanes.length === 4 ? "all lanes" : lanes.length ? lanes.map(k => LANE[k].short).join(", ") : "no lanes");
  }
  function renderShares() {
    const ul = $("sharesList"), list = ownShares();
    if (!list.length) {
      const li = document.createElement("li"); li.className = "muted"; li.textContent = "Nothing is shared right now.";
      ul.replaceChildren(li); return;
    }
    ul.replaceChildren(...list.map(x => {
      const li = document.createElement("li");
      const name = document.createElement("span"); name.className = "machine";
      name.textContent = possessive(x.name) + " todos";
      const small = document.createElement("small"); small.textContent = " " + describeShare(x.options);
      name.append(small);
      const btn = (act, label) => {
        const b = document.createElement("button"); b.type = "button"; b.className = "ghost-btn";
        b.dataset.sact = act; b.dataset.sid = x.id; b.textContent = label; return b;
      };
      li.append(name, btn("copy", "Copy link"), btn("edit", "Change what's included"), btn("stop", "Stop sharing"));
      return li;
    }));
  }
  function openSharesDialog() { renderShares(); sharesDlg.showModal(); }
  $("sharesList").addEventListener("click", async e => {
    const b = e.target.closest("button[data-sact]"); if (!b) return;
    const x = ownShares().find(s => s.id === b.dataset.sid); if (!x) return;
    if (b.dataset.sact === "copy") copyLink(x);
    else if (b.dataset.sact === "edit") openShareDialog(x);
    else if (!b.classList.contains("confirm")) { b.classList.add("confirm"); b.textContent = "Click again to stop"; }
    else { b.disabled = true; if (await stopSharing(x)) renderShares(); else b.disabled = false; }
  });
  $("sharesNew").addEventListener("click", () => openShareDialog(null));
  $("sharesClose").addEventListener("click", () => sharesDlg.close());
  $("shareStatus").addEventListener("click", openSharesDialog);
  for (const d of [shareDlg, sharesDlg]) d.addEventListener("click", e => { if (e.target === d) d.close(); });

  // ---------- live sharing: viewing someone else's board ----------
  // Opening a link saves the board under todos.shared (never in todos.v1) and shows it, read-only, in place of
  // yours. Every write path checks blocked(); the only write allowed is copying todos into your own list.
  const SHARED_KEY = NS + ".shared", LAST_SHARED_KEY = NS + ".lastShared";
  // At most 5,000 todos and 200,000 characters of text per board, and about 2 MB for all the boards kept in
  // localStorage, so someone else's board can never fill the storage your own list needs.
  const MAX_SHARED_ITEMS = 5000, MAX_SHARED_CHARS = 200000, SHARED_BUDGET = 1e6;
  const COPY_LABEL = "copy to my list";
  // A decrypted snapshot is untrusted: the right shape or nothing, known fields only, text capped like normalize().
  function normShare(s) {
    if (!s || typeof s !== "object" || Array.isArray(s) || s.v !== 1 || !Array.isArray(s.lanes) || s.lanes.length !== 4) return null;
    if (!s.lanes.every(Array.isArray)) return null;
    let n = 0, chars = 0;
    const lanes = s.lanes.map(l => {
      const out = [];
      for (const x of l) {
        if (n >= MAX_SHARED_ITEMS || chars >= MAX_SHARED_CHARS) break;
        if (!x || typeof x !== "object" || typeof x.t !== "string" || !x.t.trim()) continue;
        const it = { t: x.t.trim().slice(0, 500) };
        if (x.d === 1) it.d = 1; else if (x.w === 1) it.w = 1;
        out.push(it); n++; chars += it.t.length;
      }
      return out;
    });
    return { v: 1, name: cleanName(s.name), at: Math.min(num(s.at), Date.now()), lanes };
  }
  // Row ids come from the content (lane, done, text), not the position, so a live update that adds or removes a
  // todo above the one you're on keeps focus, and C, on the same todo.
  function textHash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(36);
  }
  function sharedItems(st) {
    const out = [], seen = new Map();
    if (st) st.lanes.forEach((l, i) => l.forEach(x => {
      const base = "v" + i + (x.d === 1 ? "d" : "") + "-" + textHash(x.t);
      const n = seen.get(base) || 0; seen.set(base, n + 1);
      const t = { id: base + (n ? "-" + n : ""), text: x.t, done: x.d === 1, prio: ORDER[i], created: 0 };
      if (t.done) t.doneAt = 0; else if (x.w) t.wip = true;
      out.push(t);
    }));
    return out;
  }
  function loadShared() {
    const out = [];
    try {
      const arr = JSON.parse(lsGet(SHARED_KEY) || "[]");
      for (const x of Array.isArray(arr) ? arr : []) {
        if (!x || !CHANNEL_RE.test(x.id) || !KEY_RE.test(x.key) || out.some(s => s.id === x.id)) continue;
        const lastState = normShare(x.lastState);
        out.push({ id: x.id, key: x.key, name: cleanName(x.name) || (lastState ? lastState.name : ""), lastState,
          lastSeenAt: num(x.lastSeenAt), version: num(x.version), stopped: x.stopped === true, kept: x.kept === true,
          altKey: KEY_RE.test(x.altKey) && x.altKey !== x.key ? x.altKey : undefined });
      }
    } catch {}
    return out;
  }
  let shared = loadShared(), viewSub = null, viewStatus = "offline";
  function saveShared() {
    const rows = shared.map(({ id, key, altKey, name, lastState, lastSeenAt, version, stopped, kept }) =>
      ({ id, key, altKey, name, lastState, lastSeenAt, version, stopped, kept }));
    // Over budget: the boards you looked at longest ago keep their link but not their last copy (a live board
    // fetches it again when you open it). The one on screen and copies you chose to keep are never cut.
    let size = JSON.stringify(rows).length;
    const cut = rows.filter(r => r.lastState && !r.kept && !(viewing && viewing.id === r.id)) // a kept copy is all there is
      .sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    while (size > SHARED_BUDGET && cut.length) {
      const r = cut.shift();
      size -= JSON.stringify(r.lastState).length - 4; r.lastState = null;
    }
    return lsSet(SHARED_KEY, JSON.stringify(rows));
  }
  const sharedById = id => shared.find(s => s.id === id);

  function blocked() {
    if (!viewing) return false;
    toast("Read-only: this is " + possessive(viewing.name) + " list");
    return true;
  }
  function setHash(h) {
    try { history.replaceState(history.state, "", location.pathname + location.search + h); } catch {}
  }

  function view(id) {
    const x = sharedById(id);
    if (!x) return;
    if (viewing !== x) { closeView(); $("viewBar").dataset.status = ""; }
    viewing = x; x.items = sharedItems(x.lastState);
    lsSet(LAST_SHARED_KEY, x.id);
    setHash("#shared=" + x.id); // never leave the key in the address bar
    editingId = null; trayEdit = null; clearDrag(); closeMenu();
    if (clip) endClip();
    applyViewMode();
    if (!viewSub) connectView();
    render(); renderTray();
    announce("Viewing " + possessive(x.name) + " todos. Read-only.");
  }
  function viewMine() {
    if (!viewing) return;
    closeView(); viewing = null;
    setHash("");
    applyViewMode(); render(); renderTray();
    announce("Back to your todos");
  }
  function closeView() { if (viewSub) { viewSub.close(); viewSub = null; } }
  // ` (backtick): your board ↔ the shared board you looked at last.
  function toggleBoards() {
    if (viewing) { viewMine(); return; }
    const last = sharedById(lsGet(LAST_SHARED_KEY)) || shared[0];
    if (last) view(last.id); else toast("No shared boards yet. Open a share link to add one.");
  }
  function applyViewMode() {
    const on = !!viewing;
    document.documentElement.classList.toggle("viewing", on);
    $("addForm").inert = on; $("importBtn").hidden = on;
    if (on) $("clipOffer").hidden = true;
    $("viewBar").hidden = !on; $("viewKeys").hidden = !on;
    renderBanner(); renderSwitcher(); updateTitle();
  }

  function connectView() {
    closeView();
    const x = viewing;
    if (!x) return;
    if (x.stopped || !relay) { viewStatus = x.stopped ? "stopped" : "offline"; renderBanner(); return; }
    viewStatus = "connecting"; renderBanner();
    const id = x.id;
    viewSub = relay.subscribe({ id }, ev => onShareEvent(id, ev), st => {
      if (!viewing || viewing.id !== id) return;
      viewStatus = st === "open" ? "live" : "offline";
      if (st !== "open") checkStopped(id);
      renderBanner();
    });
  }
  // A socket can't say why it failed, so ask: a 404 means the owner stopped sharing.
  async function checkStopped(id) {
    try { await relay.getState({ id }); }
    catch (e) { if (e && e.status === 404) markStopped(id); }
  }
  async function onShareEvent(id, ev) {
    try {
      if (ev.type === "deleted") { markStopped(id); return; }
      const x = sharedById(id);
      if (!x || ev.type !== "state" || typeof ev.data !== "string" || ev.data.length > 400000) return;
      const version = num(ev.version);
      if (version < x.version) return; // an older copy arriving late
      const read = async key => { try { return normShare(await TodoRelay.decrypt(key, ev.data, 4e6)); } catch { return null; } };
      let st = await read(x.key);
      // A link with a different key for a board you already have only takes over if the saved key no longer works.
      if (!st && x.altKey) { const alt = x.altKey; st = await read(alt); if (st) x.key = alt; }
      if (st) delete x.altKey;
      if (!st) return; // not a board we can read: keep showing what we have
      if (version < x.version || !shared.includes(x)) return; // a newer copy finished first, or it was removed
      Object.assign(x, { lastState: st, name: st.name || x.name, version, lastSeenAt: Date.now() });
      saveShared();
      if (viewing === x) {
        x.items = sharedItems(st);
        const keep = document.activeElement && document.activeElement.closest && document.activeElement.closest("li[data-id]");
        render(); renderBanner(); renderSwitcher();
        if (keep) focusRow(keep.dataset.id);
      }
    } finally {
      window.dispatchEvent(new Event("todos:sharemsg")); // lets tests/smoke.html know a state was handled
    }
  }
  function markStopped(id) {
    const x = sharedById(id);
    if (!x || x.stopped) return;
    x.stopped = true; saveShared();
    if (viewing === x) { closeView(); viewStatus = "stopped"; renderBanner(); }
    renderSwitcher();
  }
  function removeShared(id) {
    const x = sharedById(id);
    if (!x) return;
    shared = shared.filter(s => s !== x); saveShared();
    if (viewing === x) viewMine();
    renderSwitcher();
    toast("Removed " + possessive(x.name) + " board");
  }

  // The banner: whose board, whether it's live, and that it's read-only. It can't be closed.
  function renderBanner() {
    const x = viewing;
    if (!x) return;
    const when = x.lastState ? x.lastState.at || x.lastSeenAt : 0;
    const ago = when ? (age(when) === "just now" ? "just now" : age(when) + " ago") : "";
    const b = document.createElement("b");
    const stopped = x.stopped || viewStatus === "stopped";
    let parts;
    if (stopped && !x.kept) {
      b.textContent = x.name || "The owner";
      parts = [b, " stopped sharing", ago && " · last copy from " + ago];
    } else {
      b.textContent = possessive(x.name);
      const state = stopped ? (ago ? "last copy from " + ago : "last copy") :
        viewStatus === "live" ? "live" + (ago && " · updated " + ago) :
        viewStatus === "connecting" ? "connecting…" + (ago && " · updated " + ago) :
        "Offline" + (ago && " · last updated " + ago);
      parts = ["Viewing ", b, " todos · " + state];
    }
    $("viewText").replaceChildren(...parts.filter(Boolean), " · read-only");
    // The banner isn't a live region (it redraws every 30 s); only a change of state is read out.
    const status = stopped ? "stopped" : viewStatus;
    const was = $("viewBar").dataset.status;
    if (was && was !== status && (status === "stopped" || status === "offline" || (status === "live" && was === "offline")))
      announce(status === "stopped" ? (x.name || "The owner") + " stopped sharing" : status === "live" ? "Back online" : "Offline. Showing the last copy.");
    $("viewBar").dataset.status = status;
    $("viewRemove").hidden = $("viewKeep").hidden = !(stopped && !x.kept);
    $("viewCopy").disabled = !x.items || !x.items.some(t => !t.done);
  }
  setInterval(() => { if (viewing) renderBanner(); }, 30e3); // "updated 2 min ago" keeps counting
  $("viewBack").addEventListener("click", viewMine);
  $("viewCopy").addEventListener("click", () => { if (viewing) copyToMine(viewing.items.filter(t => !t.done).map(t => t.id)); });
  $("viewRemove").addEventListener("click", () => { if (viewing) removeShared(viewing.id); });
  $("viewKeep").addEventListener("click", () => {
    if (!viewing) return;
    viewing.kept = true; saveShared(); renderBanner(); renderSwitcher();
  });

  // Copies go into your own Fridge with new ids, through record() so Undo takes them back out.
  function copyToMine(ids) {
    if (!viewing) return;
    const have = new Set(items.filter(t => !t.done).map(t => t.text.toLowerCase()));
    const picked = viewing.items.filter(t => ids.includes(t.id)), fresh = [];
    for (const t of picked) {
      const k = t.text.toLowerCase();
      if (!have.has(k)) { have.add(k); fresh.push(t.text); }
    }
    if (!fresh.length) { toast(picked.length === 1 ? "That's already in your list" : "Those are all in your list already"); return; }
    const before = snap(), now = Date.now(), end = laneEnd("n");
    fresh.forEach((text, i) => items.push({ id: uid(), text, done: false, prio: "n", created: now + i, pos: end + i }));
    record(COPY_LABEL, before);
    save(); render(); renderBanner();
    const msg = fresh.length === 1 ? "Added to your Fridge" : "Copied " + fresh.length + " todos to your Fridge";
    toast(msg, "Undo", undo);
    announce(msg);
  }

  // A shared board shows without anything that changes it: no grip, checkbox or edit, just Add to mine.
  function viewRow(t, inPanel) {
    const li = document.createElement("li");
    li.dataset.id = t.id; li.dataset.prio = t.prio;
    if (t.done) li.classList.add("done");
    const cb = document.createElement("span"); cb.className = "check"; cb.setAttribute("aria-hidden", "true"); cb.innerHTML = ICON.check;
    const txt = document.createElement("span"); txt.className = "text";
    const s = document.createElement("span"); s.textContent = t.text; txt.append(s);
    li.append(cb, txt);
    if (t.wip && !t.done && !inPanel) {
      li.classList.add("wip");
      const chip = document.createElement("span"); chip.className = "chip"; chip.textContent = "In progress";
      li.append(chip);
    }
    if (inPanel) {
      const tag = document.createElement("span"); tag.className = "tag";
      tag.innerHTML = heat(t.prio); tag.append(LANE[t.prio].short);
      li.append(tag);
    }
    const acts = document.createElement("div"); acts.className = "acts";
    const b = document.createElement("button"); b.type = "button"; b.className = "act copy"; b.dataset.act = "copy";
    b.title = "Add to mine (C)"; b.setAttribute("aria-label", "Add to mine: " + t.text + (t.done ? " (done)" : t.wip ? " (in progress)" : ""));
    b.innerHTML = ICON.plus;
    acts.append(b); li.append(acts);
    return li;
  }

  // The "Todos" heading becomes a switcher once you have a shared board: My todos, each shared board, Remove….
  function renderSwitcher() {
    const has = shared.length > 0;
    $("boardTitle").hidden = has; $("switchBtn").hidden = !has;
    $("switchName").textContent = viewing ? possessive(viewing.name) + " todos" : "Todos";
  }
  function sharedLabel(x) {
    const state = x.stopped ? (x.kept ? "last copy" : "stopped") : viewing === x && viewStatus === "offline" ? "offline" : "live";
    return possessive(x.name) + " · " + state;
  }
  function openSwitcher(btn, removing) {
    closeMenu();
    menuFor = null; menuBtn = btn;
    const p = document.createElement("p"); p.textContent = removing ? "Remove a shared board" : "Boards";
    menu.replaceChildren(p);
    const item = (label, data, current) => {
      const b = document.createElement("button"); b.setAttribute("role", "menuitem");
      Object.assign(b.dataset, data);
      if (current) b.setAttribute("aria-current", "true");
      const sp = document.createElement("span"); sp.textContent = label; b.append(sp);
      menu.append(b);
    };
    if (removing) for (const x of shared) item("Remove " + possessive(x.name) + " board", { remove: x.id });
    else {
      item("My todos", { board: "" }, !viewing);
      for (const x of shared) item(sharedLabel(x), { board: x.id }, viewing === x);
      item("Remove…", { removing: "1" });
    }
    placeMenu(btn);
    menu.querySelector("button").focus();
  }
  function switcherClick(e) {
    const b = e.target.closest("button[data-board], button[data-remove], button[data-removing]");
    if (!b) return false;
    const btn = menuBtn;
    if (b.dataset.removing) { openSwitcher(btn, true); return true; }
    closeMenu(true);
    if (b.dataset.remove) removeShared(b.dataset.remove);
    else if (b.dataset.board) view(b.dataset.board);
    else viewMine();
    return true;
  }
  $("switchBtn").addEventListener("click", e => {
    if (!menu.hidden && menuBtn === e.currentTarget) { closeMenu(); return; }
    openSwitcher(e.currentTarget, false);
  });

  // #share=<id>.<key> opens (and saves) a shared board; #shared=<id> reopens one you already have; #sync=<code>
  // (a scanned pairing QR code) opens Sync across devices with the code filled in.
  function openFromHash() {
    const h = location.hash;
    const code = /^#sync=([\w-]+)$/.exec(h);
    if (code) {
      setHash("");
      if (sync) toast("This device is already syncing.");
      else openSyncDialog(code[1]);
      return;
    }
    let m = /^#share=([\w-]{22})\.([\w-]{43})$/.exec(h);
    if (m) {
      let x = sharedById(m[1]);
      if (!x) shared.push(x = { id: m[1], key: m[2], name: "", lastState: null, lastSeenAt: 0, version: 0, stopped: false, kept: false });
      else if (x.key !== m[2]) x.altKey = m[2]; // tried on the next update; see onShareEvent
      view(x.id);
      saveShared(); // after view(), so the board you're opening is the last to lose its stored copy
      return;
    }
    if (h.startsWith("#share=")) { setHash(""); toast("That share link is incomplete. Ask for it again."); return; }
    m = /^#shared=([\w-]{22})$/.exec(h);
    if (m && sharedById(m[1])) view(m[1]);
    else if (m) setHash("");
  }
  window.addEventListener("hashchange", openFromHash);
  // Another tab of this browser opened, removed or updated a shared board, or changed your shares.
  window.addEventListener("storage", e => {
    if (e.key === SHARES_KEY) { shares = loadShares(); updateShareStatus(); return; }
    if (e.key !== SHARED_KEY) return;
    const prev = viewing;
    shared = loadShared();
    if (prev) {
      const x = sharedById(prev.id);
      if (!x) { viewing = { id: prev.id }; viewMine(); }
      else {
        // Another tab may have trimmed this board's stored copy to save space: keep the one on screen.
        if (!x.lastState && prev.lastState) x.lastState = prev.lastState;
        viewing = x; x.items = sharedItems(x.lastState); render(); renderBanner();
      }
    }
    renderSwitcher();
  });
  function relayStarted() {
    updateShareStatus();
    updateSyncBtn();
    startSync();
    if (viewing) connectView();
    checkShares();
  }
  // On load: an authenticated read keeps each share from expiring (90 days unused) and finds any that did.
  async function checkShares() {
    for (const x of ownShares()) {
      try { await relay.getState(x); }
      catch (e) { if (e && (e.status === 404 || e.status === 401)) { dropShare(x); toast("A shared link expired, so it's no longer live"); } }
    }
    scheduleShares(true);
  }

  // ---------- device sync ----------
  // Your own list on all your devices, through a `sync` channel on the relay. The device that starts it owns the
  // channel and can add and unlink devices; every other device gets its own writer token from a pairing code.
  // Lists are merged per todo here in the browser (TodoStorage.merge); the relay only ever sees ciphertext.
  const SYNC_KEY = NS + ".sync";
  const WID_RE = /^[\w-]{1,32}$/;
  function loadSync() {
    try {
      const v = JSON.parse(lsGet(SYNC_KEY) || "null");
      if (!v || typeof v.relay !== "string" || !CHANNEL_RE.test(v.id) || !KEY_RE.test(v.key)) return null;
      if (typeof v.ownerToken !== "string" && typeof v.token !== "string") return null;
      const s = { relay: v.relay, id: v.id, key: v.key };
      if (typeof v.ownerToken === "string") s.ownerToken = v.ownerToken; else s.token = v.token;
      if (v.pending && WID_RE.test(v.pending.wid) && KEY_RE.test(v.pending.token)) s.pending = { wid: v.pending.wid, token: v.pending.token };
      return s;
    } catch { return null; }
  }
  let sync = loadSync();
  const saveSync = () => lsSet(SYNC_KEY, sync ? JSON.stringify(sync) : "");
  const syncDlg = $("syncDialog");
  function startSync() {
    if (!relay || !sync || sync.relay !== relay.base) return;
    const channel = sync.ownerToken ? { id: sync.id, key: sync.key, ownerToken: sync.ownerToken } : { id: sync.id, key: sync.key, token: sync.token };
    setRemote(TodoStorage.relaySync({ client: relay, channel, decode: decodeDoc }));
    updateSyncBtn();
  }
  function stopSync(msg) {
    sync = null; saveSync();
    if (remote !== baseRemote) setRemote(baseRemote);
    updateSyncBtn();
    if (syncDlg.open) renderSyncDialog();
    if (msg) toast(msg);
  }
  function syncGone(status) {
    stopSync(status === 404 ? "Sync stopped: the synced list is gone from the relay. Your list stays on this device."
      : "This device was unlinked, so it stopped syncing. Your list stays here.");
  }
  function updateSyncBtn() {
    $("syncBtn").hidden = !relay;
    $("syncBtn").textContent = sync ? "Sync: on" : "Sync across devices";
  }

  // A pairing code is base64url of { relay, channelId, key, writerToken }; as …#sync=<code> it's the QR code's link.
  function syncCodeFor(token) {
    return TodoRelay.toB64u(new TextEncoder().encode(JSON.stringify({ relay: sync.relay, channelId: sync.id, key: sync.key, writerToken: token })));
  }
  function parseSyncCode(text) {
    text = String(text || "").trim();
    const m = /#sync=([\w-]+)/.exec(text);
    if (m) text = m[1];
    try {
      const v = JSON.parse(new TextDecoder().decode(TodoRelay.fromB64u(text)));
      if (v && typeof v.relay === "string" && CHANNEL_RE.test(v.channelId) && KEY_RE.test(v.key) && KEY_RE.test(v.writerToken)) return v;
    } catch {}
    return null;
  }

  let linking = null; // { code, records }: the synced list, while asking whether to merge or replace
  let linkedCode = ""; // a code that arrived in a #sync= link: only linked once you confirm it's your own
  function syncError(msg) { $("syncErr").textContent = msg; $("syncErr").hidden = !msg; }
  function renderSyncDialog() {
    const on = !!sync;
    $("syncOff").hidden = on; $("syncOn").hidden = !on; $("syncOffBtn").hidden = !on;
    resetSyncOff();
    $("syncChoice").hidden = !linking;
    if (!on) return;
    const owner = !!sync.ownerToken;
    $("syncOwner").hidden = !owner; $("syncNotOwner").hidden = owner;
    $("syncState").textContent = owner ? "This device is synced. It started the sync, so add and unlink devices here."
      : "This device is synced with your other devices.";
    if (owner) refreshDevices();
  }
  function openSyncDialog(code) {
    if (!relay) { toast("Sync needs the relay, which isn't set up on this site."); return; }
    linking = null; syncError("");
    $("syncPair").hidden = true; $("syncCode").value = code || "";
    // A link can come from anyone, so it never links with one key press: it says what linking does and waits
    // for you to confirm the code is yours.
    linkedCode = code && !sync ? code : "";
    $("syncFromLink").hidden = !linkedCode; $("syncMine").checked = false;
    renderSyncDialog();
    syncDlg.showModal();
    (linkedCode ? $("syncMine") : sync ? $("syncClose") : $("syncStart")).focus();
  }
  $("syncBtn").addEventListener("click", () => openSyncDialog(""));
  $("syncClose").addEventListener("click", () => syncDlg.close());
  syncDlg.addEventListener("click", e => { if (e.target === syncDlg) syncDlg.close(); });

  // First device: make the channel and upload this list.
  $("syncStart").addEventListener("click", async () => {
    const b = $("syncStart");
    b.disabled = true; syncError("");
    try {
      const r = await relay.create("sync");
      if (!r || !CHANNEL_RE.test(r.id) || typeof r.ownerToken !== "string") throw new Error("bad reply");
      sync = { relay: relay.base, id: r.id, key: TodoRelay.newKey(), ownerToken: r.ownerToken };
      saveSync(); startSync(); renderSyncDialog();
      announce("Sync is on. Show a pairing code to add a device.");
    } catch { syncError("Couldn't reach the relay. Check your connection and try again."); }
    b.disabled = false;
  });

  // Another device: check the code against the synced list, ask merge or replace if both have todos, then link.
  async function linkDevice() {
    syncError("");
    const raw = $("syncCode").value, p = parseSyncCode(raw);
    if (!p) { syncError("That isn't a pairing code. Copy it again from your other device."); return; }
    if (p.relay !== relay.base) { syncError("That code is for a different Todos relay."); return; }
    if (linkedCode && raw.trim() === linkedCode && !$("syncMine").checked) {
      syncError("Only link a code you made on your own device. Tick the box to confirm."); $("syncMine").focus(); return;
    }
    const b = $("syncLink");
    b.disabled = true;
    try {
      if (!linking || linking.code !== raw) {
        linking = null;
        let st;
        try { st = await relay.getState({ id: p.channelId, token: p.writerToken }); }
        catch (e) {
          syncError(e && (e.status === 401 || e.status === 404) ? "That code has expired or its device was unlinked. Show a new one on your other device."
            : "Couldn't reach the relay. Check your connection and try again.");
          return;
        }
        let records = [];
        if (st && st.data) {
          try { records = decodeDoc((await TodoRelay.decrypt(p.key, st.data, 8e6)).items); }
          catch { syncError("That code doesn't match the synced list. Copy it again."); return; }
        }
        linking = { code: raw, records };
        if (items.length && records.some(r => !r.deleted)) { renderSyncDialog(); $("syncMerge").focus(); return; } // ask first
      }
      const replace = !$("syncChoice").hidden && $("syncReplace").checked;
      if (replace) adopt(linking.records.filter(r => !r.deleted), new Map(linking.records.filter(r => r.deleted).map(r => [r.id, r.updated])));
      sync = { relay: relay.base, id: p.channelId, key: p.key, token: p.writerToken };
      linking = null;
      saveSync(); startSync(); renderSyncDialog();
      toast(replace ? "Linked. This device now has your synced list." : "Linked. Both lists are merged and stay in sync.");
    } finally { b.disabled = false; }
  }
  $("syncLink").addEventListener("click", linkDevice);
  $("syncCode").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); linkDevice(); } });
  $("syncCode").addEventListener("input", () => { if (linking) { linking = null; renderSyncDialog(); } });

  // The first device adds devices (a writer token each, in a pairing code) and can unlink them.
  const validWriters = reply => (reply && Array.isArray(reply.writers) ? reply.writers : []).filter(w => w && typeof w.wid === "string" && WID_RE.test(w.wid));
  async function showPairingCode() {
    syncError("");
    try {
      const writers = validWriters(await relay.listWriters(sync));
      // One code per device: reuse the shown code until a device has linked with it.
      if (!(sync.pending && writers.some(w => w.wid === sync.pending.wid && !w.used))) {
        const w = await relay.mintWriter(sync);
        if (!w || typeof w.wid !== "string" || !WID_RE.test(w.wid) || !KEY_RE.test(w.token)) throw new Error("bad reply");
        sync.pending = { wid: w.wid, token: w.token }; saveSync();
      }
      const code = syncCodeFor(sync.pending.token);
      $("syncPairCode").textContent = code;
      const qr = TodoQR.svg(location.origin + location.pathname + "#sync=" + code);
      qr.setAttribute("role", "img"); qr.setAttribute("aria-label", "QR code with the pairing link");
      $("syncQr").replaceChildren(qr);
      $("syncPair").hidden = false;
      renderDevices(writers);
    } catch { syncError("Couldn't reach the relay. Check your connection and try again."); }
  }
  async function refreshDevices() {
    try { renderDevices(validWriters(await relay.listWriters(sync))); }
    catch { syncError("Couldn't load your devices. Check your connection."); }
  }
  function renderDevices(writers) {
    const ul = $("syncDevices"), list = writers.filter(w => typeof w.used === "number");
    if (!list.length) {
      const li = document.createElement("li"); li.className = "muted"; li.textContent = "No other devices yet.";
      ul.replaceChildren(li); return;
    }
    ul.replaceChildren(...list.map(w => {
      const li = document.createElement("li");
      const name = document.createElement("span"); name.className = "machine";
      name.textContent = "Device linked " + new Date(num(w.created)).toLocaleDateString(undefined, { day: "numeric", month: "short" });
      const when = document.createElement("small"); when.textContent = "seen " + (age(w.used) === "just now" ? "just now" : age(w.used) + " ago");
      const b = document.createElement("button"); b.type = "button"; b.className = "ghost-btn"; b.dataset.wid = w.wid;
      b.textContent = "Unlink"; b.setAttribute("aria-label", "Unlink " + name.textContent);
      li.append(name, when, b);
      return li;
    }));
  }
  $("syncShowCode").addEventListener("click", showPairingCode);
  $("syncCopy").addEventListener("click", async () => {
    const code = $("syncPairCode").textContent;
    try { await navigator.clipboard.writeText(code); } catch { toast("Couldn't copy. Select the code and copy it."); return; }
    toast("Pairing code copied");
    if (crypto.subtle) rememberClip(await sha256(code));
  });
  $("syncDevices").addEventListener("click", async e => {
    const b = e.target.closest("button[data-wid]");
    if (!b || !sync || !sync.ownerToken) return;
    b.disabled = true;
    try {
      await relay.revokeWriter(sync, b.dataset.wid);
      toast("Unlinked. That device stops syncing now.");
    } catch { toast("Couldn't unlink. Try again."); }
    refreshDevices();
  });
  function resetSyncOff() { $("syncOffBtn").classList.remove("confirm"); $("syncOffBtn").textContent = "Turn off sync on this device"; }
  $("syncOffBtn").addEventListener("click", () => {
    const b = $("syncOffBtn");
    if (!b.classList.contains("confirm")) { b.classList.add("confirm"); b.textContent = "Click again to turn off"; return; }
    stopSync("Sync is off on this device. Your list stays here.");
  });
  // Another tab turned sync on or off.
  window.addEventListener("storage", e => {
    if (e.key !== SYNC_KEY) return;
    sync = loadSync();
    if (sync) startSync(); else if (remote !== baseRemote) setRemote(baseRemote);
    updateSyncBtn();
  });

  // Hidden until config.js names a relay. tests/smoke.html swaps in a fake relay through this event.
  const relayBase = window.TodoStorage?.config.relayBase;
  if (relayBase && window.TodoRelay) startRelay(relayBase, {});
  window.addEventListener("todos:relay-seam", e => {
    const d = e.detail || {};
    startRelay(d.base, { fetch: d.fetch, WebSocket: d.WebSocket });
  });

  // ---------- history: every change can be undone / redone ----------
  const past = [], future = [];
  function snap() { return JSON.stringify(items); }
  const HISTORY_BYTES = 20e6;
  function record(label, before) {
    if (before === snap()) return;
    past.push({ label, items: before });
    let bytes = past.reduce((n, s) => n + s.items.length, 0);
    while (past.length > 100 || (past.length > 1 && bytes > HISTORY_BYTES)) bytes -= past.shift().items.length;
    future.length = 0;
    // A toast's Undo button means "undo that", so it goes away once something newer happens.
    if (toastAction) { $("toast").classList.remove("show"); toastAction = null; }
  }
  function restore(json) {
    for (const tm of linger.values()) clearTimeout(tm);
    linger.clear(); editingId = null;
    items = JSON.parse(json);
    applySessions(false); // an old snapshot may hold an older status
    save(); render();
  }
  // On a shared board, undo and redo only reach your own copies (Add to mine): nothing else is on screen.
  function undoBlocked(stack) {
    return viewing && stack.length && stack[stack.length - 1].label !== COPY_LABEL && blocked();
  }
  function undo() {
    if (undoBlocked(past)) return;
    const step = past.pop();
    if (!step) { toast("Nothing to undo"); return; }
    future.push({ label: step.label, items: snap() });
    restore(step.items);
    if (step.label === ADD_SESSION) unaddSessions(); // the suggestion goes back to the tray
    toast("Undid " + step.label, "Redo", redo);
    announce("Undid " + step.label);
  }
  function redo() {
    if (undoBlocked(future)) return;
    const step = future.pop();
    if (!step) { toast("Nothing to redo"); return; }
    past.push({ label: step.label, items: snap() });
    restore(step.items);
    toast("Redid " + step.label, "Undo", undo);
    announce("Redid " + step.label);
  }

  // ---------- toast ----------
  let toastTimer = null, toastAction = null;
  function toast(msg, actionLabel, action) {
    toastAction = action || null;
    $("toastMsg").textContent = msg;
    $("undo").hidden = !toastAction; $("undo").textContent = actionLabel || "";
    $("toast").classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $("toast").classList.remove("show"); toastAction = null; }, toastAction ? 6000 : 1800);
  }
  $("undo").addEventListener("click", () => { const a = toastAction; if (a) a(); });

  // ---------- global keys ----------
  document.addEventListener("keydown", e => {
    if (document.querySelector("dialog[open]")) return; // a dialog handles its own keys (Esc closes it)
    const tag = (e.target.tagName || "").toLowerCase();
    const typing = tag === "input" || tag === "textarea";
    // Ctrl/⌘+Z undo, Ctrl/⌘+Shift+Z or Ctrl+Y redo — for every change, from anywhere.
    // Only a text box you're actually typing in keeps its own text undo.
    const mod = e.metaKey || e.ctrlKey;
    const isUndo = mod && !e.altKey && e.key.toLowerCase() === "z";
    const isRedo = (isUndo && e.shiftKey) || (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "y");
    if (isUndo || isRedo) {
      const ownsText = typing && e.target.value !== "";
      if (!ownsText) { e.preventDefault(); isRedo ? redo() : undo(); return; }
    }
    if (e.key === "Escape") {
      if (!menu.hidden) { closeMenu(true); return; }
      if (panel.classList.contains("open")) { closePanel(); return; }
      if (focusLane && !typing) { setFocus(focusLane); return; }
    }
    if (typing || e.defaultPrevented) return;
    if (e.key === "`" && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); toggleBoards(); return; }
    if (e.key === "/") { e.preventDefault(); if (!blocked()) input.focus(); return; }
    // A: add the newest suggestion to P1, from anywhere on the board, a focused todo or card included.
    if ((e.key === "a" || e.key === "A") && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !viewing && trayList().length && !e.target.closest?.(".menu")) {
      e.preventDefault(); addSession(trayList()[0].id, "h"); return;
    }
    if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.target.closest?.("li[data-id], li[data-session], .menu")) {
      const card = hoveredCard();
      if (card && trayAction(card, e.key, true)) { e.preventDefault(); return; }
      const li = hoveredRow();
      if (li && rowAction(li, e.key, true)) { e.preventDefault(); return; }
      if ((e.key === "f" || e.key === "F") && ptr) {
        const lane = document.elementFromPoint(ptr.x, ptr.y)?.closest(".board .lane");
        if (lane) { e.preventDefault(); setFocus(lane.dataset.prio); }
      }
    }
  });

  buildBoard();
  applyFocus();
  syncInput();
  renderSwitcher();
  openFromHash();
  render();
  renderTray();
  if (!viewing) input.focus();
})();
