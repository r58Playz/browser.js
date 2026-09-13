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
64. **A service worker does not intercept subresources from an about:blank
    frame, and rewriting the frame to srcdoc does not fix it.** Measured in
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

65. **Realm ids are per-isolate, so they collide across trace files — and realm
    is what the comparison is scoped by.** A run writes one trace file per
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
66. **An instrument behind an environment variable is an instrument that is
    off.** The oracle's request-body hashes are `LOG(WARNING)` lines, and
    Chromium writes nothing to stderr without `--enable-logging=stderr`, which
    was behind SBXDIFF_VERBOSE. An ordinary run therefore parsed an empty
    stderr, found no oracle bodies, and reported every request the sandbox made
    as "oracle (none sent)" — seven divergences manufactured by a switched-off
    instrument. Anything the REPORT depends on is unconditional; the variable is
    for the firehose that a human reads. And a side that reports nothing at all
    while the other reports plenty is an instrument failure, not a finding: say
    so, rather than listing every request as divergent.
67. **The native trace is not what the guest sees.** The tracer hooks bindings,
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
68. **A sandbox that cannot have virtual time still needs the same clock
    ORIGIN.** #59 forces `--no-virtual-time sandbox`, which left the sandbox on
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
69. **A CSS property is a NAMED property, so only a Proxy can see it.**
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
70. **Injecting "at position 0" of a document puts you in front of the DOCTYPE,
    which is what causes quirks mode.** The HTML rewriter has a `detectQuirks()`
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
71. **Positional pairing loses its place, and a tier it cannot support is worse
    than no tier.** Calls are paired by index within an API, so one extra call
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
72. **A CSS selector does not go through `getAttribute`, so a rewritten
    attribute is invisible to it.** Scramjet rewrites `src`/`href` in the markup
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
73. **The oracle was not deterministic, and the two clocks it has are not the
    same clock.** `Date.now()` was pinned to the millisecond while
    `performance.now()` drifted 24 ms between two identical runs, because
    `WindowPerformance` resolves its origin at CONSTRUCTION and
    `--sbxdiff-virtual-time-after` starts the clock later — so it found no base
    and fell back to the loader's reference time, which is real. Resolve the
    origin at USE. `timeOrigin` needed the same treatment from the other side:
    it is built from a real wall-clock reading, and under virtual time its value
    is known exactly — the instant the clock was set to.
74. **`crypto.getRandomValues` is not the only RNG a page can reach.**
    BoringSSL seeds its own DRBG from the OS, and WebCrypto's key generation and
    RSA-OAEP padding draw from THAT — so they stayed random with //base's PRNG
    fully pinned. Measured across two otherwise identical runs:
    `generateKey` gave c2ec846c… against c47067d9…, and an RSA-OAEP ciphertext
    of the same plaintext under the same key gave 91ed881e… against b744083d….
    Cloudflare's payload prepends an RSA-encrypted random key, so no request
    body could ever be byte-identical between two runs, however well everything
    else was pinned. That is why the oracle disagreed with ITSELF on 6 of 8
    bodies and why there was no noise floor to measure a sandbox against.
75. **A clamped timestamp is not a rounded timestamp, and the difference is
    the whole of its nondeterminism.** `TimeClamper` decides per value whether
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
76. **Randomness a page cannot READ is still randomness a page SENDS.**
    `----WebKitFormBoundary<16 random chars>` is unreadable from script and
    appears nowhere in any API trace, and it made two otherwise identical
    multipart bodies agree on 4 bytes out of 2450 — twice the boundary, 28
    bytes, and the hash says only "differs". Anything that reaches the wire is
    in scope for pinning, not just what a getter returns.
77. **Give every pinned draw its own keystream.** The per-thread automatic
    stream shares one counter with all of Chromium's internal draws on that
    thread, so a draw's value depends on how many unrelated draws preceded it
    — which varies run to run. A pinned PRNG with a shared counter is not
    pinned. Rules 75 and 76 were both this, in different places.
78. **A hash says two bodies differ; it cannot say how, and the how is the
    diagnosis.** Dumping the bytes answered in one run what seven divergence
    reports had not: every Cloudflare payload agrees on its first 171 bytes and
    nothing after. That is the 128-byte RSA-wrapped XTEA key reproducing, so
    the key is pinned and the residue is plaintext — which LZW then smears over
    the entire ciphertext, making a 22-byte plaintext change look like a
    total divergence. "Agree on a long prefix, part at one field" and "differ
    from byte 0" point at completely different causes.
79. **`--sbxdiff-virtual-time-after` does not defer virtual time in a renderer
    that can never see the start realm — it cancels it.** The deferral matches
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
80. **A probe that runs only in the main frame proves nothing about a page that
    does its work elsewhere.** `clocks.html` had to compare the main frame, a
    blob worker, a cross-PROCESS iframe and that iframe's own worker before the
    answer appeared — the first three of those are pinned and only the last two
    are not. Use `127.0.0.1` against `localhost`: a different site, so a
    separate renderer, which is the structural difference that matters and the
    one same-origin probes cannot reach.
81. **The sandbox hangs under virtual time on BOTH policies, and the deferral
    bug was not the reason.** Rule 59 recorded that `deterministic` starves the
    Turnstile widget's frame; the open question was whether that was really the
    policy or just a symptom of rule 79, since a cross-origin renderer was
    silently running without virtual time at all. With 79 fixed, retested:
    `--vt-policy advance sandbox` also fails, and not by diverging — the run
    never finishes (`chromium did not exit within 240000ms`, oracle side fine
    at 47.8 s). So the cause is structural, not a policy choice. The remaining
    asymmetry is the one that has always been there: the sandbox's loads are
    served by a service worker that delegates back to the client page, and a
    clock that can be held by the page cannot also be the clock that page is
    waiting on.

    Consequence for the comparison: the oracle now completes the rateyourmusic
    journey in 8 trace files and 51k records where the sandbox needs 17 and
    443k, because virtual time compresses the oracle's run and nothing
    compresses the sandbox's. Oracle-vs-sandbox request bodies cannot match
    while that is true — they agree on **0** bytes, where two oracles agree on
    171 and four of eight bodies are byte-identical. Closing that gap means
    making the two sides' OBSERVABLE clock the same without making the
    sandbox's SCHEDULER virtual; virtual time conflates those two things, and
    that conflation is what starves the widget.

82. **The tracer is a BINDINGS tracer, so V8 builtins are a blind spot.**
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

83. **A fix keyed on PROCESS TOPOLOGY is asymmetric between the two sides by
    construction.** The oracle loads `challenges.cloudflare.com` cross-origin,
    so site isolation gives it its own renderer. The sandbox proxies every
    origin through `localhost:4500`, so the same widget is SAME-ORIGIN and
    lives in the main renderer. Anything conditioned on "this renderer hosts
    only a cross-origin subframe" therefore fires on one side and never on the
    other, which widens the very comparison it was meant to narrow. Measured:
    the observable-clock work took the oracle's Cloudflare realm from 10028
    divergences to 5 against itself, and moved `rym.sh diff` by nothing at all
    (2550/29/7 before, 2555/30/7 after).
84. **The counter clock cannot be made symmetric, and rule 82 is why.** Driving
    `Date.now()` from a count of reads reproduces across two runs of the SAME
    code, because the count is a property of the code. It cannot reproduce
    across oracle and sandbox, because the sandbox's shim reads the clock too
    and every shim read shifts the guest's count. Counting only guest-attributed
    reads would fix that, and there is nowhere to do it: `Date.now()` is a V8
    builtin, the tracer is a bindings tracer, and the platform boundary where
    V8 asks the embedder has no idea which script is asking. So byte-identical
    challenge payloads across the two sides are not reachable by clock work
    alone.
85. **Replay cannot reproduce the live failure, because the thing that fails is
    the SERVER's answer.** Scramjet loops at the Cloudflare challenge live: it
    posts a payload, the server rejects it, it retries. Under replay the store
    returns the recorded 200 whatever was posted, so the retry never happens and
    both sides sail through to the real page. Everything downstream of that --
    the main-page realm the differ picks by default, its `document.scripts`
    counts, its resource timings -- is describing a journey the sandbox does not
    actually complete. Diff the CHALLENGE realm, not the document the run ended
    on.
86. **Cloudflare's challenge worker is a hardware-throughput benchmark, and the
    sandbox scores differently.** It runs
    `while (performance.now() - start < 100) { digest(encode(...)) }` in a blob
    worker and reports the iteration count. Measured, oracle against sandbox on
    rateyourmusic:

        window     100.0 ms exactly (2.5 -> 102.5)   105.1 ms (129.3 -> 234.4)
        digests    5700                              6496          (+14%)
        per iter   0.0175 ms                         0.0162 ms

    Two separate tells: the count itself, and the fact that the sandbox
    OVERRUNS the 100 ms window while the oracle lands on it exactly. Neither is
    reachable by pinning a clock -- it is a measurement of how fast the machine
    actually is, taken by the guest, and a shimmed `performance.now()` changes
    both the measurement and the loop's own exit condition. Note also
    `MessageEvent.data` arrives as an OBJECT in the sandbox where the oracle
    gets the 3125-character string, because scramjet posts a wrapper and
    unwraps it in its shim, and `MessageEvent.origin` is never read natively at
    all there -- the shim answers it in JS, so the native getter never fires and
    the trace cannot see what the page was told.

87. **The widget FRAME is where the fingerprint is taken, and it is a different
    realm from both the page and the worker.** Scoped to it (`--realm q7dlh`,
    the one substring that appears in both sides' URLs -- the oracle's is a
    plain path and the sandbox's is percent-encoded inside a proxy prefix), the
    Turnstile frame does 9493 records in the oracle and 98186 in the sandbox,
    and reports 17 T1 buckets. That is the list worth working, and it sorts
    into four kinds:

    HARNESS GEOMETRY, and fixable there:
    MouseEvent.screenX/Y 22,32 vs 214,336
    DOMRect.width 20 vs 231.1875
    The click lands somewhere else relative to the widget, because in the
    sandbox the widget sits inside a nested iframe offset within the harness
    page. Where a click lands on a checkbox is exactly what a challenge asks.

    PROFILE STATE, and fixable there:
    PermissionStatus.state "denied" vs "prompt"
    Notification.permission "denied" vs "default"
    Permissions are per-ORIGIN: the oracle's are for rateyourmusic.com and the
    sandbox's for localhost:4500, so they were never going to agree.

    THE COST OF THE SHIM, which no pinning removes:
    MemoryInfo.usedJSHeapSize 31 MB vs 139 MB
    MemoryInfo.totalJSHeapSize 53 MB vs 191 MB
    PerformanceResourceTiming.decodedBodySize 256046 vs 967855
    PerformanceResourceTiming.responseStart / PerformanceEntry.duration
    Scramjet shares the guest's isolate, so its heap is the guest's heap, and
    its rewritten script is 3.8x the size of the original -- both readable
    through ordinary APIs.

    STILL-UNPINNED RANDOMNESS:
    RTCIceCandidate ufrag W8eO vs azhM (WebRTC's own, not //base)
    Crypto.randomUUID differs
    Note the parts that now DO agree in that candidate: the `.local` mDNS name
    and the UDP port are identical on both sides. randomUUID differs for the
    reason in rule 88.

88. **An explicit keystream's counter is per THREAD, and the two sides do not
    put the same realms on the same threads.** The oracle gives the Turnstile
    widget its own renderer, so its main thread's WebCrypto counter starts at
    zero. The sandbox proxies every origin into one renderer, so the same realm
    shares a thread with the harness and the guest page and inherits their
    draws. Everything downstream is shifted, which is why `crypto.randomUUID`
    still differs after the key itself was made cross-process stable. Fixing it
    needs a per-REALM counter, and //base has no notion of a realm -- the
    discriminator would have to come from Blink and be stable across the two
    sides, which a realm id (per-isolate) and an origin (rewritten) both are
    not.
89. **Any counter the two sides share has to be anchored to a REALM, and this
    is the shape of nearly everything left.** The oracle gives a cross-origin
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

90. **Some divergences are the sandbox, and pinning them would be lying.**
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

91. **Resetting a process-global counter at a per-realm event does not align it,
    and the ICE ufrag is the proof.** Rule 89 says to anchor a shared counter to
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
92. **The patch set was incomplete for months and every check passed.** DEPS
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

93. **Pinning the shim's cost does not make the diff pass, so the question of
    whether to pin it was moot.** `MemoryInfo` and
    `PerformanceResourceTiming.decodedBodySize` were the last two divergences
    anyone could call "real rather than noise", and the standing question was
    whether hiding them was worth a green run. Measured, with
    SBXDIFF_PIN_SHIM_COST=1:

        widget-frame T1 buckets   7 -> 4     (both gone, as expected)
        request bodies            7 -> 7     (unchanged)

    The exit code is `newBuckets.length || bodyDivergences.length`, so the
    bodies gate it on their own and they do not move. Pinning costs the
    oracle's ability to see a difference a live server sees, and buys three
    buckets and no pass. Keep it off; the flag exists so that this stays a
    measurement rather than an argument.

    What the bodies actually still carry is the open question, and it is not
    heap size: the two large Cloudflare payloads differ by about 1.1 KB each
    with the shim cost pinned out, and one of them agrees on its first 1430
    bytes rather than 171, so something else substantial is being reported
    differently.

94. **An ORACLE-side hang is always a Chromium patch, because the oracle runs no
    proxy code.** That single fact turned a hang with no error message into a
    one-step diagnosis. `rym.sh diff` stopped exiting; the oracle reached
    `SecChk` and then sat there; scramjet was not a candidate.

    The cause was counter-driving `Date.now()`. A counter advances per READ
    while timers still fire on the virtual clock, so a retry loop bounded by
    wall time -- wait 100 ms, check `Date.now()`, try again -- advances 20 us
    per attempt and never reaches its deadline however many times the timer
    fires. `performance.now()` is safe to drive from a counter because nothing
    schedules against it; `Date.now()` is not.

95. **Test the recipe the goal names, not the variant that is convenient.** The
    hang above survived many rounds of work because every measurement in those
    rounds used `--no-virtual-time both` -- chosen because it makes the two
    sides comparable -- while `rym.sh diff` uses virtual time on the oracle. The
    combination of the counter clock and virtual time was never exercised until
    the real recipe was run again, and it had been broken the whole time.
96. **The two sides' stores do not have the same matching rules, and the
    leniency is on the sandbox's side.** `LookupNextResponse` in
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

97. **`sendBeacon` does not reach the replay interceptor.** The oracle's trace
    shows `Navigator.sendBeacon` called with a Google Analytics collect URL, and
    its stderr shows no `replay MISS` for it -- and the oracle's store has no
    such entry, so a lookup would necessarily have missed. The request therefore
    never reached `sbxdiff_net_replay`, which is installed at
    `WillCreateURLLoaderFactory`; keepalive requests are serviced elsewhere.
    Either it was dropped as the browser shut down or it left the process, and
    the second would be a hole in the hermeticity rule 14 exists to enforce.
    Untested here, and worth testing: a beacon to a URL the store does not have
    should produce a MISS, and currently produces silence.
98. **Every remaining blocker on rateyourmusic reduces to one thing: the two
    sides' `Date.now()` differ.** The store holds three Google Analytics
    collect URLs, and comparing the `cid` on each side is the whole story:

        recording   cid=1125280317.1789256426
        oracle      cid=614833869.1789256417
        sandbox     cid=614833869.1789256425

    The random half is IDENTICAL -- the pinned PRNG works, across processes and
    across the two sides. The timestamp half differs by eight seconds, and that
    is `Date.now()`: the oracle on virtual time, the sandbox on a real clock
    with a pinned origin, drifting apart as the run goes on. Different
    timestamp, different URL, store miss.

    The same difference is in the request bodies, which carry timestamps too.
    So the three store misses and the seven body divergences are not two
    problems; they are one, and it is the asymmetry rule 81 describes: the
    oracle needs virtual time to be reproducible and the sandbox cannot have it
    without hanging.

    Counter-driving `Date.now()` to remove the asymmetry was tried twice and
    hung both times (rules 91, 94) -- a per-read counter cannot serve code that
    schedules against the clock. That is the shape of the remaining work, and it
    is not more pinning.

99. **A timer-driven logical clock does not converge either, because the two
    sides do not run the same timer chain.** The obvious answer to rule 98 is a
    clock that advances by timer SEMANTICS rather than by reads or by wall time:
    when a 100 ms timer fires it has advanced 100 ms. That avoids the hang the
    per-read counter caused (rule 94), because code waiting on elapsed wall time
    does reach its deadline, and it gives the sandbox the progression virtual
    time gives the oracle without fencing the scheduler -- the part the sandbox
    cannot survive (rule 81).

    Built and measured (SBXDIFF_LOGICAL_CLOCK=1). It does not hang, and it does
    not converge:

        oracle   cid=614833869.1789256417
        sandbox  cid=614833869.1789256424

    Seven seconds apart, against eight before. The mechanism works -- the clock
    advances by tens of seconds, so it is tracking timers rather than sitting
    still -- but the inputs differ: the sandbox fires the shim's timers as well
    as the guest's, so it reaches a different logical time. The same asymmetry
    that defeats every other approach, one level up.

    Kept behind the flag and off by default, so the next attempt does not have
    to rediscover that this road was taken. Making it converge needs the clock
    to advance only on GUEST timers, which needs attribution at the point a
    timer is scheduled -- the same missing discriminator as rules 88 and 89.

100.  **The last `HTMLCollection.length` divergence is a parser position, not a
      collection.** `document.scripts.length` read 20 in the oracle and 23 in the
      sandbox, stable across two oracle runs, and the obvious readings are all
      wrong: it is not the shim's own injected scripts (they self-remove, and
      `pages/scripts.html` has covered that since), not `document.currentScript`
      self-removal (rule eliminated by `pages/currentscript.html`), and not a
      collection the two sides built differently.


    Measured by instrumenting the STORE rather than the browser: a copy of the
    rym store with three lines prepended to the recorded
    `googletagmanager.com/gtag/js` body, writing the count and the src list to
    `document.title`, which the tracer already records. Both sides then run the
    same probe at exactly the same point in the same script, which no amount of
    reasoning about the two runs can substitute for. The answer:

        oracle  : ...jquery.min.2.js ~ bundle.js ~ new_music.js            (20)
        sandbox : ...jquery.min.2.js ~ bundle.js ~ new_music.js
                  ~ (inlinemodule) ~ (inlinemodule) ~ (inline)            (23)

    The three extra elements are markup indices 20, 21 and 22 -- the document's
    last three `<script>` tags. `document.scripts` is live, so the number is
    where the PARSER was when gtag's `async` script executed. In the oracle the
    parser is blocked on the `<script src>` at index 19 and gtag runs in that
    gap; in the sandbox gtag's response arrives later, the parser gets past 19
    to EOF first, and gtag sees the finished document.

    So the divergence is the relative latency of one `async` subresource, and
    the sandbox's side of it is not an accident: a rewriting proxy has to run
    the JS rewriter over every script it serves, and gtag's body is 343 KB.
    Nothing in scramjet decides this and nothing in scramjet can pin it.

    Two things follow. A value like this cannot be fixed, only measured -- and
    a real browser on a real network would not reproduce the oracle's 20
    either, because googletagmanager.com and cdn.sonemic.net are different
    servers. And prepending a probe to a recorded response body is the cheapest
    instrument this tool has: no Chromium rebuild, no new trace fields, and the
    two sides are guaranteed to sample the same instant of the same code.

101. **Attributing a timer by the TOP stack frame froze the sandbox's clock
     completely.** Rule 99's fix was to advance the logical clock only on the
     guest's timers, and the discriminator used was `CurrentScriptIsShim` -- the
     script on top of the JS stack. That is the right question for "who made
     this call" and the wrong one for "who asked for this timer": under a proxy
     the guest never calls `setTimeout` itself. scramjet traps the global, so
     the top frame on every single `setTimeout` in the run is the shim's.


    Every timer in the sandbox was therefore classified as the shim's, the
    clock never advanced, and `Date.now()` -- which reads it through
    `gin::V8Platform::CurrentClockTimeMilliseconds` -- returned the same
    millisecond for the whole run. Measured on rym:

        oracle   Event.timeStamp over 25 reads: 0, 3300, 5000
        sandbox  Event.timeStamp over 22 reads: 0

    This is worth reading twice. Rule 99's symptom was `cid` seven seconds
    apart; after the fix the two `cid`s agreed, and they agreed because the
    sandbox's clock had stopped, not because the two sides had converged. A
    metric that improves because one side stopped producing values is the
    failure mode every oracle has, and the only defence is a probe that asserts
    the value is ALIVE, not merely equal. `pages/logicalclock.html` does that:
    `lc.moved`, `lc.reachedDeadline` and `lc.distinctInstants` are all true of
    a real clock and of a logical one, and all false of a stopped one.

    The fix is `StackHasGuestFrame`: walk the stack rather than read its top,
    and call the timer the guest's if guest code is anywhere below the trap.
    The shim's own timers -- scheduled from its init, with nothing of the page
    underneath -- still do not count. It returns true when no shim markers are
    configured, so the oracle is unchanged.

    Measured after the fix, same recipe:

        oracle   Event.timeStamp: 0, 3300, 5000
        sandbox  Event.timeStamp: 6650, 7200, 12200

    Alive on both sides, and not agreeing: the sandbox reaches a higher logical
    time than the oracle because "guest anywhere on the stack" still counts a
    timer the proxy schedules for its own reasons while guest code happens to
    be running. Rule 99's seven-second `cid` drift comes back with it. That is
    the honest state of it -- a frozen clock was not a smaller version of this
    problem, it was a different one -- and the remaining gap is a THRESHOLD
    question, which `GuestFrameDepth` and `SBXDIFF_LOG_TIMER_ATTR` exist to
    answer with numbers rather than with reasoning.

102.  **One of the six divergent request bodies is three bytes of `Date.now()`,
      and that is the whole of it.** rateyourmusic posts a multipart form to
      `/httprequest/SecChk`. 2450 bytes on both sides, agreeing on the first 2100
      and the last 347:

          oracle   ...name="ts"\r\n\r\n1789256416609\r\n------WebKitFormBoundary...
          sandbox  ...name="ts"\r\n\r\n1789256423809\r\n------WebKitFormBoundary...


    7200 ms apart, which is exactly the gap between the two logical clocks
    (12200 against 5000). Everything else in the body matches byte for byte,
    including the `WebKitFormBoundary`, which is the pinned rand stream working.

    Worth stating because it converts a vague belief into a measurement: the
    clock drift is not merely *a* cause of body divergence, it is provably the
    ONLY cause of this one, and every other divergent body on this recipe is a
    Cloudflare payload that also carries timestamps. It also says what a fix is
    worth before the fix exists -- if the clocks agree, this body is identical,
    and no amount of work anywhere else would have made it so.

    How it was found: `SBXDIFF_BODY_DUMP_DIR` writes both sides' bytes, and
    `bodyShape` reports the shared prefix and suffix. "Agree on the first 2100
    and the last 347" is the whole diagnosis; without the suffix number this
    looks like a body that parts company at 2100 and never recovers.

103.  **The oracle ran four renderers and the sandbox one, so anything the
      patches keep per PROCESS was split on one side and shared on the other.**
      The logical clock is per process. `SBXDIFF_LOG_TIMER_ATTR` prints one line
      per timer, and the line carries a pid:

          oracle   108 timers across 4 pids: 45, 43, 18, 2
          sandbox  130 timers across 2 pids: 128, 2


    rym, challenges.cloudflare.com, brunhild.challenges.cloudflare.com and the
    browser UI each got their own renderer -- and their own clock, each starting
    at zero. The sandbox cannot do that: a proxy collapses every origin onto its
    own, so every frame is same-site and lands in one renderer sharing one
    clock. The sandbox's therefore accumulates what the oracle splits three
    ways, and `Date.now()` runs ahead. That is the 7200 ms in rule 102, and it
    is not an attribution problem -- the timer DELAYS matched to within three
    seconds out of 177,000 (177,150,156 against 177,147,132).

    Two things this cost. First, three rounds were spent sharpening *whose*
    timer it is -- top frame, then any frame on the stack, then the callback's
    own script (rule 101) -- each an improvement, none of them the cause. The
    evidence that would have redirected it was in the log prefix the whole
    time. Second:

        "--disable-features=site-per-process,IsolateOrigins,..."

    There is no feature named `site-per-process`. Site isolation is a SWITCH,
    and an unknown name in `--disable-features` is dropped without a word --
    the same silent-relay failure as FLAGS.md's "The relay is load-bearing and
    fails silently", one layer up. A comment three lines above the flag stated
    as settled fact that this set "is what makes a cross-origin iframe share
    the page's renderer". It never did, and nothing measured it until the pids
    were counted.

104. **A browser has one clock; the logical clock was a per-renderer stopwatch.**
     The first answer to rule 103 was to collapse the oracle's process tree with
     `--disable-site-isolation-trials`, so that both sides had one renderer.
     Measured, it is worse on every count: the oracle STILL kept a separate
     renderer for the widget, its main renderer's logical clock went from 5000 ms
     to 120100, the unbaselined bucket count went 14 → 19, and `ts` did not move
     by a single millisecond. Process topology was never the thing the two sides
     had to share.


    The clock was. `SBXDIFF_LOGICAL_CLOCK_FILE` maps an eight-byte `MAP_SHARED`
    file holding one lock-free atomic, so every process in a run advances and
    reads the same counter -- which is what `Date.now()` means. Per SIDE, in
    that side's trace directory: one file for both sides would measure a clock
    both of them are moving.

        before   oracle ts 1789256416609   sandbox 1789256423809   7200 ms apart
        after    oracle ts 1789256420709   sandbox 1789256423859   3150 ms apart

    A file rather than shared memory because it needs no handle plumbing through
    every process launch, and every process in a run is on one machine already
    running with `--no-sandbox`. It falls back to the process-local counter on
    any failure, which is the old behaviour rather than a crash.

    The residual 3150 ms is the other half, and it is the attribution question
    rule 101 is about: the sandbox still counts 119 timers as the guest's to the
    oracle's 108. Both diagnoses were right, in sequence -- 4100 ms of process
    split and 3150 ms of attribution -- which is worth remembering when a fix
    closes half a gap and looks like it failed.

105. **Unwrap a callback before you judge it, and then the residual has a
     name.** `ClassifyCallback` reads the callback's script, which works because
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

106.  **The last of the clock gap is a 550 ms poll that needs five more rounds
      under the proxy.** Grouping the guest's timers by callback script AND delay
      turns rule 105's "+5 and +5" into one line:

          oracle sandbox
               8      13   challenges.cloudflare.com/.../turnstile   ms=550
               8      13   rateyourmusic.com/cdn-cgi/.../orchestrate ms=550


    Every other delay in both scripts matches -- 32, 64, 100, 150, 250, 500,
    1000, 1500, 2000, 3100, 5000, 10000, 11000, 120000, 290000 -- except ms=0
    (+2) and ms=1168, which the oracle schedules twice and the sandbox not at
    all.

    So Cloudflare polls every 550 ms for something, and under the sandbox it
    takes five more rounds to get it: 2750 ms per script, against a remaining
    clock gap of 3150 ms. Nothing is being mis-attributed and nothing is being
    scheduled that should not be. The sandbox is slower to satisfy a condition
    the challenge waits on, and the challenge measures how long it waited.

    This is the same shape as rule 100, one level up. A rewriting proxy puts a
    service worker and a JS rewriter between the page and every byte it asks
    for; the page cannot see the proxy, but it can see the latency, and an
    anti-bot payload records it. That is a fidelity limit of the architecture
    rather than a defect in it, and the honest form of the remaining request
    body divergences is: the sandbox tells the server it waited longer, because
    it did.

107. **The clock gap was the harness clicking too early, and the poll was
     measuring it.** Rule 106 said Cloudflare's 550 ms poll ran five extra
     rounds under the sandbox. A probe planted in the challenge script -- one
     snapshot at each round's schedule and fire -- showed the two sides in
     LOCKSTEP: same `readyState`, same iframe and script counts, same empty
     token, the clock advancing exactly 550 ms per round, and only 50 ms apart
     at round zero. Nothing observable changed between rounds. The sandbox
     simply kept polling.


    The round counts name the cause:

        oracle   8 rounds x 550 = 4400 ms   first click at 4000 ms
        sandbox 13 rounds x 550 = 7150 ms   second click at 7000 ms

    The recipe clicks at 4000 ms with retries every 3000. The oracle's widget
    accepts the first click; the sandbox's is not interactive yet and needs the
    retry -- which the recipe's own comment had anticipated ("repeats because
    it is not interactive the instant the page settles") without anyone noticing
    that a retry is not free. The poll is what advances the clock, so five extra
    rounds IS the 2750 ms, and the rest of the 3150 ms gap follows.

    So the divergence was the harness asking the two sides to act at an instant
    only one of them was ready for. Moving the first click to 8000 ms, where
    both accept it:

        ts gap   +3150 ms  ->  -500 ms       (the oracle now one round ahead)
        Event.timeStamp   0 vs 7200  ->  8300 vs 7800

    `SBXDIFF_RYM_CLICK` makes the schedule overridable, because the delay is a
    guess and the right value is the one where BOTH sides are equally ready --
    which is a property of the pair, not of either side.

108. **The browser's own UI was advancing the page's clock, and closing that
     made a request body byte-identical.** Rule 104 made the logical clock one
     counter for the whole run, which is what a clock is -- and made every timer
     in the browser eligible to move it. `chrome://webui-toolbar.top-chrome/app.js`
     schedules two of 50 ms, and the probe in rule 107 had measured the two sides
     50 ms apart at the first poll round, before the page under test had run a
     line.


    The sweep is what showed it was a constant rather than jitter. Gap between
    the two sides' `ts`, by the recipe's first-click delay:

        4000   +3150 ms     8000   -500 ms
        7000     +50 ms     9000   -200 ms
                           10000    -50 ms

    A plateau from 7000 up -- so the click was fixed (rule 107) -- with about
    50 ms left over everywhere, which is the shape of an offset, not of noise.

    `IsNotGuest` excludes `chrome://`, `chrome-untrusted://`, `devtools://` and
    `chrome-extension://` from the guest, and does it whether or not shim
    markers are configured. That last part is the whole trick: markers are only
    set on the sandbox, so excluding the UI on one side only would have created
    exactly the divergence it removes.

        ts     oracle 1789256423809   sandbox 1789256423809   IDENTICAL
        request bodies   6 -> 5
        sandbox-only store misses   3 -> 2
        divergences   92 -> 80

    `/httprequest/SecChk` is the first request body on this recipe to reproduce
    byte for byte, 2450 bytes of multipart form including the
    `WebKitFormBoundary`. It took four sequential causes, each real and none
    sufficient alone: a frozen clock (#101), a per-renderer clock (#104), a
    harness clicking before the sandbox was ready (#107), and the browser's own
    toolbar (#108).

    `pages/logicalclock.html` gained `lc.idleDrift`: a chain of microtasks and a
    forced layout schedule no timers, so the clock must not move across them.
    It is a page-side invariant needing no reference to compare against, and it
    is the one thing here that would have caught this without a 400 KB anti-bot
    payload to notice it for us.

109. **Capture the payload's PLAINTEXT and the field names are just there.**
     Five request bodies were left, all Cloudflare, all agreeing on exactly the
     171-byte RSA key block and diverging from the first ciphertext byte. The
     contents are `base64(rsa-wrapped key || xtea(lzw(json)))`, so byte analysis
     says nothing: LZW makes one early difference change everything after it.


    The payload is built from `JSON.stringify`. A probe planted in the store
    (rule 100) that wraps it and dumps every large result through
    `document.createComment` -- a sink the payload does not read -- gives the
    plaintext on both sides, and a field-level diff of one
    `PerformanceResourceTiming` entry:

        navigationId      220     vs  2585
        deliveryType      ""      vs  "cache"
        contentEncoding   "br"    vs  ""
        responseEnd       104.185 vs  267.8
        serverTiming      []      vs  [{"name":"cfExtPri",...}]
        encodedBodySize   0       vs  113793

    Four were the harness, not the browser. `navigationId` counts navigations
    per renderer and the sandbox makes more of them before the guest exists.
    `deliveryType` is "cache" because a service worker answered. `contentEncoding`
    differs because that service worker hands over bytes it has already decoded.
    `serverTiming` differs because the oracle's replayer drops the header the
    sandbox passes through. All four are pinned, which is the decision
    `SbxdiffCollapsePhase` had already made for the phases beside them.

    `responseEnd` was a plain gap: the constructor collapsed the value handed
    to the base class, and `responseEnd()` reads `info_` directly, so it was
    never touched while every other phase in the entry read 0.

    And `encodedBodySize: 0` was the oracle being WRONG, not conservative. The
    replayer never set `timing_allow_passed`, so Blink zeroed every size on
    every cross-origin resource it served. rateyourmusic really does receive
    `timing-allow-origin: https://rateyourmusic.com` from
    challenges.cloudflare.com; computing it restores the number a real browser
    reports rather than inventing one. Divergences 107 -> 68.

    What is left in that entry is real:

        transferSize      86903  vs  0        a service worker response reports 0
        encodedBodySize   86603  vs  113793   the rewritten script is 1.31x

    Both are things a live server sees about a proxy, and both are the kind of
    signal this tool exists to surface rather than pin.

110. **The probe reached the end of what one realm can see.** With rule 109's
     pins in place, the ONE payload the rym challenge script builds through
     `JSON.stringify` is byte-identical on both sides. The request bodies still
     differ, so the rest is assembled in the Turnstile widget's own realm on
     challenges.cloudflare.com -- a different document, which the probe could not
     reach, because `plantProbe` prepends raw JavaScript and a document is not a
     script.


    `plantProbe` now plants into a document as well, and where it plants is the
    whole of it: inside a `<script>` at the top of `<head>`, never at byte 0. A
    `<script>` ahead of the DOCTYPE is exactly what puts a browser in quirks
    mode, which moves `compatMode`, `clientHeight`, `scrollHeight` and every
    layout number the page can read -- scramjet's html rewriter has an
    `isQuirky` path for the identical reason. A probe that changed those would
    be measuring itself.

    `SBXDIFF_PIN_SHIM_COST` was extended to `transferSize` and
    `encodedBodySize` at the same time, and re-measured honestly: on this
    recipe it makes one payload length-equal (8674 against 8674) and closes no
    body, leaving the divergence count unmoved at 68. It stays off by default.
    The earlier verdict that it "buys less than it costs" was reached when the
    oracle was reporting 0 for `encodedBodySize`, so it was measuring nothing --
    the new number is the same verdict for a better reason.

111. **The store probe's reach ends at the store, and Cloudflare's detections
     run past it.** Planting into the Turnstile widget document (rule 110) found
     eight `JSON.stringify` results in the sandbox and ZERO in the oracle -- and
     reading them says why: several are scramjet's own config
     (`{"prefix":"/~/sj/","scramjetPath":...}`), which only one side has. The
     guest's payload is not built there.


    It is built in `blob:` realms. Both sides create a dozen of them under
    challenges.cloudflare.com, and a Blob URL is minted at runtime from a string
    the page already holds -- so it is not a store entry, and nothing planted in
    the store runs inside it.

    That is the boundary of this instrument. Getting past it means hooking
    whatever constructs the Blob, in whichever script does it, which is a
    different probe and a different search. Worth knowing before reaching for
    the tool again and concluding from silence that the two sides agree: they
    may simply not be answering.

112. **Rule 108's byte-identical SecChk was one lucky run, and saying so is the
     correction that matters.** It was measured once, reported as a fix, and does
     not reproduce: the next clean run put `ts` 50 ms apart again
     (1789256423759 against 1789256423809) and the body back in the divergent
     list. Six bodies, not five.


    The honest form of rule 108 is that the clock gap went from 3150 ms to
    within +/-50 ms, and that a 2450-byte multipart body whose only variable is
    a millisecond timestamp lands on IDENTICAL whenever that 50 ms happens to be
    zero. That is a real and large improvement and it is not a fix, because the
    thing being fixed is a coin flip at the boundary.

    The attribution underneath it IS finished, and this is how that is known:
    grouped by callback script and delay, the two sides now schedule 117 guest
    timers each, matching on every script and every delay except one pair --

        challenges.cloudflare.com/.../challenge-platform  ms=0     3 vs 5
        challenges.cloudflare.com/.../challenge-platform  ms=1200  2 vs 0

    -- which is Cloudflare choosing a different branch, not the harness counting
    wrong. Two timers it gives 1200 ms in a real browser it gives 0 under the
    proxy.

    A measurement taken once is a sample. The sweep in rule 107 was believed
    because five click delays agreed; rule 108's zero was believed because it
    was the number I wanted.

113.  **A clock whose increments are read from itself is a function of the
      scheduler; chain them and it is a function of the code.** After attribution
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

114.  **SecChk reproduces byte for byte, and this time it was checked properly.**
      With the clock chained (rule 113) the gap became a whole number of
      Cloudflare's 550 ms poll rounds, which made the recipe's click delay
      something that could be aimed rather than guessed. Swept again:

          5500  0 ms      6000  0 ms      6500  0 ms      7000  -550 ms


    Three adjacent delays on zero, so 6000 is the middle of a plateau rather
    than a lucky value. And three repeats AT 6000:

        ts gap 0, 0, 0    SecChk IDENTICAL, IDENTICAL, IDENTICAL

    Both dimensions, because rule 112 was believed on one sample of one. A
    2450-byte multipart body, `WebKitFormBoundary` included, identical between
    unmodified Chromium and a JavaScript proxy running a Cloudflare managed
    challenge.

    Five request bodies remain, all Cloudflare's own encrypted payloads.

115. **A probe that one side's CSP blocks reads exactly like a probe that found
     nothing.** The widget document sends
     `script-src 'nonce-AZF71QBfuZKprSmQDESew7' 'unsafe-eval'`. An injected
     inline `<script>` without that nonce is refused by unmodified Chromium and
     RUN by the sandbox, because scramjet does not enforce the site's CSP.


    So the first two probes of that document reported "oracle 0, sandbox 8" and
    "oracle 0, sandbox 3", and rule 111 read the first of those as *the payload
    is not built here, it is built in blob realms*. It was built there all
    along. `plantProbe` now reads `'nonce-...'` out of the recorded headers and
    stamps the injected tag with it, and both sides report identically.

    The asymmetry is itself a finding, and not a small one: a nonce-based CSP
    is a site's defence against exactly the injection this probe performs, and
    under the proxy it is not there. That is a fidelity gap and a security one,
    since the proxy is removing a protection the site chose for its users.

116.  **`PermissionStatus.name` is not the name you queried with, and that hid a
      real leak behind the two names that happen to agree.** Reading the payload
      plaintext on both sides, one entry differed:

          oracle   {"name":"video_capture","state":"denied"}
          sandbox  {"name":"video_capture","state":"prompt"}


    `video_capture` is Chromium's internal spelling: `PermissionStatus::name()`
    returns `PermissionNameToString()` over the mojom enum, so a query for
    `{name: "camera"}` answers "video_capture", and "microphone" answers
    "audio_capture". scramjet's `DENIED_IN_CROSS_ORIGIN_FRAME` is keyed on
    descriptor names, so it never matched them and camera, microphone,
    display-capture, local-fonts and the sensors all fell through to the real
    state in a frame the real web treats as third-party.

    It survived because `notifications` and `geolocation` are spelled the same
    either way -- the two anyone checks first, and the two the original
    measurement for that file used. A set keyed on a name is only as good as
    the assumption that there is one name.
