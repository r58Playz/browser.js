# Progress log

One entry per milestone, recording the **actual measured gate results** so "did M7
pass" has an auditable answer rather than a vibe. Milestone definitions live in the
plan; gates are quoted here verbatim.

---

## M0 — get a stock `chrome` build running

**Gate:** binary builds; `out/sbx` <= 30 GiB; measured edge count and wall time
recorded; `--headless=new` loads a page.

**Status: PASSED** (2026-09-10 19:15).

### Environment as measured

| Item           | Value                                                                                 |
| -------------- | ------------------------------------------------------------------------------------- |
| Chromium       | 155.0.8051.0, V8 15.5.28, detached at `origin/main`, no local mods before our patches |
| Host           | Apple M4, 10 cores, 16 GiB RAM, macOS 26 (build 26A428)                               |
| Toolchain      | CommandLineTools only (no Xcode); SDK **26.5** (build 25F70)                          |
| depot_tools    | `/Users/r58playz/src/chromium/depot_tools` (not on PATH by default)                   |
| `gn gen`       | **37,129 targets from 4,996 files**, ~7-10 s                                          |
| `chrome` edges | **57,682** (`ninja -n chrome \| wc -l`)                                               |
| `base` edges   | 2,748                                                                                 |
| Disk at start  | 43.6 GiB free (Settings showed "48.57 GB" — decimal GB; mind the unit)                |

### Build config

`out/sbx/args.gn`. Notable choices, with rationale in `DECISIONS.md`:
`is_component_build=false`, `symbol_level=0` but **`blink_symbol_level=1`** (every
patch except the //base PRNG hook lives in Blink), `dcheck_always_on=true` through
bring-up, `enable_blink_bindings_tracing=true` (enabled from the cold build so M1
doesn't pay a second ~2,900-TU rebuild), `mac_sdk_min="26.5"`,
`angle_enable_metal=false`.

`-j8`, not `-j10`: Blink's largest TUs peak >1.5 GiB in clang and 16 GiB RAM swaps.

### Three toolchain blockers hit and resolved

1. **`find_sdk.py` / `sdk_info.py` assume full Xcode.** Four distinct failures; patched.
   See `CHROMIUM-PATCHES.md` #0001.
2. **SDK 27.0 breaks every link.** `libSystem.tbd` declares `arm64e.x1-*` targets the
   bundled lld can't parse. Symptom was undefined `strlen`/`getenv`/`posix_memalign`
   from `-lSystem`, which reads like a sysroot misconfiguration — it isn't. Pinned 26.5.
   See `PINNED_ASSUMPTIONS.md` #1.
3. **ANGLE's Metal backend needs Xcode's `metal` compiler.** Disabled the Metal backend;
   SwiftShader instead. See `DECISIONS.md`.

### Verification so far

- `//base` (2,748 edges) builds clean on SDK 26.5: `autoninja` exit 0.
- Trivial `-lSystem` link: fails on SDK 27.0, succeeds on 26.5 — the direct test that
  isolated blocker #2.
- `ninja -n chrome` shows **0** `metal` steps after `angle_enable_metal=false`.

### Gate results

| Gate                          | Target         | Actual                                                        |
| ----------------------------- | -------------- | ------------------------------------------------------------- |
| `chrome` builds               | exit 0         | **exit 0**, 0 errors                                          |
| wall time                     | est. 3.0-4.5 h | **222 min (3h42m)** at `-j8`                                  |
| `out/sbx` size                | <= 30 GiB      | **13 GiB**                                                    |
| disk free after               | > 8 GiB        | 27 GiB; watcher never fired                                   |
| `--headless=new` loads a page | yes            | **yes** - `--dump-dom` returned `M0 OK 756x491 dpr2 wd=false` |

Objects built: 46,509 (the 75,196 figure from the build graph counts targets `chrome`
does not need; ~46.5k is the real count, so use that as the denominator next time).
Rate held ~200-225 objects/min throughout.

`Chromium Framework` is **590 MB** with `blink_symbol_level = 1` — that single dylib is
most of the 13 GiB, and it is the reason the link tail is long.

### Build-watching gotchas (all three cost time)

1. **`autoninja | tail` masks the exit status** - `$?` becomes `tail`'s, so a failed
   build reads as a clean one. Always redirect, then check `$?`.
2. **`ninja -C out/sbx -n chrome` is only valid when idle.** `autoninja` selected
   **siso**, which keeps state in `.siso_fs_state` rather than `.ninja_log`; while siso
   holds `.siso_lock` the query returns `0 remaining` even mid-build. It gave a correct
   57,682 before the build started.
3. **`pgrep -cf` and `find -newermt` both lie here** - `pgrep -cf "bin/clang"` returned
   0 while `ps` showed 8 clang processes at 95% CPU, and `find -newermt '-5 minutes'`
   reported 0 files while the object count was demonstrably rising. Trust `ps` sorted by
   CPU, and the object-count delta between checks. Also note siso interleaves links with
   ongoing compiles, so a momentary "0 clang, 2 lld" sample does **not** mean compiling
   is finished.

### Reserve not needed

The 25 GiB `~/Library/Caches/depot_tools` git cache was never touched. Free space
actually rose mid-build (26 -> 32 GiB) as macOS reclaimed purgeable space.

---

## M1 — fingerprint parity + free-lunch tracing

**Gate:** fingerprint page shows no headless tells; a `blink.bindings` trace of a real
page names the calls we expect.

**Status: PASSED** (2026-09-10 19:21).

### Fingerprint, measured

Run with the standard flag set from `FLAGS.md`:

```json
{
	"webdriver": false,
	"ua_headless": false,
	"chrome_obj": "object",
	"plugins": 5,
	"pdf": true,
	"screen": "1512x982",
	"colorDepth": 30,
	"dpr": 2,
	"webgl": true,
	"renderer": "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0)...), SwiftShader driver)",
	"hw": 10,
	"lang": "en-US",
	"tz": "America/Los_Angeles"
}
```

UA after patch 0002: `... AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0
Safari/537.36` — no `Headless` token.

Three plan corrections came out of this, all in `FLAGS.md`: the `navigator.webdriver`
patch was unnecessary, `--screen-info` bounds are physical pixels (so 3024x1964 for a
1512-CSS-px screen), and WebGL needs `--enable-unsafe-swiftshader` or it is absent
entirely. A fourth, `label=` needing single quotes, CHECK-fails the browser if wrong.

**Known residual, accepted:** `navigator.userAgentData.brands` reports `Chromium`, not
`Google Chrome`, because this is an unbranded build (`is_chrome_branded` requires
internal `src-internal`). Symmetric across both diff runs, so it cancels; it would only
matter for a capture run, which uses stock Chrome anyway (plan §9).

### Bindings tracing works, and is exhaustive for generated callbacks

`enable_blink_bindings_tracing = true` plus
`--trace-startup=blink.bindings --trace-startup-duration=5 --trace-startup-file=...
--trace-startup-format=json`. **No CDP required** — this is the `--trace-startup`
path, which matters given plan §10.

A page doing 50 iterations of `getAttribute` / `setAttribute` / `tagName` /
`document.title` / `createElement` produced **2,622 events across 177 distinct binding
names**, with exact counts:

| Call                      | Traced count | Mine |
| ------------------------- | ------------ | ---- |
| `Document.title.get`      | 50           | 50   |
| `Document.getElementById` | 1            | 1    |
| `Element.setAttribute`    | 106          | 50   |
| `Element.tagName.get`     | 90           | 50   |
| `Document.createElement`  | 83           | 50   |

`Document.title.get == 50` and `Document.getElementById == 1` matching the loop exactly
is the important result: the hook fires on **every** call, not a sample. Naming is
`Iface.prop.get` / `Iface.prop.set` / `Iface.method`, as `_make_bindings_logging_id`
produces — which is what P2's interning scheme assumes. Both attribute getters
(`Node.nodeType.get`) and setters (`Element.innerHTML.set`) appear, so both callback
kinds are hooked.

### The interceptor blind spot is real, and measured

A second page did 30 iterations each of `coll[0]`, `coll["span"]`, `window["myframe"]`
and `document.all`:

| Access                                                     | Traced?                                   |
| ---------------------------------------------------------- | ----------------------------------------- |
| `document.all` (generated attribute)                       | **yes** — `Document.all.get` = exactly 30 |
| `coll[0]` — indexed property interceptor                   | **no events**                             |
| `coll["span"]` — named property interceptor                | **no events**                             |
| `window["myframe"]` — named property interceptor on Window | **no events**                             |

So `BLINK_BINDINGS_TRACE_EVENT` covers generated attribute/operation/constructor
callbacks but **not** interceptor callbacks — exactly as the plan predicted, and exactly
why P2 needs the second chokepoint at `_make_interceptor_callback_def`. This quantifies
the blind spot rather than assuming it: `window[name]` and indexed/named collection
access are currently invisible, and `window[name]` is a classic sandbox escape vector,
so this is load-bearing for P2 rather than a completeness nicety.

---

## M2 — value-carrying C++ tracer

**Gate:** a trace file with nonzero records for one interface; the
`DisallowJavascriptExecutionScope` DCHECK never fires; a JS page shows no extra key
from `getOwnPropertyNames`/`Reflect.ownKeys`/`JSON.stringify` on a tagged object.

**Status: PASSED** (2026-09-10).

### Coverage is exact

A page doing 50 iterations of `document.title` and `el.tagName` with **every result
consumed** (so nothing can be dead-code-eliminated), plus one `getElementById`:

| Call                      | Traced | Expected |
| ------------------------- | ------ | -------- |
| `Document.title.get`      | **50** | 50       |
| `Element.tagName.get`     | **50** | 50       |
| `Document.getElementById` | **1**  | 1        |

Exact, not approximate. A larger sample page produced 2,956 records over 231 interned
names with zero decode errors and zero throws.

Object identity behaves as the differ needs: repeat access to `window.trustedTypes`
returns the same id, and `CustomElementRegistry` keeps its id from _before_ it became a
Blink wrapper (`object(#12)` at construction → `dom(#12 CustomElementRegistry)` later),
so the private-symbol tag survives wrapper association.

### Non-observability is clean

| Probe     | own  | symbols | `Reflect.ownKeys` | sbx-named keys |
| --------- | ---- | ------- | ----------------- | -------------- |
| element   | 0    | 0       | 0                 | none           |
| document  | 1    | 0       | 1                 | none           |
| window    | 1236 | 0       | 1236              | none           |
| navigator | 0    | 0       | 0                 | none           |
| **Proxy** | 1    | 0       | 1                 | none           |

Invisible to `getOwnPropertyNames`, `getOwnPropertySymbols`, `Reflect.ownKeys`,
`for-in`, `JSON.stringify`, spread and `structuredClone`. Tagging a `Proxy` added no key
and did not trip its traps. The `DisallowJavascriptExecutionScope(CRASH_ON_FAILURE)`
guard never fired across any run, so the serializer provably never re-entered JS.

### Four bugs found, and one that was never a bug

1. **Switch not relayed to the renderer** — no trace file, no error. `RULES.md` #13,
   walked into anyway. Fixed structurally by moving the switch names into
   `blink::switches` so both sides share constants.
2. **`ToWrapperTypeInfo` is not a safe probe.** It faults (`BUS_ADRALN`) on an object
   with no wrapper internal fields; a `v8::Function` from an ExposedConstruct getter
   (`window.ShadowRoot`) triggered it immediately. Guard with
   `V8DOMWrapper::IsWrapper`.
3. **`ThreadSpecific` held a raw pointer**, so `~SbxTracer` never ran and the buffered
   tail was dropped — header-only 10-byte files. Now a `unique_ptr`.
4. **Interning corrupted the stream.** `InternLiteral` emits its own record inline, and
   `EncodeValue` interns interface names _mid-record_, splicing an intern record into
   the middle of a binding record (`unknown record kind 6 at offset 39`). Records are
   now assembled in a scratch buffer and appended atomically, with interning always
   writing ahead into the main stream.

**The one that was never a bug — read this before debugging coverage.** Counts appeared
to vary run to run (1513 / 2299 / 2452 / 2505) and to fall short of 50. I diagnosed it
as dead-code elimination, then JIT tiering, then lost tail — **all three wrong**. A run
produces **one trace file per process**, and I was reading the largest, which belongs to
the `about:blank`/dump-dom infrastructure renderer. The page under test ran in a
_different_, smaller file, where the counts were exactly 50/50/1:

```
trace.11646.0.sbxd  35635 B  total=2267  title=0   tagName=39  getElemById=0
trace.11648.0.sbxd   1948 B  total=109   title=50  tagName=50  getElemById=1  <- the page
trace.11649.0.sbxd    413 B  total=24    title=0   tagName=0   getElemById=0
```

Reading the wrong file is indistinguishable from missing instrumentation. `sbxread.py`
now takes multiple files or a directory and decodes each separately rather than
silently picking one. **This is why the trace needs realm/document identity (plan P6
attribution) sooner rather than later** — selecting by file size is not a method.

Consequence: `MaybeFlush` currently flushes every record, which was added on the false
"lost tail" premise. It is safe but slower than necessary; batching can return once the
in-binary runner (P9) owns run completion and flushes explicitly.

### Cost of iteration, after the restructure

| Change                                     | Rebuild                       |
| ------------------------------------------ | ----------------------------- |
| `sbx_tracer.cc`                            | 1 TU + relink (~1 min)        |
| `sbx_tracer.h` / `sbx_scope.h`             | ~1,121 generated TUs (~5 min) |
| `bind_gen/interface.py`                    | regenerate + ~1,121 TUs       |
| _(previously, via `runtime_call_stats.h`)_ | _~28,650 edges, 70-81 min_    |

---

## M2b (part 1) — chokepoint B: interceptors, and real string bytes

**Status: chokepoint B PASSED** (2026-09-10). Remaining M2b items listed at the end.

### The interceptor hole is closed, with exact counts

A page doing 30 iterations each of `coll[0]`, `coll["span"]` and `window["myframe"]`:

| Interceptor                                    | Before | Now    | Page does        |
| ---------------------------------------------- | ------ | ------ | ---------------- |
| `HTMLCollection.IndexedPropertyGetterCallback` | **0**  | **30** | 30               |
| `HTMLCollection.NamedPropertyGetterCallback`   | **0**  | **30** | 30               |
| `WindowProperties.NamedPropertyGetterCallback` | **0**  | 36     | 30 (+6 internal) |

Keys are captured, which is the T0-relevant part:

```
[9]  HTMLCollection.IndexedPropertyGetterCallback  recv=dom(#6 HTMLCollection) key=index(0)
[11] HTMLCollection.NamedPropertyGetterCallback    recv=dom(#6 HTMLCollection) key=string(4)'span'
     WindowProperties.NamedPropertyGetterCallback  key=string(7)'myframe'   x30
```

Note the interface is **`WindowProperties`**, not `Window` — the named-property
interceptor lives on the `[Global]` named-properties object, per WebIDL. Grep for the
wrong name and it looks like the hole is still open.

### Implementation notes for the generator side

One `body.extend([...])` in `_make_interceptor_callback_def` covers every interceptor
site. The variant is selected from `arg_names`, which is exactly the information
available there:

| `arg_names` contains                            | Emitted                                                   |
| ----------------------------------------------- | --------------------------------------------------------- |
| `v8_property_name`                              | `SBX_INTERCEPTOR_SCOPE_NAMED(id, v8_property_name, info)` |
| `index`                                         | `SBX_INTERCEPTOR_SCOPE_INDEXED(id, index, info)`          |
| neither (Enumerator / IndexOf / IterableToList) | `SBX_INTERCEPTOR_SCOPE(id, info)`                         |

`info` is always the last argument, but its type varies across
`PropertyCallbackInfo<Value|Boolean|Integer|Array|void>`.

**The `void` variant settles a design question.** `PropertyCallbackInfo<void>` (IndexOf)
has no usable return value, and interceptors return `v8::Intercepted` whose "declined"
outcome a destructor cannot see. So `SbxInterceptorScope` records **on entry, in its
constructor**, and does not attempt an outcome.

**Known limitation:** whether an interceptor _declined_ (`v8::Intercepted::kNo`, falling
back to ordinary lookup) is guest-observable and is **not** captured. That needs the
rename-to-`<name>Impl` plus thin public wrapper approach. Registration tables reference
callbacks by public name only, so the rename is safe when we do it.

### Strings now carry real bytes

Up to 512 UTF-8 bytes verbatim, with the true length always recorded. Required for T0:
matching the host origin or `/~/sj/` inside a guest-visible string needs the bytes, not
the identity hash the first version emitted. Working example from a trace:

```
Window.atob -> string(332)'{"method":"Target.attachedToTarget","params":{...}}'
```

Use `Utf8Length`/`WriteUtf8`, **not** `Utf8LengthV2`/`WriteUtf8V2` — the V2 spellings are
`V8_DEPRECATE_SOON`. Write through a stack buffer and `base::as_byte_span(string_view)`;
`-Wunsafe-buffer-usage` and `-Wshorten-64-to-32` are both `-Werror` here, and the naive
"grow the sink and memcpy into it" version trips both.

### Process lessons from this stretch

- **Check the build succeeded before interpreting any test output.** One interceptor run
  looked like zero coverage; the build had actually failed, so it was the old binary.
  Same class of error as the `autoninja | tail` exit-status trap.
- **Sample one TU per signature variant before a full build.** A misplaced
  `SbxInterceptorScope` (inserted _outside_ `namespace blink::sbxdiff`, because the
  anchor comment sits after the namespace close) was caught in seconds by compiling
  `v8_window`/`v8_location`/`v8_element`/`v8_audio_track_list` rather than 11 minutes in.
- **The page's trace file was the _middle_ file by size** this time — neither largest
  nor second largest. There is no size heuristic. Decode all of them.

### M2b remaining

1. Interceptor decline outcome (rename-to-`Impl` + wrapper).
2. Realm/document identity per record — the fix for the file-identification problem above.
3. `SbxDiffInternals` (new non-testonly `core/sbxdiff/` interface).
4. Retro-gate patches 0002 and 0004 behind `BUILDFLAG(SBXDIFF)`.
5. Restore batched flush once P9's runner owns run completion.

---

## M2b (part 2) — realm identity

**Status: PASSED** (main world). 2026-09-10.

Trace files are now self-identifying, and this finally explains the file-identification
mystery that produced three wrong diagnoses earlier:

| File          | Size                  | Realms                                                                     |
| ------------- | --------------------- | -------------------------------------------------------------------------- |
| `trace.15800` | 47 KB (**largest**)   | `chrome://omnibox-popup.top-chrome/`, `chrome://webui-toolbar.top-chrome/` |
| `trace.15802` | 2.5 KB (**smallest**) | **`file:///tmp/intercept.html`** + 2 x `about:blank`                       |
| `trace.15803` | 7 KB                  | `chrome://headless/headless_command.html`                                  |

**The largest file was Chrome's own WebUI** — the omnibox popup and toolbar — which is
why it carried thousands of records and none of the test page's. The page under test was
in the _smallest_ file. No size heuristic could ever have worked.

Realms are separated correctly within a file, including iframes:

```
[0] REALM r1 -> about:blank
[3] REALM r3 -> file:///tmp/intercept.html
[6] REALM r5 -> about:blank
[4] r3  WindowProperties.NamedPropertyGetterCallback recv=object(#4) key=string(6)'chrome'
[12] r3 HTMLCollection.IndexedPropertyGetterCallback recv=dom(#9 HTMLCollection) key=index(0)
```

The two `about:blank` realms are the page's `<iframe name="myframe">`. Each realm has a
distinct global-proxy object id (`#2`, `#4`, `#6`), so cross-realm object identity is
distinguishable — which is what the differ needs for per-realm alignment.

Interceptor counts unchanged and still exact: 30 / 30 / 36.

**Gap:** `UpdateDocumentProperty()` is main-world only, so isolated worlds and workers
get a realm id but no URL mapping. Workers matter for the sandbox (scramjet's client
runs in them), so this needs its own hook.

## M4 (part 1) — determinism: keyed PRNG and task identity

Both patches compile clean and the PRNG gate passes. Task identity needed its source
replaced after measurement.

### P4 keyed PRNG — gate passed

One hook, in `base/rand_util_posix.cc`: `SbxdiffRandBytes` called first in
`RandBytesInternal`, which is the single chokepoint for every `//base` draw. Everything
page-visible routes through it — `crypto.getRandomValues` and `crypto.randomUUID` reach
it via `crypto::RandBytes`, which `crypto/random.cc` documents as "just an alias" for
`base::RandBytes`.

Measured on a page drawing `getRandomValues` ×2, `randomUUID`, `Math.random` ×2:

| Run                            | `draw1`                            | Verdict                                           |
| ------------------------------ | ---------------------------------- | ------------------------------------------------- |
| `--sbxdiff-run-key=1337`       | `222aadb6cba74505d31100032d3e8a3f` | —                                                 |
| `--sbxdiff-run-key=1337` again | `222aadb6cba74505d31100032d3e8a3f` | **identical**, incl. `draw2` + `uuid`             |
| `--sbxdiff-run-key=42`         | `b0ec6d8e79a549e7e269534492eaaecb` | differs, as intended                              |
| no key                         | `4819b7bd...` then `32789f48...`   | differs each run — patch inert without the switch |

`Math.random` was identical in every run above, including the unkeyed ones: it is pinned
by V8's `--random-seed`, entirely separately.

`CRYPTO_chacha_20` needed no new dependency — `//base` already links BoringSSL, and the
stock file includes `openssl/rand.h`. The nonce layout fell out nicely: ChaCha20's nonce
is exactly 96 bits, which holds `stream_id` (32) ‖ `draw_index` (64) with no room spare,
so the block counter is always 0 and each draw is an independent keystream.

### The run key was silently ignored for any non-numeric value

First test used `--sbxdiff-run-key=AAAA` and both runs diverged. That reads as "P4 is
broken", and the instinct was to go debug the ChaCha path. The actual cause was
`StringToUint64("AAAA")` failing, so the key parsed as absent and the run fell back to
real OS entropy — a **falsely nondeterministic run that is indistinguishable from a
genuine divergence**, which is the single worst failure shape for an oracle.

Fixed by making the key an arbitrary string hashed with SHA-256, so no parse failure mode
exists: presence of the switch, not the shape of its value, enables determinism. The
trace header's provenance field was inconsistent for the same reason and now stores
`base::PersistentHash` of the key string.

This is RULES.md #13 ("a switch that isn't relayed fails silently") in a new costume —
third instance in this project. The generalisation is stronger than the rule as written:
**any input the oracle silently ignores manufactures divergences.**

### P7 task identity — `TaskAttributionTracker` was the wrong primitive

Measured first: **0 of 3126 records attributed**, on a page exercising sync script, a
two-link promise chain, `setTimeout`, synchronous event dispatch and `requestAnimationFrame`
(all confirmed to have run — the DOM showed `id="later" class="p2"`).

The tracker object is installed by default, so `From(isolate)` is non-null; the earlier
worry about forcing features on was misplaced. But `CurrentTaskState()` is null unless
some feature has a context to propagate — it is an opt-in channel for
`SoftNavigationContext` / `ResourceTimingContext` / `WebSchedulingTaskState`, not a
universal task-id service. On an ordinary page there is nothing to propagate.

Replaced with V8's `AddBeforeCallEnteredCallback` / `AddCallCompletedCallback` pair,
which brackets exactly one top-level JS execution, with trailing microtasks folded in
(V8 drains the checkpoint before firing completed). Full reasoning, including why the
promise-hook alternative is rejected, is in `DETERMINISM.md` § "Task identity".

**Still open:** this gives task _identity_, not _causality_. There is no `parent_task_id`,
so M4's "causal graph is connected — no orphan tasks" clause is **not met**. Task ids are
per-thread sequential and pair across runs by equality, which is enough to segment the
trace; the three candidate routes to real edges are listed in `DETERMINISM.md`.

### Lesson: measure the primitive before building on it

Two rounds of reasoning about `TaskAttributionTracker` — first that it needed features
forced on, then that it was enabled by default — were both spent on the wrong question,
and the second was reported as settled fact. A single decode of a real trace answered it
in one step. Reading an API's installation path says nothing about whether it is
_populated_; only a measurement does.

## M4 (part 2) — measured task ids, and the microtask gap

The V8 call-entered/completed design works, and the decode located its limit precisely.

Page process, `async.html` (sync script + 2-link promise chain + `setTimeout` +
synchronous event dispatch + `rAF` + a nested promise inside a second timer):

| Records     | Task     | What                                                                                       |
| ----------- | -------- | ------------------------------------------------------------------------------------------ |
| `[6]–[19]`  | `t7`     | the synchronous script — one task, correctly including the nested `dispatchEvent` listener |
| `[20]–[23]` | **`t0`** | the two promise continuations                                                              |
| `[24]–[25]` | `t8`     | the `setTimeout` callback — correctly a new task                                           |
| `[26]–[27]` | **`t0`** | the promise nested inside the second timer                                                 |
| `[29]–[31]` | `t10`    | `--dump-dom` serialisation                                                                 |

So script and timer tasks are exactly right, and **every microtask was
unattributed**. Cause, confirmed in V8 and Blink source rather than guessed:
Blink sets `MicrotasksPolicy::kScoped` (`v8_initializer.cc:908`), so V8's
`FireCallCompletedCallbackInternal` skips its checkpoint — Blink drains
microtasks itself, _after_ call depth has already reached zero — and V8 does not
fire `BeforeCallEntered` for microtask jobs at all.

Notably this was predicted before the run, from reading the policy, after the
previous comment in the header had asserted the opposite. Worth keeping: the
prediction was cheap and the measurement settled it.

Fixed with a lazy open in the record path rather than a new V8 hook, because no
V8 hook would have sufficed: `v8::Isolate`'s microtasks-completed callback
covers only the isolate's _default_ queue, while Blink drains per-agent
`MicrotaskQueue`s. Granularity is one id per microtask **checkpoint**; records
within a checkpoint remain strictly ordered by seq.

### A decoder bug was inflating the "unattributed" count

`sbxread.py` tallied task ids for `kBindingCall` but not `kInterceptor`, while
counting interceptors in the denominator. Real figure for the page process was
22/30 across 5 tasks, not 19/30 across 3. Worth stating plainly: **the
measurement tool is part of the oracle** and needs the same scrutiny as the
patches.

### Interceptor decline, done cheaply

The plan wanted every generated interceptor renamed to `<name>Impl` with a thin
public wrapper emitted around it. Not needed. Wrapping at the **registration
site** — where the function pointer is handed to
`v8::NamedPropertyHandlerConfiguration` — gets the same result from one header:

```cpp
template <auto Fn> struct SbxIntercept;
template <typename Key, typename Info, v8::Intercepted (*Fn)(Key, const Info&)>
struct SbxIntercept<Fn> { static v8::Intercepted Run(Key, const Info&); };
```

Two partial specializations (2-arg and 3-arg) cover all **22** wrapped slots,
because every `Intercepted`-returning callback has the shape
`Intercepted (*)(Key, [Extra,] const PropertyCallbackInfo<R>&)` and the types
are deduced from the function pointer. No callback bodies change, and no name
plumbing is needed: the outcome record refers back to the body's own record by
seq, sampled _before_ the inner call so nested interceptors cannot steal it.
Enumerators return `void` and cannot decline, so they are left alone; so are
Blink's `IndexOf` / `IterableToList` fast paths.

Verified in the generated output: 11 wrapped slots in `v8_html_collection.cc`
(named + indexed) and the cross-origin pair in `v8_location.cc` and
`modules/v8/v8_window.cc`. Six sample TUs covering all three registration
patterns compile clean before committing to a full build — the per-variant
sampling discipline from M2, which caught a 6-minute-late failure back then.

### The snapshot reference table caught the wrapper change — loudly

The first full build with the interceptor wrappers failed:

```
FAILED: ... ACTION //tools/v8_context_snapshot:generate_v8_context_snapshot
./v8_context_snapshot_generator failed with exit code -5
Unknown external reference 0x10ab21494.
```

`v8_context_snapshot_generator` serializes a context including the function
pointers installed in object templates, and resolves each against the
per-interface `GetRefTableOfV8<Iface>()` tables. Wrapping at the registration
site changed _which_ pointer is installed, so the wrapper address was not in
the table.

Only six interfaces participate in the snapshot — Document, EventTarget,
HTMLDocument, Node, Window, WindowProperties — and the two with interceptors
are `WindowProperties` (named + indexed) and `Window` (cross-origin). So any
interceptor change hits this by construction.

Fixed in the same generator function that builds the table
(`_make_v8_context_snapshot_get_reference_table_function`), emitting **both**
the raw and the wrapped address. Both, not just the wrapped one, because the
table is a pure lookup: extra entries cost one pointer each and a superset
cannot be wrong, whereas guessing exactly which callbacks are installed raw vs.
wrapped depends on `% if` conditions in four separate emission patterns.

Measured after the fix: 10 wrapped entries in `WindowProperties`, 16 in
`Window`. The `Window` count exceeds the 11 install-site wrappers because the
table also collects callback defs that are generated but never installed —
harmless, and the reason keeping both addresses was the right call.

**This is the good failure mode.** It is a build error, not a silent behaviour
change, and it is structurally impossible to ship past. Contrast the run-key
parse bug earlier the same session, which silently produced fake divergences.

### Two ways a failed build reported success

1. `autoninja ... | tail` returns `tail`'s status (known, RULES.md #15).
2. A **backgrounded** build returns the exit code of the last command in the
   chain. The job here ended with `echo "BUILD_RC=$?"`, so the harness reported
   `exit code 0` for a build whose own log said "finished with an error".

Caught only because the log tail was read. RULES.md #15 now requires grepping
the log for `error:|FAILED|finished with an error` rather than trusting any
exit status.

## M4 (part 3) — verification of 0006/0007 on the built binary, and one open bug

### Interceptor decline: verified, with correct semantics

100% of interceptor records annotated in every process: 91/91, 4/4, 8/8. And
**57 of 91 declined** in the WebUI renderer — declines are not an edge case,
they were simply invisible before.

Semantics check on `decline.html` (an `HTMLCollection`, which has both named and
indexed interceptors):

| Record                                         | Key            | Outcome     | Correct?                                           |
| ---------------------------------------------- | -------------- | ----------- | -------------------------------------------------- |
| `HTMLCollection.IndexedPropertyGetterCallback` | `index(0)`     | INTERCEPTED | yes, element exists                                |
| `HTMLCollection.IndexedPropertyGetterCallback` | `index(99)`    | DECLINED    | yes, out of range                                  |
| `HTMLCollection.NamedPropertyGetterCallback`   | `'nosuchname'` | DECLINED    | yes                                                |
| `WindowProperties.NamedPropertyGetterCallback` | `'chrome'`     | DECLINED    | yes — a real property, not a named-property lookup |

`c.item` produced **no** interceptor record at all, which is also right:
`kNonMasking` means V8 consults the prototype chain first and never calls the
interceptor when it finds the property there.

The nesting design is visible in the output too. Record `[8]`'s outcome is
emitted _after_ record `[9]`, because the interceptor constructed a wrapper
object while running. The outcome still attributes to `[8]` — the seq is
sampled before the inner call, which is exactly the hazard the design was
built for.

### Task attribution: 100%

The lazy open closed the gap completely: 2297/2297, 34/34, 19/19 — no `t0`
records anywhere, on the same pages that previously left every microtask
unattributed.

### Worker realm identity: verified twice

Dedicated worker on its own trace file (`trace.<pid>.1.sbxd`), realm
`http://127.0.0.1:8931/worker.js`, 11/11 records attributed, and
`Crypto.randomUUID` recorded on the worker thread — which incidentally proves
the keyed PRNG reaches worker threads.

Verified independently before that, by accident: an extension service worker
(`chrome-extension://.../background.js`) showed up with a URL, because MV3
service workers also go through `WorkerOrWorkletScriptController`.

`file://` workers are blocked by default, so worker testing needs an HTTP
origin — which is the real configuration anyway. A local `python3 -m http.server`
is sufficient.

### Worker PRNG determinism holds across runs

The per-thread `stream_id` is handed out in first-call order, which is in
principle unstable. Measured on the worker thread, same run key, three runs:

```
run1 worker uuid: 06c054bf-78da-4528-89c9-aa3093d45902
run2 worker uuid: 06c054bf-78da-4528-89c9-aa3093d45902
run3 worker uuid: 06c054bf-78da-4528-89c9-aa3093d45902
```

Identical. The ordering caveat stands in principle, but it held over three runs
on a two-thread workload.

### OPEN BUG: tracing + a file:// worker blocked by file-access policy hangs

Reproducible 5/5. Narrowed by matrix:

| Config (tracing on unless noted)                            | Hang rate |
| ----------------------------------------------------------- | --------- |
| `file://` page, `new Worker()` blocked by file policy       | **5/5**   |
| same, tracing **off**                                       | 0/5       |
| `file://` + `--allow-file-access-from-files` (worker loads) | 0/3       |
| `http://` worker that loads                                 | 0/3       |
| `http://` worker that 404s                                  | 0/3       |
| throwing binding calls (no worker)                          | 0/3       |
| no worker                                                   | 0/3       |

So it is **not** "workers + tracing", **not** "failed worker load + tracing",
and **not** "exceptions + tracing" — each of those was tested and cleared.

`lldb -p ... thread backtrace all` on every renderer _and_ the browser process
shows **every thread in a wait** (`mach_msg2_trap` / `kevent64` /
`__workq_kernreturn`), with no sbxdiff frame anywhere and nothing blocked on
`write`. So this is a missed completion signal, not a lock deadlock in the
tracer — the headless command handler simply never finishes.

**Impact on this project: low.** The target is served over HTTP with loadable
workers, which is a cleared configuration. But it is a real liveness bug in the
patched binary and it proves the tracer can affect liveness, so it must not be
left implicit.

**Next step when picked up:** bisect by no-op'ing the 0006 hook (one core TU +
link). A likely fix that is also a design improvement: don't let `NoteRealm`
_create_ a tracer, but stash the pending realm URL and emit it with the
thread's first real record. That would also stop emitting the 82-byte
header-only trace files for threads that never record.

### Two mechanism claims I got wrong before measuring

1. "A worker is a second virtual-time client, so `TryAdvancingTime` pins the
   clock" — stated on seeing the first hang, citing RULES.md #12. Wrong: the
   same page over HTTP with virtual time exits in 3s, and the hang reproduces
   with **no** virtual time at all.
2. "The `Worker` constructor throws synchronously and the binding scope
   mishandles a pending exception" — plausible, and wrong: throwing binding
   calls do not hang, 0/3 on both origins.

Both were single-run inferences. The hang rate only became legible after
running the same configuration N times, because contradictory single runs had
made it look nondeterministic when it is in fact 5/5 deterministic per
configuration. **Measure a rate, not an instance.**

## P3 time: the pin works, and is not yet usable

`--sbxdiff-initial-time=1700000000000`, two runs, same page:

```
run1: dateNow=1789115822244 dateAfterTimeout=-89115822244 tzOffset=480
run2: dateNow=1789115822836 dateAfterTimeout=-89115822836 tzOffset=480
```

The pin **is** taking effect, in two independent ways: `Date.now()` read inside
the `setTimeout` callback returns the pinned time (hence the ~-89e9 ms delta
against a `t0` captured at script start), and `getTimezoneOffset()` moves
420 → 480 because the pinned instant is PST while the real date is PDT. Both
confirm the override is live and correctly plumbed.

But it lands **after the page's first script has already run**, so the page
observes the real clock, then time jumps backwards by nearly three years
mid-run. That is _worse_ than not pinning at all: a backwards `Date.now()` is
itself a glaring, easily-detected artefact, where an unpinned-but-monotonic
clock is merely nondeterministic.

Root cause is the same one already predicted for the residual
`performance.now()` variance: the headless command handler enables virtual time
over CDP some variable number of real milliseconds into startup, i.e. after
navigation has begun. No clock patch can fix that from where it sits — the fix
is to enable virtual time before navigation, which is the in-binary runner (P9).

**Do not pass `--sbxdiff-initial-time` until P9 exists.** The patch is correct at
its chokepoint and is kept for P9 to use; it is documented as inert-until-then
rather than removed, because rediscovering the chokepoint is the expensive part.

### The CHECK is loud in the wrong place

A malformed value does produce the intended message:

```
FATAL:...thread_scheduler_base.cc:48] Check failed: base::StringToInt64(value, &unix_ms).
  --sbxdiff-initial-time must be an integer number of milliseconds since the Unix
  epoch, got: not-a-number
```

...but it fires in the **renderer**, which dies, and the headless run then hangs
instead of exiting. "Fail loudly" became "hang with a message buried in
stderr" — which is the failure shape RULES.md #13 exists to prevent, reached by
a different route. Validation of a switch's _syntax_ belongs in the browser
process at startup, before any renderer launches. Recorded as a follow-up.

### Ruled out: the command-line DCHECK is not ours

The same stderr showed `FATAL:base/command_line.cc:309] DCHECK failed:
current_process_commandline_` twice, which looked like
`base::CommandLine::ForCurrentProcess()` being called from `RandBytesInternal`
before `CommandLine::Init()` — a real hazard, since the DCHECK fires _inside_
the accessor and the `if (!cmd)` guard in patch 0007 cannot catch it.

Measured instead of assumed: **2 occurrences with no sbxdiff switches at all**,
and 2 with each of them. Pre-existing crashpad-handler noise in this
`dcheck_always_on` build, consistent with the crashpad `ReadExactly` errors
already in the benign-noise list. Not caused by patch 0007.

## P4 was NOT passing — the gate passed by luck

Re-running the randomness gate after the key derivation changed to SHA-256
showed two runs of the same key producing **different** draws. Measured rate
over 5 identical runs:

```
3  "draw1":"c60000f33c05ac0d46942345956adc0e"
1  "draw1":"9690c01cbc4371d0791e1741630afee6"
1  "draw1":"0bef1b27c4d124482aee383a77a20d92"
```

Three distinct values in five runs. The earlier "gate passed, byte-identical"
result was real but **lucky** — two runs that happened to agree.

The diagnostic detail that identified the cause: `9690c01c...` is the value
that appeared as **`draw2`** in a different run. The key was therefore correct
and the _counter_ was offset — a shifted `draw_index`, not a changed key.

Cause. `stream_id` is per-thread, so every draw on the renderer main thread
shares one counter — including Chromium's own internal `base::RandBytes` calls.
The number of internal draws before a page's first `getRandomValues()` varies
run to run, which shifts every subsequent page draw.

The design comment in `rand_util_posix.cc` claimed "a differing _number_ of
draws in one stream cannot desynchronize another". That is true **across**
streams and was the right property to want, but web-exposed randomness had no
stream of its own, so it shared the main thread's stream with exactly the
internal activity that varies. The counter-based design was necessary and not
sufficient.

Fix: `base/sbxdiff_rand_stream.h` adds `SbxdiffScopedRandStream`, reserving
stream ids 1..15 for explicit streams with their own per-stream counters, and
moving automatic per-thread ids to 16+ so they cannot collide.
`blink::Crypto::getRandomValues` and `Crypto::randomUUID` enter
`kSbxdiffStreamWebCrypto`, so the draws a page can actually observe are a pure
function of (run*key, stream, n-th draw \_in that stream*) and are immune to
unrelated activity on the same thread.

This is the plan's P6 "attribution-based streams" arriving earlier than
scheduled, because P4 does not hold without it.

**Lesson, and it is the same one twice in one session:** a two-run agreement is
not a determinism gate. RULES.md #17 said to measure a rate for _intermittent_
behaviour; the stronger form is that **any** determinism claim needs N runs,
because a passing pair cannot distinguish "deterministic" from "1-in-3 flaky".

### P4 gate, re-measured after the stream fix — passes

```
--- same key (alpha-key) x5: distinct results should be 1 ---
   5 "draw1":"b28226fc6fdbb361c94d40a03d260766","draw2":"0a8c398da54268cd5282619d91808d0e","uuid":"433e6ae2-9f90-4f38-88a1-08b3e5b7e718"
--- different key (beta-key) x2 ---
"draw1":"0e4e48f6e7c2216907e2b6aee982a48a","draw2":"11217e3acab5dee0517ff1a8135a0e62","uuid":"2aa27cd4-62ae-43e3-93da-146968f72d97"
--- no key x3: should be 3 distinct ---
       3
```

All five same-key runs collapse to **one** distinct result, the different key
is stable and distinct, and the unkeyed runs are all different. Worker thread
re-checked over three runs (`randomUUID` there routes through the same stream):
`480e1ebb-7a0e-4ae1-b7f0-17f262b67665` three times.

Gate script kept at `tools/sbxdiff/p4gate.sh`; it should be rerun as a
5-run measurement after any change touching randomness, not as a pair.

## Deferred realm notes, browser-side validation, and the hang narrowed further

### NoteRealmForContext: realm hooks no longer create a tracer

`SbxTracer::NoteRealmForContext` stashes the URL when this thread has no tracer
and emits it with the thread's first real record (before that record starts
building — splicing one record into another is the bug interning already caused
once). Both realm hooks now use it.

The pending URL is a POD `thread_local` struct with no default member
initializers: a `thread_local std::string` trips `-Wexit-time-destructors`, and
a default member initializer trips `-Wglobal-constructors`. Both are `-Werror`.

Effect, measured: the 82-byte header-only trace file is **gone**, realm URLs are
unchanged, and attribution stays at 100% (3423/3423). Worth having on its own.

### Browser-side switch validation works

```
exit=5 after 0s
ERROR:chrome/app/chrome_main_delegate.cc:1131] --sbxdiff-initial-time must be an
  integer number of milliseconds since the Unix epoch, got: not-a-number
```

Instant, before any renderer spawns, replacing a renderer CHECK that killed the
renderer and left the run hanging. Two include traps on the way: the
`base/base_switches.h` include in `chrome_main_delegate.cc` sits inside
`#if BUILDFLAG(IS_WIN)`, and `switches::` in `chrome/` resolves to a different
namespace than `::switches::`.

### The hang: patch 0006 is EXONERATED, and the trigger is narrower

The deferral makes a never-recording worker thread behave exactly as it did
before patch 0006 existed. The hang still reproduces **5/5**. So the worker
realm hook was never the cause — a clean elimination, and the reason the fix
was written to double as the bisect.

Narrowed further:

| Case (`file://`, tracing on)              | Result       |
| ----------------------------------------- | ------------ |
| `new Worker(...)` **alone**               | ok 3/3       |
| `new Worker(...)` + `onerror`             | **hung 3/3** |
| `new Worker(...)` + `postMessage`         | **hung 3/3** |
| `http://` worker that **404s**, + both    | ok 3/3       |
| throwing _method_ calls                   | ok 3/3       |
| throwing _constructor_ (`new URL('bad')`) | ok 3/3       |

Two things this rules out and one it points at:

- Not the worker realm hook, not tracer-creation-on-a-worker-thread, not
  exceptions (neither methods nor constructors).
- Not "worker fails to load" in general — an HTTP 404 is fine. It is
  specifically a fetch blocked by **security policy**.
- The constructor alone is harmless; the hang needs a subsequent binding call
  whose receiver is the live `Worker` wrapper. That keeps the worker
  referenced through its failure path.

Next diagnostic when picked up: log inside the tracer around binding calls whose
receiver is a `DedicatedWorker`, or bisect the tracer itself (disable
`EncodeValue`'s DOM branch, then `ObjectIdFor`'s private-symbol write) rather
than bisecting the call sites. The earlier all-threads-idle backtrace means the
answer is a missed signal, so the interesting question is what the tracer keeps
alive or fails to release, not where it blocks.

## P9a — enabling virtual time before navigation

The origin pin from patch 0008 was correct but landed after the page's first
script. `Page`'s constructor already fetches the virtual-time controller
_before_ the main frame is attached, which is the earliest per-page point where
no script can have observed a clock. Enabling there, triggered by
`--sbxdiff-initial-time` already being present (no new switch), passing
`base::Time()` so patch 0008's fallback stays the single source of truth, and
relying on `EnableVirtualTime` being idempotent so the CDP budget path still
owns termination.

Main-thread page schedulers only: workers must not become a second virtual-time
client, or `TryAdvancingTime` takes the min across clients and can pin the clock
forever (RULES.md #12).

### Measured: the backwards jump is gone, the origin is pinned, load time is not

Four runs, `--sbxdiff-initial-time=1700000000000`:

| Field                                     | Result                                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `dateAfterTimeout` for `setTimeout(…,10)` | `10` in all four                                                                         |
| `tzOffset`                                | `480` in all four (PST for the pinned instant)                                           |
| backwards jump                            | **gone** — time now starts at the pin and runs forward                                   |
| `timeOrigin`                              | `1700000000021.6` / `…017` / `…019.2` / `…014.1` — pinned to ~20 ms, was real wall clock |
| `perfNow0`                                | **2095593 / 3002788 / 3002991 / 3302485**                                                |

So the origin is pinned and monotonic, but 2.09–3.30 _seconds of virtual time_
elapse before the page's first script, and that amount varies.

Cause: the default policy is `kAdvance`, documented as "if the blink scheduler
runs out of immediate work, the virtual timebase will be incremented so that
the next scheduled timer may fire". During startup the scheduler is repeatedly
out of immediate work while waiting on real I/O, so the clock races ahead by an
amount that depends on real timing — exactly the coupling virtual time is
supposed to remove.

Fix under test: set `kDeterministicLoading` at early-enable, which is documented
as "Initially virtual time is not allowed to advance until we have seen at least
one load. The aim being to try and make loading (more) deterministic" — i.e.
built for this window. Preferred over `kPause`, which would stop delayed tasks
outright and risks stalling the load.

This is also a correction to an earlier note in this file, which attributed the
residual `performance.now()` variance purely to _when_ virtual time is enabled.
Enabling it earlier was necessary but not sufficient; the policy during the
startup window matters as much.

### kDeterministicLoading did not help, and the contrast rows explain why

Four more runs with `kDeterministicLoading` at early-enable:

```
perfNow0: 2589685 / 2711192 / 4962985 / 5837780
```

Not only still variable, but a _wider_ spread than `kAdvance` (2.09–3.30s).

The decisive data point was the control rows in the same table. **Unpinned**
runs — i.e. no early enable at all — produced `perfNow0:
12.100000001490116` in _both_, byte-identical. So `performance.now()` at script
start was already deterministic, and the early virtual-time enable is what broke
it.

The magnitude says what is happening: `dateNow - pin` is ~5,837,807 ms, i.e.
**~97 minutes** of virtual time elapsed during startup. Virtual time advances by
jumping to the next delayed task's scheduled time, so with the clock live during
browser startup it fast-forwards through far-future housekeeping timers — and
which of those exist, and in what order, varies per run.

`kDeterministicLoading` does not prevent this because its restraint is tied to
pending _loads_; during early startup there is no load pending yet, so it is
free to advance.

Under test now: `kPause` at early-enable, which forbids advancement outright.
Loading is I/O-driven and should proceed with only delayed tasks held, and the
CDP budget path releases the clock shortly after by setting its own policy.

**Method note.** This is the second time in this section that the control row
carried the finding rather than the treatment row. Keeping an unpinned pair in
the same table — cheap, two extra runs — is what turned "the pin does not work"
into "the pin works and my fix for a _different_ field regressed this one".

### kPause hangs. P9a abandoned, and why the whole approach was wrong

| Policy at early-enable  | Result                                                                    |
| ----------------------- | ------------------------------------------------------------------------- |
| `kAdvance` (default)    | runs; 2.09–3.30 s of variable virtual time before the page's first script |
| `kDeterministicLoading` | runs; 2.59–5.84 s — wider                                                 |
| `kPause`                | **hangs** (>10 min)                                                       |

All three fail, and the reason is structural rather than a bad policy choice.
The normal `--virtual-time-budget` flow does not blow up because CDP does three
things together: enable, set a policy, **and grant a bounded budget**
(`GrantVirtualTimeBudget`). The budget is what caps advancement. Enabling
virtual time early without a budget leaves an advancing clock loose during
browser startup, where the scheduler is idle and the next delayed task may be a
housekeeping timer tens of minutes out — hence ~97 minutes of accrued virtual
time. `kPause` avoids that by never advancing, but then nothing releases the
clock in time and the run deadlocks.

**P9a is reverted** (`page.cc` back to stock). It regressed a field that was
already deterministic — `performance.now()` at script start, byte-identical
across unpinned runs — in exchange for pinning `timeOrigin`, which is a bad
trade.

What this establishes for the real P9: pinning absolute time requires owning
**enable + policy + budget + navigation together**, in that order, before the
target page is navigated. That is the in-binary runner as originally scoped, not
a one-line hook in `Page`'s constructor. `--sbxdiff-initial-time` (patch 0008)
stays in the tree and stays documented "do not use yet": it is correct at its
chokepoint and is what the runner will use.

Current honest state of time determinism:

| Field                               | Status                                           |
| ----------------------------------- | ------------------------------------------------ |
| time _deltas_ (`setTimeout(…,10)`)  | deterministic — exactly `10`                     |
| `performance.now()` at script start | deterministic (`12.100000001490116` across runs) |
| `getTimezoneOffset()`               | pinned by `TZ`                                   |
| `Date.now()` absolute               | **not** deterministic                            |
| `performance.timeOrigin`            | **not** deterministic                            |

The two open ones are absolute-origin values only, and both are blocked on the
same piece of work.

### Correction: `performance.now()` was never deterministic either

After reverting P9a I re-ran the baseline as **four** runs instead of two:

```
   2 "perfNow0":10,                "perfAfterTimeout":20
   1 "perfNow0":9.899999998509884, "perfAfterTimeout":20
   1 "perfNow0":9.900000005960464, "perfAfterTimeout":20
```

Three distinct values in four runs, spread ~0.1 ms. The earlier claim that it
was "byte-identical across runs" came from a **pair** that happened to agree —
the identical mistake as the P4 gate, made _two steps after_ writing RULES.md
#17 which forbids exactly this. Recording it plainly rather than quietly
amending the table.

Two things this does not change:

- **Reverting P9a was still right.** ~0.1 ms of jitter versus 2–6 _seconds_ is
  not a close call, and P9a did not deliver deterministic `Date.now()` either
  (1700005837807 / 1700004963007 / 1700002711207 / 1700002589707 across four
  pinned runs).
- **Deltas remain exact.** `perfAfterTimeout - perfNow0` is exactly `10` in all
  four runs, matching `dateAfterTimeout`. What varies is only the origin the
  measurement is taken from.

Corrected state of time determinism:

| Field                                                             | Status                |
| ----------------------------------------------------------------- | --------------------- |
| time _deltas_ (`setTimeout(…,10)`, `perfAfterTimeout - perfNow0`) | deterministic, exact  |
| `getTimezoneOffset()`                                             | pinned by `TZ`        |
| `performance.now()` at script start                               | **~0.1 ms jitter**    |
| `Date.now()` absolute                                             | **not** deterministic |
| `performance.timeOrigin`                                          | **not** deterministic |

All three open items are origin values and all three are blocked on the same
work (P9). Nothing in the tracer or the randomness path is affected.

## P9b — enable + policy + **budget**, and `Date.now()` becomes deterministic

P9a was reverted for having only two of the three pieces. The controller's own
documentation named the missing one: `GrantVirtualTimeBudget` sets a fence that
virtual time "may not advance past". That fence is what stops an idle scheduler
fast-forwarding to a far-future housekeeping timer.

`Page`'s constructor now does all three together — enable,
`kDeterministicLoading`, and a bounded budget — behind the existing
`--sbxdiff-initial-time`, with `--sbxdiff-virtual-time-budget` (default 2000 ms)
for the fence. The budget callback is `base::DoNothing()`: the controller
documents that the policy is unaffected on expiry, so there is nothing to undo
and no Oilpan lifetime to manage.

### Measured, 4 pinned runs

| Field                                   | Result                                  | Verdict        |
| --------------------------------------- | --------------------------------------- | -------------- |
| `Date.now()`                            | `1700000004000` × 4                     | **exact**      |
| `dateAfterTimeout` (`setTimeout(…,10)`) | `10` × 4                                | exact          |
| `getTimezoneOffset()`                   | `480` × 4                               | exact          |
| `performance.timeOrigin`                | `…015.7 / 015.9 / 015.9 / 017.4`        | ~1.7 ms jitter |
| `performance.now()` at script start     | `3984.30 / 3984.30 / 3984.10 / 3982.70` | ~1.6 ms jitter |

`1700000004000` is exactly `initial + 4000 ms`, i.e. the sum of our 2000 ms
fence and the CDP budget granted afterwards. The value is fence-determined
rather than timing-determined, which is precisely why it is reproducible.

Control rows in the same table: **unpinned** `perfNow0` spans 9.6–12.7 (~3.1 ms).
So the pinned runs are _tighter_ than the baseline on the fields that still
jitter, and exact on the one that matters most.

### Residual, and why it is where it is

`timeOrigin` is stamped when the document is created, which happens ~15–17 ms of
virtual time after `EnableVirtualTime`, and that window varies by ~1.7 ms.
`performance.now()` inherits it, being `now - timeOrigin`. Closing it needs
virtual time to not advance _at all_ before document creation; `kPause` does
that and deadlocks, so it wants the full runner that controls navigation
ordering, not another policy tweak.

### No regressions

- P4 randomness gate: same key ×5 → 1 distinct result.
- Tracing: 2622/2622 and 34/34 attributed, 97/97 and 4/4 interceptor outcomes.
- Page behaviour under the fence is intact — `async.html` still resolves both
  promise links and both timers (`id="later" class="p2"`).
- `--sbxdiff-virtual-time-budget=abc` → `exit=5` with a clear message, via the
  browser-side validation loop (adding the switch to that loop was one line).

### Status change

`--sbxdiff-initial-time` moves from "do not use yet" to usable, paired with
`--sbxdiff-virtual-time-budget`. The full in-binary runner is still wanted — to
own navigation and termination, drop the `chrome://headless` realm, get off CDP,
and let the tracer restore batched flush — but it no longer blocks time
determinism.

## The in-binary runner (P9 proper) — first working version

`chrome/browser/headless/sbxdiff_runner.{h,cc}`, wired from
`startup_browser_creator_impl.cc`, selected by `--sbxdiff-run[=<grace_ms>]`.

It attaches to the tab the **normal startup path already opened** rather than
creating a synthetic `WebContents`, so the page runs in an ordinary browser tab.
That matters for an oracle: a run that is structurally different from a normal
one is not a valid baseline. It waits for `DidStopLoading`, allows a real-time
grace (default 1000 ms) for the tail of already-scheduled work, then quits.

This is only possible because patch 0010 moved virtual time renderer-side. While
the clock still had to be started over CDP, a traced run could not avoid the
DevTools session.

### Measured: the CDP handler realm is gone

Before (`--dump-dom --virtual-time-budget`), every trace contained:

```
r1   34 records   chrome://headless/headless_command.html
```

With `--sbxdiff-run` that realm is **absent**. The page's own trace is intact —
24 records, 6 tasks, 100% attributed — and the run takes ~3 s wall clock.

Two costs removed at once:

1. 34 records per run of handler-page noise the differ would have to know to
   ignore.
2. The DevTools session itself. Attaching one enables the `Runtime` and
   `Debugger` domains, which change console and stack-trace behaviour and are
   observable from the page. A CDP-driven run is therefore not a valid oracle
   for a site that looks, which is exactly the constraint this project started
   with.

### First version segfaulted the browser on exit, and why

`exit=139`. `Finish()` called `CloseAllBrowsersAndQuit()`, which destroys the
`WebContents`, which calls `WebContentsDestroyed()`, which called `delete this`
— and then `Finish()` deleted `this` a second time. Re-entrancy by construction,
not a race.

Fixed with a `finished_` latch, `Observe(nullptr)` before teardown so the
teardown cannot call back in, and `DeleteSoon` instead of `delete this` because
`Finish()` can be running inside an observer callback from the very object being
torn down. The keepalive is released _after_ the quit is requested — it is what
stops the browser exiting before the trace is complete.

Worth noting the trace was complete and correct in the crashing version: the
tracer flushes every record, so the segfault cost nothing but the exit code.
That is the batched-flush TODO earning its keep in a way that was not planned.

### The hang: complete elimination table, still open

Every arm measured over 3+ identical runs, never a single instance.

| Arm                                                                  | Crashes?               | Eliminates                            |
| -------------------------------------------------------------------- | ---------------------- | ------------------------------------- |
| UA forced back to `HeadlessChrome`                                   | yes                    | patch 0002                            |
| `mask=15` — every `Trace*` early-returns                             | yes                    | the record path                       |
| `mask=16` — `SbxBindingScope` destructor body                        | yes                    | reading `GetReturnValue()` / `This()` |
| `mask=31` — all of the above **+** `SbxInterceptorScope` constructor | yes, _identical stack_ | all tracer work                       |
| `SBX_INTERCEPT` compiled to identity                                 | yes                    | the registration wrappers             |
| tracer self-disabled (`--sbxdiff-trace-out` → unwritable dir)        | **no, 3/3 clean**      | —                                     |

The last row is the important one, and it is what makes the remaining space
small. That run uses the **same binary and the same generated code** — the
scope objects are still compiled into every callback, the wrappers are still
installed — and it does not crash. So the cause is not codegen shape, not the
scopes' presence, and not anything the tracer computes. The single remaining
variable is `SbxTracer::Get()` returning non-null, i.e. a tracer object having
been constructed and a trace file opened.

Also corrected along the way: the two identical `GetAttributeRegisteredEventListener`
frames looked like infinite recursion, and `SEGV_ACCERR` looked like a guard
page. The function's source contains no self-call, so those frames are an
unwinder artifact of `symbol_level=0`, not a stack overflow. Worth stating
because it briefly sent the diagnosis in the wrong direction.

**Impact remains low and bounded**: `file://` only, worker blocked by security
policy only, and a subsequent binding call on the live `Worker` wrapper. The
target configuration (HTTP, loadable workers) is a cleared row in an earlier
table.

**Next arm, when picked up.** The remaining hypothesis is that constructing the
tracer perturbs something in the renderer independently of what it records —
the only candidates left are the `base::File` open/write itself and the
`g_pending_realm` thread-local write in `NoteRealmForContext`. Both are testable
with one build by gating each separately behind further `--sbxdiff-debug-disable`
bits. If neither is implicated, the next step is a `gn` build with
`blink_symbol_level=2` to get a symbolised frame inside
`GetAttributeRegisteredEventListener` and find which pointer is bad, rather than
continuing to bisect from the outside.

## Two-phase virtual time budget — patch 0010 had a defect my gate could not see

Running the page under the **runner** (no CDP) exposed it: a two-timer page
fired its `setTimeout(0)` callback and then stopped. The nested
`setTimeout(…, 1)` never ran. Identical at a 2000 ms and a 10000 ms fence,
which is what ruled out "the fence is too small".

Cause: the fence granted in `Page`'s constructor is _consumed during load_, so
by the time page script runs the clock sits at the fence. A `setTimeout(0)`
still fires because it is already due; anything later never fires at all.

### Why the P9b gate passed anyway — a control-set gap, not a sample-size gap

Every P9b run passed `--virtual-time-budget=2000`, which makes CDP grant a
_second_ budget after the page has started, silently re-arming the fence. So
`dateAfterTimeout: 10` firing correctly was **CDP covering for the bug**.

This is a different mistake from the pair-vs-N-runs errors earlier in this
session, and worth distinguishing: running the same configuration more times
would never have caught it. The gate exercised the configuration being moved
_away from_, so it was structurally blind to a defect specific to the
configuration being moved _to_. **When replacing a mechanism, the gate has to
run without the old one.**

### Fix

Re-grant the budget in `LocalWindowProxy::UpdateDocumentProperty` (main world
only) — the last point before script can observe a clock.
`GrantVirtualTimeBudget` _sets the remaining budget_, so this re-arms the fence
relative to current virtual time while keeping the constructor's fence doing its
job against startup fast-forward.

Measured after: the two-timer page now produces **6** records including the
nested timer's `Document.title.set`, where it produced 5 before. `async.html`
gives an identical decoded record count across 3 consecutive runner runs. P4
randomness gate unaffected (same key ×5 → 1 distinct result).

## GAP: binding arguments are not traced at all

Found while checking the timer fix. The trace records **receiver and result**,
never arguments:

```
[5]  Node.textContent.set   recv=dom(#3 HTMLDivElement) -> undefined
[6]  Document.title.set     recv=dom(#4 HTMLDocument)   -> undefined
[18] Element.className.set  recv=dom(#3 HTMLDivElement) -> undefined
```

Every setter returns `undefined`, so **the value being written is invisible**.

For a differential oracle this is a hole in the middle of the mechanism: a
sandbox that sets `textContent = 'A'` where Chromium sets `'B'` produces a
**byte-identical trace**. The divergence is only detected later, and only if
something reads the value back — so it is silently missed on write-only paths,
and mis-attributed to the wrong call site when it is caught. Method arguments
(`setAttribute(name, value)`, `postMessage(data)`, `pushState(state, …)`) have
the same problem; only the interceptor records carry a key.

This is now the highest-value remaining work on the tracer — larger than the
worker crash, which is bounded to one non-target configuration. It needs:

1. The generator to pass `info` through to the scope in a way that lets the
   destructor walk `info[0..Length()-1]`. The scope already holds `info_`, so
   the C++ side is close to free; the cost is deciding per-callback how many
   arguments are meaningful.
2. A record format change: `kBindingCall` gains `varint argc` followed by
   `argc` values, and `sbxread.py` follows.
3. A size decision. Arguments are where the volume is; the existing 512-byte
   string cap and interning apply, but this is the change most likely to make
   traces large, so it should be measured on a real page before being enabled
   unconditionally.

## Tracer completed for the scramjet side

### Arguments are recorded (format v2)

`SbxBindingScope` walks `info[0..Length()-1]` in its destructor. **No generator
change was needed** — the scope already held `info_`; the work was overload-
selecting argument access, because `PropertyCallbackInfo` has no `Length()`
while `FunctionCallbackInfo` does, the same split the receiver accessor already
needed.

Verified end to end:

```
Element.setAttribute     recv=dom(#3 HTMLDivElement) (string(6)'data-x', string(5)'hello') -> undefined
Node.textContent.set     recv=dom(#3 HTMLDivElement) (string(13)'written-value') -> undefined
History.pushState        recv=dom(#6 History)  (object(#7), string(0)'', string(5)'#frag') -> undefined
EventTarget.addEventListener recv=dom(#3 …) (string(5)'click', function(#8), object(#9)) -> undefined
Node.appendChild         recv=dom(#10 …) (dom(#11 HTMLSpanElement)) -> dom(#11 HTMLSpanElement)
```

Capped at 8 args, with the true count recorded alongside so the differ can tell
truncation from a short call — the same pattern the 512-byte string cap uses.
Arguments are appended after the result so the rest of the record keeps its v1
layout.

### Interceptor writes carry their value

Fixing binding arguments alone would have left the identical blindness one layer
down: a named/indexed _setter_ interceptor recorded the key but not the value,
so `coll['x'] = 'A'` and `= 'B'` were the same trace. The generator now emits
value-carrying scopes wherever `v8_property_value` is in scope. It is a
flag-plus-value rather than an always-present field, because interceptor
**reads** are the highest-volume record kind and must not grow: measured 37
interceptor writes against 194 interceptor records in one run.

### Cost, measured

Same page, same runner: **94,244 -> 159,178 bytes** total (~69%). 2,872
arguments recorded across 4,523 binding calls in the busiest realm, i.e. ~0.6
args/call. Worth it — without arguments the oracle cannot see any value a page
writes.

### The determinism result that matters for the differ

Three identical runner runs of `async.html`:

| Scope                        | Result                                                        |
| ---------------------------- | ------------------------------------------------------------- |
| the page's realm             | **1105 bytes, 26 records, identical MD5 of the decoded dump** |
| total bytes across all files | 123,361 / 159,178 / 159,178 — varies ~30%                     |

The variation is entirely in `chrome://webui-toolbar` and
`chrome://omnibox-popup` traces, which live in a different process with their own
activity. **The differ must scope per realm**; comparing whole files would
produce constant false divergences. This is now the headline item in
`INTEGRATION.md`.

Note the first attempt to measure this used `--limit 400` and compared decoded
line counts, which were identical because the limit capped them — a measurement
that could not have failed. The byte comparison is what exposed the difference.

### Deliberately not changed, with reasons

- **Per-record flush stays.** The runner's double-delete crash produced a
  complete, correct trace precisely because of it. Restoring 4 KB batching would
  risk losing the tail exactly when something goes wrong, which is when the
  trace matters most. Revisit only with a measured cost on a real page.
- **Exception type stays unrecorded.** Getting the class means
  `GetConstructorName()` inside the `DisallowJavascriptExecutionScope`; if that
  re-enters JS it crashes the oracle. Needs testing, not assumption.
- **The debug mask (`--sbxdiff-debug-disable`) stays in.** It is what made the
  worker-crash bisect cheap — five hypotheses from one build — and it is inert
  unless the switch is passed.

## The file:// worker crash: resolved by configuration, and a lesson about controls

After seven bisect arms through the tracer, the answer was in a variable I never
varied.

| Driver                                                     | Tracing | Blocked `file://` worker | Result        |
| ---------------------------------------------------------- | ------- | ------------------------ | ------------- |
| `--dump-dom` + `--timeout` (headless command handler, CDP) | on      | yes                      | **crash 3/3** |
| `--sbxdiff-run` (in-binary runner, no CDP)                 | on      | yes                      | **clean 5/5** |
| `--sbxdiff-run`, `wb.html` (ctor + onerror)                | on      | yes                      | clean 3/3     |
| `--sbxdiff-run`, `wc.html` (ctor + postMessage)            | on      | yes                      | clean 3/3     |

The crash needs **tracing _and_ the CDP-driven headless command path**. Neither
alone does it — which is exactly why every tracer bisect came back negative:
the tracer is necessary but not sufficient, and the other necessary ingredient
was held constant in all seven experiments, including the "clean" control
(unwritable trace dir), which only ever varied the tracer.

**Practical consequence: this is fixed for the supported configuration.** The
runner is what `INTEGRATION.md` prescribes, and it is immune. `--dump-dom` with
tracing is now documented as unsupported.

### The lesson, which is the same one twice

Earlier in this session the virtual-time gate passed because it still ran with
`--virtual-time-budget`, so CDP silently covered a defect in the replacement
(RULES.md #18). This is the same shape: **the driver was the untested variable
both times.** A bisect that holds one input constant across every arm cannot
find a cause that lives in that input, no matter how many arms it has. When a
bisect returns negative on everything, the next move is not another arm — it is
to ask which input never moved.

The seven negative arms were not wasted: they are what makes the "tracing is
necessary" half of the conclusion solid. But they should have been interleaved
with varying the driver far sooner.

## `--disable-site-isolation-trials` removed: it broke a real site and bought nothing

Reported and bisected by the user on a clean-IP Linux box: rateyourmusic.com's
Cloudflare Turnstile challenge **does not auto-pass** with
`--disable-site-isolation-trials`, and does with it removed. The
`--disable-features=site-per-process,IsolateOrigins,IsolateSandboxedIframes,BackgroundResourceFetch`
set is fine.

It turns out the switch was never load-bearing. It was in the canonical set to
make the guest iframe share a renderer with the host — but that property comes
from the `--disable-features` set. Evidence from a traced run of the real site
with only those features disabled: the cross-origin Turnstile iframe appeared as
realm **`r159` in the same trace file as the page's `r1`**, i.e. same process.
So the switch cost a real site and provided nothing we were not already getting.

Removed from `FLAGS.md`, `INTEGRATION.md` and every test script.

### Two measurement errors of mine on the way here

1. **I judged the site by a `--dump-dom` at load time**, which captures
   Cloudflare's "Just a moment..." interstitial, and concluded every
   configuration was blocked — including the baseline the user had just said
   works. The challenge resolves itself; dumping at load is simply too early.
2. Even after fixing that, **my box cannot reproduce the comparison at all** —
   the challenge does not auto-pass here in either configuration (2073 records
   for the rym realm in both, and near-identical Turnstile counts: 9453 vs
   9398). Almost certainly IP reputation, possibly headless. So the user's
   bisect is the authority here, not mine.

Worth stating plainly: I went looking for a _detection_ mechanism (site
isolation as a bot signal) when the likely mechanism is functional — Turnstile
runs in a sandboxed cross-origin iframe and the switch changes how such frames
are hosted. I should not have theorised about detection before establishing
that my environment could even see the effect.

### The useful side-finding: cross-process tracing already works

Both configurations captured every realm, just distributed differently:

| Config                     | Files | Where Turnstile landed                        |
| -------------------------- | ----- | --------------------------------------------- |
| no isolation flags         | 8     | its own process (`trace.52758.*`)             |
| `--disable-features=…` set | 7     | same process as the page (`r159` beside `r1`) |

Either way the page realm, the blob realms and the challenge realm are all
present. **Coverage does not depend on collapsing processes** — the trace format
is one file per thread and realms are self-identifying, so the differ correlates
by realm URL across files. That is already what `INTEGRATION.md` tells the
harness to do, and it means the remaining isolation flags are a convenience for
the scramjet case rather than a requirement.

## CRITICAL: the keyed PRNG was killing renderers on multi-process sites

Found from a headed run of rateyourmusic.com. The user spotted that the
Cloudflare Turnstile iframe rendered as Chromium's **crashed-subframe**
placeholder, not a broken image. Browser stderr had the reason:

```
Terminating render process for bad Mojo message:
  Received bad user message: Invalid UUID passed to BlobRegistry::Register
```

Measured, headless, same page: **1 such kill with `--sbxdiff-run-key`, 0
without.** So it is ours.

### Cause

`stream_id` is a **per-process** counter starting at 16. Every renderer's main
thread therefore got stream 16 at draw 0 and generated the _same_ byte sequence
— including the same `base::Uuid::GenerateRandomV4()` values. Blob UUIDs are
registered in the **browser** process, which is shared, so the second renderer
to register a blob hit a duplicate UUID and was killed as if compromised.

This is the counter-contamination bug from P4 all over again, one level up: I
fixed collisions _within_ a thread's stream by giving web-crypto its own
counter, and never asked whether streams collided _across processes_. They did,
by construction.

Severity: it kills a renderer on any multi-process page. On rym it killed the
challenge iframe, so the page could never pass the challenge — the tracer was
actively preventing the thing we want to record.

### Fix

Mix the process identity into the ChaCha key:
`SHA256(run_key || 0 || --type || 0 || --renderer-client-id)`. The client id is
assigned in process-creation order, so it is reproducible across runs of the
same page — determinism is preserved while each process gets a distinct
keystream.

`//base` cannot include `//content`, so the two switch names are spelled out
with a comment rather than shared; they are stable Chromium switches.

### Why the earlier gates missed it

Every determinism gate ran a **single-renderer** page (`rand.html`, `async.html`,
a local 4-resource site). One renderer cannot collide with itself. The failure
needs two renderers generating blobs, which is ordinary on a real site and
absent from every synthetic test.

That is the same shape as RULES.md #18 and #19: the variable that mattered —
process count — was held at 1 across the whole suite. A real site found it in
one run.

### Verified: UUID fix on the real site, determinism intact

| Check                                                            | Before               | After                |
| ---------------------------------------------------------------- | -------------------- | -------------------- |
| `Invalid UUID` renderer kills on rateyourmusic.com, with run key | **1**                | **0**                |
| same, without run key                                            | 0                    | 0                    |
| P4 gate (same key ×5 → distinct results)                         | 1                    | 1                    |
| different key / no key                                           | differs / 3 distinct | differs / 3 distinct |

Draw values changed, as they must — the key material now includes the process
identity.

## Runner: quiet-period semantics, not first-load

Second bug from the same headed run. The runner latched on the first
`DidStopLoading`, which on a challenge-protected site is Cloudflare's
interstitial — so the run always ended before any post-pass navigation and the
trace could never contain the real page.

Now: each `DidStopLoading` restarts the grace timer, `DidStartNavigation` voids
the pending finish via a generation counter, and a hard cap at 10× grace stops a
never-quiet page hanging a batch.

Verified on a page that navigates itself after 1.2 s:

```
'FIRST-PAGE'
'SECOND-PAGE-AFTER-NAV'
  r1   7 records   http://127.0.0.1:8932/first.html
  r6   3 records   http://127.0.0.1:8932/second.html
```

Both realms present. Before the fix the second page was unreachable.

**These two bugs masked each other.** With the latch in place, fixing the crash
would have shown nothing; with the crash in place, fixing the latch would have
shown nothing. Either alone would have read as "the challenge still doesn't
pass".

## rateyourmusic still does not pass from this machine

With both fixes, headed and headless, 0 kills, challenge does ~29k records of
work and then goes quiet without passing; the only title ever set is
`'Just a moment...'`.

The user's Linux box passes the same site with the equivalent flags, so this is
environmental — almost certainly IP reputation. **I cannot demonstrate a
recorded pass here**, and should not claim the tracer is proven end-to-end on a
passing challenge. What is established:

- the two bugs that were _provably_ breaking it are fixed and verified on the
  real site;
- the tracer handles rym's real workload (20,073-record blob realm, 9,313-record
  challenge script, correct per-realm split across 6+ files);
- the runner now survives a self-navigation, which a passing challenge requires.

Next step belongs on a machine where the challenge passes: run with
`--sbxdiff-run=8000` and check whether a title other than `'Just a moment...'`
appears in the trace.

## The relay bug, fifth instance — and it invalidated a whole investigation

`DebugDisableMask()` read `--sbxdiff-debug-disable` through a **raw string
literal** and was never added to `kSbxdiffRendererSwitches`. The switch
therefore never reached the renderer, so **every `mask=N` run was actually full
tracing**.

That is why masks 1, 4, 8, 16 and 31 all produced the same number. I read that
as "none of the gated work is the cost", went looking for a cause outside the
gated paths, landed on `WTF::ThreadSpecific`, and added a TLS cache for it. The
cache is harmless but was not the fix; the hypothesis was built on void data.

It also **invalidates the worker-crash bisect** recorded earlier in this file:
all seven "mask" arms were full tracing repeated seven times, so they eliminated
nothing. The conclusion there (CDP driver vs in-binary runner) still stands,
because it came from a different experiment — but the mask table in that section
should be read as void.

This is the worst instance of the five because it happened **in the switch I
added after building `kSbxdiffRendererSwitches` specifically to make this
impossible**, and then bypassed the mechanism by hand-writing the literal. A
single-definition list only works if every new switch actually goes through it.

## Corrected performance attribution (with a working mask)

| Config                                                     | DOM (20k setAttribute/getAttribute) |
| ---------------------------------------------------------- | ----------------------------------- |
| stock Chromium                                             | 4.8 ms                              |
| ours, tracing off                                          | 4.8 ms                              |
| ours, tracer **enabled**, all recording disabled (mask=31) | **4.9 ms**                          |
| ours, object-ids disabled (mask=4)                         | 13.4 ms                             |
| ours, full tracing                                         | 19.7 ms                             |

Two things follow.

**The tracer's presence is free.** Enabled-but-idle is indistinguishable from
off (4.9 vs 4.8). Every earlier claim that the scopes, `SbxTracer::Get()` or
`ThreadSpecific` cost anything was an artefact of the broken mask.

**`ObjectIdFor` is ~42% of the recording cost** (19.7 → 13.4 when disabled),
which is the V8 private-property get+set it performs on every object-valued
receiver, result and argument.

## rateyourmusic: it is the recording, not the overhead

Measured on the real site, headed, manual click:

| Config                                   | Result     |
| ---------------------------------------- | ---------- |
| tracing off                              | **passes** |
| tracing on, recording disabled (mask=31) | **passes** |
| tracing on, full                         | loops      |

So the challenge is not reacting to the tracer existing, to the trace file, or
to the switch — only to the work done per record.

And it is probably **not** a timing signal: rym's challenge produces ~41k
records, which at the measured rate is ~14 ms of overhead spread across several
seconds of challenge work. Far too little for a wall-clock check.

The leading hypothesis is therefore _structural_, not temporal:
`ObjectIdFor` is the only part of the tracer that **mutates page objects**. It
calls `SetPrivate` on them, which is invisible to reflection (`Object.keys`,
proxies, cross-origin checks — all verified early on) but still forces a
**hidden-class transition** and can turn monomorphic inline caches megamorphic
for code touching those objects. That is observable from JS by timing operations
on your _own_ objects, without ever seeing the property. A proof-of-work loop
hammering a small object set is exactly the shape that would notice.

"Invisible to reflection" was verified and true; "has no observable effect" does
not follow from it, and I treated the two as equivalent.

## ROOT CAUSE of the Turnstile loop: the tracer was mutating page objects

Isolated by three manual clicks on the real site:

| Config                                       | rym      |
| -------------------------------------------- | -------- |
| tracing off                                  | pass     |
| tracing on, recording disabled (mask=31)     | pass     |
| tracing on, **object-ids disabled** (mask=4) | **pass** |
| full tracing                                 | loop     |

`ObjectIdFor` stashed each object's id in a `v8::Private` property **on the
object itself**. Early in the project that was verified as undetectable:
invisible to `Object.keys`, `getOwnPropertySymbols`, proxy traps and
cross-origin access checks. All true — and beside the point.

Adding a property forces a **hidden-class transition**. That can turn a
monomorphic inline cache megamorphic for any code touching the object, which a
page detects by timing operations on its _own_ objects, never seeing the
property. Turnstile's proof-of-work hammers a small object set in tight loops:
exactly the shape that notices.

The overhead numbers rule out a plain timing check: ~41k records on rym is ~14ms
across seconds of work. The signal was **structural**, not temporal — which is
why so much effort went into the wrong place (flush batching, TLS caching,
DCHECKs; only the DCHECK work was independently justified).

**"Invisible to reflection" is not "no observable effect."** I verified the
first rigorously and then treated it as the second.

### Fix: identity without mutation

A DOM wrapper already carries a stable identity — the `ScriptWrappable` behind
it. `ObjectIdFor` now reads that via `ToAnyScriptWrappable` and keys a side
table on the address. No writes to page objects, and it removes the ~42% of
recording cost the private-property get/set represented.

Costs, both deliberate and documented in the code:

- non-wrapper objects (plain JS objects, functions, proxies) get **no** stable
  id and record as `0` — visible rather than silently aliased;
- an Oilpan address freed and reused could alias two objects.

Verified: rym passes with **full tracing**, and object identity still works
(`dom(#3 HTMLDivElement)` stable across records, arguments intact).

## Automated challenge solving

`--sbxdiff-click` injects a trusted click via
`RenderWidgetHost::ForwardMouseEvent` — the path OS input takes, so
`isTrusted` is true with no DevTools session. Verified locally:
`PD trusted=true x=280 y=330 | HIT trusted=true`.

It did not work on rym until two things were added:

- **`--sbxdiff-click-frame`.** `ForwardMouseEvent` is not hit-tested into child
  frames, and `RenderWidgetHostInputEventRouter` is not exposed in
  content/public, so a root-widget click never reached the Turnstile iframe.
  Targeting the child frame's own widget does.
- **repeats**, because the widget is not interactive when the page stops
  loading.

Result: rateyourmusic.com passes fully automatically, **2/2 runs**, 8927 and
8913 records in the page realm with 116 network requests.

The small difference between runs is the real page being genuinely
nondeterministic — which is what P5 network replay exists to remove before
diffing.

### Two detection-method corrections

- `document.title` is useless as a pass signal: the real page's title comes from
  parsed markup, not a binding call. `IntersectionObserver.observe` and rym's
  CDN hosts are the reliable tells.
- The macOS screenshot tool cannot be used here ("could not create image from
  display" — Screen Recording permission, ungrantable over SSH). Capture is now
  in-browser via `CopyFromSurface`, and capture pixels are viewport pixels 1:1,
  verified against a known-position element.

## P5: network record and replay, with the server down

The oracle is worthless without this. Two runs of a live site diverge on content
neither side controls, and every one of those shows up as a false positive.

**Record → kill the server → replay** now works end to end: navigation,
subresources and `fetch()` all served from disk, with `curl` confirming the
origin returned `000`.

### The bug that made recording look fine while it was not

`MaybeCreateSbxdiffNetObserver()` was **never called**. It existed, it compiled,
it was correct — and nothing invoked it. Recording silently fell back to an
older buffer path that caught some subresources but missed `fetch`/XHR and the
navigation body itself.

This is the failure mode worth remembering: the fallback _worked_, so the store
filled up and every spot-check passed. Only counting what was in the store
against what the page actually requested exposed it. Wiring it into
`LocalFrame::Init()` fixed it; recording is now complete.

### Record and replay are in different processes, necessarily

- **Record is renderer-side**, on the `probe::DidReceiveResourceResponse` /
  `DidReceiveData` / `DidFinishLoading` hooks — DevTools' own network taps, which
  is why they see decoded bodies uniformly across navigation, subresources, XHR
  and `fetch`.
- **Replay is browser-side**, a `network::mojom::URLLoaderFactory` appended at
  `ChromeContentBrowserClient::WillCreateURLLoaderFactory`. There is no choice
  here: by the time a request is visible to the renderer, it has already gone
  out.

So the store moved to `base/sbxdiff_net_store.*` (`namespace base::sbxdiff`),
where both processes can share one definition. The blink copy and the superseded
`CreateResourceForSbxdiffReplay` path in `ResourceFetcher` are gone.

### A miss is a divergence, not a cache miss

Unrecorded URL → `net::ERR_BLOCKED_BY_CLIENT`, never the network. A fallback to
the network would make a real divergence look like a clean run, which is exactly
the bug class this tool exists to find. The decoder reports the blocked count so
it cannot be missed.

### The tamper test is the one that counts

The first version of this passed a "server is down and the page still loaded"
test while silently bypassing to HTTP cache. Loading successfully proves
nothing about _where the bytes came from_.

So: edit a stored body on disk, replay, and check the page sees the edit.
Rewriting `data.json` to `{"TAMPERED-LONGER-BODY":123456}` and replaying with
the server down produced `got:31` in the trace — 31 being that string's length.
The bytes come from the store.

(My own script labelled the expected value `got:30`. The label was a miscount,
not a failure; the code was right.)

### Gates, re-run on the final binary

| Gate                                    | Result                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------- |
| P4 randomness, same key ×5              | 1 distinct draw set; different key differs; no key → 3/3 distinct         |
| page-realm determinism, 3 replayed runs | byte-identical (16 records, same MD5)                                     |
| network replay + tamper                 | passes                                                                    |
| rateyourmusic automated pass            | 8927 records, 194 `IntersectionObserver.observe`, 116 requests, 0 blocked |

The rym figure is identical to the pre-P5 passing run, which is the useful part:
adding browser-side interception did not make the browser detectable again.

## The scramjet side: harness, differ, and three caught regressions

One page, two worlds, diffed. `pnpm runway sbxdiff`.

### The finding that shaped the design

The first working run reported **eight T0 leaks** — `Location.href.get`,
`Document.URL.get`, `HTMLImageElement.src.get` and friends all handing back
`http://localhost:4500/~/sj/…`. Every one was false.

In the sandbox the shim and the guest share one realm and one binding stream.
The native is _correctly_ reporting a page that really is served from a proxied
URL; scramjet's trap hands the guest the rewritten answer above it. A
binding-layer value is simply not a guest-observable value, and treating it as
one turns the differ into a false-positive generator on its first run.

So the probe pages funnel each observed fact through a sink — `document.title =
"<key>=<value>"` — and those are compared by key. Whatever reaches the sink is
by construction what the guest computed. The same run then gives **one** T0, and
it is real: error stacks leak the proxy URL. runway's adversarial suite asserts
exactly that independently (`platform-apis.ts:295`).

Binding-layer divergences are still reported, at T2, as context. Promoting them
needs guest-op brackets (plan P6).

### Virtual time had to come off

`--sbxdiff-initial-time` breaks scramjet outright: with it on, the harness never
navigates the testframe and no guest realm is created at all. Measured at budget
4000, budget 30000, and no budget — not a budget-size problem. Virtual time
breaks service-worker startup, which the sandbox needs and the bare harness does
not.

Both sides now run on the real clock, which keeps them **symmetric**. That
matters more than pinning the clock here: virtual-time-vs-real-time would
diverge on every timing-derived value. Randomness is still pinned by run key.

### The baseline is stable, which is what makes the test mean anything

```
run1:  1191 divergence(s), 1 bucket(s) not in the baseline, 1 T0 leak(s).
run2:  1191 divergence(s), 1 bucket(s) not in the baseline, 1 T0 leak(s).
```

Identical. The one bucket is the stack leak; T0 is never baselined.

### Three regressions, none of them announced to the differ

| Regression                                                      | Caught               |
| --------------------------------------------------------------- | -------------------- |
| R1 `element.ts` stops un-rewriting `href`/`src` components      | 3 T0, 4 new buckets  |
| R2 fake `Location` returns the real one                         | 6 T0, 12 new buckets |
| R3 `location.port` returns `"9999"` — **no leak marker at all** | 1 new T1 bucket      |

R3 is the one that proves it compares rather than greps: `9999` contains no
prefix, no origin, no shim identifier.

R1 caught `link.host` and `link.pathname` but not `link.href`, because `href`
goes through a separate path the edit did not touch (`element.ts:147`, "note
that href is not here"). The differ named the affected properties exactly rather
than smearing across the interface.

A clean rebuild returned to `1191 / 1 bucket`.

### Two bugs found along the way

- **The decoder spec was wrong, in three places at once.** A `kInterceptor`
  record with `key_kind == 2` writes **no** `has_value` byte — it ends after the
  receiver. `sbxread.py` implements this correctly but its docstring did not say
  so, `ARCHITECTURE.md` inherited the ambiguity, and the new TS decoder
  implemented the docstring. It desynchronised on the one trace of eighteen that
  contained such a record. Fixed in all three, and the TS decoder is now
  cross-checked against the Python one over 441k records.
- **`feat/idl-interceptors` did not build.** Commit `64980a08 "nuke
wrapPostMessage"` removed the feature but left four references behind, two of
  which break the Rust build (`wasm/src/lib.rs:55`,
  `native/src/rewriter.rs:79`). Completing the removal was the minimal fix; the
  TS config key `wrappostmessagefn` is still declared and unused, left alone as
  out of scope.

## Attribution, a store-backed transport, and virtual time

Three pieces, two of which work.

### Script attribution: the binding layer can now produce a verdict

Every compared record carries the V8 script id on top of the stack plus the
script that entered the task, and `kScript` maps ids to URLs (format version 3).
`v8::StackTrace::CurrentScriptId` is the primitive: allocation-free, cannot run
JS, and — unlike the multi-frame spellings — neither deprecated
(`CurrentScriptIdsAndContexts` is `V8_DEPRECATE_SOON`, fatal under `-Werror`)
nor experimental (`CurrentScriptData`).

Measured on the probe page:

|                | oracle    | sandbox |
| -------------- | --------- | ------- |
| guest-direct   | 86 (100%) | 60      |
| shim           | 0         | 1641    |
| unattributable | 0         | 9       |

**T2 went from 259 buckets to 31, and the baseline from 263 to 35.** A 263-entry
suppression list is not reviewable; a 35-entry one is.

Three bugs found on the way, two of them mine and none of which a test would
have caught:

- **Task-scoped state was not reset where the task id changes.** The entry
  script was cleared in `EnsureTaskOpen` but not in the two V8 callbacks that
  also assign `current_task_id_`. Found by grepping every assignment, not by
  testing — the wrong attribution would have read as entirely plausible.
- **Script ids collided on merge.** They are per-isolate and every trace file
  numbers from 1, so "first mapping wins" attributed the page's script 4 to the
  browser UI's script 4. Every guest record in the sandbox appeared to have been
  entered by `chrome://resources/lit/v3_0/lit.rollup.js`.
- **`entry_script` does not mean what it was designed to mean.** scramjet's
  controller enters essentially every task, so entry is shim even for guest
  code; requiring `entry == guest` classified **zero** sandbox records as guest.
  The top frame alone is the right criterion, and for a good reason: had the
  shim trapped that API, its trap would be the frame calling the native.

### A store-backed scramjet transport

`SbxdiffTransport` serves every upstream request from the oracle's recorded
store. It has to be a transport, not the Chromium-side `--sbxdiff-net-replay`:
scramjet's egress is WebSocket frames to a wisp server, which never reaches a
URLLoaderFactory. Measured earlier: a scramjet rym run recorded 15 requests, all
to the harness origin, where the direct run recorded 116 across the real CDNs.

It also keys on the _real_ upstream URL, since the transport is called before
scramjet proxies it — so no `--sbxdiff-url-normalize` is needed after all.

41 responses, 0 misses on the probe page.

### Virtual time: diagnosed, partly fixed, still not usable

The earlier diagnosis ("breaks service-worker startup") was wrong. Watching it
fail showed the harness _does_ initialise and _does_ navigate; the worker starts.
What never happens is the network request for the proxied page.

The cause is the policy: `kDeterministicLoading` pauses virtual time while a
load is outstanding, and that load is served by a worker whose transport needs
timers. Load waits on timer, timer waits on clock.

| policy          | budget | guest realm | guest script   |
| --------------- | ------ | ----------- | -------------- |
| `deterministic` | 30000  | none        | no             |
| `advance`       | 3000   | none        | no             |
| `advance`       | 30000  | created     | no — 2 records |
| `advance`       | 100000 | created     | no — 2 records |

`advance` with a large budget creates the guest realm, which was impossible
before. Two hypotheses were tested and **disproved**: the store transport does
not rescue `deterministic`, and `advance` does not just need a bigger budget
(2 records at both 30000 and 100000). What actually happens is service-worker
thrashing — 8 of 10 sandbox trace files are separate `sw.js` realms, because
virtual time races ahead while the run waits on real I/O and the worker's idle
timeout fires repeatedly.

The real fix is coordinated virtual time across the page and the worker, which
`VirtualTimeController` (per-page-scheduler) does not currently support. Both
sides stay on the real clock until then — symmetric, which matters more than
pinned.

### Regressions still caught

Re-ran the suite with attribution on; identical to before, and the clean rebuild
returns to the floor:

|                           | divergences | new buckets | T0  |
| ------------------------- | ----------- | ----------- | --- |
| clean                     | 1191        | 1           | 1   |
| R1 url-reflection         | 1195        | 4           | 3   |
| R2 location-getter        | 1197        | 12          | 6   |
| R3 port-value (no marker) | 1192        | 2           | 1   |

## Virtual time: deferral lands, the sandbox still is not deterministic

Two of my earlier diagnoses were wrong, and the third one is right but not
sufficient. Recording all three because each was disproved by a different kind
of evidence.

- _"Virtual time breaks service-worker startup."_ Disproved by console logging:
  the harness initialises, navigates, and the worker starts. What never happens
  is the network request for the proxied page.
- _"The store-backed transport will fix it by removing the WebSocket."_
  Disproved by measurement: `deterministic` still produces no guest realm with
  the transport in place.

A controlled comparison — same page, same binary, only the clock flags differing:

|                 | SW activations | guest realm records |
| --------------- | -------------- | ------------------- |
| no virtual time | 1              | 1746                |
| `advance`       | 3              | 2                   |
| `deterministic` | 0              | 0                   |

The problem is virtual time being on during the sandbox's **own bootstrap**.
`--sbxdiff-virtual-time-after=<url-substr>` defers the enable to the realm being
compared, so bootstrap runs on the real clock. That took the sandbox guest realm
from **2 records to 9569**.

It also required the harness URLs to stop embedding the target. The flag matches
a URL substring, and `?sbxdiffStore=<encoded endpoint>#<encoded target>` made the
harness page itself match — turning virtual time on during bootstrap, which is
the exact bug the flag exists to prevent. Target is base64 in the hash now,
store addressed by port.

### The clock probe, which is what stopped this being reported as fixed

`pages/clock.html` writes `Date.now()` through the sink. Without it, "virtual
time silently never enabled" and "virtual time working" are indistinguishable —
both give a clean run, and the first run after the deferral looked like a pass.

```
oracle   date.now=1700000000009  date.iso=2023-11-14T22:13:20  timer.delta=250
sandbox  date.now=1700000103836  (2 of 3 runs produced nothing at all)
```

Oracle exact, every run. Sandbox flaky, and when it does run the clock has
drifted ~100 s by the time guest script executes, differently each time.
`timer.delta=250` is exact on both, so relative time is deterministic and
absolute time is not.

This is structural: under `advance` the clock races while waiting on real I/O,
so absolute virtual time is a function of real timing; under `deterministic` it
pauses for a load serviced by a worker that needs the clock to move. A sandbox
whose page load goes through a service worker fits neither policy. The real fix
is coordinated virtual time across page and worker, and the deferral is a
prerequisite for it either way.

`--virtual-time` stays off by default. The default path is stable: 3 of 3 runs
at 1191 divergences / 1 bucket / 1 T0, and the regression suite is unchanged
(R1 4/3, R2 12/6, R3 2/1, clean 1/1).

### rateyourmusic is now wired, not yet run

`--url`, `--headed`, `--click`/`--click-frame`, `--store-out` to record once and
`--store` to replay into both sides, plus `src/sbxdiff/rym.sh`. The sandbox
reaches the site only through `SbxdiffTransport`, so Cloudflare is never
contacted and the 403 stops being a blocker. Not yet executed end to end.

## Coordinated virtual time across page and worker

Implemented, verified invoked, and it is still not enough for a deterministic
sandbox clock. All three of those are worth recording.

### The mechanism already existed

`ProcessTimeOverrideCoordinator` installs `base::subtle::ScopedTimeClockOverrides`,
which is **process-wide**. So when the page enables virtual time the service
worker's clock is frozen with it — but the worker is not a registered _client_,
so it cannot request advancement. Page pauses time waiting for a load → worker's
timers never fire → worker cannot produce the response → page waits forever.

The coordinator is documented for exactly this case ("thread scheduler for
different workers and the main thread"), advances only to the **minimum
requested across clients**, and `WorkerThreadScheduler` already overrides the
virtual-time hooks. Nothing ever called `EnableVirtualTime` on it.

### Landed

- `WorkerThreadScheduler::MaybeJoinSbxdiffVirtualTime`, lazy and one-way from
  `OnTaskCompleted`. Not at startup: the coordinator's first client fixes the
  clock origin, and a worker registering during bootstrap is what broke
  service-worker registration originally. **Verified invoked** — the log fires
  for 2 worker threads per run, which is the difference between "implemented"
  and "implemented and reached".
- The worker never fences itself. `kAdvance` sets an empty fence on purpose;
  granting the worker a budget puts one back, and an exhausted worker stops
  requesting advancement, which — minimum across clients — pins the page too.
  I wrote a comment saying exactly this and then granted a budget anyway;
  reading `ApplyVirtualTimePolicy` caught it.
- The switch helpers moved to
  `platform/scheduler/common/sbxdiff_virtual_time.{h,cc}`. They were in the
  tracer by accident, and `platform/scheduler/DEPS` forbids including a bindings
  header — the right fix was to move them, not to add a DEPS exception.
- The store is preloaded into the transport before the page under test loads, so
  the guest-load path has no real I/O to race against.

### Measured

|                                      | before    | after             |
| ------------------------------------ | --------- | ----------------- |
| runs producing any guest observation | 1 of 3    | **4 of 4**        |
| sandbox `Date.now()` drift           | ~90–110 s | ~60.8 s or ~103 s |
| `timer.delta`                        | exact     | exact             |
| oracle `Date.now()`                  | exact     | exact             |

Flakiness gone; determinism not achieved. The four drifts — 60823, 103840,
102903, 60868 — are **bimodal**, which is the useful clue: a small number of
discrete fast-forwards, not accumulated noise. Under `kAdvance` the clock jumps
to the next delayed task whenever the run is idle, so whether a long timer gets
jumped depends on real scheduling.

`kDeterministicLoading` would fix it — it honours the `WebScopedVirtualTimePauser`s
resource loads create — but still deadlocks, now with the guest realm created
and the run hitting the runner's 30 s cap. Next lead: whether enabling virtual
time at document creation inherits pausers from loads already in flight, which
would freeze the clock immediately and permanently.

`--virtual-time` stays off by default. Default path stable at 1191 / 1 bucket /
1 T0 across 3 runs; regression suite unchanged (R1 4/3, R2 12/6, R3 2/1).

## Fixing `kDeterministicLoading`: two real bugs, one remaining

`kDeterministicLoading` is the policy worth fixing — on the same binary
`kAdvance` gives 54/60/54/80 s of clock drift and even slips `timer.delta` to
249, while `deterministic` gives exact deltas. It deadlocked, and finding out
why took four wrong theories.

### Bug 1: an idle client pinned the shared clock

`ProcessTimeOverrideCoordinator::RegisterOverride` seeds a client at the current
tick, and `MaybeFastForwardToWakeUp` returns early when a thread has no pending
wakeup — so a client that is _never_ ready still constrains the minimum. An idle
service worker froze the clock for every thread. Clients now release their
constraint when idle. Latent upstream too: it only bites with more than one
participating thread, which is exactly what joining the worker introduced.

Fixing it alone changed nothing, which is worth recording — it was necessary,
not sufficient.

### Bug 2: inherited pausers, and the reading error that hid them

Deferred enablement turns the clock on at a realm reached mid-load, so pausers
are already outstanding. Counting them stops virtual time instantly, and it can
never restart, because pausing **fences the very task queues those loads
complete on**.

```
110516.788601  EnableVirtualTime, inherited pause_count=1
110516.788632  virtual time STOPPED at +0ms
   ... 30 seconds ...
110546.748156  virtual time RUNNING at +10ms      <- only at teardown
```

This was my _first_ hypothesis, and I wrongly discarded it: I saw `pause_count`
reach 0 and concluded pausers were not holding the clock — but that 0 arrived
_after_ the hang, at teardown. Reading an end-state as a steady state. The same
error made me read "RUNNING at +10ms" as a frozen clock when it was just the
value at the last transition; the coordinator log later showed time reaching
+39967 ms. **Ordering, not values, is what diagnoses a hang.**

`EnableVirtualTime` now records a baseline and compares `pause_count > baseline`.
No-op wherever virtual time is enabled at startup, so stock CDP is untouched.

### Result

Clock probe (no subresources), `--vt-policy deterministic`:

|                      | before                    | after                |
| -------------------- | ------------------------- | -------------------- |
| run time             | 30 s hang, no output      | **3.6 s, every run** |
| sandbox `Date.now()` | ~60–100 **seconds** drift | 957 / 953 / 953 ms   |
| `timer.delta`        | —                         | **exactly 250**      |

### Still broken, with the mechanism known

A page _with_ subresources still deadlocks (`probe.html` hangs the full 30 s cap;
`clock.html` does not). The pauser log names the holder: a proxied subresource,
released only at teardown. That load is served by scramjet's service worker,
whose fetch handler delegates back to the client _page_, and pausing fences the
page. A normal page never hits this — its loads complete in the network process
with no page involvement, which is why `LoadingTaskQueueTraits` leaves
`CanRunWhenVirtualTimePaused` at the default `true`.

Chromium has fixed this shape before: `kFileReading` carries "should run with VT
paused to prevent deadlocks when reading network requests as Blobs"
(crbug.com/1455267). Making `kServiceWorkerClientMessage` and `kPostedMessage`
pause-safe was the obvious next step and **did not work**, so it was reverted
rather than shipped unverified.

Next diagnostic: give each `WebScopedVirtualTimePauser` a unique id in the log.
The current one matches by name; names repeat (`ResponseBody`, `PendingScript`),
so a still-held pauser gets masked by a later balanced pair, and "which pauser is
stuck" cannot be answered reliably without it.

### Unchanged

Default path stable at 1191 divergences / 1 bucket / 1 T0 across 3 runs, and the
regression suite is identical: R1 4/3, R2 12/6, R3 2/1, clean 1/1.

## Virtual time works

`Date.now()` in the sandbox is now reproducible to **~1 ms** (1700000000019 in
four of five runs, ...020 in the fifth) with timer deltas exact, down from
60–110 _seconds_ of drift. It is on by default, and the diff result is identical
with or without it (1191 / 1 bucket / 1 T0), so the baseline covers both.

The third and final bug was the interesting one.

### Fencing assumes a load can finish without the page

`OnVirtualTimePaused` fences the frame's task queues. That is safe when loads
complete in the network process — the normal case, and why stock virtual time
works at all. It is not safe for a sandbox: the load is served by a service
worker that delegates back to the client _page_, so fencing the page stops the
very work that would release the pause.

With a deferred clock, pausing now stops the **clock** and leaves the **queues**
alone. Determinism still comes from the frozen clock, and tasks running while it
is frozen is already normal for every queue whose `CanRunWhenVirtualTimePaused`
is true — loading queues included.

### Unique ids are what found it

A pauser carries a `trace_id_` that survives moves. Logging it alongside the name
turns "the run hangs" into a name and a timestamp:

```
longest gap: 69.946s
pausers HELD across the gap:
  id=6089691360  http://localhost:4500/~/sj/…   <- proxied subresource
```

Matching by _name_ had been actively misleading: names repeat (`ResponseBody`,
`PendingScript`), so a still-held pauser gets masked by a later balanced pair,
and one run looked like "all pausers balance" when the clock was plainly stuck.
That wrong reading cost two builds.

### Six dead ends

Each cost a build, and each was killed by a different kind of evidence.

| Hypothesis                                                          | Disproved by                                               |
| ------------------------------------------------------------------- | ---------------------------------------------------------- |
| "breaks service-worker startup"                                     | console logging — the worker starts, the harness navigates |
| "the store transport fixes it by removing the WebSocket"            | `deterministic` still yields no guest realm                |
| "`advance` just needs a bigger budget"                              | 2 records at budget 30000 _and_ 100000                     |
| "`CachedStorageArea` is the stuck pauser"                           | re-running showed no such event — run-specific noise       |
| "my harness's `sessionStorage.setItem`"                             | removing it changed nothing                                |
| "`kServiceWorkerClientMessage`/`kPostedMessage` must be pause-safe" | no effect; reverted rather than shipped unverified         |

### Gates on the final binary

| Gate                              | Result                                                          |
| --------------------------------- | --------------------------------------------------------------- |
| default path (virtual time on) ×3 | 1191 / 1 bucket / 1 T0, identical                               |
| clock probe ×5                    | `Date.now()` 019,020,019,019,019; `timer.delta` 250 exact       |
| P4 randomness ×5                  | 1 distinct draw set; different key differs; no key 3/3 distinct |
| regression suite                  | R1 4/3, R2 12/6, R3 2/1, clean 1/1                              |

## Reading the probe's divergences: 1 real bug, 3 harness artifacts

Worth doing, because three of the four "findings" were the harness's fault and
the counts alone never said so.

**The real one.** `guest:stack` — a caught error's stack hands the guest the
proxy URL (and the line number shifts 68 → 69). scramjet already knows this:
`platform-error-stack-urls` is in `failing_tests.json` and
`tests/adversarial/platform-apis.ts:295` asserts against it. The oracle found it
independently, from a probe page that never mentions stacks as something to
check — which is the whole argument for a differ over a test suite.

**The three that were not.** `top_is_self`, `parent_is_self` and
`document.referrer` all came from comparing a **framed** oracle against a sandbox
that presents the guest as **top-level**. scramjet is right in every case: a real
visitor sees `top === self`, and returning the harness URL as the referrer would
be a chrome-origin leak, so `""` is the safer answer.

The oracle now loads the target top-level by default (`--framed-oracle` restores
the old behaviour). All three vanished. The floor is now:

```
1294 divergence(s), 1 bucket not in the baseline, 1 T0 leak
```

One finding, and it is real. The cost is T2 rising from 31 buckets to 159 — an
unframed oracle and a framed-but-lying sandbox make genuinely different native
calls around `top`/`parent`. T2 decides nothing and is baselined, so trading it
for three false verdicts is clearly right.

Regressions still caught, now with sharper output: R1 3 T0 (`link.host`,
`link.pathname`, plus the known stack leak), R2 6 T0 (`location.href`,
`.origin`, `.host`, `.pathname`, `url.abs`) + 1 T1, R3 1 new T1
(`location.port`), clean 1/1.

## rateyourmusic: the store records the whole journey; the challenge still does not pass

Four real fixes, one unsolved problem, and two corrections I had to make to my
own reasoning.

### Fixes

- **URL + ordinal store keys.** rym serves a challenge and then the real page at
  the _same_ URL; a URL-only key kept whichever was written last, so replay
  skipped the challenge. Now `×2 https://rateyourmusic.com/` — challenge at
  ordinal 0 (6 KB), real page at ordinal 1 (402 KB).
- **The store records its capture time** (`sbxdiff-time-base.json`) and replay
  adopts it. A challenge checks its tokens against the device clock, so a
  replay pinned to an unrelated constant rejects its own challenge.
- **Replay misses are logged.** They were invisible: not logged, and not in the
  `blocked` counters, which cover subresources but not navigations.
- **`--vt-fence`.** My earlier blanket "stop the clock but don't fence the
  queues" was right for the sandbox and wrong everywhere else. With fencing
  restored the challenge behaves: widget iframe loads, misses drop 51 → 12, the
  `pat`/`ci` endpoint mismatch disappears, retries drop **109 → 2**.

### Two corrections

I claimed a challenge-response protocol is **inherently unreplayable**. Wrong,
and on weak evidence: I concluded it from a `--no-virtual-time` run, which
mismatches the clock by construction. POSTs _are_ recorded (the `fo/` endpoints
have 3 and 2 ordinals), and the challenge's inputs are pinned — one recorded URL
is `…/jsd/oneshot/…/0.5234181967547786:1789…`, a `Math.random()` value and a
timestamp, both of which we pin. It should reproduce.

I also justified stripping `__cf_chl_rt_tk` as "the token did not exist when the
store was written". Also wrong — it is server-minted, so a faithful replay
regenerates it identically. The real reason it is absent is that the recorder
captures only _final_ responses, so the token URL's redirect was never stored.
Stripping still yields the right sequence, but for a different reason than I gave.

### Where it stops

The challenge runs, the widget loads, and it retries twice instead of 109 times
— but both `rateyourmusic.com` realms set `document.title` to `"Just a moment…"`
and fetch zero CDN assets. It is the interstitial both times.

Three misses remain. The instructive one: `brunhild.challenges.cloudflare.com/…/h/g/i/…`
**is requested during recording** (it appears as a `NET GET`) but is not in the
store — issued, response never reaching the recorder, almost certainly
fire-and-forget telemetry cut off at teardown. `--soft-miss` serves an empty 200
rather than blocking; it still does not pass.

The endpoint set also varies between recordings (`…/h/g/pat/…` missed against one
store and not another), so the challenge's request sequence is not fully
determined by the inputs we pin.

### Unaffected

Probe pipeline 1294 / 1 bucket / 1 T0 across 3 runs; regression suite unchanged
(R1 4/3, R2 12/6, R3 2/1, clean 1/1).

## Phase 13 — the challenge passes

The user watched a screen recording of a real visit and spotted what the store
could not express: _"it **starts** with a redirect to the token url then it goes
to challenge then it goes to token url AGAIN and redirects."_ Frames extracted at
10 fps confirm it — `rateyourmusic.com` → `?__cf_chl_rt_tk=<T>` for ~100 ms →
bare URL for 2.4 s (the challenge) → `?__cf_chl_tk=<same T>` for ~500 ms → bare
URL (the real page).

That ruled out the previous theory and pointed at the store format. Three
defects came out of it, each alone enough to stop the challenge passing, and
none of which presented as an error.

### 1. Headers are content

The store held `url \n mime \n encoding \n body`, and replay served everything
under a synthetic `200 OK`. Cloudflare answers the first navigation with
`Critical-CH`, so Chromium **restarts the navigation** — the recording holds two
different challenge instances at `/` (rays `…8eb896…` and `…8ed89a…`) and only
the second one's `orchestrate`/`fo` endpoints were ever fetched.

This is visible in the clean store from the previous phase and I read it as
duplicate recording: two 403 bodies 15 ms apart with different tokens. Grepping
the ray out of each settled it — the `orchestrate` request carries the second
ray, so the first instance was the abandoned one. A replay that cannot restart
hands the page that abandoned challenge and every endpoint it asks for misses.

Store format v2 carries `net::HttpResponseHeaders::raw_headers()` verbatim,
length-prefixed because it is NUL-separated:

```
"SBXD2\n" url "\n" mime "\n" encoding "\n" <header_bytes> "\n" <raw_headers> <body>
```

`head->parsed_headers` is populated with `network::PopulateParsedHeaders` —
the restart is driven off that, not off the raw headers.

### 2. Redirects were followed silently

`OnReceiveRedirect` re-keyed and followed, so only the final body of a chain was
stored. That loses the URL the page ends up at, and the URL is content: the
challenge script reads its token out of `location`. 3xx responses are records of
their own now, and `ReplayLoader` is stateful — a stored 3xx becomes a real
`OnReceiveRedirect` and the client comes back through `FollowRedirect()`.

### 3. Two keying bugs

`StripPerAttemptParams` was wrong, as the user said: the token is **server**
minted and lives in the recorded HTML, so replaying those bytes asks for exactly
the same URL. Worse, stripping collapsed four distinct steps onto one key and
scrambled the ordinals meant to separate them. Removed.

The replay ordinal counter was a map on `ReplayFactory`.
`WillCreateURLLoaderFactory` runs once per factory and the Critical-CH restart
gets a fresh one, so the counter reset to 0 and re-served ordinal 0 — defeating
ordinals in the one case they exist for. Now process-global.

### Result

```
oracle: 17 file(s), 394330 records, 8505ms       0 replay misses
store:  95 responses / 87 URLs
403:5899, 403:6091, 200:402579   https://rateyourmusic.com/
```

Traces contain `Welcome! - Rate Your Music` and the real page's `bundle.js`.
Reproduced across four runs. Recipe: `--vt-fence --vt-budget 600000`; the
default 30 s budget runs out mid-challenge.

Virtual time was the last blocker: with it on and no `--vt-fence`, the oracle
stalls at 5 510 records. With the fence it reaches the real page every time.

### `--self-check`: how good is the oracle?

New mode: run the oracle **twice** and diff the two. An oracle that cannot
reproduce its own run cannot convict the sandbox of anything.

On rateyourmusic: **0 T0 leaks**, 8 T1 buckets, ~220 T2 per run (345 unioned over
three). T1 is all environmental randomness — resource timing (real time even
under virtual time), ICE candidate ufrags, blob UUIDs, timer ids. The T2 bulk is
`identity-divergence`, downstream of a ~5 % record-count spread (≈400 k vs
≈370 k): the run is cut off by a 3 s **real-time** grace while the page is still
CPU-bound, so the two runs create different numbers of objects. Making the
termination condition virtual-time-based would fix that and has not been done.

Zero T0 is the load-bearing number: both sides of a T0 leak come from the
**sandbox** trace, so a flaky oracle cannot invent one.

The floor is stored in `noise.<host>.json`, deliberately apart from
`baseline.<host>.json` — a baselined bucket is "known and accepted", a noisy one
is "the oracle has nothing to say". Merging them would hide real bugs behind
noise with nothing in the output saying so. Both are per host now: bucket keys
are `tier|kind|api|class` with no page in them, and a shared `baseline.json`
silently suppressed 28 probe-page buckets the first time a rym `--baseline` run
overwrote it.

### Recording also moved to the browser process

Renderer-side probes cannot see an opaque cross-origin response — 20 of 78 URLs
never reached the store that way. `RecordingClient` sits between the network
service and the renderer. Not via `mojo::MakeSelfOwnedReceiver`: that destroys on
pipe disconnect, and the network service closes its end as soon as it has sent
`OnComplete`, while the drainer is still reading — the page then never loads at
all. `MaybeCreateSbxdiffNetObserver()` is commented out at its call site as a
result; two recorders double-write, and the dedupe is per-process.

### Unaffected

Probe pipeline back to 1294 divergences / 1 bucket / 1 T0 after restoring the
clobbered baseline as `baseline.localhost.json`.

## Phase 14 — the sandbox runs the challenge

Five defects between the sandbox and the Turnstile widget, found in order, each
hiding the next. None of them presented as an error.

### 1. The fence was on both sides

`--vt-fence` is what the oracle needs and what the sandbox must never have
(RULES.md #40). I had regressed that by making it a single flag. The symptom was
not a hang: the orchestrate script was requested, the store served it, and it
simply never appeared in the trace's script table. `--vt-fence` now takes a side.

### 2. `this` was `undefined` and scramjet took it literally

WebIDL: _"Let esValue be the this value, if it is not null or undefined, or
realm's global object otherwise."_ So a bare `addEventListener("x", fn)` is a
listener on the global in every engine, and Cloudflare's challenge script makes
exactly that call. Scramjet's interceptor passed `undefined` through to its own
bookkeeping, which used it as a WeakMap key — `Uncaught TypeError: Invalid value
used as weak map key`, a message no engine produces there, so both a broken page
and a tell. Fixed in `attemptToCallHandler`, plus a guard in the event shim so
the native decides what an illegal receiver means.

8511 → 33810 records.

### 3. The store refused POSTs

The endpoint called non-GET an "honest miss" while the Chromium-side replay
answered any method from the same URL key. Cloudflare POSTs to its `fo/`
endpoint and the recording holds the response. A divergence the harness invented.

33810 → 91414 records, and the Turnstile iframe started loading.

### 4. Scramjet was spending the guest's randomness

The one worth remembering. Under a pinned PRNG the keystream is **shared**: V8
seeds `Math.random` per native context from `--random-seed`, so the guest's Nth
draw is a fixed value, and Chromium's web-crypto keystream counter is per
thread. Anything the sandbox draws in the guest's realm shifts every value the
guest afterwards sees.

| Drawn by                              | Draws                  | Fix                                     |
| ------------------------------------- | ---------------------- | --------------------------------------- |
| `scramtag()` (wasm rewriter)          | 2585 `getRandomValues` | counter + FNV-1a of the context URL     |
| `libcurl/index.js` at module init     | 128 `getRandomValues`  | loaded on demand, non-sbxdiff path only |
| `createFrameId()` (controller inject) | 8 `Math.random`        | counter on the parent document          |
| `ScramjetClient.opaqueScope`          | 1 `Math.random`        | minted on first use                     |

Turnstile derives its widget id from one of those draws and puts it in a URL.
The sandbox minted `t0rxw`, then `c6t0r`, then — with all four removed —
**`q7dlh`, the recording's own id**. The run replays with zero store misses and
zero near matches.

The chase for this started from a store miss on
`…/turnstile/f/av0/rch/t0rxw/…` where the store had `…/rch/q7dlh/…`, and a
count: 2705 `getRandomValues` in the sandbox against the oracle's 6.

### 5. Still open: the Turnstile handshake

The widget iframe loads and its realm exists, but it sits in a postMessage loop
— 268 identical `Window.postMessage(obj, "*")` calls — and api.js's `message`
listener on the guest window never reads `MessageEvent.origin`, where the oracle
reads `https://challenges.cloudflare.com` on its first message. The widget realm
has 268 records against the oracle's 11204, and none of the oracle's `blob:`
worker realms (~350k of its ~400k records) exist.

Sandbox totals through the five: **7475 → 86162 records** against ~400000.

### Also added

A **near match** in the store endpoint: on an exact miss, serve the one
recording whose URL differs in exactly one path segment (same origin, same
segment count, same query; one candidate or nothing). Logged and reported apart
from hits — it is a divergence, just not one the store can resolve. rym no
longer needs it; a client-minted random id in a URL is a general problem.

### Unaffected

Probe pipeline 1295 divergences / 1 bucket / 1 T0 after all four scramjet
changes.

## Phase 15 — postMessage, and what is left of Turnstile

### `postMessage` was delivering to the sender

The one worth remembering from this pass. scramjet's `window.postMessage` shim
forwarded to the native like this:

```js
const wrappedPostMessage = Function("...args", "this(...args)");
ctx.return(wrappedPostMessage.call(ctx.fn, ...ctx.args));
```

`this(...args)` calls the native with **no receiver**, and WebIDL then
substitutes the realm's own global — so `otherWindow.postMessage(...)` silently
delivered to the forwarder's own window. A frame talking to its parent talked
only to itself. The stolen-`Function` trick is there to fix the _incumbent_
realm so `MessageEvent.source` is the caller's window; it was never meant to
drop the receiver. Now `fn.apply(target, args)`.

`probe.html` and `inner.html` gained `msg.*`: the frame posts to its parent and
the parent records `e.origin`, `e.source === frame.contentWindow` and the data.
All three were "(never observed)" in the sandbox before the fix.

### Two differ bugs the new probe case exposed

`selectGuestRealm` picks "the realm with the most records" among those matching
a hint, and the hint was the whole origin. Adding a listener and a post to
`inner.html` made the frame busier than the page, so the sandbox started
comparing **inner.html** against the oracle's **probe.html** — 60 buckets of
pure noise, every observation on both sides missing or extra. The hint is now
the target page: exact on the oracle, its encoded form under the proxy prefix on
the sandbox.

And baselines were per host, so `--page csp.html --baseline` would overwrite
probe.html's. Now per host **and** path.

### Critical-CH restart: documents only

The recording shows the oracle did not restart for the Turnstile iframe — one
stored response, not two — so emulating it per URL loaded the widget twice.
Gated on `Sec-Fetch-Dest: document`.

### Where Turnstile stands

The parent now posts into the widget (48 times, retrying) and the widget never
answers.

Its document is delivered intact: instrumenting the service worker's
`rewriteBody` shows `254986 bytes / 1 script in → 972748 / 5 out`. And its
realm's entire record set is 48 inbound `postMessage`s plus 16 `location` reads,
9 `parent` reads, 4 `Location.href` reads and 2 `sessionStorage` reads — no
`addEventListener`, no DOM construction, against 8045 records for the same
document served standalone. It starts and gives up in its first few statements.
Its absence from the trace's script table proves nothing either way: scramjet
serves rewritten inline scripts as `data:` URLs.

Ruled out, each by a probe page or a run:

| Hypothesis                                                         | Verdict                                                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| The document itself                                                | Works standalone at `--page`; renders "This challenge must be embedded into a parent page." |
| A ~200 KB inline script                                            | Works                                                                                       |
| A strict meta CSP with a nonce, plus Trusted Types                 | Works — and found a real divergence, below                                                  |
| A script-created iframe                                            | Works                                                                                       |
| A script-created **cross-origin** iframe reporting via postMessage | Works, `e.origin` included                                                                  |
| Virtual time                                                       | Same with `--no-virtual-time`                                                               |
| The Critical-CH emulation double-loading the widget                | Fixed; no change                                                                            |

### A real finding: Trusted Types are not enforced

`csp.html` carries `require-trusted-types-for 'script'` in a meta CSP, so
`el.innerHTML = "<b>x</b>"` is a `TypeError` in a real browser:

```
T1  value-divergence  guest:csp.innerHTML
    oracle : threw:TypeError
    sandbox: x
```

scramjet deletes the meta CSP wholesale — the code says "this needs to be
emulated eventually" — and Trusted Types enforcement goes with it. Deliberately
not baselined.

### Unaffected

`pnpm sbxdiff` (probe.html): 1298 divergences, 1 bucket, 1 T0 — the known
`guest:stack` leak. `--page embed.html`: clean.

## Phase 16 — the sandbox passes the challenge

Two more, on top of Phase 15's five. The sandbox now replays rateyourmusic end
to end: it passes Cloudflare's managed challenge and reaches the real page.

```
oracle : 17 file(s), 394273 records
sandbox: 17 file(s), 462845 records
3827 divergence(s), 0 T0 leak(s)          T2 819, T4 1 -- no T0, no T1
```

`Welcome! - Rate Your Music` appears in the **sandbox** traces, and its realm
list mirrors the oracle's: the widget frame, eight
`blob:challenges.cloudflare.com` worker realms, an `about:srcdoc` realm, and a
second `rateyourmusic.com` realm for the real page. Across all seven fixes the
sandbox went from **7 475 to 462 845 records**.

### 6. Virtual time starved the widget's frame

The long one. The widget's document never got past its first script: measured,
`readyState: "loading"`, one script, 83 bytes of DOM, unchanged across an entire
30 s run — while `performance.getEntriesByType("navigation")[0].decodedBodySize`
said all 972 750 bytes had arrived. Ruled out along the way, each by a probe
page or a run: the document itself (it runs standalone), a ~200 KB inline
script, a strict meta CSP with a nonce plus Trusted Types, a script-created
iframe, a script-created cross-origin iframe, Cloudflare's exact embedding shape
(0×0 iframe with `allow` and `sandbox`, appended to a shadow root), the response
headers (stripping all of them changed nothing), and the `Critical-CH`
emulation double-loading the widget.

What it was: `kDeterministicLoading`. With `--no-virtual-time sandbox` the same
frame runs 44 000 records and spawns Turnstile's blob workers. Not root-caused
beyond that. The workaround costs the sandbox its pinned elapsed clock, which is
why three analytics beacons carrying `_p=<epoch ms>` now miss the store — the
oracle reproduces the recorded value from its virtual clock and the sandbox
cannot.

A false lead worth recording: scramjet's `contentWindow` trap hooks a subcontext
into a frame on first read, and with the frame stuck mid-parse that produced a
document with `readyState: "complete"`, no `<body>`, and the parse abandoned. I
read that as "the hook destroys the parse". It was the _symptom_ — the frame was
already stuck; hooking a stuck frame just changed how the stuckness looked.

### 7. The click never reached the widget

`RenderFrameHost::GetView()` returns the ROOT view for a subframe sharing its
parent's process, so `--sbxdiff-click-frame` was silently clicking (22,32) of
the top-level page. Not a corner case for a sandbox — it is the norm: the oracle
sees `challenges.cloudflare.com` cross-origin and therefore out-of-process, with
a widget of its own, while a proxy serves every frame from one origin.

Found by diffing the two widget realms' API histograms: the oracle's had
`MouseEvent.*`, `Document.elementFromPoint`, `Element.clientWidth` — the shape
of an interactive widget being clicked — and the sandbox's had none of them,
while matching the oracle exactly on things like `Document.styleSheets.get`
(413 on both). The sandbox was running the whole challenge and looping on
`createScript(1337359)` every 550 ms, waiting for a click that never came.

The runner now asks the frame for its offset from an **isolated world** — the
page shares the DOM but not the prototypes, so a replaced
`getBoundingClientRect` cannot observe the question — and clicks in root
coordinates. `--grace <ms>` was added at the same time: with the sandbox on a
real clock, Turnstile's own timers are real seconds and the default 3 s ended
the run mid-challenge.

### Unaffected

`pnpm sbxdiff` (probe.html): 1298 divergences, 1 bucket, 1 T0 — the known
`guest:stack` leak.

## Phase 17 — rateyourmusic request bodies

### What the target actually is

Not the recording. Unmodified Chromium replaying the same store disagrees with
it on all five `/fo/` endpoints, and — the measurement that settles it — **two
runs of unmodified Chromium disagree with each other on 6 of 8 request
bodies**. Cloudflare's payload carries a time-boxed proof of work whose
iteration count varied 43 962 against 47 144 between two identical oracle runs,
and the payload is `JSON → LZW → XTEA → base64` with the XTEA key generated per
request and RSA-wrapped, so the plaintext is not recoverable and the bytes
cannot be attributed by reading them.

So the reachable target is "inside the oracle's own spread", and the comparison
had to be rebuilt to measure that at all (`c0bc1851`).

### Where it stands

    rym  /fo/ #0        2263 vs 2263    exact
    /httprequest/SecChk 2450 vs 2450    exact
    rym  /fo/ #1        8876 vs 8791    -85
    jsd/oneshot        16270 vs 15967   -303   (was: not sent at all)
    cf   /fo/ #0        4588 vs 4716    +128
    cf   /fo/ #1       88652 vs 89708   +1056
    cf   /fo/ #2       91863 vs 92930   +1067

Every request the oracle makes, the sandbox now makes. The API diff is at one
T1 bucket and 0 T0 leaks, and `--self-check` is down to 34 divergences.

### Resource sizes now match the site's, not the proxy's

`PerformanceResourceTiming` reports what the browser received, and under the
proxy that is the rewritten script -- 113793 bytes where rateyourmusic served
86603, inside a payload Cloudflare posts. The rewriter's own sourcemap says
what it added, so the original is arithmetic on data the client already holds
(`0b4ec8d1`, RULES.md #130). Two pieces were invisible until measured: the
replaced string's length in BYTES rather than UTF-16 units, and the
`pushsourcemapfn([...], "tag");` call the rewriter prepends AFTER computing the
map, which is 15390 of the 27190 bytes.

The whole 829-byte resource-timing payload is now byte-identical across the two
sides, and the correction lives in scramjet, so it holds on a stock browser.

### The widget's realm, which the diff was never looking at

`index.ts` compares ONE realm per side -- the page -- and on rateyourmusic that
is 2% of the run. Cloudflare's fingerprinting happens in the Turnstile widget's
own realm and in a blob worker, and neither was ever in the comparison, so
"0 T0 leak(s)" was a statement about 2% of the run. Diffing that realm offline
against the same traces turned up six T1 divergences at once, every one of them
in the payload the widget posts.

Five are fixed (`4a15ebe6`, `0b3b3835`, `f2dbf66f`, `fbd09bbc`):

    decodedBodySize    256046   vs  968058      the document's own size
    encodedBodySize    256046   vs  968058      same, and via toJSON too
    totalJSHeapSize    53558272 vs  180295469   the shim shares the heap
    usedJSHeapSize     31237624 vs  137809077   same
    Event.timeStamp    -- comes and goes with the click plateau

What is left there is the proxy's COST rather than its shape:

    duration           13.4 vs 317.5   the navigation entry's, i.e. load time
    responseStart      0.6  vs  1.7
    long-animation-frame               one entry, attributed to the GUEST's own
                                       script, which exists only because that
                                       script runs slower rewritten

The last one is a decision rather than a bug: masking long frames whose scripts
are all the proxy's is safe and is done, but this one is the page's own script
being slow BECAUSE of the proxy, and hiding it means hiding a real statement
about speed. Left visible.

### The request bodies, and what they can be

The oracle cannot reproduce its own. Two ORACLE runs on the same store post
87746 bytes against 87767, 90903 against 90914, 8716 against 8727 -- and
internal-cf's lifted challenge says why: `gl(W)` serialises an OBJECT straight
to bytes, and inside it is one entry per pointer event (capped at 50), each
stamped with a real `performance.now()`, plus `collectionStartTime` and the
target's `getBoundingClientRect` centre. There is no plaintext string anywhere
in the pipeline, which is why no probe ever found one.

So the bodies are now scored against the oracle's own spread, like every other
comparison here (`bodynoise.ts`, RULES.md #138). Recorded from three
self-checks: 0, 11, 11, 11 bytes. Four of the five differences are far outside
that and still fail:

    cf /fo/ #0      4556  vs  4674   (+118)
    cf /fo/ #1     87756  vs  88951  (+1195)
    cf /fo/ #2     90914  vs  92098  (+1184)
    jsd/oneshot    16268  vs  16191  (-77)
    rym /fo/ #1     8727  vs  8759   (+32)    inside the floor now

Ruled out by measurement, so the next person does not spend the day there:

- every `TextEncoder` component in the widget realm -- identical, all ten
- every `JSON.stringify` result there -- identical, all eleven
- all 36 messages the fingerprinting worker exchanges -- identical, after
  rule 136
- every string over 20 KB either side reads character by character --
  the same four, same lengths, same heads
- the widget's geometry and its pointer event counts: 17
  `getBoundingClientRect` calls and 95 rect reads on both sides, the same
  boxes (254.546875, 183.390625, 20x21), the same 3/3/2/1 mouse and pointer
  reads. The `DOMRect.width` 20-against-231.1875 that looked like a layout
  divergence is six extra SHIM reads at the front, an offset in the pairing
  rather than a different widget.

### The live path, which is what the replay is a proxy for

Run both sides against the real Cloudflare with the same click, over the
BLINK transport so both present one network stack:

    pnpm serve --blink --url https://rateyourmusic.com/ --open sandbox \
      --click 22,32,6000,10,3000 --click-frame challenges.cloudflare.com

The sandbox no longer loops. It used to answer five cycles of `GET / -> 403`;
now it gets one 403 (the challenge being issued), loads the widget, and has
every `/fo/` payload accepted with a 200.

What is left there, and it is a real divergence rather than an interpretation:

    sandbox   [Cloudflare Turnstile] Cannot find Widget cf-chl-widget-q7dlh   x4
    oracle    nothing

Same site, same click, same seventy-five seconds, unmodified Chromium on the
other side. No uncaught exceptions on either. Turnstile cannot find the widget
element it just rendered, only under the proxy.

The likely shape: the widget realm's diff reports `Node.parentNode` returning a
`ShadowRoot` in the sandbox where the oracle returns `HTMLBodyElement`, and a
shadow root is exactly the boundary that hides an element from a document
query. scramjet shims neither `attachShadow` nor `getElementById`, so it is not
creating that root -- Turnstile is, and only on one side. That is where to look
next.

### Where the four remaining bodies come from

The list Cloudflare walks and posts. Measured in the widget's realm, at the
challenge's FIRST `getEntries()`:

    oracle    navigation, visibility-state, 1 resource
    sandbox   visibility-state, navigation, 2 resources

Both sides have the same four resource entries over the run -- the `fo` XHR
three times and the `ci` image once -- so nothing is extra or missing. What
differs is WHEN: the sandbox's `ci` entry has already landed when the challenge
walks the list, and the oracle's has not. An entry is ~829 bytes serialised
(measured: that is the whole first payload), so a list that is one entry longer
is a payload that is longer.

That is load completion racing the challenge's own progress, and the logical
clock cannot pace it: the clock advances on guest timers, and a resource lands
when the bytes arrive. It is also the last thing standing, with everything else
in that realm now measured equal.

Not the cause, each ruled out by measurement rather than argument: the pointer
telemetry (same events, same geometry), `performance.now()` (same values, read
for read -- and widening its attribution the way rule 113 widened the timers'
makes it WORSE, rule 139), and the failed-request replay (27 of 96 store
entries have that shape and both sides serve them identically).

### Two leaks the payload was carrying, found by enumeration

`gl(W)` serialises an object straight to bytes, so there is no plaintext string
to read -- but every key the challenge enumerates crosses a traced API. Hooking
`Object.keys`, `Object.entries` and `Object.getOwnPropertyNames` in the widget
realm, chunking each list through `document.createComment` so nothing is
truncated, and pairing the two sides' enumerations by key-set overlap rather
than by index (scramjet performs its own, which offsets the sequences) gave the
whole set of differing ones rather than the first:

    keys 237 vs 236   only oracle: navigation
    keys 272 vs 271   only oracle: navigation
    keys  22 vs  23   only sandbox: "f1.2|f1|"

The third is a Cloudflare constant pool -- a string the challenge collected and
kept -- and `f1.2|f1|` is the controller's frame id. It was stored in
`window.name` in front of the page's own value, and it accumulated: the write
used the bare `window` binding, which for a subcontext is the PARENT's realm,
and `window.name` survives a navigation, so each injection prefixed a string
that already carried an id. A page two frames down read `"f1.2|f1|"` where a
browser reports `""`. Nothing outside the id chain ever consumed the id, so it
came out of `window.name` entirely (RULES.md #148).

The first two are the Navigation API, now shimmed rather than deleted: three
URLs (`navigate()` going out, `NavigationHistoryEntry.url` and
`NavigationDestination.url` coming back) plus keeping a fragment navigation
same-document (RULES.md #149). `globals.html` is exact -- 1236 own properties
against 1236, same hash, same bytes -- and `jsd/oneshot` went from -77 bytes to
-13 with its agreeing prefix growing from 825 to 1056.

### Where the bodies stand

    cf /fo/ #0      4556  vs   4684  (+128)
    cf /fo/ #1     87543  vs  88855  (+1312)
    cf /fo/ #2     90711  vs  92034  (+1323)
    rym /fo/ #1     8738  vs   8802  (+64)
    jsd/oneshot    16268  vs  16255  (-13)

Three other bodies are byte-identical. All four `/fo/` divergences begin at
byte 171 exactly, which is where the RSA-wrapped key ends: 128 bytes is 171
base64url characters. So the key reproduces on both sides and only the
plaintext differs -- and the oracle's own spread on these same bodies is 0 and
11 bytes, so +1312 is a real content difference, not telemetry noise.

### The build that was never run

The harness serves `packages/core/dist`, and neither `rym.sh` nor
`pnpm sbxdiff` built it. A source change that was never built therefore
measured as "no divergence", which is the strongest result the differ can
report. Caught by accident -- reverting a fix produced a run identical to the
fixed one. `regress.sh` had always built; `rym.sh` now does too (RULES.md #146).

### Reading the payload, and what six fixes did to it

The `/fo/` body is `base64(rsa-wrapped key || xtea(lzw(json)))`. Both sides part
at byte 171 exactly, which is where a 128-byte wrapped key ends, so the key
reproduces and the whole difference is plaintext. internal-cf reads that
plaintext by rewriting `xhr.send(enc(payload))` in source; rym's recording is a
string-table VM with no textual call site, and a search of all 97 store entries
for that shape found zero. But LZW reads its input character by character, so
the plaintext is the receiver of a long `charCodeAt` (RULES.md #150).

That instrument found two fixes nothing else had:

    Error.stackTraceLimit      50 in every realm, V8 default is 10; stacks
                               ten frames deep against twenty-one (#151)
    scramjet-attr-<name>       a renamed attribute vanished from every
                               enumeration -- `hasAttribute("nonce")` false
                               where a browser says true (#155)

and enumeration hooking found two more: the controller's frame id, which had
been accumulating in `window.name` without bound (#148), and the Navigation
API, which was deleted rather than shimmed (#149).

    cf /fo/ #0     +128  ->   +22
    cf /fo/ #1    +1312  -> +1152
    cf /fo/ #2    +1323  -> +1152
    rym /fo/        +64  ->   +64
    jsd/oneshot     -77  ->   -13

### What is left, ranked by what is actually known

CONFIRMED in the payload, unfixed:

- Stack line and column. `shared/error.ts` unrewrites the URL in every frame
  and nothing maps the POSITION back: `:2:20674` against `:3:25157`. Fixing
  it needs line tables for the original and the rewritten text, and scramjet
  retains neither -- `Rewrite[]` gives offset deltas, not lines. A real
  feature, not a patch.

- Attribute order. `nonce src` enumerates as `src,nonce` because the alias
  does not sit where the attribute sat. The authored position is not written
  down anywhere, so this is the rewriter's emission order to fix.

MEASURED AND RULED OUT, so nobody has to look again:

- The performance entry list. Masking every long animation frame -- not a
  shippable fix, a measurement -- moved the two big bodies by 10 and 21
  bytes, which is run-to-run variance.

- Every long string the pipeline reads: identical in length AND in sampled
  checksum on both sides.

- Every textual component of 512 bytes or more: identical except the stacks
  above and one SDP field, the DTLS certificate fingerprint, at identical
  length on both sides.

- `window.frameElement`, which the challenge's collected-value pool appeared
  to hold only in the sandbox. Probed in the widget realm: null on both
  sides, and every property of it agrees. The pool comparison splits on
  commas and the pool holds values containing commas, so that reading was an
  artifact.

STILL UNLOCALISED: about 1152 bytes of body, which is roughly 864 bytes of LZW
output. The `charCodeAt` seam cannot see it -- every component it can reach
agrees. The likely reason is that the compressor consumes a byte ARRAY rather
than a string, which is what the `fromCharCode` and `join` shapes suggest: the
final body is assembled by joining an 87564-element character array.

Two cautions for whoever picks this up. Counting `charCodeAt` receiver
TRANSITIONS is not a measure of plaintext volume -- code that alternates
between two strings produces many transitions over the same bytes, and a
histogram built that way says less than it looks like it says. And a
sandbox-only string is not evidence of a leak: wasm-bindgen passes ASCII into
wasm character by character, so scramjet's own rewriting shows up in exactly
the same hook.

### The old body notes

Still five, and stable in shape:

    cf /fo/ #0      4556  vs  4674   (+118)
    cf /fo/ #1     87767  vs  88951  (+1184)
    cf /fo/ #2     90914  vs  92098  (+1184)
    rym /fo/ #1     8716  vs  8748   (+32)
    jsd/oneshot    16268  vs  16191  (-77)

The self-check is the number that matters here: two ORACLE runs differ on four
of these too -- same LENGTH, differing in a small window ("agree on the first
4460 and the last 64"). So a length delta is a real content difference and a
byte difference at equal length is the floor. The +1184 pair is what is left to
explain, and the entry list is the strongest candidate: the sandbox's widget
sees its resources in a different ORDER (visibility-state before navigation,
both at startTime 0, so insertion order decides) and sometimes one more of
them.

### The old open lead

### The open lead

`document.scripts.length` reads 20 in the oracle and 23 in the sandbox. The
recorded markup carries 23 script tags — 20 untyped, one `text/javascript`, two
`module` — so the SANDBOX matches the markup and the oracle is the side that
ends up with fewer. Both oracle runs read exactly 20, so it is stable rather
than noise. Ruled out: scramjet's injected scripts (its removal finds and
removes all four, measured), the quirky injection path, document size, unusual
script types, and CSS selectors failing to find them (`3110a16e` fixed that and
the count did not move). What is left is WHEN the read happens relative to
parsing, which needs the identities of the three rather than the counts.

### Instrument bugs found on the way

Four, each of which had been producing confident wrong answers:

- T0 and T1 were switched off for every https site — guest scripts were matched
  with `http%3A%2F%2F`, which "https%3A%2F%2F" does not contain (`eee04928`).
- Realm ids collide across trace files, so the oracle's "guest realm" was a
  union of seventeen documents (`bbc71c23`).
- The request-body comparison was behind SBXDIFF_VERBOSE, so an ordinary run
  reported seven divergences that did not exist (`35a037f5`).
- Drifted pairs were being judged at T1, and calls past the shorter side's count
  were examined by nothing at all (`1b73b410`).

### The second reader could not read

`tools/sbxdiff/sbxread.py` exists so the `.sbxd` format has a reader that is
not `trace.ts` -- the point being that a format with one decoder has no
independent check on that decoder. It had stopped working:

    trace.8058.0.sbxd: SBXD v4 pid=8058 run_key=0xbd6d069
    unknown record kind 285402408423 at offset 102

v4 appended `varint(created_us)` to `kRealm`, and the Python decoder still read
the v2 shape. Missing a field does not fail where the field is -- it leaves the
cursor mid-record, so the NEXT varint decodes as a nonsense record kind and the
error points at the wrong place. It failed on the first realm in every file,
which is offset 102 of a 431 KB trace, so nothing anyone did with it worked at
all.

Fixed, and its header comment now documents v4 rather than v2. Worth stating as
a rule in the shape the others take: **a format bump must land in both readers
in the same change, or the second one is decoration.**

Found while looking for a time axis in the trace, which is how `created_us` --
a per-realm microsecond timestamp on a clock comparable across processes, added
in v4 and used by nothing but realm pairing -- turned out to be the timeline the
gate was missing. `pnpm sbxoffline --timeline` reads it.
