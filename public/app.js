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
  function normSession(s) {
    if (!s || typeof s !== "object" || typeof s.id !== "string" || !SESSION_RE.test(s.id)) return null;
    return {
      id: s.id,
      state: Object.hasOwn(STATES, s.state) ? s.state : "ended",
      project: typeof s.project === "string" ? s.project.trim().slice(0, 120) : "",
      kind: s.kind === "cloud" ? "cloud" : "local",
      updatedAt: num(s.updatedAt),
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
      out.push(todo);
    }
    return out;
  }
  try { items = normalize(JSON.parse(lsGet(LS_KEY) || "[]")); } catch { items = []; }
  let pick = ORDER.includes(lsGet(NS + ".pick")) ? lsGet(NS + ".pick") : "n";
  let multiPick = null;

  // ---------- sync ----------
  // localStorage is always written (instant load, works offline). A remote store from storage.js,
  // when configured, mirrors the whole list on top of it.
  const remote = window.TodoStorage?.remote || null;
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
    writing = true;
    let tries = 0;
    while (dirty) {
      dirty = false;
      const updated = Math.max(Date.now(), syncedAt() + 1);
      try {
        await docRef.set({ items, updated });
        lsSet(SYNCED_KEY, String(updated));
        if (!dirty) { lsSet(PENDING_KEY, ""); setStatus("Synced"); }
        tries = 0;
      } catch (e) {
        if (e && e.code === "unavailable") { dirty = true; setStatus("Offline. Retrying…"); await sleep(backoff(tries++)); continue; }
        setStatus("Couldn't sync. Saved in this browser."); docRef = null;
      }
    }
    writing = false;
  }
  function save() {
    queued = null; // our own change wins over a list another tab sent mid-drag
    if (!lsSet(LS_KEY, JSON.stringify(items))) {
      setStatus("Browser storage is full. Changes aren't saved.");
      if (!storageFull) toast("Browser storage is full. Export a backup, then clear some done todos.");
      storageFull = true;
    } else storageFull = false;
    if (!remote) return;
    lsSet(PENDING_KEY, "1");
    if (docRef) { dirty = true; setStatus("Saving…"); flush(); }
  }
  // Take a list saved elsewhere (another tab, another device). During a drag the board can't re-render,
  // so it waits for the drop; an open edit keeps what you've typed so far.
  let queued = null, adopting = false;
  function adopt(next) {
    if (dragId) { queued = next; return; }
    queued = null;
    next = normalize(next);
    if (JSON.stringify(next) === JSON.stringify(items)) return;
    const ed = editingId && $("edit-" + editingId);
    const draft = ed && [ed.value, ed.selectionStart, ed.selectionEnd];
    if (editingId && !next.some(t => t.id === editingId)) editingId = null;
    items = next;
    past.length = 0; future.length = 0; // older snapshots would undo the other tab's work
    lsSet(LS_KEY, JSON.stringify(items));
    adopting = true; render(); adopting = false;
    const ed2 = draft && editingId && $("edit-" + editingId);
    if (ed2) { ed2.value = draft[0]; requestAnimationFrame(() => ed2.setSelectionRange(draft[1], draft[2])); }
  }
  async function connect() {
    for (let tries = 0; ; tries++) {
      try {
        const first = await remote.get();
        const has = first && Array.isArray(first.items) && (first.items.length > 0 || num(first.updated) > 0);
        docRef = remote;
        if (has && !(lsGet(PENDING_KEY) && items.length)) {
          lsSet(SYNCED_KEY, String(num(first.updated)));
          adopt(first.items); setStatus("Synced");
        } else if (items.length) { dirty = true; flush(); } // this browser has changes the server hasn't seen
        else setStatus("Synced");
        break;
      } catch (e) {
        if (!(e && e.code === "unavailable")) { setStatus("Couldn't reach server. Saved in this browser."); return; }
        setStatus("Offline. Retrying…"); await sleep(backoff(tries));
      }
    }
    remote.subscribe(data => {
      if (writing || dirty || !docRef || !data || !Array.isArray(data.items)) return;
      if (num(data.updated) <= syncedAt()) return; // nothing newer than what we already have
      lsSet(SYNCED_KEY, String(num(data.updated)));
      adopt(data.items);
    });
  }
  if (remote) connect();
  // Another tab of this browser saved: pick up its list.
  window.addEventListener("storage", e => {
    if (e.key !== LS_KEY || writing || dirty) return;
    try { adopt(JSON.parse(e.newValue || "[]")); } catch {}
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
    for (const l of LANES) {
      const list = items.filter(t => t.prio === l.k && inLane(t));
      $("list-" + l.k).replaceChildren(...list.map(t => row(t, false)));
      $("empty-" + l.k).hidden = list.length > 0;
      $("count-" + l.k).textContent = items.filter(t => t.prio === l.k && !t.done).length;
    }
    const open = items.filter(t => !t.done).length;
    const done = items.filter(t => t.done).length;
    $("summary").textContent = items.length ? open + " open" : "";
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
    const done = items.filter(t => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    $("clearDone").hidden = done.length === 0;
    if (!done.length) { body.innerHTML = '<p class="panel-empty">Nothing done yet. Tick a todo and it lands here.</p>'; return; }
    const frag = document.createDocumentFragment();
    let cur = null, ul = null;
    for (const t of done) {
      const lbl = dayLabel(t.doneAt || t.created || Date.now());
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
    const parsed = parse(raw); if (!parsed.length) return 0;
    const before = snap();
    const now = Date.now();
    parsed.forEach((p, i) => {
      const t = { id: uid(), text: p.text, done: p.done, prio, created: now + i };
      if (p.done) t.doneAt = now + i;
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
    const i = items.findIndex(t => t.id === id); if (i < 0) return;
    const before = snap();
    items.splice(i, 1); linger.delete(id);
    record("delete", before);
    save(); render();
    toast("Todo deleted", "Undo", undo);
  }

  function moveTo(id, prio, beforeId) {
    const t = find(id); if (!t) return;
    const before = snap();
    const i = items.indexOf(t); items.splice(i, 1);
    const from = t.prio; t.prio = prio;
    let idx = beforeId ? items.findIndex(x => x.id === beforeId) : -1;
    if (idx < 0) {
      let last = -1; items.forEach((x, j) => { if (x.prio === prio && !x.done) last = j; });
      idx = last + 1 || items.length;
      if (last < 0) idx = items.length;
    }
    items.splice(idx, 0, t);
    landedId = id;
    record(from !== prio ? "move to " + LANE[prio].name : "reorder", before);
    save(); render();
    if (from !== prio) announce("Moved to " + LANE[prio].name);
  }

  function commitEdit(id, value, cancel) {
    const t = find(id); editingId = null;
    if (t && !cancel) {
      const v = value.trim();
      if (!v) { render(); remove(id); return; }
      if (v !== t.text) { const before = snap(); t.text = v; record("edit", before); save(); }
    }
    render(); focusRow(id);
  }
  function focusRow(id, sel = ".text") {
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
    if (!clipOn() || clipBusy || clip || document.visibilityState !== "visible" || !composerIdle()) return;
    clipBusy = true;
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) return;
      const hash = await sha256(text);
      const age = Date.now() - firstSeen(hash);
      if (clipSeen.has(hash) || age > CLIP_EXPIRE || !TodoClipboard.check(text).ok) return;
      const lower = text.toLowerCase();
      if (items.some(t => t.text.toLowerCase() === lower)) return;
      if (!composerIdle()) return; // you started something while we were reading
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
  input.addEventListener("paste", () => { if (clipSupported && !lsGet(CLIP_KEY)) $("clipOffer").hidden = false; });
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
    if (act === "toggle") { toggle(id); requestAnimationFrame(() => focusRow(id, ".check")); }
    else if (act === "delete") remove(id);
    else if (act === "edit") { editingId = id; render(); }
    else if (act === "move") openMenu(btn, id);
    else if (act === "wip") { toggleWip(id); focusRow(id, ".text"); }
    else if (act === "session") copyResume(id);
  }
  function toggleWip(id) {
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
    if (!li || editingId) { e.preventDefault(); return; }
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
    if (!dragId) return;
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
  document.addEventListener("dragend", () => { clearDrag(); if (queued) adopt(queued); });
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
    else if (/^[1-4]$/.test(e.key)) { e.preventDefault(); btns[+e.key - 1].click(); }
    else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
  });
  document.addEventListener("pointerdown", e => { if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('[data-act="move"], #exportBtn')) closeMenu(); });
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
  $("exportBtn").addEventListener("click", e => {
    if (!menu.hidden && menuBtn === e.currentTarget) { closeMenu(); return; }
    closeMenu();
    menuFor = null; menuBtn = e.currentTarget;
    menu.innerHTML = '<p>Export</p>' + EXPORTS.map((x, i) =>
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
      const open = items.filter(t => t.prio === l.k && !t.done).map(t => t.text);
      const done = items.filter(t => t.prio === l.k && t.done)
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
    if (!items.length) { toast("Nothing to export yet"); return; }
    const count = items.length + (items.length === 1 ? " todo" : " todos");
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
  $("importBtn").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", async e => {
    const file = e.target.files[0]; e.target.value = "";
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) { toast("That file is too big to import (2 MB max)"); return; }
    let incoming;
    try {
      const data = JSON.parse(await file.text());
      incoming = Array.isArray(data) ? data : data && data.items;
      if (!Array.isArray(incoming)) throw 0;
    } catch { toast("That file isn't a todos export"); return; }
    if (incoming.length > MAX_IMPORT_ITEMS) { toast("That file has more than " + MAX_IMPORT_ITEMS + " todos"); return; }
    incoming = normalize(incoming);
    if (!incoming.length) { toast("No todos in that file"); return; }
    // Merge by id: a todo in the file replaces the same todo here, everything else is kept.
    const before = snap();
    const byId = new Map(incoming.map(t => [t.id, t]));
    items = items.map(t => byId.get(t.id) || t);
    const have = new Set(items.map(t => t.id));
    items.push(...incoming.filter(t => !have.has(t.id)));
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
      project: (m.project || "").trim(), title: (m.title || "").replace(/\s+/g, " ").trim() || null,
      kind: m.kind === "cloud" ? "cloud" : "local", machine: (m.machine || "").trim(),
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
    if (m.event === "suggest") { s.suggested = true; s.title = m.title || s.title; s.startedAt = m.at; }
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
    $("tray").hidden = list.length === 0;
    const again = keep && ul.querySelector('li[data-session="' + CSS.escape(keep) + '"]');
    const edit = trayEdit && ul.querySelector(".tray-edit");
    if (edit) { edit.focus(); edit.setSelectionRange(edit.value.length, edit.value.length); }
    else if (again) again.focus({ preventScroll: true });
    else if (keep) (ul.querySelector("li") || input).focus({ preventScroll: true });
    updateTitle();
  }
  function addSession(id, prio, text) {
    const s = sessions.get(id);
    if (!s) return;
    trayEdit = null;
    const before = snap();
    const t = {
      id: uid(), text: (text || s.title || untitled(s)).slice(0, 500), done: false, prio, created: Date.now(),
      session: { id: s.id, state: s.state, project: s.project, kind: s.kind, updatedAt: s.updatedAt },
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
    announce("Suggestion dismissed");
  }
  // Card shortcuts, for a focused card and the card under the mouse (like rowAction for todos).
  function trayAction(li, k, viaHover) {
    const id = li.dataset.session;
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
    if (!ptr || dragId || editingId || trayEdit) return null;
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
  }
  function follow() {
    if (sub) sub.close();
    sub = relay.subscribe(inbox, onRelayEvent);
  }
  async function onRelayEvent(ev) {
    if (ev.type === "deleted") { // the inbox is gone (expired): the next Connect makes a new one
      if (sub) { sub.close(); sub = null; }
      inbox = null; lsSet(INBOX_KEY, "");
      return;
    }
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
    if (ch) relay.deleteMessage(ch, ev.id).catch(() => {});
    window.dispatchEvent(new Event("todos:relaymsg")); // lets tests/smoke.html know a message was handled
  }
  // Another tab of this browser may have handled messages or made the inbox.
  window.addEventListener("storage", e => {
    if (e.key === SESS_KEY) { sessions = loadSessions(); renderTray(); }
    else if (e.key === INBOX_KEY && relay) {
      const next = loadInbox();
      if (next && next.relay === relay.base && (!inbox || inbox.id !== next.id)) { inbox = next; follow(); }
      else if (next && inbox && next.id === inbox.id) inbox = next;
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
  async function refreshDialog() {
    $("claudeErr").hidden = true;
    try {
      const ch = await ensureInbox();
      const reply = await relay.listWriters(ch);
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
  function undo() {
    const step = past.pop();
    if (!step) { toast("Nothing to undo"); return; }
    future.push({ label: step.label, items: snap() });
    restore(step.items);
    if (step.label === ADD_SESSION) unaddSessions(); // the suggestion goes back to the tray
    toast("Undid " + step.label, "Redo", redo);
    announce("Undid " + step.label);
  }
  function redo() {
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
    if ($("claudeDialog").open) return; // the dialog handles its own keys (Esc closes it)
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
    if (e.key === "/") { e.preventDefault(); input.focus(); return; }
    if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.target.closest?.("li[data-id], li[data-session], .menu")) {
      const card = hoveredCard();
      if (card && trayAction(card, e.key, true)) { e.preventDefault(); return; }
      const li = hoveredRow();
      if (li && rowAction(li, e.key, true)) { e.preventDefault(); return; }
      if ((e.key === "a" || e.key === "A") && !e.shiftKey && trayList().length) { e.preventDefault(); addSession(trayList()[0].id, "h"); return; }
      if ((e.key === "f" || e.key === "F") && ptr) {
        const lane = document.elementFromPoint(ptr.x, ptr.y)?.closest(".board .lane");
        if (lane) { e.preventDefault(); setFocus(lane.dataset.prio); }
      }
    }
  });

  buildBoard();
  applyFocus();
  syncInput();
  render();
  renderTray();
  input.focus();
})();
