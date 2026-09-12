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
  # --no-virtual-time for the recording: determinism does not matter here (we
  # only want the bytes), and the challenge is the fragile part -- do not give
  # it a pinned clock to notice on the one run that has to succeed.
  cd "$RUNWAY" && pnpm sbxdiff \
    --url "$URL" --headed --no-virtual-time \
    --click-frame challenges.cloudflare.com --click 22,32,4000,8,3000 \
    --store-out "$STORE"
  ;;
diff)
  [ -d "$STORE" ] || { echo "no store at $STORE -- run './rym.sh record' first" >&2; exit 1; }
  # Headed and clicking, same as the recording: the store now holds the whole
  # journey (challenge at ordinal 0, real page at ordinal 1), and getting from
  # one to the other means actually passing the challenge -- on BOTH sides.
  # That is the point: if a user can hit this path, the sandbox has to survive
  # it too.
  cd "$RUNWAY" && pnpm sbxdiff --url "$URL" --store "$STORE" --headed \
    --click-frame challenges.cloudflare.com --click 22,32,4000,8,3000
  ;;
*)
  echo "usage: $0 [record|diff]" >&2; exit 2;;
esac
