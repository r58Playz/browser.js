import http from "node:http";
import type { AddressInfo } from "node:net";
import { basicTest, htmlTest, playwrightTest } from "../../testcommon.ts";

/**
 * The page-facing side of the identifier mangler.
 *
 * Every assertion here is an *identity* claim: whatever the document was written
 * with must be what the page reads back, whether or not mangling is on. So the whole
 * file is meaningful in a normal run (it proves the traps are transparent) and in a
 * `MANGLE=1` run (it proves they are transparent while the document underneath has
 * been renamed).
 *
 * The one thing that only holds under mangling — that the fingerprint is actually
 * gone from the real DOM — is at the bottom, guarded on the env var.
 */

const manglingOn = process.env.MANGLE === "1";

const tests = [
	basicTest({
		name: "mangle-dom-tagname-roundtrip",
		js: `
			const el = document.createElement("yt-icon");
			assertEqual(el.tagName, "YT-ICON", "tagName");
			assertEqual(el.localName, "yt-icon", "localName");
			assertEqual(el.nodeName, "YT-ICON", "nodeName");
			document.body.appendChild(el);
			assert(document.querySelector("yt-icon") === el, "querySelector by type");
			assert(el.matches("yt-icon"), "matches");
			assert(el.closest("yt-icon") === el, "closest");
			assertEqual(document.getElementsByTagName("yt-icon").length, 1, "getElementsByTagName");
			assertEqual(el.outerHTML, "<yt-icon></yt-icon>", "outerHTML");
		`,
	}),
	basicTest({
		name: "mangle-dom-innerhtml-roundtrip",
		js: `
			const host = document.createElement("div");
			host.innerHTML = '<ytd-app id="a" class="x y" data-ytd="1"><yt-icon></yt-icon></ytd-app>';
			assertEqual(
				host.innerHTML,
				'<ytd-app id="a" class="x y" data-ytd="1"><yt-icon></yt-icon></ytd-app>',
				"innerHTML round trip"
			);
			const app = host.querySelector("ytd-app");
			assert(app, "querySelector after innerHTML");
			assertEqual(app.id, "a", "id property");
			assertEqual(app.className, "x y", "className property");
			assertEqual(app.getAttribute("data-ytd"), "1", "data attribute");
			assertDeepEqual(app.getAttributeNames().sort(), ["class", "data-ytd", "id"], "getAttributeNames");
		`,
	}),
	basicTest({
		name: "mangle-dom-customelements",
		js: `
			class Thing extends HTMLElement {
				connectedCallback() { this.setAttribute("upgraded", "1"); }
			}
			customElements.define("yt-thing", Thing);
			assert(customElements.get("yt-thing") === Thing, "registry get");
			const el = document.createElement("yt-thing");
			document.body.appendChild(el);
			assert(el instanceof Thing, "upgrade ran");
			assertEqual(el.getAttribute("upgraded"), "1", "connectedCallback ran");
			assertEqual(el.tagName, "YT-THING", "upgraded tagName");
			if (customElements.getName) {
				assertEqual(customElements.getName(Thing), "yt-thing", "registry getName");
			}
			await customElements.whenDefined("yt-thing");
		`,
	}),
	basicTest({
		name: "mangle-dom-classlist",
		js: `
			const d = document.createElement("div");
			d.classList.add("alpha", "beta");
			assertEqual(d.className, "alpha beta", "className after add");
			assert(d.classList.contains("alpha"), "contains");
			assertEqual(d.classList.length, 2, "length");
			assertEqual(d.classList[0], "alpha", "index access");
			assertEqual(d.classList.item(1), "beta", "item()");
			assertEqual(d.classList.value, "alpha beta", "value");
			assertDeepEqual([...d.classList], ["alpha", "beta"], "iteration");
			const seen = [];
			d.classList.forEach((t) => seen.push(t));
			assertDeepEqual(seen, ["alpha", "beta"], "forEach");
			d.classList.replace("alpha", "gamma");
			assertDeepEqual([...d.classList], ["gamma", "beta"], "replace");
			d.classList.remove("beta");
			assertEqual(d.className, "gamma", "className after remove");
			d.classList.toggle("beta");
			assert(d.classList.contains("beta"), "toggle on");
			assert(d.classList === d.classList, "classList identity is stable");
			assertEqual(d.getAttribute("class"), "gamma beta", "getAttribute class");
		`,
	}),
	basicTest({
		name: "mangle-dom-dataset",
		js: `
			const d = document.createElement("div");
			d.dataset.ytdThing = "1";
			assertEqual(d.dataset.ytdThing, "1", "dataset read back");
			assertEqual(d.getAttribute("data-ytd-thing"), "1", "reflected attribute");
			assert("ytdThing" in d.dataset, "in operator");
			assertDeepEqual(Object.keys(d.dataset), ["ytdThing"], "enumeration");
			delete d.dataset.ytdThing;
			assertEqual(d.getAttribute("data-ytd-thing"), null, "delete");
		`,
	}),
	basicTest({
		name: "mangle-dom-getelementbyid-and-class",
		js: `
			document.body.innerHTML = '<div id="target" class="marker"></div>';
			const byId = document.getElementById("target");
			assert(byId, "getElementById");
			assertEqual(byId.id, "target", "id property");
			assertEqual(document.getElementsByClassName("marker").length, 1, "getElementsByClassName");
			assert(document.querySelector("#target.marker") === byId, "compound selector");
			assert(document.querySelector('[class~="marker"]') === byId, "attribute selector on class");
		`,
	}),
	htmlTest({
		name: "mangle-dom-stylesheet-applies",
		html: `<!DOCTYPE html>
<html>
<head><style>
	yt-icon { display: block; width: 42px }
	.marker { height: 17px }
</style></head>
<body>
<yt-icon class="marker"></yt-icon>
<script>
const el = document.querySelector("yt-icon");
assert(el, "element found by its type selector");
const style = getComputedStyle(el);
assert(style.width === "42px", "type selector still styles the element, got " + style.width);
assert(style.height === "17px", "class selector still styles the element, got " + style.height);
pass();
</script>
</body>
</html>`,
	}),
	htmlTest({
		name: "mangle-dom-cssom-roundtrip",
		html: `<!DOCTYPE html>
<html>
<head><style id="s">yt-icon { color: rgb(1, 2, 3) }</style></head>
<body>
<script>
const sheet = document.getElementById("s").sheet;
assert(
	sheet.cssRules[0].selectorText === "yt-icon",
	"selectorText reads back unmangled, got " + sheet.cssRules[0].selectorText
);
sheet.insertRule("ytd-app { color: rgb(4, 5, 6) }", 1);
assert(
	sheet.cssRules[1].selectorText === "ytd-app",
	"insertRule round trips, got " + sheet.cssRules[1].selectorText
);
const el = document.createElement("ytd-app");
document.body.appendChild(el);
assert(
	getComputedStyle(el).color === "rgb(4, 5, 6)",
	"the inserted rule matches the element, got " + getComputedStyle(el).color
);
pass();
</script>
</body>
</html>`,
	}),
	basicTest({
		name: "mangle-dom-mutationobserver",
		js: `
			const d = document.createElement("div");
			document.body.appendChild(d);
			const names = [];
			const obs = new MutationObserver((records) => {
				for (const r of records) names.push(r.attributeName);
			});
			obs.observe(d, { attributes: true, attributeFilter: ["data-ytd"] });
			d.setAttribute("data-ytd", "1");
			d.setAttribute("data-other", "2");
			await new Promise((r) => setTimeout(r, 50));
			obs.disconnect();
			assertDeepEqual(names, ["data-ytd"], "attributeFilter and attributeName use source names");
		`,
	}),
	basicTest({
		name: "mangle-dom-idref-still-resolves",
		js: `
			document.body.innerHTML = '<label for="f">l</label><input id="f">';
			const label = document.querySelector("label");
			const input = document.getElementById("f");
			assertEqual(label.getAttribute("for"), "f", "for attribute reads back");
			assertEqual(label.htmlFor, "f", "htmlFor property");
			assert(label.control === input, "the label still points at its control");
		`,
	}),
];

if (manglingOn) {
	// The only claim that is specific to a mangling run: the fingerprint the detector
	// looks for is not in the document any more. Read from the browser side rather
	// than from page script, because that is the vantage point an extension content
	// script in an isolated world has — none of the client traps are in this path.
	const markup = `<!DOCTYPE html>
<html><head><style>yt-icon { color: rgb(9, 9, 9) }</style></head>
<body><ytd-app id="page" class="style-scope"><yt-icon data-ytd="1"></yt-icon></ytd-app></body></html>`;

	tests.push(
		playwrightTest({
			name: "mangle-dom-fingerprint-absent-from-real-dom",
			fn: async ({ page, navigate }) => {
				// the runner only calls Test.start() for non-playwright tests, so this
				// one owns its own server
				const server = http.createServer((_req, res) => {
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(markup);
				});
				await new Promise<void>((resolve) => server.listen(0, resolve));
				const port = (server.address() as AddressInfo).port;

				try {
					await navigate(`http://localhost:${port}/`);

					const cdp = await page.context().newCDPSession(page);
					await cdp.send("DOM.enable");

					const snapshot = async () => {
						const { root } = (await cdp.send("DOM.getDocument", {
							depth: -1,
							pierce: true,
						})) as any;

						const tagNames: string[] = [];
						const attrNames: string[] = [];
						const attrValues: string[] = [];
						let documents = 0;

						const walk = (node: any) => {
							if (!node) return;
							if (node.nodeType === 9) documents++;
							if (node.nodeType === 1) {
								tagNames.push(String(node.nodeName).toLowerCase());
								const attrs = node.attributes ?? [];
								for (let i = 0; i < attrs.length; i += 2) {
									attrNames.push(String(attrs[i]).toLowerCase());
									attrValues.push(String(attrs[i + 1]));
								}
							}
							for (const child of node.children ?? []) walk(child);
							for (const shadow of node.shadowRoots ?? []) walk(shadow);
							walk(node.contentDocument);
						};
						walk(root);

						return { tagNames, attrNames, attrValues, documents };
					};

					// `navigate` does not wait for the frame to load, and an absence of
					// fingerprints only means something once the document is there
					const isCustom = (t: string) =>
						t.includes("-") && t !== "runway-cleartext";
					let state = await snapshot();
					const deadline = Date.now() + 20000;
					while (
						state.tagNames.filter(isCustom).length < 2 &&
						Date.now() < deadline
					) {
						await new Promise((r) => setTimeout(r, 250));
						state = await snapshot();
					}

					const custom = state.tagNames.filter(isCustom);
					if (custom.length < 2) {
						throw new Error(
							`the proxied document never appeared: ${state.documents} document(s), tags ${JSON.stringify(state.tagNames)}`
						);
					}

					const problems: string[] = [];
					for (const tag of ["yt-icon", "ytd-app"]) {
						if (state.tagNames.includes(tag)) problems.push(`tag ${tag}`);
					}
					if (state.attrNames.includes("data-ytd")) {
						problems.push("attribute data-ytd");
					}
					if (state.attrNames.some((n) => n.startsWith("scramjet-attr"))) {
						problems.push("scramjet-attr-* shadow attributes");
					}
					if (state.attrValues.includes("style-scope")) {
						problems.push("class style-scope");
					}
					if (state.attrValues.includes("page")) problems.push("id page");

					if (problems.length) {
						throw new Error(
							`still visible in the real DOM: ${problems.join(", ")}`
						);
					}
				} finally {
					server.closeAllConnections?.();
					await new Promise<void>((resolve) => server.close(() => resolve()));
				}
			},
		})
	);
}

export default tests;
