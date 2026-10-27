# Milestone 3: Syncing your own list across devices

**Goal:** the same list on your laptop, phone and other browsers, with edits on any device showing up on the others. It keeps working offline, and there are still no accounts.

**Requires milestone 1** (the relay with the `sync` channel kind). It's independent of milestone 2. Read [README.md](README.md) first.

## Pairing

- **First device:** **Sync across devices** (in the footer or a settings menu):
  - creates a `sync` channel;
  - saves `{ id, key, ownerToken }` in `localStorage` as `todos.sync`;
  - uploads the current list.
- **Adding a device:**
  - the first device mints a writer token and shows a pairing code, plus a QR code (generated in-page, no library if feasible, otherwise a small vendored encoder in `public/`);
  - the code is base64url of `{ relay, channelId, key, writerToken }`;
  - entering or scanning it on the other device links it.
- **When the second device already has todos:** ask **Merge both lists** (default) or **Replace this device's list**.
- **Managing devices:** a list of linked devices, each with **Unlink** (revokes its token). **Turn off sync** stops syncing on this device.

## Merging: the hard part

Today a save replaces the whole list, which loses edits when two devices change things at once. Sync needs per-item merging:

- **Data model:**
  - add `updated` (epoch ms, set on every change to that todo);
  - keep deletions as tombstones `{ id, deleted: true, updated }` for 30 days, so a deletion on one device isn't undone by a stale copy on another;
  - keep the order as an explicit `pos` (a fractional index per lane), so concurrent reorders merge instead of fighting.

  Update `normalize()` and the contract comment in `storage.js`.
- **Merge rule:** last writer wins **per todo**, by `updated`. On a tie a deletion wins, then a fixed choice (the larger canonical JSON), so every device picks the same. Union by id; tombstones beat older versions. A linked Claude session's status goes by its own `updatedAt`, not the todo's.
- **Saving:** `PUT /c/:id/state` with `If-Match: <version>`. On `409`, fetch the current state, merge, and retry with backoff.
- **Receiving:** live `state` messages merge into the local list.
- **Undo:** the existing `adopt()` behaviour (history cleared when another device's list arrives) still applies. Revisit only if it gets in the way.
- **Where it plugs in:** `storage.js` already has a seam for a remote store (`TodoStorage.remote`), used by `app.js`'s `connect()`/`flush()`/`subscribe()`. Add a `relaySync` store behind the same interface, with merging in the client.

## Tests (`tests/smoke.html`)

**Merge logic:**
- edits on different todos on two devices both survive;
- the same todo edited on both → newer wins;
- delete versus older edit → stays deleted;
- concurrent reorders keep both moves sensibly;
- tombstones expire after 30 days.

**Flows** (through the test seam):
- pairing;
- "merge both lists";
- offline edits are uploaded when back online;
- a `409` conflict causes a retry with a merge;
- unlinking stops updates.

**Done when:** a laptop and a phone stay in sync through simultaneous edits, offline edits and deletes, with nothing lost.

## Later

- **The desktop app** (Tauri, reusing `public/`) can use the same sync channel.
- **Claude Code cloud sessions** already reach the board through milestone 1's inbox.
