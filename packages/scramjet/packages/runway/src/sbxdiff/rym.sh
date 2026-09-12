#!/bin/bash
# The rateyourmusic recipe.
#
# scramjet cannot load rym on its own -- Cloudflare 403s the proxy's upstream
# fetch, and sometimes serves a challenge page instead. So the oracle records a
# run that DOES pass the challenge, and the sandbox replays it through
# SbxdiffTransport, never contacting the site at all.
#
#   ./rym.sh record    # headed, passes Turnstile, fills the store (slow)
#   ./rym.sh diff      # both sides from that store
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
RUNWAY="$(cd "$HERE/../.." && pwd)"
STORE="${SBXDIFF_RYM_STORE:-$HERE/.traces/rym-store}"
URL="${SBXDIFF_RYM_URL:-https://rateyourmusic.com/}"

case "${1:-diff}" in
record)
  # Headed: the challenge is never passed headless, for stock Chromium either.
  # The click targets the Turnstile iframe's own widget, with repeats because
  # it is not interactive the instant the page settles.
  rm -rf "$STORE"
  cd "$RUNWAY" && pnpm sbxdiff \
    --url "$URL" --headed \
    --click-frame challenges.cloudflare.com --click 22,32,4000,8,3000 \
    --store-out "$STORE"
  ;;
diff)
  [ -d "$STORE" ] || { echo "no store at $STORE -- run './rym.sh record' first" >&2; exit 1; }
  cd "$RUNWAY" && pnpm sbxdiff --url "$URL" --store "$STORE" --virtual-time
  ;;
*)
  echo "usage: $0 [record|diff]" >&2; exit 2;;
esac
