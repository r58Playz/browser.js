# sbxdiff docs

A patched-Chromium differential oracle for the browser.js/scramjet sandbox: run a site
in unmodified Chromium and in the sandbox, and report every divergence in the
guest-observable universe.

| Doc                                            | What it is                                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [TOOLS.md](TOOLS.md)                           | **Start here to run something**: one entry per tool, and which question each answers                              |
| [GUEST-OPS.md](GUEST-OPS.md)                   | **Start here to trust a result**: the scramjet layer, what it covers, and the four things it structurally cannot  |
| [INTEGRATION.md](INTEGRATION.md)               | How to run the differ, what a trace contains, which realms are deterministic, and the known gaps                  |
| [SCRAMJET-HARNESS.md](SCRAMJET-HARNESS.md)     | The scramjet-side harness: running a page in both worlds, the guest-observation layer, and the regression results |
| [ARCHITECTURE.md](ARCHITECTURE.md)             | The seam, the trace format, the differ                                                                            |
| [DETERMINISM.md](DETERMINISM.md)               | Every nondeterminism source, its pin, and how to verify the pin                                                   |
| [RULES.md](RULES.md)                           | Invariants. Read before changing anything                                                                         |
| [FLAGS.md](FLAGS.md)                           | The canonical command line, and why each flag is there                                                            |
| [CHROMIUM-PATCHES.md](CHROMIUM-PATCHES.md)     | Every local Chromium modification and why                                                                         |
| [PINNED_ASSUMPTIONS.md](PINNED_ASSUMPTIONS.md) | Facts true only at Chromium 155 that a roll can break silently                                                    |
| [PROGRESS.md](PROGRESS.md)                     | Measured gate results, per milestone                                                                              |
| [DECISIONS.md](DECISIONS.md)                   | ADR-style log, including rejected alternatives                                                                    |
| `patches/`                                     | The Chromium patch set. `all.patch` is authoritative; `regen.sh` rebuilds and verifies it                         |
| `tools/sbxdiff/`                               | `sbxread.py` decodes a trace directory; `p4gate.sh` is the randomness gate                                        |

Running something: **TOOLS.md**. Reading a result: **GUEST-OPS.md**. Changing the
Chromium side: **ARCHITECTURE.md**, then **RULES.md**.

RULES.md is 219 numbered rules in one flat list, appended to over the life of
the project, and some of them retract earlier ones (219 retracts 218; 214
corrects 212; 217 corrects 209). A rule's number is not evidence that it still
holds. Read it as a lab notebook, not a specification.

## The process, end to end

Everything runs from `packages/scramjet/packages/runway`.

### 1. Record a store

```sh
src/sbxdiff/rym.sh record          # or: pnpm sbxdiff --url <URL> --headed \
                                   #       --no-virtual-time --store-out <dir>
```

One headed run against the **live** site, writing every response to
`src/sbxdiff/.traces/rym-store` (override with `SBXDIFF_RYM_STORE`). Headed and
on a real clock deliberately: the challenge is the fragile part and this is the
one run that has to succeed, so it is not given a pinned clock to notice.

A record writes `sbxdiff-time-base.json` alongside the bodies. Recorded bytes
are not timeless — a challenge embeds tokens minted at capture time and checks
them against the device clock — so replay adopts that clock.

It prints what it captured, including every URL that returned more than one
body. That is the check that the whole journey landed rather than just the
destination. A good rateyourmusic store has three entries for the root:

```
403:5920, 403:6091, 200:402435   https://rateyourmusic.com/
```

Two challenge instances, because `Critical-CH` makes Chromium restart the
navigation and throw the first one away, then the real page.

### 2. Diff it

```sh
src/sbxdiff/rym.sh diff
pnpm sbxdiff                       # the probe page, the default gate
pnpm sbxdiff --page csp.html       # one of the focused probes
```

Two runs of the patched binary against the same store — unmodified Chromium
(the **oracle**) and the page inside scramjet (the **sandbox**) — compared at
the guest-observation layer. Divergences are bucketed into tiers; only **T0**,
a guest-observable leak, fails unconditionally.

`baseline.<host>[.<page>].json` holds the buckets already known and accepted, so
a run reports only what is new. Re-record it with `--baseline` after a change
you have decided is correct.

### 2b. Re-diff it without a browser

```sh
pnpm sbxoffline                    # re-read .traces/oracle and .traces/sandbox
pnpm sbxoffline --coverage         # and what the diff cannot see
```

A run leaves everything the differ needs on disk, so a change to the differ can
be measured against the SAME bytes in about a second instead of two headed
browser runs. It reproduces the live run's numbers exactly; if it does not, one
of the two is wrong and that is worth stopping for.

`--coverage` is the number to watch. It says, per API, whether the differ is
comparing the guest's view, comparing scramjet's answer, or not looking at all.

### 3. Check the oracle against itself

```sh
src/sbxdiff/rym.sh self-check      # or: pnpm sbxdiff --url … --self-check
src/sbxdiff/rym.sh noise           # writes noise.<host>.json, unioned
```

`--self-check` replaces the sandbox with a **second oracle run**. An oracle that
cannot reproduce its own run cannot convict the sandbox of anything, so this is
the number that licenses every other number. The floor lives in
`noise.<host>.json`, kept apart from the baseline: a baselined bucket is "known
and accepted", a noisy one is "the oracle has nothing to say".

### 4. Replay it by hand

```sh
pnpm serve --store <dir> --url <URL> --open sandbox   # the proxied page
pnpm serve --store <dir> --url <URL> --open oracle    # the page as recorded
pnpm serve --store <dir> --url <URL>                  # servers + URLs only
```

Drives a store manually — click the widget yourself, scroll, open devtools.
Nothing is traced and nothing is compared. Chromium's stderr goes to
`.traces/serve-<side>.log`; `SBXDIFF_VERBOSE=1` adds Chromium's own logging and
`SBXDIFF_HTTPLOG=1` logs harness server requests.

A manual run is on the **real clock**, deliberately: virtual time either races
ahead while you are looking at the page or freezes when its budget runs out.
That means a store recorded long ago replays under a device time its own tokens
disagree with, so `serve` prints how long ago the store was recorded and warns
past an hour.

### 5. Ask whether it works outside replay

```sh
pnpm serve --url <URL> --wisp --open sandbox   # scramjet's own transport, live
pnpm serve --url <URL> --live --open sandbox   # fetched through Node, live
```

Neither is hermetic and neither is a differ input; both answer one question,
"does this work without the store". `--wisp` is scramjet's shipped egress —
libcurl over a WebSocket, TLS inside the page. `--live` replaces that with a
Node-side fetch through `POST /__sbxdiff/live`, so the same `ProxyTransport`
seam carries plain bytes and none of that machinery is in the picture.

**`--live` cannot exonerate the transport**, and it is worth knowing why before
using it on an anti-bot site. The request still carries the browser's
`User-Agent`, but the TLS and HTTP/2 handshake is now Node's. That mismatch is
precisely what a bot-detection vendor fingerprints, so a failure under `--live`
may be a property of the experiment rather than of the sandbox. Use `--wisp` for
the real comparison; `--live` is for sites that do not care.

Both accept `--click`/`--click-frame`, which turn on the in-binary runner, so a
manual session can reproduce the automated one with no hand on the mouse. That
also means the browser quits after `--grace` (10 minutes by default).

Measured on rateyourmusic, both loop: the challenge runs its full cycle, posts
~820 KB of fingerprint data to `fo/`, is issued a `cf_clearance` cookie, sends
it back on the next request — and gets a fresh 403. Replay passes; neither live
path did in a ~70 s run. So the wisp transport is **not** what stops it.

### Reading a result

| Tier  | Meaning                                                                      |
| ----- | ---------------------------------------------------------------------------- |
| T0    | The guest itself observed a sandbox artifact. Never baselined; always fails. |
| T1    | Guest-observable value divergence.                                           |
| T2    | Divergence below the guest-observation layer — mostly shim overhead.         |
| T3/T4 | Structural, informational.                                                   |

`store miss(es)` means the sandbox asked for bytes the oracle never fetched —
a divergence, not an error. `near match(es)` means one path segment differed and
the store served the one candidate anyway; that is a client-minted id the two
sides cannot agree on. `past-the-end hit(s)` means the page asked for a URL more
times than the recording did and was served the last response again. All three
are reported apart from hits so they never pass as clean.

### What replay cannot check

A store answers by **URL and ordinal**. It does not and cannot validate a
request, so three kinds of leniency are structural:

| Leniency            | What it hides                                                                                                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Method-agnostic** | A POST is answered from the same key as a GET. Cloudflare's `fo/` endpoint receives ~820 KB of fingerprint data and the store answers regardless of what was posted — so a wrong answer still gets the recorded "you passed".                                  |
| **Past the end**    | Asking more times than recorded reuses the last response. For a site whose last recorded response is the destination, a page stuck in a retry loop would be handed that destination. **Counted and reported**, so it can be told apart from actually arriving. |
| **Near match**      | One differing path segment is served anyway. Counted and reported.                                                                                                                                                                                             |

So "the sandbox passes the challenge under replay" means: it produced the
recorded request sequence and consumed the recorded responses **in order**,
ending at the real page, with zero misses, zero near matches and zero
past-the-end hits. It does **not** mean it would pass a live challenge — see
step 5, where it does not.

## Status

The oracle side is working. On the current binary:

|                 |                                                                                 |
| --------------- | ------------------------------------------------------------------------------- |
| randomness      | same run key ×5 → identical draws                                               |
| clock           | `Date.now()` exact; `performance.*` origin jitters ~1.7 ms                      |
| network         | full record and replay; a replayed run never touches the network                |
| determinism     | 3 replayed runs byte-identical in the page realm                                |
| undetectability | rateyourmusic.com passes Cloudflare Turnstile under full tracing, automatically |

The scramjet side is measured, and what it measures changed:

```
oracle : 326856 records        sandbox: 537560 records
guest ops: 8606 recorded, 4997 in the compared realm
guest-observable calls: 6020 compared (1427 at the scramjet layer),
                        24 intercepted and unmeasured (99% covered)
253 divergence(s), 32 bucket(s) not in the baseline, 0 T0 leak(s)
```

Until the guest-op layer existed, **76%** of the guest-observable calls in the
page realm were compared and the rest were invisible: scramjet's trap is what
the guest talks to, so an intercepted API contributed nothing to the sandbox's
side of the diff and arrived as `T2|missing-call`. 663 of the 838 buckets in
`baseline.rateyourmusic.com.json` are that shape. "0 T0 leaks" was a statement
about the APIs scramjet does not touch — which are the ones it cannot be wrong
about. See [GUEST-OPS.md](GUEST-OPS.md).

Two things the numbers above still do **not** cover, and both are large:

- **The compared realm is 2% of the run.** Cloudflare's fingerprinting happens in
  the Turnstile widget's realm and in eight blob workers, none of which the
  default diff looks at. `--all-realms` reports them; it does not gate on them.
- **The guest-op recorder needs a `document`,** so those eight workers have no
  scramjet-layer record at all.

The sandbox does reach the real page under replay, consuming the recorded
responses in order with zero misses, zero near matches and zero past-the-end
hits. It posts a **different** fingerprint payload to the five requests
Cloudflare actually grades (-1899 and -1909 bytes on `fo/`), and the store
answers them anyway — so that is not evidence it would pass live, and it does
not: both live transports loop. See "What replay cannot check".
