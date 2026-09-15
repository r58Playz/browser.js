# Rules

Invariants for anyone (human or agent) touching sbxdiff. Imperative on purpose.
Each one exists because violating it either silently invalidates the oracle or
silently reintroduces a bug class we already paid for.

Companion to `.agents/skills/spec-lookup/SKILL.md`, which governs web-platform
work in this repo generally (ground changes in spec text; cross-check against
WPT).

**Measurements live in [FINDINGS.md](FINDINGS.md)** — what was true of
rateyourmusic, of that challenge, on the day it was measured. They used to be in
here, and the file was 219 entries of which half were a lab notebook. "Read
RULES.md before changing anything" is a reasonable instruction for 108 rules and
not for 219, particularly when several of them retract each other from hundreds
of lines away.

**The numbering did not change.** It is continuous across the two files, so every
`RULES.md #N` already written in a code comment still names the same entry — it
may just be in the other file. The [index](#index) says which, for all 219.

Each rule is a heading rather than an ordered-list item, and that is not
cosmetic: the numbers are identifiers, and prettier renumbers an ordered list
whose entries are not contiguous. Splitting the file made them non-contiguous,
and the first format run quietly rewrote #113 as #95.

---

## The tracer must never be observable

<a id="1"></a>

### 1. The value serializer must never run page JS.

No `ToString`, `ToNumber`,
`ToDetailString`, `Get`, `Has`, `GetOwnPropertyNames`, `GetPropertyNames`,
`GetOwnPropertyDescriptor`, `GetRealNamedProperty`, `JSON::Stringify`, `Delete`, or
`GetPrototype`/`GetPrototypeOf` (the last traps on a Proxy). This is enforced
mechanically, not by review: the encoder body runs inside
`v8::Isolate::DisallowJavascriptExecutionScope(isolate, kCrashOnFailure)` in DCHECK
builds. **Do not weaken that scope to make a value serialize.**

<a id="2"></a>

### 2. Never serialize object contents or own-key lists.

Encode
`{type_tag, object_id, interface_name | constructor_name, shape_hints}` and nothing
more. Enumerating keys can trip a Proxy trap, and scramjet hands the guest many
Proxies. It is also the wrong semantics — the page's own access sequence is the
signal, and we already capture that exhaustively.

<a id="3"></a>

### 3. Never write anything to a page object, and assign ids lazily.

Identity comes
from the `ScriptWrappable` behind a DOM wrapper — read-only (see #22 for what
happened when it was not). Still assign only when a value is actually written into
a `level==0` record: eager assignment costs a map lookup and an allocation on every
wrapper the page touches.

<a id="4"></a>

### 4. Do not add CDP to the record/replay path.

`Runtime.addBinding` adds an enumerable
own property to the global; `Runtime.enable` makes `console` eagerly serialize
arguments, which _invokes page getters_; `--remote-debugging-pipe` sets
`navigator.webdriver = true`. Everything the harness needs has a verified non-CDP
path — see plan §10.

## The differ must not launder divergences

## The differ must not launder divergences

<a id="5"></a>

### 5. Compare literally.

Never run scramjet's un-rewrite functions over a value before
comparing it. The un-rewritten value _is_ the bug.

<a id="6"></a>

### 6. `diffClass` classifies, it never normalizes.

It runs strictly _after_ literal
comparison has already failed, and only picks a bucket. Enforce this with types: the
bucketer takes a `Divergence`, not two `Value`s.

<a id="7"></a>

### 7. T0 is never suppressible.

Host origin, `/~/sj/`, controller ids, cross-site
cookies, a real `top`/`parent`/`location`/`eval` reaching the guest, chrome-realm
objects, and cross-origin access-check outcome divergences always abort. No
allowlist, no baseline entry.

<a id="8"></a>

### 8. Bucket on `(scriptId, fnName)`, never line/col.

Minified bundles shift columns
between loads and scramjet's rewrite shifts them systematically.

## Sandbox-side

## Sandbox-side

<a id="9"></a>

### 9. Every new interceptor goes through `client.Intercept` / `client.proxyObject`.

Never a bespoke `Object.defineProperty` or a raw `new Proxy`. That is precisely how
`client/dom/element.ts:154-184` became the largest URL-leak surface in the system
_and_ invisible to the `missing-interceptor` heuristic — it never populated
`descriptors.store`. A lint rule for this is cheaper than the next blind spot.

<a id="10"></a>

### 10. Guest-op brackets are token-returning, not depth-balanced.

Per-instance
`RawTrap`s (e.g. `xmlhttprequest.ts:79-113`) are installed _inside_ an apply
handler, so bracket nesting is re-entrant.

## Determinism

## Determinism

<a id="11"></a>

### 11. Never use a raw `ScopedTimeClockOverrides`.

Nested overrides are forbidden; go
through `ProcessTimeOverrideCoordinator::CreateOverride`. And pass **all five**
clock functions — the existing call site leaves `ThreadTicks`, `LiveTicks` and
`TimeTicks::LowResolutionNow` on the real clock.

<a id="12"></a>

### 12. Enable virtual time on exactly one thread.

`TryAdvancingTime` takes the min
across registered clients, so a second registrant can pin the clock forever.

<a id="13"></a>

### 13. Never let the oracle silently ignore an input.

FIVE instances now, the last
one _in the switch added to prevent the other four_: `--sbxdiff-debug-disable` was
written as a raw literal and left out of `kSbxdiffRendererSwitches`, so every
bisect that used it silently ran with the mask at zero and eliminated nothing.
A single-definition list only helps if new switches go through it. New `--sbxdiff-*` switches the
renderer reads go in `::switches::kSbxdiffRendererSwitches` (base/base_switches.h), which
`render_process_host_impl.cc` iterates — adding one there is the whole relay.
That list exists because this was the **most repeated bug in the project, four
separate times**, each presenting as "the feature silently does nothing" with no
error. The fourth instance also used a raw string literal instead of the shared
constant, which is the same drift one layer down. Treat a discipline problem that
recurs as a design problem.

The same class bit elsewhere too: a run key parsed with `StringToUint64` fell back
to real entropy for any non-numeric value. A dropped determinism input does not
look like a bug — it **manufactures divergences indistinguishable from real ones**,
which is the worst possible failure for a differential oracle. Prefer designs with
no failure mode (hash any string rather than parse one shape); where that is
impossible, fail loudly.

<a id="14"></a>

### 14. A replay miss is a divergence, not an error.

Emit `net_replay_miss` at
`level==0`. Never fall through to the real network (that silently breaks
hermeticity) and never abort the process (you lose _why_ the sandbox asked).

## Process

## Process

<a id="15"></a>

### 15. Never trust a build's reported exit status; grep the log.

`autoninja ... | tail`
reports `tail`'s status, so a failed build looks clean. Redirecting and checking
`$?` is _also_ not enough for a backgrounded build: the job's exit code is that of
the last command in the chain (an `echo` will happily return 0 over a failed
build). Both have now happened here. The only reliable check is
`grep -E "error:|FAILED|finished with an error" <log>`.

<a id="16"></a>

### 16. Wrapping an installed V8 callback pointer means updating the context snapshot reference table too.

`v8_context_snapshot_generator` serializes the _installed_
function pointers and resolves them against the per-interface
`GetRefTableOfV8<Iface>()` tables; a pointer that is installed but absent from the
table aborts the snapshot build with `Unknown external reference 0x...`. Only six
interfaces participate (Document, EventTarget, HTMLDocument, Node, Window,
WindowProperties) — and `WindowProperties` and `Window` are exactly the two with
interceptors, so interceptor changes always hit this. Emit **both** the raw and the
wrapped address: the table is a lookup, extra entries are free, and a superset
cannot be wrong.

<a id="17"></a>

### 17. Every determinism claim needs N identical runs, not two that agree.

The P4
randomness gate was recorded as passing on a byte-identical _pair_; a 5-run loop
later showed 3 distinct results. A passing pair cannot distinguish "deterministic"
from "flaky". This also applies to intermittent behaviour generally: measure a
rate, never a single instance — contradictory single runs of the worker hang
produced two confidently stated and wrong mechanisms before a 5-run loop showed
it was 5/5 deterministic _per configuration_.

<a id="18"></a>

### 18. When replacing a mechanism, the gate must run without the old one.

The
virtual-time gate passed while still passing `--virtual-time-budget`, so CDP's
second budget grant silently covered a defect in the replacement: any
`setTimeout(n>0)` never fired. More runs would not have caught it — the gate
exercised the configuration being moved _away from_. This is a control-set gap,
distinct from the sample-size gap in #17.

<a id="19"></a>

### 19. When a bisect comes back negative on every arm, find the input you never varied.

Seven arms through the tracer all reproduced a crash; the cause was the
_driver_ (`--dump-dom`/CDP vs the in-binary runner), which was constant in every
arm including the control. A bisect cannot find a cause inside a variable it holds
fixed. Twin of #18.

<a id="20"></a>

### 20. Determinism gates must run a multi-process page.

Every gate here used a
single-renderer page, and a single renderer cannot collide with itself — which is
why a keyed-PRNG bug that gave _every_ renderer the same byte sequence (duplicate
blob UUIDs, renderer killed) survived the whole suite and was found by the first
real site. Process count is a variable; hold it at 1 and you cannot see
cross-process collisions.

<a id="21"></a>

### 21. Record gate results in `PROGRESS.md` as they are measured

, not afterwards.

<a id="22"></a>

### 22. "Invisible to reflection" is not "no observable effect."

The tracer stored
object ids in a `v8::Private` property on page objects. That was verified
undetectable via `Object.keys`, symbols, proxy traps and cross-origin checks —
all correct — and it still made Cloudflare Turnstile loop forever, because
adding a property forces a hidden-class transition and can deoptimise inline
caches, which a page times on its _own_ objects. **Never mutate a page object.**
Identity for DOM wrappers comes from the `ScriptWrappable` behind them, free.

<a id="23"></a>

### 23. Check the build config of any binary you use as a control.

A snapshot
Chromium is not "stock Chromium" in the ways that matter for perf: the GN default
would give it DCHECKs, but it overrides that off. Comparing our
`dcheck_always_on = true` build against it made our bindings look 8x slow, which
is a real finding only once both sides agree on DCHECKs. `strings -a <framework> |
grep -c current_process_commandline_` distinguishes them.

<a id="24"></a>

### 24. Anything true only of Chromium 155 goes in `PINNED_ASSUMPTIONS.md`

with a check
command. Several of these fail _silently_ on a roll.

<a id="25"></a>

### 25. A successful load proves nothing about where the bytes came from.

Network
replay passed a "server is down and the page still rendered" test while silently
serving from HTTP cache. The test that has teeth is **tampering**: edit a stored
response on disk, replay, and assert the page observes the edit. Apply this to
any cache, store or replay layer — verify provenance, not success.

<a id="26"></a>

### 26. Code that compiles and is correct can still never run.

`MaybeCreateSbxdiffNetObserver()`
was never called; recording fell back to an older path that caught enough to make
every spot-check pass while missing `fetch`/XHR and the navigation body. Spot-checks
confirm a feature works _when invoked_. Prove it is invoked: count what the store
holds against what the page actually requested, or assert the negative case.

<a id="27"></a>

### 27. In the sandbox, the binding layer is not the guest-observable layer.

The
shim and the guest share one realm, so a native's return value is what the
_shim_ saw, not what the guest saw. Reading binding calls as guest-observable
reported eight T0 "leaks" on a clean scramjet run, every one of them false --
the native correctly reports a page that really is served from a proxied URL.
Compare what the guest itself computed (a sink the probe page writes to), and
keep the binding layer at a lower tier until guest-op brackets exist.

<a id="28"></a>

### 28. A baseline hides a regression in anything already diverging.

Buckets key
on `(tier, kind, api, diffClass)`, so an API that already has a bucket
absorbs a _different_ divergence silently. That is what suppression is for
and it is also a blind spot: pick regression targets that currently agree,
and never treat "no new buckets" as "no change".

<a id="29"></a>

### 29. Reset every piece of task-scoped state wherever the task id changes.

The
entry-script id was cleared in `EnsureTaskOpen` but not in the two V8
callbacks that also change `current_task_id_`, so a task would have been
attributed to whoever entered the _previous_ one. Found by grepping every
assignment to the task id rather than by testing -- the wrong attribution
would have looked entirely plausible in a report.

<a id="30"></a>

### 30. A sandbox's network egress is not visible to a URLLoader interceptor.

`--sbxdiff-net-replay` sits at `WillCreateURLLoaderFactory`, but scramjet
reaches the internet over WebSocket frames to a wisp server, which never
goes through a URLLoaderFactory. Replay for a sandbox has to be a _transport_,
not a browser-side interceptor -- and a transport is also the only layer that
sees the real upstream URL rather than the proxied one.

<a id="31"></a>

### 31. V8 script ids are per-isolate; namespace them before merging traces.

A
run produces one trace file per thread and each numbers scripts from 1, so
merging with "first mapping wins" silently attributed the page's script 4 to
the browser UI process's script 4. Every guest record in the sandbox looked
like it was entered by `chrome://resources/lit/v3_0/lit.rollup.js`. The same
applies to any per-isolate id.

<a id="32"></a>

### 32. Attribute a native call by the TOP stack frame, not the task's entry.

"Who entered the task" sounds like the right question and is not: scramjet's
controller enters essentially every task, so entry is shim even for guest
code, and requiring it classified zero sandbox records as guest. The topmost
frame being guest code is what means "no trap intervened", which is the
property that makes a value guest-observable.

<a id="33"></a>

### 33. A sandbox's own bootstrap must run on the real clock.

Virtual time
enabled in `Page`'s constructor breaks service-worker registration --
`kDeterministicLoading` never activates the worker and `kAdvance` activates
it three times -- so the page under test never loads. Defer the clock to the
realm being compared (`--sbxdiff-virtual-time-after`). Both sides enable at
their own guest realm, which keeps them symmetric.

<a id="34"></a>

### 34. Never let the driver's own URLs contain the thing a flag matches on.

`--sbxdiff-virtual-time-after` matches a URL substring, and the harness URL
embedded the encoded target twice (`?sbxdiffStore=<url>#<url>`), so the
harness page matched as the guest realm and turned virtual time on during
bootstrap -- reintroducing the exact bug the flag existed to fix. The target
is base64 in the hash now and the store is addressed by port.

<a id="35"></a>

### 35. Prove a clock is pinned by reading it, not by the run succeeding.

"Virtual
time silently never enabled" and "virtual time working" produce
indistinguishable clean runs. `pages/clock.html` writes `Date.now()` through
the sink; the 2023 date is what proves it, and it is what exposed the sandbox
drifting ~100s per run while the oracle was exact.

<a id="36"></a>

### 36. A process-wide clock override freezes threads that cannot advance it.

`ProcessTimeOverrideCoordinator` installs `ScopedTimeClockOverrides`
process-wide, so enabling virtual time on the page freezes a service
worker's clock too -- while leaving the worker unable to request
advancement, because only registered clients can. Any thread whose work the
page waits on must be a client, or the two deadlock. The coordinator is
built for exactly this; the worker just was never registered.

<a id="37"></a>

### 37. Under `kAdvance`, every real I/O wait becomes nondeterministic virtual time.

The clock jumps to the next delayed task whenever the run is idle,
so real latency converts into virtual latency by an amount that varies per
run. Removing real I/O from the measured path (preloading the network store)
fixed the flakiness but not the drift -- only a pause-on-load policy can fix
that, and it has to not deadlock first.

<a id="38"></a>

### 38. Do not inherit virtual-time pausers created before the clock existed.

Enabling virtual time mid-load counts pausers from loads that started on the
real clock, which stops the clock instantly -- and it never restarts,
because pausing fences the queues those loads complete on. Record a baseline
at enable and compare against it. Symptom: `virtual time STOPPED at +0ms`
followed by nothing at all until teardown.

<a id="39"></a>

### 39. When a hang has no error, log which resource holds the lock, not the count.

A pause _count_ going 1->0 says nothing about whether the run was
stuck: that 0 arrived after a 30-second hang, at teardown, and reading it as
a steady state sent me chasing three wrong theories. The pauser's debug name
plus timestamps found it in one run. Match on a unique id, though -- names
repeat, and a still-held pauser is masked by a later balanced pair.

<a id="40"></a>

### 40. Pausing virtual time must stop the clock, not the page, when the page is in its own load path.

Fencing task queues on pause is safe only because loads
normally complete in the network process. A sandbox's load is served by a
service worker that delegates back to the client page, so fencing the page
stops the work that would release the pause. Determinism comes from the
frozen clock; freezing the queues as well is an optimisation that assumes
the page is not a participant.

<a id="41"></a>

### 41. Key a network store on URL AND ordinal.

A URL can return different bodies
on successive requests -- a challenge page and then the real page -- and a
URL-only key silently keeps whichever was written last. That is not a lost
byte, it is a different user journey: replay skipped the challenge entirely
and a sandbox that could not survive one would have looked fine.

<a id="42"></a>

### 42. A store must record WHEN it was captured.

Recorded bytes are not
timeless. A challenge embeds tokens minted at capture time and checks them
against the device clock, so replaying under an unrelated constant makes the
page reject its own challenge. Same for cookies, JWTs, cache validators.

<a id="43"></a>

### 43. Log replay misses where the miss happens.

Browser-side misses were
invisible -- not logged, and not in the `blocked` counters, which only cover
subresources and not navigations. A guaranteed-miss navigation therefore
presented as an unexplainable 109-iteration retry loop, and I reasoned my way
to "this protocol is unreplayable" instead of reading a one-line MISS.

<a id="44"></a>

### 44. A recorded response is its headers, not just its bytes.

Replaying bodies
under a synthetic `200 OK` looks harmless and is not. Cloudflare answers the
first navigation with `Critical-CH`; Chromium restarts the navigation, the
first challenge instance is thrown away, and only the SECOND one's
sub-requests are in the store. A replay that cannot restart therefore hands
the page the abandoned challenge and every one of its endpoints misses. The
headers are what drive the browser, so the store has to carry them verbatim.

<a id="45"></a>

### 45. Record redirects; do not follow them silently.

The URL a page ends up at
is content. Cloudflare bounces `/` to `/?__cf_chl_rt_tk=<token>` and the
challenge script reads the token out of `location`, so a store that keeps
only the final body runs that script at a URL with no token. Store the 3xx
with its `Location` and make replay emit a real redirect the client has to
follow.

<a id="46"></a>

### 46. Do not normalise a key you do not understand.

I stripped
`__cf_chl_tk`/`__cf_chl_rt_tk` from store keys reasoning that a token minted
during recording could never be asked for again. Wrong twice: the token is
minted by the SERVER and lives in the recorded HTML, so replaying those bytes
asks for exactly the same URL -- and the stripping collapsed four distinct
steps of the challenge onto one key, scrambling the ordinals meant to
separate them. A normalisation that "cannot matter" is a hypothesis.

<a id="47"></a>

### 47. Per-request state that survives a restart must not live on the factory.

The replay ordinal counter was per-URLLoaderFactory.
`WillCreateURLLoaderFactory` runs once per factory and a restarted
navigation gets a fresh one, so the counter reset to 0 and re-served ordinal
0 -- defeating ordinals in the one case they exist for.

<a id="48"></a>

### 48. Measure the oracle against itself before believing a bucket.

An oracle
that cannot reproduce its own run cannot convict the sandbox of anything.
`--self-check` runs the oracle twice and diffs; on rateyourmusic that is 345
unstable buckets (resource timing, ICE candidates, blob UUIDs, timer ids) and
0 T0 leaks. Keep the noise floor in a file SEPARATE from the baseline: a
baselined bucket is "known and accepted", a noisy one is "the oracle has
nothing to say", and merging them hides real bugs behind noise invisibly.

<a id="49"></a>

### 49. Key a baseline by what it was recorded against.

Bucket keys are
`tier|kind|api|class` with no page in them, so one shared `baseline.json`
let a run on rateyourmusic silently suppress 28 probe-page buckets. That is
the exact failure a baseline exists to prevent, so the file is now per target
host.

<a id="50"></a>

### 50. A service worker does not get the browser's network-layer behaviour.

`Critical-CH` makes Chromium redo a navigation and discard the first
response; for a response synthesized by a service worker it does not, because
client hints are a network concept. A sandbox that serves the guest through a
SW therefore ran the challenge instance the recording threw away. Emulate it
in the transport, and **log when the emulation fires** — the harness is
compensating for a real divergence, not removing it.

<a id="51"></a>

### 51. Fence one side, not both.

`--vt-fence` is per side now. The oracle needs
it -- without it rateyourmusic's challenge takes different branches and the
run stalls at 5510 records. The sandbox must NOT have it: its loads are
served by a service worker that delegates back to the client page, so
fencing the page stops the work that would release the pause (#40). Applying
it to both reintroduced that deadlock, and it presented as "the challenge
script is fetched and never executes" rather than as a hang.

<a id="52"></a>

### 52. A shim must not spend the guest's randomness.

Under a pinned PRNG the
keystream is shared: V8 seeds `Math.random` per native context from
`--random-seed`, so the guest's Nth draw is fixed, and Chromium's web-crypto
keystream counter is per thread. Anything the sandbox draws in the guest's
realm -- or on its thread -- shifts every value the guest afterwards sees.
Measured on scramjet: `scramtag()` 2585 crypto draws, libcurl 128,
`createFrameId()` 8 `Math.random`, `opaqueScope` 1. Cloudflare's Turnstile
derives its widget id from one of those, puts it in a URL and routes
postMessages on it, so the sandbox and the recording could not agree on it
and the widget hung. With all four removed the ids match exactly and the
store serves the run with zero misses. Ids need to be UNIQUE, not
unpredictable: use a counter.

<a id="53"></a>

### 53. WebIDL substitutes the global for a null receiver; a shim must too.

"Let esValue be the this value, if it is not null or undefined, or realm's
global object otherwise." A bare `addEventListener("x", fn)` therefore works
in every engine, and an interceptor that takes `this` at face value sees
`undefined`. Ours then used it as a WeakMap key and threw
"Invalid value used as weak map key" -- a message no engine produces there,
so both a broken page and a tell.

<a id="54"></a>

### 54. Make the sandbox's store exactly as permissive as the oracle's.

The
endpoint refused non-GET as an "honest miss" while the Chromium-side replay
answered any method from the same URL key. Cloudflare POSTs to its `fo/`
endpoint, the recording holds that response, and the asymmetry showed up as
a sandbox miss -- a divergence manufactured by the harness.

<a id="55"></a>

### 55. A shim that calls the native without a receiver posts to itself.

WebIDL
substitutes the _realm's_ global for a null `this`, so
`otherWindow.postMessage(...)` forwarded as a bare call silently delivers to
the forwarder's own window. scramjet's shim did exactly that
(`Function("...args", "this(...args)")` invoked with the native as `this`),
so a frame talking to its parent talked only to itself. Forward with
`fn.apply(receiver, args)`; the stolen-`Function` trick is for the
_incumbent_ realm, not the receiver.

<a id="56"></a>

### 56. Select the guest realm by the target page, not by record count.

A probe
page with an iframe has two realms on the origin, and "the realm with the
most records" picked a different DOCUMENT on each side the moment the frame
got busier than the page -- every observation on both then reported as
missing or extra. Match the target URL: exactly on the oracle, its encoded
form under the proxy prefix on the sandbox.

<a id="57"></a>

### 57. Emulate a browser behaviour at the scope the browser applies it.

The
`Critical-CH` restart is a NAVIGATION restart, and the recording shows the
oracle did not restart for the Turnstile iframe -- one stored response, not
two. Emulating it per URL loaded the widget twice. Gate on
`Sec-Fetch-Dest: document`.

<a id="58"></a>

### 58. Key a baseline by the page, not just the origin.

Per-host was not enough:
two probe pages on `localhost` shared one file, so `--page csp.html
--baseline` overwrote probe.html's. Same failure as #49, one level down.

<a id="59"></a>

### 59. Virtual time starves a frame created late.

Under `kDeterministicLoading`
the Turnstile widget's frame never started its blocking `<script src>` at
all: measured, it sat at `readyState: "loading"` with one script and 83
bytes of DOM for an entire 30 s run, while `decodedBodySize` said all
972 750 bytes of its document had arrived. Turn virtual time off for that
side and the same frame runs 44 000 records and spawns Turnstile's blob
workers. Not root-caused; `--no-virtual-time sandbox` is the workaround, and
it costs the sandbox its pinned elapsed clock (Google Analytics' `_p=`
timestamp then misses the store).

<a id="60"></a>

### 60. A same-process iframe has no widget of its own, so a frame-targeted click lands in the main frame.

`RenderFrameHost::GetView()` returns the ROOT
view for a subframe that shares its parent's process, so
`--sbxdiff-click-frame` silently clicked (22,32) of the top-level page. That
is not a corner case for a sandbox, it is the norm: the oracle sees
Cloudflare's widget cross-origin and therefore out-of-process, while a proxy
serves every frame from one origin. The oracle's widget realm received
MouseEvents and the sandbox's received none — which is why the sandbox could
run the whole challenge and never finish it. Ask the frame for its offset
from an ISOLATED world (the page shares the DOM but not the prototypes, so a
replaced `getBoundingClientRect` does not see the question) and click in root
coordinates.

<a id="61"></a>

### 61. An anti-bot payload is not reproducible across runs, so the recording is the wrong thing to score a run against.

Cloudflare's `/fo/` bodies were
compared against the bytes the recording posted, and the sandbox "failed" on
five endpoints. It does not fail them: unmodified Chromium replaying the
same store disagrees with the recording on all five too, sending 2263 bytes
where the recording sent 2274. Worse, the oracle disagrees with _itself_:
two runs of stock Chromium, identical settings, same store, diverged on 6 of
8 request bodies — 4578 vs 4588, 88652 vs 88663, 91852 vs 91874, and three
more that matched in length but not in content. The payload is built from
the clock and from entropy drawn during the run; no two runs produce it
twice, and holding the sandbox to bytes nobody can reproduce scores it
against noise. Compare the sandbox against the ORACLE, and only past the
oracle's own measured spread. Note what survives that: a request one side
sends and the other never sends at all is a real divergence at any noise
floor.

<a id="62"></a>

### 62. Input has to land in the same place in both runs, and a frame-targeted click lands in neither page.

`--sbxdiff-click-frame` delivers every event
straight into the widget, and an event inside an iframe does not bubble out
of it, so the main document never saw a pointer at all. Worse, the two sides
cannot be given the same _moments_: the oracle's clock is virtual and the
sandbox's is real (#59), so a fixed schedule of clicks lands at different
points in the two page lifetimes — measured, the sandbox's real page
committed at 78% of the run and the last click landed at 70%, so it was
never clicked at all. rateyourmusic arms its anti-bot check with
`$("body").on("mousemove touchend", ...)`: the oracle posted 2450 bytes to
/httprequest/SecChk and the sandbox posted nothing. Move the pointer across
the page continuously, independent of the click schedule, and every document
that commits gets one whenever it commits.

<a id="63"></a>

### 63. The guest frame must BE the viewport, and nothing may resize it after the page starts.

The harness hosted the guest at `height: 80vh` below a
heading, which breaks the oracle's equivalence twice: root coordinates stop
addressing the same place in the guest's own client space, and
`innerHeight`/`outerHeight`/`visualViewport` — values anti-bot payloads post
verbatim — differ for a reason that has nothing to do with the sandbox.
Then a subtler one: Chromium's `--no-sandbox` infobar slides in about a
second after startup and shrinks the content area by 56 px UNDER the running
page. The oracle's guest reads `innerHeight` before that lands and the
sandbox's cannot — service worker registration and scramjet boot sit in
front of the guest's first line — so the oracle measured 813 then 757, the
sandbox measured 757 twice, and the sandbox was blamed for a viewport the
browser moved. `--test-type` suppresses it. `pointer.html` reads the
viewport twice, early and late, so a repeat is visible as itself.

<a id="64"></a>

### 64. A service worker does not intercept subresources from an about:blank frame, and rewriting the frame to srcdoc does not fix it.

Measured in
unmodified Chromium with no proxy in the picture
(`sbxdiff/pages/swblank.html`), against a worker that answers one URL
itself:

| frame                                | who served the subresource |
| ------------------------------------ | -------------------------- |
| top-level (control)                  | `sw`                       |
| `about:blank`                        | **`network`**              |
| `about:srcdoc`, after its load event | `sw`                       |
| `srcdoc` set, injected synchronously | **never loaded at all**    |

srcdoc works because `kServiceWorkerSrcdocSupport` is
FEATURE_ENABLED_BY_DEFAULT and `InheritControllerFrom` accepts an
about:srcdoc client. The commit that did it (crbug 41411856) says why
about:blank was left out: "about:blank iframe navigation is committed
synchronously and requires separate fix."

That synchronicity is also why a proxy cannot route around it by turning
blank frames into srcdoc ones. A page creates the iframe, appends it, and
reads `contentDocument` on the very next line; a srcdoc navigation is
queued, so what it gets back is still the initial about:blank
(`sw.srcdocsync.url=about:blank`) and everything injected into it dies when
the srcdoc document commits -- the marker injected that way never loaded at
all, where the awaited one loaded through the worker.

The consequence for the sandbox is not subtle. On rateyourmusic the page
creates a 1x1 blank iframe and injects a script that appends
`<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js">`; that
request was the ONLY `/~/sj/` request the proxy's own HTTP server received
in the entire run, where every other one went through the worker. It came
back as the harness's 404 page ("Refused to execute script ... MIME type
('text/html')"), so the oracle posted 16270 bytes to `jsd/oneshot` and the
sandbox posted nothing. Anything loaded from a blank frame leaves the
sandbox. Covered by `sbxdiff/pages/blankframe.html`, left FAILING rather
than baselined -- see #61 for what a baseline recorded over a broken
sandbox does.

<a id="65"></a>

### 65. Realm ids are per-isolate, so they collide across trace files — and realm is what the comparison is scoped by.

A run writes one trace file per
thread; each numbers its realms from 1. `mergeTraces` namespaced SCRIPT ids
for exactly this reason and left realms alone, so realm 1 in the merged
trace was every document that happened to be first in its own process.
Measured on rateyourmusic: all 17 of the oracle's trace files claimed realm
1 — the browser toolbar, the page, the Turnstile widget, eight Cloudflare
blob workers — so `selectGuestRealm` matched the page's URL and swept up
357 195 records from seventeen documents, while the sandbox's guest realm
had a large id that collided with nothing and stayed clean. Every diff
compared a seventeen-document union against one document; that is where 650
`missing-call` baseline buckets came from. Namespacing both dropped
rateyourmusic from 3983 divergences to 2512.

<a id="66"></a>

### 66. An instrument behind an environment variable is an instrument that is off.

The oracle's request-body hashes are `LOG(WARNING)` lines, and
Chromium writes nothing to stderr without `--enable-logging=stderr`, which
was behind SBXDIFF_VERBOSE. An ordinary run therefore parsed an empty
stderr, found no oracle bodies, and reported every request the sandbox made
as "oracle (none sent)" — seven divergences manufactured by a switched-off
instrument. Anything the REPORT depends on is unconditional; the variable is
for the firehose that a human reads. And a side that reports nothing at all
while the other reports plenty is an instrument failure, not a finding: say
so, rather than listing every request as divergent.

<a id="67"></a>

### 67. The native trace is not what the guest sees.

The tracer hooks bindings,
so a shim that answers from its own state leaves no record, and a shim that
consults the native leaves a record of the NATIVE answer. Reading
`Window.origin.get -> "http://localhost:4500"` out of the sandbox trace and
calling it a leak is wrong twice over — that is scramjet's own trap reading
through to the native before substituting the site's origin, and the guest
never sees it. This is why T0 (guest-direct) exists and why a probe page
that pushes values through `document.title` is worth more than any amount of
reading the trace: it records what the PAGE got. Two of the real bugs this
session (`window.name`, resource timing) were only confirmed that way, and
two false leads were killed by it.

<a id="68"></a>

### 68. A sandbox that cannot have virtual time still needs the same clock ORIGIN.

#59 forces `--no-virtual-time sandbox`, which left the sandbox on
the real wall clock while the oracle ran from a pinned one. That is not only
a fingerprint: Cloudflare's JS detections take the challenge's issue time out
of `__CF$cv$params.t`, compare it against `Date.now()`, and stop — with no
error, no exception, nothing in the console — when a recorded challenge is
replayed hours later and looks stale. Measured: the script executed exactly
six operations (`crypto` ×3, `randomUUID`, `atob`) and halted, the sandbox
made five XHR POSTs where the oracle made six, and `jsd/oneshot` was never
sent. `--sbxdiff-time-offset` shifts `base::Time::Now()` by a delta fixed at
startup and then lets it run at real speed: same origin, real rate, which is
what a sandbox needs. `TimeTicks` is deliberately untouched — it is
monotonic-since-boot, has no epoch to agree on, and is what
`performance.now()` measures. With it the sandbox makes six and posts to the
byte-identical URL.

<a id="69"></a>

### 69. A CSS property is a NAMED property, so only a Proxy can see it.

`getComputedStyle(el).backgroundImage` handed the page
`url("http://localhost:4500/~/sj/<ctx>/http%3A%2F%2F…")` — the proxy's
origin, its prefix and the encoded target, in a string the guest itself
reads. It looked like an accessor to patch and is not: measured,
`backgroundImage` is nowhere on the prototype chain of a computed
declaration, which is why the trace shows a
`CSSStyleDeclaration.NamedPropertyGetterCallback`. `getPropertyValue` was
intercepted and covered nothing a page actually writes. Inline styles were
already wrapped in a Proxy for this reason; computed ones were left out as
"correct but extremely expensive", which is a trade that cannot be made —
the cost is per-property-read and the alternative is a T0 leak. Cache the
wrapper per declaration and pay it once.

<a id="70"></a>

### 70. Injecting "at position 0" of a document puts you in front of the DOCTYPE, which is what causes quirks mode.

The HTML rewriter has a `detectQuirks()`
that, on finding an unusual document structure, injected its scripts at
index 0 of the root — ahead of `<!DOCTYPE html>`. A `<script>` before the
doctype makes a browser ignore it, so the function caused the thing it is
named for. Measured on rateyourmusic, whose document takes that path
(trailing content after `</html>` is enough):
`document.compatMode` was "BackCompat" where unmodified Chromium says
"CSS1Compat", `documentElement.clientHeight` 15364 against 813, and
`scrollHeight`, `HTMLCollection.length` and
`IntersectionObserverEntry.isIntersecting` moved with it — all values an
anti-bot payload records. Inject after any leading doctype or comment
instead: still ahead of anything the page can run, and the document keeps
its mode.

<a id="71"></a>

### 71. Positional pairing loses its place, and a tier it cannot support is worse than no tier.

Calls are paired by index within an API, so one extra call
on either side shifts every pairing after it and the "divergences" that
follow are two unrelated calls held up next to each other. Measured on
rateyourmusic, `Element.tagName.get` reported oracle "BODY" against sandbox
"SCRIPT" 27 times — four of the six T1 buckets were that. A count mismatch
is already reported on its own; what it must not do is lend its drift the
authority of a judged tier. A LEAK is the exception and keeps its tier,
because that classification reads the sandbox's own string and drift cannot
invent one. For the same reason a leak needs no pair at all: the calls
BEYOND the oracle's count were never examined by anything, and "the sandbox
made an extra call that returned a proxy URL" is precisely what this tool
exists to catch.

<a id="72"></a>

### 72. A CSS selector does not go through `getAttribute`, so a rewritten attribute is invisible to it.

Scramjet rewrites `src`/`href` in the markup
and serves the original back through `getAttribute`, but a selector matches
the REAL attribute: `[src="/a.png"]` found nothing while the page could
plainly read "/a.png" off the same element. Measured — `[src=…]`,
`[src^=…]`, `[src$=…]`, `[href=…]`, `matches()` and `closest()` all
returned 0/false in the sandbox against 1/true in the oracle; only `*=`
happened to work, because the substring survives inside the encoded URL.
That is a functional break before it is a tell: finding elements by their
URL is how a script cleans up after itself. Rewrite the attribute name in
the selector to the `scramjet-attr-` alias, and KEEP the original beside it
as a selector list — an attribute that was never rewritten has no alias, and
a list matches the union.

<a id="73"></a>

### 73. The oracle was not deterministic, and the two clocks it has are not the same clock.

`Date.now()` was pinned to the millisecond while
`performance.now()` drifted 24 ms between two identical runs, because
`WindowPerformance` resolves its origin at CONSTRUCTION and
`--sbxdiff-virtual-time-after` starts the clock later — so it found no base
and fell back to the loader's reference time, which is real. Resolve the
origin at USE. `timeOrigin` needed the same treatment from the other side:
it is built from a real wall-clock reading, and under virtual time its value
is known exactly — the instant the clock was set to.

<a id="74"></a>

### 74. `crypto.getRandomValues` is not the only RNG a page can reach.

BoringSSL seeds its own DRBG from the OS, and WebCrypto's key generation and
RSA-OAEP padding draw from THAT — so they stayed random with //base's PRNG
fully pinned. Measured across two otherwise identical runs:
`generateKey` gave c2ec846c… against c47067d9…, and an RSA-OAEP ciphertext
of the same plaintext under the same key gave 91ed881e… against b744083d….
Cloudflare's payload prepends an RSA-encrypted random key, so no request
body could ever be byte-identical between two runs, however well everything
else was pinned. That is why the oracle disagreed with ITSELF on 6 of 8
bodies and why there was no noise floor to measure a sandbox against.

<a id="75"></a>

### 75. A clamped timestamp is not a rounded timestamp, and the difference is the whole of its nondeterminism.

`TimeClamper` decides per value whether
the 100 µs clamp rounds UP or DOWN, by a coin flip keyed on a per-process
`secret_` drawn from `base::RandUint64()` — and it flips that coin against
the ABSOLUTE value, because `MonotonicTimeToDOMHighResTimeStamp` clamps
`monotonic_time` and `time_origin` separately as time since the machine
BOOTED and subtracts. So a timestamp depends on (a) an unpinned secret and
(b) where boot-relative ticks happen to fall on the grid, which is a
different phase every run. Both are invisible in any aggregate: the error
is exactly one bucket, so anything that rounds, or that reports a duration
rather than an instant, cannot see it. Measured: `Event.timeStamp` 48
against 48.099999994039536, `performance.now()` 59.5 against
59.3999999910593. Pin the secret to its own keystream and clamp the
ELAPSED difference, not the two absolutes.

<a id="76"></a>

### 76. Randomness a page cannot READ is still randomness a page SENDS.

`----WebKitFormBoundary<16 random chars>` is unreadable from script and
appears nowhere in any API trace, and it made two otherwise identical
multipart bodies agree on 4 bytes out of 2450 — twice the boundary, 28
bytes, and the hash says only "differs". Anything that reaches the wire is
in scope for pinning, not just what a getter returns.

<a id="77"></a>

### 77. Give every pinned draw its own keystream.

The per-thread automatic
stream shares one counter with all of Chromium's internal draws on that
thread, so a draw's value depends on how many unrelated draws preceded it
— which varies run to run. A pinned PRNG with a shared counter is not
pinned. Rules 75 and 76 were both this, in different places.

<a id="78"></a>

### 78. A hash says two bodies differ; it cannot say how, and the how is the diagnosis.

Dumping the bytes answered in one run what seven divergence
reports had not: every Cloudflare payload agrees on its first 171 bytes and
nothing after. That is the 128-byte RSA-wrapped XTEA key reproducing, so
the key is pinned and the residue is plaintext — which LZW then smears over
the entire ciphertext, making a 22-byte plaintext change look like a
total divergence. "Agree on a long prefix, part at one field" and "differ
from byte 0" point at completely different causes.

<a id="79"></a>

### 79. `--sbxdiff-virtual-time-after` does not defer virtual time in a renderer that can never see the start realm — it cancels it.

The deferral matches
on a URL substring of the page under test. A cross-origin iframe lives in
its OWN renderer under site isolation, and its URL never contains that
substring, so the match never happens and virtual time never starts there
at all. Measured on rateyourmusic: the Turnstile widget's renderer ran the
entire journey on the real wall clock and stamped it into Cloudflare's
payload — two oracle runs sent `|1789282059420|` and `|1789282110001|`,
50.6 s apart (the real gap between the runs) and ~7.7 hours past the pinned
origin. Every request body built there diverged while the page's own realm
reported **zero** divergences, for exactly as long as nobody looked. The
deferral exists to keep a sandbox's bootstrap off the virtual clock; a
renderer whose main frame is remote hosts no bootstrap, so it must start
immediately.

<a id="80"></a>

### 80. A probe that runs only in the main frame proves nothing about a page that does its work elsewhere.

`clocks.html` had to compare the main frame, a
blob worker, a cross-PROCESS iframe and that iframe's own worker before the
answer appeared — the first three of those are pinned and only the last two
are not. Use `127.0.0.1` against `localhost`: a different site, so a
separate renderer, which is the structural difference that matters and the
one same-origin probes cannot reach.

<a id="82"></a>

### 82. The tracer is a BINDINGS tracer, so V8 builtins are a blind spot.

Instrumentation is injected by Chromium's Web IDL generator
(`bind_gen/interface.py`), so it sees everything that crosses Blink's
binding layer and nothing that does not. `Date.now`, `Math.random`,
`JSON.stringify` and `RegExp` live inside V8 and never cross it. This is
not a small gap: in Cloudflare's realm `performance.now()` showed up as
10028 divergences while `Date.now()` — the value actually in the payload,
`tmiw0:'…|1789282059420|0|'`, 50.6 seconds apart between two oracle runs —
showed up as nothing. A clean bill of health from the trace does not cover
them, so anything built out of a builtin has to be reasoned about or
measured through the bytes it produces.

Wrapping the builtin is not an option: a JS wrapper or a V8 API interceptor
is guest-observable through `toString`, function identity and property
descriptors, which defeats the point of the oracle. Patching V8 works but
V8 cannot depend on Blink and the tracer's realm identity is Blink-side.
The one clean seam is the PLATFORM boundary, where V8 asks the embedder --
`gin::V8Platform::CurrentClockTime*` for the clock, the entropy source for
randomness. That covers exactly what V8 delegates, which is why the clock
cap lives there and why `Math.random` is pinned with `--random-seed`
instead of traced.

<a id="83"></a>

### 83. A fix keyed on PROCESS TOPOLOGY is asymmetric between the two sides by construction.

The oracle loads `challenges.cloudflare.com` cross-origin,
so site isolation gives it its own renderer. The sandbox proxies every
origin through `localhost:4500`, so the same widget is SAME-ORIGIN and
lives in the main renderer. Anything conditioned on "this renderer hosts
only a cross-origin subframe" therefore fires on one side and never on the
other, which widens the very comparison it was meant to narrow. Measured:
the observable-clock work took the oracle's Cloudflare realm from 10028
divergences to 5 against itself, and moved `rym.sh diff` by nothing at all
(2550/29/7 before, 2555/30/7 after).

<a id="84"></a>

### 84. The counter clock cannot be made symmetric, and rule 82 is why.

Driving
`Date.now()` from a count of reads reproduces across two runs of the SAME
code, because the count is a property of the code. It cannot reproduce
across oracle and sandbox, because the sandbox's shim reads the clock too
and every shim read shifts the guest's count. Counting only guest-attributed
reads would fix that, and there is nowhere to do it: `Date.now()` is a V8
builtin, the tracer is a bindings tracer, and the platform boundary where
V8 asks the embedder has no idea which script is asking. So byte-identical
challenge payloads across the two sides are not reachable by clock work
alone.

<a id="85"></a>

### 85. Replay cannot reproduce the live failure, because the thing that fails is the SERVER's answer.

Scramjet loops at the Cloudflare challenge live: it
posts a payload, the server rejects it, it retries. Under replay the store
returns the recorded 200 whatever was posted, so the retry never happens and
both sides sail through to the real page. Everything downstream of that --
the main-page realm the differ picks by default, its `document.scripts`
counts, its resource timings -- is describing a journey the sandbox does not
actually complete. Diff the CHALLENGE realm, not the document the run ended
on.

<a id="88"></a>

### 88. An explicit keystream's counter is per THREAD, and the two sides do not put the same realms on the same threads.

The oracle gives the Turnstile
widget its own renderer, so its main thread's WebCrypto counter starts at
zero. The sandbox proxies every origin into one renderer, so the same realm
shares a thread with the harness and the guest page and inherits their
draws. Everything downstream is shifted, which is why `crypto.randomUUID`
still differs after the key itself was made cross-process stable. Fixing it
needs a per-REALM counter, and //base has no notion of a realm -- the
discriminator would have to come from Blink and be stable across the two
sides, which a realm id (per-isolate) and an origin (rewritten) both are
not.

<a id="89"></a>

### 89. Any counter the two sides share has to be anchored to a REALM, and this is the shape of nearly everything left.

The oracle gives a cross-origin
widget its own renderer; a proxy puts every origin in one. So any index
that counts per thread or per process is the guest's Nth on one side and
its (N+k)th on the other, and every value derived from it differs however
well the key or the clock is pinned. Found in four places, and the fix is
the same each time -- find the per-realm object and hang the counter on it:

    performance.now()      per-thread clock   -> counter on `Performance`
    crypto.getRandomValues per-thread stream  -> counter on `Crypto`
    crypto.randomUUID      per-thread stream  -> counter on `Crypto`
    ICE ufrag              process-global     -> NO realm object to use;
                                                 generated inside WebRTC,
                                                 which Blink cannot reach
    PerformanceEntry       process-global     -> `index_` is an
                                                 AtomicSequenceNumber, so
                                                 resource-timing values
                                                 inherit the same shift

The two unfixed ones are unfixed for the same reason: there is no per-realm
object in scope at the point the number is minted. That is the work, not
more pinning.

<a id="90"></a>

### 90. Some divergences are the sandbox, and pinning them would be lying.

What survives after all of the above splits in two, and the difference
matters more than the count:

Noise, and legitimate to pin, because under replay BOTH sides are served
from one store and the value measures the machine rather than the page:
`navigator.connection` rtt/downlink (pinned), resource-timing durations.

Real, and not: `MemoryInfo` 31 MB against 139 MB, and
`PerformanceResourceTiming.decodedBodySize` 256046 against 967855. The
shim shares the guest's isolate, so its heap IS the guest's heap, and its
rewritten script is 3.8x the original. Both are readable through ordinary
APIs, both are exactly what an anti-bot payload carries, and a live server
sees them whatever the oracle does. Pinning those would make `rym.sh diff`
pass by making the oracle blind to the thing it was built to find.

<a id="91"></a>

### 91. Resetting a process-global counter at a per-realm event does not align it, and the ICE ufrag is the proof.

Rule 89 says to anchor a shared counter to
a realm. Where no per-realm object is in scope, the obvious substitute is to
RESET the global one at something per-realm -- for ICE credentials, the
guest constructing an `RTCPeerConnection`, which both sides reach at the
same point in the same code. Tried, measured, and it changed nothing:
`ufrag 8RDl` against `GWw6`, byte for byte what it was before the reset.
A reset only helps if the draws BETWEEN it and the value are the same on
both sides, and they are not -- that is the whole problem, and moving the
origin of the count does not change the count. Anchoring means the counter
must BELONG to the realm, not merely be zeroed near it. The hook was
reverted rather than left in: a no-op with a confident comment is worse than
nothing.

<a id="92"></a>

### 92. The patch set was incomplete for months and every check passed.

DEPS
pulls `third_party/boringssl/src`, `third_party/webrtc` and `v8` as their
OWN git checkouts, so the outer `git diff` that `regen.sh` runs cannot see a
line of them. BoringSSL's `getentropy.cc` had been listed in
07-determinism.patch since it was written and contributed nothing the whole
time -- 66 lines of deterministic entropy, the thing rule 74 says is the
difference between reproducible request bodies and none. Anyone applying
these patches got a build without it and would have seen randomness they
could not explain.

It passed because a listed file that produces no diff contributes nothing
and says nothing, and because the checks were self-referential: the area
patches were verified against all.patch, and all.patch against itself. A
file neither could see agreed with itself perfectly.

Sub-repos are now diffed with prefixes that put their paths back where they
belong, and a check asserts that every modified file anywhere appears in the
patch set. The list of sub-repos is DISCOVERED, not written down -- the
first version of the guard derived what it expected from the same list it
used to collect, so omitting a repo hid it from both sides and the check
still said OK. That was verified by hiding them and watching it pass.

<a id="94"></a>

### 94. An ORACLE-side hang is always a Chromium patch, because the oracle runs no proxy code.

That single fact turned a hang with no error message into a
one-step diagnosis. `rym.sh diff` stopped exiting; the oracle reached
`SecChk` and then sat there; scramjet was not a candidate.

The cause was counter-driving `Date.now()`. A counter advances per READ
while timers still fire on the virtual clock, so a retry loop bounded by
wall time -- wait 100 ms, check `Date.now()`, try again -- advances 20 us
per attempt and never reaches its deadline however many times the timer
fires. `performance.now()` is safe to drive from a counter because nothing
schedules against it; `Date.now()` is not.

<a id="95"></a>

### 95. Test the recipe the goal names, not the variant that is convenient.

The
hang above survived many rounds of work because every measurement in those
rounds used `--no-virtual-time both` -- chosen because it makes the two
sides comparable -- while `rym.sh diff` uses virtual time on the oracle. The
combination of the counter clock and virtual time was never exercised until
the real recipe was run again, and it had been broken the whole time.

<a id="96"></a>

### 96. The two sides' stores do not have the same matching rules, and the leniency is on the sandbox's side.

`LookupNextResponse` in
`base/sbxdiff_net_store.cc` -- the oracle's -- is an exact URL lookup and
nothing else. `nearMatch` in `sbxdiff/store.ts` -- the sandbox's -- serves a
recorded response when one path segment differs. So there are URLs the
sandbox is handed and the oracle is refused, and the difference flatters the
sandbox: it can complete a journey the oracle could not, and the run reads
as agreement.

Not currently firing on rateyourmusic (the report shows no near matches
there), which is the only reason it has not produced a wrong answer yet.
Two implementations of one rule in two languages, with no test holding them
together, is the same shape as `bodyFileStem` -- and that one had a test
precisely because drift in it is silent.

<a id="97"></a>

### 97. `sendBeacon` does not reach the replay interceptor.

The oracle's trace
shows `Navigator.sendBeacon` called with a Google Analytics collect URL, and
its stderr shows no `replay MISS` for it -- and the oracle's store has no
such entry, so a lookup would necessarily have missed. The request therefore
never reached `sbxdiff_net_replay`, which is installed at
`WillCreateURLLoaderFactory`; keepalive requests are serviced elsewhere.
Either it was dropped as the browser shut down or it left the process, and
the second would be a hole in the hermeticity rule 14 exists to enforce.
Untested here, and worth testing: a beacon to a URL the store does not have
should produce a MISS, and currently produces silence.

<a id="105"></a>

### 105. Unwrap a callback before you judge it, and then the residual has a name.

`ClassifyCallback` reads the callback's script, which works because
a `setTimeout` trap forwards the page's function untouched. It does not
work on a function that carries no script, and `Function.prototype.bind`
produces exactly that -- `ScriptId() <= 0`, no script origin -- as does a
Proxy. Nearly half the timers on this recipe arrived that way and fell back
to the stack without being looked at.

`v8::Proxy::GetTarget()` and `v8::Function::GetBoundFunction()` unwrap them.
Measured, guest timers grouped by the callback's script:

         oracle sandbox
             40      45  <-- +5  challenges.cloudflare.com/.../turnstile
             29      29          googletagmanager G-CPSL518SBG
             14      19  <-- +5  rateyourmusic.com/cdn-cgi/.../orchestrate
             11      11          googletagmanager UA-59057-1
              5       5          (no-script)
              4       4          challenges.cloudflare.com/turnstile/api.js
              2       2          chrome://webui-toolbar
              2       2          cdn.sonemic.net bundle.js
              1       1          rateyourmusic.com
            108     118  TOTAL

Be honest about what this fixed: nothing. The count was 118 before and 118
after -- those ten really are the guest's, so the stack fallback had been
accidentally right. `(no-script) 48 against 58` became `5 against 5`, and
the ten moved from unexplained to named.

That is the whole value. The two scripts that differ are Cloudflare's own
challenge code, both +5, and every other script matches exactly. So the
remaining 3150 ms of clock gap is not the harness mis-attributing anything:
it is Cloudflare's code scheduling ten more timers under the sandbox than in
a real browser, which is a genuine behavioural divergence and the thing this
tool exists to find. Three rounds of sharpening the discriminator ended by
proving the discriminator was not the problem -- which is a result, as long
as it is written down as one.

<a id="113"></a>

### 113. A clock whose increments are read from itself is a function of the scheduler; chain them and it is a function of the code.

After attribution
was exact -- both sides scheduling 117 guest timers, matching on every
script and every delay -- the clocks still parted. Dumping the schedule
sequence side by side found where:

      index 20   oracle  at=200  ms=5000
                 sandbox at=550  ms=550

Same timers, different ORDER. A timer's due was `LogicalElapsed() + timeout`,
so it depended on whatever had already fired, and the sandbox's task queue
draining more slowly was enough to change the trajectory. The clock fed back
into itself.

Chained instead: a timer scheduled inside a timer is due at THAT timer's due
plus its own delay, held in a thread-local across the callback. So
`setTimeout(100)` inside `setTimeout(100)` is due at 200 wherever it runs,
and the clock becomes a function of the timer tree -- a property of the
page's code -- rather than of the machine.

Measured, three consecutive runs:

    ts gap   -550, -550, -550

Which is the result, and it is not zero. Before the change the gap wandered
(+50, -500, -200, -50) and landed on zero once, which rule 112 records
believing. Now it is one poll round, every time. Reproducible and wrong
beats unreproducible and sometimes right: a stable quantum is a thing a
click delay can be chosen against, and noise is not.

<a id="115"></a>

### 115. A probe that one side's CSP blocks reads exactly like a probe that found nothing.

The widget document sends
`script-src 'nonce-AZF71QBfuZKprSmQDESew7' 'unsafe-eval'`. An injected
inline `<script>` without that nonce is refused by unmodified Chromium and
RUN by the sandbox, because scramjet does not enforce the site's CSP.

So the first two probes of that document reported "oracle 0, sandbox 8" and
"oracle 0, sandbox 3", and rule 111 read the first of those as _the payload
is not built here, it is built in blob realms_. It was built there all
along. `plantProbe` now reads `'nonce-...'` out of the recorded headers and
stamps the injected tag with it, and both sides report identically.

The asymmetry is itself a finding, and not a small one: a nonce-based CSP
is a site's defence against exactly the injection this probe performs, and
under the proxy it is not there. That is a fidelity gap and a security one,
since the proxy is removing a protection the site chose for its users.

<a id="127"></a>

### 127. A bucket key carries no magnitude, so the noise floor was hiding a thirteenfold divergence behind sub-millisecond jitter.

Asked whether the
widget realm's resource-timing divergence was real or noise, the oracle
answered it against itself:

      oracle vs oracle    responseStart 0.56  vs 0.57     duration 14.29  vs 13.575
      oracle vs sandbox   responseStart 0.595 vs 1.3      duration 14.495 vs 185.4

The oracle reproduces itself to 0.7 ms and the sandbox is 171 ms out. Real,
and caused by the proxy: the resource takes thirteen times longer through a
service worker and a JS rewriter than it does direct.

And it was SUPPRESSED. A bucket is `tier|kind|api|class`, so both land on
`T1|value-divergence|PerformanceEntry.duration.get|numeric-delta`, and a
noise floor recorded from the self-check covers the name. The floor now
records the spread the oracle showed itself, and a run inside it is noise
while a run far outside it is a finding -- scaled, because one sampling run
only estimates the spread, with an absolute floor so a recorded 0 does not
reject every later run over a rounding difference.

This is the same failure as rules 117 and 118 at the reporting layer rather
than the attribution one: the tool was not reporting something wrong, it was
reporting nothing, with the authority of a suppressed bucket.

<a id="128"></a>

### 128. Pinning a genuine proxy property in the patched browser is teaching to the test.

The sandbox has to work on UNPATCHED Chromium -- a real user
runs scramjet in a stock browser -- so a divergence closed by a patch in
this tree is closed only here. The resource-timing pins in rule 109 split
two ways and the distinction was not drawn at the time:

- Harness artifacts, legitimately pinned. `navigationId` counts THIS
  harness's extra navigations. `timing_allow_passed` was the replayer
  failing to set a flag the real network service sets. Neither exists for
  a real user.
- Proxy properties, masked rather than fixed. `deliveryType: "cache"`
  because a service worker answered. `contentEncoding: ""` because that
  worker hands over decoded bytes. `transferSize: 0` for any service
  worker response. `encodedBodySize` being the rewritten script's size.
  Every one of those is true on stock Chrome and a live server sees it.

The second group belongs in scramjet, as traps reporting the upstream
values -- which is what `crossOriginIsolated` (rule 126) got right, and the
reason it is the right shape: it works on an unpatched browser.

<a id="131"></a>

### 131. A replay that serves decoded bytes must not claim an encoding.

The
recorder drains the body the network service hands it, which has already
been un-brotli'd, and stores the headers that came off the wire beside it
-- 21 of rateyourmusic's 97 recorded responses say `content-encoding:
br|gzip|zstd`. Replaying that header verbatim serves identity bytes under
a name that is not identity, and
`PerformanceResourceTiming.contentEncoding` then read "br" on the oracle
against "" on the sandbox, whose service worker never had an encoding to
report either.

    That divergence was PINNED in Blink, which is the wrong place twice over:
    it changed what the oracle tells a page (the one thing this project cannot
    do, since the oracle's job is to be an ordinary browser), and it left the
    replay internally inconsistent -- `content_length` was already the decoded
    length beside a header claiming compression.

    `MakeHead` now strips `Content-Encoding`. The pin is gone from
    `performance_resource_timing.cc`, the oracle reports "" because that is
    what it is actually serving, and a full run is unchanged otherwise: 12
    buckets before and after.

<a id="139"></a>

### 139. "Is there a guest frame on the stack" is the right question for a timer and the wrong one for a clock read.

Rule 113 fixed timer attribution by
widening the test from "is the top frame the shim" to "is there guest code
anywhere below" -- a timer scheduled beneath a guest frame is the guest's.
Applying the same widening to `performance.now()` looked obviously right
and was wrong: a clock read made BY the shim inside a guest-initiated task
is still the shim's.

Measured both ways in Cloudflare's Turnstile realm, which makes 2 guest
reads beside 99 of scramjet's:

    top-frame test     oracle 0.04, 0.06    sandbox 0.04, 0.06
    guest-frame test   oracle 0.04, 0.06    sandbox 1.96, 2

The shim's 99 reads ran the counter ahead of the page's. Reverted; the
comment in `Performance::now()` keeps the measurement so the next person
does not try it again.

It also settles a hypothesis that looked strong: the payload samples the
pointer path on a 10 ms `performance.now()` throttle, so a divergent clock
would mean a divergent array -- but the clock already agrees, read for
read. Whatever is left in those bodies, it is not this.

<a id="140"></a>

### 140. The replay diff is a proxy; the live challenge is the acceptance test.

> **Amended by [#143](FINDINGS.md#143).** "No longer loops" was too strong: it loops, visibly.

With the fixes in rules 130-138 in place, the sandbox against the LIVE
Cloudflare endpoint no longer loops. It used to answer five cycles of
`GET https://rateyourmusic.com/ -> 403`. Now:

403 GET rateyourmusic.com/ the challenge every visitor gets
200 GET .../orchestrate/chl_page/v1
200 GET turnstile/v0/.../api.js 86603b
200 POST .../fo/... 113772b payload accepted
200 GET turnstile/f/av0/... widget loads
200 POST .../fo/... 822840b payload accepted
ERR GET brunhild... TypeError: fetch failed
401 GET .../pat/... 200 GET .../ci/...
200 POST .../fo/... 127232b payload accepted

One 403, which is the challenge being issued rather than the challenge
being failed, and then the whole flow proceeds.

And `brunhild.challenges.cloudflare.com` fails LIVE, in an ordinary browser
too -- which is what rule 136's recording had captured as a 200 with
nothing in it.

AMENDED by rule 143. "No longer loops" was too strong: it loops, and the
loop is visible in a cookie rather than in the request log. What is true is
that the challenge now runs to completion and its payloads are accepted,
where before it never got that far.

<a id="141"></a>

### 141. A live transport that is not the browser's answers a different question.

The `--live` path handed the URL to NODE, which did the DNS,
the TLS and the HTTP. That is enough for "does scramjet load this site" and
useless for "does this site's anti-bot accept the sandbox", and the
difference is not theoretical:

403 GET rateyourmusic.com/ the challenge
403 GET rateyourmusic.com/ sent[cf_clearance,cf_chl_rc_ni]
200 GET challenges.cloudflare.com/...
403 GET rateyourmusic.com/ sent[cf_clearance,cf_chl_rc_ni]

The sandbox SOLVED the challenge and was issued a `cf_clearance` cookie --
which is the whole point of the exercise -- and then got 403 on every
request that presented it. A clearance is bound to the handshake of the
client that earned it, and that client was Node. The same path failed all
of `brunhild.challenges.cloudflare.com` with `TypeError: fetch failed`,
which an ordinary browser also fails (rule 136) but for its own reasons.

Removed, not kept as a diagnostic: a measurement that reads as a failure
when the thing being measured succeeded is worse than no measurement.
`--blink` fetches through the browser being measured, so both sides present
one network stack.

<a id="146"></a>

### 146. The differ served a bundle, not the source.

The scramjet harness mounts
`packages/core/dist`, and neither `rym.sh` nor `pnpm sbxdiff` built it.
A source change that was never built therefore measured as "no divergence"
-- the strongest result the differ can report, and a lie. It was caught by
accident: reverting the `window.name` fix produced a run identical to the
fixed one, which is not a thing a real revert does.

`regress.sh` had it right all along (`pnpm build` before every case), which
is why the regression suite was never affected. `rym.sh` now builds too;
`SBXDIFF_NO_BUILD=1` skips it when the bundle is known current.

The general form: anything that reads a build artifact has to be told how
the artifact is produced, or it will keep answering questions about an
older version of the thing under test.

<a id="155"></a>

### 155. A renamed attribute is the attribute, not a copy of it.

The rewriter
moves an attribute the browser would otherwise act on -- `nonce` above
all, CSP consumes it -- into `scramjet-attr-<name>`, and `getAttribute`
and the IDL property both answer from the alias. Every ENUMERATION just
dropped the alias and put nothing back, so the attribute was simply gone:

    attributes.length        2  vs  1
    getAttributeNames()      nonce,src  vs  src
    hasAttribute("nonce")    true  vs  false
    getAttribute("nonce")    sbxdiffnonce  vs  sbxdiffnonce

Cloudflare walks the map. Its element-tree fingerprint is the tag plus the
first letters of each attribute, and on rateyourmusic the two sides fed
the compressor 140 characters against 158:

    oracle   ...met_ht_co   >...>scr_sr      >...>scr_no
    sandbox  ...met_ht_co_sc>...>scr_sc_sc_sr>...>scr_sc_sc

Found by capturing what the payload pipeline reads (#150), not by reading
the shim: `getAttributeNames` had a filter and looked right.

So the alias is renamed BACK rather than hidden, unless the real attribute
is present too -- `src` keeps its rewritten value beside the alias, and
surfacing both would report `src` twice. `Attr.name`, `hasAttribute`,
`item()`, the indexed getter, `length` and `ownKeys` all go through it,
and `ownKeys` reports contiguous indices because a map with a renamed
attribute at native index 1 must still look like 0,1,2 from outside.

What is left is ORDER: the alias does not sit where the attribute sat, so
`nonce src` enumerates as `src,nonce`. That is the rewriter's emission
order, not something the shim can recover -- the authored position is not
written down anywhere. `pages/attrmap.html` reports it rather than
baselining it.

<a id="159"></a>

### 159. Hiding an attribute from the enumeration APIs does not remove it from the DOM.

`#158` made `scramjet-injected` and `scramjet-attr-script-source-src`
invisible to `getAttributeNames`, `element.attributes`, `hasAttribute` and
`getAttribute` -- `pages/attrmap.html` walks every element and finds no
attribute name matching `scramjet` anywhere. The payload disagrees. With a
clean build, Cloudflare's element-tree fingerprint still reads:

    oracle   ...met_ht_co   >...>scr_sr      >...>scr_no
    sandbox  ...met_ht_co_sc>...>scr_no_sc_sr>...>scr_no_sc

Same number of elements, one extra attribute on three of them, every one
starting `sc`. So the challenge is not reading through any API the shim
covers. The attributes are REALLY THERE, in the tree, and something that
serialises rather than enumerates -- `outerHTML`, or the markup itself --
sees them.

The lesson is about the shape of the fix, not the coverage. A shim can
make an attribute invisible to the functions it wraps; it cannot make the
element not have it. Anything the browser serialises natively, and any API
nobody thought to wrap, still reports it. For a name that must not exist,
the attribute has to go: `scramjet-injected` is a marker and could be a
WeakSet, `scramjet-attr-script-source-src` is storage and could be a
WeakMap. That is a real change to the rewriter's output, not a shim.

Recorded rather than attempted: it is the correct fix and it is larger
than the one it replaces.

<a id="166"></a>

### 166. Ladybird passing is the reference this project should be measuring against.

Every instrument here answers "does the sandbox differ from
Chromium", and that question has a floor: Ladybird clears the challenge
while refusing `eval` under CSP, failing to load `brunhild`, and stubbing
dozens of IDL interfaces. Chromium-difference is therefore the wrong
metric, and a large part of one session went into fields a passing browser
would also get "wrong".

The cheap version needs no Ladybird patching: serve the deobfuscated,
`__cfTrace`-instrumented challenge from `.traces/rym-store-cf` over plain
HTTP and let the plaintext land in its console log. Then the payload is a
three-way diff -- Chromium oracle, scramjet sandbox, Ladybird -- and each
field gets a RANGE instead of a single reference point.

Run it with the JIT off as well. LibJS's JIT changes stack shapes and
timing, which are exactly the two payload areas hardest to reason about
from here: `Error.stack` frames are in the payload, and the timing fields
are the 92%. A JIT-off run that still passes is direct evidence those
fields are not load-bearing.

<a id="168"></a>

### 168. Sec-Fetch belongs to the network service, and that is where the proxy's values have to be put back.

#167 measured the sandbox announcing
`dest: empty`, `mode: cors`, `site: cross-site` on every upstream request.
Scramjet computes the right values and `fetch()` drops them, the family
being forbidden.

      The first attempt restored them in `ResourceFetcher` beside `Cookie`, and
      every upstream fetch died with `TypeError: Failed to fetch`. The cause is
      not what it looks like: it is NOT that custom headers make the request
      preflighted -- four prefixed headers already worked. The network service
      refuses Sec-Fetch-\* that came from a renderer, and rightly so. Diagnosing
      that wrongly would have meant redesigning a carrier that was fine.

      So the three pieces sit where they belong. The transport carries
      `x-sbxdiff-h-sec-fetch-*` as ordinary custom headers; `ResourceFetcher`
      explicitly SKIPS that family while restoring the others; and
      `SbxdiffApplyProxyFetchMetadata` in `services/network/sec_header_helpers.cc`
      applies them immediately after `SetFetchMetadataHeaders` computes its own
      -- the layer that owns these headers, correcting its own output rather
      than fighting it.

      Measured live, healthy run (107 client inits, 899 challenge requests):

          dest   empty x all      ->  script 111, empty 64, serviceworker 14,
                                      document 7, image 7
          mode   cors x all       ->  no-cors 151, cors 34, same-origin 14,
                                      navigate 12
          site   cross-site x all ->  same-origin 165, none 37, cross-site 9

      A distribution, which is what a browser produces. `cf_clearance` is still
      not issued, so this was necessary and is not sufficient.

      Check the HEALTH counts before reading any live diff: `already

intercepted`near 107 and`cdn-cgi/challenge` in the hundreds. The broken
run produced a log that looked fine and a wire diff that reported
everything matching, because it was comparing Chrome's idle traffic to
itself.

<a id="171"></a>

### 171. An attribute selector reads the real attribute, so renaming one to neutralise it hides the element from `querySelector`.

Scramjet stopped
the browser applying a `<meta http-equiv="content-security-policy">` by
renaming `http-equiv` and keeping the original in the alias. Every
accessor un-aliases, so `getAttribute` and `outerHTML` both read back
correctly -- and `querySelector('meta[http-equiv="content-security-policy"
i]')` still found the element in the oracle and null in the sandbox, on a
page that plainly has one. Selectors do not go through the shims.

    Taking `content` away instead is the edit the browser ignores outright:
    `HTMLMetaElement::ProcessHttpEquiv` returns before parsing anything when
    the content attribute is null. An EMPTY one will not do -- that parses to
    a policy with no directives, which forbids nothing but is still a policy
    the window is handed.

    Generally: an alias is invisible to CSS. Anything a page can select on has
    to be true of the REAL attribute.

<a id="236"></a>

### 236. Reported is not gated, and a count nothing reads is a count nobody has.

`TOOLS.md` said the store's three lenienices -- past-the-end, near
match, sandbox-only miss -- were "counted and reported so they never pass as
clean". The counting was real and the conclusion was not: the exit code was
computed from buckets, bodies, extra-realm findings and structural errors, and
from none of those three. A run with a past-the-end hit passed.

Each of them is replay answering a request it cannot grade, which is the exact
case the gate exists to catch, so the fix is one term in the exit expression.
But the general form is what to keep: **anything documented as a safeguard must
appear in the exit condition, or it is documentation of an intention.** The
same trap caught `sbxread.py` (PROGRESS.md, "The second reader could not read")
and the guest-op recorder's silent non-install, which the run now says out loud
for the same reason.

Shared misses stay informational, and that distinction is the point rather than
an exception: a URL NEITHER side could find is a gap in the recording, a fact
about the store. Only a divergence between the two sides is a finding about the
sandbox.

---

## Index

All 236 by number. The list below stops at 219; entries 220-236 are in
[FINDINGS.md](FINDINGS.md) and RULES.md and are not indexed here yet. `F` marks an entry that lives in
[FINDINGS.md](FINDINGS.md); the rest are here.

- ` ` [1](RULES.md#1) — The value serializer must never run page JS.
- ` ` [2](RULES.md#2) — Never serialize object contents or own-key lists.
- ` ` [3](RULES.md#3) — Never write anything to a page object, and assign ids lazily.
- ` ` [4](RULES.md#4) — Do not add CDP to the record/replay path.
- ` ` [5](RULES.md#5) — Compare literally.
- ` ` [6](RULES.md#6) — `diffClass` classifies, it never normalizes.
- ` ` [7](RULES.md#7) — T0 is never suppressible.
- ` ` [8](RULES.md#8) — Bucket on `(scriptId, fnName)`, never line/col.
- ` ` [9](RULES.md#9) — Every new interceptor goes through `client.Intercept` / `client.proxyObject`.
- ` ` [10](RULES.md#10) — Guest-op brackets are token-returning, not depth-balanced.
- ` ` [11](RULES.md#11) — Never use a raw `ScopedTimeClockOverrides`.
- ` ` [12](RULES.md#12) — Enable virtual time on exactly one thread.
- ` ` [13](RULES.md#13) — Never let the oracle silently ignore an input.
- ` ` [14](RULES.md#14) — A replay miss is a divergence, not an error.
- ` ` [15](RULES.md#15) — Never trust a build's reported exit status; grep the log.
- ` ` [16](RULES.md#16) — Wrapping an installed V8 callback pointer means updating the context snapshot reference tab…
- ` ` [17](RULES.md#17) — Every determinism claim needs N identical runs, not two that agree.
- ` ` [18](RULES.md#18) — When replacing a mechanism, the gate must run without the old one.
- ` ` [19](RULES.md#19) — When a bisect comes back negative on every arm, find the input you never varied.
- ` ` [20](RULES.md#20) — Determinism gates must run a multi-process page.
- ` ` [21](RULES.md#21) — Record gate results in `PROGRESS.md` as they are measured
- ` ` [22](RULES.md#22) — "Invisible to reflection" is not "no observable effect."
- ` ` [23](RULES.md#23) — Check the build config of any binary you use as a control.
- ` ` [24](RULES.md#24) — Anything true only of Chromium 155 goes in `PINNED_ASSUMPTIONS.md`
- ` ` [25](RULES.md#25) — A successful load proves nothing about where the bytes came from.
- ` ` [26](RULES.md#26) — Code that compiles and is correct can still never run.
- ` ` [27](RULES.md#27) — In the sandbox, the binding layer is not the guest-observable layer.
- ` ` [28](RULES.md#28) — A baseline hides a regression in anything already diverging.
- ` ` [29](RULES.md#29) — Reset every piece of task-scoped state wherever the task id changes.
- ` ` [30](RULES.md#30) — A sandbox's network egress is not visible to a URLLoader interceptor.
- ` ` [31](RULES.md#31) — V8 script ids are per-isolate; namespace them before merging traces.
- ` ` [32](RULES.md#32) — Attribute a native call by the TOP stack frame, not the task's entry.
- ` ` [33](RULES.md#33) — A sandbox's own bootstrap must run on the real clock.
- ` ` [34](RULES.md#34) — Never let the driver's own URLs contain the thing a flag matches on.
- ` ` [35](RULES.md#35) — Prove a clock is pinned by reading it, not by the run succeeding.
- ` ` [36](RULES.md#36) — A process-wide clock override freezes threads that cannot advance it.
- ` ` [37](RULES.md#37) — Under `kAdvance`, every real I/O wait becomes nondeterministic virtual time.
- ` ` [38](RULES.md#38) — Do not inherit virtual-time pausers created before the clock existed.
- ` ` [39](RULES.md#39) — When a hang has no error, log which resource holds the lock, not the count.
- ` ` [40](RULES.md#40) — Pausing virtual time must stop the clock, not the page, when the page is in its own load pa…
- ` ` [41](RULES.md#41) — Key a network store on URL AND ordinal.
- ` ` [42](RULES.md#42) — A store must record WHEN it was captured.
- ` ` [43](RULES.md#43) — Log replay misses where the miss happens.
- ` ` [44](RULES.md#44) — A recorded response is its headers, not just its bytes.
- ` ` [45](RULES.md#45) — Record redirects; do not follow them silently.
- ` ` [46](RULES.md#46) — Do not normalise a key you do not understand.
- ` ` [47](RULES.md#47) — Per-request state that survives a restart must not live on the factory.
- ` ` [48](RULES.md#48) — Measure the oracle against itself before believing a bucket.
- ` ` [49](RULES.md#49) — Key a baseline by what it was recorded against.
- ` ` [50](RULES.md#50) — A service worker does not get the browser's network-layer behaviour.
- ` ` [51](RULES.md#51) — Fence one side, not both.
- ` ` [52](RULES.md#52) — A shim must not spend the guest's randomness.
- ` ` [53](RULES.md#53) — WebIDL substitutes the global for a null receiver; a shim must too.
- ` ` [54](RULES.md#54) — Make the sandbox's store exactly as permissive as the oracle's.
- ` ` [55](RULES.md#55) — A shim that calls the native without a receiver posts to itself.
- ` ` [56](RULES.md#56) — Select the guest realm by the target page, not by record count.
- ` ` [57](RULES.md#57) — Emulate a browser behaviour at the scope the browser applies it.
- ` ` [58](RULES.md#58) — Key a baseline by the page, not just the origin.
- ` ` [59](RULES.md#59) — Virtual time starves a frame created late.
- ` ` [60](RULES.md#60) — A same-process iframe has no widget of its own, so a frame-targeted click lands in the main…
- ` ` [61](RULES.md#61) — An anti-bot payload is not reproducible across runs, so the recording is the wrong thing to…
- ` ` [62](RULES.md#62) — Input has to land in the same place in both runs, and a frame-targeted click lands in neith…
- ` ` [63](RULES.md#63) — The guest frame must BE the viewport, and nothing may resize it after the page starts.
- ` ` [64](RULES.md#64) — A service worker does not intercept subresources from an about:blank frame, and rewriting t…
- ` ` [65](RULES.md#65) — Realm ids are per-isolate, so they collide across trace files — and realm is what the compa…
- ` ` [66](RULES.md#66) — An instrument behind an environment variable is an instrument that is off.
- ` ` [67](RULES.md#67) — The native trace is not what the guest sees.
- ` ` [68](RULES.md#68) — A sandbox that cannot have virtual time still needs the same clock ORIGIN.
- ` ` [69](RULES.md#69) — A CSS property is a NAMED property, so only a Proxy can see it.
- ` ` [70](RULES.md#70) — Injecting "at position 0" of a document puts you in front of the DOCTYPE, which is what cau…
- ` ` [71](RULES.md#71) — Positional pairing loses its place, and a tier it cannot support is worse than no tier.
- ` ` [72](RULES.md#72) — A CSS selector does not go through `getAttribute`, so a rewritten attribute is invisible to…
- ` ` [73](RULES.md#73) — The oracle was not deterministic, and the two clocks it has are not the same clock.
- ` ` [74](RULES.md#74) — `crypto.getRandomValues` is not the only RNG a page can reach.
- ` ` [75](RULES.md#75) — A clamped timestamp is not a rounded timestamp, and the difference is the whole of its nond…
- ` ` [76](RULES.md#76) — Randomness a page cannot READ is still randomness a page SENDS.
- ` ` [77](RULES.md#77) — Give every pinned draw its own keystream.
- ` ` [78](RULES.md#78) — A hash says two bodies differ; it cannot say how, and the how is the diagnosis.
- ` ` [79](RULES.md#79) — `--sbxdiff-virtual-time-after` does not defer virtual time in a renderer that can never see…
- ` ` [80](RULES.md#80) — A probe that runs only in the main frame proves nothing about a page that does its work els…
- `F` [81](FINDINGS.md#81) — The sandbox hangs under virtual time on BOTH policies, and the deferral bug was not the rea…
- ` ` [82](RULES.md#82) — The tracer is a BINDINGS tracer, so V8 builtins are a blind spot.
- ` ` [83](RULES.md#83) — A fix keyed on PROCESS TOPOLOGY is asymmetric between the two sides by construction.
- ` ` [84](RULES.md#84) — The counter clock cannot be made symmetric, and rule 82 is why.
- ` ` [85](RULES.md#85) — Replay cannot reproduce the live failure, because the thing that fails is the SERVER's answ…
- `F` [86](FINDINGS.md#86) — Cloudflare's challenge worker is a hardware-throughput benchmark, and the sandbox scores di…
- `F` [87](FINDINGS.md#87) — The widget FRAME is where the fingerprint is taken, and it is a different realm from both t…
- ` ` [88](RULES.md#88) — An explicit keystream's counter is per THREAD, and the two sides do not put the same realms…
- ` ` [89](RULES.md#89) — Any counter the two sides share has to be anchored to a REALM, and this is the shape of nea…
- ` ` [90](RULES.md#90) — Some divergences are the sandbox, and pinning them would be lying.
- ` ` [91](RULES.md#91) — Resetting a process-global counter at a per-realm event does not align it, and the ICE ufra…
- ` ` [92](RULES.md#92) — The patch set was incomplete for months and every check passed.
- `F` [93](FINDINGS.md#93) — Pinning the shim's cost does not make the diff pass, so the question of whether to pin it w…
- ` ` [94](RULES.md#94) — An ORACLE-side hang is always a Chromium patch, because the oracle runs no proxy code.
- ` ` [95](RULES.md#95) — Test the recipe the goal names, not the variant that is convenient.
- ` ` [96](RULES.md#96) — The two sides' stores do not have the same matching rules, and the leniency is on the sandb…
- ` ` [97](RULES.md#97) — `sendBeacon` does not reach the replay interceptor.
- `F` [98](FINDINGS.md#98) — Every remaining blocker on rateyourmusic reduces to one thing: the two sides' `Date.now()`…
- `F` [99](FINDINGS.md#99) — A timer-driven logical clock does not converge either, because the two sides do not run the…
- `F` [100](FINDINGS.md#100) — The last `HTMLCollection.length` divergence is a parser position, not a collection.
- `F` [101](FINDINGS.md#101) — Attributing a timer by the TOP stack frame froze the sandbox's clock completely.
- `F` [102](FINDINGS.md#102) — One of the six divergent request bodies is three bytes of `Date.now()`, and that is the who…
- `F` [103](FINDINGS.md#103) — The oracle ran four renderers and the sandbox one, so anything the patches keep per PROCESS…
- `F` [104](FINDINGS.md#104) — A browser has one clock; the logical clock was a per-renderer stopwatch.
- ` ` [105](RULES.md#105) — Unwrap a callback before you judge it, and then the residual has a name.
- `F` [106](FINDINGS.md#106) — The last of the clock gap is a 550 ms poll that needs five more rounds under the proxy.
- `F` [107](FINDINGS.md#107) — The clock gap was the harness clicking too early, and the poll was measuring it. **(superseded)**
- `F` [108](FINDINGS.md#108) — The browser's own UI was advancing the page's clock, and closing that made a request body b… **(superseded)**
- `F` [109](FINDINGS.md#109) — Capture the payload's PLAINTEXT and the field names are just there.
- `F` [110](FINDINGS.md#110) — The probe reached the end of what one realm can see.
- `F` [111](FINDINGS.md#111) — The store probe's reach ends at the store, and Cloudflare's detections run past it.
- `F` [112](FINDINGS.md#112) — Rule 108's byte-identical SecChk was one lucky run, and saying so is the correction that ma…
- ` ` [113](RULES.md#113) — A clock whose increments are read from itself is a function of the scheduler; chain them an…
- `F` [114](FINDINGS.md#114) — SecChk reproduces byte for byte, and this time it was checked properly.
- ` ` [115](RULES.md#115) — A probe that one side's CSP blocks reads exactly like a probe that found nothing.
- `F` [116](FINDINGS.md#116) — `PermissionStatus.name` is not the name you queried with, and that hid a real leak behind t…
- `F` [117](FINDINGS.md#117) — The differ was blind to every blob realm in the sandbox, which is where Cloudflare's detect…
- `F` [118](FINDINGS.md#118) — A Blob worker's own URL, under a proxy, carries no identity; the realm's does.
- `F` [119](FINDINGS.md#119) — What the detection worker was hiding: one poll round, hashed 5000 times.
- `F` [120](FINDINGS.md#120) — Virtual time was re-measured, not assumed, and it still does not work.
- `F` [121](FINDINGS.md#121) — The last divergence cannot be closed without redesigning the thing under test, which is not…
- `F` [122](FINDINGS.md#122) — Live, the sandbox loops and the oracle passes -- and that is now a fair comparison.
- `F` [123](FINDINGS.md#123) — --strict-bodies plus a plaintext probe is a working loop, and it walks the failure forward…
- `F` [124](FINDINGS.md#124) — Per-realm clocks, measured: they fix what they were aimed at and do not finish the job.
- `F` [125](FINDINGS.md#125) — `internal-cf` already had the instrument sbxdiff could not build.
- `F` [126](FINDINGS.md#126) — sbxdiff could see it all along; the diff was never pointed at the realm that mattered.
- ` ` [127](RULES.md#127) — A bucket key carries no magnitude, so the noise floor was hiding a thirteenfold divergence…
- ` ` [128](RULES.md#128) — Pinning a genuine proxy property in the patched browser is teaching to the test.
- `F` [129](FINDINGS.md#129) — A getter override does not change what `toJSON` emits, and the payload reads the JSON.
- `F` [130](FINDINGS.md#130) — The rewriter's sourcemap is enough to report the size the SITE served.
- ` ` [131](RULES.md#131) — A replay that serves decoded bytes must not claim an encoding.
- `F` [132](FINDINGS.md#132) — A proxy's DOCUMENT has no sourcemap, so its size has to travel.
- `F` [133](FINDINGS.md#133) — The proxy's heap is on the guest's heap, and subtracting a measurement beats pinning a cons…
- `F` [134](FINDINGS.md#134) — A getter that falls back reads the field a constructor did not collapse.
- `F` [135](FINDINGS.md#135) — "0 T0 leaks" was a statement about 2% of the run.
- `F` [136](FINDINGS.md#136) — An empty mime type is not a `Content-Type:` header, and a failed request is not a 200.
- `F` [137](FINDINGS.md#137) — A timer id is a per-document counter, and the shim was spending it.
- `F` [138](FINDINGS.md#138) — The request bodies cannot be byte-identical, and the source says why.
- ` ` [139](RULES.md#139) — "Is there a guest frame on the stack" is the right question for a timer and the wrong one f…
- ` ` [140](RULES.md#140) — The replay diff is a proxy; the live challenge is the acceptance test. **(superseded)**
- ` ` [141](RULES.md#141) — A live transport that is not the browser's answers a different question.
- `F` [142](FINDINGS.md#142) — A `dbg` argument is invisible in a headless log, and the noisiest error was scramjet's own…
- `F` [143](FINDINGS.md#143) — `cf_chl_rc_ni` is the live pass/fail signal, and the widget error is downstream of it.
- `F` [144](FINDINGS.md#144) — The one thing in an ICE candidate the PRNG could not reach was the port.
- `F` [145](FINDINGS.md#145) — Six of the seven deleted Navigation API names were not load-bearing.
- ` ` [146](RULES.md#146) — The differ served a bundle, not the source.
- `F` [147](FINDINGS.md#147) — Hooking `Object.keys` reaches inside the payload; the first difference is not the only one.
- `F` [148](FINDINGS.md#148) — A frame id in `window.name` accumulated, and the shim handed the page the accumulation.
- `F` [149](FINDINGS.md#149) — The Navigation API needed a shim, and the shim is three URLs.
- `F` [150](FINDINGS.md#150) — The payload plaintext is reachable without lifting the challenge.
- `F` [151](FINDINGS.md#151) — `Error.stackTraceLimit` was raised for the guest and never put back.
- `F` [152](FINDINGS.md#152) — What the plaintext diff has left.
- `F` [153](FINDINGS.md#153) — A long animation frame names its scripts by URL, and nothing corrected them.
- `F` [154](FINDINGS.md#154) — Two harness instances contend, and the symptom looks like a slow build.
- ` ` [155](RULES.md#155) — A renamed attribute is the attribute, not a copy of it.
- `F` [156](FINDINGS.md#156) — The payload's plaintext is readable by DEOBFUSCATING rym's own recording.
- `F` [157](FINDINGS.md#157) — 92% of the remaining body divergence is the sandbox being slower, and it is not a leak.
- `F` [158](FINDINGS.md#158) — Two of scramjet's attributes are its own, and one of them hid from every filter.
- ` ` [159](RULES.md#159) — Hiding an attribute from the enumeration APIs does not remove it from the DOM.
- `F` [160](FINDINGS.md#160) — The challenge is rewritten 234 times, and 159 of those are `eval`.
- `F` [161](FINDINGS.md#161) — Ladybird passes rym, and that is the reference the project lacked.
- `F` [162](FINDINGS.md#162) — One API-surface divergence in 1156 enumerated members, and it belongs to the harness.
- `F` [163](FINDINGS.md#163) — `unrewriteHtml` restored every alias and deleted all but one.
- `F` [164](FINDINGS.md#164) — The Blink transport cannot complete a cookie challenge, by construction.
- `F` [165](FINDINGS.md#165) — The differ had no request-header comparison, and the obvious place to add one compares diff…
- ` ` [166](RULES.md#166) — Ladybird passing is the reference this project should be measuring against.
- `F` [167](FINDINGS.md#167) — The sandbox tells Cloudflare it is a cross-site CORS fetch with no destination.
- ` ` [168](RULES.md#168) — Sec-Fetch belongs to the network service, and that is where the proxy's values have to be p…
- `F` [169](FINDINGS.md#169) — The proxy announced an Origin where a browser announces none.
- `F` [170](FINDINGS.md#170) — A page under the proxy could read its own nonces, because scramjet strips the policy that m…
- ` ` [171](RULES.md#171) — An attribute selector reads the real attribute, so renaming one to neutralise it hides the…
- `F` [172](FINDINGS.md#172) — The `NamedNodeMap.length` bucket on the brunhild store is the shim reading its own map, not…
- `F` [173](FINDINGS.md#173) — `location`'s members are unforgeable, and the probe that found this was trying to measure s…
- `F` [174](FINDINGS.md#174) — Identical bytes in, identical execution, different decision -- the challenge's choice to re…
- `F` [175](FINDINGS.md#175) — The clearance cookie is issued AND sent back, and the page is still 403.
- `F` [176](FINDINGS.md#176) — The live failure has a name: the Turnstile widget fails with `600010`, and never reaches "S…
- `F` [177](FINDINGS.md#177) — A field serialised by `toJSON` is invisible to the differ, and the harness's clock hides re…
- `F` [178](FINDINGS.md#178) — A rewritten script reported the wrong line AND column, and Cloudflare collects both.
- `F` [179](FINDINGS.md#179) — Stack columns are correctable in TypeScript, and the first attempt failed silently for a re…
- `F` [180](FINDINGS.md#180) — Diff the widget realm scoped to ONE realm, not with `--all-realms`.
- `F` [181](FINDINGS.md#181) — TLS was NOT ruled out. The earlier experiment tested the wrong client.
- `F` [182](FINDINGS.md#182) — The wire fingerprint is Chromium's now, and the challenge still fails.
- `F` [183](FINDINGS.md#183) — `pages/tlsfp.html` was losing the half of the record that matters, and HTTP header order is…
- `F` [184](FINDINGS.md#184) — Chrome's request header order is not one sequence -- it depends on which headers are presen…
- `F` [185](FINDINGS.md#185) — The whole wire is Chromium's now, and Turnstile still says 600010.
- `F` [186](FINDINGS.md#186) — The oracle only passes with the CLICK, and a control without it proves nothing.
- `F` [187](FINDINGS.md#187) — The sandbox is not uniformly slow, and the one benchmark Cloudflare is known to take is the…
- `F` [188](FINDINGS.md#188) — The passing side CAN be instrumented, with CDP, and that is how to read the challenge's pay…
- `F` [189](FINDINGS.md#189) — What the challenge actually sends, read off the passing side.
- `F` [190](FINDINGS.md#190) — The challenge's value fingerprint is identical on both sides -- 1308 names, zero difference…
- `F` [191](FINDINGS.md#191) — The same-origin boundary between two guest origins does not exist, and it is the largest di…
- `F` [192](FINDINGS.md#192) — Instrumented identically, the two widgets run the same protocol and get different verdicts.
- `F` [193](FINDINGS.md#193) — The enumeration payload is built AFTER the verdict, so its absence is a symptom.
- `F` [194](FINDINGS.md#194) — The serialised DOM payload is randomised per run; do not diff it.
- `F` [195](FINDINGS.md#195) — Cloudflare configures the challenge DIFFERENTLY for the sandbox, in the bytes it serves, be…
- `F` [196](FINDINGS.md#196) — The first request WAS capturable, and it differed in four ways.
- `F` [197](FINDINGS.md#197) — A navigation is a THIRD header order, and rule 148's table only had two.
- `F` [198](FINDINGS.md#198) — `Sec-Fetch-User` is user activation, and the proxy was telling half a lie without it.
- `F` [199](FINDINGS.md#199) — `accept-encoding` was the transport's, and it was an HTTP library's.
- `F` [200](FINDINGS.md#200) — `priority` is HTTP/2 only, and its value is not a function of the destination alone.
- `F` [201](FINDINGS.md#201) — `KbTG4` is served in the `orchestrate/chl_page/v1` response, not the interstitial, and it i… **(superseded)**
- `F` [202](FINDINGS.md#202) — The Referer was read too late, and the challenge's own token fell out of it. `KbTG4` is now…
- `F` [203](FINDINGS.md#203) — brunhild is not a divergence: it does not resolve, and it fails on both sides.
- `F` [204](FINDINGS.md#204) — Two guests that are cross-origin to EACH OTHER were not separated, and measuring it needs `…
- `F` [205](FINDINGS.md#205) — The payload plaintext is IDENTICAL, 41 fields out of 41.
- `F` [206](FINDINGS.md#206) — The widget's verdict is an INLINE STYLE, not a class, and the sandbox never reaches it. The…
- `F` [207](FINDINGS.md#207) — Timing is NOT the blocker, and the click is not what passes the challenge.
- `F` [208](FINDINGS.md#208) — The live payload sizes differ, and payload 3 is ~890 bytes SHORT.
- `F` [209](FINDINGS.md#209) — Filtering the sandbox's trace to guest scripts does NOT make it comparable, because a shimm… **(superseded)**
- `F` [210](FINDINGS.md#210) — The performance entry list is NOT the payload gap.
- `F` [211](FINDINGS.md#211) — Shim-side attribution, built -- and the guest is not reading less.
- `F` [212](FINDINGS.md#212) — The sandbox encodes a 907-byte `cf_clearance` blob into its payload and the oracle does not. **(superseded)**
- `F` [213](FINDINGS.md#213) — The 907-byte `cf_clearance` blob is downstream of the retry loop, not a cause of it.
- `F` [214](FINDINGS.md#214) — CORRECTS rule 212's "the big encodes agree". They agree in the WIDGET. In the interstitial… **(superseded)**
- `F` [215](FINDINGS.md#215) — A probe that hooks a global BEFORE scramjet snapshots it measures scramjet, and two correct…
- `F` [216](FINDINGS.md#216) — Payload 3 cannot be read without deobfuscating, and that is now established rather than ass…
- `F` [217](FINDINGS.md#217) — The oracle's interstitial builds a 29 KB value fingerprint at t=208 ms. The sandbox's never…
- `F` [218](FINDINGS.md#218) — `jsd/main.js` runs on the ORACLE'S INTERSTITIAL at t=181 ms and the sandbox never fetches i… **(superseded)**
- `F` [219](FINDINGS.md#219) — RETRACTS rule 218. `jsd` IS post-redemption, and rule 201 was right.
