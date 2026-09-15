# The guest-op layer

What the guest asked scramjet for, and what scramjet answered.

This is the layer the differ was missing. Everything here is measured on
rateyourmusic against the store in `.traces/rym-store-fresh`; every number is
reproducible with `pnpm sbxoffline --coverage`.

## The problem it solves

The binding tracer records native calls, and the differ pairs **guest** calls
against guest calls — a call whose topmost JS frame is the page's own script.

For an API scramjet leaves alone that is exactly right. The guest's call _is_
the binding call, both sides record one, and they compare.

For an API scramjet **intercepts** it is exactly wrong:

```
  guest code  ->  scramjet trap  ->  native
                  ^^^^^^^^^^^^^
                  topmost JS frame at the native call
```

The native's record carries scramjet's script on top, so it is attributed to the
shim and filtered out — correctly, it _is_ the shim's call. But the guest's call
never reached a native at all, so the sandbox contributes **nothing** to that
API's sequence. The differ compares the oracle's N calls against zero and
reports `missing-call`, at T2, where a baseline swallows it.

Measured before this layer existed, in the rateyourmusic page realm:

|                                                            |                 |
| ---------------------------------------------------------- | --------------- |
| APIs compared                                              | 159             |
| APIs intercepted and unmeasured                            | 43 (1344 calls) |
| APIs elided — scramjet answered with no native call at all | 18 (117 calls)  |
| coverage                                                   | **76%**         |

`Element.getAttribute`: 217 guest calls on the oracle, 0 in the sandbox.
`Window.location.get`: 67 against 0. And **663 of the 838 buckets** in
`baseline.rateyourmusic.com.json` are `T2|missing-call` — that is not a list of
accepted divergences, it is the shape of the hole, written down and suppressed.

So "the sandbox agrees with the oracle everywhere the differ looked" was true and
uninformative at once: the differ looked only at the APIs scramjet does not
touch, which are the ones it cannot be wrong about.

After:

|                                     |                 |
| ----------------------------------- | --------------- |
| APIs compared at the binding layer  | 157             |
| APIs compared at the scramjet layer | 44 (1427 calls) |
| APIs intercepted and unmeasured     | 14 (24 calls)   |
| APIs elided                         | 5 (12 calls)    |
| coverage                            | **99%**         |

## How it works

### The seams

scramjet reaches the guest through five places. Four of them install a property
descriptor, and `ScramjetClient.installNative` is the single point all four go
through — it exists so a page cannot tell from the _shape_ of a member which
mechanism touched it. That makes it the one place that can wrap all of them:

| seam                       | what it covers                                              |
| -------------------------- | ----------------------------------------------------------- |
| `ScramjetClient.RawProxy`  | function and constructor members                            |
| `ScramjetClient.RawTrap`   | accessor and data members                                   |
| `ScramjetClient.Intercept` | class-handler members                                       |
| `createLocationProxy`      | `location`'s own per-property proxies                       |
| `shared/wrap.ts`           | `$scramjet$location` / `$scramjet$parent` / `$scramjet$top` |

The first three are covered by eight lines in `client/guestop.ts`, called from
`installNative`. The last two do not install a descriptor — `location` cannot be
`Proxy()`d, so scramjet builds a stand-in; and the `$scramjet$*` accessors are
the **rewriter's** seam, reached because guest code that says `location` is
rewritten to read one of them. Both are hooked by hand, and that is worth
knowing: they were the two largest holes left after the first version.

### Depth is the cut

scramjet's own code uses the members it traps — the URL rewriter reads
`location`, the element shims read attributes. A recorder that logged every
entry would log scramjet's plumbing as if the guest had asked for it.

So the recorder counts depth and records **only at zero**. The outermost entry
is the guest's; everything nested inside it is scramjet working.

That is the guest-op bracket `ARCHITECTURE.md` specifies, in JS instead of C++,
and it needs no Chromium rebuild. On rateyourmusic it separates 4997 guest ops
from 4173 calls of scramjet's own plumbing in the same realm.

### The sink

`document.createComment`, buffered. The argument lands in the trace as an
ordinary `Document.createComment` binding record with a marked string, and
nothing else in the page can read a detached `Comment` — which is why
`probestore.ts` already reports through it.

Buffered because an unbuffered sink would put a binding record between every
pair of guest ops. Flushed on a **microtask**, never a timer: the first version
used `setInterval(flush, 250)` and the very next run reported `Window.setTimeout`
returning 3 on the oracle against 2 in the sandbox. That is a real divergence
class — a page can read a timer id, and `pages/timerids.html` exists because
Cloudflare does — and the instrument had caused it by taking id 1.

### What a value carries

Strings exactly, up to 200 characters; past that, a 48-character prefix, the
true UTF-8 byte length and an FNV-1a hash of the whole. Numbers, booleans, null
and undefined exactly. Everything else is an identity from a `WeakMap`, never a
constructor name — reading one off a value the page may have proxied would run
guest code, which is the one thing the tracer's own rules forbid (RULES #1, #2).

**The leak check runs in the page**, on the whole value, before anything
truncates it. So a proxy URL 4 KB into a 40 KB string is still caught, which no
scan of a 512-byte trace field could manage. A flagged value is T0 and is never
baselined.

## What it cannot do

Four limits, all of them structural. None is a bug to be fixed later without
saying so here first.

**Documents only.** A worker has no `document`, so no sink. The realms that
matter on rateyourmusic — the page, the interstitial, the Turnstile widget — are
all documents; the eight blob workers run Cloudflare's SubtleCrypto benchmark,
which is a timing loop rather than an API surface. A worker sink needs a
different traced call that carries a string.

**Object tags do not cross the layers.** The tracer reads a `WrapperTypeInfo`
and says `CSSStyleDeclaration`; the recorder is forbidden from reading a
constructor name and says only "an object". So across the two layers the _tags_
of two references are not compared — their identity is, through a bijection of
its own. A trap returning `undefined` where the native returned a node is still
caught; a trap returning the wrong _kind_ of object is not.

**Long strings are compared on length and common prefix.** The tracer keeps 512
bytes, the recorder 48 plus a hash. Comparing past the shorter of two
truncations compares the instruments. Every value the comparison actually turns
on — a URL, an origin, a cookie, a referrer, a user-agent — is under the
200-character exact limit.

**ECMAScript members have no oracle counterpart.** `bind_gen` instruments Web
IDL, so `Function.prototype.toString`, `eval` and `console.*` have no binding
behind them and the oracle _cannot_ record them — not "did not call". scramjet
traps several, so the recorder sees them: 3115 `Function.toString` calls on
rateyourmusic against a structural zero. Those are excluded from the diff by
`isUntracedApi` and **counted in the report**, never silently dropped.

## Reading the report

```
  guest ops: 8606 total, 4997 in the compared realm
             3314 on 6 API(s) the binding tracer cannot record, excluded: ...
```

`0 total` means the recorder did not install, and the run says so in those
words. This matters more than it sounds: a recorder that silently failed reports
as a clean run, which is the exact failure mode the whole layer exists to
remove. Cross-check against `sbxdiff-guestop: installed` in the sandbox's
`chromium.stderr.log`.

`N member(s) map to no traced API` means `apiNameFor` could not translate
scramjet's spelling of a member into the tracer's. Those ops are dropped, so the
count is the size of a blind spot, not a curiosity.

## Turning it off

`--no-guestops`, on both `pnpm sbxdiff` and `pnpm sbxoffline`. It is on by
default and that is the right way round: a measurement instrument that has to be
remembered is one that will be forgotten. Off, the differ reports a clean run for
every intercepted API, which is where this started.

A `--self-check` never records guest ops — the "sandbox" is a second oracle and
there is no scramjet in it.

## Files

|                                                         |                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| `runway/src/harness/scramjet/public/sbxdiff-guestop.js` | the recorder. Installed by `probePath`, ahead of guest code |
| `scramjet/core/src/client/guestop.ts`                   | the seam. Inert without a recorder                          |
| `runway/src/sbxdiff/guestop.ts`                         | the decoder, and scramjet-name → tracer-name                |
| `runway/src/sbxdiff/coverage.ts`                        | what the differ can and cannot see, per API                 |
