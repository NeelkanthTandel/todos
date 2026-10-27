#!/usr/bin/env node
// /todos:connect <pairing code>: saves the connection to ~/.config/todos/connection.json (mode 600) and
// sends a hello so the board can show this machine as connected. Prints one line for Claude to relay.
// Always exits 0: the command runs it with `!`, and a non-zero exit would hide this explanation behind a
// generic "command failed".
import os from "node:os";

async function main() {
  const { connectionFile, decodeCode, saveConnection, send } = await import("./lib.mjs");
  const code = (process.argv.slice(2).join(" ") || "").trim();
  const conn = decodeCode(code);
  if (!conn) {
    return "That isn't a Todos pairing code. On your board, click Connect Claude Code and copy the command it shows.";
  }
  try { saveConnection(conn); } catch (e) {
    return "Couldn't save the connection to " + connectionFile() + " (" + (e && e.code || "error") + "). Check that folder is writable, then run /todos:connect again.";
  }
  const host = new URL(conn.relay).host;
  let status = 0;
  try {
    status = await send(conn, {
      event: "hello",
      sessionId: "connect",
      project: "",
      kind: process.env.CLAUDE_CODE_REMOTE === "true" ? "cloud" : "local",
      machine: os.hostname().slice(0, 64),
      at: Date.now(),
    }, { timeout: 5000 });
  } catch {}
  if (status === 201) {
    return "Connected to your Todos board via " + host + ". New Claude Code sessions on this machine will show up there as suggestions. (Saved in " + connectionFile() + ")";
  }
  if (status === 401) {
    return "Saved, but the board's relay (" + host + ") rejected this code: it may have been disconnected. Create a new code on the board and run /todos:connect again.";
  }
  return "Saved, but couldn't reach the relay at " + host + " (" + (status ? "HTTP " + status : "network error") + "). Sessions will show up once it's reachable.";
}

let line;
try { line = await main(); } catch (e) {
  line = "Couldn't connect: " + (e && e.message || "unexpected error") + ".";
}
console.log(line);
process.exitCode = 0;
