#!/usr/bin/env node
// /todos:disconnect: forgets the connection. Nothing more is sent from this machine.
import { connectionFile, removeConnection } from "./lib.mjs";

if (removeConnection()) console.log("Disconnected. Removed " + connectionFile() + ". To stop the board accepting the old code too, click Disconnect next to this machine in the board's Connect Claude Code dialog.");
else console.log("This machine wasn't connected to a Todos board.");
