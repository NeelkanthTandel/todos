#!/usr/bin/env node
// /todos:connect <pairing code>: saves the connection to ~/.config/todos/connection.json (mode 600) and
// sends a hello so the board can show this machine as connected. Prints one line for Claude to relay.
import os from "node:os";
import { connectionFile, decodeCode, saveConnection, send } from "./lib.mjs";

const code = (process.argv.slice(2).join(" ") || "").trim();
const conn = decodeCode(code);
if (!conn) {
  console.log("That isn't a Todos pairing code. On your board, click Connect Claude Code and copy the command it shows.");
  process.exit(1);
}
saveConnection(conn);
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
  console.log("Connected to your Todos board. New Claude Code sessions on this machine will show up there as suggestions. (Saved in " + connectionFile() + ")");
} else if (status === 401) {
  console.log("Saved, but the board rejected this code: it may have been disconnected. Create a new code on the board and run /todos:connect again.");
} else {
  console.log("Saved, but couldn't reach the relay (" + (status ? "HTTP " + status : "network error") + "). Sessions will show up once it's reachable.");
}
