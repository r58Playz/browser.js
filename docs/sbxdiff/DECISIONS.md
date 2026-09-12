# Decision log

ADR-style. Each entry: the decision, why, and what was rejected. Decisions made during
planning are recorded first; implementation decisions follow in date order.

---

## Planning decisions

| #    | Decision                                                             | Rejected alternative, and why                                                                                                                                                                                                                                                                                                                                       |
| ---- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-1  | **Record/replay**, comparing traces                                  | _Two V8s in lockstep against one DOM._ The sandbox's DOM differs by construction (rewritten HTML, injected shim nodes, proxied URLs). The runs are meant to be bisimilar at the guest-observable boundary, not equal. Lockstep's only real perk — both sides in a debugger at the divergence — comes free from deterministic replay (`--sbxdiff-break-at-event=N`). |
| P-2  | **Literal comparison**; `diffClass` classifies but never normalizes  | _Un-rewriting values before comparing._ The un-rewritten value **is** the bug — normalizing hides exactly the leak class the oracle exists to find.                                                                                                                                                                                                                 |
| P-3  | **Never serialize object contents or own-keys**                      | _Deep value serialization._ Enumerating keys can hit a Proxy trap (scramjet hands the guest many Proxies), which would make the tracer observable; and it compares state the page never looked at. Identity + the page's own access sequence is the signal.                                                                                                         |
| P-4  | **Non-isolated mode (`VITE_ISOLATION_ORIGIN=none`) first**           | _Isolated-mode-first._ Non-isolated is the normal devserver setup and the strictly harder oracle — nothing masks a leak. Clean there implies clean in both.                                                                                                                                                                                                         |
| P-5  | **T4 suppression keyed on divergence buckets**                       | _Keying on `failing_tests.json` test names._ A 225-entry list of names cannot suppress a bucket-based differ.                                                                                                                                                                                                                                                       |
| P-6  | **New non-testonly `core/sbxdiff/` interface** for guest-op brackets | _Blink's `internals`._ `core/BUILD.gn:533` marks it `testonly`; only `content_shell` links it.                                                                                                                                                                                                                                                                      |
| P-7  | **`kSbxDiffScripted` virtual time = a recorded input stream**        | _`kDeterministicLoading`._ Ten `WebScopedVirtualTimePauser` sites hold an absolute veto and `TryAdvancingTime` takes the min across clients, so during SW registration time waits for the load while the load waits for time. Structural, not a bug.                                                                                                                |
| P-8  | **Narrow V8 determinism knobs**                                      | _`--predictable`._ It crashes the renderer, and the two behaviours `--single-threaded-gc` doesn't imply are process-global (`WorklistBase::EnforcePredictableOrder`, synchronous second-pass phantom callbacks). Not worth fixing.                                                                                                                                  |
| P-9  | **`--no-turbo-fast-api-calls`**                                      | _`--jitless` / `--no-opt`._ The flag closes the actual fast-path hole; jitless costs 5–20x runtime for no extra coverage.                                                                                                                                                                                                                                           |
| P-10 | **`--disable-features=site-per-process,...`**                        | _`--single-process`._ We need one _renderer_, not one process. `--single-process` makes `performance.memory` report the browser heap, changes GC/crash semantics, and skips the sandbox.                                                                                                                                                                            |
| P-11 | **Build `chrome`, run `--headless=new`**                             | _`headless_shell`_ (UA says HeadlessChrome, forced SwiftShader, empty `navigator.plugins` — two instant bot-detects) and _`content_shell`_ (no `window.chrome`, no PDF mime).                                                                                                                                                                                       |
| P-12 | **Rewrite the scramjet-side harness in `runway`**                    | _Rebasing `origin/scramdiff`._ runway is already in the workspace with 553 tests on two symmetric harnesses, CI, baselines and coverage. scramdiff's probe also has a real bug (its `pre` capture re-invokes the native a second time, duplicating side effects).                                                                                                   |

---

## Implementation decisions

### 2026-09-10 — Build with CommandLineTools, not full Xcode

**Decision.** Patch three build-script paths to support a CLT-only toolchain rather than
installing Xcode. See `CHROMIUM-PATCHES.md` #0001.

**Why.** Disk is the project's binding constraint (~26 GiB free with `out/` growing).
Xcode is ~20 GiB installed plus the download. CLT turns out to be sufficient for
everything the `chrome` target actually needs: no `compile_xcassets` in `chrome/`, and
all required binutils are in `/usr/bin`.

**Cost.** Three small patches to carry across rolls, and no `metal` compiler (below).

### 2026-09-10 — SDK pinned to 26.5

**Decision.** `mac_sdk_min = "26.5"`, and the patched `sdk_info.py` resolves
`mac_sdk_official_version` from `mac_sdk.gni`.

**Why.** SDK 27.0's `libSystem.tbd` declares `arm64e.x1-*` targets that Chromium 155's
bundled lld cannot parse, so every link fails. 26.5 is also Chromium 155's officially
tested SDK (build 25F70). Verified: `//base` builds clean on 26.5, and a trivial
`-lSystem` link fails on 27.0 / succeeds on 26.5. See `PINNED_ASSUMPTIONS.md` #1.

**Rejected.** Overriding `mac_sdk_path` in `args.gn` — gn requires it to resolve under
the output dir (`build/config/mac/BUILD.gn:114`), so it must come from `sdk_info.py`'s
`sdk/xcode_links` symlink. Also rejected an env-var override as too fragile: ninja
re-runs `gn gen` on build-file changes and would silently pick a different SDK.

### 2026-09-10 — SwiftShader instead of the Metal backend

**Decision.** `angle_enable_metal = false`.

**Why.** ANGLE's Metal backend requires Xcode's `metal` shader compiler
(`xcrun: error: unable to find utility "metal"`), which CLT does not ship. Confirmed
with the user. The cost is the real-GPU WebGL fingerprint that plan P8 called a decisive
advantage of `chrome --headless` on macOS. Accepted because:

1. Determinism _prefers_ software raster — GPU drivers are not deterministic, and plan
   P3 already wanted SwiftShader.
2. Network capture runs in stock headful Chrome (plan §9), so bot detection never sees
   this binary.
3. Both diff runs use the same binary, so the fingerprint cancels by symmetry (plan §1).

**Reversible** with one GN arg if full Xcode is ever installed.

### 2026-09-11 — Run key is an arbitrary string, hashed; never parsed

**Context.** `--sbxdiff-run-key` seeds the deterministic PRNG. The first
implementation parsed it with `base::StringToUint64` and used the integer
directly as the ChaCha20 key material.

**Problem.** A non-numeric key parsed as absent, so the run silently used real
OS entropy. The first test (`--sbxdiff-run-key=AAAA`) therefore diverged, which
is exactly what a genuine determinism bug looks like.

**Decision.** Accept any string and SHA-256 it into the 32-byte key. Presence of
the switch is what enables determinism; the value's shape cannot matter.

**Consequences.** No parse failure mode exists. Uses the full 256-bit key space.
Human-memorable keys work. The trace header's provenance field stores
`base::PersistentHash` of the same string for consistency. Generalised into
RULES.md #13.

### 2026-09-11 — Task ids from V8 call-entered/completed, not `TaskAttributionTracker`

**Context.** Every record needs a task id so the trace segments into tasks and
tasks pair across runs.

**Problem.** `scheduler::TaskAttributionTracker` is platform-level, propagates
through promise reactions, and is installed by default — it looked ideal. But
measured attribution was **0 of 3126 records**: `CurrentTaskState()` is null
unless some feature has a context to propagate, and it is an opt-in channel for
soft navigation / resource timing / `scheduler.postTask`, not a general task-id
service.

**Decision.** Mint an id on the 0 → 1 transition of V8's
`AddBeforeCallEnteredCallback`, and close it on `AddCallCompletedCallback`
(which fires only at call depth zero, after the microtask checkpoint is
drained).

**Consequences.** Exactly one id per top-level JS execution with its trailing
microtasks folded in; nested re-entrance keeps one id, correctly. Invisible to
JS, and Blink already installs a callback of the same kind. Rejected
`SetPromiseHook` (single-slot, contended, and its perf cost is potentially
page-observable). **Accepted gap:** identity without causality — no
`parent_task_id`, so M4's connected-graph clause remains open.
