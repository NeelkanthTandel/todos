---
description: Connect this machine to your Todos board
argument-hint: <pairing code from the board>
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/connect.mjs" '$ARGUMENTS'`

Tell the user the result above in one short sentence. Don't repeat the pairing code, and don't do anything else.
