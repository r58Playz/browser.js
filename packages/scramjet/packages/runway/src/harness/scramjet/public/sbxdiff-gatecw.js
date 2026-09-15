/**
 * Turn on the `contentWindow` gating experiment (FINDINGS.md #251).
 *
 * Off in every ordinary build. Set here rather than behind a config flag
 * because it is not a feature -- it is a switch for one measurement:
 * gating `contentWindow` closes the window-identity set RULES #191 asks for and
 * hangs the sandbox, and this is how to watch it hang with the logs on.
 *
 *     SBXDIFF_PROBE=/sbxdiff-gatecw.js SBXDIFF_VERBOSE=1 \
 *       pnpm serve --store <store> --url <url> --open sandbox --shots 1000
 */
globalThis[Symbol.for("sbxdiff.gate-contentwindow")] = true;
try {
	console.info("sbxdiff-gatecw: contentWindow gating ON");
} catch (err) {
	/* no console */
}
