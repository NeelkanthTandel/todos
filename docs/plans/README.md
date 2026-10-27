# Plans

Three features, built **one at a time, in this order**. Each depends on the one before it.

| # | Milestone | Plan | Status |
| --- | --- | --- | --- |
| 1 | Encrypted relay + Claude Code session suggestions | [01-relay-and-claude-suggestions.md](01-relay-and-claude-suggestions.md) | In review (1a, 1b and 1c in one PR) |
| 2 | Live sharing (read-only for viewers) | [02-live-sharing.md](02-live-sharing.md) | In review |
| 3 | Syncing your own list across devices | [03-device-sync.md](03-device-sync.md) | In review |

Update the **Status** column in the PR that finishes a milestone (or a step of one).

## Why a relay, and why this one

Todos is a static site, and todos live in the browser's `localStorage`. All three features need data to reach a browser from somewhere else (your terminal, another person, your other device) even while the sending side is offline. That needs something in between that holds the latest copy.

The research behind this (October 2026) compared the options:

- **Peer-to-peer (WebRTC):** only works while both sides are online, and 10–25% of connections fail without a TURN relay server. Rejected.
- **Public Nostr relays:** third-party relays can drop data or rate-limit. Rejected.
- **Supabase:** free projects pause after 7 days of low activity. Rejected.
- **Firebase:** workable, but heavier (Google SDK and account, 100 simultaneous connections on the free plan).
- **Cloudflare Workers KV alone:** 1,000 writes/day on the free plan and up to 60 s before other locations see a change. Too limited for live updates.
- **Cloudflare Worker + Durable Objects: chosen.** About 150 lines, deployed once, free tier of 100k requests/day (WebSocket messages included), consistent, pushes updates over WebSockets, and costs nothing while idle (hibernation). Over a limit, requests fail until 00:00 UTC; there's no surprise bill on the free plan.

Even WhatsApp always relayed through its own servers. The trick, which Excalidraw also uses, is a **dumb relay**: it only ever stores ciphertext.

## Rules that apply to every milestone

1. **End-to-end encrypted.** The browser or hook encrypts before anything leaves the device; the relay stores and forwards ciphertext only. Keys live in URL fragments (after `#`, never sent to any server) or in local storage/config files, never in requests to the relay.
2. **Shared todos are always read-only for the person viewing them.** A viewer can never edit, tick, move, add or delete on someone else's board. The only write allowed is copying items into *their own* list.
3. **Local storage stays the source of truth** for your own list. The relay is a mirror and a mailbox, never required to use the app.
4. **No accounts.** Access is by unguessable ids and tokens created in the browser, the way you pair a TV.
5. **The website stays dependency-free** (`public/` has no build step, no npm, no CDN). The relay (`relay/`) and the Claude Code plugin (`claude-plugin/`) are separate folders and may use their own tooling.
6. **Everything lands through PRs.** `main` is protected: a PR and the `check` CI job are required.

## Shared relay design

Built in milestone 1 and reused by 2 and 3. Lives in `relay/`.

### Channels

One Durable Object class, `Channel`, one instance per channel id (128-bit random, base64url). Three kinds:

| Kind | Used by | Writers | Readers | Stores |
| --- | --- | --- | --- | --- |
| `inbox` | 1. Claude suggestions | Paired machines (each has a writer token) | The board that owns it (owner token) | Append-only messages, capped |
| `share` | 2. Live sharing | The sharer (owner token) | Anyone with the channel id (the key in the link keeps it private) | Latest state blob |
| `sync` | 3. Device sync | Every paired device (writer tokens) | Same devices | Latest state blob + version |

### API

Finalized in milestone 1; [`relay/README.md`](../../relay/README.md) is the reference. Changes from the draft below: `GET /c/:id/writers` lists paired machines, a WebSocket carries its token in a subprotocol (`["todos", "bearer.<token>"]`, since browsers can't set headers on one), and writes allow a burst of 5 before the 2/s limit.

| Method and path | Auth | Does |
| --- | --- | --- |
| `POST /c` `{ kind }` | none (rate-limited per IP) | Creates a channel, returns `{ id, ownerToken }` |
| `GET /c/:id` | `share`: none; others: Bearer token | Returns the latest state or the pending messages. With `Upgrade: websocket`, streams updates. |
| `PUT /c/:id/state` (`If-Match: <version>`) | owner or writer | Replaces the state blob. Returns `409` with the current version on conflict (sync). |
| `POST /c/:id/messages` | writer | Appends one encrypted message (inbox) |
| `DELETE /c/:id/messages/:mid` | owner | Removes a handled message |
| `POST /c/:id/writers` | owner | Mints a writer token (pairing); returns `{ wid, token }` |
| `DELETE /c/:id/writers/:wid` | owner | Revokes a paired machine or device |
| `DELETE /c/:id` | owner | Deletes the channel; open sockets get `{ "type": "deleted" }` |

WebSocket messages from the relay: `{ type: "state", version, data }`, `{ type: "message", id, data }`, `{ type: "deleted" }`.

- **Tokens:** 256-bit random, stored on the relay as SHA-256 hashes only.
- **Limits:** state ≤ 256 KB, message ≤ 16 KB, inbox ≤ 500 messages (oldest dropped), 2 writes/s per channel, channels unused for 90 days delete themselves (Durable Object alarm).
- **CORS:** allow `https://todos.always17.com` and `http://localhost:*` / `http://127.0.0.1:*` only.
- **The relay never logs bodies.**

### Encryption (client side)

- AES-GCM with a 256-bit key, a fresh random 96-bit IV per write, `data = base64url(iv ‖ ciphertext)`.
- Plaintext is JSON, compressed with `CompressionStream("deflate-raw")` before encrypting.
- Browser: WebCrypto. Node hook script: `globalThis.crypto.subtle` (Node 18+). No libraries.
- Keys are exported raw and base64url-encoded.

### Hosting

- `relay/wrangler.toml`, deployed by `.github/workflows/relay.yml` on pushes to `main` that touch `relay/**`, using repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. **Adding those secrets is a one-time step for the repo owner;** a Claude session can't do it.
- Address: the default `todos-relay.<account>.workers.dev`. A custom domain like `relay.always17.com` needs `always17.com`'s DNS on Cloudflare (it's at Hostinger today), so it's optional.
- The website learns the address from `public/config.js` (`relayBase`), and the Content Security Policy's `connect-src` must allow it (`https://…` and `wss://…`).
