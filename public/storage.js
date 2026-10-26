// Storage seam. app.js always keeps a localStorage copy; `remote` is the optional server-side store
// that mirrors it. Moving to Postgres/Mongo means standing up an API with this contract and setting
// storage: "http" in config.js. Nothing in app.js changes.
//
//   GET {apiBase}/todos  -> 200 { items: Todo[], updated: number }, or 404 when nothing is stored yet
//   PUT {apiBase}/todos  <- { items: Todo[], updated: number }       -> any 2xx
//
//   Todo = { id: string, text: string, done: boolean, prio: "h"|"m"|"l"|"n",
//            created: number, doneAt?: number, wip?: true,         (timestamps are epoch ms)
//            session?: { id: string, state: "running"|"needs_you"|"your_turn"|"ended",
//                        project: string, kind: "local"|"cloud", updatedAt: number },
//            pos: number, updated: number }
//   `session` links a todo added from a Claude Code session to that session (id: /^[\w-]{1,64}$/,
//   project: at most 120 characters). The board keeps `state` up to date from the relay inbox.
//   `pos` orders a lane (a fractional index: a moved todo goes halfway between its new neighbours) and
//   `updated` is when that todo last changed. Lists saved before these existed still load: missing positions
//   follow the saved order, and `updated` falls back to `doneAt` or `created`.
//
// Device sync (relaySync below) also keeps deletions, as tombstones { id, deleted: true, updated }, for 30 days,
// and merges per todo: union by id, the newest `updated` wins, and a deletion beats an edit made at the same time.
//
// The server decides whose list it is (cookie/session/header), so the client never sends a user id.
// Network errors, 429 and 5xx (except 501) are retried with backoff by app.js; any other failure falls
// back to browser-only. A server with no list for this user should answer 404 (or { items: [], updated: 0 }),
// so the browser uploads what it already has.
(() => {
  const config = Object.assign({ storage: "local", namespace: "todos", apiBase: "/api", credentials: "same-origin", relayBase: "" }, window.TODO_CONFIG);
  const unavailable = msg => Object.assign(new Error(msg), { code: "unavailable" });

  function httpStore(apiBase, credentials) {
    const url = apiBase.replace(/\/$/, "") + "/todos";
    async function req(method, body) {
      let res;
      try {
        res = await fetch(url, {
          method, credentials, cache: "no-store",
          headers: body ? { "Content-Type": "application/json" } : {},
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch { throw unavailable("network"); }
      if (res.status === 429 || (res.status >= 500 && res.status !== 501)) throw unavailable("HTTP " + res.status);
      return res;
    }
    const store = {
      async get() {
        const res = await req("GET");
        if (res.status === 404) return null;
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      },
      async set(data) {
        const res = await req("PUT", data);
        if (!res.ok) throw new Error("HTTP " + res.status);
      },
      // No push channel: re-read whenever the tab comes back into view (covers edits from other devices).
      subscribe(fn) {
        let busy = false;
        const check = () => {
          if (busy || document.visibilityState !== "visible") return;
          busy = true;
          store.get().then(d => d && fn(d), () => {}).finally(() => { busy = false; });
        };
        document.addEventListener("visibilitychange", check);
        window.addEventListener("focus", check);
        return () => { document.removeEventListener("visibilitychange", check); window.removeEventListener("focus", check); };
      },
    };
    return store;
  }

  // ---------- merging, for device sync ----------
  const TOMB_TTL = 30 * 864e5;
  // The same JSON for the same record on every device, whatever order its keys were set in.
  const canon = v => Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" :
    v && typeof v === "object" ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}" : JSON.stringify(v);
  function newer(r, cur) {
    if (r.updated !== cur.updated) return r.updated > cur.updated;
    if (!!r.deleted !== !!cur.deleted) return !!r.deleted; // deleted and edited in the same millisecond: deleted
    return canon(r) > canon(cur); // two devices at the same moment: any fixed choice, the same on both
  }
  const byPos = (a, b) => (!!a.deleted - !!b.deleted) || (a.deleted ? 0 : a.pos - b.pos) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  // Merges two lists of validated records (todos and tombstones): union by id, last writer wins per todo, and
  // tombstones older than 30 days are dropped. Order-independent: merge(a, b) and merge(b, a) are the same list.
  function merge(a, b, now = Date.now()) {
    const best = new Map();
    for (const r of a.concat(b)) {
      const cur = best.get(r.id);
      if (!cur || newer(r, cur)) best.set(r.id, r);
    }
    return [...best.values()].filter(r => !(r.deleted && now - r.updated > TOMB_TTL)).sort(byPos);
  }
  const sameDoc = (a, b) => a.length === b.length && canon([...a].sort(byPos)) === canon([...b].sort(byPos));

  // ---------- device sync over the relay ----------
  // A `sync` channel holds the whole list (todos and tombstones), encrypted: data = { v: 1, items }. Saving sends
  // If-Match with the version this device last saw; on 409 it reads the newer list, merges and tries again.
  // `decode` validates a decrypted list (app.js's normalize) and must return records ready for merge().
  // Errors: code "unavailable" (offline, rate-limited: retry), code "gone" (unlinked or deleted: stop).
  const MAX_SYNC_PLAIN = 8e6;
  function relaySync({ client, channel, decode, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
    let version = 0;
    const fail = e => {
      const st = e && e.status;
      if (st === 401 || st === 404) return Object.assign(new Error("gone"), { code: "gone", status: st });
      if (!st || st === 429 || st >= 500) return unavailable("HTTP " + (st || "network"));
      return e;
    };
    async function open(data) {
      if (!data) return [];
      try { return decode((await TodoRelay.decrypt(channel.key, data, MAX_SYNC_PLAIN)).items); } catch { return null; }
    }
    async function read() {
      let r;
      try { r = await client.getState(channel); } catch (e) { throw fail(e); }
      version = Number(r && r.version) || 0;
      return { items: (await open(r && r.data)) || [], version };
    }
    return {
      merges: true,
      get: read,
      // Resolves to null, or to { items } when it had to merge in another device's list first.
      async set({ items }) {
        let merged = false;
        for (let tries = 0; ; tries++) {
          const data = await TodoRelay.encrypt(channel.key, { v: 1, items });
          try {
            const r = await client.putState(channel, data, version);
            version = Number(r && r.version) || version + 1;
            return merged ? { items } : null;
          } catch (e) {
            if (!(e && e.status === 409) || tries >= 8) throw e && e.status === 409 ? unavailable("conflict") : fail(e);
          }
          // Another device saved first: take its list, merge ours in, and try again.
          items = merge(items, (await read()).items);
          merged = true;
          await sleep(Math.min(5000, 100 * 2 ** tries) * (0.5 + Math.random()));
        }
      },
      // fn gets { items, version } for each newer list, or { gone: true } once this device can't sync any more.
      subscribe(fn) {
        const sub = client.subscribe(channel, async ev => {
          if (ev.type === "deleted") { fn({ gone: true }); return; }
          if (ev.type !== "state" || typeof ev.data !== "string") return;
          const v = Number(ev.version) || 0;
          if (v <= version) { fn({ same: true }); return; } // ours, or one we've already read
          version = v;
          const items = await open(ev.data);
          fn(items ? { items, version: v } : { same: true });
        }, (status, code) => {
          if (status !== "closed") return;
          if (code === 4001) { fn({ gone: true }); return; } // this device was unlinked
          read().catch(e => { if (e && e.code === "gone") fn({ gone: true }); }); // a socket can't say why it failed
        });
        return () => sub.close();
      },
    };
  }

  window.TodoStorage = {
    config, merge, sameDoc, relaySync, TOMB_TTL,
    remote: config.storage === "http" ? httpStore(config.apiBase, config.credentials) : null,
  };
})();
