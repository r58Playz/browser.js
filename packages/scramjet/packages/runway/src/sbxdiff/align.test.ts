/**
 * Calls are paired by position within an API, so one extra call on either side
 * shifts every pairing after it.
 *
 * The "divergences" that follow are two unrelated calls held up next to each
 * other. Measured on rateyourmusic: `Element.tagName.get` reported oracle
 * "BODY" against sandbox "SCRIPT" twenty-seven times, which is not a divergence
 * -- it is the comparison having lost its place. Four of the six T1 buckets
 * there were that, and T1 is a tier the run is judged on.
 *
 * A count mismatch is already reported on its own. What it must not do is lend
 * its drift the authority of T1. A LEAK is the exception and keeps its tier:
 * that classification looks only at the sandbox's own string -- a proxy URL is
 * a proxy URL whoever it was paired against -- so drift cannot invent one.
 *
 *   node --experimental-strip-types --no-warnings --test src/sbxdiff/align.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { diff, type Side } from "./diff.ts";
import { Kind, type Trace } from "./trace.ts";

const str = (s: string) => ({ t: 4, len: s.length, s, truncated: false });

const call = (seq: number, name: string, result: unknown) =>
	({
		kind: Kind.BindingCall,
		level: 0,
		seq,
		realm: 1,
		task: 0,
		name,
		threw: false,
		// script 1 is classified "guest" below, so these are guest-direct and
		// eligible for T0/T1 -- without that everything is T2 and the test
		// would pass for the wrong reason.
		topScript: 1,
		entryScript: 1,
		recv: { t: 0 },
		result,
		argcTotal: 0,
		args: [],
	}) as never;

const side = (calls: unknown[]): Side => ({
	trace: {
		file: "t.sbxd",
		version: 1,
		pid: 1,
		runKey: 1,
		realms: new Map([[1, "https://site.example/"]]),
		scripts: new Map([[1, "https://site.example/app.js"]]),
		records: calls as never,
		truncatedBytes: 0,
	} satisfies Trace,
	realm: 1,
	url: "https://site.example/",
	reqBodies: new Map(),
});

const opts = {
	markers: {
		chromeOrigin: "http://localhost:4500",
		proxyPrefix: "/~/sj/",
		shimIdentifiers: ["$scramjet"],
	},
	oracleAttribution: { classes: new Map([[1, "guest" as const]]) },
	sandboxAttribution: { classes: new Map([[1, "guest" as const]]) },
};

test("equal-length sequences produce a T1 value divergence", () => {
	const d = diff(
		side([call(1, "Element.tagName.get", str("BODY"))]),
		side([call(1, "Element.tagName.get", str("DIV"))]),
		opts
	);
	const v = d.filter((x) => x.api === "Element.tagName.get");
	assert.equal(v.length, 1);
	assert.equal(v[0].tier, "T1", "a real pair is judged");
});

test("a count mismatch keeps its value divergences out of T1", () => {
	// The sandbox makes one call more, so every pairing after the first is two
	// unrelated calls. The count difference is reported on its own; the values
	// must not be.
	const d = diff(
		side([
			call(1, "Element.tagName.get", str("BODY")),
			call(2, "Element.tagName.get", str("DIV")),
		]),
		side([
			call(1, "Element.tagName.get", str("SCRIPT")),
			call(2, "Element.tagName.get", str("BODY")),
			call(3, "Element.tagName.get", str("DIV")),
		]),
		opts
	);
	const valued = d.filter(
		(x) => x.api === "Element.tagName.get" && x.kind === "value-divergence"
	);
	assert.ok(valued.length > 0, "the drifted pairs are still reported");
	assert.ok(
		valued.every((x) => x.tier === "T2"),
		`drifted pairs must not reach T1, got ${valued.map((x) => x.tier).join(",")}`
	);
	// And the count difference itself is still said out loud.
	assert.ok(
		d.some((x) => x.api === "Element.tagName.get" && x.kind.endsWith("-call"))
	);
});

test("a leak keeps its tier even when the counts drift", () => {
	// The classification looks at the sandbox's own string, not at the pair, so
	// misalignment cannot invent one -- and must not suppress one either.
	const d = diff(
		side([call(1, "Location.href.get", str("https://site.example/a"))]),
		side([
			call(1, "Location.href.get", str("https://site.example/a")),
			call(
				2,
				"Location.href.get",
				str("http://localhost:4500/~/sj/ctx/https%3A%2F%2Fsite.example%2Fb")
			),
		]),
		opts
	);
	assert.ok(
		d.some((x) => x.tier === "T0"),
		"a proxy URL the guest read is a leak however the sequences line up"
	);
});
