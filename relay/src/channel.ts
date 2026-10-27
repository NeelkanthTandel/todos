// One Durable Object per channel. It stores ciphertext it can't read, checks tokens (kept only as SHA-256
// hashes), enforces the limits and pushes updates to open WebSockets. Sockets use the Hibernation API, so an
// idle board costs nothing.
import { DurableObject } from "cloudflare:workers";

export const KINDS = ["inbox", "share", "sync"];
type Kind = "inbox" | "share" | "sync";
type Role = { owner: true } | { owner: false; wid: string } | null;

export const LIMITS = {
  state: 256 * 1024,       // characters of `data` in a state blob
  message: 16 * 1024,      // characters of `data` in an inbox message
  messages: 500,           // inbox size; the oldest are dropped
  writers: 50,             // paired machines or devices per channel
  burst: 5,                // writes allowed at once…
  perSecond: 2,            // …refilling at this rate (per channel)
  ttl: 90 * 864e5,         // a channel unused this long deletes itself
};
const TOUCH_EVERY = 3600e3; // write the "last used" time at most this often
const SEEN_EVERY = 60e3;    // and a sync device's "last seen" time at most this often

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
export const fail = (status: number, error: string) => json({ error }, status);

const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const randomId = (n: number) => b64u(crypto.getRandomValues(new Uint8Array(n)));
async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Reads a request body as text, giving up (null) past `max` bytes without buffering the rest.
export async function readCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("Content-Length"));
  if (declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

// `data` must be a base64url string (iv ‖ ciphertext); anything else isn't from a Todos client.
const DATA_RE = /^[A-Za-z0-9_-]+$/;
async function readData(req: Request, max: number): Promise<string | Response> {
  const body = await readCapped(req, max + 1024);
  if (body === null) return fail(413, "too large");
  let data: unknown;
  try { data = JSON.parse(body).data; } catch { return fail(400, "body must be JSON: { data }"); }
  if (typeof data !== "string" || !DATA_RE.test(data)) return fail(400, "data must be a base64url string");
  if (data.length > max) return fail(413, "too large");
  return data;
}

function bearer(req: Request): string | null {
  const auth = req.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  // Browsers can't set headers on a WebSocket, so the token rides in a subprotocol: ["todos", "bearer.<token>"].
  for (const p of (req.headers.get("Sec-WebSocket-Protocol") || "").split(",")) {
    const t = p.trim();
    if (t.startsWith("bearer.")) return t.slice(7);
  }
  return null;
}

export class Channel extends DurableObject<Env> {
  private sql: SqlStorage;
  private ready = false; // the tables exist (made by init, gone after destroy)
  private tokens = LIMITS.burst;
  private refilledAt = Date.now();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // No schema here: any GET to a made-up id builds an instance, and it mustn't leave a database behind.
    // Keepalive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private schema() {
    this.ready = true;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v);
      CREATE TABLE IF NOT EXISTS writers (wid TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, created INTEGER NOT NULL, used INTEGER);
      CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, at INTEGER NOT NULL, wid TEXT);
    `);
  }

  // Tables exist only for a live channel. Checking is a read, so a lookup of an unknown id writes nothing.
  private hasTables(): boolean {
    if (!this.ready) this.ready = this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0;
    return this.ready;
  }
  private get(k: string): any {
    if (!this.hasTables()) return null;
    const rows = this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray();
    return rows.length ? rows[0].v : null;
  }
  private set(k: string, v: string | number | null) {
    this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  }

  private async role(req: Request): Promise<Role> {
    const token = bearer(req);
    if (!token || token.length > 128) return null;
    const hash = await sha256(token);
    if (!this.get("kind")) return null; // deleted while we hashed
    if (hash === this.get("owner")) return { owner: true };
    const w = this.sql.exec("SELECT wid FROM writers WHERE hash = ?", hash).toArray()[0];
    return w ? { owner: false, wid: String(w.wid) } : null;
  }

  // A slow body upload is a gap other requests can use: re-check that the channel is still there and the
  // writer still paired before writing. Everything after this is synchronous, so nothing can slip in.
  private gone(role: Role): Response | null {
    if (!this.get("kind")) return fail(404, "no such channel");
    if (role && !role.owner && !this.sql.exec("SELECT 1 FROM writers WHERE wid = ?", role.wid).toArray().length) return fail(401, "missing or wrong token");
    return null;
  }

  // Remember when the channel was last used, and make sure the expiry alarm is set.
  private async touch() {
    const now = Date.now();
    if (now - (Number(this.get("touched")) || 0) > TOUCH_EVERY) this.set("touched", now);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + LIMITS.ttl);
  }

  // Token bucket: a short burst is fine (several sessions finishing together), a stream isn't.
  private allowWrite(): boolean {
    const now = Date.now();
    this.tokens = Math.min(LIMITS.burst, this.tokens + ((now - this.refilledAt) / 1000) * LIMITS.perSecond);
    this.refilledAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  private broadcast(msg: unknown, tag?: string) {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets(tag)) {
      try { ws.send(text); } catch {}
    }
  }

  private messages() {
    return this.sql.exec("SELECT id, data, at, wid FROM messages ORDER BY seq").toArray()
      .map(r => ({ id: r.id, data: r.data, at: r.at, wid: r.wid }));
  }
  private stateBody() {
    return { version: Number(this.get("version")) || 0, data: this.get("state") };
  }

  private async destroy() {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(JSON.stringify({ type: "deleted" })); ws.close(1000, "deleted"); } catch {}
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.ready = false; // this instance may keep serving requests (all of them 404 now, without writing)
  }

  async fetch(req: Request): Promise<Response> {
    const parts = new URL(req.url).pathname.split("/").filter(Boolean); // ["c", id, ...rest]
    const id = parts[1], rest = parts.slice(2), m = req.method;

    if (rest[0] === "init" && m === "POST") {
      if (this.get("kind")) return fail(409, "channel exists");
      const { kind } = await req.json<{ kind: Kind }>();
      this.schema();
      const ownerToken = randomId(32);
      this.set("kind", kind);
      this.set("owner", await sha256(ownerToken));
      this.set("version", 0);
      this.set("created", Date.now());
      await this.touch();
      return json({ id, kind, ownerToken }, 201);
    }

    const role = await this.role(req);
    const kind = this.get("kind") as Kind | null; // read after hashing: a DELETE may have landed meanwhile
    if (!kind) return fail(404, "no such channel");
    const isOwner = !!role?.owner;
    const canWrite = !!role; // owner or a paired writer
    const canRead = kind === "share" || (kind === "inbox" ? isOwner : canWrite);
    // Watching a shared board counts as using it, so a link people still open doesn't expire after 90 days.
    if (role || (kind === "share" && m === "GET")) await this.touch();
    // A paired sync device reads more than it writes, so any request counts as "last seen" (shown when unlinking).
    if (kind === "sync" && role && !role.owner) {
      const now = Date.now();
      this.sql.exec("UPDATE writers SET used = ? WHERE wid = ? AND (used IS NULL OR used < ?)", now, role.wid, now - SEEN_EVERY);
    }

    // GET /c/:id (optionally a WebSocket)
    if (rest.length === 0 && m === "GET") {
      if (!canRead) return fail(401, "missing or wrong token");
      if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") return this.accept(req, kind, role);
      return json(kind === "inbox" ? { kind, messages: this.messages() } : { kind, ...this.stateBody() });
    }
    // DELETE /c/:id
    if (rest.length === 0 && m === "DELETE") {
      if (!isOwner) return fail(401, "missing or wrong token");
      await this.destroy();
      return new Response(null, { status: 204 });
    }

    // PUT /c/:id/state (share: owner, sync: owner or writers)
    if (rest[0] === "state" && rest.length === 1 && m === "PUT") {
      if (kind === "inbox") return fail(400, "inbox channels have no state; POST messages instead");
      if (kind === "share" ? !isOwner : !canWrite) return fail(401, "missing or wrong token");
      const data = await readData(req, LIMITS.state);
      if (data instanceof Response) return data;
      const lost = this.gone(role);
      if (lost) return lost;
      const current = Number(this.get("version")) || 0;
      const ifMatch = req.headers.get("If-Match");
      if (ifMatch !== null && ifMatch.replace(/"/g, "").trim() !== String(current)) return json({ error: "version conflict", version: current }, 409);
      if (!this.allowWrite()) return fail(429, "too many writes, slow down");
      const version = current + 1;
      this.set("state", data);
      this.set("version", version);
      this.broadcast({ type: "state", version, data });
      return json({ version }, 200, { ETag: '"' + version + '"' });
    }

    // POST /c/:id/messages (inbox: writers)
    if (rest[0] === "messages" && rest.length === 1 && m === "POST") {
      if (kind !== "inbox") return fail(400, "only inbox channels take messages");
      if (!role || role.owner) return fail(401, "missing or wrong token");
      const data = await readData(req, LIMITS.message);
      if (data instanceof Response) return data;
      const lost = this.gone(role);
      if (lost) return lost;
      if (!this.allowWrite()) return fail(429, "too many writes, slow down");
      const mid = randomId(9), at = Date.now();
      this.sql.exec("INSERT INTO messages (id, data, at, wid) VALUES (?, ?, ?, ?)", mid, data, at, role.wid);
      this.sql.exec("DELETE FROM messages WHERE seq NOT IN (SELECT seq FROM messages ORDER BY seq DESC LIMIT ?)", LIMITS.messages);
      this.sql.exec("UPDATE writers SET used = ? WHERE wid = ?", at, role.wid);
      this.broadcast({ type: "message", id: mid, data, at, wid: role.wid }, "reader");
      return json({ id: mid }, 201);
    }
    // DELETE /c/:id/messages/:mid (inbox: owner)
    if (rest[0] === "messages" && rest.length === 2 && m === "DELETE") {
      if (!isOwner) return fail(401, "missing or wrong token");
      // Tell the board's other tabs, so a message handled in one disappears from all of them.
      if (this.sql.exec("DELETE FROM messages WHERE id = ?", rest[1]).rowsWritten) this.broadcast({ type: "removed", id: rest[1] }, "reader");
      return new Response(null, { status: 204 });
    }

    // Writers (pairing): owner only, inbox and sync
    if (rest[0] === "writers") {
      if (!isOwner) return fail(401, "missing or wrong token");
      if (kind === "share") return fail(400, "share channels have no writers");
      if (rest.length === 1 && m === "POST") {
        const wid = randomId(6), token = randomId(32), hash = await sha256(token), created = Date.now();
        // Checked after the await so concurrent pairings can't overshoot the cap or write into a deleted channel.
        if (!this.get("kind")) return fail(404, "no such channel");
        if (Number(this.sql.exec("SELECT count(*) AS n FROM writers").one().n) >= LIMITS.writers) return fail(409, "too many paired devices; unlink one first");
        if (!this.allowWrite()) return fail(429, "too many writes, slow down");
        this.sql.exec("INSERT INTO writers (wid, hash, created) VALUES (?, ?, ?)", wid, hash, created);
        return json({ wid, token, created }, 201);
      }
      if (rest.length === 1 && m === "GET") {
        const writers = this.sql.exec("SELECT wid, created, used FROM writers ORDER BY created").toArray()
          .map(r => ({ wid: r.wid, created: r.created, used: r.used ?? null }));
        return json({ writers });
      }
      if (rest.length === 2 && m === "DELETE") {
        this.sql.exec("DELETE FROM writers WHERE wid = ?", rest[1]);
        for (const ws of this.ctx.getWebSockets("w:" + rest[1])) {
          try { ws.close(4001, "revoked"); } catch {}
        }
        return new Response(null, { status: 204 });
      }
    }
    return fail(405, "method not allowed");
  }

  private accept(req: Request, kind: Kind, role: Role): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // Tags: "reader" gets pushes; "w:<wid>" lets a revoke close that writer's sockets.
    const tags = ["reader"];
    if (role && !role.owner) tags.push("w:" + role.wid);
    this.ctx.acceptWebSocket(server, tags);
    // Catch the new socket up: pending inbox messages, or the latest state.
    if (kind === "inbox") for (const msg of this.messages()) server.send(JSON.stringify({ type: "message", ...msg }));
    else server.send(JSON.stringify({ type: "state", ...this.stateBody() }));
    const headers: Record<string, string> = {};
    if ((req.headers.get("Sec-WebSocket-Protocol") || "").split(",").some(p => p.trim() === "todos")) headers["Sec-WebSocket-Protocol"] = "todos";
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  async webSocketMessage() {
    // Clients only listen; "ping" is answered by the auto-response above.
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch {}
  }

  async alarm() {
    if (!this.get("kind")) return;
    const touched = Number(this.get("touched")) || 0;
    if (Date.now() - touched >= LIMITS.ttl) await this.destroy();
    else await this.ctx.storage.setAlarm(touched + LIMITS.ttl);
  }
}
