// Client for the Todos relay (relay/ in the repo): create a channel, pair writers, follow it over a WebSocket,
// and the end-to-end encryption every message goes through. The relay only ever sees ciphertext; keys stay in
// this browser. Format: data = base64url(iv ‖ AES-256-GCM(deflate-raw(JSON))), shared with the Claude Code plugin.
(() => {
  const MAX_PLAIN = 64 * 1024; // a decrypted message never needs more; guards against a decompression bomb

  function toB64u(bytes) {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function fromB64u(s) {
    if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(bin, c => c.charCodeAt(0));
  }
  const random = n => crypto.getRandomValues(new Uint8Array(n));

  async function readAll(stream, max) {
    const reader = stream.getReader(), parts = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) { reader.cancel().catch(() => {}); throw new Error("too large"); }
      parts.push(value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }
  const deflate = bytes => readAll(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw")), Infinity);
  const inflate = bytes => readAll(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")), MAX_PLAIN);
  const importKey = (b64, use) => crypto.subtle.importKey("raw", fromB64u(b64), "AES-GCM", false, [use]);

  async function encrypt(keyB64, obj, iv = random(12)) {
    const plain = await deflate(new TextEncoder().encode(JSON.stringify(obj)));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await importKey(keyB64, "encrypt"), plain));
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv); out.set(ct, iv.length);
    return toB64u(out);
  }
  // Throws on anything that isn't ours: wrong key, tampered or truncated data, oversized or invalid JSON.
  async function decrypt(keyB64, data) {
    const bytes = fromB64u(data);
    if (bytes.length < 29) throw new Error("too short");
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await importKey(keyB64, "decrypt"), bytes.slice(12));
    return JSON.parse(new TextDecoder().decode(await inflate(new Uint8Array(plain))));
  }

  // Pairing code for /todos:connect: base64url(1 ‖ channel id (16 bytes) ‖ key (32) ‖ writer token (32) ‖ relay URL).
  function pairingCode({ relay, channelId, key, writerToken }) {
    const url = new TextEncoder().encode(relay);
    const parts = [Uint8Array.of(1), fromB64u(channelId), fromB64u(key), fromB64u(writerToken), url];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return toB64u(out);
  }

  // `fetch` and `WebSocket` can be swapped out (tests/smoke.html uses fakes).
  function client({ base, fetch: doFetch = (...a) => fetch(...a), WebSocket: WS = WebSocket }) {
    base = String(base).replace(/\/+$/, "");
    async function req(method, path, token, body) {
      const res = await doFetch(base + path, {
        method, cache: "no-store", credentials: "omit",
        headers: Object.assign(body ? { "Content-Type": "application/json" } : {}, token ? { Authorization: "Bearer " + token } : {}),
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) throw Object.assign(new Error("HTTP " + res.status), { status: res.status });
      return res.status === 204 ? null : res.json();
    }
    const ch = c => "/c/" + encodeURIComponent(c.id);
    return {
      base,
      create: kind => req("POST", "/c", null, { kind }),
      mintWriter: c => req("POST", ch(c) + "/writers", c.ownerToken),
      listWriters: c => req("GET", ch(c) + "/writers", c.ownerToken),
      revokeWriter: (c, wid) => req("DELETE", ch(c) + "/writers/" + encodeURIComponent(wid), c.ownerToken),
      deleteMessage: (c, mid) => req("DELETE", ch(c) + "/messages/" + encodeURIComponent(mid), c.ownerToken),

      // Follows a channel while the page is open. Reconnects with backoff, and straight away when the tab
      // comes back into view or the network returns. onEvent gets each parsed relay message.
      subscribe(c, onEvent, onStatus = () => {}) {
        const url = base.replace(/^http/, "ws") + ch(c);
        let ws = null, closed = false, tries = 0, timer = null, ping = null;
        function open() {
          if (closed || ws) return;
          let sock;
          try { sock = new WS(url, ["todos", "bearer." + c.ownerToken]); } catch { retry(); return; }
          ws = sock;
          sock.onopen = () => {
            tries = 0; onStatus("open");
            ping = setInterval(() => { try { sock.send("ping"); } catch {} }, 45000); // keeps proxies from dropping it
          };
          sock.onmessage = e => {
            if (typeof e.data !== "string" || e.data.length > 64 * 1024) return;
            let msg;
            try { msg = JSON.parse(e.data); } catch { return; } // "pong" and anything else that isn't JSON
            if (msg && typeof msg === "object") onEvent(msg);
          };
          sock.onclose = () => {
            if (ws !== sock) return;
            ws = null; clearInterval(ping);
            onStatus("closed");
            retry();
          };
        }
        function retry() {
          if (closed || timer) return;
          const ms = Math.min(60000, 1000 * 2 ** tries++) * (0.75 + Math.random() / 2);
          timer = setTimeout(() => { timer = null; open(); }, ms);
        }
        const wake = () => {
          if (closed || ws || document.visibilityState !== "visible") return;
          clearTimeout(timer); timer = null; tries = 0; open();
        };
        window.addEventListener("focus", wake);
        window.addEventListener("online", wake);
        document.addEventListener("visibilitychange", wake);
        open();
        return {
          close() {
            closed = true; clearTimeout(timer); clearInterval(ping);
            window.removeEventListener("focus", wake);
            window.removeEventListener("online", wake);
            document.removeEventListener("visibilitychange", wake);
            if (ws) { const s = ws; ws = null; try { s.close(); } catch {} }
          },
        };
      },
    };
  }

  window.TodoRelay = { toB64u, fromB64u, encrypt, decrypt, pairingCode, newKey: () => toB64u(random(32)), client };
})();
