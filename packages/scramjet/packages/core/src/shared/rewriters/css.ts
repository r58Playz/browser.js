import { URLMeta, rewriteUrl, unrewriteUrl } from "@rewriters/url";
import { manglerFor, ScramjetContext } from "@/shared";
import { String, _Set } from "@/shared/snapshot";
import { shouldMangleAttr, shouldMangleTag } from "@/shared/mangle";
import {
	IdentTransform,
	transformSelector,
} from "@rewriters/selectors";

export function rewriteCss(
	css: string,
	context: ScramjetContext,
	meta: URLMeta
) {
	return handleCss("rewrite", css, context, meta);
}

export function unrewriteCss(
	css: string,
	context: ScramjetContext,
	meta: URLMeta
) {
	return handleCss("unrewrite", css, context, meta);
}

/**
 * At-rules whose body is a list of rules rather than a list of declarations, so their
 * contents still need walking. Everything else (`@keyframes`, `@font-face`,
 * `@property`, `@counter-style`, ...) has a body that only looks like selectors.
 */
const NESTED_AT_RULES = new _Set<string>([
	"media",
	"supports",
	"container",
	"layer",
	"scope",
	"document",
	"-moz-document",
	"starting-style",
]);

function isSpace(c: string): boolean {
	return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
}

/**
 * Walk a stylesheet and hand every selector list to {@link transformSelector}.
 *
 * A rule's prelude is whatever sits between the last `;`/`{`/`}` and the next `{`, so
 * this handles CSS nesting for free: inside a style rule, declarations terminate at
 * `;` and nested rules are found at `{`.
 */
export function transformStylesheet(
	css: string,
	xf: IdentTransform
): string {
	const s = String(css);
	let out = "";
	let segment = "";
	// `false` inside `@keyframes`/`@font-face` style bodies, where the things that
	// look like selectors are not selectors
	const stack: boolean[] = [];
	let rules = true;
	let parens = 0;
	let i = 0;

	const flush = () => {
		out += segment;
		segment = "";
	};

	while (i < s.length) {
		const c = s[i];

		if (c === "/" && s[i + 1] === "*") {
			const end = s.indexOf("*/", i + 2);
			const stop = end === -1 ? s.length : end + 2;
			segment += s.slice(i, stop);
			i = stop;
			continue;
		}

		if (c === '"' || c === "'") {
			let j = i + 1;
			while (j < s.length) {
				if (s[j] === "\\") j += 2;
				else if (s[j] === c) {
					j++;
					break;
				} else j++;
			}
			segment += s.slice(i, j);
			i = j;
			continue;
		}

		// url(...) may hold anything; the URL pass has already been through it
		if (
			(c === "u" || c === "U") &&
			/^url\s*\(/i.test(s.slice(i, i + 8))
		) {
			const open = s.indexOf("(", i);
			let j = open + 1;
			let depth = 1;
			while (j < s.length && depth > 0) {
				if (s[j] === "\\") j++;
				else if (s[j] === "(") depth++;
				else if (s[j] === ")") depth--;
				j++;
			}
			segment += s.slice(i, j);
			i = j;
			continue;
		}

		if (c === "(") {
			parens++;
			segment += c;
			i++;
			continue;
		}
		if (c === ")") {
			if (parens > 0) parens--;
			segment += c;
			i++;
			continue;
		}

		if (parens > 0) {
			segment += c;
			i++;
			continue;
		}

		if (c === "{") {
			let prelude = segment;
			let trimmed = prelude;
			while (trimmed.length && isSpace(trimmed[0])) trimmed = trimmed.slice(1);

			let childRules: boolean;
			if (trimmed[0] === "@") {
				let name = "";
				let k = 1;
				while (k < trimmed.length && !isSpace(trimmed[k]) && trimmed[k] !== "(")
					name += trimmed[k++];
				childRules = rules && NESTED_AT_RULES.has(name.toLowerCase());
			} else if (rules) {
				prelude = transformSelector(prelude, xf);
				// CSS nesting: a style rule body can hold further rules
				childRules = true;
			} else {
				childRules = false;
			}

			segment = prelude;
			flush();
			out += "{";
			stack.push(rules);
			rules = childRules;
			i++;
			continue;
		}

		if (c === "}") {
			flush();
			out += "}";
			rules = stack.length ? stack.pop()! : true;
			i++;
			continue;
		}

		if (c === ";") {
			flush();
			out += ";";
			i++;
			continue;
		}

		segment += c;
		i++;
	}
	flush();

	return out;
}

/**
 * Build the ident transform for this document, or null when no mangling tier applies
 * (in which case the stylesheet walker is skipped entirely).
 */
export function selectorTransform(
	direction: "rewrite" | "unrewrite",
	context: ScramjetContext,
	url: URL
): IdentTransform | null {
	const tags = manglerFor(context, url, "mangleTags");
	const attrs = manglerFor(context, url, "mangleAttrs");
	const classids = manglerFor(context, url, "mangleClassIds");
	if (!tags && !attrs && !classids) return null;

	return (kind, name) => {
		if (kind === "tag") {
			if (!tags) return name;
			if (direction === "rewrite" && !shouldMangleTag(name)) return name;

			return direction === "rewrite"
				? tags.mangle("tag", name)
				: tags.unmangle("tag", name);
		}
		if (kind === "attr") {
			if (!attrs) return name;
			if (direction === "rewrite" && !shouldMangleAttr(name, false)) return name;

			return direction === "rewrite"
				? attrs.mangle("attr", name)
				: attrs.unmangle("attr", name);
		}
		if (!classids) return name;

		return direction === "rewrite"
			? classids.mangle(kind, name)
			: classids.unmangle(kind, name);
	};
}

function handleCss(
	type: "rewrite" | "unrewrite",
	css: string,
	context: ScramjetContext,
	meta: URLMeta
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
					? rewriteUrl(url.trim(), context, meta!)
					: unrewriteUrl(url.trim(), context);

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
							? rewriteUrl(url.trim(), context, meta!)
							: unrewriteUrl(url.trim(), context);

					return `${firstQuote}${encodedUrl}${endQuote}`;
				}
			)
		);
	});

	const xf = selectorTransform(type, context, meta.base);
	if (xf) css = transformStylesheet(css, xf);

	return css;
}
