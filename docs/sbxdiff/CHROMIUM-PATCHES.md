# Chromium patch inventory

Every local modification to the Chromium checkout, why it exists, and what it is
anchored on. **`bind_gen/interface.py` is 7706 lines and churns**, so patches are
anchored on function names rather than line numbers wherever possible, and must be
re-anchored on every Chromium roll.

Checkout: `chromium-sbxdiff/src` @ **155.0.8051.0** / V8 15.5.28, detached at
`origin/main`.

Export the current state with:

```sh
cd chromium-sbxdiff/src
git diff > ../browser.js/docs/sbxdiff/patches/all.patch
```

---

## 0001 — CommandLineTools-only toolchain

**Status:** landed. **Files:** `build/mac/find_sdk.py`,
`build/config/apple/sdk_info.py`. **Patch:** `patches/01-host-build-fixes.patch`.

**Why.** Chromium's mac build assumes a full Xcode install. This machine has only
CommandLineTools (CLT), and installing Xcode would cost ~20 GiB of a disk budget that
is already the project's binding constraint (see `PROGRESS.md`). CLT turns out to be
sufficient: nothing in `chrome/` uses `compile_xcassets`, so `actool`/`ibtool` are not
needed, and every binutil the toolchain wants (`libtool`, `lipo`, `nm`, `strip`,
`dsymutil`, `install_name_tool`, `otool`, `codesign`) is present in `/usr/bin`.

**What breaks without the patch**, in the order you hit it:

1. `find_sdk.py` looks for SDKs under `<dev_dir>/Platforms/MacOSX.platform/Developer/SDKs`
   (Xcode layout). CLT puts them at `<dev_dir>/SDKs`. Symptom: the misleading
   `'Install Xcode, launch it, accept the license agreement...'` error.
2. `find_sdk.py --print_bin_path` returns `<dev_dir>/Toolchains/XcodeDefault.xctoolchain/usr/bin/`.
   CLT has `<dev_dir>/usr/bin`.
3. `sdk_info.py` shells out to `xcodebuild -version`, which CLT does not ship at all.
4. `sdk_info.py` uses `xcrun -sdk <platform> --show-sdk-platform-path`, which CLT
   cannot answer (`unable to lookup item 'PlatformPath'`). Note `--show-sdk-path`,
   `--show-sdk-version` and `--show-sdk-build-version` _do_ work — only the platform
   path fails, so that is what the fallback probes on.
5. `sdk_info.py`'s symlink loop symlinks every setting whose key contains `_path`.
   Our CLT fallback sets `sdk_platform_path = ''`, which made `os.symlink('', ...)`
   raise `FileExistsError`.

**Blast radius of the faked values.** The mac build reads only `xcode_version`,
`xcode_version_int`, `xcode_build` and `sdk_path` from `sdk_info.py`.
`sdk_platform_path` and `toolchains_path` are consumed exclusively by
`build/config/ios/`. `xcode_version_int` gates exactly one non-iOS thing —
`build/config/c++/modules.gni:44` asserts `>= 2600` — and the SDK-derived value
satisfies it.

**SDK selection is load-bearing; see `PINNED_ASSUMPTIONS.md` #1.** The fallback
resolves `mac_sdk_official_version` out of `build/config/mac/mac_sdk.gni` rather than
hardcoding a version, so it tracks Chromium rolls.

**Why `mac_sdk_path` is not simply set in `args.gn`.** It cannot be an absolute path:
`build/config/mac/BUILD.gn:114` lists `$mac_sdk_path/usr/include/mach/exc.defs` as a
build input, and gn requires inputs under the output directory. It has to arrive via
`sdk_info.py`'s `out/sbx/sdk/xcode_links` symlink. That is also why fixing the SDK
choice had to happen inside `sdk_info.py` instead of in `args.gn`.

---

## 0002 — remove the "HeadlessChrome" UA token

**Status: landed.** **File:** `components/embedder_support/user_agent_utils.cc`
(`GetUserAgentInternal`, ~line 216).

`chrome --headless` advertises `HeadlessChrome/155.0.0.0` in the UA. **This is not
`headless_shell` code** — the plan and the design pass both asserted the token only
affected that target, and measurement disproved it:

```
Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)
  HeadlessChrome/155.0.0.0 Safari/537.36
```

It comes from shared embedder code:

```cpp
std::string product = GetProductAndVersion();
if (base::CommandLine::ForCurrentProcess()->HasSwitch(kHeadless)) {
  product.insert(0, "Headless");   // <- deleted
}
```

Unlike the renderer-side `EnableAutomationControlled` mapping (withdrawn below),
`kHeadless` **is** available in the browser process, so this one really does fire.

**Why patch it at all**, given both runs share the binary and the token cancels by
symmetry: it is the loudest bot-detection tell there is, and it would poison any network
archive captured with this binary.

**Follow-up:** gate behind `BUILDFLAG(SBXDIFF)` once P1 introduces the `sbxdiff` GN arg.

### Withdrawn: the `navigator.webdriver` patch

The plan called deleting the `{EnableAutomationControlled, switches::kHeadless, true}`
mapping at `content/child/runtime_features.cc:344` the single highest-value fingerprint
fix. **It is unnecessary.** Measured `navigator.webdriver === false` under both
`--headless` and `--headless=new`, because `switches::kHeadless` is not in `kSwitchNames`
(`render_process_host_impl.cc:3855-4046`), so the renderer never sees it and that entry
is dead code there. See `PINNED_ASSUMPTIONS.md` #7.

The actionable rule is a flag discipline, not a patch: never pass `--enable-automation`,
`--remote-debugging-pipe`, or `--remote-debugging-port=0`. See `FLAGS.md`.

---

## 0003 — the tracer: `sbxdiff` GN arg + macro extension (M2)

**Status: building.** **Files:** new
`third_party/blink/renderer/platform/bindings/sbxdiff/{sbx_tracer.h,sbx_tracer.cc,sbx_scope.h}`;
modified `third_party/blink/renderer/platform/BUILD.gn` and
`third_party/blink/renderer/platform/bindings/runtime_call_stats.h`.
**Patch:** `patches/04-tracer.patch` (new files included with full content).

### The generator does not need to change for chokepoint A

`bind_gen/interface.py:842` already emits

```cpp
BLINK_BINDINGS_TRACE_EVENT("Element.tagName.get");
```

at the **prologue** of every generated attribute get/set, operation, constructor,
exposed construct, legacy factory function, overload dispatcher and stringifier
callback. Three properties make that macro a usable instrumentation point as-is:

1. It is emitted _before_ `make_check_receiver` and before every early return, so the
   four attribute-setter fast paths and the `make_return_value_cache_return_early` path
   are all inside the scope.
2. `info` is in scope, always named `info`, and always
   `const v8::FunctionCallbackInfo<v8::Value>&` — verified across every macro site in
   the generated output.
3. The macro is used in exactly **one** place in the whole source tree
   (`interface.py:842`), so redefining it cannot affect hand-written code.

But `info`'s **type** is not uniform, and assuming it was cost a failed build. The
macro is emitted into three distinct signatures, counted across both generated trees:

| Signature                                           | Sites                               |
| --------------------------------------------------- | ----------------------------------- |
| `const v8::FunctionCallbackInfo<v8::Value>& info`   | 13,418                              |
| `const v8::PropertyCallbackInfo<v8::Value>& info`   | 2,212                               |
| `const v8::PropertyCallbackInfo<v8::Boolean>& info` | 2 (cross-origin `Location` setters) |

and the two info types expose **different receiver accessors**:
`FunctionCallbackInfo` has `This()` and no `Holder()`; `PropertyCallbackInfo` has
`Holder()` and no `This()`. So `SbxBindingScope` is a template deduced via CTAD, with
the receiver chosen by an overload pair rather than assumed.

**Fidelity caveat, recorded rather than hidden:** at `PropertyCallbackInfo` sites the
tracer records `Holder()` — the object the property was found on — not the receiver the
guest actually used. Those differ for inherited properties and interceptor paths.
Revisit if V8 ever exposes `This()` there.

Also worth knowing: the `make_cross_origin_*` setters **do** get this macro (that is
where the `PropertyCallbackInfo<v8::Boolean>` pair comes from), so cross-origin
attribute access is partially covered by chokepoint A already, even though ordinary
named/indexed interceptors are not.

So `runtime_call_stats.h` gains an `#if BUILDFLAG(SBXDIFF)` arm that expands the macro
to the existing `TRACE_EVENT0` **plus** an `SbxBindingScope`. That instruments
**1,152 generated `.cc` files** — 549 in `bindings/core/v8` and 603 in
`bindings/modules/v8` — with no `bind_gen` change, and therefore without paying the
~2,900-TU regeneration cost per iteration.

Verified after compiling one generated TU:

```
$ nm out/sbx/obj/.../v8_element.o | grep sbxdiff
U __ZN5blink7sbxdiff9SbxTracer16TraceBindingCallEPKcPN2v87IsolateENS4_5LocalINS4_5ValueEEES9_b
U __ZN5blink7sbxdiff9SbxTracer3GetEv
```

### Why `platform/bindings/sbxdiff/` and not `core/sbxdiff/`

Measured: the macro is emitted into **both** generated trees, and `Document`'s real
bindings are in `bindings/modules/v8/v8_document.cc`, not `core` (`core/v8/v8_document.cc`
is a 3 KB stub with only `IsExposed`). `modules` can see `core` and `platform`; `core`
cannot see `modules`. `blink_platform` is the only component visible to both.

`runtime_call_stats.h` reaches generated code via `v8_per_isolate_data.h` and
`v8_dom_wrapper.h`, both already in `platform/bindings/`, so the include is free.

### Interceptors are NOT covered by this patch

Confirmed by measurement, not assumption: 30 accesses each of `coll[0]`,
`coll["span"]` and `window["myframe"]` produced **zero** trace events, while
`document.all` (a generated _attribute_) traced exactly 30. Named/indexed property
interceptors do not receive `BLINK_BINDINGS_TRACE_EVENT`, so the second chokepoint,
`_make_interceptor_callback_def`, remains a real generator change and is still to do.
`window[name]` is a classic sandbox-escape vector, so this is load-bearing.

### Notes for the next person

- `Symbol::Set` / `HasValue` / `DeleteProperty` on `V8PrivateProperty::Symbol` all
  `ToChecked()` and would **CHECK-fail** on a receiver that refuses private properties
  (Wasm objects, detached global proxies, shared structs). Use raw
  `object->SetPrivate(...)` and `Symbol::GetOrUndefined(...)`, which do not.
- `v8::Isolate::DisallowJavascriptExecutionScope`'s enum is
  `CRASH_ON_FAILURE`, not `kCrashOnFailure`.
- Chromium's `-Wunsafe-buffer-usage` is `-Werror` here: no pointer+length
  `base::span(...)` construction and no `memcpy`. Use `base::span(container)`,
  `base::as_byte_span(std::string_view)` and `std::bit_cast`.
- WTF `Vector` has no `AppendSpan`; use `Append(span.begin(), span.end())`.
- `ObjectIdFor` must check `isolate->InContext()` first. Private-property get/set both
  need a context, and bindings can fire with none entered (snapshot creation, some
  early-startup paths), where `GetCurrentContext()` is an empty handle.
- **Sample all three signature variants before a full rebuild.** Validating only
  `v8_element.cc` (which is `FunctionCallbackInfo`-only) passed, then the full build
  failed 6 minutes in at `v8_location.cc`. Compile one TU of each variant instead:
  `v8_element.o`, `v8_audio_track_list.o`, `v8_location.o`.

### 0003a — switch plumbing (the silent failure this caused)

**Files:** `third_party/blink/public/common/switches.{h,cc}`,
`content/browser/renderer_host/render_process_host_impl.cc`.

The first traced run produced **no trace file and no error**. `SbxTracer::IsEnabled()`
reads `--sbxdiff-trace-out` from the command line, and the tracer runs in the
**renderer** — but the switch was not in `kSwitchNames`, the browser-to-renderer
allowlist. The renderer therefore never saw it, disabled itself, and exited cleanly.

This is the exact hazard already written down as `RULES.md` #13, walked into anyway. The
fix removes the possibility rather than just the instance: the switch names now live in
`blink::switches` (`blink/public/common/switches.h`), so the browser-side allowlist and
the renderer-side reader reference the **same constants** instead of duplicated string
literals. Adding them there is cheap — 123 direct includers and **zero** of them are
headers, so there is no transitive fan-out.

`kJavaScriptFlags` appears twice in `render_process_host_impl.cc` (once in a
`--jitless` helper, once in `kSwitchNames`); anchor on the preceding
`kTouchTextSelectionStrategy` line to hit the array.

### Cost correction: the macro-in-a-shared-header approach was the expensive choice

Patch 0003 was justified as avoiding "the ~2,900-TU regeneration cost" of a `bind_gen`
change. **That has it backwards**, and the numbers say so:

| Approach                                                 | Rebuild scope                                                        |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| Extend the macro in `runtime_call_stats.h` (what we did) | **~28,650 edges**                                                    |
| Change `bind_gen`                                        | ~2,928 generated `.cc` — which are _leaf_ TUs, nothing includes them |

`runtime_call_stats.h` reaches generated code via `v8_per_isolate_data.h` /
`v8_dom_wrapper.h`, and those are included by essentially all of Blink core and
modules. Measured distribution of the rebuild: 1,826 objects in
`blink/renderer/core/core`, 981 in `bindings/core/v8/v8`, the rest spread across ~30
module targets. It took **70 minutes**, and the rate was ~65 objects/min rather than
the cold build's 200-225, because Blink core holds the slowest TUs in the tree.

**Planned fix, folded into the chokepoint-B work** so it costs one rebuild rather than
two: have `bind_gen` emit the `#include` for `sbx_scope.h` directly into generated
code, and drop the `runtime_call_stats.h` arm. After that, `sbx_scope.h` edits rebuild
only the ~1,152 generated files and `sbx_tracer.cc` edits rebuild exactly one TU.

---

## 0004 — headless macOS CGWindowID DCHECK

**Status: landed.** **File:** `components/remote_cocoa/browser/scoped_cg_window_id.cc`.

Every traced run died with:

```
FATAL:components/remote_cocoa/browser/scoped_cg_window_id.cc:29]
DCHECK failed: GetMap().count(cg_window_id) == 0u (1 vs. 0)
```

`ScopedCGWindowID` registers itself in a process-global map keyed on the CGWindowID,
which comes from the real `NSWindow.windowNumber`
(`ui/views/cocoa/native_widget_mac_ns_window_host.mm:690-697`). Headless windows have no
backing NSWindow, so the id is **0 for all of them**, and the second window collides.
It is fatal only because we build with `dcheck_always_on = true` — which we keep,
because the same setting is what enforces the tracer's
`DisallowJavascriptExecutionScope` invariant.

Fix: skip registration when `cg_window_id == 0`, in both the constructor and the
destructor. 0 is not a valid CGWindowID and such a window has nothing to capture, so
this preserves the invariant for real ids rather than weakening the DCHECK.

This is an upstream Chromium bug on headless macOS, not something sbxdiff caused.

---

## 0005 — realm identity (M2b)

**Status: building.** **Files:**
`third_party/blink/renderer/bindings/core/v8/local_window_proxy.cc` (+ tracer changes in
`patches/04-tracer.patch`).

Every binding and interceptor record now carries a **realm id**, and a `kRealm` record
maps that id to the realm's document URL.

### Why core has to push this

The tracer lives in `platform/bindings/sbxdiff/` (it must be visible to both generated
bindings trees — see #0003) and `platform` cannot see `Document`. So the
realm→URL association is pushed **from core**, which knows both.

No separate adapter file is needed after all: `core` may include `platform` directly, so
`local_window_proxy.cc` includes the tracer header and calls
`SbxTracer::NoteRealm(isolate, context->Global(), url)` from
`LocalWindowProxy::UpdateDocumentProperty()` — the one place that already holds both the
`v8::Context` and the `Document`. Gated on `BUILDFLAG(SBXDIFF)`.

### Realm id

The object id of the current context's **global proxy** (`Context::Global()`), which is
stable for the realm's lifetime and costs one private-property read. `CurrentRealmId`
returns 0 when no context is entered, which is why `ObjectIdFor` needs its
`isolate->InContext()` guard.

Deliberately **not** cached in a `v8::Global`: that would keep the context alive and
leak realms. The per-record cost is a private-property lookup on an already-tagged
object.

### Why this matters more than it sounds

A run writes one trace file per process, and there is **no size heuristic** for finding
the page under test — it has been the largest file, the second largest, and the middle
file on different runs. Misidentifying the file looks exactly like missing
instrumentation, and cost three wrong diagnoses (see `PROGRESS.md` M2). Realm records
make trace files self-identifying.

### Known gaps

`UpdateDocumentProperty()` is `DCHECK(world_->IsMainWorld())`, so **isolated worlds and
workers get no realm URL yet** — their records still carry a realm id, just no URL
mapping. Worker and isolated-world hooks are follow-ups.

### Build note

`local_window_proxy.cc` lives under `bindings/core/v8/` but compiles into the
`core/core` target: the object is
`obj/third_party/blink/renderer/core/core/local_window_proxy.o`, not anything under
`bindings/`. Use `ninja -t targets all | grep <name>.o` rather than guessing paths.

---

## 0006 — worker and worklet realm identity (M2b gap closed)

`third_party/blink/renderer/bindings/core/v8/worker_or_worklet_script_controller.cc`

Patch 0005 hooked `LocalWindowProxy::UpdateDocumentProperty()`, which is **main
world only**. Worker and worklet realms therefore got an object id but no URL,
which is the wrong way round for this project: scramjet's client runs in a
worker, so worker realms are the ones that matter most.

The hook goes immediately after the global proxy is associated with its
wrapper, and reuses `url_for_debugger` — the script URL Blink has _already_
computed for `WorkerThreadDebugger::ContextCreated` at that exact point. No new
URL plumbing, and it is the same string DevTools would show.

Placed **outside** the `IsMainThreadWorkletGlobalScope()` if/else so both
branches are covered; the debugger call is only in the `else`, but realm
identity is wanted for main-thread worklets too.

Gated on `BUILDFLAG(SBXDIFF)`.

**Still open:** isolated worlds (extension-style content script worlds) get an
id but no URL. They do not arise in the sandbox scenario, so this is recorded
rather than fixed.

## 0007 — determinism: keyed PRNG and task identity (M4)

Two files, both chokepoints, both inert without their runtime switch.

**`base/rand_util_posix.cc`** — `SbxdiffRandBytes` called first in
`RandBytesInternal`. See `DETERMINISM.md` §2 for the measured gate and the
nonce layout. Two structural notes:

- `//base` cannot include Blink, so `kSbxdiffRunKey` lives in
  `base/base_switches.h` as the **single** definition, referenced from
  `blink::switches`, content's relay allowlist and the tracer. An earlier
  duplicate literal in `blink::switches` is exactly the drift that broke the
  trace switch once already.
- No new dependency: `//base` already links BoringSSL (the stock file includes
  `openssl/rand.h`), so `CRYPTO_chacha_20` and `SHA256` were free.

**`sbx_tracer.{h,cc}`** — task ids from V8's
`AddBeforeCallEnteredCallback` / `AddCallCompletedCallback` pair rather than
`scheduler::TaskAttributionTracker`, which measured 0 of 3126 records
attributed. Full reasoning in `DETERMINISM.md` § "Task identity". The callbacks
are registered lazily from the record path (`EnsureIsolateHooks`), so only
threads that actually trace install them — no spurious header-only trace files
on JS threads that never hit a binding.

**Build cost warning:** `sbx_tracer.h` is included by every generated bindings
TU, so touching it rebuilds ~1,121 files plus the link. Batch header changes;
do not interleave them with verification runs.

## 0008 — pinned initial virtual time (P3)

`base/base_switches.h`, `.../platform/scheduler/common/thread_scheduler_base.cc`,
`content/browser/renderer_host/render_process_host_impl.cc`

`--sbxdiff-initial-time=<unix_ms>`. Virtual time already makes time _deltas_
deterministic, but its origin is the real clock, so `Date.now()` and
`performance.timeOrigin` differ between otherwise identical runs (measured:
`DETERMINISM.md` §1). The patch sits at the exact fallback in
`ThreadSchedulerBase::EnableVirtualTime` where a null `initial_time` becomes
`base::Time::Now()`.

Notes:

- A malformed value is a `CHECK` failure, not a silent fallback — RULES.md #13.
  There is no hash trick available for a timestamp, so the alternative to
  loudness would be a silently non-deterministic run.
- The switch lives in `base/base_switches.h` next to `kSbxdiffRunKey`, so every
  determinism input has exactly one definition.
- It is relayed in `kSwitchNames`. The edit to add it initially failed its own
  anchor assertion, which is the third time this relay has bitten — the
  assertion is why it was caught this time rather than at runtime.
- Not gated on `BUILDFLAG(SBXDIFF)`: `//base` and the scheduler cannot see Blink
  buildflags, and the switch alone makes it inert.

## 0009 — dedicated keystream for web-exposed randomness (P4 fix)

`base/sbxdiff_rand_stream.h` (new), `base/rand_util_posix.cc`,
`base/BUILD.gn`, `third_party/blink/renderer/modules/crypto/crypto.cc`

Patch 0007 alone does **not** make page-visible randomness reproducible.
Per-thread streams made streams independent of each other, but every draw on a
thread shared one counter, so Chromium's own internal `base::RandBytes` calls
on the renderer main thread shifted the page's draws by a run-dependent amount.
Measured: 3 distinct results in 5 runs. See `PROGRESS.md`.

`SbxdiffScopedRandStream` reserves stream ids 1..15 for explicit streams, each
with its own per-stream counter, and moves automatic per-thread ids to 16+ so
they cannot collide. `Crypto::getRandomValues` and `Crypto::randomUUID` enter
`kSbxdiffStreamWebCrypto`.

Deliberate choices:

- **A new header, not `base/rand_util.h`.** `rand_util.h` is included across
  most of Chromium; a new header costs 2 TUs instead of a near-full rebuild.
- **Scoped at the Blink API, not inside `crypto::RandBytes`.** The stream must
  cover only the web-exposed entry points; `crypto::RandBytes` has many
  internal callers that should stay on the thread's automatic stream.
- **`CHECK` on an out-of-range stream id**, since a silently-ignored stream
  would reintroduce exactly the contamination this fixes.
- macOS only: the hook lives in `rand_util_posix.cc`. Windows and Fuchsia have
  their own `rand_util_*.cc` and would each need it.

## 0010 — early virtual time with a budget fence (P9b)

`base/base_switches.h`, `content/browser/renderer_host/render_process_host_impl.cc`,
`chrome/app/chrome_main_delegate.cc`, `third_party/blink/renderer/core/page/page.cc`

Completes patch 0008. Enabling virtual time in `Page`'s constructor — before the
main frame is attached, so before any page script can read a clock — together
with `kDeterministicLoading` **and** a bounded budget.

The budget is the load-bearing part, and the reason an earlier attempt (P9a) was
reverted. `GrantVirtualTimeBudget` sets a fence virtual time may not advance
past; without it an idle scheduler jumps to the next delayed task, which during
startup means far-future housekeeping timers. Result with the fence:
`Date.now()` is `1700000004000` in four consecutive runs — exactly
`initial + our 2000 ms fence + the 2000 ms CDP budget`, i.e. determined by the
fences rather than by real timing.

Notes:

- `base::DoNothing()` as the expiry callback is correct, not lazy: the
  controller documents that the policy is unaffected when the budget expires, so
  there is nothing to undo and no Oilpan lifetime to manage.
- `EnableVirtualTime` early-returns when already enabled, so a later CDP call
  still applies its own policy and budget. Only the origin is claimed here.
- Main-thread page schedulers only; a worker must not become a second
  virtual-time client (RULES.md #12).
- `--sbxdiff-virtual-time-budget` joined the existing browser-side validation
  loop in `ChromeMainDelegate`, which now covers any `--sbxdiff-*` value switch
  by adding one entry.
- Behaviour change: timers scheduled beyond the fence do not fire. That is
  already true of the stock `--virtual-time-budget`, and the hook is inert
  without `--sbxdiff-initial-time`.

## 0011 — the in-binary runner (`--sbxdiff-run`)

`chrome/browser/headless/sbxdiff_runner.{h,cc}` (new),
`chrome/browser/ui/startup/startup_browser_creator_impl.cc`,
`chrome/app/chrome_main_delegate.cc`, `chrome/browser/headless/BUILD.gn`.

Replaces `--dump-dom --virtual-time-budget` as the way to drive a run. That path
attaches a DevTools session and drives the page from a `chrome://headless/`
page — which puts a CDP realm in every trace, and is page-observable, which is
disqualifying for an oracle that must not be detectable.

The runner attaches to the real tab and quits on its own. **The trace files are
the output**; nothing goes to stdout.

### Quiet-period, not first-load

The first implementation latched on the first `DidStopLoading` and quit. On any
site with an interstitial that is the _challenge_ page, not the page — the run
ended before the thing being measured existed.

Now: a generation counter bumped by `DidStartNavigation`, a grace period that
restarts on each navigation, and a hard cap of 10× the grace so a page that
never settles still terminates.

### Input and capture

- `--sbxdiff-click=x,y[,delay[,repeat[,interval]]]` via
  `RenderWidgetHost::ForwardMouseEvent` — the path OS input takes, so
  `isTrusted` is true with no DevTools session.
- `--sbxdiff-click-frame=<url-substr>` targets a child frame's own widget.
  Necessary because `ForwardMouseEvent` delivers to one widget and is _not_
  hit-tested into child frames, and `RenderWidgetHostInputEventRouter` is not
  exposed in content/public.
- `--sbxdiff-shots=<dir>[,interval]` via `RenderWidgetHostView::CopyFromSurface`.
  In-browser because the macOS screenshot tool needs a Screen Recording grant an
  SSH session cannot give. Capture pixels are viewport pixels 1:1.

### The double-delete

`Finish()` ran twice and the second run segfaulted (exit 139). Fixed with a
`finished_` latch plus `Observe(nullptr)` and `DeleteSoon` rather than deleting
inline from an observer callback.

## 0012 — network visibility and the replay gate (P5, part 1)

`third_party/blink/renderer/platform/loader/fetch/resource_fetcher.cc`,
`base/base_switches.h`, `content/browser/renderer_host/render_process_host_impl.cc`,
plus `TraceNetRequest` / `ShouldBlockRequest` in the tracer.

Hooked at `ResourceFetcher::RequestResource`, chosen over the
`probe::WillSendRequest` machinery the plan suggested because it is
**platform-layer** — the same layer as the tracer, so no layering violation and
no probe-agent plumbing — and it is the single funnel for scripts, stylesheets,
images, XHR/fetch and worker scripts. `ResourceForBlockedRequest` is already in
scope there, so blocking reuses Chromium's own refusal path rather than a new
one.

Two capabilities:

- **Every subresource request becomes a `kNetRequest` record** (seq, task id,
  method, URL, blocked flag). Network divergence becomes directly visible: a
  sandbox that requests a different URL, or in a different order, shows up in
  the trace.
- **`--sbxdiff-net-allow=<file>` enforces hermeticity.** A request not in the
  newline-separated allow-list is recorded as blocked and refused. This is
  RULES.md #14 exactly: it does not fall through to the real network (which
  breaks hermeticity silently) and does not abort (which loses why the sandbox
  asked).

The record carries a task id but **no realm id**: resource loads are not
necessarily inside a v8 context, so ordering against binding records comes from
`seq`.

### Scope: this was the gate, not body replay — now superseded

This patch originally stopped at visibility and blocking, on the reasoning that
serving recorded **bodies** needed a `network::mojom::URLLoaderFactory` wrapper
and a `URLLoader` writing into mojo data pipes — several hundred lines against a
slow build cycle — and that serving both sides from one local origin was a
cheaper route to hermeticity.

That reasoning did not survive contact with a real target. rateyourmusic.com
cannot be served from a local origin, and it is the site the oracle exists for.
Body record and replay is implemented in **0014**; the estimate was roughly
right (~270 lines across the two new files) and it was worth paying.

The allow-list gate remains useful and orthogonal: it constrains what a run is
_permitted_ to request, where replay constrains what it _receives_.

### The relay bug, for the fourth time — now fixed mechanically

The gate silently did nothing on first test: `--sbxdiff-net-allow` was never
relayed to the renderer, and the code read it through a raw string literal
instead of a shared constant. That is RULES.md #13 a fourth time, in both of its
forms at once.

Fixed by making it impossible rather than remembering harder:
`::switches::kSbxdiffRendererSwitches` in `base/base_switches.h` lists every
renderer-read sbxdiff switch, and `render_process_host_impl.cc` iterates it.
Adding a switch to that array **is** the relay.

Worth noting how it was caught: the positive path looked perfect — 5 requests,
correct task attribution, clean realm separation — while the feature was
entirely inert. Only asserting the **negative** case (specific URLs must be
blocked) exposed it.

## 0013 — exception identity and time origin

`third_party/blink/renderer/platform/bindings/exception_state.cc`,
`third_party/blink/renderer/core/page/page.cc`,
`third_party/blink/renderer/core/timing/window_performance.cc`.

`kBindingCall` only carried a `threw` bool, so `TypeError` vs `RangeError` was
invisible — a sandbox could throw the wrong error type and the oracle would call
the runs identical. `ExceptionState` is hooked at the one place that sees the
exception's identity, and `kException` now carries Blink's `ExceptionCode`.

`performance.timeOrigin` retains roughly 1.7 ms of jitter. Diff _deltas_, not
absolute values; `Date.now()` is exact.

## 0014 — response body record and replay (P5, part 2)

`base/sbxdiff_net_store.{h,cc}` (new),
`chrome/browser/headless/sbxdiff_net_replay.{h,cc}` (new),
`third_party/blink/renderer/core/sbxdiff/sbxdiff_net_observer.{h,cc}` (new),
`chrome/browser/chrome_content_browser_client.cc`,
`third_party/blink/renderer/core/probe/core_probes.json5`,
`third_party/blink/renderer/core/frame/local_frame.{h,cc}`.

`--sbxdiff-net-record=<dir>` writes every response to disk;
`--sbxdiff-net-replay=<dir>` serves them back and never touches the network.

### Record and replay live in different processes, necessarily

Recording is **renderer-side**, on `probe::DidReceiveResourceResponse` /
`DidReceiveData` / `DidFinishLoading` — DevTools' own network taps, which is why
they see decoded bodies uniformly across navigation, subresources, XHR and
`fetch`. A non-CDP consumer registers through the `observers:` block in
`core_probes.json5`.

Replay is **browser-side**, a factory appended at
`ChromeContentBrowserClient::WillCreateURLLoaderFactory`. There is no choice: by
the time a request is visible to the renderer it has already been sent.

Hence the store lives in `base/` rather than blink — one definition both
processes link. The blink-side copy and the superseded
`CreateResourceForSbxdiffReplay` path in `ResourceFetcher` are gone.

### A miss is `ERR_BLOCKED_BY_CLIENT`, never a network fetch

Falling back to the network on a miss would make a real divergence look like a
clean run — precisely the bug class this tool exists to catch. The decoder
reports the blocked count so a miss is visible rather than silent.

### `MaybeCreateSbxdiffNetObserver()` was never called

It existed, compiled, and was correct — and nothing invoked it. Recording
silently fell back to an older buffer path that caught some subresources but
missed `fetch`/XHR and the navigation body. Every spot-check passed because the
fallback _worked_. Only counting store contents against what the page actually
requested exposed it. Wired into `LocalFrame::Init()`.

### Verification: load-success proves nothing

An earlier version passed "server is down and the page still loaded" while
silently bypassing to HTTP cache. The test that counts is tampering with a
stored body on disk and checking the page observes the edit — it does.

## Gating principle: gate behaviour changes, not bug fixes

Learned the hard way. When retro-gating the patches so a non-diff run behaves like
stock Chromium, I gated **both** 0002 (UA) and 0004 (CGWindowID) on the
`--sbxdiff-trace-out` switch. That broke the binary for every run _without_ the switch,
because 0004's DCHECK is fatal on headless macOS regardless of whether we are tracing:

```
rc=133  FATAL:components/remote_cocoa/browser/scoped_cg_window_id.cc:43]
        DCHECK failed: GetMap...
```

The distinction that matters:

| Patch                                         | Kind                                                                           | Gated?                         |
| --------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------ |
| 0002 — suppress the `HeadlessChrome` UA token | deliberate **behaviour change**                                                | **yes**, on the runtime switch |
| 0004 — skip CGWindowID registration for id 0  | plain **bug fix** (0 is not a valid CGWindowID)                                | **no**, unconditional          |
| 0001 — CommandLineTools toolchain             | build system                                                                   | n/a                            |
| 0003/0005/0006 — tracer + realm identity      | `BUILDFLAG(SBXDIFF)` + runtime switch                                          | yes                            |
| 0007 — keyed PRNG                             | runtime switch `--sbxdiff-run-key` only (`//base` cannot see Blink buildflags) | yes                            |
| 0008 — pinned initial virtual time            | runtime switch `--sbxdiff-initial-time` only                                   | yes                            |
| 0009 — web-crypto keystream                   | inert unless `--sbxdiff-run-key` is set                                        | yes                            |
| 0010 — early virtual time + fence             | inert unless `--sbxdiff-initial-time` is set                                   | yes                            |
| 0012 — net records + replay gate              | records need the tracer; gate inert unless `--sbxdiff-net-allow` is set        | yes                            |

Verified both directions after the fix:

| Run                        | UA                                 |
| -------------------------- | ---------------------------------- |
| no `--sbxdiff-trace-out`   | `HeadlessChrome/155.0.0.0` (stock) |
| with `--sbxdiff-trace-out` | `Chrome/155.0.0.0` (diff run)      |

### Why runtime switch, not `BUILDFLAG(SBXDIFF)`, for 0002

`BUILDFLAG(SBXDIFF)` comes from
`third_party/blink/renderer/platform/bindings/buildflags.h`, and **`components/` must
not include `third_party/blink/renderer/**`** — that is a layering violation `gn check`rejects.`third_party/blink/public/common/switches.h`*is* fair game for components, so`blink::switches::kSbxdiffTraceOut` is the portable gate. It also reads better: the UA
is only altered during an actual diff run.

Note that byte-identical stock-ness of this tree matters less than it first appears: the
`patched-vs-stock` comparison binary is a **downloaded official Chrome**, not a second
build from here.

## 0015 — deferred and coordinated virtual time

`base/base_switches.h`,
`third_party/blink/renderer/platform/scheduler/common/sbxdiff_virtual_time.{h,cc}` (new),
`third_party/blink/renderer/platform/scheduler/worker/worker_thread_scheduler.{h,cc}`,
`third_party/blink/renderer/core/page/page.cc`,
`third_party/blink/renderer/bindings/core/v8/local_window_proxy.cc`.

Virtual time as shipped in 0008/0010 cannot be used on a sandbox. Two separate
problems, two switches.

### `--sbxdiff-virtual-time-after=<url-substr>`

Enabling virtual time in `Page`'s constructor breaks the sandbox's own
bootstrap: measured on the scramjet harness, `kDeterministicLoading` never
activates the service worker at all and `kAdvance` activates it three times,
while the guest realm gets 2 records instead of 1746. This defers the enable to
the realm whose document URL matches, so setup runs on the real clock. Both
sides enable at their own guest realm, so the runs stay symmetric.

### `--sbxdiff-virtual-time-policy=<p>`

`deterministic` (default), `advance`, `pause`. The default is right for a plain
page and wrong for a sandbox, so it had to become selectable.

### The worker joins the page's clock

`ProcessTimeOverrideCoordinator` installs `ScopedTimeClockOverrides`, which is
**process-wide**. Enabling virtual time on the page therefore freezes a service
worker's clock too, while leaving the worker unable to advance it — only
registered clients can. The page waits for a load the worker must produce, and
the worker cannot get there.

The coordinator is documented for precisely this ("thread scheduler for
different workers and the main thread") and advances to the minimum requested
across clients; `WorkerThreadScheduler` already overrides the virtual-time
hooks. The only missing piece was the call.

`MaybeJoinSbxdiffVirtualTime` is lazy and one-way, from `OnTaskCompleted`. Not
at startup: the coordinator's first client fixes the clock origin, and a worker
registering during its own bootstrap reintroduces the bug above.

It grants **no** budget. `kAdvance` sets an empty fence deliberately; a budget
would put one back, and an exhausted worker stops requesting advancement, which
pins the page as well (RULES.md #12).

### Why the helpers live in the scheduler

`platform/scheduler/DEPS` forbids `platform/` outside a small allow-list. The
switch helpers were in `sbx_tracer.h` by accident — they are scheduler
concerns and touch no bindings — so they moved rather than the DEPS gaining an
exception for a tracer header.

### Pausing stops the clock, not the queues

`MainThreadSchedulerImpl::OnVirtualTimePaused` normally fences the frame's task
queues. That is safe only because loads complete in the network process. A
sandbox's load is served by a service worker that delegates back to the client
_page_, so fencing the page stops the work that would release the pause — the
load waits on the clock and the clock waits on the load.

With a deferred clock, pausing now stops the clock and leaves the queues alone.
Determinism still comes from the frozen clock, and tasks running while it is
frozen is already normal for every queue whose `CanRunWhenVirtualTimePaused` is
true, loading queues included.

### Status: working

`Date.now()` in the sandbox is reproducible to ~1 ms (`1700000000019` in four of
five runs) with timer deltas exact, from 60–110 s of drift before. The diff
result is identical with and without virtual time, so the harness turns it on by
default.

Use `deterministic`. `advance` converts every idle moment into a clock jump:
measured 54/60/54/80 s of drift, and it slipped an exact 250 ms timer to 249.

## 0016 — browser-side recording, store v2, and redirect replay

`base/sbxdiff_net_store.{h,cc}`,
`chrome/browser/headless/sbxdiff_net_replay.cc`,
`chrome/browser/headless/BUILD.gn`,
`third_party/blink/renderer/core/sbxdiff/sbxdiff_net_observer.cc`,
`third_party/blink/renderer/core/frame/local_frame.cc`.

What 0014 built worked on ordinary pages and failed completely on
rateyourmusic.com, which sits behind a Cloudflare managed challenge. Three
separate defects, each of which alone was enough to stop the challenge passing.

### Recording moved from the renderer to the browser

A cross-origin response without CORS is **opaque**: the renderer never receives
its bytes, so a Blink probe has nothing to record. Measured on rateyourmusic, 20
of 78 requested URLs never reached the store — every web font, a no-cors
analytics beacon, and two Cloudflare challenge endpoints among them. A replay
then blocks requests the recording had no trouble with.

`RecordingClient` sits between the network service and the renderer as a
`URLLoaderClient`, buffers the body, and forwards it on completion. Not with
`mojo::MakeSelfOwnedReceiver`: that destroys on pipe disconnect, and the network
service closes its end as soon as it has sent `OnComplete` — while the drainer is
still reading. The response then never arrives and the page simply does not load.
Explicit `mojo::Receiver` plus `DeleteSoon`.

`MaybeCreateSbxdiffNetObserver()` is commented out at its `LocalFrame` call site
as a consequence; running both recorders double-writes every response, and the
dedupe is per-process so it cannot see across them.

### v2 store format: headers are content

```
"SBXD2\n" url "\n" mime "\n" encoding "\n" <header_bytes> "\n" <raw_headers> <body>
```

`raw_headers` is `net::HttpResponseHeaders::raw_headers()` verbatim — a
NUL-separated status line and field list, hence the explicit length. Files
without the magic still read as the old `url \n mime \n encoding \n body`.

The reason is concrete. Cloudflare answers the first navigation with
`Critical-CH`, so Chromium **restarts the navigation** to resend client hints.
The store therefore holds two different challenge instances at `/` (rays
`…8eb896…` and `…8ed89a…`) and only the second one's `orchestrate`/`fo` endpoints
were ever fetched. A replay serving bodies under a synthetic `200 OK` never
restarts, hands the page the abandoned challenge, and every endpoint it asks for
misses. `head->parsed_headers` is populated with `network::PopulateParsedHeaders`
because the restart is driven off it, not off the raw headers.

### Redirects are recorded, and replayed as redirects

`OnReceiveRedirect` used to just re-key and follow. It now writes a record for
the URL that produced the 3xx, with its headers and an empty body. `ReplayLoader`
is stateful: a stored 3xx becomes a real
`OnReceiveRedirect(net::RedirectInfo::ComputeRedirectInfo(...), head)` and the
client has to come back through `FollowRedirect()`, at which point the next
recording — keyed by the **new** URL — is what it gets.

Flattening the chain loses the URL the page ends up at, and that URL is content:
Cloudflare bounces `/` to `/?__cf_chl_rt_tk=<token>` and the challenge script
reads the token out of `location`.

### Two keying bugs

`StripPerAttemptParams` removed `__cf_chl_tk`/`__cf_chl_rt_tk` from store keys,
on the theory that a token minted during recording could never be asked for
again. The token is minted by the **server** and lives in the recorded challenge
HTML, so a replay of those exact bytes asks for exactly the same URL — and the
stripping collapsed four distinct steps onto one key, scrambling the ordinals
that separate them. Removed; URLs are keyed whole.

The replay ordinal counter was a `std::map` on `ReplayFactory`.
`WillCreateURLLoaderFactory` runs once per factory and the Critical-CH restart
gets a fresh one, so the counter reset to 0 and re-served ordinal 0 — defeating
ordinals in the one case they exist for. Moved to a process-global counter
(`LookupNextResponse`).

### Result

```
oracle: 17 file(s), 394330 records, 8505ms      0 replay misses
store:  95 responses / 87 URLs
403:5899, 403:6091, 200:402579   https://rateyourmusic.com/
301→//cdn.sonemic.net/…          https://rateyourmusic.com/favicon.ico
302→/cdn-cgi/challenge-platform/h/g/scripts/jsd/330e41bb475c/main.js?
```

The traces contain `Welcome! - Rate Your Music` and the real page's `bundle.js`:
the replay passes the challenge. Needs `--vt-fence --vt-budget 600000`; the
default 30 s budget runs out mid-challenge.

## 0017 — clicking a frame that has no widget of its own

`chrome/browser/headless/sbxdiff_runner.cc`.

`--sbxdiff-click-frame` matched a frame by URL and clicked
`rfh->GetView()->GetRenderWidgetHost()` at the given coordinates. That is right
only for an out-of-process frame. `RenderFrameHost::GetView()` returns the
**root** view for a subframe that shares its parent's process, so the click
landed at (22,32) of the top-level page instead of inside the frame.

That is not a corner case for this tool, it is the norm on one side of every
diff: the oracle sees Cloudflare's Turnstile widget cross-origin and therefore
out-of-process, with a widget of its own, while a proxy serves every frame from
a single origin and the widget shares its parent's process. Measured on
rateyourmusic, the oracle's widget realm received `MouseEvent`s and the
sandbox's received none — so the sandbox ran the entire challenge and looped
forever waiting for a click.

When the matched frame's view IS the root, the runner now asks the frame where
it is and clicks in root coordinates:

```js
(() => {
	let x = 0,
		y = 0,
		w = window,
		e = w.frameElement;
	while (e) {
		const b = e.getBoundingClientRect();
		x += b.x;
		y += b.y;
		w = e.ownerDocument.defaultView;
		e = w.frameElement;
	}
	return x + "," + y;
})();
```

run via `ExecuteJavaScriptInIsolatedWorld` in `ISOLATED_WORLD_ID_CHROME_INTERNAL`.
An isolated world shares the DOM but not the prototypes, so a page that has
replaced `Element.prototype.getBoundingClientRect` — which an anti-bot script
plausibly has — cannot observe the question being asked.
