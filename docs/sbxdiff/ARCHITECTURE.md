# Architecture

What sbxdiff is, where the seam is cut, and how a divergence is decided. Read
`RULES.md` before changing any of it.

**Status: design + M0 in progress.** Nothing below the "Trace format" heading is
implemented yet.

---

## The problem

`browser.js` + `scramjet` run untrusted pages in a real browser tab by rewriting
JS/HTML/CSS and mediating platform access through per-property interceptors. The
fidelity of that mediation *is* the security property: anywhere the guest observes
something real Chromium would not show it — the host origin, a proxy URL, host cookies,
an untrapped API, the real `top`/`location` — is a leak or an escape.

sbxdiff runs a site twice and reports every divergence in the guest-observable
universe, aborting on the first one.

## Three phases

```
 capture (stock headful Chrome, real profile, live internet) ──▶ network archive server
                                                                        │
 record ──▶ patched Chromium, direct (in #testframe) ───────────────────┤──▶ trace.oracle
               ├─ kSbxDiffScripted virtual time                        │    vt_schedule
               ├─ keyed PRNG streams                                   │    net_manifest
               └─ C++ binding tracer → file                            │
                                                                       │
 replay ──▶ patched Chromium, via browser.js ───────────────────────────┘──▶ trace.sandbox
               ├─ same vt_schedule / run_key / archive
               ├─ C++ binding tracer → file
               └─ shim guest-op brackets

 trace.oracle + trace.sandbox ──▶ differ ──▶ tiered, bucketed report + triage GUI
```

Capture is separate from replay on purpose: the patched binary never faces a bot
detector, which reduces fingerprint parity from "must fool Cloudflare" to plain
symmetry.

## Why symmetry, not undetectability

Both runs use the same patched binary, so any perturbation the patch introduces cancels
in the diff. That is far weaker — and far more achievable — than true undetectability,
and it is what lets us disable V8 fast-API calls and virtualize the clock freely.

Undetectability still matters in exactly two places:

- **Realism.** A page that takes an unrealistic branch means we diff the wrong site. So
  the virtual clock advances plausibly rather than freezing.
- **The asymmetric bits.** The shim's guest-op brackets exist only on the sandbox side.
  Keep them minimal and audited.

A cautionary example of getting this wrong: scramdiff's in-page probe forces
`configurable: true` on every wrapped accessor and converts data properties to
accessors. That is symmetric only if both sides' descriptors start identical — but the
sandbox's have already been rewritten by scramjet. Hence a C++ tracer, and hence the
probe is deleted rather than ported.

## The cut: five layers

Naively diffing raw Blink binding calls fails, because the sandbox run makes vastly more
of them (shim helpers, `Reflect.get`, rewriter runtime). The seam that works:

| `layer` | Used for | Compared? |
|---|---|---|
| `binding` | APIs the sandbox does **not** intercept — the guest's view *is* the binding layer | yes, at `depth == 0` |
| `trap` | APIs it does intercept — the guest's view is the interceptor | yes; one event per guest op |
| `helper` | rewriter runtime helpers (`$scramjet$wrap`, `$scramjet$prop`, ...) | yes |
| `guest-entry` | every point where the platform or shim calls *into* guest code | yes — the differ's primary alignment anchors |
| `wire` | reimplemented interfaces (`WebSocket`, `WebSocketStream`) | trap layer + a normalized request/response and wisp-frame stream |

Nested binding events inside a `beginGuestOp`/`endGuestOp` bracket are demoted to
`level == 1` and excluded from comparison — kept in the same file, because the innermost
suppressed event **is** the native value that reveals a missing interceptor. So `pre` is
*derived*, never captured; no second invocation of the native, and therefore no
duplicated side effects.

`wire` exists because `WebSocket`/`WebSocketStream` are rebuilt from scratch by scramjet
(`new EventTarget()` + `setPrototypeOf`), so the oracle emits real binding events with
**no sandbox counterpart at all**. The differ skips binding-layer alignment for
receivers in `reimplementedInterfaces`.

## Trace format

Length-prefixed binary, appended, never seeked, one file per renderer.

As implemented (`sbx_tracer.cc`; `tools/sbxdiff/sbxread.py` is the reference
decoder). This differs from the original sketch in this file, which had a
`total_len` prefix and a realm table offset — neither survived contact: records
are self-delimiting, and realms are emitted inline as they are created because
a trailing table cannot be written when the process may be killed mid-run.

```
header := "SBXD" varint version(=2) varint pid varint run_key
record := varint kind payload

kIntern(0)             := varint id, varint len, bytes
kBindingCall(1)        := u8 level, varint seq, varint realm_id, varint task_id,
                          varint name_id, u8 threw, value recv, value result,
                          varint argc_total, varint argc_emitted, value*
kInterceptor(2)        := u8 level, varint seq, varint realm_id, varint task_id,
                          varint name_id, u8 key_kind,
                          value recv,
                          key_kind==0 -> value key
                          key_kind==1 -> varint index
                          key_kind==2 -> (nothing)
                          u8 has_value, has_value -> value written
kRealm(3)              := varint seq, varint realm_id, varint len, bytes
kInterceptorOutcome(4) := varint target_seq, u8 intercepted
kNetRequest(5)         := varint seq, varint task_id, varint len, method,
                          varint len, url
kException(6)          := varint seq, varint task_id, varint code,
                          varint msg_len, varint msg_emitted, bytes

level    := 0 compared | 1 internal(demoted) | 2 debug
key_kind := 0 name | 1 index | 2 none (enumerator / IndexOf / IterableToList)
value    := u8 tag [payload per tag]
```

`run_key` is `base::PersistentHash` of the `--sbxdiff-run-key` string —
provenance only, so a reader can confirm two traces share a key.

**Truncation is always explicit.** Arguments are capped at 8 and strings at 512
bytes, and both carry the *true* size alongside the emitted size
(`argc_total`/`argc_emitted`, `msg_len`/`msg_emitted`). So a differ can tell
"the call had 12 arguments and we recorded 8" from "the call had 8", which a
single count could not.

`kNetRequest` carries a task id but **no realm id**: resource loads are not
necessarily inside a v8 context, so its ordering against binding records comes
from `seq` alone.

`kInterceptorOutcome` carries **no seq of its own**: it annotates the record at
`target_seq` rather than being a guest-observable event, so it must not consume
a position in the ordered stream.

Two decisions that carry their weight:

- **Everything is interned.** `kind`, interface name, property name and script URL are
  u32 ids into side tables emitted as `kIntern` records on first use. The generator
  already builds the exact `"Iface.prop.get"` string
  (`_make_bindings_logging_id`), so it emits a `constexpr` interned id per callback and
  the hot path writes 4 bytes. Without this the trace is tens of GB.
- **One ordered stream, both levels.** Splitting `level==0` and `level==1` into separate
  files would destroy the interleaving needed to attribute a divergence.

A rolling hash per 64 KiB block rides alongside so the self-diff gate is a hash compare,
byte-comparing only the first mismatching block.

## Values: identity, not contents

An encoded value is `{type_tag, object_id, interface_name | constructor_name,
shape_hints}` — never contents, never own-keys (`RULES.md` #2).

Object ids are **run-local** and come from the `ScriptWrappable*` behind a DOM wrapper
(`ToAnyScriptWrappable`), through a `ScriptWrappable*` -> id map. Reading it mutates
nothing, and a node keeps its id across wrapper recreation after a GC drop.

Non-wrapper objects — plain JS objects, functions, Proxies — get id `0`, meaning
*unidentified*. The differ pairs them positionally by `seq`; two `0`s are not the same
object.

> This replaced a `v8::Private` symbol written onto the object itself. That was
> verified invisible to every JS enumeration path, and it was still detectable: adding
> a property forces a hidden-class transition and can deoptimise the page's own inline
> caches. See RULES.md #22.

Ids are assigned in first-sighting order, so the same object has different ids in two
runs. The differ needs a bijection built as the streams align — never a numeric
comparison.

## The differ

Streaming, two cursors, per realm.

1. **Align** by `(realm, task.id)`. Task ids are causal (from Blink's
   V8's call-entered/call-completed pair), so tasks pair by equality — no
   fingerprint fallback. Task ids are per-thread sequential, not causal: see
   `DETERMINISM.md` § "Task identity".
   Within a task, walk positionally; on mismatch, resync with a bounded Myers diff over
   a 64-event window keyed on `(api, op, argShapeWithBijectionResolvedIds)`.
2. **Bind identities.** Maintain `bind: oracleH -> sandboxH`, `inv`, and
   `witness: oracleH -> EventId` — where the binding was established. An inconsistent
   binding reports with its provenance: *"sandbox #4127 was bound to oracle #391 at
   `Document.prototype.createElement` id 812; here it is used where oracle #402 is
   expected."*
3. **Check novelty.** A bijection alone cannot see "the sandbox minted a fresh object
   where the oracle returned a cached one" if the fresh object is never observed again —
   and that is high-frequency here, because `dom/css.ts:71` mints a new Proxy on every
   `style` get, making `el.style === el.style` false in the sandbox and true in the
   oracle. So every value carries a `novel: boolean`, set on first observation; a
   mismatch is `identity-novelty-divergence`.
4. **Classify and bucket.** `diffClass` picks a bucket *after* literal comparison has
   already failed (`RULES.md` #6). Bucket key is
   `(tier, kind, api, op, normalizedSite, diffClass)` with
   `normalizedSite = (scriptId, fnName)`.

`missing-call`/`extra-call` split four ways by whose code is on the stack — free,
because the bracket knows its depth and the tracer knows the script identity:
`shim-call` (T4; the shim *is* extra work), `extra-call` (T2), `missing-call` (T2), and
`interceptor-elided` (**T1** — the shim skipped a native the oracle made). This is why
`extra-call` is ~90% noise in the prior harness.

## Tiers

T0 containment (never suppressible, always aborts) · T1 logical value/identity/novelty
divergence (aborts by default) · T2 ordering and control flow · T3 layout/timing
(summary counts only) · T4 by design (suppressed, counted). Full definitions in the
plan; T4 suppression is keyed on **buckets**, not test names, generated by running each
expected-failing runway test under the tracer.

## Attribution

Two tiers, avoiding a per-script allocation:

1. **Realm-level, O(1)** — an `SbxRealmKind` on `V8PerContextData`, read via
   `GetEnteredOrMicrotaskContext()`.
2. **Script-level, once at compile time** — classify from `ClassicScript::SourceUrl()`
   against `--sbxdiff-shim-prefix=` / `--sbxdiff-harness-prefix=` and emit
   `script_compiled{script_id, kind, url_id, source_hash}`. Runtime events carry only
   realm + task id; the differ joins offline. Zero per-call cost.

In non-isolated mode (the primary target) guest, shim, harness and chrome share a realm,
so tier 1 collapses and **tier 2 is load-bearing**.
