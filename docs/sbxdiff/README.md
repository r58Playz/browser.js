# sbxdiff docs

A patched-Chromium differential oracle for the browser.js/scramjet sandbox: run a site
in unmodified Chromium and in the sandbox, and report every divergence in the
guest-observable universe.

| Doc                                            | What it is                                                                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [INTEGRATION.md](INTEGRATION.md)               | **Start here to write the differ**: how to run it, what a trace contains, which realms are deterministic, and the known gaps |
| [SCRAMJET-HARNESS.md](SCRAMJET-HARNESS.md)     | The scramjet-side harness: running a page in both worlds, the guest-observation layer, and the regression results            |
| [ARCHITECTURE.md](ARCHITECTURE.md)             | The seam, the trace format, the differ                                                                                       |
| [DETERMINISM.md](DETERMINISM.md)               | Every nondeterminism source, its pin, and how to verify the pin                                                              |
| [RULES.md](RULES.md)                           | Invariants. Read before changing anything                                                                                    |
| [FLAGS.md](FLAGS.md)                           | The canonical command line, and why each flag is there                                                                       |
| [CHROMIUM-PATCHES.md](CHROMIUM-PATCHES.md)     | Every local Chromium modification and why                                                                                    |
| [PINNED_ASSUMPTIONS.md](PINNED_ASSUMPTIONS.md) | Facts true only at Chromium 155 that a roll can break silently                                                               |
| [PROGRESS.md](PROGRESS.md)                     | Measured gate results, per milestone                                                                                         |
| [DECISIONS.md](DECISIONS.md)                   | ADR-style log, including rejected alternatives                                                                               |
| `patches/`                                     | The Chromium patch set. `all.patch` is authoritative; `regen.sh` rebuilds and verifies it                                    |
| `tools/sbxdiff/`                               | `sbxread.py` decodes a trace directory; `p4gate.sh` is the randomness gate                                                   |

Writing the differ: **INTEGRATION.md**. Changing the Chromium side:
**ARCHITECTURE.md**, then **RULES.md**.

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
sides cannot agree on, reported apart from hits so it never passes as clean.

## Status

The oracle side is working. On the current binary:

|                 |                                                                                 |
| --------------- | ------------------------------------------------------------------------------- |
| randomness      | same run key ×5 → identical draws                                               |
| clock           | `Date.now()` exact; `performance.*` origin jitters ~1.7 ms                      |
| network         | full record and replay; a replayed run never touches the network                |
| determinism     | 3 replayed runs byte-identical in the page realm                                |
| undetectability | rateyourmusic.com passes Cloudflare Turnstile under full tracing, automatically |

The scramjet side works too, on the same page:

```
oracle : 17 file(s), 394273 records
sandbox: 17 file(s), 462845 records
3827 divergence(s), 0 T0 leak(s)          T2 819, T4 1 -- no T0, no T1
```

scramjet passes the Cloudflare managed challenge under replay and reaches the
real page. Three reverted scramjet fixes were all detected against a stable
baseline, including one with no leak marker in it at all. Finding the seven
defects between the sandbox and that widget is written up in
[SCRAMJET-HARNESS.md](SCRAMJET-HARNESS.md); the invariants they produced are
RULES.md #51-#60.
