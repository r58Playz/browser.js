/** Starts the three servers and leaves them running, for manual inspection. */
import express from "express";
import path from "node:path";
import { startHarness, PORT } from "../harness/scramjet/index.ts";
import { startBareHarness, BARE_PORT } from "../harness/bare/index.ts";

const HERE = import.meta.dirname;
const app = express();
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
