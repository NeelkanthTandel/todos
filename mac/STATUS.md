# Mac app status

What's done and what's left, so the next person (or session) can pick up from here. The decisions are in [`docs/plans/04-mac-app.md`](../docs/plans/04-mac-app.md).

## Done

- [x] SwiftPM package in `mac/` (`Todos` executable + `TodosTests`), macOS 14+, no third-party packages
- [x] `todos-app://app/` scheme handler serving the bundled `public/`, with path-traversal, symlink and MIME tests
- [x] WKWebView with the persistent default data store (the app keeps its own list)
- [x] ⌥ Space global shortcut (Carbon `RegisterEventHotKey`) that toggles the window; the app keeps running when the window is closed
- [x] Toggle decision logic unit-tested; the real toggle checked by the self-test (hide → show → hide)
- [x] Standard app, Edit, View, Window and Help menus (⌘C/V/X/A/Z work in the page)
- [x] External links open in the default browser; nothing but the bundled page loads in the window
- [x] Export downloads (`WKDownloadDelegate` + save panel), Import (`runOpenPanelWith`)
- [x] Window size and position remembered
- [x] Native clipboard bridge (skips concealed/transient copies), wired into `public/app.js`, with a smoke check in `tests/smoke.html`
- [x] Relay allows the app's origin `todos-app://app` (with a relay test)
- [x] `make app` / `make dmg` / `make test` / `make lint`, `scripts/build_app.sh` (copies `public/`), `scripts/make_dmg.sh`, generated app icon
- [x] `TODOS_SELFTEST` mode: renders the board, checks the CSP, storage, WebCrypto and the bridge, writes a snapshot
- [x] CI `mac` job on `macos-15`: lint, unit tests, build, self-test, app artifact
- [x] Release workflow on `mac-v*` tags publishing an unsigned DMG (no tag created)
- [x] README "Mac app" section, `docs/plans/04-mac-app.md`, `docs/SETUP.md`
- [x] Verified locally: built, 16 unit tests pass, launched, self-test passed, the board renders (WebKit snapshot), the app quit afterwards

## Left (needs the repo owner or a later milestone)

- [ ] Press ⌥ Space on a real keyboard once: the unattended session couldn't send real key presses (no Accessibility permission), so the Carbon key delivery itself is unverified. The code path it calls is verified.
- [ ] Rebase onto `main` once milestones 2 and 3 land, then rebuild. The app picks up their UI automatically.
- [ ] After the relay is deployed and `relayBase` is set: try Connect Claude Code in the app, which checks the relay's CORS for `todos-app://app` against the real Worker.
- [ ] Optional: Developer ID signing and notarization (Recess has the workflow steps), so Gatekeeper doesn't ask on first launch.
- [ ] Optional: a tag ruleset protecting `mac-v*`, like Recess's `v*`.
