// NOTE: this is the entrypoint for scramjet.bundle.js
// as such it exports everything in scramjet
// the entry point for scramjet.all.js (what most sites wil use) is entry.ts

import "./global.d";
import { atob } from "@/shared/snapshot";
import { setWasm } from "@rewriters/wasm";
import { ScramjetVersionInfo, ScramjetConfig } from "./types";

declare const VERSION: string;
declare const COMMITHASH: string;
declare const BUILDDATE: string;
export const versionInfo: ScramjetVersionInfo = {
	version: VERSION,
	build: COMMITHASH,
	date: BUILDDATE,
};

export const defaultConfig: ScramjetConfig = {
	globals: {
		wrapfn: "$scramjet$wrap",
		wrappropertybase: "$scramjet__",
		wrappropertyfn: "$scramjet$prop",
		cleanrestfn: "$scramjet$clean",
		importfn: "$scramjet$import",
		rewritefn: "$scramjet$rewrite",
		metafn: "$scramjet$meta",
		wrappostmessagefn: "$scramjet$wrappostmessage",
		pushsourcemapfn: "$scramjet$pushsourcemap",
		trysetfn: "$scramjet$tryset",
		templocid: "$scramjet$temploc",
		tempunusedid: "$scramjet$tempunused",
	},
	flags: {
		syncxhr: false,
		disableComputedWrap: false,
		rewriterLogs: false,
		captureErrors: false,
		// On by default. An error's stack is a first-class fingerprinting input
		// -- anti-bot scripts read it -- and without this it hands the page the
		// proxy URL of every frame. `client/shared/error.ts` has un-rewritten
		// them all along; it was simply never switched on.
		cleanErrors: true,
		scramitize: false,
		sourcemaps: true,
		destructureRewrites: true,
		allowInvalidJs: true,
		debugTrampolines: false,
		encapsulateWorkers: true,
		debugSourceURL: false,
	},
	siteFlags: {},
	maskedfiles: [],
};

export const defaultConfigDev: ScramjetConfig = {
	...defaultConfig,
	flags: {
		...defaultConfig.flags,
		rewriterLogs: false,
		captureErrors: true,
		cleanErrors: false,
		debugTrampolines: true,
		debugSourceURL: true,
		allowInvalidJs: false,
	},
};

declare const REWRITERWASM: string | undefined;
// bundled build will have the wasm binary inlined as a base64 string
if (REWRITERWASM) {
	setWasm(Uint8Array.from(atob(REWRITERWASM), (c) => c.charCodeAt(0)));
}

export * from "./symbols";
export * from "./types";
export * from "./Tap";
export * from "./shared";
export * from "./fetch";
export { BareResponse } from "@mercuryworkshop/proxy-transports";
export * from "./client";
