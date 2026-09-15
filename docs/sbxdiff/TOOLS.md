# The tools

One page, one entry per thing you can run. Everything runs from
`packages/scramjet/packages/runway`.

If you are trying to answer a question rather than run a command, the question
is probably one of these:

| question                                                       | tool                         |
| -------------------------------------------------------------- | ---------------------------- |
| does the sandbox diverge from real Chromium on this site?      | `rym.sh diff`                |
| I changed the differ — did it change the answer?               | `pnpm sbxoffline`            |
| what is the differ not even looking at?                        | `pnpm sbxoffline --coverage` |
| is this divergence the sandbox, or the oracle's own noise?     | `rym.sh self-check`          |
| does it work live, which is the actual goal?                   | `rym.sh live`                |
| what does this page actually do, by hand?                      | `pnpm serve`                 |
| is the sandbox WORKING for those extra seconds, or waiting?    | `--shots`                    |
| what is IN the encrypted payload, and how do the sides differ? | `rym.sh plaintext`           |
| what does one line of JS see, inside the site's own script?    | `rym.sh probe`               |

---

## `pnpm sbxoffline` — re-diff, without a browser

```sh
pnpm sbxoffline                            # .traces/oracle vs .traces/sandbox
pnpm sbxoffline --coverage                 # and what the diff cannot see
pnpm sbxoffline --no-realms                # skip the realm sweep (it is on)
pnpm sbxoffline --realm challenges         # scope to one
pnpm sbxoffline --oracle <dir> --sandbox <dir>
pnpm sbxoffline --url <URL>                # which target's realm/baseline to use
pnpm sbxoffline --no-baseline              # show everything, suppress nothing
```

Reads the traces the last run left on disk and diffs them again. **1 second
against 110**, and against _fixed_ bytes — which is the part that matters. Two
live runs differ from each other as well as from your change, so a live run
cannot tell you what a differ change did. This can.

It reproduces the live run's numbers exactly — divergences, fresh buckets, noise
subtraction, request bodies and the realm sweep. If it does not, that is a bug
in one of the two and worth stopping for.

The realm sweep is on by default here because it is on in the gate, and because
**13 of the 16 findings on rateyourmusic are outside the page realm**. An
offline re-diff that skipped them would report on the wrong fifth of the gate.

Gating stays with `index.ts`. This prints; it does not decide.

## `pnpm sbxoffline --coverage` — the blind-spot report

```
guest-observable calls: 6038 compared (1445 at the scramjet layer),
                        6 intercepted and unmeasured, 4 elided (100% covered)
```

Per API, in the compared realm and over the whole run: how many guest calls the
oracle made, how many the sandbox made, and which of six things is true.

| verdict            | meaning                                                                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compared`         | both sides have guest binding calls; the differ compares them                                                                                                                          |
| `guest-op`         | scramjet intercepts it; the guest-op recorder caught the guest's view                                                                                                                  |
| `intercepted`      | scramjet intercepts it and **no guest op was recorded** — unmeasured                                                                                                                   |
| `elided`           | nobody in the sandbox called a native at all; scramjet answered from its own state                                                                                                     |
| `sandbox-only`     | only the sandbox's guest calls it                                                                                                                                                      |
| `interface-object` | `window.Node` and the other ~920. Blink installs these lazily, so the one traced access per realm is the _install_ and every read after it is untraced on both sides. Nothing to cover |

`intercepted` and `elided` are the work list. Coverage going **down** after a
scramjet change means a new interception with no guest op behind it, which reads
as a clean run — watch this number, not just the bucket count.

See [GUEST-OPS.md](GUEST-OPS.md).

## `--shots [<interval_ms>]` — a viewport strip per side

```sh
./rym.sh diff --shots 1000                 # .traces/<label>-shots/shot_NN.png
pnpm serve --wisp --open sandbox --shots    # .traces/serve-<side>-shots/
```

Passes Chromium's own `--sbxdiff-shots`, which is a browser-side
`CopyFromSurface` — no CDP session, nothing the page can see, and measurably
free (oracle 183914 ms with it against 184189 without).

It answers the one question a per-side elapsed time cannot: **is the sandbox
doing work, or waiting?** Those have opposite fixes, and the totals cannot tell
them apart because both sides pad with the same grace. On rateyourmusic the
strip is two byte-identical images a side and says the whole thing at once —
the oracle reaches the real page at t≈8 s, the sandbox at t≈124 s, and the 116
seconds in between do not change a pixel (FINDINGS #234).

`md5 -q <dir>/*.png | sort | uniq -c` is the whole analysis: a run with two
hashes has two states, and where they change is when.

Off by default — a frame a second over a 276-second run is 273 PNGs a side, and
it is diagnostic rather than part of the gate.

## `src/sbxdiff/rym.sh` — the rateyourmusic recipe

```sh
./rym.sh record       # headed, live, passes Turnstile, fills the store (slow)
./rym.sh diff         # THE GATE: oracle vs sandbox, every shared realm
./rym.sh self-check   # oracle vs a SECOND oracle: how reproducible is it?
./rym.sh baseline     # re-record the accepted-divergence baseline
./rym.sh noise        # re-record the oracle's own noise floor
./rym.sh live         # the acceptance test: live, through scramjet's transport
./rym.sh probe <url-substring> <probe.js>
```

### What the gate fails on

|                                       |                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------- |
| any **T0**                            | a guest-observable leak. Never baselined                                   |
| any **T1** in the page realm          | a guest-observable value divergence, beyond the oracle's own noise         |
| any **T0/T1** in another shared realm | the widget, the interstitial. `--all-realms`, on by default in this recipe |
| a **graded request body**             | `fo/`, `jsd/`, `SecChk` — what Cloudflare reads. T1, and never baselined   |

T2 and below are baselined. **T0 and T1 never are**, in either realm: a T1 is
the work, and a baseline is for shim overhead that will always be there. What
the oracle cannot reproduce against itself belongs in `noise.<host>.json`
(`./rym.sh noise`), which is a different claim and a different file.

### Why the body matters more than it looks

A store answers by URL and ordinal. It cannot grade a request, so Cloudflare's
`fo/` endpoint returns the recorded "you passed" whatever was posted to it. The
sandbox posts ~1400 bytes less than the oracle there and is handed success
anyway — so **the body is the one signal in the replay gate that predicts
live**. Scored against the oracle's body from the same run, never against the
recording: nobody reproduces the recording, stock Chromium included.

Anything after the subcommand is forwarded, so `./rym.sh diff --strict-bodies`
works without editing the file. `--all-realms` is already on.

`SBXDIFF_RYM_STORE` picks the store; `SBXDIFF_NO_BUILD=1` skips the
scramjet-staleness check.

## `pnpm serve` — drive a store by hand

```sh
pnpm serve --store <dir> --url <URL> --open sandbox   # the proxied page
pnpm serve --store <dir> --url <URL> --open oracle    # the page as recorded
pnpm serve --url <URL> --wisp --open sandbox          # live, scramjet's own egress
pnpm serve --url <URL> --live --open sandbox          # live, fetched through Node
```

Nothing is traced and nothing is compared. `SBXDIFF_PROBE=<path>` runs a script
at the top of every guest document.

`--live` **cannot exonerate the transport**: the request carries the browser's
`User-Agent` over Node's TLS and HTTP/2 handshake, and that mismatch is what a
bot-detection vendor fingerprints. Use `--wisp` for the real comparison.

## `src/sbxdiff/rym.sh plaintext` — Cloudflare's payload, before encryption

```sh
./rym.sh plaintext              # both sides, the Turnstile widget's realm
./rym.sh plaintext orchestrate  # the interstitial's realm instead
pnpm sbxplaintext --show o27    # one chunk in full
```

The `/fo/` body is `base64(rsa-wrapped key || xtea(lzw(json)))`, so diffing two
bodies says only that they differ. This reads the plaintext on both sides, out
of the build rym actually replays: the pipeline is JSON → LZW → XTEA → base64
and LZW reads its input character by character, so the plaintext is the receiver
of a long `charCodeAt`.

Measured on rateyourmusic: **58 of 61 chunks identical**, 3 differing, and the
16 sandbox-only ones are scramjet's own rather than findings.

Read [PAYLOAD-PLAINTEXT.md](PAYLOAD-PLAINTEXT.md) before using it — it records
which approaches do **not** work, and the two traps in reading the output.

## `tools/sbxdiff/sbxread.py` — decode a trace by hand

The reference decoder for the `.sbxd` wire format. `src/sbxdiff/trace.ts` is the
one the differ uses; this one exists so the format has a second reader.

---

## Where a run leaves things

```
src/sbxdiff/.traces/
  oracle/                 trace.<pid>.<n>.sbxd, chromium.stderr.log, logical-clock
  sandbox/                same
  <name>-store/           the network recording: one file per response
  bodydiff/<label>/       an oracle's request bodies, as bytes, + a .url sidecar
  bodydiff/*.sandbox      a real sandbox's, written flat by the store server
```

`sbxoffline` reads the `.sbxd` files, `chromium.stderr.log` and `bodydiff/`.
Keeping a run means copying all three; the next run overwrites `oracle/`,
`sandbox/` and `bodydiff/`.

`bodydiff/` is cleared once per run, and was not always: the flat `.sandbox`
files accumulated across every run the tool had ever done, and an offline
re-diff read 44 of them as bodies the sandbox had posted and the oracle had
not.

## What replay cannot check

A store answers by **URL and ordinal**. It cannot validate a request, so three
kinds of leniency are structural. All three are counted, reported, **and now
fail the run**:

| leniency        | what it hides                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| method-agnostic | a POST is answered from the same key as a GET, so Cloudflare's `fo/` endpoint returns the recorded "you passed" whatever was posted |
| past the end    | asking more times than recorded reuses the last response                                                                            |
| near match      | one differing path segment is served anyway                                                                                         |

They used to be reported only, and this page said they were counted "so they
never pass as clean" — which was true of the counting and false of the run,
because nothing read the count. A leniency is a request replay answered without
being able to grade it, so it is exactly the case the gate exists to catch.

A **shared** miss — a URL neither side could find — stays informational. That
is a gap in the recording, which is a fact about the store rather than about
the sandbox.

"The sandbox passes under replay" means: it produced the recorded request
sequence and consumed the recorded responses in order, ending at the real page,
with zero misses, zero near matches and zero past-the-end hits. It does **not**
mean it would pass a live challenge.
