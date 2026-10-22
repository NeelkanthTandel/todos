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
  let items = [];               // {id, text, done, prio, created, doneAt?, wip?}
  let editingId = null, justId = null, enterIds = new Set(), landedId = null;
  const linger = new Map();     // id -> timer: just-done items still shown in lane
  const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } };
  // Every list from outside this tab (localStorage, an imported file, the server) passes through here, so a
  // corrupted or crafted value can't break the page: known fields only, right types, safe unique ids.
  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const num = v => (typeof v === "number" && Number.isFinite(v) ? v : 0);
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
    $("addBtn").textContent = n > 1 ? "Add " + n : "Add";
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
  input.addEventListener("input", () => { typedAt = performance.now(); syncInput(); });
  input.addEventListener("focus", () => { typedAt = performance.now(); });
  input.addEventListener("keydown", e => {
    // Composer empty and the mouse moved onto a todo since you last typed: shortcuts go to that todo.
    if (!input.value && !e.metaKey && !e.ctrlKey && !e.altKey && ptrMovedAt > typedAt && /^([1-4sSxXeE]|Delete)$/.test(e.key)) {
      const li = hoveredRow();
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
    input.value = ""; multiPick = null; syncInput(); input.focus(); typedAt = performance.now();
    if (n > 1) toast("Added " + n + " todos to " + LANE[prio].short, "Undo", undo);
  });

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
    menu.hidden = false;
    const r = btn.getBoundingClientRect(), mw = menu.offsetWidth, mh = menu.offsetHeight;
    let left = Math.min(r.right - mw, window.innerWidth - mw - 8); left = Math.max(8, left);
    let top = r.bottom + 6; if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    menu.style.left = left + "px"; menu.style.top = top + "px";
    (menu.querySelector('button:not([aria-current="true"])') || menu.querySelector("button")).focus();
  }
  function closeMenu(refocus) {
    if (menu.hidden) return;
    menu.hidden = true;
    if (refocus && menuBtn && document.contains(menuBtn)) menuBtn.focus();
    menuFor = null; menuBtn = null;
  }
  menu.addEventListener("click", e => {
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
  document.addEventListener("pointerdown", e => { if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('[data-act="move"]')) closeMenu(); });
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

  // ---------- backup: export / import a JSON file ----------
  // File shape: { app: "todos", version: 1, exported, items: Todo[] }. A bare Todo[] imports too.
  const MAX_IMPORT_BYTES = 2e6, MAX_IMPORT_ITEMS = 5000;
  $("exportBtn").addEventListener("click", () => {
    const data = { app: "todos", version: 1, exported: new Date().toISOString(), items };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    a.download = "todos-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast("Exported " + items.length + (items.length === 1 ? " todo" : " todos"));
  });
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
    save(); render();
  }
  function undo() {
    const step = past.pop();
    if (!step) { toast("Nothing to undo"); return; }
    future.push({ label: step.label, items: snap() });
    restore(step.items);
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
    if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.target.closest?.("li[data-id], .menu")) {
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
  render();
  input.focus();
})();
