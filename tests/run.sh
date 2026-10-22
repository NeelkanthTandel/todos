#!/usr/bin/env bash
# Runs tests/smoke.html in headless Chrome and fails if any check fails.
# Needs python3 and a Chromium-based browser (set CHROME=/path/to/browser to pick one;
# CHROME_FLAGS adds flags, e.g. CHROME_FLAGS=--no-sandbox when running as root in a container).
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-8765}"

if [[ -z "${CHROME:-}" ]]; then
  for c in google-chrome google-chrome-stable chromium chromium-browser \
           "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"; do
    if command -v "$c" >/dev/null 2>&1 || [[ -x "$c" ]]; then CHROME="$c"; break; fi
  done
fi
[[ -n "${CHROME:-}" ]] || { echo "No Chrome/Chromium found. Set CHROME=/path/to/browser." >&2; exit 2; }

python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER=$!
PROFILE="$(mktemp -d)"
trap 'kill $SERVER 2>/dev/null || true; rm -rf "$PROFILE"' EXIT
for _ in $(seq 1 50); do curl -fs "http://127.0.0.1:$PORT/" >/dev/null && break; sleep 0.1; done

# shellcheck disable=SC2086
OUT="$("$CHROME" ${CHROME_FLAGS:-} --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --user-data-dir="$PROFILE" --window-size=1400,900 --virtual-time-budget=15000 \
  --dump-dom "http://127.0.0.1:$PORT/tests/smoke.html" 2>/dev/null)"

# Print the check list as plain text.
echo "$OUT" | grep -o '<li class="[a-z]*">[^<]*</li>' | sed 's/<[^>]*>//g; s/&lt;/</g; s/&gt;/>/g; s/&quot;/"/g; s/&amp;/\&/g'
RESULT="$(echo "$OUT" | sed -n 's:.*<pre id="result">\([^<]*\)</pre>.*:\1:p')"
echo "${RESULT:-NO RESULT}"
[[ "$RESULT" == PASS* ]]
