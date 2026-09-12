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
baselined because **T0 is never suppressible**. With attribution the baseline is
35 buckets; without it, 263.

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

## Script attribution

Every compared record carries two V8 script ids -- the script on top of the JS
stack and the script that entered the task -- and a `kScript` record maps ids to
URLs. The differ classifies each as guest or shim: in the oracle the guest is
the site's own origin, in the sandbox it is anything served under `/~/sj/`.
Everything else on the chrome origin (`scramjet.js`, the controller, the
transport, the harness page) is shim.

The **pair** carries the meaning:

| entry | top   | meaning                                | tier           |
| ----- | ----- | -------------------------------------- | -------------- |
| guest | guest | the guest called a native directly     | judged (T0/T1) |
| guest | shim  | the shim acting for the guest — a trap | T2             |
| shim  | shim  | the shim's own work                    | T4             |

Only the first row is guest-observable at the binding layer, and it is the row
the differ promotes: there is no trap in between whose return value could differ
from the native's. **This is what lets a real page be compared** — the probe
pages fake it with a cooperating `document.title` sink, and rateyourmusic does
not cooperate (measured: zero `Document.title.set` calls in a direct rym run).

Measured on the probe page:

|                                 | oracle    | sandbox |
| ------------------------------- | --------- | ------- |
| guest-direct binding calls      | 86 (100%) | 60      |
| shim                            | 0         | 1641    |
| unattributable (no JS on stack) | 0         | 9       |

96% of the sandbox's guest-realm binding calls are the shim. Separating them is
what takes **T2 from 259 buckets to 31**, and the baseline from **263 buckets to
35** — small enough for a person to actually read.

### Only the top frame is tested, and that is a correction

`entry_script` was designed to mean "whose work is this task". Measurement says
it does not: scramjet's controller enters essentially every task, so `entry` is
shim even for guest code. Requiring `entry == guest` classified **zero** sandbox
records as guest.

`top == guest` is the criterion that carries the meaning. At a native call the
topmost JS frame being guest code means no shim trap intervened — had scramjet
trapped that API, its trap would be the frame calling the native. Shim frames
_below_ the guest are expected: that is the shim having invoked guest code, an
event handler or a timer. `entry_script` is still recorded (it is free, captured
once per task) and still tells you which side started a task.

An empty script URL — an inline or `eval`'d script with no `sourceURL` — is
classified `unknown`, never guessed. In the sandbox scramjet rewrites the
guest's inline scripts, so guessing by realm would attribute shim-rewritten code
to the guest.

## Network: a store-backed scramjet transport

`SbxdiffTransport` (`harness/scramjet/public/sbxdiff-transport.js`) is a
`ProxyTransport` that serves every upstream request from the store the oracle
run recorded, via an endpoint on the site server. Enabled with
`?sbxdiffStore=<endpoint>` on the harness URL.

It has to be a transport rather than the Chromium-side `--sbxdiff-net-replay`,
for two independent reasons:

- **A URLLoader interceptor cannot see it.** Replay is installed at
  `WillCreateURLLoaderFactory`, but scramjet's egress is WebSocket frames to a
  wisp server, which never goes through a URLLoaderFactory. Measured: a scramjet
  rym run recorded 15 requests, all to the harness origin, where the direct run
  recorded 116 across the real CDNs.
- **It sees the real URL.** The transport is called with the upstream URL
  _before_ scramjet proxies it, so a store recorded by a direct run matches
  directly and no proxy-URL normalization is needed.

A miss is a 504 and is counted, never a live fetch. A non-GET is also reported
as a miss rather than served a GET's body, since the store keys on URL alone.
WebSockets are not replayable and fail loudly rather than opening a live socket.

## Virtual time: working, on by default

`pnpm runway sbxdiff` runs with a pinned clock under `kDeterministicLoading`.
`--no-virtual-time` opts out. Both sides get identical clock settings; the diff
result is the same either way (1191 / 1 bucket / 1 T0), so the baseline is valid
for both.

```
sandbox Date.now()   1700000000019  ×4,  ...020  ×1     (5 runs)
timer.delta          250 exactly,  every run
oracle  Date.now()   1700000000009,  every run
```

Reproducible to **~1 ms**, from 60–110 _seconds_ of drift before.

### Three bugs, found in this order

**1. An idle client pinned the shared clock.**
`ProcessTimeOverrideCoordinator::RegisterOverride` seeds a client at the current
tick and `MaybeFastForwardToWakeUp` returns early when a thread has no pending
wakeup, so a client that is _never_ ready still constrains the minimum. An idle
service worker froze the clock for every thread. Clients now release their
constraint when idle. Latent upstream; it only bites with more than one
participating thread, which is what joining the worker introduced. **Fixing it
alone changed nothing** — necessary, not sufficient.

**2. Inherited pausers deadlocked the clock permanently.**
Deferred enablement turns the clock on at a realm reached mid-load, so pausers
are already outstanding. Counting them stops virtual time instantly, and it
never restarts:

```
110516.788601  EnableVirtualTime, inherited pause_count=1
110516.788632  virtual time STOPPED at +0ms
   ... 30 seconds ...
110546.748156  virtual time RUNNING at +10ms      <- only at teardown
```

`EnableVirtualTime` now records a baseline and compares `pause_count > baseline`.
No-op wherever virtual time is enabled at startup, so stock CDP is untouched.

**3. Fencing assumed loads finish without the page.** This was the last one, and
the most interesting. `OnVirtualTimePaused` fences the frame's task queues,
which is safe when loads complete in the network process — the normal case, and
why stock virtual time works. It is **not** safe for a sandbox: the load is
served by a service worker that delegates back to the client _page_, so fencing
the page stops the very work that would release the pause.

With a deferred clock, pausing now stops the **clock** without fencing the
**queues**. Determinism still comes from the frozen clock; tasks running while
it is frozen is already normal for every queue whose `CanRunWhenVirtualTimePaused`
is true, loading queues included.

### How it was found

Logging _which_ pauser holds the clock, with a unique id and timestamps. Matching
by name is not enough — names repeat (`ResponseBody`, `PendingScript`), and a
still-held pauser is masked by a later balanced pair of the same name. That
mistake made an early run look like "all pausers balance", which is what sent
the investigation into two dead ends. With ids:

```
longest gap: 69.946s
pausers HELD across the gap:
  id=6089691360  http://localhost:4500/~/sj/…   <- proxied subresource
```

Kept as `VLOG(1)` behind the deferred-clock switch: a virtual-time deadlock has
no error message, so "which resource holds the lock" is the only usable signal.

### Dead ends, recorded because each cost a build

| Hypothesis                                                               | Disproved by                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| "breaks service-worker startup"                                          | console logging — the worker starts and the harness navigates |
| "the store transport fixes it by removing the WebSocket"                 | `deterministic` still yields no guest realm                   |
| "`advance` just needs a bigger budget"                                   | 2 records at budget 30000 _and_ 100000                        |
| "`CachedStorageArea` is the stuck pauser"                                | re-running showed no such event; it was run-specific          |
| "my harness's `sessionStorage.setItem`"                                  | removing it changed nothing                                   |
| "`kServiceWorkerClientMessage` / `kPostedMessage` need to be pause-safe" | no effect; reverted rather than shipped unverified            |

### Why `deterministic` and not `advance`

`advance` converts every idle moment into a clock jump. On the same binary it
drifts 54 / 60 / 54 / 80 s between runs and slipped an exact 250 ms timer to 249.

## Running against a real site (the rateyourmusic recipe)

```sh
pnpm runway sbxdiff --url https://rateyourmusic.com/ --headed \
  --click-frame challenges.cloudflare.com --click 22,32,4000,8,3000 \
  --virtual-time
```

The sandbox **never contacts the site**. The oracle run records every response
into the store; the sandbox's `SbxdiffTransport` serves them back. That is what
makes a real site usable at all here, because scramjet cannot load
rateyourmusic on its own: Cloudflare returns 403 to the proxy's upstream fetch
(sometimes a challenge page instead — not even consistent between runs).
Recording from a run that _does_ pass the challenge and replaying it sidesteps
the whole problem.

`--store <dir>` reuses a store instead of recording a new one, so the expensive
headed challenge-passing run happens once. When reused, the oracle replays it
too, so both sides see byte-identical input.

The store must be recorded through the **bare harness**, not a direct
navigation: `--sbxdiff-net-replay` blocks anything not in the store, and that
includes the harness's own assets.

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

- **Trap-layer comparison.** Attribution separates guest-direct calls from
  shim-mediated ones, but for a _trapped_ API the guest's answer is the trap's
  return value, which is not a binding call at all. Reading it needs guest-op
  brackets from the shim (plan P6). Attribution is necessary for this, not
  sufficient.
- ~~Virtual time~~ — done; see above. `Date.now()` reproducible to ~1 ms and
  timer deltas exact, on by default.
- **rateyourmusic itself.** scramjet cannot load it: Cloudflare returns 403 to
  the proxy's upstream fetch (sometimes a challenge page instead — not even
  consistent), and rym's own code crashes the shim with `Invalid value used as
weak map key` at `client/shared/event.ts:212`.
- **`known_boundaries.json` keyed to runway's 257 expected-failing tests.**
  `baseline.json` is the mechanism; mapping buckets to the tests that document
  them is not done.
