# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately via GitHub: **Security → Report a vulnerability** on this repository. That opens a private advisory only the maintainers can see.

Please include what you found, how to reproduce it, and the browser and version you used. You'll get a reply within a week. Fixes are published before details are made public.

## Supported versions

Only the latest version on `main` (what's live at https://todos.always17.com/) gets security fixes.

## What Todos can do in your browser

Knowing this helps when judging a report:

- **Your todos stay in your browser.** With the default `storage: "local"`, they live in this site's `localStorage` and are never sent anywhere. There are no accounts, analytics, trackers or third-party requests; the font is self-hosted.
- **Clipboard suggestions are opt-in and Chromium-only.** Once you turn them on (which asks for the browser's clipboard permission), Todos reads the clipboard only when you return to the tab and the new-todo box is empty. Text that matches secret patterns (private keys, GitHub/GitLab/Slack/Stripe/AWS/Google/OpenAI/Anthropic tokens, JWTs, URLs with a password, `KEY=value` lines, passwords, one-time codes, card numbers, long random strings) is never shown. Suggested text isn't saved unless you add it; to avoid repeating suggestions, only SHA-256 hashes of handled text are kept. The filters live in `public/clipboard.js` and, like any pattern list, can miss things.
- **Anything on the same origin can read them.** That's how `localStorage` works. Todos runs on its own domain so no other site shares that storage. If you host it under a shared origin (for example `you.github.io/todos`), every other page on that origin can read and change your list.
- **Imported files are treated as untrusted.** Import only keeps known fields with the right types, drops rows with malformed ids or empty text, ignores duplicates, and refuses files over 2 MB or 5,000 todos. Todo text is always rendered as text, never as HTML.
- **A Content Security Policy** limits scripts, styles, fonts and network requests to the site itself. It's set with a `<meta>` tag, so it works on any static host, and the page sends no referrer to other sites.
- **The optional server mode** (`storage: "http"` in `public/config.js`) sends the whole list to `apiBase` and, by default, includes cookies only for the site's own origin. Whoever runs that API should authenticate users with `HttpOnly`, `SameSite` cookies, require `Content-Type: application/json` on writes, check the `Origin` header, and validate and size-limit `items` on the server: the client forwards whatever a user imported.
