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

**Status: working, both sides.** The oracle replays the whole journey — two 403
challenge instances, Turnstile, and the 200 real page — with zero replay misses,
and so does the sandbox: scramjet passes the Cloudflare managed challenge under
replay and reaches the real page.

```sh
src/sbxdiff/rym.sh record      # once, headed, passes Turnstile
src/sbxdiff/rym.sh diff        # oracle vs sandbox from that store
src/sbxdiff/rym.sh self-check  # oracle vs a SECOND oracle
```

which is:

```sh
pnpm sbxdiff --url https://rateyourmusic.com/ --store <dir> --headed \
  --vt-fence oracle --no-virtual-time sandbox --vt-budget 600000 --grace 20000 \
  --click-frame challenges.cloudflare.com --click 22,32,4000,12,3000
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

### Recording the whole journey, not just the destination

The store keys on **URL + ordinal**, so the Nth request for a URL replays the
Nth recorded response. This matters more than it sounds: rateyourmusic serves a
Cloudflare challenge and then the real page at the _same_ URL. With a URL-only
key the second silently overwrote the first, so replay jumped straight to the
real page and the challenge never happened — a different user journey from the
one recorded, and a sandbox that could not survive the challenge would have
looked fine.

Recording also writes `sbxdiff-time-base.json`, and replay adopts that clock.
Recorded bytes are not timeless: a challenge embeds tokens minted at capture
time and compares them against the device clock, so replaying under an unrelated
constant makes the page reject its own challenge for having the wrong device
time.

### What it took to pass the challenge

Three defects, each alone enough to stop it. All three were invisible as
failures — the page just retried forever.

**Headers are content.** The store held `url \n mime \n encoding \n body` and
replay served everything as a synthetic `200 OK`. Cloudflare answers the first
navigation with `Critical-CH`, which makes Chromium **restart the navigation**;
the store therefore holds two different challenge instances at `/`, and only the
second one's `orchestrate`/`fo` endpoints were ever fetched. Without the restart
the replay handed the page the abandoned challenge and every endpoint missed.
Store format v2 carries `net::HttpResponseHeaders::raw_headers()` verbatim.

**Redirects were followed silently.** Only the final body of a chain was stored,
which loses the URL the page ends up at — and that URL is content: Cloudflare
bounces `/` to `/?__cf_chl_rt_tk=<token>` and the challenge script reads the
token out of `location`. 3xx responses are now records of their own and replay
emits real redirects.

**Two keying bugs.** Store keys had `__cf_chl_tk`/`__cf_chl_rt_tk` stripped, on
the theory that a token minted during recording could never be asked for again —
but the token is server-minted and lives in the recorded HTML, so replaying
those bytes asks for the same URL, and the stripping collapsed four distinct
steps onto one key. And the replay ordinal counter lived on the
`URLLoaderFactory`, so the Critical-CH restart got a fresh factory, reset to 0,
and re-served ordinal 0.

The store now looks like this:

```
403:5899, 403:6091, 200:402579  https://rateyourmusic.com/
301→//cdn.sonemic.net/2.5/img/sonemic.png   https://rateyourmusic.com/favicon.ico
302→/cdn-cgi/challenge-platform/h/g/scripts/jsd/330e41bb475c/main.js?
200:113760, 200:3660            …/challenge-platform/h/g/fo/…
```

and a replay run reports `oracle: 17 file(s), 394330 records` with **0 misses**
and `Welcome! - Rate Your Music` in the traces.

### How reproducible is the oracle? (`--self-check`)

`--self-check` replaces the sandbox with a **second oracle run** and diffs the
two. An oracle that cannot reproduce its own run cannot convict the sandbox of
anything, so this is the number that licenses every other number here.

On rateyourmusic: **0 T0 leaks**, 8 T1 buckets, ~220 T2 buckets per run, 345
unioned over three runs. The T1 list is all environmental randomness —
`PerformanceResourceTiming.*` (resource timing is real time even under virtual
time), `RTCIceCandidate.candidate` (random ufrag), `URL.createObjectURL` (random
blob UUIDs), `Window.setTimeout` (timer ids). The T2 bulk is
`identity-divergence`: the run is cut off by a 3 s **real-time** grace while the
page is still CPU-bound, so the two runs create different numbers of objects
(~400 k vs ~370 k records). Zero T0 is the part that matters: a guest-observable
leak is not something a flaky oracle can invent.

`rym.sh noise` records the floor into `src/sbxdiff/noise.<host>.json`, unioned
across runs. It is deliberately **not** `baseline.<host>.json`: a baselined
bucket is "known and accepted", a noisy one is "the oracle has nothing to say",
and merging them would hide real bugs behind noise with nothing in the output to
say so. Both files are per target host, because bucket keys are
`tier|kind|api|class` with no page in them — one shared `baseline.json` let a run
on rateyourmusic silently suppress 28 probe-page buckets.

### Flags that exist because of this

| Flag                       | Why                                                                                                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--vt-fence [side]`        | Restores Chromium's default of fencing task queues while virtual time is paused, for `oracle`, `sandbox` or `both` (default). The oracle needs it; the sandbox deadlocks with it (RULES.md #40, #51). Use `--vt-fence oracle` for rym. |
| `--no-virtual-time [side]` | Same shape. The oracle needs virtual time; the sandbox's late-created frames are starved by it (RULES.md #59). Use `--no-virtual-time sandbox` for rym.                                                                                |
| `--grace <ms>`             | Real-time grace after the page stops loading. A challenge running on a real clock needs seconds; the default 3 s ends the run mid-challenge.                                                                                           |
| `--vt-budget 600000`       | The challenge and the real page each re-arm the budget; the default 30 s runs out mid-challenge.                                                                                                                                       |
| `--self-check`             | Second oracle run in place of the sandbox. Measures the oracle's own noise floor.                                                                                                                                                      |
| `--soft-miss`              | A replay miss serves an empty 200 instead of `ERR_BLOCKED_BY_CLIENT`. Still logged and counted. No longer needed for rym, but useful when bringing up a new site.                                                                      |
| `--profile <dir>`          | Persistent user-data-dir. A challenge passed once stays passed via its clearance cookie.                                                                                                                                               |

### Getting the sandbox through the challenge

Five things, found in order, each one hiding the next.

**1. The fence was on both sides.** `--vt-fence` is what the oracle needs and
what the sandbox must never have: a sandbox's loads are served by a service
worker that delegates back to the client page, so fencing the page stops the
work that would release the pause. Applying it to both reintroduced that
deadlock, and it presented as "the orchestrate script is requested and never
executes", not as a hang. `--vt-fence` now takes a side: `--vt-fence oracle`.

**2. `this` was `undefined` and we took it literally.** WebIDL says "let esValue
be the this value, if it is not null or undefined, or realm's global object
otherwise", so a bare `addEventListener("x", fn)` is a listener on the global in
every engine. Cloudflare's challenge script makes exactly that call. Scramjet's
interceptor passed `undefined` through to its own bookkeeping, which used it as a
WeakMap key: `Uncaught TypeError: Invalid value used as weak map key`, a message
no engine produces there. Substituting the global in `attemptToCallHandler`
fixed it: 8 511 records → 33 810.

**3. The store refused POSTs.** The endpoint called non-GET an "honest miss"
while the Chromium-side replay answered any method from the same URL key.
Cloudflare POSTs to its `fo/` endpoint and the recording holds that response, so
this was a divergence the harness invented. 33 810 → 91 414 records, and the
Turnstile iframe started loading.

**4. Scramjet was spending the guest's randomness.** This is the interesting
one. Under a pinned PRNG the keystream is _shared_: V8 seeds `Math.random` per
native context from `--random-seed`, so the guest's Nth draw is a fixed value,
and Chromium's web-crypto keystream counter is per thread. Anything the sandbox
draws in the guest's realm shifts every value the guest afterwards sees.

| Drawn by                              | Draws                  | Fix                                                                            |
| ------------------------------------- | ---------------------- | ------------------------------------------------------------------------------ |
| `scramtag()` (wasm rewriter)          | 2585 `getRandomValues` | counter + FNV-1a of the context URL; tags need to be unique, not unpredictable |
| `libcurl/index.js` at module init     | 128 `getRandomValues`  | loaded on demand, only on the non-sbxdiff path                                 |
| `createFrameId()` (controller inject) | 8 `Math.random`        | counter on the parent document, prefixed with the parent's name                |
| `ScramjetClient.opaqueScope`          | 1 `Math.random`        | minted on first use; a document with a real origin never needs one             |

Turnstile derives its widget id from one of those draws, requests
`…/turnstile/f/av0/rch/<id>/…` and routes postMessages on it. The sandbox minted
`t0rxw`, then `c6t0r`, then — with all four removed — **`q7dlh`, the recording's
own id**. The run now replays with **zero store misses and zero near matches**.

**5. `postMessage` was delivering to the sender.** WebIDL substitutes the
_realm's_ global for a null `this`, and scramjet forwarded to the native as a
bare call — `Function("...args", "this(...args)")` invoked with the native as
`this`. So `otherWindow.postMessage(...)` silently delivered to the forwarder's
own window and a frame talking to its parent talked only to itself. Forwarding
with `fn.apply(receiver, args)` fixes it; the stolen-`Function` trick is for the
_incumbent_ realm, not the receiver. `msg.*` in `probe.html` is the case that
catches it.

**6. The widget's frame was starved by virtual time.** Under
`kDeterministicLoading` the Turnstile widget's frame never started its blocking
`<script src>` at all: it sat at `readyState: "loading"` with one script and
83 bytes of DOM for a whole 30 s run, while its `decodedBodySize` said all
972 750 bytes of the document had arrived. Turning virtual time off for the
sandbox alone — `--no-virtual-time sandbox` — makes the same frame run 44 000
records and spawn Turnstile's `blob:` workers. Not root-caused; see "What it
costs" below.

**7. The click never reached the widget.** `RenderFrameHost::GetView()` returns
the ROOT view for a subframe that shares its parent's process, so
`--sbxdiff-click-frame` was silently clicking (22,32) of the top-level page.
That is not a corner case for a sandbox, it is the norm: the oracle sees
`challenges.cloudflare.com` cross-origin and therefore out-of-process, with a
widget of its own, while a proxy serves every frame from one origin. The
oracle's widget realm received MouseEvents and the sandbox's received none —
which is why the sandbox could run the entire challenge and never finish it.
The runner now asks the frame for its offset from an **isolated world** (the
page shares the DOM but not the prototypes, so a replaced
`getBoundingClientRect` cannot see the question) and clicks in root coordinates.

### Where it lands

```
oracle : 17 file(s), 394273 records
sandbox: 17 file(s), 462845 records
3827 divergence(s), 0 T0 leak(s)          T2 819, T4 1 -- no T0, no T1
```

`Welcome! - Rate Your Music` appears in the **sandbox** traces: it passes the
Cloudflare managed challenge and reaches the real page. Its realm list mirrors
the oracle's — the widget frame, eight `blob:challenges.cloudflare.com` worker
realms, an `about:srcdoc` realm, and a second `rateyourmusic.com` realm for the
real page.

Sandbox totals across the seven fixes: **7 475 → 462 845 records**.

`baseline.rateyourmusic.com.json` holds the 820 buckets this currently produces,
so `rym.sh diff` reports only what is new; a repeat run lands at ~12, which is
the run-to-run noise of a page this size.

### What it costs

Three store misses remain, all analytics beacons:
`analytics.google.com/g/collect`, `stats.g.doubleclick.net/g/collect`,
`www.google.com/g/collect`. Their URLs carry `_p=<epoch ms>`. The oracle
reproduces the recording's value because its clock is virtual and pinned; the
sandbox, now on a real clock, does not. That is the price of
`--no-virtual-time sandbox`, and it is visible rather than hidden.

### A near match, when a client-minted id cannot agree

Kept even though rateyourmusic no longer needs it. A random id a page puts in a
URL cannot replay across two different JS environments in general, and that is
not a bug in either of them. On an exact miss the store endpoint will serve the
one recording whose URL differs in exactly **one** path segment — same origin,
same segment count, same query, one candidate or nothing. Every near match is
logged and reported separately from a hit, because it IS a divergence, just not
one the store can resolve.

The store must be recorded through the **bare harness** if the oracle will
replay it with `--framed-oracle`: `--sbxdiff-net-replay` blocks anything not in
the store, including the harness's own assets. The default top-level oracle has
no such problem.

## What the probe actually finds

One guest-observable divergence, and it is a real bug:

```
T0  leak  guest:stack  [proxy-url-leak]
    oracle :     at http://localhost:4510/probe.html:68:11
    sandbox:     at http://localhost:4500/~/sj/…/probe.html:69:11
```

A caught error's stack hands the guest the proxy URL. scramjet already knows:
`platform-error-stack-urls` is in `failing_tests.json`, and
`tests/adversarial/platform-apis.ts:295` asserts against it. The oracle found it
independently, from a page that does not mention stacks as a thing to check.
Note the line number moves too (68 → 69) — the rewrite shifts it, which is a
second, quieter tell.

### Three findings that were the harness's fault, not scramjet's

An earlier run reported three more. All were artifacts of comparing a **framed**
oracle against a sandbox that presents the guest as **top-level**:

| Reported                                             | Why it was not a bug                                                                                                                                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `top_is_self` false vs true                          | the oracle framed the page in `#testframe`; scramjet correctly presents the guest as top-level, which is what a real visitor sees                                                                        |
| `parent_is_self` false vs true                       | same                                                                                                                                                                                                     |
| `document.referrer` `http://localhost:4502/` vs `""` | the oracle's referrer _is_ the bare harness. scramjet returns `""` unless its own history has a previous entry — handing back the harness URL would be a chrome-origin leak, so `""` is the safer answer |

The oracle now loads the target **top-level** by default, which matches what the
sandbox claims and what a real visitor sees. All three disappeared;
`--framed-oracle` restores the old behaviour.

The trade is more binding-layer noise — T2 goes from 31 buckets to 159, because
an unframed oracle and a framed-but-lying sandbox make genuinely different native
calls around `top`/`parent`. T2 never decides anything and is baselined, so
losing three false verdicts is worth it.

## Known harness asymmetry

Resolved: the oracle no longer uses the bare harness by default, so there is no
second origin to leak into `document.referrer`. See above.

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
