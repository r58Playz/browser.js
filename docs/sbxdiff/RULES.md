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
