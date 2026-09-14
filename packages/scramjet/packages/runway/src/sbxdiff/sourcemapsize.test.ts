/**
 * The size arithmetic that un-does the rewriter.
 *
 * A resource's reported size is the REWRITTEN size, and the challenge scripts
 * that measure their own bundle read it. The sourcemap the rewriter pushes
 * says exactly what it added, so the original is recoverable -- but only if
 * every byte is accounted for, including the bytes of the push call itself,
 * which is prepended after the map is built and therefore appears in no
 * rewrite. That omission is worth 15390 bytes on rateyourmusic's challenge
 * script, so it is the case these tests exist for.
 *
 *   node --experimental-strip-types --no-warnings --test src/sbxdiff/sourcemapsize.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	INSERT,
	REPLACE,
	originalSize,
	preludeBytes,
	rewriteOverhead,
	type SizedRewrite,
} from "../../../core/src/shared/sourcemapsize.ts";

const insert = (size: number): SizedRewrite => ({ type: INSERT, size });
const replace = (start: number, end: number, oldLen: number): SizedRewrite => ({
	type: REPLACE,
	start,
	end,
	oldLen,
});

test("no rewrites means the size is already the site's", () => {
	assert.equal(originalSize([], 4096), 4096);
});

test("an insertion is subtracted", () => {
	assert.equal(originalSize([insert(10)], 100), 90);
});

test("a replacement costs only what it GREW", () => {
	// `fetch` -> `$scramjet$fetch`: 15 new bytes for 5 old ones.
	assert.equal(originalSize([replace(0, 15, 5)], 115), 105);
});

test("a rewrite that SHRANK the file is counted but not trusted", () => {
	// The overhead is honestly negative...
	assert.equal(rewriteOverhead([replace(0, 2, 5)]), -3);
	// ...but "the original was bigger than what arrived" is also exactly what
	// a mismatched map looks like, and that one can inflate without bound.
	// Scramjet's replacements only ever expand, so clamping costs nothing
	// real and keeps a corrupt map from reporting a size the site never had.
	assert.equal(originalSize([replace(0, 2, 5)], 100), 100);
});

test("rewrites accumulate", () => {
	const rewrites = [insert(10), replace(0, 15, 5), insert(7)];
	assert.equal(rewriteOverhead(rewrites), 27);
	assert.equal(originalSize(rewrites, 1027), 1000);
});

test("oldLen is bytes, not UTF-16 code units", () => {
	// "é" is one code unit and two bytes. Using `.length` here would report
	// 1 and leave the recovered size one byte heavy -- per non-ASCII rewrite.
	const bytes = new TextEncoder().encode("é").length;
	assert.equal(bytes, 2);
	assert.equal(originalSize([replace(0, 10, bytes)], 108), 100);
});

test("the prelude is subtracted on top of the map", () => {
	assert.equal(originalSize([insert(10)], 100, 40), 50);
});

test("prelude bytes match the string js.ts prepends", () => {
	const buf = [1, 2, 3];
	const call = `__scramjet$pushsourcemap([1,2,3], "abc", []);`;

	assert.equal(
		preludeBytes("__scramjet$pushsourcemap", buf, "abc"),
		call.length
	);
});

test("the prelude occupies no line of its own", () => {
	// Load-bearing, and not just an economy: a prelude that ends in a newline
	// pushes every line of the script down by one, and an error thrown in a
	// rewritten script then reports a line number one greater than the one the
	// site served. Cloudflare captures a stack at `turnstile.render` and posts
	// it, for a script it serves and knows the offsets of.
	const call = `f([1,2,3], "t", []);`;
	assert.equal(preludeBytes("f", [1, 2, 3], "t"), call.length);
	assert.ok(!call.includes("\n"));
});

test("prelude bytes count the line table the rewriter ships", () => {
	// The table is an argument of the same call, so a prelude measured without
	// it is short by exactly its serialisation -- and the prelude is what gets
	// subtracted from the reported resource size.
	const call = `f([1], "t", [10,20,30]);`;
	assert.equal(preludeBytes("f", [1], "t", [10, 20, 30]), call.length);
});

test("prelude bytes count a typed array the same as an array", () => {
	// `registerRewrites` receives the map as a plain array, but the rewriter
	// builds it from a Uint8Array; both have to measure identically.
	const buf = [200, 1, 45];
	assert.equal(
		preludeBytes("f", Uint8Array.from(buf), "t"),
		preludeBytes("f", buf, "t")
	);
});

test("a map that does not describe the body reports the size unchanged", () => {
	// Claiming the original was negative, or somehow bigger than what
	// arrived, means the map belongs to a different script. An uncorrected
	// number is at least the one every other proxy reports.
	assert.equal(originalSize([insert(500)], 100), 100);
	assert.equal(originalSize([replace(0, 0, 500)], 100), 100);
	assert.equal(originalSize([insert(100)], 100), 100);
});

test("the measured rateyourmusic script recovers its served size", () => {
	// The real numbers: 113793 bytes arrived, the map accounted for 11800 of
	// them and the push call for 15390, leaving the 86603 the oracle saw.
	const rewrites = [insert(11800)];
	assert.equal(originalSize(rewrites, 113793, 15390), 86603);
});
