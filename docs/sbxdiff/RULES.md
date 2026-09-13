# Rules

Invariants for anyone (human or agent) touching sbxdiff. Imperative on purpose. Each
rule exists because violating it either silently invalidates the oracle or silently
reintroduces a bug class we already paid for.

Companion to `.agents/skills/spec-lookup/SKILL.md`, which governs web-platform work in
this repo generally (ground changes in spec text; cross-check against WPT).

---

## The tracer must never be observable

1. **The value serializer must never run page JS.** No `ToString`, `ToNumber`,
   `ToDetailString`, `Get`, `Has`, `GetOwnPropertyNames`, `GetPropertyNames`,
   `GetOwnPropertyDescriptor`, `GetRealNamedProperty`, `JSON::Stringify`, `Delete`, or
   `GetPrototype`/`GetPrototypeOf` (the last traps on a Proxy). This is enforced
   mechanically, not by review: the encoder body runs inside
   `v8::Isolate::DisallowJavascriptExecutionScope(isolate, kCrashOnFailure)` in DCHECK
   builds. **Do not weaken that scope to make a value serialize.**
2. **Never serialize object contents or own-key lists.** Encode
   `{type_tag, object_id, interface_name | constructor_name, shape_hints}` and nothing
   more. Enumerating keys can trip a Proxy trap, and scramjet hands the guest many
   Proxies. It is also the wrong semantics — the page's own access sequence is the
   signal, and we already capture that exhaustively.
3. **Never write anything to a page object, and assign ids lazily.** Identity comes
   from the `ScriptWrappable` behind a DOM wrapper — read-only (see #22 for what
   happened when it was not). Still assign only when a value is actually written into
   a `level==0` record: eager assignment costs a map lookup and an allocation on every
   wrapper the page touches.
4. **Do not add CDP to the record/replay path.** `Runtime.addBinding` adds an enumerable
   own property to the global; `Runtime.enable` makes `console` eagerly serialize
   arguments, which _invokes page getters_; `--remote-debugging-pipe` sets
   `navigator.webdriver = true`. Everything the harness needs has a verified non-CDP
   path — see plan §10.

## The differ must not launder divergences

5. **Compare literally.** Never run scramjet's un-rewrite functions over a value before
   comparing it. The un-rewritten value _is_ the bug.
6. **`diffClass` classifies, it never normalizes.** It runs strictly _after_ literal
   comparison has already failed, and only picks a bucket. Enforce this with types: the
   bucketer takes a `Divergence`, not two `Value`s.
7. **T0 is never suppressible.** Host origin, `/~/sj/`, controller ids, cross-site
   cookies, a real `top`/`parent`/`location`/`eval` reaching the guest, chrome-realm
   objects, and cross-origin access-check outcome divergences always abort. No
   allowlist, no baseline entry.
8. **Bucket on `(scriptId, fnName)`, never line/col.** Minified bundles shift columns
   between loads and scramjet's rewrite shifts them systematically.

## Sandbox-side

9. **Every new interceptor goes through `client.Intercept` / `client.proxyObject`.**
   Never a bespoke `Object.defineProperty` or a raw `new Proxy`. That is precisely how
   `client/dom/element.ts:154-184` became the largest URL-leak surface in the system
   _and_ invisible to the `missing-interceptor` heuristic — it never populated
   `descriptors.store`. A lint rule for this is cheaper than the next blind spot.
10. **Guest-op brackets are token-returning, not depth-balanced.** Per-instance
    `RawTrap`s (e.g. `xmlhttprequest.ts:79-113`) are installed _inside_ an apply
    handler, so bracket nesting is re-entrant.

## Determinism

11. **Never use a raw `ScopedTimeClockOverrides`.** Nested overrides are forbidden; go
    through `ProcessTimeOverrideCoordinator::CreateOverride`. And pass **all five**
    clock functions — the existing call site leaves `ThreadTicks`, `LiveTicks` and
    `TimeTicks::LowResolutionNow` on the real clock.
12. **Enable virtual time on exactly one thread.** `TryAdvancingTime` takes the min
    across registered clients, so a second registrant can pin the clock forever.
13. **Never let the oracle silently ignore an input.** FIVE instances now, the last
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

14. **A replay miss is a divergence, not an error.** Emit `net_replay_miss` at
    `level==0`. Never fall through to the real network (that silently breaks
    hermeticity) and never abort the process (you lose _why_ the sandbox asked).

## Process

15. **Never trust a build's reported exit status; grep the log.** `autoninja ... | tail`
    reports `tail`'s status, so a failed build looks clean. Redirecting and checking
    `$?` is _also_ not enough for a backgrounded build: the job's exit code is that of
    the last command in the chain (an `echo` will happily return 0 over a failed
    build). Both have now happened here. The only reliable check is
    `grep -E "error:|FAILED|finished with an error" <log>`.
16. **Wrapping an installed V8 callback pointer means updating the context snapshot
    reference table too.** `v8_context_snapshot_generator` serializes the _installed_
    function pointers and resolves them against the per-interface
    `GetRefTableOfV8<Iface>()` tables; a pointer that is installed but absent from the
    table aborts the snapshot build with `Unknown external reference 0x...`. Only six
    interfaces participate (Document, EventTarget, HTMLDocument, Node, Window,
    WindowProperties) — and `WindowProperties` and `Window` are exactly the two with
    interceptors, so interceptor changes always hit this. Emit **both** the raw and the
    wrapped address: the table is a lookup, extra entries are free, and a superset
    cannot be wrong.
17. **Every determinism claim needs N identical runs, not two that agree.** The P4
    randomness gate was recorded as passing on a byte-identical _pair_; a 5-run loop
    later showed 3 distinct results. A passing pair cannot distinguish "deterministic"
    from "flaky". This also applies to intermittent behaviour generally: measure a
    rate, never a single instance — contradictory single runs of the worker hang
    produced two confidently stated and wrong mechanisms before a 5-run loop showed
    it was 5/5 deterministic _per configuration_.
18. **When replacing a mechanism, the gate must run without the old one.** The
    virtual-time gate passed while still passing `--virtual-time-budget`, so CDP's
    second budget grant silently covered a defect in the replacement: any
    `setTimeout(n>0)` never fired. More runs would not have caught it — the gate
    exercised the configuration being moved _away from_. This is a control-set gap,
    distinct from the sample-size gap in #17.
19. **When a bisect comes back negative on every arm, find the input you never
    varied.** Seven arms through the tracer all reproduced a crash; the cause was the
    _driver_ (`--dump-dom`/CDP vs the in-binary runner), which was constant in every
    arm including the control. A bisect cannot find a cause inside a variable it holds
    fixed. Twin of #18.
20. **Determinism gates must run a multi-process page.** Every gate here used a
    single-renderer page, and a single renderer cannot collide with itself — which is
    why a keyed-PRNG bug that gave _every_ renderer the same byte sequence (duplicate
    blob UUIDs, renderer killed) survived the whole suite and was found by the first
    real site. Process count is a variable; hold it at 1 and you cannot see
    cross-process collisions.
21. **Record gate results in `PROGRESS.md` as they are measured**, not afterwards.
22. **"Invisible to reflection" is not "no observable effect."** The tracer stored
    object ids in a `v8::Private` property on page objects. That was verified
    undetectable via `Object.keys`, symbols, proxy traps and cross-origin checks —
    all correct — and it still made Cloudflare Turnstile loop forever, because
    adding a property forces a hidden-class transition and can deoptimise inline
    caches, which a page times on its _own_ objects. **Never mutate a page object.**
    Identity for DOM wrappers comes from the `ScriptWrappable` behind them, free.
23. **Check the build config of any binary you use as a control.** A snapshot
    Chromium is not "stock Chromium" in the ways that matter for perf: the GN default
    would give it DCHECKs, but it overrides that off. Comparing our
    `dcheck_always_on = true` build against it made our bindings look 8x slow, which
    is a real finding only once both sides agree on DCHECKs. `strings -a <framework> |
grep -c current_process_commandline_` distinguishes them.
24. **Anything true only of Chromium 155 goes in `PINNED_ASSUMPTIONS.md`** with a check
    command. Several of these fail _silently_ on a roll.
25. **A successful load proves nothing about where the bytes came from.** Network
    replay passed a "server is down and the page still rendered" test while silently
    serving from HTTP cache. The test that has teeth is **tampering**: edit a stored
    response on disk, replay, and assert the page observes the edit. Apply this to
    any cache, store or replay layer — verify provenance, not success.
26. **Code that compiles and is correct can still never run.** `MaybeCreateSbxdiffNetObserver()`
    was never called; recording fell back to an older path that caught enough to make
    every spot-check pass while missing `fetch`/XHR and the navigation body. Spot-checks
    confirm a feature works _when invoked_. Prove it is invoked: count what the store
    holds against what the page actually requested, or assert the negative case.
27. **In the sandbox, the binding layer is not the guest-observable layer.** The
    shim and the guest share one realm, so a native's return value is what the
    _shim_ saw, not what the guest saw. Reading binding calls as guest-observable
    reported eight T0 "leaks" on a clean scramjet run, every one of them false --
    the native correctly reports a page that really is served from a proxied URL.
    Compare what the guest itself computed (a sink the probe page writes to), and
    keep the binding layer at a lower tier until guest-op brackets exist.
28. **A baseline hides a regression in anything already diverging.** Buckets key
    on `(tier, kind, api, diffClass)`, so an API that already has a bucket
    absorbs a _different_ divergence silently. That is what suppression is for
    and it is also a blind spot: pick regression targets that currently agree,
    and never treat "no new buckets" as "no change".
29. **Reset every piece of task-scoped state wherever the task id changes.** The
    entry-script id was cleared in `EnsureTaskOpen` but not in the two V8
    callbacks that also change `current_task_id_`, so a task would have been
    attributed to whoever entered the _previous_ one. Found by grepping every
    assignment to the task id rather than by testing -- the wrong attribution
    would have looked entirely plausible in a report.
30. **A sandbox's network egress is not visible to a URLLoader interceptor.**
    `--sbxdiff-net-replay` sits at `WillCreateURLLoaderFactory`, but scramjet
    reaches the internet over WebSocket frames to a wisp server, which never
    goes through a URLLoaderFactory. Replay for a sandbox has to be a _transport_,
    not a browser-side interceptor -- and a transport is also the only layer that
    sees the real upstream URL rather than the proxied one.
31. **V8 script ids are per-isolate; namespace them before merging traces.** A
    run produces one trace file per thread and each numbers scripts from 1, so
    merging with "first mapping wins" silently attributed the page's script 4 to
    the browser UI process's script 4. Every guest record in the sandbox looked
    like it was entered by `chrome://resources/lit/v3_0/lit.rollup.js`. The same
    applies to any per-isolate id.
32. **Attribute a native call by the TOP stack frame, not the task's entry.**
    "Who entered the task" sounds like the right question and is not: scramjet's
    controller enters essentially every task, so entry is shim even for guest
    code, and requiring it classified zero sandbox records as guest. The topmost
    frame being guest code is what means "no trap intervened", which is the
    property that makes a value guest-observable.
33. **A sandbox's own bootstrap must run on the real clock.** Virtual time
    enabled in `Page`'s constructor breaks service-worker registration --
    `kDeterministicLoading` never activates the worker and `kAdvance` activates
    it three times -- so the page under test never loads. Defer the clock to the
    realm being compared (`--sbxdiff-virtual-time-after`). Both sides enable at
    their own guest realm, which keeps them symmetric.
34. **Never let the driver's own URLs contain the thing a flag matches on.**
    `--sbxdiff-virtual-time-after` matches a URL substring, and the harness URL
    embedded the encoded target twice (`?sbxdiffStore=<url>#<url>`), so the
    harness page matched as the guest realm and turned virtual time on during
    bootstrap -- reintroducing the exact bug the flag existed to fix. The target
    is base64 in the hash now and the store is addressed by port.
35. **Prove a clock is pinned by reading it, not by the run succeeding.** "Virtual
    time silently never enabled" and "virtual time working" produce
    indistinguishable clean runs. `pages/clock.html` writes `Date.now()` through
    the sink; the 2023 date is what proves it, and it is what exposed the sandbox
    drifting ~100s per run while the oracle was exact.
36. **A process-wide clock override freezes threads that cannot advance it.**
    `ProcessTimeOverrideCoordinator` installs `ScopedTimeClockOverrides`
    process-wide, so enabling virtual time on the page freezes a service
    worker's clock too -- while leaving the worker unable to request
    advancement, because only registered clients can. Any thread whose work the
    page waits on must be a client, or the two deadlock. The coordinator is
    built for exactly this; the worker just was never registered.
37. **Under `kAdvance`, every real I/O wait becomes nondeterministic virtual
    time.** The clock jumps to the next delayed task whenever the run is idle,
    so real latency converts into virtual latency by an amount that varies per
    run. Removing real I/O from the measured path (preloading the network store)
    fixed the flakiness but not the drift -- only a pause-on-load policy can fix
    that, and it has to not deadlock first.
38. **Do not inherit virtual-time pausers created before the clock existed.**
    Enabling virtual time mid-load counts pausers from loads that started on the
    real clock, which stops the clock instantly -- and it never restarts,
    because pausing fences the queues those loads complete on. Record a baseline
    at enable and compare against it. Symptom: `virtual time STOPPED at +0ms`
    followed by nothing at all until teardown.
39. **When a hang has no error, log which resource holds the lock, not the
    count.** A pause _count_ going 1->0 says nothing about whether the run was
    stuck: that 0 arrived after a 30-second hang, at teardown, and reading it as
    a steady state sent me chasing three wrong theories. The pauser's debug name
    plus timestamps found it in one run. Match on a unique id, though -- names
    repeat, and a still-held pauser is masked by a later balanced pair.
40. **Pausing virtual time must stop the clock, not the page, when the page is in
    its own load path.** Fencing task queues on pause is safe only because loads
    normally complete in the network process. A sandbox's load is served by a
    service worker that delegates back to the client page, so fencing the page
    stops the work that would release the pause. Determinism comes from the
    frozen clock; freezing the queues as well is an optimisation that assumes
    the page is not a participant.
41. **Key a network store on URL AND ordinal.** A URL can return different bodies
    on successive requests -- a challenge page and then the real page -- and a
    URL-only key silently keeps whichever was written last. That is not a lost
    byte, it is a different user journey: replay skipped the challenge entirely
    and a sandbox that could not survive one would have looked fine.
42. **A store must record WHEN it was captured.** Recorded bytes are not
    timeless. A challenge embeds tokens minted at capture time and checks them
    against the device clock, so replaying under an unrelated constant makes the
    page reject its own challenge. Same for cookies, JWTs, cache validators.
43. **Log replay misses where the miss happens.** Browser-side misses were
    invisible -- not logged, and not in the `blocked` counters, which only cover
    subresources and not navigations. A guaranteed-miss navigation therefore
    presented as an unexplainable 109-iteration retry loop, and I reasoned my way
    to "this protocol is unreplayable" instead of reading a one-line MISS.
44. **A recorded response is its headers, not just its bytes.** Replaying bodies
    under a synthetic `200 OK` looks harmless and is not. Cloudflare answers the
    first navigation with `Critical-CH`; Chromium restarts the navigation, the
    first challenge instance is thrown away, and only the SECOND one's
    sub-requests are in the store. A replay that cannot restart therefore hands
    the page the abandoned challenge and every one of its endpoints misses. The
    headers are what drive the browser, so the store has to carry them verbatim.
45. **Record redirects; do not follow them silently.** The URL a page ends up at
    is content. Cloudflare bounces `/` to `/?__cf_chl_rt_tk=<token>` and the
    challenge script reads the token out of `location`, so a store that keeps
    only the final body runs that script at a URL with no token. Store the 3xx
    with its `Location` and make replay emit a real redirect the client has to
    follow.
46. **Do not normalise a key you do not understand.** I stripped
    `__cf_chl_tk`/`__cf_chl_rt_tk` from store keys reasoning that a token minted
    during recording could never be asked for again. Wrong twice: the token is
    minted by the SERVER and lives in the recorded HTML, so replaying those bytes
    asks for exactly the same URL -- and the stripping collapsed four distinct
    steps of the challenge onto one key, scrambling the ordinals meant to
    separate them. A normalisation that "cannot matter" is a hypothesis.
47. **Per-request state that survives a restart must not live on the factory.**
    The replay ordinal counter was per-URLLoaderFactory.
    `WillCreateURLLoaderFactory` runs once per factory and a restarted
    navigation gets a fresh one, so the counter reset to 0 and re-served ordinal
    0 -- defeating ordinals in the one case they exist for.
48. **Measure the oracle against itself before believing a bucket.** An oracle
    that cannot reproduce its own run cannot convict the sandbox of anything.
    `--self-check` runs the oracle twice and diffs; on rateyourmusic that is 345
    unstable buckets (resource timing, ICE candidates, blob UUIDs, timer ids) and
    0 T0 leaks. Keep the noise floor in a file SEPARATE from the baseline: a
    baselined bucket is "known and accepted", a noisy one is "the oracle has
    nothing to say", and merging them hides real bugs behind noise invisibly.
49. **Key a baseline by what it was recorded against.** Bucket keys are
    `tier|kind|api|class` with no page in them, so one shared `baseline.json`
    let a run on rateyourmusic silently suppress 28 probe-page buckets. That is
    the exact failure a baseline exists to prevent, so the file is now per target
    host.
50. **A service worker does not get the browser's network-layer behaviour.**
    `Critical-CH` makes Chromium redo a navigation and discard the first
    response; for a response synthesized by a service worker it does not, because
    client hints are a network concept. A sandbox that serves the guest through a
    SW therefore ran the challenge instance the recording threw away. Emulate it
    in the transport, and **log when the emulation fires** — the harness is
    compensating for a real divergence, not removing it.
51. **Fence one side, not both.** `--vt-fence` is per side now. The oracle needs
    it -- without it rateyourmusic's challenge takes different branches and the
    run stalls at 5510 records. The sandbox must NOT have it: its loads are
    served by a service worker that delegates back to the client page, so
    fencing the page stops the work that would release the pause (#40). Applying
    it to both reintroduced that deadlock, and it presented as "the challenge
    script is fetched and never executes" rather than as a hang.
52. **A shim must not spend the guest's randomness.** Under a pinned PRNG the
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
53. **WebIDL substitutes the global for a null receiver; a shim must too.**
    "Let esValue be the this value, if it is not null or undefined, or realm's
    global object otherwise." A bare `addEventListener("x", fn)` therefore works
    in every engine, and an interceptor that takes `this` at face value sees
    `undefined`. Ours then used it as a WeakMap key and threw
    "Invalid value used as weak map key" -- a message no engine produces there,
    so both a broken page and a tell.
54. **Make the sandbox's store exactly as permissive as the oracle's.** The
    endpoint refused non-GET as an "honest miss" while the Chromium-side replay
    answered any method from the same URL key. Cloudflare POSTs to its `fo/`
    endpoint, the recording holds that response, and the asymmetry showed up as
    a sandbox miss -- a divergence manufactured by the harness.
55. **A shim that calls the native without a receiver posts to itself.** WebIDL
    substitutes the _realm's_ global for a null `this`, so
    `otherWindow.postMessage(...)` forwarded as a bare call silently delivers to
    the forwarder's own window. scramjet's shim did exactly that
    (`Function("...args", "this(...args)")` invoked with the native as `this`),
    so a frame talking to its parent talked only to itself. Forward with
    `fn.apply(receiver, args)`; the stolen-`Function` trick is for the
    _incumbent_ realm, not the receiver.
56. **Select the guest realm by the target page, not by record count.** A probe
    page with an iframe has two realms on the origin, and "the realm with the
    most records" picked a different DOCUMENT on each side the moment the frame
    got busier than the page -- every observation on both then reported as
    missing or extra. Match the target URL: exactly on the oracle, its encoded
    form under the proxy prefix on the sandbox.
57. **Emulate a browser behaviour at the scope the browser applies it.** The
    `Critical-CH` restart is a NAVIGATION restart, and the recording shows the
    oracle did not restart for the Turnstile iframe -- one stored response, not
    two. Emulating it per URL loaded the widget twice. Gate on
    `Sec-Fetch-Dest: document`.
58. **Key a baseline by the page, not just the origin.** Per-host was not enough:
    two probe pages on `localhost` shared one file, so `--page csp.html
--baseline` overwrote probe.html's. Same failure as #49, one level down.
59. **Virtual time starves a frame created late.** Under `kDeterministicLoading`
    the Turnstile widget's frame never started its blocking `<script src>` at
    all: measured, it sat at `readyState: "loading"` with one script and 83
    bytes of DOM for an entire 30 s run, while `decodedBodySize` said all
    972 750 bytes of its document had arrived. Turn virtual time off for that
    side and the same frame runs 44 000 records and spawns Turnstile's blob
    workers. Not root-caused; `--no-virtual-time sandbox` is the workaround, and
    it costs the sandbox its pinned elapsed clock (Google Analytics' `_p=`
    timestamp then misses the store).
60. **A same-process iframe has no widget of its own, so a frame-targeted click
    lands in the main frame.** `RenderFrameHost::GetView()` returns the ROOT
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
61. **An anti-bot payload is not reproducible across runs, so the recording is
    the wrong thing to score a run against.** Cloudflare's `/fo/` bodies were
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
62. **Input has to land in the same place in both runs, and a frame-targeted
    click lands in neither page.** `--sbxdiff-click-frame` delivers every event
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
63. **The guest frame must BE the viewport, and nothing may resize it after the
    page starts.** The harness hosted the guest at `height: 80vh` below a
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
