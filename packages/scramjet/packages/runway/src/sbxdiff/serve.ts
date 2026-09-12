/** Starts the three servers and leaves them running, for manual inspection. */
import express from "express";
import path from "node:path";
import { startHarness, PORT } from "../harness/scramjet/index.ts";
import { startBareHarness, BARE_PORT } from "../harness/bare/index.ts";
import { loadStore, mountStoreEndpoint } from "./store.ts";

const HERE = import.meta.dirname;
const app = express();
// The same endpoint the driver mounts. Without it a manual run fails with a
// CORS error from a 404, which looks like a transport bug rather than a
// missing route.
const store = await loadStore(
	process.env.SBXDIFF_STORE ?? path.join(HERE, ".traces", "store")
);
mountStoreEndpoint(app, store, []);
console.log(`    store endpoint: ${store.size} response(s)`);
app.use(express.static(path.join(HERE, "pages")));
app.get("/asset.png", (_q, r) =>
	r
		.type("png")
		.send(
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
				"base64"
			)
		)
);
await new Promise<void>((r) => app.listen(4510, r));
await startHarness();
await startBareHarness();
const target = encodeURIComponent("http://localhost:4510/probe.html");
console.log(`\n  scramjet: http://localhost:${PORT}/#${target}`);
console.log(`  bare    : http://localhost:${BARE_PORT}/#${target}\n`);
await new Promise(() => {});
