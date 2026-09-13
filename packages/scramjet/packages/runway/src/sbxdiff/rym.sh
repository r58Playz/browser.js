#!/bin/bash
# The rateyourmusic recipe.
#
# rym sits behind a Cloudflare managed challenge, so it is the hardest thing
# sbxdiff has to handle and the reason the store grew HTTP status and headers.
# The recorded journey is: 403 challenge, 403 challenge again (Critical-CH makes
# Chromium restart the navigation and throw the first one away), Turnstile,
# 200 real page. All four steps replay.
#
#   ./rym.sh record      # headed, passes Turnstile, fills the store (slow)
#   ./rym.sh diff        # oracle vs sandbox, both from that store
#   ./rym.sh self-check  # oracle vs a SECOND oracle: how reproducible is it?
#   ./rym.sh noise       # re-record the self-check noise floor
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
RUNWAY="$(cd "$HERE/../.." && pwd)"
STORE="${SBXDIFF_RYM_STORE:-$HERE/.traces/rym-store}"
URL="${SBXDIFF_RYM_URL:-https://rateyourmusic.com/}"

# The click targets the Turnstile iframe's own widget, with repeats because it
# is not interactive the instant the page settles.
CLICK=(--click-frame challenges.cloudflare.com --click 22,32,4000,12,3000)
# --vt-fence oracle: Chromium's own fencing, so the page cannot run while the
#   clock is frozen. The ORACLE only: a sandbox's loads are served by a service
#   worker that delegates back to the client page, so fencing the page stops the
#   work that would release the pause (RULES.md #40).
# --no-virtual-time sandbox: the oracle needs virtual time and the sandbox
#   cannot have it. Under kDeterministicLoading the Turnstile widget's frame
#   never starts its blocking <script src> at all -- it sits at readyState
#   "loading" with 83 bytes of DOM for the whole run (RULES.md #59).
# --vt-budget 600000: the challenge and the real page each re-arm the budget;
#   the default 30 s runs out mid-challenge.
# --grace 45000: with the sandbox on a real clock, Turnstile's own timers are
#   real seconds, and everything after the challenge happens at real speed too.
#   The default 3 s ends the run mid-challenge; 20 s ended it on top of
#   Cloudflare's JS-detections frame, which was still working at 99.5% of the
#   run while the oracle's finished at 18% of its own (virtual time compresses
#   the whole journey). A run that stops early reports the requests it did not
#   reach as divergences.
REPLAY=(--vt-fence oracle --no-virtual-time sandbox --vt-budget 600000 --grace 45000)

case "${1:-diff}" in
record)
  # Headed: the challenge is never passed headless, for stock Chromium either.
  # --no-virtual-time for the recording: determinism does not matter here (we
  # only want the bytes), and the challenge is the fragile part -- do not give
  # it a pinned clock to notice on the one run that has to succeed.
  rm -rf "$STORE"
  cd "$RUNWAY" && pnpm sbxdiff \
    --url "$URL" --headed --no-virtual-time "${CLICK[@]}" \
    --store-out "$STORE"
  ;;
diff)
  [ -d "$STORE" ] || { echo "no store at $STORE -- run './rym.sh record' first" >&2; exit 1; }
  # Headed and clicking, same as the recording: the store holds the whole
  # journey and getting from the challenge to the real page means actually
  # passing it -- on BOTH sides. That is the point: if a user can hit this
  # path, the sandbox has to survive it too.
  cd "$RUNWAY" && pnpm sbxdiff --url "$URL" --store "$STORE" --headed \
    "${REPLAY[@]}" "${CLICK[@]}"
  ;;
self-check)
  cd "$RUNWAY" && pnpm sbxdiff --url "$URL" --store "$STORE" --self-check \
    --headed "${REPLAY[@]}" "${CLICK[@]}"
  ;;
noise)
  # Three runs, unioned: one run only samples the noise.
  for _ in 1 2 3; do
    ( cd "$RUNWAY" && pnpm sbxdiff --url "$URL" --store "$STORE" --self-check \
        --baseline --headed "${REPLAY[@]}" "${CLICK[@]}" ) | grep "noise bucket"
  done
  ;;
*)
  echo "usage: $0 [record|diff|self-check|noise]" >&2; exit 2;;
esac
