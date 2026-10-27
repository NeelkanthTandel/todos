# Todos relay

A small Cloudflare Worker that carries data between your Todos board and the things that talk to it: your Claude Code sessions today, and later people you share a board with and your other devices. It's a **dumb relay**: everything is encrypted before it leaves the browser or the Claude Code hook, and the relay only stores and forwards ciphertext. It never sees a key.

- `src/index.ts`: router, CORS, request shape, channel creation (rate-limited per IP).
- `src/channel.ts`: the `Channel` Durable Object, one per channel. SQLite storage, token checks, limits, the WebSocket Hibernation API and the expiry alarm.
- `test/relay.test.ts`: Vitest tests that run inside workerd, through [`@cloudflare/vitest-plugin`](https://www.npmjs.com/package/@cloudflare/vitest-plugin) (the renamed `@cloudflare/vitest-pool-workers`).

## Run it locally

Needs Node 20 or later.

```bash
cd relay
npm ci
npx wrangler dev          # http://localhost:8787
npm test                  # generates types, type-checks, then runs the tests
```

To point a local copy of the site at it, set `relayBase: "http://localhost:8787"` in `public/config.js` and add `http://localhost:8787 ws://localhost:8787` to `connect-src` in `public/index.html` (don't commit either). The relay always accepts `http://localhost:*` and `http://127.0.0.1:*` origins.

A quick check with curl:

```bash
R=http://localhost:8787
curl -s -X POST $R/c -d '{"kind":"inbox"}'                                     # → { id, kind, ownerToken }
curl -s -X POST $R/c/$ID/writers -H "Authorization: Bearer $OWNER"           # → { wid, token, created }
curl -s -X POST $R/c/$ID/messages -H "Authorization: Bearer $WRITER" -d '{"data":"Y2lwaGVydGV4dA"}'
curl -s $R/c/$ID -H "Authorization: Bearer $OWNER"                            # → { kind, messages: [...] }
```

## Deploy

`.github/workflows/relay.yml` runs the tests and `wrangler deploy` on every push to `main` that touches `relay/`. It needs two repo secrets (**Settings → Secrets and variables → Actions**):

- `CLOUDFLARE_API_TOKEN`: a token made from the **Edit Cloudflare Workers** template.
- `CLOUDFLARE_ACCOUNT_ID`: from the Cloudflare dashboard's Workers overview.

The relay then lives at `https://todos-relay.<your-subdomain>.workers.dev`. Put that in `relayBase` in `public/config.js`, and its `https://` and `wss://` origins in the CSP's `connect-src` in `public/index.html`. Everything fits the Workers free plan (SQLite-backed Durable Objects, 100,000 requests a day); past a limit, requests fail until 00:00 UTC rather than costing money.

Self-hosting for another site? Change `ALLOWED_ORIGINS` in `wrangler.toml`.

## Channels

One `Channel` Durable Object per channel id (128-bit random, base64url). Three kinds:

| Kind | Used for | Writers | Readers | Stores |
| --- | --- | --- | --- | --- |
| `inbox` | Claude Code sessions → your board | Paired machines (writer tokens) | The board (owner token) | Messages, newest 500 |
| `share` | Live read-only sharing (milestone 2) | The owner | Anyone with the id | Latest state + version |
| `sync` | Your list across devices (milestone 3) | Owner and paired devices | The same | Latest state + version |

## API

Tokens go in `Authorization: Bearer <token>`. A browser can't set headers on a WebSocket, so there the token goes in a subprotocol instead: `new WebSocket(url, ["todos", "bearer." + token])`. Bodies and replies are JSON; `data` is always a base64url string (`iv ‖ ciphertext`).

| Method and path | Who | Does |
| --- | --- | --- |
| `POST /c` `{ kind }` | anyone (10 a minute per IP) | Creates a channel. `201 { id, kind, ownerToken }` |
| `GET /c/:id` | `share`: anyone. `inbox`: owner. `sync`: owner or writer | `inbox`: `{ kind, messages: [{ id, data, at, wid }] }`. Others: `{ kind, version, data }` |
| `GET /c/:id` with `Upgrade: websocket` | same | Sends what's there now, then every change (see below) |
| `PUT /c/:id/state` `{ data }`, optional `If-Match: <version>` | `share`: owner. `sync`: owner or writer | Replaces the state. `200 { version }`, or `409 { version }` if `If-Match` is stale |
| `POST /c/:id/messages` `{ data }` | `inbox` writers | Appends a message. `201 { id }` |
| `DELETE /c/:id/messages/:mid` | owner | Removes a handled message, and tells the owner's open sockets. `204` |
| `POST /c/:id/writers` | owner (`inbox`, `sync`) | Pairs a machine or device. `201 { wid, token, created }`, or `409` at 50 |
| `GET /c/:id/writers` | owner | `{ writers: [{ wid, created, used }] }` (`used`: an inbox writer's last message, or a sync device's last request; `null` until then) |
| `DELETE /c/:id/writers/:wid` | owner | Revokes it, and closes its open sockets. `204` |
| `DELETE /c/:id` | owner | Deletes the channel. Open sockets get `{ "type": "deleted" }`. `204` |

WebSocket messages from the relay: `{ type: "message", id, data, at, wid }`, `{ type: "removed", id }` (an inbox message was deleted, maybe from another tab), `{ type: "state", version, data }` and `{ type: "deleted" }`. Send `ping` to keep a socket alive; the relay answers `pong` without waking up.

Errors are `{ error }` with `400` (bad request), `401` (missing or wrong token), `403` (origin not allowed), `404` (no such channel), `409` (version conflict, or too many paired devices), `413` (too large) or `429` (too fast).

## Limits

- State up to 256 KB of `data`; a message up to 16 KB.
- An inbox keeps the newest 500 messages; older ones are dropped.
- Writes (`PUT state`, `POST messages`, `POST writers`): bursts of 5, then 2 a second per channel.
- Up to 50 paired machines or devices per channel.
- 10 new channels a minute per IP address.
- Anonymous reads and WebSockets on `share` channels aren't throttled beyond Cloudflare's own limits.
- A channel nobody has used for 90 days deletes itself (Durable Object alarm).

## Security

- Tokens are 256-bit random values. The relay keeps only their SHA-256 hashes.
- Browsers can call it only from `ALLOWED_ORIGINS` (`https://todos.always17.com`, and `todos-app://app` for the Mac app's web view) and localhost; other origins get `403`. Requests without an `Origin` (the Claude Code hook, curl) are fine, since they rely on tokens, not cookies.
- The relay never logs request bodies, and Workers Logs are off (`[observability] enabled = false`).
- What it can see: channel ids, IP addresses, when requests happen and how big they are. What it can't: titles, todos, project names, session status. See [SECURITY.md](../SECURITY.md).
