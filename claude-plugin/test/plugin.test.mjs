// node --test claude-plugin/test
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as L from "../scripts/lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(here, "../scripts/todos-hook.mjs");
const CONNECT = path.join(here, "../scripts/connect.mjs");
const DISCONNECT = path.join(here, "../scripts/disconnect.mjs");

// Shared with tests/smoke.html: key = bytes 0..31, IV = bytes 100..111.
const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const MESSAGE = { event: "suggest", title: "Fix the flaky login test", sessionId: "abc-123", project: "todos", kind: "local", at: 1793000000000 };
// Encrypted by lib.mjs (Node's zlib + WebCrypto). public/relay.js in Chrome (CompressionStream + WebCrypto)
// produced the same string; tests/smoke.html decrypts it in the browser.
const VECTOR = "ZGVmZ2hpamtsbW5vfdefbLvZRtjfyduXx8Tf9nPFLnIH9H0DffCPhtMp3b_GLfc-NA1Ll2fQuSFI0PPthwaQ7gP1w3fTrYj5AKH_Mw1zyi3lnU2fG_8iJsZlNqK4liVnfqMjVcXTIKpgAmMInuCP11RRP5BsjduE_hBwjrwdIFbShIQtXF2F";

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "todos-plugin-")); }

// Runs a script like Claude Code would, and returns its exit code, output and how long it took.
function run(script, args, { stdin = "", env = {}, cwd } = {}) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [script, ...args], {
      cwd,
      env: { ...process.env, TODOS_CONNECTION: "", CLAUDE_CODE_REMOTE: "", CLAUDE_PROJECT_DIR: "", CLAUDE_CODE_ENTRYPOINT: "cli", TODOS_SDK: "", ...env },
    });
    let out = "", err = "";
    p.stdout.on("data", d => { out += d; });
    p.stderr.on("data", d => { err += d; });
    p.on("close", code => resolve({ code, out, err, ms: Date.now() - t0 }));
    p.stdin.on("error", () => {});
    p.stdin.end(stdin);
  });
}

// A stand-in relay that decrypts what it receives.
async function fakeRelay(status = 201, headers = {}) {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", d => { body += d; });
    req.on("end", () => {
      got.push({ url: req.url, auth: req.headers.authorization, body });
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end('{"id":"m1"}');
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { url: "http://127.0.0.1:" + server.address().port, got, close: () => server.close() };
}
const TOKEN = L.toB64u(new Uint8Array(32).fill(7));
const conn = relay => ({ relay, channelId: "AAAAAAAAAAAAAAAAAAAAAA", key: KEY, writerToken: TOKEN });
const events = async relay => Promise.all(relay.got.map(g => L.decrypt(KEY, JSON.parse(g.body).data)));

test("title: first meaningful line, without Markdown or code, at most 80 characters", () => {
  assert.equal(L.titleFrom("## Fix **the** [login](https://example.com) bug\nand more"), "Fix the login bug");
  assert.equal(L.titleFrom("```js\nconst a = 1\n```\n\n- [ ] refactor `auth.ts`, please"), "refactor auth.ts, please");
  assert.equal(L.titleFrom("\n   \n> *Why* is   the build\tslow?"), "Why is the build slow?");
  assert.equal(L.titleFrom("    indented code\n1. Write the README"), "Write the README");
  assert.equal(L.titleFrom("<task>Rename the config</task>"), "Rename the config");
  const long = L.titleFrom("Please look into why the export button sometimes downloads an empty file when the list is very long");
  assert.ok(long.length <= 80, long);
  assert.ok(long.endsWith("…"));
  assert.equal(L.titleFrom("```\nonly code\n```"), null);
  assert.equal(L.titleFrom("  \n---\n"), null);
  assert.equal(L.titleFrom(42), null);
});

test("title: anything that looks like a secret is never sent", () => {
  // Assembled at runtime so secret scanners don't flag this file. None of these are real.
  const secrets = [
    "push with ghp_" + "a1B2c3D4e5".repeat(3) + "f6G7h8 please",
    "connect to " + ["postgres://admin", "s3cret@db.example.com/app"].join(":"),
    "set DATABASE_PASSWORD=hunter22 and deploy",
    "my key is 9fA8sd7f6g5h4j3k2l1qwe8r can you check it",
    "use the key sk-ant-api03-" + "x".repeat(60) + " for the tests in the staging environment please and thanks",
  ];
  for (const s of secrets) assert.equal(L.titleFrom(s), null, s);
});

test("title: Markdown stripping can't break up a secret, and snake_case survives", () => {
  // Stripping _…_ inside words used to turn MY_API_KEY=… into MYAPIKEY=…, which the filter let through.
  for (const s of ["set MY_API_KEY=abc123xyz and run", "use my_db_password=hunter22 here", "call with __token=abc123def__ please"]) {
    assert.equal(L.titleFrom(s), null, s);
  }
  assert.equal(L.titleFrom("rename my_var_name to user_id"), "rename my_var_name to user_id");
  assert.equal(L.titleFrom("_Why_ is the __build__ slow?"), "Why is the build slow?");
});

test("the secret filter is the website's, byte for byte", () => {
  const site = fs.readFileSync(path.join(here, "../../public/clipboard.js"), "utf8");
  const copy = fs.readFileSync(path.join(here, "../scripts/clipboard.cjs"), "utf8");
  assert.equal(copy, site, "claude-plugin/scripts/clipboard.cjs must be a copy of public/clipboard.js");
});

test("encryption: fixed test vectors round-trip with the browser format", async () => {
  assert.deepEqual(await L.decrypt(KEY, VECTOR), MESSAGE);
  const iv = Uint8Array.from({ length: 12 }, (_, i) => i + 100);
  const data = await L.encrypt(KEY, MESSAGE, iv);
  assert.ok(data.startsWith(L.toB64u(iv)));
  assert.deepEqual(await L.decrypt(KEY, data), MESSAGE);
  const fresh = await L.encrypt(KEY, MESSAGE);
  assert.notEqual(fresh, await L.encrypt(KEY, MESSAGE), "every write uses a fresh IV");
  await assert.rejects(L.decrypt("A".repeat(43), VECTOR));
});

test("pairing code: encodes to about 150 characters and decodes back", () => {
  const c = conn("https://todos-relay.example.workers.dev");
  const code = L.encodeCode(c);
  assert.ok(code.length <= 170, String(code.length));
  assert.deepEqual(L.decodeCode(code), c);
  assert.deepEqual(L.decodeCode("  " + code + "\n"), c);
  for (const bad of ["", "nope", "A".repeat(150), L.encodeCode(conn("http://evil.example")), L.encodeCode(conn("https://x.example/path")), null]) {
    assert.equal(L.decodeCode(bad), null, String(bad));
  }
  assert.ok(L.decodeCode(L.encodeCode(conn("http://localhost:8787"))));
});

test("config: connect saves it privately, disconnect removes it", async () => {
  const dir = tmpDir(), relay = await fakeRelay();
  try {
    const env = { TODOS_CONFIG_DIR: dir };
    // Always exit 0 with an explanation: the `!` command shows a generic failure otherwise.
    for (const args of [["not-a-code"], [""], []]) {
      const bad = await run(CONNECT, args, { env });
      assert.equal(bad.code, 0, bad.err);
      assert.match(bad.out, /isn't a Todos pairing code/);
    }
    assert.equal(fs.existsSync(path.join(dir, "connection.json")), false);
    const blocker = path.join(dir, "not-a-folder");
    fs.writeFileSync(blocker, "");
    const unsaved = await run(CONNECT, [L.encodeCode(conn(relay.url))], { env: { TODOS_CONFIG_DIR: blocker } });
    assert.equal(unsaved.code, 0, unsaved.err);
    assert.match(unsaved.out, /Couldn't save the connection/);
    assert.equal(relay.got.length, 0);

    const ok = await run(CONNECT, [L.encodeCode(conn(relay.url))], { env });
    assert.equal(ok.code, 0, ok.err);
    assert.ok(ok.out.startsWith("Connected to your Todos board via " + new URL(relay.url).host + "."), ok.out);
    const file = path.join(dir, "connection.json");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), conn(relay.url));
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const hello = await L.decrypt(KEY, JSON.parse(relay.got[0].body).data);
    assert.equal(hello.event, "hello");

    const off = await run(DISCONNECT, [], { env });
    assert.match(off.out, /Disconnected/);
    assert.equal(fs.existsSync(file), false);
  } finally { relay.close(); }
});

test("hook: sends the expected encrypted events for a session", async () => {
  const dir = tmpDir(), relay = await fakeRelay();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "my-repo-"));
  fs.mkdirSync(path.join(project, ".git"));
  fs.mkdirSync(path.join(project, "src"));
  try {
    const env = { TODOS_CONFIG_DIR: dir, TODOS_CONNECTION: L.encodeCode(conn(relay.url)) };
    const base = { session_id: "sess-1", cwd: path.join(project, "src") };
    const steps = [
      ["start", { ...base, source: "startup" }],
      ["prompt", { ...base, prompt: "# Fix the flaky login test\n\nIt fails on CI." }],
      ["prompt", { ...base, prompt: "and add a test" }],
      ["notification", { ...base, notification_type: "permission_prompt", message: "Claude needs your permission" }],
      ["notification", { ...base, notification_type: "auth_success" }],
      ["notification", { ...base, notification_type: "idle_prompt" }],
      ["stop", { ...base, stop_hook_active: false }],
      ["end", { ...base, reason: "prompt_input_exit" }],
    ];
    for (const [ev, input] of steps) {
      const r = await run(HOOK, [ev], { stdin: JSON.stringify(input), env });
      assert.deepEqual([r.code, r.out, r.err], [0, "", ""], ev);
    }
    const msgs = await events(relay);
    assert.deepEqual(msgs.map(m => m.event), ["start", "suggest", "running", "needs_you", "your_turn", "ended"]);
    assert.equal(msgs[1].title, "Fix the flaky login test");
    for (const m of msgs) {
      assert.equal(m.sessionId, "sess-1");
      assert.equal(m.project, path.basename(project)); // the repo's name, never the full path
      assert.equal(m.kind, "local");
      assert.ok(Math.abs(Date.now() - m.at) < 60000);
    }
    assert.equal(relay.got[0].url, "/c/AAAAAAAAAAAAAAAAAAAAAA/messages");
    assert.equal(relay.got[0].auth, "Bearer " + TOKEN);
    assert.equal(fs.existsSync(path.join(dir, "sessions", "sess-1")), true, "the marker outlives the session, for --resume");

    // Cloud sessions say so; a secret-looking first prompt gets no title.
    relay.got.length = 0;
    await run(HOOK, ["prompt"], {
      stdin: JSON.stringify({ session_id: "sess-2", cwd: project, prompt: "deploy with token=" + "9f8e7d6c5b4a3f2e1d0c" }),
      env: { ...env, CLAUDE_CODE_REMOTE: "true" },
    });
    const cloud = await L.decrypt(KEY, JSON.parse(relay.got[0].body).data);
    assert.deepEqual([cloud.event, cloud.title, cloud.kind], ["suggest", null, "cloud"]);

    // Connecting is never a task (the prompt holds the pairing code).
    relay.got.length = 0;
    await run(HOOK, ["prompt"], { stdin: JSON.stringify({ session_id: "sess-3", cwd: project, prompt: "/todos:connect abc" }), env });
    assert.equal(relay.got.length, 0);
  } finally { relay.close(); }
});

test("hook: opt-outs and missing config send nothing", async () => {
  const dir = tmpDir(), relay = await fakeRelay();
  const project = tmpDir();
  try {
    const input = JSON.stringify({ session_id: "s", cwd: project, prompt: "hello there" });
    const env = { TODOS_CONFIG_DIR: dir, TODOS_CONNECTION: L.encodeCode(conn(relay.url)) };
    await run(HOOK, ["prompt"], { stdin: input, env: { ...env, TODOS_DISABLE: "1" } });
    fs.writeFileSync(path.join(project, ".todos-ignore"), "");
    await run(HOOK, ["prompt"], { stdin: input, env });
    fs.unlinkSync(path.join(project, ".todos-ignore"));
    await run(HOOK, ["prompt"], { stdin: input, env: { TODOS_CONFIG_DIR: dir } }); // not connected
    assert.equal(relay.got.length, 0);
  } finally { relay.close(); }
});

test("hook: never throws, never prints, always exits 0 quickly", async () => {
  const dir = tmpDir();
  const unreachable = { TODOS_CONFIG_DIR: dir, TODOS_CONNECTION: L.encodeCode(conn("http://127.0.0.1:9")) };
  const garbage = ["", "not json", "null", "[]", "42", '{"session_id":{"$ne":1}}', '{"session_id":"../../etc/passwd"}',
    '{"session_id":"x","cwd":7,"prompt":["a"]}', "\u0000￿".repeat(1000), "{".repeat(100000)];
  const events = ["start", "prompt", "notification", "stop", "end", "bogus", ""];
  for (const ev of events) {
    for (const stdin of garbage) {
      const r = await run(HOOK, ev ? [ev] : [], { stdin, env: unreachable });
      assert.deepEqual([r.code, r.out, r.err], [0, "", ""], ev + " " + JSON.stringify(stdin.slice(0, 40)));
    }
  }
  // A relay that never answers: the hook gives up on its own.
  const hang = http.createServer(() => {});
  await new Promise(r => hang.listen(0, "127.0.0.1", r));
  try {
    const env = { TODOS_CONFIG_DIR: dir, TODOS_CONNECTION: L.encodeCode(conn("http://127.0.0.1:" + hang.address().port)) };
    const r = await run(HOOK, ["stop"], { stdin: JSON.stringify({ session_id: "s", cwd: dir }), env });
    assert.deepEqual([r.code, r.out, r.err], [0, "", ""]);
    assert.ok(r.ms < 4500, r.ms + " ms");
  } finally { hang.closeAllConnections?.(); hang.close(); }
});

test("hook: the project is where the session started, and an ignored session stays ignored after a cd", async () => {
  const dir = tmpDir(), relay = await fakeRelay();
  const secret = fs.mkdtempSync(path.join(os.tmpdir(), "client-repo-"));
  fs.mkdirSync(path.join(secret, ".git"));
  fs.writeFileSync(path.join(secret, ".todos-ignore"), "");
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "elsewhere-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-repo-"));
  fs.mkdirSync(path.join(home, ".git"));
  try {
    const env = { TODOS_CONFIG_DIR: dir, TODOS_CONNECTION: L.encodeCode(conn(relay.url)) };
    // Started in an ignored project, then Claude cd'd out of it: still nothing.
    await run(HOOK, ["start"], { stdin: JSON.stringify({ session_id: "ign", cwd: secret, source: "startup" }), env });
    for (const ev of ["prompt", "stop", "prompt"]) {
      await run(HOOK, [ev], { stdin: JSON.stringify({ session_id: "ign", cwd: elsewhere, prompt: "draft the letter" }), env });
    }
    // Even when CLAUDE_PROJECT_DIR isn't set and only the first event saw the ignored folder.
    await run(HOOK, ["prompt"], { stdin: JSON.stringify({ session_id: "ign2", cwd: secret, prompt: "x y" }), env });
    await run(HOOK, ["prompt"], { stdin: JSON.stringify({ session_id: "ign2", cwd: elsewhere, prompt: "x y" }), env });
    // CLAUDE_PROJECT_DIR wins over cwd for the ignore check...
    await run(HOOK, ["prompt"], { stdin: JSON.stringify({ session_id: "ign3", cwd: elsewhere, prompt: "x y" }), env: { ...env, CLAUDE_PROJECT_DIR: secret } });
    assert.equal(relay.got.length, 0);
    // ...and for the project name.
    await run(HOOK, ["prompt"], { stdin: JSON.stringify({ session_id: "ok", cwd: elsewhere, prompt: "Fix it" }), env: { ...env, CLAUDE_PROJECT_DIR: home } });
    const [m] = await events(relay);
    assert.deepEqual([m.event, m.project], ["suggest", path.basename(home)]);
  } finally { relay.close(); }
});

test("hook: only notifications that need you become needs_you", async () => {
  const dir = tmpDir(), relay = await fakeRelay();
  try {
    const env = { TODOS_CONFIG_DIR: dir, TODOS_CONNECTION: L.encodeCode(conn(relay.url)) };
    const types = ["permission_prompt", "idle_prompt", "auth_success", "elicitation_dialog", "elicitation_url_dialog",
      "elicitation_complete", "elicitation_response", "agent_needs_input", "agent_completed", "plugin_notification", "quota_auto_resume_fired", undefined];
    for (const notification_type of types) {
      await run(HOOK, ["notification"], { stdin: JSON.stringify({ session_id: "n", cwd: dir, notification_type, message: "hi" }), env });
    }
    assert.equal((await events(relay)).filter(m => m.event === "needs_you").length, 4);
    assert.equal(relay.got.length, 4);
  } finally { relay.close(); }
});

test("hook: compaction sends nothing, and a resumed session isn't suggested again", async () => {
  const dir = tmpDir(), relay = await fakeRelay();
  try {
    const env = { TODOS_CONFIG_DIR: dir, TODOS_CONNECTION: L.encodeCode(conn(relay.url)) };
    const go = (ev, extra) => run(HOOK, [ev], { stdin: JSON.stringify({ session_id: "r", cwd: dir, ...extra }), env });
    await go("start", { source: "startup" });
    await go("prompt", { prompt: "Fix login" });
    await go("start", { source: "compact" });
    await go("end", { reason: "prompt_input_exit" });
    await go("start", { source: "resume" });
    await go("prompt", { prompt: "keep going" });
    assert.deepEqual((await events(relay)).map(m => m.event), ["start", "suggest", "ended", "start", "running"]);

    // A session resumed after its marker was swept (or from before connecting) isn't suggested either.
    relay.got.length = 0;
    const old = (ev, extra) => run(HOOK, [ev], { stdin: JSON.stringify({ session_id: "old", cwd: dir, ...extra }), env });
    await old("start", { source: "resume" });
    await old("prompt", { prompt: "pick this up" });
    assert.deepEqual((await events(relay)).map(m => m.event), ["start", "running"]);

    // After /clear the old id is finished, so its marker goes.
    await go("end", { reason: "clear" });
    assert.equal(fs.existsSync(path.join(dir, "sessions", "r")), false);
  } finally { relay.close(); }
});

test("hook: claude -p and Agent SDK runs send nothing", async () => {
  const dir = tmpDir(), relay = await fakeRelay();
  try {
    const env = { TODOS_CONFIG_DIR: dir, TODOS_CONNECTION: L.encodeCode(conn(relay.url)) };
    const stdin = JSON.stringify({ session_id: "p", cwd: dir, prompt: "summarise the logs" });
    for (const ep of ["sdk-cli", "sdk-ts", "sdk-py"]) {
      const r = await run(HOOK, ["prompt"], { stdin, env: { ...env, CLAUDE_CODE_ENTRYPOINT: ep } });
      assert.deepEqual([r.code, r.out, r.err], [0, "", ""]);
    }
    assert.equal(relay.got.length, 0);
    await run(HOOK, ["prompt"], { stdin, env: { ...env, CLAUDE_CODE_ENTRYPOINT: "sdk-ts", TODOS_SDK: "1" } });
    await run(HOOK, ["stop"], { stdin, env: { ...env, CLAUDE_CODE_ENTRYPOINT: "claude-desktop" } });
    assert.deepEqual((await events(relay)).map(m => m.event), ["suggest", "your_turn"]);
  } finally { relay.close(); }
});

test("hook: never follows a redirect with the writer token", async () => {
  const dir = tmpDir(), thief = await fakeRelay();
  const relay = await fakeRelay(307, { Location: thief.url + "/steal" });
  try {
    const env = { TODOS_CONFIG_DIR: dir, TODOS_CONNECTION: L.encodeCode(conn(relay.url)) };
    const r = await run(HOOK, ["stop"], { stdin: JSON.stringify({ session_id: "s", cwd: dir }), env });
    assert.deepEqual([r.code, r.out, r.err], [0, "", ""]);
    assert.equal(relay.got.length, 1);
    assert.equal(thief.got.length, 0);
    await assert.rejects(L.send(conn(relay.url), { event: "x" }));
    assert.equal(thief.got.length, 0);
  } finally { relay.close(); thief.close(); }
});

test("hook: stops reading oversized input and quits promptly", async () => {
  const dir = tmpDir(), relay = await fakeRelay();
  try {
    const env = { TODOS_CONFIG_DIR: dir, TODOS_CONNECTION: L.encodeCode(conn(relay.url)) };
    const r = await run(HOOK, ["prompt"], { stdin: "x".repeat(20 << 20), env });
    assert.deepEqual([r.code, r.out, r.err], [0, "", ""]);
    assert.ok(r.ms < 1500, r.ms + " ms"); // gave up at the 1 MB cap, not at the 1.5 s read timeout
    assert.equal(relay.got.length, 0);
  } finally { relay.close(); }
});
