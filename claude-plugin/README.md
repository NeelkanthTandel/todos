# Todos for Claude Code

A Claude Code plugin that puts each new session on your [Todos](https://todos.always17.com) board as a suggestion. One key adds it to a lane, and the todo then shows the session's live status: running, needs you, your turn, or ended.

Everything is end-to-end encrypted: the relay in between only ever sees ciphertext.

## Install

Needs Node 18 or later on the machine running Claude Code.

```
/plugin marketplace add NeelkanthTandel/todos
/plugin install todos@todos
```

(On Claude Code 2.1.275 or later, `/plugin install todos --marketplace NeelkanthTandel/todos` does both.)

## Connect

1. On your board, click **Connect Claude Code** in the footer.
2. Copy the command it shows and run it in Claude Code on that machine: `/todos:connect <code>`.

The connection is saved in `~/.config/todos/connection.json` (readable only by you). Each machine gets its own code, and the board lists connected machines with a **Disconnect** button. `/todos:disconnect` forgets the connection on this machine.

The code contains your board's encryption key and this machine's writer token. It's typed as a command argument, so it becomes part of that conversation: it goes to the model provider along with the rest of the conversation, and it stays in the local transcript. Treat that conversation like the config file, and disconnect the machine from the board if a code leaks.

**Only use codes from your own board.** A code decides where your session titles and project names go: a code someone else gives you would send them to their relay and their board.

**Cloud sessions** start from a fresh container, so a saved connection doesn't carry over. Set the environment variable `TODOS_CONNECTION=<code>` in your cloud environment's settings instead.

## What gets sent

One small encrypted message per hook event, to your board's inbox:

| Hook | Message |
| --- | --- |
| `SessionStart` | `start` (nothing after compaction) |
| First `UserPromptSubmit` | `suggest`, with a title |
| Later `UserPromptSubmit` | `running` (also the first one after `--resume`) |
| `Notification` | `needs_you`, only when Claude is waiting on you: `permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog`, `agent_needs_input` |
| `Stop` | `your_turn` |
| `StopFailure` | `your_turn`, when the turn ended on an API error (rate limit, authentication, overload) |
| `SessionEnd` | `ended` |

Each also carries the session id, the project name (the git repo's folder name for the folder the session started in, never the full path; for a git worktree, such as Claude Desktop's `.claude/worktrees/…`, the main repo's name), whether it's a cloud or local session, and the time.

A small marker file per session in `~/.config/todos/sessions/` remembers which sessions were already suggested, so a resumed session isn't suggested twice. Markers older than a week are removed. If that folder isn't writable, sessions are still suggested, just possibly more than once.

The **title** is the first meaningful line of your first prompt, with Markdown and code removed, cut to 80 characters. It goes through the same secret filter the website uses for clipboard suggestions (`scripts/clipboard.cjs` is a copy of `public/clipboard.js`); if anything looks like a key, token, password or card number, no title is sent and the board shows "Untitled session in <project>". Control and bidirectional-formatting characters are removed from titles and project names. Nothing else from your prompts, code or files is sent. Prompts starting with `/todos:` are never sent.

## Opting out

- A `.todos-ignore` file in a project's root: nothing is sent for sessions there, including sessions in that repo's git worktrees. A session that starts in an ignored project stays ignored if Claude later moves to another folder, and so does one that moves into an ignored project.
- `claude -p` and Agent SDK runs are skipped: scripted runs aren't sessions you'd pick up. They're detected by `CLAUDE_CODE_ENTRYPOINT` starting with `sdk-`. Claude Code sets that variable but doesn't document it, so if an app built on the Agent SDK should show up, set `TODOS_SDK=1` there. A `claude -p` started from inside an interactive session (for example by Claude, or from Claude Desktop's terminal) inherits that session's entrypoint and isn't skipped; set `TODOS_DISABLE=1` for it if that matters.
- `TODOS_DISABLE=1` in the environment: nothing is sent at all.
- Not connected: the hooks do nothing.

## It never gets in the way

Every hook runs in the background (`"async": true`), so Claude Code doesn't wait for it. The script gives up on the network after 2.5 seconds (1.2 seconds when the session ends), quits after 4 seconds no matter what, catches every error, always exits 0, and never prints anything.

## Files

| File | What it does |
| --- | --- |
| `.claude-plugin/plugin.json` | Plugin manifest |
| `hooks/hooks.json` | The six hooks, all running `scripts/todos-hook.mjs <event>` |
| `commands/connect.md`, `commands/disconnect.md` | `/todos:connect` and `/todos:disconnect` |
| `scripts/todos-hook.mjs` | The hook |
| `scripts/connect.mjs`, `scripts/disconnect.mjs` | Save or remove the connection |
| `scripts/lib.mjs` | Encryption, pairing codes, config, titles |
| `test/plugin.test.mjs` | `node --test claude-plugin/test/plugin.test.mjs` |

To try changes locally: `claude --plugin-dir ./claude-plugin`, with the [relay](../relay/README.md) running under `wrangler dev`.
