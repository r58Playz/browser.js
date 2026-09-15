# The tools

One page, one entry per thing you can run. Everything runs from
`packages/scramjet/packages/runway`.

If you are trying to answer a question rather than run a command, the question
is probably one of these:

| question                                                    | tool                         |
| ----------------------------------------------------------- | ---------------------------- |
| does the sandbox diverge from real Chromium on this site?   | `rym.sh diff`                |
| I changed the differ — did it change the answer?            | `pnpm sbxoffline`            |
| what is the differ not even looking at?                     | `pnpm sbxoffline --coverage` |
| is this divergence the sandbox, or the oracle's own noise?  | `rym.sh self-check`          |
| does it work live, which is the actual goal?                | `rym.sh live`                |
| what does this page actually do, by hand?                   | `pnpm serve`                 |
| what does one line of JS see, inside the site's own script? | `rym.sh probe`               |

---

## `pnpm sbxoffline` — re-diff, without a browser

```sh
pnpm sbxoffline                            # .traces/oracle vs .traces/sandbox
pnpm sbxoffline --coverage                 # and what the diff cannot see
pnpm sbxoffline --all-realms               # realms both sides have
pnpm sbxoffline --realm challenges         # scope to one
pnpm sbxoffline --oracle <dir> --sandbox <dir>
pnpm sbxoffline --url <URL>                # which target's realm/baseline to use
pnpm sbxoffline --no-baseline              # show everything, suppress nothing
```

Reads the traces the last run left on disk and diffs them again. **1 second
against 110**, and against _fixed_ bytes — which is the part that matters. Two
live runs differ from each other as well as from your change, so a live run
cannot tell you what a differ change did. This can.

It reproduces the live run's numbers exactly. If it does not, that is a bug in
one of the two and worth stopping for.

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
kinds of leniency are structural, and all three are counted and reported so they
never pass as clean:

| leniency        | what it hides                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| method-agnostic | a POST is answered from the same key as a GET, so Cloudflare's `fo/` endpoint returns the recorded "you passed" whatever was posted |
| past the end    | asking more times than recorded reuses the last response                                                                            |
| near match      | one differing path segment is served anyway                                                                                         |

"The sandbox passes under replay" means: it produced the recorded request
sequence and consumed the recorded responses in order, ending at the real page,
with zero misses, zero near matches and zero past-the-end hits. It does **not**
mean it would pass a live challenge.
