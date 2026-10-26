#!/usr/bin/env node
// One script for every hook event: node todos-hook.mjs <start|prompt|notification|stop|end>
// Sends one encrypted message to your Todos inbox. It must never slow down or break a Claude Code session:
// it runs as an async hook, gives up after a few seconds, swallows every error, always exits 0 and never
// prints (some hook output is fed back to Claude).
const quiet = () => {};
for (const k of ["log", "info", "warn", "error", "debug", "trace"]) console[k] = quiet;
process.stdout.write = () => true;
process.stderr.write = () => true;
process.on("uncaughtException", () => process.exit(0));
process.on("unhandledRejection", () => process.exit(0));
setTimeout(() => process.exit(0), 4000).unref();

const EVENTS = { start: "start", prompt: null, notification: "needs_you", stop: "your_turn", end: "ended" };
const SESSION_RE = /^[\w-]{1,64}$/;
const STALE = 7 * 864e5;

function readStdin(max = 1 << 20, wait = 1500) {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve("");
    let buf = "", done = false;
    const finish = () => { if (!done) { done = true; resolve(buf); } };
    setTimeout(finish, wait).unref();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", d => { buf += d; if (buf.length > max) { buf = ""; finish(); } });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

async function main() {
  const which = process.argv[2];
  if (!(which in EVENTS) || process.env.TODOS_DISABLE === "1") return;
  const { loadConnection, projectRoot, projectName, titleFrom, send, configDir } = await import("./lib.mjs");
  const fs = await import("node:fs");
  const path = await import("node:path");

  const conn = loadConnection();
  if (!conn) return; // not connected: do nothing
  let input;
  try { input = JSON.parse(await readStdin()); } catch { return; }
  if (!input || typeof input !== "object") return;
  const sessionId = input.session_id;
  if (typeof sessionId !== "string" || !SESSION_RE.test(sessionId)) return;

  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = projectRoot(cwd);
  if (fs.existsSync(path.join(root, ".todos-ignore")) || fs.existsSync(path.join(cwd, ".todos-ignore"))) return;

  // "First prompt of this session" is a small marker file per session id, removed when the session ends.
  const dir = path.join(configDir(), "sessions");
  const marker = path.join(dir, sessionId);
  const msg = { event: EVENTS[which] };
  if (which === "prompt") {
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    if (/^\s*\/todos:/.test(prompt)) return; // connecting or disconnecting isn't a task (and holds the pairing code)
    let first = false;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.closeSync(fs.openSync(marker, "wx", 0o600));
      first = true;
    } catch {}
    if (first) { msg.event = "suggest"; msg.title = titleFrom(prompt); }
    else msg.event = "running";
  } else if (which === "notification") {
    if (input.notification_type === "auth_success") return;
  } else if (which === "end") {
    try { fs.unlinkSync(marker); } catch {}
  } else if (which === "start") {
    // Sweep markers left behind by sessions that never reached SessionEnd (crashes, killed terminals).
    try {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (Date.now() - fs.statSync(p).mtimeMs > STALE) fs.unlinkSync(p);
      }
    } catch {}
  }

  Object.assign(msg, {
    sessionId,
    project: projectName(root),
    kind: process.env.CLAUDE_CODE_REMOTE === "true" ? "cloud" : "local",
    at: Date.now(),
  });
  // SessionEnd hooks get little time before Claude Code exits, so don't wait around for a retry.
  await send(conn, msg, which === "end" ? { timeout: 1200, retries: 0 } : { timeout: 2500, retries: 1 });
}

main().catch(() => {}).finally(() => process.exit(0));
