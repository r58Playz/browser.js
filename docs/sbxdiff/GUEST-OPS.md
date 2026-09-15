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
| APIs compared at the scramjet layer | 49 (1445 calls) |
| APIs intercepted and unmeasured     | 3 (6 calls)     |
| APIs elided                         | 3 (4 calls)     |
| coverage                            | **100%**        |

Over the whole run, which includes the eight Cloudflare blob workers, coverage
is also 100%: 431 calls across 184 APIs remain unmeasured, the largest of them
`DOMRectReadOnly.top.get` at 20. `--coverage` names every one.

A caution about how that number got there. The blind list was 1108 APIs and 3229
calls until 923 of them turned out to be `Window.Node` and its ~900 siblings --
interface objects, which Blink installs LAZILY. The one traced access per realm
is the install; every read after it is a data-property read and untraced on both
sides. So there was never anything to cover, and a coverage report that counted
them was reporting its own confusion as a gap. They are classified
`interface-object` now and counted apart.

## How it works

### The seams

scramjet reaches the guest through seven places, and every one of them records
from **inside a function scramjet already installs**. Nothing is wrapped after
the fact, so nothing new exists on the page for a census to find.

That is the second design. The first hooked `ScramjetClient.installNative`, the
single point all three descriptor-installing mechanisms go through, and wrapped
whatever it was handed. What it was handed is a `Proxy` over the native, and a
plain wrapper around one loses `[native code]`, loses the target's prototype
chain and is absent from `box.unproxy`. Cloudflare's `jsd` census tests exactly
that pair from a pristine child realm, and read the sandbox's shimmed members as
non-native (FINDINGS #224, #226, #227, fixed in #237). One hook in the wrong
place cost more than three in the right ones.

| seam                       | what it covers                                                | recorded in                |
| -------------------------- | ------------------------------------------------------------- | -------------------------- |
| `ScramjetClient.RawProxy`  | function members                                              | its `h.apply` trap         |
| `ScramjetClient.RawTrap`   | accessor and data members                                     | its `next.get`/`next.set`  |
| `ScramjetClient.Intercept` | class-handler members                                         | `createProxy`'s apply trap |
| constructors               | `RawProxy`'s `construct`, and `Intercept`'s class replacement | those traps                |
| `createLocationProxy`      | `location`'s own per-property proxies                         | its own descriptors        |
| `shared/wrap.ts`           | `$scramjet$location` / `$scramjet$parent` / `$scramjet$top`   | those accessors            |
| `dom/element.ts`           | the URL-carrying attributes: `href`, `src`, `action`, ...     | its own descriptors        |

`location.ts` and `dom/element.ts` are the two that still wrap a descriptor
rather than a trap body, and that is safe for a reason worth stating: the
descriptor they wrap is one **scramjet authored**, so the wrapper is a scramjet
closure around a scramjet closure. The census sees the same class of thing
either way. `installNative`'s was a wrapper around a `Proxy`, which is not.

The seams that do not install a descriptor were each a hole worth naming:

- **Constructors.** A `new` cannot go through a plain-function wrapper at all —
  it loses `new.target` — which is why `construct` was always recorded at the
  trap and never at the descriptor. The rest of the seams have now joined it.
- **`location`** cannot be `Proxy()`d, so scramjet builds a stand-in object and
  defines onto that.
- **The `$scramjet$*` accessors** are the _rewriter's_ seam: guest code that
  says `location` is rewritten to read one of them, so no interceptor is
  involved at all. 67 `window.location` reads on rateyourmusic against nothing.
- **The URL attributes** define straight onto the interface prototype. Those are
  the values a leak would be _in_: `HTMLAnchorElement.href` was 15 guest reads
  against nothing, `HTMLScriptElement.src` 8.
- **`wrapEvent`** traps a single event OBJECT rather than a prototype, so
  nothing installed on a prototype reaches it. It is how `MessageEvent.data`,
  `.origin` and `.source` are answered -- 135 guest reads against nothing -- and
  its fall-through counts too: a property the trap does not rewrite still went
  through it, and `MessageEvent.isTrusted` was another 31.

### Depth is the cut

scramjet's own code uses the members it traps — the URL rewriter reads
`location`, the element shims read attributes. A recorder that logged every
entry would log scramjet's plumbing as if the guest had asked for it.

So the recorder counts depth and records **only at zero**. The outermost entry
is the guest's; everything nested inside it is scramjet working.

That is the guest-op bracket `ARCHITECTURE.md` specifies, in JS instead of C++,
and it needs no Chromium rebuild. On rateyourmusic it separates 4997 guest ops
from 4173 calls of scramjet's own plumbing in the same realm.

**RULES.md #10 says a depth counter is not quite the right shape** -- brackets
should be token-returning, because per-instance `RawTrap`s are installed INSIDE
an apply handler and the nesting is re-entrant. Nothing had ever measured what
the counter drops, so it now counts: the recorder reports
`nested=<n>` on its way out, alongside `events` and `dropped`, in the same
`chromium.stderr.log` line the run already greps for the word "installed". If
that number is large the token-returning bracket is worth building; if it is
zero, #10 is satisfied by the shape of the code and there is nothing to fix.
Measure before changing it.

### The sink

Two sinks, because a worker has no `document`.

A document reports through **`document.createComment`**: the argument lands in
the trace as an ordinary binding record with a marked string, and nothing else
in the page can read a detached `Comment` — which is why `probestore.ts` already
reports through it.

A worker reports through **`new URL("sbxgop:" + chunk)`**. `URL.constructor` is
a traced binding that records its string _argument_, so the parser's
normalization of the payload never matters; `sbxgop:` is a valid scheme with an
opaque path, so it parses, throws for nothing and touches no network; and `URL`
exists in every worker and worklet. Deliberately not `TextEncoder.encode`, the
other traced string-taking call there: it already carries 40000 real calls per
blob worker, and `sbxdiff-encode.js` reads the challenge's payload plaintext out
of exactly those records.

The probe reaches a worker because `getWorkerInjectScripts` in the controller
puts `probePath` into the worker bootstrap, ahead of the client — the same
ordering guarantee a document gets.

**The benchmark is unperturbed.** Cloudflare's worker runs
`while (performance.now() - start < 100) digest(...)` and reports the iteration
count, which is a hardware fingerprint. Measured with the worker sink in place:
5000 digests in each of the eight workers, on **both** sides, identical. The
logical clock is what makes that hold — the loop is a function of the clock
sequence rather than of how fast the machine is.

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

## Errors

An error reaches the guest by two roads and each side favours a different one,
so both are recorded and merged by `exceptions.ts`:

| road                 | written by                         | holds                          |
| -------------------- | ---------------------------------- | ------------------------------ |
| `kException`         | `ExceptionState::SetExceptionInfo` | what a **Blink binding** threw |
| guest op, op `throw` | `NativeErrors.stamp`               | what **scramjet** built        |

An API scramjet handles in JS never reaches a binding, so scramjet's own
refusals are invisible to the tracer: on rateyourmusic, 31 exception records on
the oracle against 3 in the sandbox, most of that gap being interception rather
than behaviour.

Two things about this channel are deliberate and easy to undo by accident:

- **It is not gated on depth.** An error is constructed inside the trap that
  rejects the call, so it is always nested; `around`'s depth gate would drop
  every one. It is not scramjet working, it is the value the guest is about to
  catch.
- **The message is reflected on, which `around` refuses to do.** RULES #1
  forbids reading properties off an arbitrary thrown object — it can run a page
  getter. It is safe at `stamp` and nowhere else: the object there is
  scramjet's own, built from a snapshotted constructor one instruction earlier.

The two roads also record at different **points**: the tracer copies the
message before `DOMException::AddContextToMessages` decorates it, so the oracle
holds the bare detail where the page catches
`Failed to execute 'x' on 'Y': <detail>`. `stripBindingContext` removes the
prefix for pairing only; the full text is what gets reported and what the leak
scan reads.

## What it cannot do

Three limits, all of them structural. None is a bug to be fixed later without
saying so here first.

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

_Except error messages_, which broke this assumption and now have their own
cap. An error message is long by nature and the part that decides the question
— the origin, the URL — is at the END of it, so 48 characters kept the
boilerplate and discarded the evidence: a cross-origin `pushState` refusal came
back as `Failed to execute 'replaceState' on 'History': A`. The `threw` channel
records 512 to match `kMaxStringBytes` in `sbx_tracer.cc` (FINDINGS #256).

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

`sbxdiff-shimread.js` and `sbxdiff-nativeread.js` used to sit beside these and
are deleted. They counted per-member reads through a second hook on the same
`createProxy` funnel, which the guest-op stream answers per call rather than in
aggregate -- and `nativeread` wrapped native descriptors on the ORACLE, which is
the scramdiff mistake `ARCHITECTURE.md` cites as the reason a C++ tracer exists
at all (FINDINGS #211 has what they measured, #237 why they went).
