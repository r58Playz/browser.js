import { ScramjetConfig, ScramjetFlags, ScramjetVersionInfo } from "@/types";
import DomHandler, { Element } from "domhandler";
import { URLMeta } from "@rewriters/url";
import { CookieJar } from "./cookie";
import { TapInstance } from "@/Tap";
import { HtmlContext } from "@/shared/rewriters/html";
import { _RegExp } from "./snapshot";
import { getMangler, Mangler, ManglerSet } from "./mangle";

export * from "./cookie";
export * from "./mangle";
export * from "./headers";
export * from "./htmlRules";
export * from "./mime";
export * from "./rewriters";

export function flagEnabled(
	flag: keyof ScramjetFlags,
	context: ScramjetContext,
	url: URL
): boolean {
	const value = context.config.flags[flag];
	for (const regex in context.config.siteFlags) {
		const partialflags = context.config.siteFlags[regex];
		if (new _RegExp(regex).test(url.href) && flag in partialflags) {
			return partialflags[flag];
		}
	}

	return value;
}
/**
 * The mangler for a tier, or null when that tier is off for this URL.
 *
 * Gated on both the salt (which the embedder supplies once per session) and the
 * per-tier flag, so `siteFlags` can enable mangling for one origin at a time.
 */
export function manglerFor(
	context: ScramjetContext,
	url: URL,
	flag: "mangleTags" | "mangleAttrs" | "mangleClassIds"
): Mangler | null {
	if (!context.config.mangleSalt) return null;
	if (!flagEnabled(flag, context, url)) return null;

	return getMangler(context.config.mangleSalt);
}

/**
 * Resolve every mangling tier at once. Callers that walk a whole document should do
 * this a single time and thread the result through, rather than re-checking the flags
 * for every node.
 */
export function manglersFor(
	context: ScramjetContext,
	url: URL
): ManglerSet {
	const tag = manglerFor(context, url, "mangleTags");
	const attr = manglerFor(context, url, "mangleAttrs");
	const classid = manglerFor(context, url, "mangleClassIds");

	return { tag, attr, classid, enabled: !!(tag || attr || classid) };
}

export type ScramjetInterface = {
	codecEncode: (input: string) => string;
	codecDecode: (input: string) => string;

	getInjectScripts(
		meta: URLMeta,
		handler: DomHandler,
		htmlcontext: HtmlContext,
		script: (src: string) => Element
	): Element[];
	getWorkerInjectScripts?(
		meta: URLMeta,
		isModule: boolean,
		script: (src: string) => string
	): string;
};

export type ScramjetContext = {
	config: ScramjetConfig;
	prefix: URL;
	interface: ScramjetInterface;
	cookieJar: CookieJar;
	hooks?: {
		rewriter: {
			html: TapInstance<HtmlRewriterHooks>;
		};
	};
};

export type HtmlRewriterHooks = {
	pre: {
		context: {
			handler: DomHandler;
			meta: URLMeta;
			origHtml: string;
			htmlcontext: HtmlContext;
		};
	};
	post: {
		context: {
			handler: DomHandler;
			meta: URLMeta;
			origHtml: string;
			htmlcontext: HtmlContext;
		};
		props: {
			setRawHtml?: string;
		};
	};
};
