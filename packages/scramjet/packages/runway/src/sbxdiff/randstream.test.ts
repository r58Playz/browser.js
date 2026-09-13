/**
 * Every pinned draw needs its OWN keystream, and the registry that hands them
 * out has to stay consistent with the call sites.
 *
 * The per-thread automatic stream shares one counter with all of Chromium's
 * internal draws on that thread, so a draw's value depends on how many
 * unrelated draws happened first -- which varies run to run. A pinned PRNG with
 * a shared counter is not pinned (RULES.md #77). That single mistake produced
 * four separate divergences in this project, each of which looked like its own
 * bug:
 *
 *   the multipart form boundary   2450-byte bodies agreeing on 4 bytes
 *   TimeClamper's secret          every timestamp off by one 100us bucket
 *   blob URL UUIDs                a different worker URL in each oracle run
 *   the mDNS `<uuid>.local` name  a different ICE candidate in each run
 *
 * Two ways this silently breaks, both checked here: an id used by two call
 * sites (they share a counter again, which is the original bug back), and a
 * call site that draws without entering any stream at all.
 *
 *   node --experimental-strip-types --no-warnings --test src/sbxdiff/randstream.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const CHROMIUM_SRC = path.resolve(
	import.meta.dirname,
	"../../../../../../../src"
);
const HEADER = path.join(CHROMIUM_SRC, "base/sbxdiff_rand_stream.h");

/** Every call site that enters an explicit stream, and the id it uses. */
const CALL_SITES: Record<string, string> = {
	"third_party/blink/renderer/modules/crypto/crypto.cc":
		"kSbxdiffStreamWebCrypto",
	"third_party/blink/renderer/platform/network/form_data_encoder.cc":
		"kSbxdiffStreamFormBoundary",
	"third_party/blink/renderer/core/timing/time_clamper.cc":
		"kSbxdiffStreamTimeClamper",
	"third_party/blink/renderer/platform/blob/blob_url.cc":
		"kSbxdiffStreamBlobUuid",
	"services/network/mdns_responder.cc": "kSbxdiffStreamMdnsName",
};

function declaredIds(): Map<string, number> {
	const src = readFileSync(HEADER, "utf8");
	const out = new Map<string, number>();
	for (const m of src.matchAll(/^\s*(kSbxdiffStream\w+)\s*=\s*(\d+),/gm)) {
		out.set(m[1]!, Number(m[2]));
	}
	return out;
}

test("every explicit stream id is distinct", () => {
	const ids = declaredIds();
	assert.ok(ids.size >= 5, `only found ${ids.size} stream ids`);
	const seen = new Map<number, string>();
	for (const [name, value] of ids) {
		const clash = seen.get(value);
		assert.equal(
			clash,
			undefined,
			`${name} and ${clash} are both stream ${value}, so they share a counter -- which is the bug these streams exist to prevent`
		);
		seen.set(value, name);
	}
});

test("explicit ids stay below the first automatic one", () => {
	const src = readFileSync(HEADER, "utf8");
	const first = /kSbxdiffFirstAutoStream\s*=\s*(\d+)/.exec(src);
	assert.ok(first, "kSbxdiffFirstAutoStream is gone");
	const auto = Number(first[1]);
	for (const [name, value] of declaredIds()) {
		if (name === "kSbxdiffFirstAutoStream") continue;
		assert.ok(
			value < auto,
			`${name} is ${value}, at or past the automatic range (${auto}) -- it would collide with a per-thread stream`
		);
	}
});

test("each call site uses a declared id, and no two share one", () => {
	const ids = declaredIds();
	const byId = new Map<string, string>();
	for (const [file, id] of Object.entries(CALL_SITES)) {
		const src = readFileSync(path.join(CHROMIUM_SRC, file), "utf8");
		assert.ok(
			ids.has(id),
			`${file} enters ${id}, which is not declared in sbxdiff_rand_stream.h`
		);
		assert.ok(
			src.includes(`base::${id}`),
			`${file} no longer enters ${id} -- if the draw moved, the stream has to move with it, or it is back on the shared counter`
		);
		const other = byId.get(id);
		assert.equal(
			other,
			undefined,
			`${file} and ${other} both use ${id}, so they share a counter`
		);
		byId.set(id, file);
	}
});

test("a call site that draws does not do it outside a stream", () => {
	// The failure this catches: someone adds a base::RandBytes/RandUint64 next
	// to the guarded one and it lands on the shared per-thread counter, which
	// reintroduces exactly the shift the stream removed -- and nothing about
	// the code looks wrong.
	for (const [file, id] of Object.entries(CALL_SITES)) {
		const src = readFileSync(path.join(CHROMIUM_SRC, file), "utf8");
		const draws = [...src.matchAll(/base::Rand(Bytes|Uint64)\b/g)].length;
		const scopes = [...src.matchAll(/SbxdiffScopedRandStream/g)].length;
		if (draws === 0) continue;
		assert.ok(
			scopes >= 1,
			`${file} draws ${draws} time(s) and enters no stream`
		);
		assert.ok(
			draws <= scopes,
			`${file} has ${draws} draw(s) but only ${scopes} stream scope(s) for ${id} -- an unguarded draw is back on the shared counter`
		);
	}
});
