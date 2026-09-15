/**
 * Every file under `client/dom`, `client/worker` and `client/shared` is a
 * MODULE, and a module has a default export.
 *
 *   node --experimental-strip-types --no-warnings --test src/sbxdiff/modules.test.ts
 *
 * `ScramjetClient.installModules` enumerates those three directories and calls
 * `module.default(this, this.global)` on everything ending in `.ts`. A plain
 * helper put there throws `module.default is not a function` in every realm,
 * once per realm -- and the loop catches it and carries on, so nothing fails:
 * the gate stays green and the only evidence is console output, which is itself
 * a divergence the oracle does not have.
 *
 * `shared/wrap.ts` has carried a comment warning about this for a while.
 * `shared/rewritecache.ts` was written into that directory anyway and produced
 * 26 throws a run, nine of them inside Cloudflare's blob workers, before anyone
 * noticed (FINDINGS.md #252). A comment that has been ignored once is a comment
 * that will be ignored again, so this is the same rule with a test behind it.
 *
 * Lives in runway because that is where the test runner is; it reads core's
 * source as data and imports nothing from it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const CORE_CLIENT = path.resolve(
	import.meta.dirname,
	"../../../core/src/client"
);

/** The three directories `installModules` enumerates. */
const MODULE_DIRS = ["dom", "worker", "shared"];

function tsFilesUnder(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
		else if (entry.endsWith(".ts")) out.push(full);
	}

	return out;
}

test("every module under dom/, worker/ and shared/ has a default export", () => {
	const offenders: string[] = [];
	for (const name of MODULE_DIRS) {
		const dir = path.join(CORE_CLIENT, name);
		for (const file of tsFilesUnder(dir)) {
			const src = readFileSync(file, "utf8");
			// Deliberately textual. Importing the module would need the whole
			// client bundle and a DOM, and the loader's own test is equally
			// shallow: it reads `.default` off whatever the context hands back.
			if (!/^export default/m.test(src)) {
				offenders.push(path.relative(CORE_CLIENT, file));
			}
		}
	}

	assert.deepEqual(
		offenders,
		[],
		`these are enumerated by installModules and called as ` +
			`module.default(client, global), so each throws once per realm:\n  ` +
			offenders.join("\n  ") +
			`\n\nA helper that is not a module belongs beside client/helpers.ts, ` +
			`not under one of these directories.`
	);
});

test("the directories this guards are the ones installModules reads", () => {
	// If `installModules` starts enumerating a fourth directory, or stops
	// reading one of these, the test above silently guards the wrong set. This
	// pins the list to the source rather than to this file's memory of it.
	const client = readFileSync(path.join(CORE_CLIENT, "client.ts"), "utf8");
	for (const name of MODULE_DIRS) {
		assert.ok(
			client.includes(`"./${name}/"`),
			`installModules no longer mentions "./${name}/" -- update MODULE_DIRS`
		);
	}
});
