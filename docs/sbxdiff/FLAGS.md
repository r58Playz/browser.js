# Runtime flags

The canonical command line for running the patched binary, and **why each flag is
there**. Every value below was verified empirically against the M0 build, not copied
from the plan — three of the plan's recommendations turned out to be wrong or
unnecessary (noted inline).

Binary: `src/out/sbx/Chromium.app/Contents/MacOS/Chromium` (Chromium 155.0.8051.0).

---

## The standard set

```sh
CHROME=src/out/sbx/Chromium.app/Contents/MacOS/Chromium
UDD=$(mktemp -d)

"$CHROME" \
  --headless=new \
  --no-sandbox \
  --user-data-dir="$UDD" \
  --use-mock-keychain \
  --no-first-run \
  --no-default-browser-check \
  --enable-unsafe-swiftshader \
  --screen-info="{0,0 3024x1964 colorDepth=30 devicePixelRatio=2 isInternal=true label='Built-in Retina Display' workAreaTop=38}" \
  --window-size=1512,944 \
  --disable-features=site-per-process,IsolateOrigins,IsolateSandboxedIframes,BackgroundResourceFetch \
  --num-raster-threads=1 \
  --enable-begin-frame-control \
  --run-all-compositor-stages-before-draw \
  --disable-new-content-rendering-timeout \
  --disable-image-animation-resync \
  --disable-threaded-animation \
  --disable-checker-imaging \
  --force-color-profile=srgb \
  --js-flags='--random-seed=1337 --hash-seed=1337 --rehash-snapshot --single-threaded-gc --no-concurrent-recompilation --predictable-gc-schedule --no-flush-bytecode --no-lazy-feedback-allocation --no-turbo-fast-api-calls' \
  --lang=en-US \
  <url>
```

with `TZ=America/Los_Angeles` in the environment (pinned, but a _plausible_ zone — UTC
alongside a Mac UA is itself an oddity).

## Why each group

| Flag(s)                                              | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--headless=new`                                     | the real browser layer, so `window.chrome`, `navigator.plugins` and the PDF mime exist. Not `headless_shell`.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--no-sandbox`                                       | the macOS renderer sandbox denies `open()` for writes, and the tracer writes a file. Invisible to page JS. Replaceable later by FD-passing (plan P1, deferred).                                                                                                                                                                                                                                                                                                                                                                                   |
| `--user-data-dir`                                    | **required**, not optional: without it (or `--incognito`) `headless_mode_init.cc:66-70` force-appends `--incognito`, which changes storage quotas, `navigator.storage.estimate()` and cookie persistence.                                                                                                                                                                                                                                                                                                                                         |
| `--use-mock-keychain`                                | no keychain prompts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `--no-first-run`, `--no-default-browser-check`       | a fresh `--user-data-dir` otherwise opens the first-run/OOBE window ("the browser that gets more done"). Harmless headless, but it is an extra window and an extra realm in a headed run.                                                                                                                                                                                                                                                                                                                                                         |
| `--enable-unsafe-swiftshader`                        | **see below — without this WebGL is entirely absent.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `--screen-info`, `--window-size`                     | `--headless` selects `ScreenMacHeadless`, whose defaults are `800x600 colorDepth=24 dpr=1`. See the units note below.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `--disable-features=site-per-process,IsolateOrigins` | the guest iframe must share a renderer with the host. **Not** `--single-process` (see `DECISIONS.md` P-10).                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ~~`--disable-site-isolation-trials`~~                | **REMOVED — breaks real sites.** It stops rateyourmusic.com's Cloudflare Turnstile challenge from auto-passing; without it the same page passes. Measured directly by the user on a clean-IP Linux box, bisected to this one switch (the `--disable-features` set above is fine). It was never load-bearing: with only the `--disable-features` set, the Turnstile iframe still shares the page's renderer — observed as realm `r159` sitting in the _same_ trace file as the page's `r1`. So this switch cost us a real site and bought nothing. |
| `BackgroundResourceFetch` disable                    | otherwise `URLLoaderThrottleProvider::CreateThrottles` runs on a background thread and races the network replay gate.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| compositor/animation group                           | lifted verbatim from `--deterministic-mode`'s own bundle in `headless/lib/browser/command_line_handler.cc:36-53`.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `--num-raster-threads=1`                             | one raster thread, for ordering determinism.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `--js-flags`                                         | see `DETERMINISM.md` §4. `--no-turbo-fast-api-calls` is a _coverage_ requirement too: it stops TurboFan emitting the fast path that bypasses the traced generated callback.                                                                                                                                                                                                                                                                                                                                                                       |

## Never pass these

They set `EnableAutomationControlled`, which makes `navigator.webdriver` return `true`:

- `--enable-automation`
- `--remote-debugging-pipe`
- `--remote-debugging-port=0` — note **specifically** port 0. A concrete port does not
  trip it (`runtime_features.cc:386-398`); ChromeDriver's default ephemeral-port launch
  is what that check targets.

Also avoid `--enable-precise-memory-info` (changes `performance.memory` granularity) and
`--disable-gpu` (unnecessary; see below).

---

## Three corrections to the plan, measured

### 1. `navigator.webdriver` needs no patch — it is already `false`

The plan called deleting the `{EnableAutomationControlled, kHeadless, true}` mapping at
`runtime_features.cc:344` the single highest-value fingerprint fix. **It is unnecessary.**
Measured `navigator.webdriver === false` under both `--headless` and `--headless=new`.

Mechanism: `runtime_features.cc` runs in the **renderer**, and `switches::kHeadless` is
**not** in `kSwitchNames`, the browser-to-renderer switch allowlist
(`content/browser/renderer_host/render_process_host_impl.cc:3855-4046` — it lists
`kEnableAutomation` and `kRemoteDebuggingPipe` but not `kHeadless`). So the renderer
never learns it is headless and that mapping is dead code there.

The actionable rule is therefore the "never pass these" list above, not a patch.

### 2. `--screen-info` bounds are physical pixels; `screen.width` reports CSS pixels

The plan's `1512x982 devicePixelRatio=2` yields `screen.width === 756`, i.e. bounds/dpr.
To present as a 14" MacBook Pro (`screen.width === 1512`, dpr 2) the bounds must be
**3024x1964**. Measured:

| `--screen-info`                      | `screen.width x height` |
| ------------------------------------ | ----------------------- |
| `{0,0 1512x982 devicePixelRatio=2}`  | 756x491                 |
| `{0,0 3024x1964 devicePixelRatio=2}` | **1512x982**            |

### 3. `--screen-info` labels must use SINGLE quotes

`TrimAndUnescape` in `components/headless/screen_info/headless_screen_info.cc:51` only
strips `'`. A double-quoted label with spaces makes the parser split on whitespace and
**CHECK-fail the browser**:

```
FATAL:ui/display/mac/screen_mac_headless.mm:38] Check failed:
  screen_infos_or_error.has_value(). Invalid screen info: Retina Display" workAreaTop=38
```

So quote the whole switch value with shell double quotes and the label with single
quotes, as in the standard set above.

### 4. WebGL is absent by default, not SwiftShader-backed

With `angle_enable_metal = false` the GPU process fails outright:

```
ERROR:ui/gl/gl_display.cc:648] Initialization of all (0) EGL display types failed.
ERROR:components/viz/service/main/viz_main_impl.cc:192] Exiting GPU process due to
  errors during initialization
```

Measured `!!canvas.getContext('webgl')`:

| flags                         | WebGL     |
| ----------------------------- | --------- |
| default                       | **false** |
| `--enable-unsafe-swiftshader` | **true**  |

So `--enable-unsafe-swiftshader` is mandatory, not optional. Without it a site calling
`getContext('webgl')` gets `null` — a much larger behavioural gap than "SwiftShader
instead of Metal", and it would have shown up as a pile of spurious divergences.

Note the forced `--use-angle=swiftshader-for-webgl` in
`chrome/browser/headless/headless_mode_init.cc:95-114` is inside `#if BUILDFLAG(IS_LINUX)`
and does **not** apply here, which is why the flag has to be passed explicitly.

## The sbxdiff switches

| Switch                               | Effect                                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--sbxdiff-trace-out=<dir>`          | Enables the binding tracer and writes `trace.<pid>.<n>.sbxd` into `<dir>`. Absent = tracer fully inert (`sbx_tracer.cc` sets `g_enabled` from this switch alone). Defined in `blink::switches`.                                                                                                                    |
| `--sbxdiff-run-key=<string>`         | Enables the deterministic PRNG in `base/rand_util_posix.cc`. **Any string**; it is SHA-256'd into the ChaCha20 key, together with the process type and renderer client id so sibling processes get distinct streams. Absent = real OS entropy. Defined in `base::switches`, because `//base` cannot include Blink. |
| `--sbxdiff-initial-time=<unix_ms>`   | Pins the clock origin and enables virtual time in `Page`'s constructor, before any page script runs. Makes `Date.now()` **exact** across runs. Must be paired with the budget switch below.                                                                                                                        |
| `--sbxdiff-virtual-time-budget=<ms>` | Fence for how far virtual time may advance (default 2000). Without it an idle scheduler fast-forwards to far-future startup timers — ~97 minutes accrued, varying per run. Timers scheduled beyond the fence will not fire, same as the stock `--virtual-time-budget`.                                             |

| `--sbxdiff-virtual-time-policy=<p>` | `deterministic` (default), `advance`, or `pause`. Use the default. `advance` converts every idle moment into a clock jump — measured 54/60/54/80 s of drift between runs, and it slipped an exact 250 ms timer to 249. |
| `--sbxdiff-virtual-time-after=<url-substr>` | Defer enabling virtual time until a realm whose document URL contains this, instead of enabling it in `Page`'s constructor. **Required for a sandbox**: virtual time during the proxy's own bootstrap breaks service-worker registration — `deterministic` never activates the worker and `advance` activates it three times while the guest realm gets 2 records instead of 1746. Setup runs on the real clock, the page under test on virtual time; both sides enable at their own guest realm, so the runs stay symmetric. |
| `--sbxdiff-net-record=<dir>` | Writes every response body the renderer receives into `<dir>`, via the DevTools network probes. |
| `--sbxdiff-net-replay=<dir>` | Serves responses from `<dir>` and **never** touches the network. A URL with no stored body gets `net::ERR_BLOCKED_BY_CLIENT` — a divergence, not a fallback (RULES.md #14). Browser-side, at `WillCreateURLLoaderFactory`. |
| `--sbxdiff-net-allow=<file>` | Newline-separated URLs the request gate permits; anything else is recorded as blocked and refused. Orthogonal to replay: this constrains what a run may _ask for_, replay constrains what it _receives_. Absent = gate inert. |
| `--sbxdiff-debug-disable=<mask>` | Bisection aid: disables parts of the tracer. 1=binding calls, 2=interceptors, 4=object ids, 8=DOM encode, 16=scope work, 32=trace file to `/dev/null`, 64=pending realm. |
| `--sbxdiff-run[=<grace_ms>]` | **Browser-only.** The in-binary run driver; quits once the page stops loading plus the grace (default 1000), restarting the grace on each navigation, capped at 10×. Use this instead of `--dump-dom` / `--virtual-time-budget`. |
| `--sbxdiff-click=<x>,<y>[,<delay>[,<repeat>[,<interval>]]]` | **Browser-only.** Trusted left click via `RenderWidgetHost::ForwardMouseEvent` — `isTrusted` is true, no DevTools session. |
| `--sbxdiff-click-frame=<url-substr>` | **Browser-only.** Sends the click to that frame's own widget, coordinates relative to it. Required for child frames: `ForwardMouseEvent` is not hit-tested into them and the input router is not in content/public. |
| `--sbxdiff-shots=<dir>[,<interval_ms>]` | **Browser-only.** Periodic viewport capture via `CopyFromSurface`. Capture pixels are viewport pixels 1:1. |

### Environment variables

Not switches, because they are read from places that cannot see the command
line, or turned on for a single run without touching the renderer relay.

| Variable                | Effect                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SBXDIFF_RAND_KEY`      | Pins BoringSSL's `CRYPTO_sysrand`. Separate from `--sbxdiff-run-key` because BoringSSL cannot depend on `//base` and so cannot read a switch. Without it, WebCrypto key generation and RSA-OAEP padding stay random with `//base`'s PRNG fully pinned (RULES.md #74).                                                                       |
| `SBXDIFF_BODY_DUMP_DIR` | Writes every request body the oracle sends into `<dir>`, one file per `bodyFileStem(url, ordinal)` — the same key the sandbox's beacon uses, so the two sides pair up and a divergence can be byte-diffed rather than counted (RULES.md #78). The harness sets it per side.                                                                 |
| `SBXDIFF_LOG_VT`        | Logs every virtual-clock advance as microseconds from the instant virtual time was enabled. Two runs' logs diff directly, which is what says WHERE the clocks part rather than that they do.                                                                                                                                                |
| `SBXDIFF_VT_QUANTUM_US` | Snaps each virtual-clock advance up to the next multiple of `n` µs from that same instant. The clock does not only advance to times the page asked for: wake-ups already scheduled when virtual time was enabled carry REAL-clock times at an arbitrary sub-millisecond offset, different every run, and everything downstream inherits it. |
| `SBXDIFF_VERBOSE`       | Adds `--v=1` to the spawned Chromium. Request-body logging is **not** behind this — it was, and that manufactured seven false "(none sent)" divergences.                                                                                                                                                                                    |

### The relay is load-bearing and fails silently

Renderer-read switches are relayed by `render_process_host_impl.cc` iterating
`::switches::kSbxdiffRendererSwitches` in `base/base_switches.h`. **Adding a
switch to that array is the relay.**

A switch the browser accepts but never forwards produces a run with no trace
file and no error. That happened **five** times in this project; the fifth
(`--sbxdiff-debug-disable`, read through a raw string literal _and_ missing from
the array) silently ran every `mask=N` measurement at mask 0, invalidating a
performance attribution and a crash bisect. Hence the array, and hence: never
read an sbxdiff switch through a literal.

The browser-only switches above are deliberately **excluded** — relaying them
would be harmless but meaningless.

`--virtual-time-budget=<ms>` is honoured **only** by the headless command
handler, so it needs one of `--dump-dom` / `--screenshot` / `--print-to-pdf`;
it silently does nothing otherwise. It also injects a `chrome://headless/`
realm that drives the run over CDP, which is why traces contain that realm.

**Known bug:** with tracing enabled, a `file://` page whose `new Worker()` is
blocked by file-access policy never completes (5/5). Serve test pages over HTTP
(`python3 -m http.server`) — `file://` workers are blocked anyway. See
`PROGRESS.md` M4 part 3.

`--sbxdiff-trace-out` also currently implies the stock (non-"Headless") user
agent, so a traced run is not self-identifying to the page; see
`CHROMIUM-PATCHES.md` 0002.

A traced run needs `--no-sandbox` (the tracer writes a file). Use
`--sbxdiff-run` to let async work finish before teardown — **not**
`--virtual-time-budget`, which needs a headless command handler, injects a
`chrome://headless/` CDP realm into your traces, and is page-observable.

## Benign stderr noise

Expected and safe to ignore:

- `code_sign_clone_manager.mm:98] error removing quarantine attribute`
- `CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670` (headless, no display link)
- the EGL / GPU-process errors above, once `--enable-unsafe-swiftshader` is in use
- `FATAL:base/command_line.cc:309] DCHECK failed: current_process_commandline_`,
  exactly twice per run. Crashpad-handler noise in this `dcheck_always_on`
  build; measured at 2 occurrences with _no_ sbxdiff switches, so it is not
  caused by the patches.
