# Todos: notes for Claude

A heat-lane todo board: a static site in `public/`, live at https://todos.always17.com (GitHub Pages, deployed from `main`).

## Before you start

- **Planned work** lives in [`docs/plans/`](docs/plans/README.md). Build the milestones in order and keep the status table there up to date.
- **Shared todos are always read-only for the viewer.** Never add a way for a viewer to change someone else's board.

## Workflow

- `main` is protected: changes land only through a PR, and the `check` CI job must pass. Never try to push to `main` or bypass the ruleset.
- One topic per PR. Merge only when the repo owner says so, using a merge commit.
- Commit as the repo's configured identity (the GitHub noreply address); never use a personal or work email.
- **Tests:** `tests/run.sh` runs `tests/smoke.html` in headless Chrome (`CHROME=/path`, plus `CHROME_FLAGS=--no-sandbox` as root in a container). Also run `node --check public/*.js` and `npx --yes html-validate@11.16.2 public/index.html tests/smoke.html`.

## Code rules (`public/`)

- No dependencies, build step, CDN links or third-party requests. The CSP `<meta>` in `index.html` enforces this.
- Treat anything from localStorage, imported files, the clipboard or a server as untrusted. Validate it the way `normalize()` in `app.js` does, and render text with `textContent`, never `innerHTML`.
- Every change to the list goes through `record()` (undo), then `save()` and `render()`.
- Keep keyboard shortcuts and screen-reader announcements working. Every new behaviour gets a check in `tests/smoke.html`.
- Style: 2-space indents, double quotes, short comments that explain why.
