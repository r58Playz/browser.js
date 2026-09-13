import { URLMeta, rewriteUrl, unrewriteUrl } from "@rewriters/url";
import { ScramjetContext } from "@/shared";
import { QP } from "@/fetch/parse";
import { String, _URL } from "@/shared/snapshot";

/**
 * Rewrite a `url()` target, remembering the text the stylesheet actually wrote.
 *
 * A browser serializes `url()` as the SPECIFIED value: `url("/a.png")` reads
 * back as `url("/a.png")`, not as the resolved absolute. Rewriting resolves,
 * and unrewriting can only reconstruct the absolute form, so the round trip
 * turned every relative reference in every stylesheet absolute.
 */
function rewriteCssUrl(
	url: string,
	context: ScramjetContext,
	meta: URLMeta
): string {
	const rewritten = rewriteUrl(url, context, meta);
	try {
		const out = new _URL(rewritten);
		out.searchParams.set(QP.cssSpecified, url);

		return out.href;
	} catch {
		// not a URL to hang a parameter on -- a `data:` target, say. Nothing to
		// remember either, because there was nothing to resolve.
		return rewritten;
	}
}

/** The inverse: the specified text if it travelled and was asked for. */
function unrewriteCssUrl(
	url: string,
	context: ScramjetContext,
	resolved: boolean
): string {
	if (!resolved) {
		try {
			const specified = new _URL(url).searchParams.get(QP.cssSpecified);
			if (specified !== null) return specified;
		} catch {
			// not a URL, so not one of ours
		}
	}

	return unrewriteUrl(url, context);
}

export function rewriteCss(
	css: string,
	context: ScramjetContext,
	meta: URLMeta
) {
	return handleCss("rewrite", css, context, meta);
}

/**
 * @param resolved Answer with the RESOLVED url rather than the one the
 * stylesheet specified. A computed value is resolved by definition -- that is
 * what `getComputedStyle` means -- while `cssText` and an inline declaration
 * serialize what the author wrote. Same un-rewriting, opposite answers, so the
 * caller says which it is.
 */
export function unrewriteCss(
	css: string,
	context: ScramjetContext,
	resolved = false
) {
	return handleCss("unrewrite", css, context, undefined, resolved);
}

function handleCss(
	type: "rewrite" | "unrewrite",
	css: string,
	context: ScramjetContext,
	meta?: URLMeta,
	resolved = false
) {
	// regex from vk6 (https://github.com/ading2210)
	const urlRegex =
		/(?i:url)\((?:\s*"((?:\\.|[^"])+)"\s*|\s*'((?:\\.|[^'])+)'\s*|((?!\s*['"])(?!\s*\))(?:\\.|[^)])+?))\)/gm;
	const Atruleregex =
		/@import\s+((?i:url)\s*?\(.{0,9999}?\)|['"].{0,9999}?['"]|.{0,9999}?)($|\s|;)/gm;
	css = String(css);
	css = css.replace(
		urlRegex,
		(
			match,
			doubleQuotedUrl: string | undefined,
			singleQuotedUrl: string | undefined,
			unquotedUrl: string | undefined
		) => {
			const url = doubleQuotedUrl ?? singleQuotedUrl ?? unquotedUrl;
			const encodedUrl =
				type === "rewrite"
					? rewriteCssUrl(url.trim(), context, meta!)
					: unrewriteCssUrl(url.trim(), context, resolved);

			return match.replace(url, encodedUrl);
		}
	);
	css = css.replace(Atruleregex, (match, importStatement: string) => {
		return match.replace(
			importStatement,
			importStatement.replace(
				/^(url\(['"]?|['"]|)(.+?)(['"]|['"]?\)|)$/gm,
				(match: string, firstQuote: string, url: string, endQuote: string) => {
					if (firstQuote.startsWith("url")) {
						return match;
					}
					const encodedUrl =
						type === "rewrite"
							? rewriteCssUrl(url.trim(), context, meta!)
							: unrewriteCssUrl(url.trim(), context, resolved);

					return `${firstQuote}${encodedUrl}${endQuote}`;
				}
			)
		);
	});

	return css;
}
