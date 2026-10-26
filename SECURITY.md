# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately via GitHub: **Security → Report a vulnerability** on this repository. That opens a private advisory only the maintainers can see.

Please include what you found, how to reproduce it, and the browser and version you used. You'll get a reply within a week. Fixes are published before details are made public.

## Supported versions

Only the latest version on `main` (what's live at https://todos.always17.com/) gets security fixes.

## What Todos can do in your browser

Knowing this helps when judging a report:

- **Your todos stay in your browser.** With the default `storage: "local"`, they live in this site's `localStorage` and are never sent anywhere. There are no accounts, analytics, trackers or third-party requests; the font is self-hosted.
- **Clipboard suggestions are opt-in and Chromium-only.** Once you turn them on (which asks for the browser's clipboard permission), Todos reads the clipboard only when you return to the tab and the new-todo box is empty. Text that matches secret patterns (private keys, GitHub/GitLab/Slack/Stripe/AWS/Google/OpenAI/Anthropic tokens, JWTs, URLs with a password, `KEY=value` lines, passwords, one-time codes, card numbers, long random strings) is never shown. Suggested text isn't saved unless you add it; to avoid repeating suggestions, only SHA-256 hashes of handled text are kept. The filters live in `public/clipboard.js` and, like any pattern list, can miss things.
- **Anything on the same origin can read them.** That's how `localStorage` works. Todos runs on its own domain so no other site shares that storage. If you host it under a shared origin (for example `you.github.io/todos`), every other page on that origin can read and change your list.
- **Imported files are treated as untrusted.** Import only keeps known fields with the right types, drops rows with malformed ids or empty text, ignores duplicates, and refuses files over 2 MB or 5,000 todos. Todo text is always rendered as text, never as HTML.
- **A Content Security Policy** limits scripts, styles, fonts and network requests to the site itself (plus the relay, once one is configured). It's set with a `<meta>` tag, so it works on any static host, and the page sends no referrer to other sites.
- **The Claude Code integration is optional and end-to-end encrypted.** It's hidden unless `relayBase` is set in `public/config.js`, and does nothing until you click **Connect Claude Code**. The board then creates an inbox on the relay (`relay/`, a Cloudflare Worker) and a 256-bit AES-GCM key, which stays in this browser's `localStorage` and in the pairing code you give Claude Code. The plugin keeps it in `~/.config/todos/connection.json` (mode 600). The pairing code also passes through the Claude Code conversation where you run `/todos:connect`.
  - **What the relay can see:** channel ids, IP addresses, when messages are sent, how big they are, how many machines are paired and when each last sent something.
  - **What it can't see:** anything inside a message: session titles, project names, status, session ids, machine names. Keys never go to the relay, and it stores only SHA-256 hashes of the access tokens. It doesn't log request bodies.
  - **What's in a message:** a title made from the first line of a session's first prompt (run through the same secret filter as clipboard suggestions; nothing if it looks like a secret), the project's folder name, a session id, local or cloud, a status and a time. Never code, files or full paths.
  - **Messages are untrusted input to the board.** A machine you paired could send anything, so the board decrypts, validates every field strictly, ignores anything malformed or oversized, and renders text only with `textContent`. Disconnecting a machine in the dialog revokes its token on the relay at once.
  - **Access is by unguessable ids and tokens, not accounts.** The relay accepts browser requests only from this site's origin (and localhost), limits message sizes and write rates, and deletes channels unused for 90 days.
- **Live sharing is optional, end-to-end encrypted and read-only for viewers.** **Share live link…** creates a `share` channel on the relay and a new 256-bit AES-GCM key. The key is only in the link (after the `#`, which browsers never send to servers) and in the sharer's `localStorage`; the viewer's page removes it from the address bar on load and keeps it in its own `localStorage` (`todos.shared`).
  - **What the relay can see:** the channel id, the IP addresses of the sharer and of everyone viewing, when the board changes and how big the encrypted snapshot is.
  - **What it can't see:** the todos, the sharer's name, which lanes or options were picked. A snapshot holds only the included todos' text and done/in-progress flags: no ids, timestamps or Claude Code session details.
  - **Anyone with the link can read the board** until it's stopped. Treat it like the board itself. **Stop sharing** deletes the channel and everything on it; open viewers are told at once. Only the sharer's browser holds the owner token that can write or delete.
  - **A shared board is untrusted input for the viewer.** It's decrypted, validated (shape, types, lengths, at most 5,000 todos) and rendered as text only. It's kept apart from the viewer's own list (`todos.v1`), and every path that could change a list is blocked while viewing one; the only write is copying todos into the viewer's own list.
- **Device sync is optional and end-to-end encrypted.** **Sync across devices** creates a `sync` channel on the relay and a new 256-bit AES-GCM key, kept in `localStorage` (`todos.sync`) on each linked device. The relay stores the whole list (todos and 30-day deletion records) as one encrypted blob.
  - **What the relay can see:** the channel id, each device's IP address, when a device reads or saves, how big the encrypted list is, how many devices are linked and when each was last seen.
  - **What it can't see:** any todo, its lane, order or status, or the device names.
  - **A pairing code (and its QR code) is the key to your list**: base64url of the relay address, channel id, key and a new writer token. Anyone who gets one can read and change your synced list until you **Unlink** that device. Each code is for one device, and a code stays the same only until a device uses it.
  - **Lists from other devices are untrusted input.** They're decrypted, validated like an imported file (and deletion records like todos), merged per todo, and rendered as text only.
  - **Unlinking revokes that device's token on the relay at once** and closes its connection; the device stops syncing and keeps its own copy. Only the first device (which holds the owner token) can add or unlink devices.
- **The optional server mode** (`storage: "http"` in `public/config.js`) sends the whole list to `apiBase` and, by default, includes cookies only for the site's own origin. Whoever runs that API should authenticate users with `HttpOnly`, `SameSite` cookies, require `Content-Type: application/json` on writes, check the `Origin` header, and validate and size-limit `items` on the server: the client forwards whatever a user imported.
