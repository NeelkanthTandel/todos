# Todos

**A todo board sorted by heat.** Everything goes into one of four lanes: *Boiling over* (today), *Simmering* (this week), *Back burner* (whenever) or *Still in the fridge* (not sorted yet). Paste a whole list at once, drag things between lanes, and undo anything. Your todos stay in your browser.

**[Open Todos](https://todos.always17.com/)** · no account, no install, works offline

[![CI](https://github.com/NeelkanthTandel/todos/actions/workflows/ci.yml/badge.svg)](https://github.com/NeelkanthTandel/todos/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshot-dark.png">
  <img src="docs/screenshot-light.png" alt="The Todos board: a large Boiling over lane on the left, with Simmering, Back burner and Still in the fridge stacked on the right">
</picture>

## Features

- **Four heat lanes.** The hottest lane gets the most room; cooler ones stack beside it. Expand any lane to fill the board.
- **Paste a list.** Bullets, numbers and checkboxes are stripped, `[x]` items land straight in Done, and the whole batch goes to the fridge for sorting.
- **Drag and drop** between and within lanes, or press `1`–`4` on a todo to move it.
- **In progress** marks what you're actually working on.
- **Done** slides out from the side, grouped by day. Ticked todos linger for a moment so you see them go.
- **Undo anything** with `Ctrl/⌘+Z`, redo with `Ctrl/⌘+Shift+Z`: adds, deletes, moves, edits, imports, clearing Done.
- **Keyboard first.** Shortcuts work on the focused todo, or on the one under your mouse.
- **Export and import** a JSON backup to move between browsers or devices.
- **Light and dark**, following your system. Works on phones.
- **Private.** No accounts, analytics, trackers or third-party requests. It's a static page; your list never leaves your browser.

## Keyboard shortcuts

| Key | Does |
| --- | --- |
| `/` | Jump to the new-todo box |
| `Enter` / `Shift+Enter` | Add / new line (paste or type several lines to add many) |
| `Alt+1`–`Alt+4` | Pick the lane while typing |
| `1`–`4` | Move the focused or hovered todo to that lane |
| `S` | Mark in progress, or stop |
| `X` | Done, or not done |
| `E` | Edit |
| `Delete` | Delete |
| `F` | Expand the lane under the mouse (`Esc` to go back) |
| `↑` `↓` `←` `→` | Move between todos and lanes |
| `Ctrl/⌘+Z`, `Ctrl/⌘+Shift+Z` | Undo, redo |

## Where your todos are stored

By default everything lives in your browser's `localStorage`:

- **Each browser keeps its own list.** Your laptop and phone don't share todos, and nothing reaches a server. Use **Export** and **Import** to copy a list across.
- **Clearing site data deletes it**, and Safari deletes it if you haven't opened the site for 7 days (unless you've added it to your Home Screen). Export a backup now and then.
- **Tabs stay in step.** A change in one tab shows up in your other tabs straight away.

### Backups: Export / Import

**Export** (top right) downloads `todos-YYYY-MM-DD.json`:

```json
{ "app": "todos", "version": 1, "exported": "2026-10-22T09:30:00.000Z", "items": [ ... ] }
```

**Import** reads that file, or a bare array of todos, and merges by `id`. A todo in the file replaces the same todo on the board, and everything else is kept. One `Ctrl/⌘+Z` undoes the whole import. Files over 2 MB or 5,000 todos are refused.

## Run it yourself

It's plain HTML, CSS and JavaScript with no build step, so any static file server works:

```bash
git clone https://github.com/NeelkanthTandel/todos.git
cd todos
python3 -m http.server 8080 -d public
```

Then open http://localhost:8080.

### Docker / Dokploy

The `Dockerfile` serves `public/` with an unprivileged nginx on port **8080**. It also sends security headers (Content Security Policy, `X-Frame-Options`, `nosniff`, `Referrer-Policy`):

```bash
docker build -t todos .
docker run -p 8080:8080 todos
```

On Dokploy, create an **Application** from this repo with **Build Type: Dockerfile**, set the container port to `8080`, and attach a domain.

### GitHub Pages

`.github/workflows/pages.yml` publishes `public/` whenever it changes on `main`. In a fork, set **Settings → Pages → Source** to **GitHub Actions**.

Give it its own domain or subdomain if you can. Every project page under `you.github.io` shares one `localStorage`, so another page there could read your todos. Keys are prefixed with `namespace` from `public/config.js` to avoid collisions, but that doesn't keep the data private.

## Moving to a database later

The app never talks to a database directly. It always keeps the `localStorage` copy, so it loads instantly and works offline. Set `storage: "http"` in `public/config.js` and it also mirrors the whole list to an API with this contract (full details at the top of [`public/storage.js`](public/storage.js)):

| Method | Path | Body / response |
| --- | --- | --- |
| GET | `/api/todos` | `200 { items, updated }`, or `404` if nothing is stored yet |
| PUT | `/api/todos` | body `{ items, updated }`, reply any `2xx` |

- **The server works out who the user is** from its own session or cookie, so the client never sends a user id.
- **Postgres:** `create table todo_lists (user_id text primary key, items jsonb not null, updated bigint not null);`. GET selects the row, PUT upserts it.
- **Mongo:** one document per user, `{ _id: userId, items: [...], updated }`, written with `replaceOne(..., { upsert: true })`.
- **Existing browser data moves over automatically.** On first connect, if the server answers `404` (or an empty list with `updated: 0`) and the browser has todos, the app uploads them. Changes made while offline are uploaded when the server is reachable again.
- **A newer server list wins.** When the tab regains focus, the app fetches the list and takes it if its `updated` is newer than what this browser last saw.
- **Run the API on the same origin.** Use the commented `location /api/` block in [`nginx/default.conf`](nginx/default.conf); that avoids CORS and keeps cookies simple. An exported JSON file can seed the table, since `items` has exactly the shape the API stores.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, how the code fits together and the test page. Please report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). The bundled Schibsted Grotesk font is under the [SIL Open Font License](public/fonts/OFL-SchibstedGrotesk.txt).
