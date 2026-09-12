# Determinism

Every source of nondeterminism, how it is pinned, and **how to verify it is still
pinned**. This is the highest-value document in the project because almost every entry
fails *silently*: a broken pin does not error, it just makes the self-diff dirty, and a
dirty self-diff makes every sandbox comparison meaningless.

**The gate this document serves (plan M7):** record a page, then replay the same
archive + `vt_schedule` + `run_key` into a second *direct* run and get byte-identical
`level==0` trace streams, on >= 5 real sites including one with a Service Worker.
Compare via the per-64-KiB rolling hash, byte-comparing only the first mismatching
block.

**Status: not yet implemented.** M0-M2 (build, fingerprint parity, tracer) come first,
because a trace is the only way to *measure* determinism. Entries below are the design
plus the verification recipe for each.

---

## 1. Time

| Source | Pin | Verify |
|---|---|---|
| `Date.now`, `new Date` | `kSbxDiffScripted` virtual time via `ProcessTimeOverrideCoordinator::CreateOverride` | `vt_advance` records identical across replays |
| `performance.now`, `timeOrigin` | same clock | ditto |
| `ThreadTicks::Now`, `LiveTicks::Now`, `TimeTicks::LowResolutionNow` | **must be passed explicitly** — the existing `ScopedTimeClockOverrides(CurrentTime, CurrentTicks, nullptr)` leaves all three on the real clock (`base/time/time_override.h:42-47`) | grep the override construction for all five args |
| `Date.now` clamping | `gin/time_clamper.h` holds a per-process `base::RandUint64()` secret | pin the secret; a divergence shows as sub-ms jitter in `Date.now` returns |
| `performance.now` clamping | `core/timing/time_clamper.h`, separate per-process secret | pin separately — **these are two different clampers** |
| PartitionAlloc's clock | it has its **own copy** of the time-override machinery under `base/allocator/partition_allocator/.../time/` | patching `//base` alone does not cover it |

**Why virtual time is a recorded input, not a function of load state:** see
`DECISIONS.md` P-7. Short version: `kDeterministicLoading` deadlocks structurally
during Service Worker registration.

Also suppress `DecrementVirtualTimePauseCount`'s `MaybeAdvanceVirtualTime(paused + 10ms)`
nudge for `kNonInstant` pausers (`web_scoped_virtual_time_pauser.cc:83-87`) — a
nondeterministic +10 ms.

### Time, measured (2026-09-11)

Virtual time installs a **process-wide** clock override —
`ProcessTimeOverrideCoordinator::EnableOverride` builds a
`base::subtle::ScopedTimeClockOverrides(&CurrentTime, &CurrentTicks, nullptr)`
— so once enabled, both `Date.now()` and `performance.now()` follow the virtual
clock. (The third argument is null, so `base::ThreadTicks` is **not**
overridden.)

`--virtual-time-budget=<ms>` is honoured only by the headless command handler
(`components/headless/command_handler/`), i.e. alongside `--dump-dom` /
`--screenshot` / `--print-to-pdf`. It injects a `chrome://headless/` realm which
drives the run over CDP internally — which is why traces contain that realm, and
why P9's in-binary runner should eventually replace it.

Measured on two runs of the same page:

| Field | run 1 | run 2 | Verdict |
|---|---|---|---|
| 3× `performance.now()` in one task | all `11.700000001117587` | all `10.799999998882413` | **quantised per task** — the clock does not advance during synchronous execution |
| `Date.now()` delta across `setTimeout(…, 10)` | `10` | `10` | **exact** |
| `new Date().getTimezoneOffset()` | `420` | `420` | pinned by `TZ` |
| `Date.now()` absolute | `1789115549011` | `1789115549577` | **real wall clock** |
| `performance.timeOrigin` | `1789115548999.9` | `1789115549567.1` | **real wall clock** |
| `performance.now()` at script start | `11.7` | `10.8` | variable offset |

So virtual time makes *deltas* deterministic but takes its **origin** from the
real clock: `ThreadSchedulerBase::EnableVirtualTime(initial_time)` falls back to
`base::Time::Now()` when the caller passes a null time, and the headless
command handler never passes one.

Patched with `--sbxdiff-initial-time=<unix_ms>`, consumed at that exact fallback
(a single call site, `inspector_emulation_agent.cc:673`, reaches it). A
malformed value is a `CHECK` failure rather than a silent fallback, per
RULES.md #13.

**Two corrections, both measured.** An earlier note blamed the
`performance.now()` variance on virtual time being enabled *late*, and predicted
that enabling it earlier would fix it. Enabling it earlier made it far worse
(2–6 *seconds* of variance), because an advancing clock with no budget
fast-forwards through far-future startup timers — see `PROGRESS.md` P9a, now
reverted. A second note then claimed `performance.now()` was deterministic; that
was a two-run coincidence. Four runs give three distinct values, spread ~0.1 ms.

**Resolved (P9b):** `Date.now()` is now exact across runs
(`1700000004000` ×4) with `--sbxdiff-initial-time` plus
`--sbxdiff-virtual-time-budget`. The fence from `GrantVirtualTimeBudget` is the
piece that makes it reproducible — the value is determined by the budget, not by
real timing.

**Still open:** `performance.timeOrigin` and `performance.now()` carry ~1.7 ms of
jitter, because `timeOrigin` is stamped after a variable ~15–17 ms of virtual
time has elapsed during load. Time *deltas* are exact in every measurement. Both are origin values, and pinning them requires owning enable +
policy + budget + navigation together, before the target page navigates — the
in-binary runner (P9). `--sbxdiff-initial-time` is correct at its chokepoint and
waits for that.

## 2. Randomness

Three independent patches, not one.

| Source | Pin | Verify |
|---|---|---|
| Everything in `//base` | installable `RandBytesOverride` at the top of `RandBytesInternal` (`base/rand_util_posix.cc:123-171`). One chokepoint covers `RandUint64`, `RandDouble`, `RandFloat`, `RandBool`, `RandGenerator`, `RandBytesAsVector/String`, `RandomBitGenerator`, `RandomShuffle`, `InsecureRandomGenerator`'s seed, `UnguessableToken`, `Token` — **and** PartitionAlloc's and the network stack's draws | `rand_draw{stream_id, counter, len}` sequences identical across runs |
| `crypto::RandBytes` | same — it is literally `base::RandBytes` (`crypto/random.cc:15-20`) | ditto |
| `crypto.getRandomValues` | same, own `stream_id` (`modules/crypto/crypto.cc:58-78`) | ditto |
| `crypto.randomUUID` | same, own `stream_id` (`:80-82` -> `uuid.cc` -> `base/uuid.cc:73-79`) | ditto |
| BoringSSL `RAND_bytes` | covered by the `UseBoringSSLForRandBytes` branch at `rand_util_posix.cc:125-129` — intercept in `RandBytesInternal` so it is one patch, not two | ditto |
| `Math.random` | **no patch needed.** `--random-seed=1337`: `MathRandom::InitializeAndMaybeRefillCache` (`v8/src/numbers/math-random.cc:43-87`) is per-native-context and honours the flag, giving each realm a deterministic *and independent* stream | two record runs produce identical values |
| V8 hash seed / dictionary iteration order | `--hash-seed=1337 --rehash-snapshot` (the snapshot's baked-in seed wins without the latter) | property enumeration order stable |

The PRNG is **stateless** — `ChaCha20(run_key, stream_id, counter)` — so a differing
*number* of draws in one stream cannot desynchronize another. Guest and shim draws get
separate streams. Emitting `rand_draw` records means a draw-*count* divergence is itself
detected rather than silently corrupting downstream values.

### Measured (2026-09-11)

Implemented in `base/rand_util_posix.cc` as `SbxdiffRandBytes`, called first in
`RandBytesInternal`. Stateless and counter-based: the keystream is a pure
function of `(run_key, stream_id, draw_index)`, so a differing *number* of draws
in one stream cannot desynchronise another. ChaCha20's nonce is 96 bits, which
holds `stream_id` (32) ‖ `draw_index` (64) exactly, so the block counter is
always 0 and every draw gets a fresh keystream.

`--sbxdiff-run-key` takes an **arbitrary string**, hashed to the 256-bit key
with SHA-256. It originally parsed a decimal integer, and a non-numeric key was
then silently ignored — the run fell back to real OS entropy and looked exactly
like a genuine divergence. That is RULES.md #13 in miniature, and it cost a
debugging cycle on the very first test. Presence of the switch, not the shape of
its value, is what enables determinism.

Verified on `getRandomValues` ×2 + `randomUUID` + `Math.random` ×2:

| Run | Result |
|---|---|
| same key, **5 runs** (after the stream fix) | all 5 byte-identical — `getRandomValues` ×2 + `randomUUID`; worker thread identical over 3 runs |
| different key | differs, as intended |
| no key | differs each run — the patch is inert without the switch |
| `Math.random` | identical in all of the above (V8 `--random-seed`, independent of this patch) |

**A first version of this table recorded the gate as passing on two
byte-identical runs. That was wrong**: a later 5-run measurement produced 3
distinct results. Web-exposed draws shared the main thread's counter with
Chromium's internal draws, whose count varies per run, so the page's draws were
shifted rather than re-keyed. Fixed with dedicated per-stream counters
(`base/sbxdiff_rand_stream.h`); full account in `PROGRESS.md`.

`stream_id` is **per-thread**. A single global counter would make output depend
on inter-thread interleaving, which is precisely the nondeterminism being
removed. Draws made inside a `SbxdiffScopedRandStream` use that stream's own counter
instead, which is what makes web-exposed randomness reproducible;
`stream_id` for automatic streams is still handed out in first-call order per
thread, so an automatic stream's id is only stable if threads first draw in a
stable order. That no longer affects page-visible output, but it does still
affect internal draws.

## 3. Task and event ordering

| Source | Pin |
|---|---|
| Task identity | V8's `AddBeforeCallEnteredCallback` / `AddCallCompletedCallback` pair, in `sbx_tracer.cc`. **Not** `TaskAttributionTracker` — see below. Do **not** build a wall-clock-salted generation counter |
| Total task order | `base/task/sequence_manager/task_order.{h,cc}` |
| HTML parsing | the existing `probe::WillCreateDocumentParser(Document*, bool& force_sync_parsing)` probe (`core_probes.pidl:141`, consumed at `document_loader.cc:3527`) — set it true. No new plumbing |
| Compositing / animation | the `--deterministic-mode` switch bundle from `headless/lib/browser/command_line_handler.cc:36-53`: `--enable-begin-frame-control --run-all-compositor-stages-before-draw --disable-new-content-rendering-timeout --disable-image-animation-resync --disable-threaded-animation --disable-checker-imaging` |
| Raster threads | `--num-raster-threads=1` |
| Background resource fetch | `--disable-features=BackgroundResourceFetch` — otherwise `URLLoaderThrottleProvider::CreateThrottles` runs on a background thread (`url_loader_throttle_provider.h:32-40`) and **races the replay gate** |
| Process model | `--disable-site-isolation-trials --disable-features=site-per-process,IsolateOrigins,IsolateSandboxedIframes`. **Not** `--single-process` (`DECISIONS.md` P-10) |

Sites that still force OOPIFs regardless: COOP+COEP cross-origin-isolated documents and
`Origin-Agent-Cluster`. Detect and report "cannot run in one renderer" rather than
silently splitting the trace.

### Task identity — why not `TaskAttributionTracker` (2026-09-11)

`scheduler::TaskAttributionTracker` looked like the obvious source: it is
platform-level (so the tracer can reach it with no `core/` hook), it already
propagates lineage through tasks *and* promise reactions, and it has a
`MicrotaskTraceScope`. An earlier note in this file claimed it needed features
forced on; a later one claimed it was enabled by default. **Both were beside the
point.**

The tracker object *is* installed by default — `V8PerIsolateData`'s constructor
creates it on the main thread unless
`kTaskAttributionInfrastructureDisabledForTesting` is set. But
`CurrentTaskState()` returns null "outside of a `TaskScope` or microtask
checkpoint, **or if there is nothing to propagate**"
(`task_attribution_tracker_impl.cc`). It is an *opt-in propagation channel* for
`SoftNavigationContext` / `ResourceTimingContext` / `WebSchedulingTaskState`,
not a universal task-id service: `SetCurrentTaskStateIfTopLevel` only sets state
when handed a non-null one. On an ordinary page none of those contexts exist, so
there is nothing to propagate and the state stays null.

Measured, before replacing it: **0 of 3126 records attributed** on a page
exercising sync script, a two-link promise chain, `setTimeout`, synchronous
event dispatch and `requestAnimationFrame`.

The replacement is V8's own call-entered/call-completed pair, which brackets
exactly one top-level JS execution:

- `AddBeforeCallEnteredCallback` fires on **every** entry, including re-entrance
  (`v8-isolate.h:1356-1362`). A fresh id is minted only on the 0 → 1
  transition, so nested C++ → JS → C++ → JS keeps one id — correct, it is one
  task.
- `AddCallCompletedCallback` fires **only** when the outermost execution ends
  (`Isolate::FireCallCompletedCallback` early-returns unless
  `CallDepthIsZero()`).
- V8 drains the microtask checkpoint *before* firing it
  (`FireCallCompletedCallbackInternal` calls `PerformCheckpoint` first), so
  microtasks are recorded under the enclosing task id. That matches the
  definition in `task_attribution_tracker.h`: "the current JavaScript
  execution, excluding microtasks" — with the trailing microtasks folded in,
  which is what a diff wants.

Both callbacks are lists, and Blink already installs a
`BeforeCallEnteredCallback` of its own, so adding one is a proven-safe pattern.
Neither is observable from JS.

**Known gap — this gives task *identity*, not task *causality*.** Ids are
per-thread sequential, so the trace segments cleanly into tasks and tasks pair
across runs by equality, but there is no `parent_task_id`: nothing records that
a given timer callback was scheduled by an earlier task. The plan's M4 gate
("the causal graph is connected — no orphan tasks") is therefore **not met** by
this step. Options, cheapest first:

1. The differ reconstructs most edges offline — the tracer already sees the
   `setTimeout` / `addEventListener` / `queueMicrotask` binding calls that
   scheduled the work, so a scheduling call in task *N* can be matched to the
   callback task it produced. Heuristic, zero new patch surface.
2. `base::TaskAnnotator` already threads a parent-task notion through
   `base::PendingTask`; reading it at task start would give exact edges for
   posted tasks, but not for promise reactions.
3. `v8::Isolate::SetPromiseHook` gives exact promise causality, but it is a
   single-slot API that `TaskAttributionTrackerImpl` also wants, is a known
   perf cost, and perf costs are potentially page-observable. Avoid.

## 4. GC and JIT

```
--single-threaded-gc --no-concurrent-recompilation --predictable-gc-schedule
--no-flush-bytecode --no-lazy-feedback-allocation --no-turbo-fast-api-calls
```

Set from `content/renderer/render_process_impl.cc`, which already has
`SetV8FlagIfHasSwitch` (`:68-71`) and runs **before V8 init** — load-bearing, because
`freeze_flags_after_init` defaults true (`flag-definitions.h:3765`) and mprotects the
flag page afterwards.

`--single-threaded-gc` is the useful half of `--predictable`
(`flag-definitions.h:4269-4279`) without its two process-global behaviours. Do not use
`--predictable` (`DECISIONS.md` P-8).

`--no-turbo-fast-api-calls` is also a *coverage* requirement, not just determinism: it
stops TurboFan emitting the fast path that bypasses the traced generated callback.
Verify with the NADC fast-path DCHECK counter, which must stay at **zero**.

## 5. Rendering and layout

| Source | Pin |
|---|---|
| GPU | SwiftShader (`angle_enable_metal = false`; see `DECISIONS.md`) |
| Font rendering | **not yet done.** macOS is the weak spot here — Chromium's hermetic font setup is Linux-first. Pin `WebFontRenderStyle`, `layout_theme_mac.mm:129`, and the `WebTestSupport` antialiasing/subpixel hooks |
| Viewport / DPR | `--screen-info` + matching `--window-size`; see the fingerprint table in the plan (P8). `colorDepth=30`, not 24, on Apple displays |
| Layout-derived values | tiered off by default (T3) — and mostly *prevented* by harness symmetry (plan §11): put the oracle in an identically-sized `#testframe` iframe rather than at top level |

## 6. Network

**Implemented.** `--sbxdiff-net-record=<dir>` writes every response body to disk;
`--sbxdiff-net-replay=<dir>` serves them back and never touches the network. A URL with
no stored body gets `net::ERR_BLOCKED_BY_CLIENT` and is recorded as blocked — a
divergence, never a fallback (RULES.md #14).

Gates that were actually run: record → **stop the origin server** (`curl` → `000`) →
replay serves navigation, subresources and `fetch()`; then **tamper** a stored body on
disk and confirm the page observes the edit. The tamper step is the one that counts —
an earlier version passed the server-down test while silently serving from HTTP cache
(RULES.md #25). Three replayed runs were byte-identical in the page realm.

### What the design above this was, and what shipped

The original plan called for chunk-level capture released at recorded *virtual* times,
keyed on `(method, canonicalized URL after proxy-URL normalization, ordinal among
identical keys, request body hash)`, with the un-rewrite rule injected via
`--sbxdiff-url-normalize=` so Chromium stayed sandbox-agnostic.

What shipped is **whole-body, keyed on URL alone**. That is enough to make two runs of
the same site comparable, which was the blocking requirement. The deltas, in the order
they will matter:

1. **Method and request body are not in the key.** Two different POSTs to one URL
   collide and the second receives the first's body. `kNetRequest` records carry the
   method, so a differ can detect the collision even though replay cannot resolve it.
2. **No ordinal.** Repeated identical GETs all get the same stored body — usually
   right, silently wrong for a polling endpoint that returns changing state.
3. **Release timing is not reproduced.** Bodies are delivered as fast as the pipe
   accepts them rather than at recorded virtual-time offsets, so a page racing two
   resources against each other can still order them differently between runs. Not
   observed on rateyourmusic.com, but it is the most likely source of a future
   intermittent false positive.
4. **No `--sbxdiff-url-normalize`.** The sandbox side will need proxy-URL
   normalization before a scramjet run can replay a store captured by a stock run;
   this is the piece to build next on the Chromium side.

## 7. Locale

`TZ` pinned to a **plausible real zone** (`America/Los_Angeles`), not UTC — determinism
needs it pinned, not zeroed, and UTC alongside a Mac UA is itself an oddity. `--lang=en-US`.

---

## Deriving the to-do list rather than guessing it

Plan M3's gate is the practical trick here: once the value-carrying tracer works but
*before* any determinism work, record the same page twice and bucket the divergences.
That histogram **is** the determinism to-do list, measured rather than predicted, and
each section above should collapse a named bucket to zero.
