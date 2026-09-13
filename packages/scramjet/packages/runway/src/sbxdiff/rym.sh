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
#   ./rym.sh baseline    # re-record the accepted-divergence baseline
#   ./rym.sh noise       # re-record the self-check noise floor
#   ./rym.sh probe <url-substring> <probe.js>
#                        # same diff, against a COPY of the store with a line of
#                        # JavaScript prepended to one recorded response
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
RUNWAY="$(cd "$HERE/../.." && pwd)"
STORE="${SBXDIFF_RYM_STORE:-$HERE/.traces/rym-store}"
URL="${SBXDIFF_RYM_URL:-https://rateyourmusic.com/}"

# The click targets the Turnstile iframe's own widget, with repeats because it
# is not interactive the instant the page settles.
# SBXDIFF_RYM_CLICK overrides the schedule, because the first click's delay is a
# guess and the two sides are not equally ready at the same instant.
#
# 4000 ms was that guess, and it was wrong in a way that cost 2750 ms of clock:
# the oracle's widget takes the first click, the sandbox's is not interactive
# yet and needs the 3000 ms retry, and Cloudflare's 550 ms poll -- which is what
# advances the logical clock -- runs five extra rounds waiting (RULES.md #107).
#
# Swept twice, as the gap between the two sides' `ts` field.
#
# The first sweep was taken while a timer's due was read from the clock itself,
# so the gap wandered and nothing could be chosen against it:
#
#      4000  +3150 ms      8000  -500 ms
#      7000    +50 ms      9000  -200 ms
#                         10000   -50 ms
#
# Chaining the dues (RULES.md #113) made the clock a function of the timer tree
# instead of the scheduler, and the gap became a whole number of Cloudflare's
# 550 ms poll rounds -- stable, and therefore aimable:
#
#      5500   0 ms      6000   0 ms      6500   0 ms      7000  -550 ms
#
# 6000 is the middle of that plateau. Three delays agreeing is what makes this a
# choice rather than a fit; one value landing on zero is what RULES.md #112
# records believing.
CLICK=(--click-frame challenges.cloudflare.com
       --click "${SBXDIFF_RYM_CLICK:-22,32,6000,10,3000}")
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
# NEITHER side gets virtual time, and the clock both of them read is the LOGICAL
# one: it advances when a GUEST timer fires, by that timer's delay.
#
# Virtual time was the oracle's only way to be reproducible, and the sandbox
# could never have it -- fencing the scheduler stops the service worker the
# sandbox's loads depend on (RULES.md #81). That asymmetry was the root of
# everything left: the two sides' `Date.now()` drifted eight seconds apart and
# put different timestamps in URLs and request bodies (#98).
#
# The logical clock removes the asymmetry instead of working around it. Measured
# against two oracle runs of this recipe: 326960 records against 326961, which
# is reproducibility without virtual time at all.
REPLAY=(--no-virtual-time both --grace 45000)
export SBXDIFF_LOGICAL_CLOCK="${SBXDIFF_LOGICAL_CLOCK:-1}"
# The virtual clock does not only advance to times the page asked for: wake-ups
# already scheduled when it was enabled carry REAL-clock times, at an arbitrary
# sub-millisecond offset that differs every run, and everything downstream
# inherits it. Snapping advances to a 1 ms grid took two oracle runs of this
# recipe from 7 divergences to 0. Exported rather than passed, because it is
# read in the renderer by auto_advancing_virtual_time_domain.cc, not parsed
# from the command line (FLAGS.md, "Environment variables").
# Only matters if virtual time is turned back on by hand; the recipe no longer
# uses it. Kept because `--no-virtual-time both` is a choice this file makes,
# not a property of the harness.
export SBXDIFF_VT_QUANTUM_US="${SBXDIFF_VT_QUANTUM_US:-1000}"
# Cloudflare's challenge worker measures the machine:
# `while (performance.now() - start < 100) { digest(...) }`, reporting the
# iteration count. That is a hardware fingerprint and no amount of pinning a
# real clock fixes it -- measured, 5700 in the oracle against 6496 in the
# sandbox, with the sandbox also OVERRUNNING the 100 ms window the oracle lands
# on exactly. Answering now() from a per-realm counter makes the loop a pure
# function of the clock sequence, so it runs exactly 100 ms / step iterations
# wherever it runs: 5000 against 5000. The loop compares a DIFFERENCE, so a
# shim reading the clock a few extra times shifts both ends and cancels.
export SBXDIFF_OBSERVABLE_STEP_US="${SBXDIFF_OBSERVABLE_STEP_US:-20}"

# The harness serves scramjet out of `packages/core/dist`, not out of `src`.
# Nothing in the diff path rebuilt it, so a source change that was never built
# was measured as "no divergence" -- the strongest result the differ can report,
# and a lie (RULES.md #146).
#
# Only when something is actually newer than the bundle. `pnpm build` is a full
# production rspack build of the whole workspace and takes about thirty minutes
# here; running it unconditionally turned `./rym.sh diff` from a three-minute
# command into a half-hour one, which is its own way of making the differ
# useless. SBXDIFF_NO_BUILD=1 skips the check entirely.
ROOT="$(cd "$RUNWAY/../../../.." && pwd)"
BUNDLE="$ROOT/packages/scramjet/packages/core/dist/scramjet.js"
if [ -z "${SBXDIFF_NO_BUILD:-}" ]; then
  stale=1
  if [ -f "$BUNDLE" ]; then
    # -quit on the first hit, so this is a walk that stops rather than a full
    # scan of the workspace.
    stale="$(find "$ROOT/packages/scramjet/packages" \
               -name node_modules -prune -o -name dist -prune -o \
               -name '*.ts' -newer "$BUNDLE" -print -quit 2>/dev/null)"
  fi
  if [ -n "$stale" ]; then
    echo "  scramjet sources are newer than the bundle -- building (slow)" >&2
    ( cd "$ROOT" && pnpm build ) >/dev/null 2>&1 || {
      echo "scramjet build failed -- rerun 'pnpm build' at the repo root to see why" >&2
      exit 1
    }
  fi
fi

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
  # Anything after `diff` is forwarded, so `./rym.sh diff --strict-bodies` is a
  # thing without editing this file.
  cd "$RUNWAY" && pnpm sbxdiff --url "$URL" --store "$STORE" --headed \
    "${REPLAY[@]}" "${CLICK[@]}" "${@:2}"
  ;;
self-check)
  # Extra arguments forwarded, the same way `diff` forwards them: `self-check
  # --baseline` reads as "record the noise floor" and silently did nothing.
  cd "$RUNWAY" && pnpm sbxdiff --url "$URL" --store "$STORE" --self-check \
    --headed "${REPLAY[@]}" "${CLICK[@]}" "${@:2}"
  ;;
baseline)
  # Three runs, unioned over T2 and below: one run only samples the API
  # surface the page happens to touch, and the shim-attributed buckets come
  # and go with it. T1 is not inherited -- see index.ts.
  for _ in 1 2 3; do
    ( cd "$RUNWAY" && pnpm sbxdiff --url "$URL" --store "$STORE" --baseline \
        --headed "${REPLAY[@]}" "${CLICK[@]}" ) | grep "baseline bucket"
  done
  ;;
noise)
  # Three runs, unioned: one run only samples the noise.
  for _ in 1 2 3; do
    ( cd "$RUNWAY" && pnpm sbxdiff --url "$URL" --store "$STORE" --self-check \
        --baseline --headed "${REPLAY[@]}" "${CLICK[@]}" ) | grep "noise bucket"
  done
  ;;
probe)
  # Plant a probe in a recorded response and run the diff against the copy.
  #
  # Both sides replay the same store, so a probe planted in a recorded script
  # runs on BOTH of them, inside the same script, at the same point in that
  # script's execution -- which is the one thing no amount of reasoning about
  # two separate runs can give you. It answered rule 100 in a single run after
  # three rounds of plausible explanations had all been wrong.
  #
  # The report from this run means nothing on its own: the patched body changes
  # every request that follows it. Read the probe's own values out of the
  # traces, not the bucket count.
  [ -n "${2:-}" ] && [ -n "${3:-}" ] || {
    echo "usage: $0 probe <url-substring> <probe.js>" >&2; exit 2; }
  PROBED="$STORE-probed"
  node --experimental-strip-types --no-warnings "$HERE/probestore.ts" \
    "$STORE" "$PROBED" "$2" "$3" || exit 1
  cd "$RUNWAY" && pnpm sbxdiff --url "$URL" --store "$PROBED" --headed \
    "${REPLAY[@]}" "${CLICK[@]}"
  ;;
*)
  echo "usage: $0 [record|diff|self-check|noise|probe]" >&2; exit 2;;
esac
