# Milestone 1: Relay + Claude Code session suggestions

**Goal:** when you start a Claude Code session (CLI, desktop app or cloud), its task shows up on *your* Todos board as a suggestion, without being added. One key adds it to P1. Once added, the todo shows the session's live status: running, needs you, your turn, or ended.

Read [README.md](README.md) first for the shared relay design and the rules.

Build it as **three PRs, in order**:

1. **1a:** the relay (`relay/`)
2. **1b:** the Claude Code plugin (`claude-plugin/`)
3. **1c:** pairing and the Claude tray on the board (`public/`)

---

## 1a. Relay

**Scope:** the `Channel` Durable Object with the `inbox` kind fully working. Implement `share` and `sync` state handling too if it's cheap (one `state` blob plus a version). Milestones 2 and 3 then only add client code.

- **Layout:** `relay/src/index.ts` (router, CORS, auth), `relay/src/channel.ts` (Durable Object), `relay/wrangler.toml`, `relay/package.json`, `relay/test/*.test.ts`.
- **Durable Objects:** use SQLite-backed Durable Objects (available on the free plan) and the **WebSocket Hibernation API** (`state.acceptWebSocket`), so idle sockets cost nothing.
- **Tests:** Vitest with `@cloudflare/vitest-pool-workers`, covering:
  - create, write and read for each kind;
  - auth (wrong or missing token → `401`);
  - limits (oversized → `413`, too fast → `429`);
  - CORS for allowed and blocked origins;
  - WebSocket push;
  - expiry alarm;
  - revoking a writer.
- **CI:** add the relay tests as steps in the existing `check` job in `.github/workflows/ci.yml`, so `check` stays the single required status check (`cd relay && npm ci && npm test`). Pin the action and package versions.
- **Deploy:** add `.github/workflows/relay.yml` to deploy on push to `main` when `relay/**` changes, with `wrangler deploy` using the repo secrets.
- **Docs:** add a `relay/README.md` covering running it locally (`npx wrangler dev`), the API, and the limits.

**Done when:**
- Tests pass in CI.
- A manual curl walkthrough works against `wrangler dev`: create an inbox, mint a writer, post a message, read it over a WebSocket.
- **Repo owner:** add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to the repo secrets, then the deploy workflow publishes it. Put the deployed URL into `public/config.js` in 1c.

---

## 1b. Claude Code plugin

**Distribution:** this repo doubles as a plugin marketplace. Users run:

```
/plugin marketplace add NeelkanthTandel/todos
/plugin install todos@todos
```

Verify the exact manifest format and commands against the current Claude Code plugin docs before building; the structure below is the expected shape.

```
.claude-plugin/marketplace.json      # lists the plugin at ./claude-plugin
claude-plugin/
  .claude-plugin/plugin.json         # name "todos", version, description
  commands/connect.md                # /todos:connect <code>  -> runs scripts/connect.mjs
  commands/disconnect.md             # /todos:disconnect
  hooks/hooks.json                   # SessionStart, UserPromptSubmit, Notification, Stop, SessionEnd
  scripts/todos-hook.mjs             # one script for every hook event
  scripts/connect.mjs
  README.md
```

- **Hook commands:** use `${CLAUDE_PLUGIN_ROOT}/scripts/todos-hook.mjs <event>`. Node 18+ is required; say so in the README. **The hook must never slow down or break a session:**
  - run in the background or with a 2-second timeout;
  - catch everything;
  - always exit 0;
  - never print to stdout (some hook outputs are fed back to Claude).
- **Config:** `connect.mjs` decodes the pairing code into `{ relay, channelId, key, writerToken }` and writes it to `~/.config/todos/connection.json` with mode `600`. `disconnect` deletes the file. If there's no config, hooks do nothing.
- **Events sent** (each is one encrypted inbox message):

  | Hook | Message |
  | --- | --- |
  | `SessionStart` | `{ event: "start" }` |
  | `UserPromptSubmit` (first one in this session) | `{ event: "suggest", title }` |
  | `UserPromptSubmit` (later) | `{ event: "running" }` |
  | `Notification` | `{ event: "needs_you" }` |
  | `Stop` | `{ event: "your_turn" }` |
  | `SessionEnd` | `{ event: "ended" }` |

  Every message also carries `sessionId`, `project` (the git repo name, or the folder's basename; never the full path), `kind` (`"cloud"` when running in a Claude Code cloud session, else `"local"`) and `at` (epoch ms). Track "first prompt in this session" with a small state file per session id under `~/.config/todos/sessions/`, and clean these up on `SessionEnd`.
- **The title:**
  - take the first prompt's first meaningful line, strip Markdown and code fences, collapse whitespace, cut to 80 characters;
  - run it through the same secret filter the website uses (`public/clipboard.js`; make that file usable from Node, e.g. also assign `globalThis.TodoClipboard` and add a tiny ESM wrapper, without breaking the browser);
  - if the filter rejects it, send `title: null`, and the board shows "Untitled session in <project>".
- **Opt-out:** a `.todos-ignore` file in the project root, or `TODOS_DISABLE=1`, sends nothing.
- **Tests:** `node --test` covering:
  - title extraction and secret filtering;
  - encryption that round-trips with the browser format (fixed key and IV test vector);
  - config handling;
  - the "never throws, never prints" guarantee (feed it garbage on stdin).

  Run them in the `check` job.

**Done when:** in a real Claude Code session with the plugin installed and connected, the expected encrypted messages reach a `wrangler dev` relay, and the session is never delayed.

---

## 1c. Pairing and the Claude tray (website)

### Pairing UX

1. **Connect:** the footer gets a **Connect Claude Code** button (later this moves into a settings menu). Clicking it:
   - creates the board's inbox channel if there isn't one, and saves `{ relay, id, key, ownerToken }` in `localStorage` as `todos.inbox`;
   - mints a writer token;
   - shows a dialog with the command `/todos:connect <code>` and a **Copy** button. The code is base64url of `{ relay, channelId, key, writerToken }`, about 150 characters, so copying is fine.
2. **Manage connections:** the dialog lists connected machines, with a **Disconnect** button for each (revokes its writer token).
3. **When it works:** the board connects to the inbox over a WebSocket whenever it's open. It reconnects with backoff, and reconnects on focus or when the tab becomes visible.

### The tray

- **Placement and look:** a slim **Claude sessions** strip between the composer and the lanes. It only shows when there's at least one suggestion. Cards are styled clearly differently from todos (pen-colour outline and a small Claude-session icon), so a suggestion never looks like a real todo.
- **Each card shows:**
  - the title (or "Untitled session in <project>");
  - the project;
  - a status dot: 🔵 running · 🟠 needs you · 🟢 your turn · grey ended;
  - its age ("2 min").
- **Keys** (on a hovered or focused card, consistent with the board's existing shortcuts):
  - **Enter** or **1** adds it to P1 (Boiling over);
  - **2–4** adds it to that lane;
  - **E** edits the title, then Enter adds;
  - **Esc** or **Delete** dismisses it.
- **Global:** **A** adds the newest suggestion to P1 from anywhere on the board (when not typing).
- **Adding is a normal change:** it goes through `record()`, so **Ctrl/⌘+Z** undoes it.
- **Housekeeping:**
  - handled messages are deleted from the relay;
  - suggestions whose session has ended and weren't added disappear after 24 h;
  - several messages for the same `sessionId` collapse into one card that shows the latest status.

### Todos linked to a session

- **Data model:** a new optional field `session: { id, state, project, kind, updatedAt }`, where:
  - `state` is one of `"running" | "needs_you" | "your_turn" | "ended"`;
  - `id` matches `/^[\w-]{1,64}$/`;
  - `project` is a string of at most 120 characters.

  Add it to `normalize()` in `app.js` (an allowlist with type checks, like every other field), and to the `Todo` type in the comment at the top of `storage.js`.
- **Status badge:** linked todos show a small status badge, updated live from later inbox messages for that `sessionId`.
- **Resuming:** clicking the badge copies `claude --resume <id>` (local sessions). For cloud sessions it just shows "Cloud session".
- **Needs-you count:** the page title shows it, e.g. "(2) Todos", so you notice it from another tab.

### Website plumbing

- **New file `public/relay.js`:** a small client for create, mint writer, WebSocket subscribe with reconnect, delete message, and AES-GCM plus deflate helpers. No libraries.
- **Config and CSP:**
  - `public/config.js`: add `relayBase` (empty means the feature is hidden).
  - The CSP `<meta>` in `index.html`: add the relay's `https://` and `wss://` origins to `connect-src`.
- **Messages are untrusted input:** decrypt, then validate strictly (the same discipline as `normalize()`). Ignore unknown events and malformed or oversized fields. Render text only with `textContent`.

### Tests (`tests/smoke.html`)

- **Stub the relay client:** inject a fake WebSocket through a test seam, like the existing `todos:clipcheck` event.
- **Cover:**
  - tray hidden with no suggestions;
  - a suggestion appears with its title and status;
  - Enter adds it to P1 with a session link;
  - 2 adds it to Simmering;
  - Esc dismisses it;
  - undo after adding;
  - a status update changes the badge on the added todo;
  - a malformed or oversized message is ignored;
  - a title containing markup renders as text;
  - "Untitled session" fallback;
  - an ended suggestion expires.

### Docs

- **README:** a "Claude Code integration" section covering install, connect, what's sent (encrypted titles and status only, never your code) and the opt-out.
- **SECURITY.md:** what the relay can see (channel ids, IP addresses, timing and sizes), and that it never sees content.

**Done when:** start a real Claude Code session → within a few seconds the suggestion appears on https://todos.always17.com → Enter adds it to P1 → the badge follows the session through needs you / your turn / ended.

## Open questions to settle while building

- **Better titles:** Claude Code may write a session title or summary into the transcript (`transcript_path` in the hook input). If it does, update the card's title from it on `Stop`.
- **Desktop app deep links:** whether the Claude desktop app exposes a deep link per session that the badge could open, instead of copying the resume command.
