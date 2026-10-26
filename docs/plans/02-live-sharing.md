# Milestone 2: Live sharing (read-only for viewers)

**Goal:** share your board with someone through a link. They see your todos update live, in a view that makes it unmistakable that they're looking at someone else's list. They can switch back to their own list instantly.

**Requires milestone 1** (the relay with the `share` channel kind). Read [README.md](README.md) first.

> **Rule: shared todos are always read-only for the viewer.** No editing, ticking, moving, adding, deleting or reordering on a shared board, by any path: clicks, keyboard shortcuts, drag and drop, the composer, Import or clipboard suggestions. The only write a viewer can make is copying items into *their own* list. Tests must prove each of these paths is blocked.

## Sharing (the owner's side)

- **Starting:** Export menu → **Share live link…** opens a dialog with:
  - **Your name** (remembered in `localStorage`), shown to viewers as "Priya's todos";
  - **What to include:** open todos (default on), done todos (default off), and a toggle per lane;
  - **Create link**, which creates a `share` channel and shows `https://todos.always17.com/#share=<channelId>.<key>` with **Copy link**;
  - the plain warning: "Anyone with this link can see these todos, and updates appear for them as you make changes."
- **Keeping it live:** after each local `save()`, debounced to about 1 s, encrypt a compact snapshot and `PUT` it as the channel state. Format: `{ v: 1, name, at, lanes: [[{ t: text, d?: 1, w?: 1 }, …] ×4] }`. No ids, timestamps or session data, and only the included lanes and items.
- **Storage:** active shares go in `localStorage` as `todos.shares`: `[{ id, key, ownerToken, name, options, createdAt }]`. You can have more than one (say, one for work and one for home).
- **Managing:** **Shared links** in the Export menu lists active shares, each with **Copy link**, **Change what's included** and **Stop sharing**. Stopping deletes the channel, and viewers see "Priya stopped sharing".
- **Status:** the footer shows "Sharing live" while at least one share is active, so it's never forgotten.

## Viewing (the other person's side)

- **Opening a link:** when the page loads with `#share=<id>.<key>`:
  - save `{ id, key, name, lastState, lastSeenAt }` into `localStorage` under `todos.shared` (a list);
  - replace the URL fragment with `#shared=<id>`, so the key isn't left in the address bar or in screenshots;
  - switch to that board.
- **It must be unmistakable:**
  - a **non-dismissable banner** at the top in a colour no other part of the app uses: "Viewing **Priya's** todos · live · updated 2 min ago · read-only", with **Back to my todos** and **Copy to mine** buttons;
  - a tinted frame around the whole board;
  - a browser-tab title of "Priya's todos (shared)".
- **Read-only:**
  - The composer, drag handles, row actions, checkboxes, the Done panel's "Clear all", Import and clipboard suggestions are hidden or inert.
  - Keyboard shortcuts that would change something show a toast: "Read-only: this is Priya's list".
  - Expanding lanes, the Done panel (view only) and Export as text still work.
- **Copying into your own list:** an **Add to mine** action per todo, plus **Copy all**, add copies to your own Fridge lane with new ids. This goes through `record()`, so it can be undone, and it never touches the shared board.
- **Switching:**
  - The "Todos" heading becomes a switcher: **My todos**, then each shared board ("Priya's · live"), then **Remove…**.
  - The `` ` `` (backtick) key toggles between your board and the last shared one you viewed.
  - Your own board looks exactly as it does today.
- **Live updates:** connect over a WebSocket and re-render on each `state` message, keeping scroll position and any open lane.
- **When the connection drops:**
  - **Offline or unreachable:** show the cached copy with "Offline · last updated 3 h ago".
  - **Channel deleted:** show "Priya stopped sharing" and offer **Remove** or **Keep last copy**.
- **Storage stays separate:** shared boards never touch `todos.v1`. Viewer data is untrusted input, so decrypt and then validate as strictly as `normalize()`.

## Tests (`tests/smoke.html`)

**Read-only:** inject a share state through the test seam, then prove every write path is blocked:
- click, drag, every keyboard shortcut, the composer, Import, clipboard suggestions;
- your own `todos.v1` is unchanged afterwards.

**Viewing:**
- banner text and visibility;
- backtick switching;
- **Add to mine** copies into your Fridge lane, and undo removes it;
- a state update re-renders;
- the "stopped sharing" path;
- the key is stripped from the URL;
- a malformed state is ignored.

**Sharing:** the snapshot respects the include options (done off → no done items).

**Done when:** two browsers, one sharing and one viewing; edits on the first appear on the second within about a second, and nothing on the second can change anything.
