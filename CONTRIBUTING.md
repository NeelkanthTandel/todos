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
| `public/index.html` | Markup, and the Content Security Policy for GitHub Pages |
| `public/app.js` | The board: lanes, drag and drop, list parsing, undo/redo, shortcuts, export/import |
| `public/storage.js` | Where todos are kept: localStorage always, plus an optional HTTP mirror. The API contract is at the top. |
| `public/config.js` | Per-deploy settings |
| `public/styles.css` | Styles, light and dark |
| `nginx/`, `Dockerfile` | The self-hosted image |
| `tests/smoke.html` | End-to-end checks that drive the app in an iframe |

## Before you open a pull request

- `tests/run.sh` passes. It runs `tests/smoke.html` in headless Chrome. Set `CHROME=/path/to/browser` if it can't find one. You can also just open the test page and look for `PASS`.
- New behaviour has a check in `tests/smoke.html`.
- UI changes include a before/after screenshot in the PR, in light and dark mode if colours changed.
- One topic per PR. Small PRs get reviewed faster.

CI also runs `node --check`, [html-validate](https://html-validate.org/) and a Docker build on every PR.

## Code guidelines

- Keep it dependency-free: plain HTML, CSS and JavaScript, no frameworks, no build step, no CDN links.
- **No third-party requests.** No trackers, analytics, remote fonts or scripts. The Content Security Policy blocks them anyway, both in `public/index.html` and in `nginx/security-headers.conf` (keep the two in step).
- Never put user text into `innerHTML`. Use `textContent`, or `esc()` for the few attribute strings built as HTML.
- Anything read from localStorage, an imported file or the server goes through `normalize()` in `app.js`.
- If you change the saved data shape, keep old data loading (`normalize()` fills gaps) and update the contract in `storage.js` and the README.
- Every change to the list should go through `record()` so it can be undone.
- Keep the keyboard shortcuts and screen-reader announcements working when you change the UI.
- Match the existing style: 2-space indents (see `.editorconfig`), double quotes, short comments that explain why.

## Deploys

Merges to `main` that touch `public/` publish to GitHub Pages at https://todos.always17.com/.

## Reporting bugs and security issues

Use the issue templates for bugs and feature requests. For security problems, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
