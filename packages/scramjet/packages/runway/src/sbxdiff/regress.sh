#!/bin/bash
# Regression test: break a fix in scramjet, confirm the differ notices.
#
# The point is that NOTHING tells the differ what was broken. It is given the
# same probe page and the same baseline as a clean run; a regression has to show
# up as buckets that were not in the baseline. That is the difference between an
# oracle and a test suite.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../../../../../.." && pwd)"
RUNWAY="$ROOT/packages/scramjet/packages/runway"
SRC="$ROOT/packages/scramjet/packages/core/src"
OUT="${SBXDIFF_OUT:-/tmp/sbxdiff-regress}"
mkdir -p "$OUT"

apply() { # file, search, replace
  python3 - "$1" "$2" "$3" <<'PY'
import sys
p, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p).read()
if a not in s:
    print("ANCHOR NOT FOUND in", p); sys.exit(1)
open(p, "w").write(s.replace(a, b, 1))
PY
}

run_case() { # name, file, search, replace
  local name="$1" file="$2" search="$3" replace="$4"
  echo ""
  echo "=================================================================="
  echo "  REGRESSION: $name"
  echo "=================================================================="
  cp "$SRC/$file" "$OUT/$name.bak"
  if ! apply "$SRC/$file" "$search" "$replace"; then
    echo "  SKIPPED (anchor missing)"; return 1
  fi
  local before after
  before=$(md5 -q "$ROOT/packages/scramjet/packages/core/dist/scramjet.js")
  ( cd "$ROOT" && pnpm build >"$OUT/$name.build.log" 2>&1 )
  after=$(md5 -q "$ROOT/packages/scramjet/packages/core/dist/scramjet.js")
  # Do not trust the build's exit status (RULES.md #15) and do not trust that
  # it ran at all: if the bundle is byte-identical the edit never landed, and
  # the "regression" run would silently be a clean run.
  if [ "$before" = "$after" ]; then
    echo "  BUILD DID NOT CHANGE THE BUNDLE -- edit did not take effect"
    cp "$OUT/$name.bak" "$SRC/$file"; return 1
  fi
  ( cd "$RUNWAY" && pnpm sbxdiff >"$OUT/$name.txt" 2>&1 )
  cp "$OUT/$name.bak" "$SRC/$file"
  echo ""
  sed -n '/^T0  (/,/^T2  (/p' "$OUT/$name.txt" | grep -v '^T2' | head -40
  tail -2 "$OUT/$name.txt" | head -1
}

# R1 -- element URL reflection stops un-rewriting, so `img.src` / `a.href`
#       hand the guest the proxied URL.
run_case url-reflection client/dom/element.ts \
  'const url = new URL(unrewriteUrl(href, client.context));' \
  'const url = new URL(href);'

# R2 -- the fake Location returns the real one, so `location.href` and every
#       component of it leak.
run_case location-getter client/location.ts \
  'return client.url[prop];' \
  'return self.location[prop];'

# R3 -- a NON-leak regression: a wrong value containing no marker at all.
#       Proves the differ compares values rather than grepping for the prefix.
#
#       It has to target an API that currently AGREES. Buckets key on
#       (tier, kind, api, class), so making an already-diverging value diverge
#       differently reuses the same bucket and would not surface as new --
#       which is the point of a baseline, but makes it a useless test target.
run_case port-value client/location.ts \
  '					return client.url[prop];' \
  '					if (prop === "port") return "9999";
					return client.url[prop];'

echo ""
echo "=================================================================="
echo "  Rebuilding clean"
( cd "$ROOT" && pnpm build >"$OUT/clean.build.log" 2>&1 )
( cd "$RUNWAY" && pnpm sbxdiff >"$OUT/clean.txt" 2>&1 )
tail -2 "$OUT/clean.txt" | head -1
