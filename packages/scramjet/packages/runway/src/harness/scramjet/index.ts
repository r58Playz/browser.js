import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve paths relative to the package root (runway/)
const packageRoot = path.resolve(__dirname, "../../..");

export const PORT = 4500;
export const WISP_PORT = 4501;

export async function startHarness() {
	const app = express();

	if (process.env.SBXDIFF_HTTPLOG) {
		app.use((req, _res, next) => {
			console.log(`HARNESS ${req.method} ${req.url}`);
			next();
		});
	}

	app.use(
		"/scramjet",
		express.static(
			path.join(packageRoot, "node_modules/@mercuryworkshop/scramjet/dist")
		)
	);

	app.use(
		"/controller",
		express.static(
			path.join(
				packageRoot,
				"node_modules/@mercuryworkshop/scramjet-controller/dist"
			)
		)
	);

	app.use(
		"/libcurl",
		express.static(
			path.join(
				packageRoot,
				"node_modules/@mercuryworkshop/libcurl-transport/dist"
			)
		)
	);

	// epoxy-tls: rustls + hyper compiled to wasm, TLS done in the page. The
	// live path's transport -- see sbxdiff-epoxy-transport.js for why it is
	// this one and not libcurl.
	//
	// `dist/` and not `dist/full.bundled.js`: the bundled build inlines 1.3 MB
	// of wasm as base64 into the module source, which the page then has to
	// parse as JavaScript before it can decode it. Served split, the wasm is
	// fetched as wasm and streamed into the compiler.
	//
	// SBXDIFF_EPOXY_DIST points this at a local `epoxy-tls/client/dist` instead
	// of the published package, which is what makes changing the TLS handshake
	// an edit-build-measure loop rather than a publish. Overwriting the copy in
	// node_modules works right up until the next `pnpm install` silently puts
	// the stock one back, and then the measurement is of something else.
	app.use(
		"/epoxy",
		express.static(
			process.env.SBXDIFF_EPOXY_DIST
				? path.resolve(process.env.SBXDIFF_EPOXY_DIST)
				: path.join(packageRoot, "node_modules/@mercuryworkshop/epoxy-tls/dist")
		)
	);

	app.use(express.static(path.join(__dirname, "public")));

	app.listen(PORT, () => {
		console.log(`    Harness server listening on port ${PORT}`);
	});

	const wispServer = http.createServer((req, res) => {
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("wisp server");
	});
	wisp.options.allow_private_ips = true;
	wisp.options.allow_loopback_ips = true;
	logging.set_level(logging.NONE);

	wispServer.on("upgrade", (req, socket, head) => {
		wisp.routeRequest(req, socket, head);
	});

	wispServer.listen(WISP_PORT, () => {
		console.log(`    Wisp server listening on port ${WISP_PORT}`);
	});
}
