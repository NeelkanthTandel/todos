# Setting up the relay, Claude Code, sharing, sync and the Mac app

A step-by-step guide for the repo owner. You don't need to know Cloudflare: every click is spelled out. It's written from the code as of October 27, 2026.

**Where things stand at the time of writing**

| Piece | Branch / PR | State |
| --- | --- | --- |
| Milestone 1: relay + Claude Code suggestions | `claude/relay-suggestions`, [PR #6](https://github.com/NeelkanthTandel/todos/pull/6) → `main` | Open, `check` green |
| Milestone 2: live sharing | `claude/live-sharing` | **Not started** (no branch yet) |
| Milestone 3: device sync | `claude/device-sync` | **Not started** (no branch yet) |
| Mac app | `claude/mac-app` → `claude/relay-suggestions` | Open, stacked on PR #6 |

Do the parts in order. Parts 1–2 take about 15 minutes, and nothing in them costs money.

---

## Part 1: Cloudflare (account, subdomain, Account ID, API token)

The relay is a small Cloudflare Worker (`relay/`) that only ever stores encrypted data. It runs on the free plan.

### 1.1 Create the account

1. Go to <https://dash.cloudflare.com/sign-up>, sign up with email and password, and verify your email.
2. If it asks what you want to do, skip it, or pick anything; you don't need to add a website or domain.

### 1.2 Pick your workers.dev subdomain (once per account)

1. In the left sidebar, open **Compute (Workers)** › **Workers & Pages**. Older layouts just say **Workers & Pages**.
2. The first visit asks you to choose a **workers.dev subdomain**, for example `neel`. Choose one and confirm.
   - If you don't see the prompt, look for **Your subdomain** on the right of the Workers & Pages overview. It shows `<something>.workers.dev`, with a **Change** link.
3. Write it down. Your relay's address will be **`https://todos-relay.<subdomain>.workers.dev`** (`todos-relay` comes from `name` in `relay/wrangler.toml`).

### 1.3 Copy your Account ID

On the same **Workers & Pages** overview, the right-hand column shows **Account ID** with a copy button. Copy it. It's a 32-character hex string, and it's also the long part of the dashboard URL: `dash.cloudflare.com/<account id>/…`.

### 1.4 Create the API token

1. Click your profile icon (top right) › **My Profile** › **API Tokens** (or go to <https://dash.cloudflare.com/profile/api-tokens>).
2. **Create Token** › next to the **Edit Cloudflare Workers** template, click **Use template**.
3. Under **Account Resources**: **Include** › your account.
4. Under **Zone Resources**: **Include** › **All zones from an account** › your account. You have no zones, so this grants nothing extra, but the template wants a value.
5. Leave **Client IP Address Filtering** and **TTL** empty. **Continue to summary** › **Create Token**.
6. **Copy the token now.** Cloudflare shows it only once. If you lose it, roll or delete it and make a new one.

This is the template the repo's docs and `.github/workflows/relay.yml` name. The deploy itself uses only **Account › Workers Scripts › Edit** (which covers Durable Objects) and **Account › Account Settings › Read**. A custom token with just those two should also work, but only the template is documented in the repo, and neither was tried against a real account here.

### 1.5 What the free plan needs (nothing to switch on)

- **Durable Objects:** `relay/wrangler.toml` declares the `Channel` class with `new_sqlite_classes`, which makes it a SQLite-backed Durable Object. Those are available on the free plan, and the first deploy creates it.
- **Limits:** 100,000 requests a day, WebSocket messages included. Past a limit, requests fail until 00:00 UTC; the free plan never bills you.
- **Rate limiting:** `wrangler.toml` also declares a `[[ratelimits]]` binding (10 new channels a minute per IP). If the first deploy complains about it, see the failures table at the end.
- **Logs:** Workers Logs are off (`[observability] enabled = false`) so nothing about requests is stored. Leave it that way.

---

## Part 2: GitHub secrets

1. Open <https://github.com/NeelkanthTandel/todos/settings/secrets/actions>: **Settings** › **Secrets and variables** › **Actions**.
2. **New repository secret**: name `CLOUDFLARE_API_TOKEN`, value: the token from 1.4. **Add secret**.
3. **New repository secret**: name `CLOUDFLARE_ACCOUNT_ID`, value: the ID from 1.3. **Add secret**.

Use exactly those names. `.github/workflows/relay.yml` reads them and stops with "Add the CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID repo secrets…" if either is missing.

---

## Part 3: Merge the stacked PRs, in order

The PRs are stacked: each one's base is the branch before it. Merge from the bottom up, with **Create a merge commit** (the repo's rule).

1. **PR #6 (milestone 1) → `main`.** Check that `check` is green, then **Merge pull request** › **Create a merge commit**, and **Delete branch** afterwards. Deleting `claude/relay-suggestions` makes GitHub retarget the PRs stacked on it (the Mac app PR, and milestone 2 once it exists) to `main` automatically.
2. **After merging, check:**
   - **Actions** › **CI** on `main` is green.
   - **Actions** › **Relay** started, because the merge touched `relay/**`. Open it. The **Deploy** step should end with a line like `https://todos-relay.<subdomain>.workers.dev` and `Current Version ID: …`.
   - Open `https://todos-relay.<subdomain>.workers.dev/` in a browser. It should say `Todos relay. See https://github.com/NeelkanthTandel/todos/tree/main/relay`.
   - If you added the secrets after merging, run it by hand: **Actions** › **Relay** › **Run workflow** › branch `main` › **Run workflow**.
   - **Actions** › **Pages** redeployed the site. Nothing visible changes yet: Claude Code stays hidden until Part 4.
3. **Milestone 2 (live sharing) and milestone 3 (device sync)**, when their PRs exist: same steps, one at a time. Once the base PR is merged and its branch deleted, check that the next PR now targets `main` (the base shown at the top of the PR). If it didn't retarget, click **Edit** next to the title and set the base to `main`. Wait for `check` to pass on the new base before merging.
4. **The Mac app PR** last. It's built on milestone 1 only, so once 2 and 3 land, ask for it to be rebased onto `main` (or click **Update branch**) so the app bundles their UI too. Its merge also redeploys the relay, because it adds the app's origin `todos-app://app` to `ALLOWED_ORIGINS` in `relay/wrangler.toml`.

---

## Part 4: Turn the features on (`relayBase` and the CSP), through a PR

`main` is protected, so this is a small PR of its own. Two edits, both required: the page can only reach the relay if the CSP allows it, and a smoke check fails if `relayBase` is set without the CSP change.

```bash
git switch main
git pull
git switch -c turn-on-relay
```

1. **`public/config.js`**: set your address (no trailing slash):
   ```js
   relayBase: "https://todos-relay.<subdomain>.workers.dev",
   ```
2. **`public/index.html`**, line 7, the `Content-Security-Policy` meta tag: change `connect-src 'self'` to
   ```
   connect-src 'self' https://todos-relay.<subdomain>.workers.dev wss://todos-relay.<subdomain>.workers.dev
   ```
   Leave the rest of the policy as it is.
3. Check and ship it:
   ```bash
   tests/run.sh
   git commit -am "Turn on the relay"
   git push -u origin turn-on-relay
   gh pr create --fill
   ```
   Merge it once `check` is green. After Pages redeploys, reload <https://todos.always17.com>. **Connect Claude Code** now appears in the footer.

The Mac app copies `public/` when it's built, so it picks this up the next time you build or release it (Part 7).

---

## Part 5: The Claude Code plugin

On each machine where you run Claude Code (it needs Node 18 or later):

1. In Claude Code:
   ```
   /plugin marketplace add NeelkanthTandel/todos
   /plugin install todos@todos
   ```
   This reads `.claude-plugin/marketplace.json` from `main`, so do it after PR #6 is merged.
2. On your board, click **Connect Claude Code** in the footer. Copy the `/todos:connect <code>` command it shows, and run it in Claude Code on that machine. The dialog then says Claude Code is connected and lists the machine with a **Disconnect** button.
3. **Try it:** start a new Claude Code session and type a prompt. A card appears in the **Claude sessions** strip above the lanes within a second or two. Press `Enter` to add it to Boiling over; its badge then follows the session (Running → Your turn → Ended).

- **Cloud sessions** start from a fresh container, so set the environment variable `TODOS_CONNECTION=<code>` in the cloud environment's settings instead (the code is the part after `/todos:connect `).
- **Opting out:** a `.todos-ignore` file in a project's root (nothing is sent for that project), `TODOS_DISABLE=1` (nothing at all), or `/todos:disconnect` on that machine. **Disconnect** on the board revokes a machine for good.
- The connection is saved in `~/.config/todos/connection.json` (mode 600). The code contains your board's key, so treat it like a password.

---

## Part 6: Trying live sharing and device sync

**These aren't built yet** (no branches exist at the time of writing). The steps below follow the plans (`docs/plans/02-live-sharing.md`, `03-device-sync.md`); check each PR's description for the final wording.

**Live sharing (milestone 2)**

1. On your board: **Export** › **Share live link…**. Enter your name, choose what to include, then **Create link** › **Copy link**.
2. Open the link in a private window, or send it to your phone. You should see "<your name>'s todos", clearly marked as someone else's board.
3. Change something on your board. It appears in the viewer within about a second.
4. In the viewer, try to edit, tick, drag, delete, use shortcuts, paste into the composer or Import. **None of it may change the shared board**: shared todos are always read-only for the viewer. Copying items into the viewer's own list is the only write allowed.
5. **Export** › **Shared links** › **Stop sharing**. The viewer shows that sharing stopped.

**Device sync (milestone 3)**

1. On device A: **Sync across devices** › turn it on. It shows a pairing code (and a QR code).
2. On device B (another browser, your phone, or the Mac app): enter the code. If B already has todos, choose **Merge both lists**.
3. Edit on one device; the change shows up on the other. Go offline, edit on both, reconnect, and check that both edits survive.
4. **Unlink** a device from the list and check it stops receiving changes.

This is also how the Mac app's list and your browser's list become one; by default they're separate.

---

## Part 7: The Mac app

**Build and try it locally** (Xcode 16 or later):

```bash
cd mac
make test
make app
open build/Todos.app
```

Press `⌥ Space` (Option+Space) to hide the window, and press it again to bring it back. Todos takes over that shortcut system-wide while it runs.

**Publish a release** (after the Mac app PR is merged):

```bash
git switch main
git pull
git tag mac-v1.0.0
git push origin mac-v1.0.0
```

`.github/workflows/mac-release.yml` builds a universal app, packs `Todos.dmg` and publishes a GitHub Release with first-launch instructions. The app is signed ad hoc, not notarized, so macOS asks once: **System Settings › Privacy & Security › Open Anyway**. Consider a tag ruleset for `mac-v*` (like Recess's `v*`) so only you can start a release.

---

## Final checklist

- [ ] Cloudflare account, with a workers.dev subdomain chosen
- [ ] `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repo secrets added
- [ ] PR #6 merged; **Relay** workflow green; the relay's address answers "Todos relay…"
- [ ] `relayBase` + CSP PR merged; **Connect Claude Code** shows on the site
- [ ] Plugin installed and connected on each machine; a new session shows up in the tray
- [ ] Milestones 2 and 3 merged, and sharing and sync tried as in Part 6 (when built)
- [ ] Mac app PR rebased onto `main` after milestones 2 and 3, merged, and `mac-v1.0.0` tagged
- [ ] Optional: a tag ruleset for `mac-v*`

## Common failures

| What you see | Cause | Fix |
| --- | --- | --- |
| Relay workflow: "Add the CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID repo secrets…" | A secret is missing or misnamed | Part 2, then **Run workflow** |
| Deploy: "You need to register a workers.dev subdomain" | Step 1.2 was skipped | Choose a subdomain, re-run the workflow |
| Deploy: "Authentication error [code: 10000]" | Token for the wrong account, or missing permissions | Recreate the token from the template (1.4), with your account included; update the secret |
| Deploy mentions `ratelimits` / the rate limiting binding | The binding isn't available to the account (unverified on the free plan) | Ask for a PR that drops the `[[ratelimits]]` block from `relay/wrangler.toml` and marks `CREATE_LIMIT` optional in the types; `src/index.ts` already skips the limit when the binding is absent |
| No **Connect Claude Code** button | `relayBase` is empty, or Pages hasn't redeployed | Part 4; hard-reload the site |
| Console: "Refused to connect … because it violates the Content Security Policy" | The CSP is missing the relay's `https://` or `wss://` origin | Add both to `connect-src` (Part 4) |
| Relay returns `403 Origin not allowed` | The page's origin isn't in `ALLOWED_ORIGINS` (a fork, a custom domain, or the Mac app before its PR is merged and the relay redeployed) | Add the origin to `ALLOWED_ORIGINS` in `relay/wrangler.toml` through a PR |
| Relay returns `429` | Too many writes (2 per second per channel) or new channels (10 a minute per IP), or the daily free limit | Wait; the daily limit resets at 00:00 UTC |
| Claude Code sends nothing | Node older than 18, not connected, `.todos-ignore` in the project, or `TODOS_DISABLE=1` | Check `~/.config/todos/connection.json` exists; run `/todos:connect` again |
| Mac app: "can't be opened" / "can't verify" | It isn't notarized | **System Settings › Privacy & Security › Open Anyway**, once |
| Mac app: `⌥ Space` does nothing | Another app registered Option+Space first | Quit that app (or change its shortcut), then quit and reopen Todos |
