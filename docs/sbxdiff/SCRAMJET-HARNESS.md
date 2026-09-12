# The scramjet-side harness

Runs one page twice — once in bare Chromium, once inside scramjet — under the
patched binary, and diffs what the guest observed.

```sh
pnpm runway sbxdiff              # run, print the report, exit 1 on a new bucket
pnpm runway sbxdiff --baseline   # record the current buckets as expected
pnpm runway sbxdiff --page x.html
node --experimental-strip-types src/sbxdiff/serve.ts   # servers only, for poking by hand
```

Four servers, all from runway: the site under test (4510), the scramjet harness
(4500), its wisp server (4501), and the bare harness (4502). Both harnesses put
the target in `#testframe`, so the layout noise class the plan's §11 describes
never arises.

## Driving without CDP

Both harness pages take their target from `location.hash`:

```
http://localhost:4502/#http%3A%2F%2Flocalhost%3A4510%2Fprobe.html
```

That is the whole driver. No Playwright, no `Runtime.enable`, no
`navigator.webdriver` — a DevTools session is page-observable and would inject a
`chrome://headless/` realm into every trace. `--sbxdiff-run` ends the run.

## The layer that decides: guest observations, not binding calls

**This is the part that matters.** In the sandbox the shim and the guest share
one realm and one binding stream, so a _binding-layer_ value is not a
guest-observable value. scramjet's traps hand the guest a rewritten answer while
the native underneath legitimately reports the proxied URL.

Read the binding layer as guest-observable and you get this:

```
T0  leak  Location.href.get   sandbox: "http://localhost:4500/~/sj/…/probe.html"
T0  leak  Document.URL.get    sandbox: "http://localhost:4500/~/sj/…/probe.html"
T0  leak  HTMLImageElement.src.get …
```

Eight T0 "leaks", **all false**. That is the native reporting the truth about a
page that really is served from a proxied URL; the guest never saw any of it.

So the probe pages funnel every fact they observe through a sink:

```js
const say = (k, v) => {
	document.title = k + "=" + String(v);
};
```

Whatever reaches `Document.title.set` is by construction what the _guest_
computed. Those are compared **by key, not by position**, so a missing
observation reports as itself instead of shifting everything after it. With that
change the same run gives one T0 — a real one:

```
T0  leak  guest:stack  [proxy-url-leak]
    oracle :     at http://localhost:4510/probe.html:68:11
    sandbox:     at http://localhost:4500/~/sj/…/probe.html:69:11
```

Error stacks leak the proxy URL to guest code. runway's adversarial suite
asserts exactly this (`tests/adversarial/platform-apis.ts:295`), independently.

Binding-layer divergences are still reported, at **T2**, as context. Promoting
them needs guest-op brackets from the shim so the tracer can tell guest code
from shim code (plan §P6). Until that exists, the binding layer cannot produce a
verdict, and the differ does not let it.

## Baseline, and what counts as a regression

A clean run produces ~1191 divergences in 264 buckets — almost all of it
scramjet doing its job. `--baseline` records the non-T0 buckets; after that only
**new** buckets are reported.

Measured floor, two consecutive clean runs:

```
run1:  1191 divergence(s), 1 bucket(s) not in the baseline, 1 T0 leak(s).
run2:  1191 divergence(s), 1 bucket(s) not in the baseline, 1 T0 leak(s).
```

Byte-stable, and the one remaining bucket is the stack leak, which is never
baselined because **T0 is never suppressible**.

Buckets key on `(tier, kind, api, diffClass)`. `diffClass` is a _classifier_: it
runs strictly after literal comparison has already failed and only chooses a
bucket name. The bucketer takes a `Divergence`, never two `Value`s, so
"literal, not normalized" survives contact with triage.

### The limitation this creates

An API that already diverges has a bucket. Make it diverge _differently_ and it
lands in the same bucket, so it does not surface as new. That is what a baseline
is for, and it is also a blind spot: a regression in an API that is already on
the known-boundary list is invisible. Regression targets must be APIs that
currently **agree** — see R3 below, which had to move off `document.referrer`
for exactly this reason.

## Does it catch regressions?

Three fixes were reverted in scramjet, rebuilt, and run against the same
baseline. Nothing tells the differ what was broken.

| Regression                        | Edit                                                    | Caught                   |
| --------------------------------- | ------------------------------------------------------- | ------------------------ |
| **R1** URL reflection             | `element.ts`: stop un-rewriting `href`/`src` components | **3 T0**, 4 new buckets  |
| **R2** fake `Location`            | `location.ts`: return the real `self.location[prop]`    | **6 T0**, 12 new buckets |
| **R3** wrong port, no leak marker | `location.ts`: `location.port` returns `"9999"`         | **1 new T1 bucket**      |

```
R1  T0 leak guest:link.host      oracle: localhost:4510   sandbox: localhost:4500
    T0 leak guest:link.pathname  oracle: /page2.html      sandbox: /~/sj/…/page2.html%3Fq%3D1
R2  T0 leak guest:location.href  oracle: http://localhost:4510/probe.html
                                 sandbox: http://localhost:4500/~/sj/…/probe.html
    T0 leak guest:location.origin, .host, .pathname, guest:url.abs
R3  T1 value-divergence guest:location.port   oracle: 4510   sandbox: 9999
```

**R3 is the one that proves the design.** `"9999"` contains no proxy prefix, no
chrome origin, no shim identifier — nothing to grep for. It is caught because
the differ compares values, not because it pattern-matches leaks.

R1 caught `link.host` and `link.pathname` but not `link.href`: `href` is handled
by a separate code path (`element.ts:147`, "note that href is not here"), which
that edit did not touch. The differ named the affected properties exactly.

A clean rebuild afterwards returned to `1191 / 1 bucket`, confirming the edits
reverted and the floor is reproducible.

## Virtual time is off, and has to be

`--sbxdiff-initial-time` / `--sbxdiff-virtual-time-budget` are **not** passed.
With virtual time on, scramjet never initialises: the harness never navigates
the testframe and no guest realm is created at all.

Measured at budget 4000, budget 30000, and no budget — so this is not a
budget-size problem. Enabling virtual time breaks service-worker startup, which
the sandbox depends on and the bare harness does not.

Both sides therefore run on the real clock. That keeps the runs **symmetric**,
which matters more here than pinning the clock: a virtual-time run diffed
against a real-time run would diverge on every timing-derived value.
`--sbxdiff-run-key` still pins randomness. Fixing this properly means making
virtual time cover the service worker thread — see RULES.md #12, which already
says virtual time must be enabled on exactly one thread.

## Known harness asymmetry

The two harnesses are served from different origins (4502 and 4500) because
both servers are up at once, so `document.referrer` differs by construction. It
is in the baseline, and it is a harness artifact rather than a scramjet finding.
Serving both harnesses from one origin across sequential runs would remove it.

## Files

| File                        | What                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `src/sbxdiff/trace.ts`      | `.sbxd` decoder. Cross-checked against `tools/sbxdiff/sbxread.py` on 18 traces / 441k records |
| `src/sbxdiff/diff.ts`       | guest-observation layer, binding layer, bijection + novelty, tiers, buckets                   |
| `src/sbxdiff/run.ts`        | launches the patched binary, loads and merges per-thread traces                               |
| `src/sbxdiff/index.ts`      | the driver                                                                                    |
| `src/sbxdiff/serve.ts`      | servers only, for manual inspection                                                           |
| `src/sbxdiff/regress.sh`    | the regression suite above                                                                    |
| `src/sbxdiff/pages/`        | probe pages                                                                                   |
| `src/sbxdiff/baseline.json` | expected buckets                                                                              |

## What is not built yet

- **Guest/shim attribution.** The single biggest gap; it is what would let the
  binding layer produce a verdict instead of context.
- **Object identity across the boundary.** The bijection and novelty bit are
  implemented and run on the binding layer, but without attribution their output
  is context too.
- **Network replay in the sandbox run.** The Chromium side supports it; the
  sandbox fetches through wisp, so the store would need proxy-URL normalization
  (`--sbxdiff-url-normalize`, see `DETERMINISM.md` §6).
- **`known_boundaries.json` keyed to runway's 257 expected-failing tests.**
  `baseline.json` is the mechanism; mapping buckets to the tests that document
  them is not done.
