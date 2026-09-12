# Integrating the tracer with the scramjet harness

What the patched Chromium gives you, what is guaranteed, and what is not. Read
this before writing the differ.

## Running

```sh
CHROME=src/out/sbx/Chromium.app/Contents/MacOS/Chromium
OUT=$(mktemp -d)

TZ=America/Los_Angeles "$CHROME" \
  --headless=new --no-sandbox --user-data-dir="$(mktemp -d)" \
  --use-mock-keychain --enable-unsafe-swiftshader --window-size=1512,944 \
  --no-first-run --no-default-browser-check \
  --disable-features=site-per-process,IsolateOrigins,IsolateSandboxedIframes,BackgroundResourceFetch \
  --num-raster-threads=1 --force-color-profile=srgb --lang=en-US \
  --js-flags='--random-seed=1337 --hash-seed=1337 --no-turbo-fast-api-calls' \
  --sbxdiff-run-key=<any-string> \
  --sbxdiff-trace-out="$OUT" \
  --sbxdiff-initial-time=1700000000000 \
  --sbxdiff-virtual-time-budget=2000 \
  --sbxdiff-run=1500 \
  <url>
```

`--sbxdiff-run` is the in-binary driver: no `--dump-dom`, no
`--virtual-time-budget`, no CDP, no `chrome://headless/` page. It quits on its
own once the page stops loading plus the grace period. The **trace files are the
output**; nothing goes to stdout.

Both sides of a diff must use the **same `--sbxdiff-run-key`**. Any string
works; it is SHA-256'd into the PRNG key.

## Do not pass `--disable-site-isolation-trials`

It breaks Cloudflare Turnstile's auto-pass on real sites (measured on
rateyourmusic.com). Keep
`--disable-features=site-per-process,IsolateOrigins,IsolateSandboxedIframes,BackgroundResourceFetch`
— that is what makes a cross-origin iframe share the page's renderer, and it
does not break the challenge.

## Passing a Cloudflare Turnstile challenge (rateyourmusic.com)

Verified end to end, fully automated, twice:

```sh
"$CHROME" --no-sandbox --user-data-dir="$(mktemp -d)" \
  --no-first-run --no-default-browser-check --use-mock-keychain \
  --enable-unsafe-swiftshader --window-size=1280,900 \
  --disable-features=site-per-process,IsolateOrigins,IsolateSandboxedIframes,BackgroundResourceFetch \
  --js-flags='--random-seed=1337 --hash-seed=1337 --no-turbo-fast-api-calls' \
  --sbxdiff-run-key=<key> --sbxdiff-trace-out="$OUT" \
  --sbxdiff-click-frame=challenges.cloudflare.com \
  --sbxdiff-click=22,32,4000,8,3000 \
  --sbxdiff-run=16000 \
  https://rateyourmusic.com/
```

Three things make this work:

1. **Headed.** Headless is challenged and never passes, for stock Chromium too.
2. **`--sbxdiff-click-frame`.** `ForwardMouseEvent` delivers to one widget and
   is _not_ hit-tested into child frames, and the input router is not in
   content/public. So the click must target the Turnstile iframe's own widget;
   coordinates are then relative to that frame (22,32 = its checkbox).
3. **Repeats.** The widget shows "Verifying..." before it is interactive, so a
   single click has to guess the instant. `4000,8,3000` = start at 4s, 8 tries,
   3s apart.

Events go through `RenderWidgetHost::ForwardMouseEvent`, the same path OS input
takes, so `isTrusted` is **true** and no DevTools session is attached.

### Confirming a pass from the trace

`document.title` is **not** a reliable signal: the challenge page sets its title
from JS (traced), the real page gets it from parsed markup (not a binding call,
never traced). Use instead:

- `IntersectionObserver.observe` in the summary — rym lazy-loads, the challenge
  does not (the page also sets `window.lazyloadObserver`);
- network records for `cdn.sonemic.net` / `e.snmc.io`;
- a `rateyourmusic.com` realm with thousands of records.

A passing run gives ~8.9k records and 116 network requests in the page realm.

### Screenshots

`--sbxdiff-shots=<dir>[,interval_ms]` captures the viewport periodically via
`CopyFromSurface`. Done in-browser because the macOS screenshot tool needs
Screen Recording permission an SSH session cannot grant. Capture pixels are
viewport pixels 1:1 (cropped, not scaled) — verified against a known-position
element — so coordinates read off a screenshot can be used directly for
`--sbxdiff-click`.

## Network record and replay (P5)

This is what makes two runs comparable at all: without it every run re-fetches
the live site and diverges on content you do not control.

```sh
# 1. Record. Runs normally, hits the network, writes every response to <dir>.
"$CHROME" … --sbxdiff-run-key=k --sbxdiff-net-record="$STORE" --sbxdiff-run=3000 <url>

# 2. Replay, on both sides of the diff. Serves from <dir>; never touches the network.
"$CHROME" … --sbxdiff-run-key=k --sbxdiff-net-replay="$STORE" --sbxdiff-run=3000 <url>
```

Record and replay are two different layers, deliberately:

- **Recording is renderer-side**, off the `probe::DidReceiveResourceResponse` /
  `DidReceiveData` / `DidFinishLoading` hooks — the same taps DevTools' network
  panel uses, so it sees decoded bodies for navigation, subresources, XHR and
  `fetch` alike.
- **Replay is browser-side**, a `network::mojom::URLLoaderFactory` spliced in at
  `WillCreateURLLoaderFactory`. It has to be: by the time a request is visible to
  the renderer it has already been sent.

The store is `base/sbxdiff_net_store.*` (in `base/`, not blink, precisely so both
processes can share one definition).

### Replay is strict: a miss is a failure, not a fallback

An unrecorded URL gets `net::ERR_BLOCKED_BY_CLIENT`. It is **never** fetched from
the network. This is the whole point — a silent fallback would let a real
divergence look like a clean run. The decoder surfaces it:

```
network: 116 requests, 0 blocked by the replay gate
```

Any nonzero blocked count is a divergence to investigate, not an error to fix.

### Verified

With the origin server **confirmed down** (`curl` → `000`), a replayed run
produced the page realm, every subresource, and a `fetch()` body. Then the
stored body was edited on disk and replayed again: the page observed the
_edited_ bytes. That tamper step is the one that actually proves the bytes come
from the store — an earlier version passed the first test while silently
bypassing to cache.

Three replayed runs of the same store were **byte-identical** in the page realm.

## What a run produces

One file per _thread that recorded_, named `trace.<pid>.<n>.sbxd`. A dedicated
worker gets its own file (`trace.<pid>.1.sbxd`), because the tracer is
thread-local. Decode with `tools/sbxdiff/sbxread.py`, which takes a directory.

## THE IMPORTANT PART: scope the diff to the page realm

A run contains realms you must ignore. Measured over 3 identical runs of the
same page:

| Realm                                                                      | Deterministic?                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------ |
| the page's own realm (`http://…` / `file://…`)                             | **byte-identical across runs**                   |
| `chrome://webui-toolbar.top-chrome/`, `chrome://omnibox-popup.top-chrome/` | **varies** — different process, its own activity |
| `chrome-extension://…` service workers                                     | varies                                           |

The page trace was 1105 bytes / 26 records with an identical MD5 of the decoded
record dump in all three runs, while total bytes across all files varied by
~30%. **Diff per realm, keyed on the realm URL, and only compare the realms your
page owns** — page, its iframes, its workers. Comparing whole files will produce
constant false divergences.

`kRealm` records map realm id -> URL, emitted when the realm is created, so the
mapping is available before any record that uses the id.

## Record content

`kBindingCall` carries: interface+member name, receiver, **arguments**, result,
`threw`, realm id, task id, seq.

`kInterceptor` carries: name, receiver, key (name or index), and for
setter/definer interceptors the **value written**. A following
`kInterceptorOutcome` record says whether it intercepted or declined
(`v8::Intercepted::kNo` means it fell through to the ordinary lookup, which is
guest-observable).

`kException` carries Blink's `ExceptionCode`, so `TypeError` vs `RangeError` is
a real diff, not just a `threw` bool. (`kBindingCall` still carries `threw` for
the cheap check.)

Arguments are capped at 8 per call; the record carries the true count too, so
`argc_total > argc_emitted` means truncated, not short. Strings are capped at
512 bytes with the true length recorded the same way.

## Object identity

Ids are derived from the **Blink object behind a DOM wrapper**
(`ToAnyScriptWrappable`), keyed on its address. Nothing is written to the page's
objects.

> This mattered. The tracer previously stashed the id in a `v8::Private` on the
> object. Private symbols are invisible to every reflection path — `Object.keys`,
> proxies, cross-origin checks, all verified — but _invisible to reflection is
> not unobservable_: adding a property forces a hidden-class transition, which
> can turn a monomorphic inline cache megamorphic for the page's own code. On
> rateyourmusic.com this looped the Cloudflare challenge forever. Disabling only
> that write made it pass. **Never give a traced object a property.**

Consequences for the differ:

- **Only wrapper objects get ids.** Plain JS objects, functions and proxies
  record id `0` = _unidentified_, not "object #0". Pair them positionally by
  `seq`; do not treat two `0`s as the same object.
- **Ids are run-local**, assigned in first-sighting order, so the same object
  has different ids in two runs. The differ needs a bijection: pair ids
  positionally as the streams align and treat a first-seen id as novel. Never
  compare ids numerically across runs.
- **Address reuse can alias ids.** The key is an Oilpan address; if a wrappable
  is collected and a new one lands on the same address, they share an id. It has
  not been observed in practice, but a differ that sees an object "change type"
  should suspect this before suspecting the sandbox.

## Determinism: what is pinned and what is not

| Source                                        | Status                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| `crypto.getRandomValues`, `crypto.randomUUID` | **exact** with `--sbxdiff-run-key` (gate: same key ×5 → 1 distinct result)  |
| `Math.random`                                 | exact via `--js-flags=--random-seed`                                        |
| `Date.now()` absolute                         | **exact** with `--sbxdiff-initial-time` + budget                            |
| time deltas (`setTimeout(…,10)`)              | exact                                                                       |
| `getTimezoneOffset()`                         | pinned by `TZ`                                                              |
| `performance.timeOrigin`, `performance.now()` | **~1.7 ms jitter** — do not diff these values directly; diff their _deltas_ |
| network                                       | **exact** with `--sbxdiff-net-record` / `--sbxdiff-net-replay` (below)      |

## Known gaps to design around

1. **`performance.timeOrigin` / `performance.now()` jitter ~1.7 ms.** Compare
   deltas, not absolutes. `Date.now()` is exact; only the monotonic clock's
   origin moves.
2. **Replay keys on URL alone.** Method and POST body are not part of the key,
   so two different POSTs to one URL collide and the second gets the first's
   body. Recorded requests carry the method, so a differ can at least detect it.
3. **Non-wrapper objects have no identity** (id `0`) — see above.
4. **`PropertyCallbackInfo` sites record `Holder()`, not the receiver** the
   guest used. They differ for inherited properties.
5. **Do not combine tracing with `--dump-dom` / `--virtual-time-budget`.** That
   path drives the page over CDP from a `chrome://headless/` page, and with
   tracing on it crashes the renderer for a `file://` page whose worker is
   blocked by security policy (3/3). The in-binary runner is clean on the same
   pages (5/5) and is what you should use anyway — it also keeps the CDP realm
   out of your traces and avoids a page-observable DevTools session.

## Verifying your setup

Four gates, all green on the current binary. Re-run them after any patch:

| Gate                   | Method                                                                                                        | Result                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| P4 randomness          | `tools/sbxdiff/p4gate.sh` — same `--sbxdiff-run-key` ×5 → count distinct `getRandomValues`/`randomUUID` draws | **1 distinct**; different key differs; no key → 3/3 distinct              |
| page-realm determinism | 3 replayed runs, diff the decoded page realm                                                                  | **byte-identical**                                                        |
| network replay         | record, kill the server, replay; then tamper a stored body                                                    | page sees stored bytes, then tampered bytes                               |
| rym automated pass     | headed, `--sbxdiff-click-frame` + repeats                                                                     | 8927 records, 194 `IntersectionObserver.observe`, 116 requests, 0 blocked |

Measure any determinism claim over **N runs, not two** — a passing pair has been
wrong three times in this project. Two of those were the tracer itself being
nondeterministic in a way that happened to agree twice.
