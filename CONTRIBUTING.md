# Contributing to Todos

Thanks for helping! Bug reports, ideas and code are all welcome.

## Getting started

There's no build step and nothing to install. All you need is Python 3 (or any static file server) and a browser.

```bash
git clone https://github.com/NeelkanthTandel/todos.git
cd todos
python3 -m http.server 8080
```

Open http://localhost:8080/public/ for the app and http://localhost:8080/tests/smoke.html for the tests. Serve the repo root rather than `public/`, so the test page can reach the app.

Your local copy has its own `localStorage` (it's a different origin from the live site), so you can experiment freely.

## How it fits together

| File | What it does |
| --- | --- |
| `public/index.html` | Markup, and the Content Security Policy |
| `public/app.js` | The board: lanes, drag and drop, list parsing, undo/redo, shortcuts, export/import, Claude sessions, live sharing, device sync |
| `public/storage.js` | Where todos are kept: localStorage always, plus an optional HTTP mirror or device sync over the relay (with the per-todo merge). The API contract is at the top. |
| `public/clipboard.js` | Decides whether copied text is safe to suggest (secret patterns). Add a case to `tests/smoke.html` when you change it. |
| `public/relay.js` | Client for the relay: channels, state, pairing codes, the WebSocket, and AES-GCM + deflate encryption |
| `public/qr.js` | A small QR code encoder for sync pairing codes (no library) |
| `public/config.js` | Per-deploy settings |
| `public/styles.css` | Styles, light and dark |
| `tests/smoke.html` | End-to-end checks that drive the app in an iframe |
| `relay/` | The end-to-end encrypted relay (Cloudflare Worker). Has its own tooling: `cd relay && npm ci && npm test`. See [relay/README.md](relay/README.md) |
| `claude-plugin/` | The Claude Code plugin. Tests: `node --test claude-plugin/test/plugin.test.mjs`. See [claude-plugin/README.md](claude-plugin/README.md) |

## Before you open a pull request

- `tests/run.sh` passes. It runs `tests/smoke.html` in headless Chrome. Set `CHROME=/path/to/browser` if it can't find one. (If it hangs with `RUNNING`, that Chrome build doesn't honour `--virtual-time-budget`; point `CHROME` at a `chrome-headless-shell` binary instead.) You can also just open the test page and look for `PASS`.
- New behaviour has a check in `tests/smoke.html`.
- UI changes include a before/after screenshot in the PR, in light and dark mode if colours changed.
- One topic per PR. Small PRs get reviewed faster.

CI also runs `node --check`, [html-validate](https://html-validate.org/), the plugin's tests and the relay's tests on every PR. If you change `public/clipboard.js`, copy it to `claude-plugin/scripts/clipboard.cjs` too (a test checks they match).

## Code guidelines

- Keep the site (`public/`) dependency-free: plain HTML, CSS and JavaScript, no frameworks, no build step, no CDN links. `relay/` and `claude-plugin/` are separate and may use their own tooling.
- **No third-party requests.** No trackers, analytics, remote fonts or scripts. The Content Security Policy in `public/index.html` blocks them anyway.
- Never put user text into `innerHTML`. Use `textContent`, or `esc()` for the few attribute strings built as HTML.
- Anything read from localStorage, an imported file or the server goes through `normalize()` in `app.js`.
- If you change the saved data shape, keep old data loading (`normalize()` fills gaps) and update the contract in `storage.js` and the README.
- Every change to the list should go through `record()` so it can be undone.
- Keep the keyboard shortcuts and screen-reader announcements working when you change the UI.
- Match the existing style: 2-space indents (see `.editorconfig`), double quotes, short comments that explain why.

## Deploys

Merges to `main` that touch `public/` publish to GitHub Pages at https://todos.always17.com/. Merges that touch `relay/` deploy the relay to Cloudflare Workers (`.github/workflows/relay.yml`).

## Reporting bugs and security issues

Use the issue templates for bugs and feature requests. For security problems, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
