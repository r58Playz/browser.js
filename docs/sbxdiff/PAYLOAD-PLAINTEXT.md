# Reading Cloudflare's payload before it is encrypted

```sh
src/sbxdiff/rym.sh plaintext              # both sides, the widget's realm
src/sbxdiff/rym.sh plaintext orchestrate  # the interstitial's realm instead
pnpm sbxplaintext --show o27              # one chunk in full
pnpm sbxplaintext --kind json             # only the JSON.stringify results
```

The `/fo/` body is `base64(rsa-wrapped key || xtea(lzw(json)))`. A byte diff of
two bodies therefore says only **that** they differ: LZW turns one early
difference into a completely different tail, and every one of the five diverging
bodies agrees on exactly the 171-byte RSA key block and then parts company at
the first ciphertext byte.

This reads the payload **before** the encryption, on both sides, out of the
build rym actually replays. No lifting, no deobfuscation, no Chromium rebuild.

## The seam, and why it is that one

**`String.prototype.charCodeAt`.** The pipeline is JSON → LZW → XTEA → base64,
and LZW reads its input one character at a time. So the plaintext is simply _the
receiver of a long `charCodeAt`_.

This is the part worth remembering, because two earlier passes got it wrong in
the same way: they looked for one big plaintext string, did not find one, and
concluded none existed. It is chunked at 4096/8192 with a one-character header,
so there are **dozens of small ones**.

**`JSON.stringify`.** The parts the challenge serialises conventionally. This is
how the per-field `PerformanceResourceTiming` diff in FINDINGS [#109](FINDINGS.md#109)
was read. On rateyourmusic all 41 of these came back byte-identical
([#205](FINDINGS.md#205)) — which is what established that the remaining
difference is assembled inside the VM and never touches a traced API.

## What does not work

Recorded so nobody spends an afternoon on them again.

| approach                                                                                 | why not                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `internal-cf/sandbox/payload-plaintext.mjs` — rewrite `xhr.send(enc(payload))` in source | Needs a deobfuscated challenge. rym's recording is a string-table VM: `send` and `XMLHttpRequest` exist only as entries in a semicolon-joined table reached by computed index. A search of all 97 store entries for `ident.send(ident(ident))` found **zero**; the only `.send(` anywhere in rym's store is gtag and jQuery ([#150](FINDINGS.md#150)) |
| `Object.keys` / `entries` / `getOwnPropertyNames`                                        | Gives the key **set**, no values. Good for "which field is extra" ([#147](FINDINGS.md#147)), useless for "what does it say"                                                                                                                                                                                                                           |
| Diffing the `/fo/` bodies                                                                | Ciphertext. Says only that they differ                                                                                                                                                                                                                                                                                                                |
| `sbxdiff-encode.js`                                                                      | Hooks the same `TextEncoder` boundary but records **lengths and a masked preview** on purpose. It answers "how big is the gap", not "what is in it"                                                                                                                                                                                                   |

## How it reaches both sides

Planted in a **copy** of the store by `probestore.ts`. That is the only
injection that reaches both: the sandbox could take it through scramjet's
`probePath`, but the oracle has no scramjet. Both sides replay the same store,
so a probe in a recorded body runs in the same script at the same point in both
runs.

The probe hooks a global, so **it only covers the realm the patched script runs
in**. The default target is the Turnstile widget's own script, which is the
realm the `challenges.cloudflare.com` `/fo/` is posted from. Pass `orchestrate`
for the interstitial's `/fo/` on rateyourmusic.com.

The run's own divergence report means nothing — a patched body changes every
request after it. Read the chunks, not the buckets.

## Reading the result

Measured on rateyourmusic, widget realm:

```
oracle : 61 chunk(s)   sandbox: 77 chunk(s)
58 identical, 3 differing, 0 oracle-only, 16 sandbox-only
```

**58 of 61 identical** is the headline: the payload is overwhelmingly the same,
and the three that differ are the whole story.

Two traps, both of which have caught someone:

1. **A sandbox-only chunk is suspect, not a finding.** The oracle has no
   scramjet, so every oracle chunk is the challenge's — but wasm-bindgen passes
   strings to the rewriter by reading them character by character, which is the
   same seam. All 16 sandbox-only chunks in the run above are scramjet's own:
   its config JSON, a CSS `@keyframes` block, SVG path data, the rewriter's
   working strings. They are listed apart for exactly this reason.
2. **Pair by content, never by index.** Both sides do a different number of
   encodings, so the sequences offset. `plaintext.ts` matches on hash first,
   then on common-prefix similarity, so "the same chunk, three bytes different"
   is one differing chunk rather than one missing plus one extra.

### What the three differing chunks were

| chunk     | size             | what                                                                                                      |
| --------- | ---------------- | --------------------------------------------------------------------------------------------------------- |
| `o27/s42` | 1804 vs **3068** | a captured **stack trace**. Same frames, different column offsets — `…:223:206018` against `…:223:872417` |
| `o60/s75` | 545 vs 546       | the same stack-trace shape, one character apart                                                           |
| `o20/s35` | 6373 vs 6373     | a colon-separated hex digest list. **Same length**, different values                                      |

The stack traces are the interesting ones and they connect to
[#178](FINDINGS.md#178)/[#179](FINDINGS.md#179): a rewritten script reports
different line **and** column numbers, and Cloudflare collects both. The column
offsets differ because scramjet's rewriting changes the script's length, and the
sandbox's trace is 1264 characters longer.

Note the direction: the sandbox's `/fo/` body is ~1420 bytes **shorter** overall
while this chunk is 1264 characters **longer**, so there are offsetting effects
and the body-length delta alone will not tell you where they are. That is the
argument for this tool over byte arithmetic.

## Cost

The `charCodeAt` hook runs on every string read in the realm. It is affordable
because it tests `this.length` first and then short-circuits on receiver
identity, so a repeat receiver costs two comparisons — but it is not free, and
it is a **diagnostic**, never part of the gate. The probed store is a copy
(`<store>-plaintext`); the real one is untouched.

## Files

|                                           |                                                          |
| ----------------------------------------- | -------------------------------------------------------- |
| `src/sbxdiff/probes/payload-plaintext.js` | the probe: which seam, and why the other two do not work |
| `src/sbxdiff/plaintext.ts`                | the decoder and the content-pairing diff                 |
| `src/sbxdiff/rym.sh plaintext`            | plants it, runs both sides, prints the diff              |
