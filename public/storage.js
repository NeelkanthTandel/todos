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
//                        project: string, kind: "local"|"cloud", updatedAt: number } }
//   `session` links a todo added from a Claude Code session to that session (id: /^[\w-]{1,64}$/,
//   project: at most 120 characters). The board keeps `state` up to date from the relay inbox.
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

  window.TodoStorage = { config, remote: config.storage === "http" ? httpStore(config.apiBase, config.credentials) : null };
})();
