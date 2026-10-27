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
// Notifications that mean Claude is waiting on you. idle_prompt, auth_success, agent_completed and the rest don't.
const NEEDS_YOU = new Set(["permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]);
const SESSION_RE = /^[\w-]{1,64}$/;
const STALE = 7 * 864e5;

function readStdin(max = 1 << 20, wait = 1500) {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve("");
    let buf = "", done = false;
    const finish = () => { if (!done) { done = true; resolve(buf); } };
    setTimeout(finish, wait).unref();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", d => {
      buf += d;
      if (buf.length > max) { buf = ""; process.stdin.destroy(); finish(); } // too big to be hook input
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

async function main() {
  const which = process.argv[2];
  if (!(which in EVENTS) || process.env.TODOS_DISABLE === "1") return;
  // claude -p and Agent SDK runs (entrypoint sdk-cli, sdk-ts, sdk-py) are scripts, not sessions you'd pick up.
  // The variable isn't in Claude Code's docs, so TODOS_SDK=1 turns this off if an SDK-based app needs it.
  if (/^sdk-/.test(process.env.CLAUDE_CODE_ENTRYPOINT || "") && process.env.TODOS_SDK !== "1") return;
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

  // The folder the session started in: input.cwd follows Claude's cd, CLAUDE_PROJECT_DIR stays put.
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : "";
  const base = process.env.CLAUDE_PROJECT_DIR || cwd || process.cwd();
  const root = projectRoot(base);

  // One small marker file per session id: it exists once the session has been suggested, and says "ignored"
  // for a session that started in an ignored project, so it stays ignored after a cd elsewhere.
  const dir = path.join(configDir(), "sessions");
  const marker = path.join(dir, sessionId);
  const mark = (content, flag) => {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(marker, content, { mode: 0o600, flag });
      return true;
    } catch { return false; }
  };
  let seen = null;
  try { seen = fs.readFileSync(marker, "utf8"); } catch {}
  if (seen === "ignored") return;
  const ignored = [root, base, ...(cwd ? [projectRoot(cwd), cwd] : [])]
    .some(d => fs.existsSync(path.join(d, ".todos-ignore")));
  if (ignored) { mark("ignored", "w"); return; }

  const msg = { event: EVENTS[which] };
  if (which === "prompt") {
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    if (/^\s*\/todos:/.test(prompt)) return; // connecting or disconnecting isn't a task (and holds the pairing code)
    if (mark("", "wx")) { msg.event = "suggest"; msg.title = titleFrom(prompt); }
    else {
      msg.event = "running";
      try { const t = new Date(); fs.utimesSync(marker, t, t); } catch {} // still active: keep it out of the sweep
    }
  } else if (which === "notification") {
    if (!NEEDS_YOU.has(input.notification_type)) return;
  } else if (which === "end") {
    // Keep the marker so a resumed session (same id) isn't suggested again; the weekly sweep at
    // SessionStart removes it later.
    // After /clear the conversation continues under a new id, so this one is done.
    if (input.reason === "clear") { try { fs.unlinkSync(marker); } catch {} }
  } else if (which === "start") {
    if (input.source === "compact") return; // same session, mid-task: "start" would wrongly say it's your turn
    // A resumed session was suggested before (or predates the connection): its next prompt is just "running".
    if (input.source === "resume") mark("", "wx");
    // Sweep markers older than a week (resumed sessions, crashes, killed terminals).
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
