# Milestone 4: The Mac app

**Goal:** Todos as a Mac app that looks and behaves exactly like the website, opens and hides with ⌥ Space from anywhere, and is as small and light as possible.

**Builds on milestones 1–3.** It ships the same `public/` folder as the website, so every web feature (including the Claude tray, live sharing and device sync as they land) works in the app without app-specific UI.

## Decisions (final, from the repo owner)

| Question | Decision | Why |
| --- | --- | --- |
| Technology | Native Swift/AppKit, laid out like the owner's app Recess (SwiftPM, `Makefile`, `scripts/build_app.sh`, `scripts/make_dmg.sh`, CI on `macos-15`, a tag-triggered release) | Same toolchain and habits as Recess; no third-party Swift packages |
| UI | A thin shell hosting the existing web UI in a `WKWebView`; `public/` is copied into the bundle at build time | The UI stays identical and there is one codebase. Electron was rejected for size |
| Size | Target under 10 MB | Actual: **576 KB** (arm64), **736 KB** universal, **400 KB** DMG |
| Global shortcut | **⌥ Space** shows and hides the window, through Carbon `RegisterEventHotKey` | Needs no Accessibility permission. It takes over Option+Space system-wide while Todos runs |
| Lifetime | Closing or hiding the window keeps the app running | So the shortcut always works |
| Data | The app keeps its **own list** by default; you link it to a browser's list with device sync (milestone 3) | A browser's localStorage can't be shared with the app |
| Identity | Name "Todos", bundle id `com.neel.todos`, macOS 14+, code in `mac/` | |

## How it works

- **`todos-app://app/`**: a `WKURLSchemeHandler` (`AppScheme.swift`) serves `Contents/Resources/web`. A custom scheme gives a stable origin, so localStorage persists in `WKWebsiteDataStore.default()`. Relative paths and the page's CSP (`'self'`) keep working, and WebKit treats the origin as a secure context, so WebCrypto works for the relay. The handler refuses anything outside the web folder (`..`, encoded dots, hidden files, symlinks out) and sets MIME types and `nosniff`.
- **The relay:** the page's origin is `todos-app://app`, so `relay/wrangler.toml` adds it to `ALLOWED_ORIGINS`. The relay only answers browser requests from listed origins. Requests to the relay still need `relayBase` and the CSP's `connect-src`, exactly as on the website.
- **Clipboard suggestions:** WKWebView can't read the clipboard without a click each time. So `public/app.js` asks a native handler (`webkit.messageHandlers.todosClipboard`, in `ClipboardBridge.swift`) instead of `navigator.clipboard` when it exists. Swift answers only while Todos is the active app and only to the bundled page. It returns "" for anything marked `org.nspasteboard.ConcealedType` or `TransientType` (password managers). The text then goes through the same filters (`public/clipboard.js`) and suggestion flow as in Chromium, and the website is unchanged. The page asks on focus, which is when the app is activated.
- **Browser features, done natively:** the Edit menu (⌘C/V/X/A/Z), links opening in the default browser, Export through `WKDownload` and a save panel, Import through `runOpenPanelWith`, JavaScript alerts and confirms, and remembering the window's size and position (`setFrameAutosaveName`). A second copy hands over to the first and quits. If WebKit's content process crashes, the page reloads.
- **⌥ Space:** if Todos is in front with its window up, the shortcut hides the app, which hands focus back to where you were. Otherwise it shows and activates the window, bringing it forward even when it was open behind another app (`WindowToggle` in `HotKey.swift`).
- **Self-test:** `TODOS_SELFTEST=<folder> Todos.app/Contents/MacOS/Todos` checks the real bundle and quits. It checks that the board renders, the CSP blocks other origins, storage, WebCrypto, the native bridge, and that the toggle hides and shows the window. It writes `report.json` and a WebKit snapshot `board.png`. CI runs it on every PR.

## Notes for milestones 2 and 3

- **Share links (M2):** the page's origin in the app is `todos-app://app`, so a share link must be built from the website's address (`https://todos.always17.com/#share=…`), not from `location.origin`. Opening a share link that someone sent you still happens in the browser, or by pasting it into the app once M2 adds that.
- **Device sync (M3):** the app is just another device. Its pairing code works like a browser's, which is how the app's list and a browser's list become one.
- Neither needs Swift changes, as long as they stay inside `public/`.

## Status

Built in the `claude/mac-app` PR; [`mac/STATUS.md`](../../mac/STATUS.md) is the checklist.
