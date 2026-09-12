# Pinned assumptions

Facts that are true at Chromium **155.0.8051.0** / V8 **15.5.28** and that a Chromium
roll, an OS update, or an Xcode/CLT update could invalidate **silently**. Re-check every
item before rolling. Each entry says how to check it.

---

## 1. macOS SDK must be 26.5, not 27.0

SDK 27.0's `usr/lib/libSystem.tbd` declares extra targets:

```
26.5: targets: [ x86_64-macos, x86_64-maccatalyst, arm64e-macos, arm64e-maccatalyst ]
27.0: targets: [ ..., arm64e.x1-macos, arm64e.x1-maccatalyst ]
```

Chromium 155's bundled lld (clang 24) cannot parse the `arm64e.x1-*` form:

```
ld64.lld: error: could not load TAPI file at .../MacOSX27.0.sdk/usr/lib/libSystem.tbd:
  malformed file
libSystem.tbd:4:20: error: unknown target
                   arm64e.x1-macos, arm64e.x1-maccatalyst ]
```

Every link fails, so this surfaces as `-lSystem` producing undefined `strlen` /
`getenv` / `posix_memalign` — which looks like a sysroot misconfiguration rather than a
parser limitation. Don't be misled; it also is _not_ an availability/`-Wunguarded-availability`
problem, and the two SDKs' `tbd-version` are both 4.

**Danger:** CLT's `SDKs/MacOSX.sdk` symlink follows the _newest_ installed SDK, so a CLT
update silently repoints it. Our patched `sdk_info.py` defends against this by resolving
`mac_sdk_official_version` from `mac_sdk.gni`; `args.gn` pins `mac_sdk_min` to match.

**Check:**

```sh
sed -n '2,6p' /Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk/usr/lib/libSystem.tbd
grep mac_sdk_official_version src/build/config/mac/mac_sdk.gni
readlink -f src/out/sbx/sdk/xcode_links/MacOSX*.sdk   # must be MacOSX26.5.sdk
```

A newer bundled clang may fix this; retest with 27.0 after a roll and drop the pin if
a trivial `-lSystem` link succeeds.

## 2. `MacOSX26.0.sdk` in CLT is a stub

It contains only `System/` and `usr/` — no `SDKSettings.plist`. `find_sdk.py` picks the
_lowest_ SDK >= `mac_sdk_min`, so a low `mac_sdk_min` selects this broken SDK. Another
reason `mac_sdk_min` is pinned at 26.5.

**Check:** `ls /Library/Developer/CommandLineTools/SDKs/MacOSX26.0.sdk`

## 3. WITHDRAWN — private-symbol tagging is no longer used

This pinned the V8 flag that let a `v8::Private` be written onto a frozen object
(`js_nonextensible_applies_to_private`, default `false`,
`v8/src/flags/flag-definitions.h`), because object identity tagged page objects that
way.

**It no longer matters, for a better reason than the flag.** Writing _any_ property to
a page object — private symbol or not — forces a hidden-class transition and can
deoptimise the page's own inline caches. That is guest-observable without ever seeing
the property, and it made Cloudflare Turnstile loop forever. Identity now comes from
the `ScriptWrappable` behind a DOM wrapper, which is read-only and free.

Kept as a withdrawn entry rather than deleted: the tempting reasoning ("private symbols
are invisible to reflection, verified") was _correct and still wrong_. See RULES.md #22.

## 4. `bind_gen` has exactly two generated-callback chokepoints

Plan §P2 instruments `_make_empty_callback_def`
(`third_party/blink/renderer/bindings/scripts/bind_gen/interface.py:1815`) and
`_make_interceptor_callback_def` (`:2713`). If a roll adds a third way to emit a V8
entry point, coverage silently develops a hole.

**Check:** after a roll, confirm every `v8_callback_type` in `interface.py` still routes
through one of those two, and that the `make_cross_origin_*` family still calls
`_make_interceptor_callback_def` directly with `class_name=None`.

## 5. `internals` is testonly and unusable from `chrome`

`third_party/blink/renderer/core/BUILD.gn:533` declares
`source_set("testing") { testonly = true }`, with `internals.cc/.h` inside it. Only
`content_shell` and unit tests link it — hence the separate non-testonly
`core/sbxdiff/` interface in plan §P6. If a roll makes `internals` generally available,
that interface could be simplified away.

## 6. Nothing in `chrome/` uses `compile_xcassets`

This is what makes a CommandLineTools-only build possible (no `actool`). Note
`chrome/app/theme/chromium/mac/Assets.xcassets` _exists on disk_ but is referenced only
from comments in `build/config/apple/mobile_bundle_data.gni`.

**Check:** `grep -rn "compile_xcassets\|bundle_data_xcassets" chrome/ --include="*.gn" --include="*.gni"`

## 7. `switches::kHeadless` is not propagated to the renderer

This is what keeps `navigator.webdriver === false` without any patch.
`content/browser/renderer_host/render_process_host_impl.cc`'s `kSwitchNames` allowlist
contains `kEnableAutomation` and `kRemoteDebuggingPipe` but **not** `kHeadless`, so
`content/child/runtime_features.cc:344`'s
`{EnableAutomationControlled, kHeadless, true}` entry never fires in the renderer.

**If a roll adds `kHeadless` to `kSwitchNames`, `navigator.webdriver` silently flips to
`true`** and the plan's withdrawn P8 patch becomes necessary again.

**Check:** the direct measurement, which is cheaper than reading the allowlist:

```sh
UDD=$(mktemp -d); src/out/sbx/Chromium.app/Contents/MacOS/Chromium \
  --headless=new --no-sandbox --user-data-dir=$UDD --dump-dom \
  'data:text/html,<body><script>document.body.textContent=String(navigator.webdriver)</script>'
```

Must print `false`.

## 8. WebGL requires `--enable-unsafe-swiftshader`

With `angle_enable_metal = false` the GPU process exits during init, so WebGL is
**absent** rather than software-backed unless that flag is passed. If a roll renames or
removes it, `getContext('webgl')` starts returning `null` and every WebGL-touching site
produces spurious divergences.

**Check:** `!!document.createElement('canvas').getContext('webgl')` must be `true` with
the standard flag set in `FLAGS.md`.

## 9. `-j8` kernel-panics this machine; use `-j4`

**2026-09-10: a full build at `-j8` panicked the kernel.**

```
panic(cpu 0): userspace watchdog timeout: no successful checkins from
              WindowServer (2 induced crashes) in 122 seconds
```

Not a hardware fault — resource starvation. 16 GiB RAM, and Blink core TUs peak over
1.5 GiB each in clang, so 8 concurrent compiles is ~12 GiB before the OS, the UI and
anything else. The machine swap-thrashed, WindowServer missed its watchdog check-ins
for 122 s, and the kernel panicked. The build that triggered it was also regenerating
all bindings, which adds many concurrent Python processes on top of the compiles.

**Use `nice -n 5 autoninja -C out/sbx -j4 chrome`.** ~6 GiB peak, and the `nice` keeps
the UI responsive. Roughly doubles wall time versus `-j8`, which is a trade worth making
— a panic costs an entire build _and_ leaves stale `.siso_lock` / `.siso_port` files
that must be removed before the next run.

The plan already said "use `-j8`, not `-j10` — swapping costs more than the two lost
cores." That reasoning was right and the number was still too high. If
`blink_symbol_level = 1` is ever combined with a higher `-j`, expect this again: debug
info generation is a large part of the per-TU memory peak.

**Check:** `sysctl -n hw.memsize` and `hw.ncpu`. The binding constraint is RAM, not
cores — this machine has 10 cores but only enough memory for 4 concurrent Blink
compiles.

**Check after any panic or hard reboot:** `git status --short` in `src/` (patches
survive; they are ordinary working-tree edits), whether `out/sbx/gen/.../v8_element.cc`
still contains what you expect, `rm -f out/sbx/.siso_lock out/sbx/.siso_port`, and kill
any orphaned `clang` processes.

very after a panic:\*\* the checkout survives (git-tracked patches and untracked
files both intact), but clear `out/sbx/.siso_lock` and `out/sbx/.siso_port` before
rebuilding, and kill orphaned `clang` processes.

## 10. A run produces one trace file per process — never select by size

`--sbxdiff-trace-out=DIR` yields `trace.<pid>.<n>.sbxd` per process/thread. The page
under test frequently runs in a **different, smaller-file** renderer than the
`about:blank`/dump-dom infrastructure process. Reading the largest file is
indistinguishable from missing instrumentation, and cost several wrong diagnoses
(dead-code elimination, JIT tiering, lost buffer tail — all wrong).

**Check:** decode every file, not one. `sbxread.py` accepts a directory and decodes each
file separately. Until plan P6's realm/document attribution lands, identify the page's
file by looking for its expected call counts, not by size.

## 11. `--disable-site-isolation-trials` must not be used

Breaks Cloudflare Turnstile's auto-pass (measured on rateyourmusic.com,
2026-09-11). Not required for the guest iframe to share a renderer — the
`--disable-features=site-per-process,IsolateOrigins` set provides that.

Check: run a Turnstile-protected site headed, with and without the switch, and
confirm the challenge completes. A `--dump-dom` at load time is **not** a valid
check: it captures the interstitial before the auto-pass.

## 12. The snapshot Chromium used as the A/B control has DCHECKs OFF

`build/config/dcheck_always_on.gni` defaults
`dcheck_always_on = (build_with_chromium && !is_official_build)`, so a
non-official build gets DCHECKs **on** unless overridden — which is why our
build had them. The download-chromium.appspot.com snapshot (155.0.8054.0)
overrides it to off. Verified four ways:

- the DCHECK condition string `current_process_commandline_` is **absent** from
  the stock framework and present in ours;
- stock contains the strings "Build with DCHECKs enabled to see information
  here" and "Run a build with DCHECK on to get more details", which are what
  Chromium shows when DCHECKs are off;
- runtime: 0 `DCHECK failed` lines from stock, 2 from ours on the same page;
- size: 254 MB vs 590 MB.

Check: `strings -a "<framework>" | grep -c current_process_commandline_` — 0
means DCHECKs are compiled out.

Why it matters: any performance comparison against this binary is only fair
with `dcheck_always_on = false` on our side. The measured 8x DOM-binding gap
(38.4ms vs 4.9ms for 20k setAttribute/getAttribute pairs, with pure JS _not_
slower) was measured against a DCHECK-free control.

## 13. Browser-side replay hooks: `WillCreateURLLoaderFactory` + `URLLoaderFactoryBuilder`

Replay splices a `network::mojom::URLLoaderFactory` in at
`ChromeContentBrowserClient::WillCreateURLLoaderFactory` via
`network::URLLoaderFactoryBuilder::Append()`. Both the override signature and the
builder API have churned across recent milestones — `WillCreateURLLoaderFactory` has
gained and lost parameters more than once — and `URLLoader::FollowRedirect` now takes
`network::HttpRequestHeadersUpdateParams`.

A roll breaks these **loudly** (compile error), unlike most entries here. The risk is
not silence, it is that the natural fix is to drop the interception and not notice the
oracle went non-hermetic.

**Check:** `grep -n "WillCreateURLLoaderFactory" src/content/public/browser/content_browser_client.h`
and `grep -n "Append" src/services/network/public/cpp/url_loader_factory_builder.h`

## 14. Renderer-side recording rides the DevTools probes

`sbxdiff_net_observer` registers through the `observers:` block in
`third_party/blink/renderer/core/probe/core_probes.json5` — the mechanism for
non-CDP probe consumers — and implements `DidReceiveResourceResponse`,
`DidReceiveData` and `DidFinishLoading`.

If a roll renames those probes or reworks the `observers:` mechanism, recording goes
**silent, not broken**: the store simply stops filling. That is the failure mode this
project has already hit once, from a different cause (`MaybeCreateSbxdiffNetObserver()`
existed but was never called).

**Check:** after any roll, record a page and assert the store's entry count equals the
`kNetRequest` count in the trace. Never spot-check a single URL.
