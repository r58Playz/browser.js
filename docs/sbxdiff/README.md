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

## Status

The oracle side is working. On the current binary:

|                 |                                                                                 |
| --------------- | ------------------------------------------------------------------------------- |
| randomness      | same run key ×5 → identical draws                                               |
| clock           | `Date.now()` exact; `performance.*` origin jitters ~1.7 ms                      |
| network         | full record and replay; a replayed run never touches the network                |
| determinism     | 3 replayed runs byte-identical in the page realm                                |
| undetectability | rateyourmusic.com passes Cloudflare Turnstile under full tracing, automatically |

The scramjet side runs too: one page in bare Chromium vs. inside scramjet,
diffed at the guest-observation layer. Three reverted scramjet fixes were all
detected against a stable baseline, including one with no leak marker in it at
all. See [SCRAMJET-HARNESS.md](SCRAMJET-HARNESS.md).

Next: guest/shim attribution (plan P6), which is what would let the binding
layer produce a verdict rather than context.
