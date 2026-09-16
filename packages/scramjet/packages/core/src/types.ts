/**
 * Version information for the current Scramjet build.
 * Contains both the semantic version string and the git commit hash for build identification.
 */
export interface ScramjetVersionInfo {
	/** The semantic version */
	version: string;
	/** The git commit hash that this build was created from */
	build: string;
	/** The date of the build */
	date: string;
}

/**
 * Scramjet Feature Flags, configured at build time
 */
export type ScramjetFlags = {
	syncxhr: boolean;
	disableComputedWrap: boolean;
	rewriterLogs: boolean;
	captureErrors: boolean;
	cleanErrors: boolean;
	scramitize: boolean;
	sourcemaps: boolean;
	destructureRewrites: boolean;
	allowInvalidJs: boolean;
	allowFailedIntercepts: boolean;
	debugTrampolines: boolean;
	debugSourceURL: boolean;
	encapsulateWorkers: boolean;
	/**
	 * Mangle hyphenated (custom element) tag names and the `is` attribute so that
	 * site-specific structural fingerprints (`yt-icon`, `ytd-searchbox`, ...) do not
	 * appear in the real DOM. Requires a non-empty {@link ScramjetConfig.mangleSalt}.
	 */
	mangleTags: boolean;
	/**
	 * Mangle `data-*` and unrecognised attribute *names*. Requires a non-empty
	 * {@link ScramjetConfig.mangleSalt}.
	 */
	mangleAttrs: boolean;
	/**
	 * Mangle `class` tokens, `id` values, IDREF attribute values and URL fragments.
	 * Highest breakage risk of the three tiers. Requires a non-empty
	 * {@link ScramjetConfig.mangleSalt}.
	 */
	mangleClassIds: boolean;
};

export interface ScramjetConfig {
	globals: {
		wrapfn: string;
		wrappropertybase: string;
		wrappropertyfn: string;
		cleanrestfn: string;
		importfn: string;
		rewritefn: string;
		metafn: string;
		wrappostmessagefn: string;
		pushsourcemapfn: string;
		trysetfn: string;
		setrealmfn: string;
		templocid: string;
		tempunusedid: string;
		/**
		 * Prefix used for the shadow attributes that hold pre-rewrite attribute
		 * values. Randomizing this per session stops `[scramjet-attr-href]` from
		 * being a universal proxy signature.
		 */
		attrprefix: string;
		/** Marker attribute placed on Scramjet's own injected `<script>` elements. */
		injectedattr: string;
	};
	flags: ScramjetFlags;
	siteFlags: Record<string, Partial<ScramjetFlags>>;
	maskedfiles: string[];
	/**
	 * Per-session key for the identifier mangler. Must be identical in the fetch
	 * handler and in every page realm, and stable for the lifetime of a document
	 * (its stylesheets are mangled with the same key). An empty string disables
	 * all `mangle*` flags.
	 */
	mangleSalt: string;
}

/**
 * The config for Scramjet initialization.
 */
export interface ScramjetInitConfig
	extends Omit<ScramjetConfig, "codec" | "flags"> {
	flags: Partial<ScramjetFlags>;
	codec: {
		encode: (url: string) => string;
		decode: (url: string) => string;
	};
}

//eslint-disable-next-line
export type AnyFunction = Function;
