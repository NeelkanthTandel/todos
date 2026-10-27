import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/channel";

const BASE = "https://relay.test";
const SITE = "https://todos.always17.com";
let ipSeq = 0;

function call(path: string, init: RequestInit & { token?: string; origin?: string; ip?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", "Bearer " + init.token);
  if (init.origin) headers.set("Origin", init.origin);
  headers.set("CF-Connecting-IP", init.ip || "10.0.0." + ++ipSeq);
  return exports.default.fetch(new Request(BASE + path, { ...init, headers }));
}
const post = (path: string, body: unknown, init: Parameters<typeof call>[1] = {}) =>
  call(path, { ...init, method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const put = (path: string, body: unknown, init: Parameters<typeof call>[1] = {}) =>
  call(path, { ...init, method: "PUT", body: JSON.stringify(body) });

async function create(kind: string) {
  const res = await post("/c", { kind });
  expect(res.status).toBe(201);
  return res.json<{ id: string; kind: string; ownerToken: string }>();
}
async function mint(id: string, ownerToken: string) {
  const res = await call("/c/" + id + "/writers", { method: "POST", token: ownerToken });
  expect(res.status).toBe(201);
  return res.json<{ wid: string; token: string }>();
}
// Opens a WebSocket the way the website does (token in a subprotocol) and collects what it receives.
async function socket(id: string, token?: string) {
  const protocols = ["todos", ...(token ? ["bearer." + token] : [])];
  const res = await call("/c/" + id, { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": protocols.join(", ") } });
  const ws = res.webSocket;
  if (!ws) return { res, ws: null, got: [] as any[], closed: null as null | { code: number } };
  const out = { res, ws, got: [] as any[], closed: null as null | { code: number } };
  ws.accept();
  ws.addEventListener("message", e => { out.got.push(JSON.parse(e.data as string)); });
  ws.addEventListener("close", e => { out.closed = { code: e.code }; });
  return out;
}
const until = async (cond: () => boolean) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setTimeout(r, 5)); return cond(); };
const data = (n = 40) => "A".repeat(n);
const stubOf = (id: string) => env.CHANNEL.get(env.CHANNEL.idFromName(id));
// Sends a body that stalls after its first bytes until finish(), like a slow upload.
function slow(method: string, path: string, token: string, body: unknown) {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const stream = new ReadableStream<Uint8Array>({ start(c) { ctl = c; c.enqueue(bytes.slice(0, 5)); } });
  const headers = { Authorization: "Bearer " + token, "CF-Connecting-IP": "10.0.1." + ++ipSeq };
  const res = exports.default.fetch(new Request(BASE + path, { method, body: stream, headers, duplex: "half" } as RequestInit));
  return { res, finish: () => { ctl.enqueue(bytes.slice(5)); ctl.close(); } };
}
const settle = () => new Promise(r => setTimeout(r, 30));
// Tables the Channel made (the runtime keeps its own _cf_* ones).
const tables = (sql: SqlStorage) => sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map(r => String(r.name)).filter(n => !n.startsWith("_cf_"));

describe("inbox", () => {
  it("creates, pairs a writer, takes a message and returns it to the owner", async () => {
    const ch = await create("inbox");
    expect(ch.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(ch.ownerToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const w = await mint(ch.id, ch.ownerToken);
    const sent = await post("/c/" + ch.id + "/messages", { data: data() }, { token: w.token });
    expect(sent.status).toBe(201);
    const { id: mid } = await sent.json<{ id: string }>();
    const read = await call("/c/" + ch.id, { token: ch.ownerToken });
    expect(read.status).toBe(200);
    const body = await read.json<any>();
    expect(body.kind).toBe("inbox");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({ id: mid, data: data(), wid: w.wid });

    expect((await call("/c/" + ch.id + "/messages/" + mid, { method: "DELETE", token: ch.ownerToken })).status).toBe(204);
    expect((await (await call("/c/" + ch.id, { token: ch.ownerToken })).json<any>()).messages).toHaveLength(0);
  });

  it("caps paired writers at 50", async () => {
    const ch = await create("inbox");
    await runInDurableObject(stubOf(ch.id), async (_o, state) => {
      for (let i = 0; i < LIMITS.writers - 1; i++) state.storage.sql.exec("INSERT INTO writers (wid, hash, created) VALUES (?, ?, 0)", "w" + i, "h" + i);
    });
    await mint(ch.id, ch.ownerToken);
    const over = await call("/c/" + ch.id + "/writers", { method: "POST", token: ch.ownerToken });
    expect(over.status).toBe(409);
    expect(await over.json()).toEqual({ error: "too many paired devices; unlink one first" });
  });

  it("lists writers with when they were last used", async () => {
    const ch = await create("inbox");
    const w = await mint(ch.id, ch.ownerToken);
    await post("/c/" + ch.id + "/messages", { data: data() }, { token: w.token });
    const list = await (await call("/c/" + ch.id + "/writers", { token: ch.ownerToken })).json<any>();
    expect(list.writers).toHaveLength(1);
    expect(list.writers[0].wid).toBe(w.wid);
    expect(list.writers[0].used).toBeTypeOf("number");
  });

  it("keeps only the newest 500 messages", async () => {
    const ch = await create("inbox");
    const w = await mint(ch.id, ch.ownerToken);
    await runInDurableObject(env.CHANNEL.get(env.CHANNEL.idFromName(ch.id)), async (_o, state) => {
      for (let i = 0; i < LIMITS.messages; i++) state.storage.sql.exec("INSERT INTO messages (id, data, at, wid) VALUES (?, 'AA', 0, 'x')", "m" + i);
    });
    await post("/c/" + ch.id + "/messages", { data: "NEWEST" }, { token: w.token });
    const { messages } = await (await call("/c/" + ch.id, { token: ch.ownerToken })).json<any>();
    expect(messages).toHaveLength(LIMITS.messages);
    expect(messages[0].id).toBe("m1");
    expect(messages.at(-1).data).toBe("NEWEST");
  });
});

describe("share and sync state", () => {
  it("share: the owner writes, anyone with the id reads", async () => {
    const ch = await create("share");
    expect((await put("/c/" + ch.id + "/state", { data: data() })).status).toBe(401);
    const res = await put("/c/" + ch.id + "/state", { data: data() }, { token: ch.ownerToken });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 1 });
    expect(await (await call("/c/" + ch.id)).json()).toEqual({ kind: "share", version: 1, data: data() });
  });

  it("sync: writers read and write, and If-Match catches conflicts", async () => {
    const ch = await create("sync");
    const w = await mint(ch.id, ch.ownerToken);
    expect((await call("/c/" + ch.id)).status).toBe(401);
    expect((await put("/c/" + ch.id + "/state", { data: "AAA" }, { token: w.token, headers: { "If-Match": "0" } })).status).toBe(200);
    const stale = await put("/c/" + ch.id + "/state", { data: "BBB" }, { token: ch.ownerToken, headers: { "If-Match": "0" } });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ version: 1 });
    expect((await put("/c/" + ch.id + "/state", { data: "BBB" }, { token: ch.ownerToken, headers: { "If-Match": "1" } })).status).toBe(200);
    expect(await (await call("/c/" + ch.id, { token: w.token })).json()).toEqual({ kind: "sync", version: 2, data: "BBB" });
  });
});

describe("auth", () => {
  it("rejects missing and wrong tokens with 401", async () => {
    const ch = await create("inbox");
    const w = await mint(ch.id, ch.ownerToken);
    expect((await call("/c/" + ch.id)).status).toBe(401);
    expect((await call("/c/" + ch.id, { token: "nope" })).status).toBe(401);
    expect((await call("/c/" + ch.id, { token: w.token })).status).toBe(401); // writers can't read an inbox
    expect((await post("/c/" + ch.id + "/messages", { data: data() })).status).toBe(401);
    expect((await post("/c/" + ch.id + "/messages", { data: data() }, { token: "x".repeat(43) })).status).toBe(401);
    expect((await call("/c/" + ch.id + "/writers", { method: "POST", token: w.token })).status).toBe(401);
    expect((await call("/c/" + ch.id, { method: "DELETE", token: w.token })).status).toBe(401);
    expect((await (await socket(ch.id)).res).status).toBe(401);
  });

  it("revoking a writer locks it out", async () => {
    const ch = await create("inbox");
    const w = await mint(ch.id, ch.ownerToken);
    expect((await post("/c/" + ch.id + "/messages", { data: data() }, { token: w.token })).status).toBe(201);
    expect((await call("/c/" + ch.id + "/writers/" + w.wid, { method: "DELETE", token: ch.ownerToken })).status).toBe(204);
    expect((await post("/c/" + ch.id + "/messages", { data: data() }, { token: w.token })).status).toBe(401);
    const list = await (await call("/c/" + ch.id + "/writers", { token: ch.ownerToken })).json<any>();
    expect(list.writers).toHaveLength(0);
  });

  it("a sync device counts as used once it reads", async () => {
    const ch = await create("sync");
    const w = await mint(ch.id, ch.ownerToken);
    const before = await (await call("/c/" + ch.id + "/writers", { token: ch.ownerToken })).json<any>();
    expect(before.writers[0].used).toBeNull();
    expect((await call("/c/" + ch.id, { token: w.token })).status).toBe(200);
    const after = await (await call("/c/" + ch.id + "/writers", { token: ch.ownerToken })).json<any>();
    expect(after.writers[0].used).toBeTypeOf("number");
  });

  it("sync: a stale If-Match after another device's write gets 409 with the current version and keeps the state", async () => {
    const ch = await create("sync");
    const a = await mint(ch.id, ch.ownerToken), b = await mint(ch.id, ch.ownerToken);
    expect((await put("/c/" + ch.id + "/state", { data: "AAA" }, { token: a.token, headers: { "If-Match": "0" } })).status).toBe(200);
    const late = await put("/c/" + ch.id + "/state", { data: "BBB" }, { token: b.token, headers: { "If-Match": "0" } });
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ version: 1 });
    expect(await (await call("/c/" + ch.id, { token: b.token })).json()).toEqual({ kind: "sync", version: 1, data: "AAA" });
    expect((await put("/c/" + ch.id + "/state", { data: "BBB" }, { token: b.token, headers: { "If-Match": '"1"' } })).status).toBe(200);
  });

  it("a writer revoked during a slow upload doesn't get its write in", async () => {
    const sy = await create("sync"), sw = await mint(sy.id, sy.ownerToken);
    const inb = await create("inbox"), iw = await mint(inb.id, inb.ownerToken);
    const put = slow("PUT", "/c/" + sy.id + "/state", sw.token, { data: "EVIL" });
    const msg = slow("POST", "/c/" + inb.id + "/messages", iw.token, { data: "EVIL" });
    await settle();
    expect((await call("/c/" + sy.id + "/writers/" + sw.wid, { method: "DELETE", token: sy.ownerToken })).status).toBe(204);
    expect((await call("/c/" + inb.id + "/writers/" + iw.wid, { method: "DELETE", token: inb.ownerToken })).status).toBe(204);
    put.finish(); msg.finish();
    expect((await put.res).status).toBe(401);
    expect((await msg.res).status).toBe(401);
    expect(await (await call("/c/" + sy.id, { token: sy.ownerToken })).json()).toEqual({ kind: "sync", version: 0, data: null });
    expect((await (await call("/c/" + inb.id, { token: inb.ownerToken })).json<any>()).messages).toHaveLength(0);
  });

  it("a channel deleted during a slow upload stays deleted", async () => {
    const sy = await create("sync");
    const inb = await create("inbox"), iw = await mint(inb.id, inb.ownerToken);
    const put = slow("PUT", "/c/" + sy.id + "/state", sy.ownerToken, { data: "LATE" });
    const msg = slow("POST", "/c/" + inb.id + "/messages", iw.token, { data: "LATE" });
    await settle();
    expect((await call("/c/" + sy.id, { method: "DELETE", token: sy.ownerToken })).status).toBe(204);
    expect((await call("/c/" + inb.id, { method: "DELETE", token: inb.ownerToken })).status).toBe(204);
    put.finish(); msg.finish();
    expect((await put.res).status).toBe(404);
    expect((await msg.res).status).toBe(404);
    for (const id of [sy.id, inb.id]) {
      await runInDurableObject(stubOf(id), async (_o, state) => {
        expect(tables(state.storage.sql)).toEqual([]);
        expect(await state.storage.getAlarm()).toBeNull();
      });
    }
  });

  it("revoking a sync writer closes its sockets", async () => {
    const ch = await create("sync");
    const w = await mint(ch.id, ch.ownerToken);
    const s = await socket(ch.id, w.token);
    expect(s.res.status).toBe(101);
    await call("/c/" + ch.id + "/writers/" + w.wid, { method: "DELETE", token: ch.ownerToken });
    expect(await until(() => s.closed !== null)).toBe(true);
    expect(s.closed!.code).toBe(4001);
  });

  it("a request to an unknown id stores nothing", async () => {
    const untouched = "B".repeat(22), probed = "C".repeat(22);
    const empty = await runInDurableObject(stubOf(untouched), async (_o, state) => state.storage.sql.databaseSize);
    expect((await call("/c/" + probed)).status).toBe(404);
    expect((await call("/c/" + probed, { token: "x".repeat(43) })).status).toBe(404);
    expect((await put("/c/" + probed + "/state", { data: data() }, { token: "x" })).status).toBe(404);
    await runInDurableObject(stubOf(probed), async (_o, state) => {
      expect(tables(state.storage.sql)).toEqual([]);
      expect(state.storage.sql.databaseSize).toBe(empty);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("unknown ids and malformed requests", async () => {
    expect((await call("/c/AAAAAAAAAAAAAAAAAAAAAA", { token: "x" })).status).toBe(404);
    expect((await call("/c/short")).status).toBe(404);
    expect((await post("/c", { kind: "nope" })).status).toBe(400);
    expect((await call("/c", { method: "POST", body: "not json" })).status).toBe(400);
    const ch = await create("inbox");
    expect((await call("/c/" + ch.id + "/init", { method: "POST", body: '{"kind":"inbox"}' })).status).toBe(404);
    const w = await mint(ch.id, ch.ownerToken);
    expect((await post("/c/" + ch.id + "/messages", { data: "<script>" }, { token: w.token })).status).toBe(400);
    expect((await post("/c/" + ch.id + "/messages", { data: 5 }, { token: w.token })).status).toBe(400);
  });
});

describe("limits", () => {
  it("rejects oversized messages and state with 413", async () => {
    const ch = await create("inbox");
    const w = await mint(ch.id, ch.ownerToken);
    expect((await post("/c/" + ch.id + "/messages", { data: data(LIMITS.message) }, { token: w.token })).status).toBe(201);
    expect((await post("/c/" + ch.id + "/messages", { data: data(LIMITS.message + 1) }, { token: w.token })).status).toBe(413);
    expect((await post("/c/" + ch.id + "/messages", { data: data(LIMITS.message * 4) }, { token: w.token })).status).toBe(413);
    const sh = await create("share");
    expect((await put("/c/" + sh.id + "/state", { data: data(LIMITS.state) }, { token: sh.ownerToken })).status).toBe(200);
    expect((await put("/c/" + sh.id + "/state", { data: data(LIMITS.state + 1) }, { token: sh.ownerToken })).status).toBe(413);
  });

  it("rejects writes that come too fast with 429", async () => {
    const ch = await create("inbox");
    const w = await mint(ch.id, ch.ownerToken); // pairing is a write too, so it uses one of the burst
    const codes: number[] = [];
    for (let i = 0; i < LIMITS.burst + 3; i++) codes.push((await post("/c/" + ch.id + "/messages", { data: data() }, { token: w.token })).status);
    expect(codes.slice(0, LIMITS.burst - 1).every(c => c === 201)).toBe(true);
    expect(codes).toContain(429);
  });

  it("rate-limits pairing like other writes", async () => {
    const ch = await create("sync");
    const codes: number[] = [];
    for (let i = 0; i < LIMITS.burst + 3; i++) codes.push((await call("/c/" + ch.id + "/writers", { method: "POST", token: ch.ownerToken })).status);
    expect(codes.slice(0, LIMITS.burst).every(c => c === 201)).toBe(true);
    expect(codes).toContain(429);
  });

  it("limits channel creation per IP address", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await post("/c", { kind: "inbox" }, { ip: "192.0.2.1" })).status);
    expect(codes.slice(0, 10).every(c => c === 201)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });
});

describe("CORS", () => {
  it("allows the site and localhost, and answers preflights", async () => {
    for (const origin of [SITE, "todos-app://app", "http://localhost:8080", "http://127.0.0.1:5500"]) {
      const res = await post("/c", { kind: "inbox" }, { origin });
      expect(res.status).toBe(201);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    }
    const pre = await call("/c/AAAAAAAAAAAAAAAAAAAAAA/messages", {
      method: "OPTIONS", origin: SITE,
      headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, content-type" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe(SITE);
    expect(pre.headers.get("Access-Control-Allow-Headers")).toMatch(/Authorization/);
  });

  it("refuses other origins", async () => {
    for (const origin of ["https://evil.example", "https://todos.always17.com.evil.example", "http://localhost.evil.example", "todos-app://evil", "null"]) {
      const res = await post("/c", { kind: "inbox" }, { origin });
      expect(res.status).toBe(403);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
    expect((await call("/c", { method: "OPTIONS", origin: "https://evil.example" })).status).toBe(403);
  });
});

describe("WebSocket", () => {
  it("catches up on connect and pushes new inbox messages", async () => {
    const ch = await create("inbox");
    const w = await mint(ch.id, ch.ownerToken);
    await post("/c/" + ch.id + "/messages", { data: "FIRST" }, { token: w.token });
    const s = await socket(ch.id, ch.ownerToken);
    expect(s.res.status).toBe(101);
    expect(s.res.headers.get("Sec-WebSocket-Protocol")).toBe("todos");
    expect(await until(() => s.got.length === 1)).toBe(true);
    expect(s.got[0]).toMatchObject({ type: "message", data: "FIRST", wid: w.wid });
    await post("/c/" + ch.id + "/messages", { data: "SECOND" }, { token: w.token });
    expect(await until(() => s.got.length === 2)).toBe(true);
    expect(s.got[1]).toMatchObject({ type: "message", data: "SECOND" });
    expect(s.got[1].id).toBeTypeOf("string");
  });

  it("tells the owner's sockets when a message is removed", async () => {
    const ch = await create("inbox");
    const w = await mint(ch.id, ch.ownerToken);
    const s = await socket(ch.id, ch.ownerToken);
    const { id: mid } = await (await post("/c/" + ch.id + "/messages", { data: data() }, { token: w.token })).json<{ id: string }>();
    expect(await until(() => s.got.length === 1)).toBe(true);
    expect((await call("/c/" + ch.id + "/messages/" + mid, { method: "DELETE", token: ch.ownerToken })).status).toBe(204);
    expect(await until(() => s.got.length === 2)).toBe(true);
    expect(s.got[1]).toEqual({ type: "removed", id: mid });
    expect((await call("/c/" + ch.id + "/messages/" + mid, { method: "DELETE", token: ch.ownerToken })).status).toBe(204);
    await settle();
    expect(s.got).toHaveLength(2); // nothing to remove the second time, so nothing sent
  });

  it("pushes share state to anonymous viewers, and tells them when the channel is deleted", async () => {
    const ch = await create("share");
    const s = await socket(ch.id);
    expect(await until(() => s.got.length === 1)).toBe(true);
    expect(s.got[0]).toEqual({ type: "state", version: 0, data: null });
    await put("/c/" + ch.id + "/state", { data: "STATE" }, { token: ch.ownerToken });
    expect(await until(() => s.got.length === 2)).toBe(true);
    expect(s.got[1]).toEqual({ type: "state", version: 1, data: "STATE" });
    expect((await call("/c/" + ch.id, { method: "DELETE", token: ch.ownerToken })).status).toBe(204);
    expect(await until(() => s.got.length === 3)).toBe(true);
    expect(s.got[2]).toEqual({ type: "deleted" });
    expect((await call("/c/" + ch.id)).status).toBe(404);
    expect((await put("/c/" + ch.id + "/state", { data: "AGAIN" }, { token: ch.ownerToken })).status).toBe(404);
    await runInDurableObject(stubOf(ch.id), async (_o, state) => { expect(tables(state.storage.sql)).toEqual([]); });
  });
});

describe("expiry", () => {
  it("deletes a channel unused for 90 days, and keeps one in use", async () => {
    const used = await create("inbox");
    const idle = await create("inbox");
    await runInDurableObject(stubOf(idle.id), async (_o, state) => {
      state.storage.sql.exec("UPDATE meta SET v = ? WHERE k = 'touched'", Date.now() - LIMITS.ttl - 1000);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    expect(await runDurableObjectAlarm(stubOf(idle.id))).toBe(true);
    expect((await call("/c/" + idle.id, { token: idle.ownerToken })).status).toBe(404);

    expect(await runDurableObjectAlarm(stubOf(used.id))).toBe(true);
    expect((await call("/c/" + used.id, { token: used.ownerToken })).status).toBe(200);
    await runInDurableObject(stubOf(used.id), async (_o, state) => {
      expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now() + LIMITS.ttl - 864e5);
    });
  });
});
