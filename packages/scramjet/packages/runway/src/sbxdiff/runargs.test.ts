/**
 * The run reads its results out of Chromium's stderr, so the flag that puts
 * them there is not optional.
 *
 * The oracle's request-body hashes are `LOG(WARNING)` lines from the replay
 * loader; the sandbox's per-request log is `console.info` from the store
 * transport. Neither reaches stderr without `--enable-logging=stderr`. It used
 * to be behind SBXDIFF_VERBOSE, and the failure that caused is the reason this
 * file exists: a run without that variable saw no oracle bodies at all, so
 * every request the sandbox made came out as "oracle (none sent)" -- seven
 * divergences reported by an instrument that was simply switched off.
 *
 *   node --experimental-strip-types --no-warnings --test src/sbxdiff/runargs.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { baseArgs } from "./run.ts";

const opts = {
	url: "http://localhost:4510/probe.html",
	traceDir: "/tmp/sbxdiff-test",
	runKey: 1,
};

test("stderr logging is on whether or not SBXDIFF_VERBOSE is set", () => {
	const was = process.env.SBXDIFF_VERBOSE;
	try {
		delete process.env.SBXDIFF_VERBOSE;
		const quiet = baseArgs(opts as never, "/tmp/sbxdiff-profile");
		assert.ok(
			quiet.includes("--enable-logging=stderr"),
			"the oracle's body hashes are stderr WARNING lines; without this the " +
				"run reports every request as 'oracle (none sent)'"
		);
		// The firehose stays optional: every URLRequest and every virtual-time
		// pauser, which is for reading by hand, not for the report.
		assert.ok(!quiet.includes("--v=1"));

		process.env.SBXDIFF_VERBOSE = "1";
		const loud = baseArgs(opts as never, "/tmp/sbxdiff-profile");
		assert.ok(loud.includes("--enable-logging=stderr"));
		assert.ok(loud.includes("--v=1"));
	} finally {
		if (was === undefined) delete process.env.SBXDIFF_VERBOSE;
		else process.env.SBXDIFF_VERBOSE = was;
	}
});

test("the URL stays last", () => {
	// Chromium takes the positional URL as the page to open; a flag appended
	// after it is read as a second URL and opens a second tab. The logging
	// flags were originally spliced in before the last element for exactly
	// this reason, so a test that only checked "includes" would not have
	// noticed them moving to the end.
	const args = baseArgs(opts as never, "/tmp/sbxdiff-profile");
	assert.equal(args.at(-1), opts.url);
});
