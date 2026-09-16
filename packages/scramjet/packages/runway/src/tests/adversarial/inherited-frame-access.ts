import { basicTest } from "../../testcommon.ts";

// HTML's "determine the origin" steps 3–4: blank/srcdoc documents
// inherit the creator's origin, even though their URL origin is "null".
// https://html.spec.whatwg.org/multipage/document-sequences.html#determining-the-origin
export default [
	...(["blank", "srcdoc"] as const).map((kind) =>
		basicTest({
			name: `inherited-frame-access-${kind}`,
			js: `
				const f = document.createElement("iframe");
				const loaded = new Promise(resolve => f.onload = resolve);
				${kind === "srcdoc" ? 'f.srcdoc = "<!doctype html><p>child</p>";' : ""}
				document.body.appendChild(f);
				await loaded;
				assert(f.contentDocument, "the parent can read the inherited-origin document");
				assertEqual(f.contentDocument, f.contentWindow.document, "both access paths agree");
				assertEqual(f.contentWindow.eval("parent.document"), document,
					"the child can read its same-origin parent's document");
				assertEqual(f.contentWindow.eval("parent.location.href"), location.href,
					"the child can read its same-origin parent's location");
				const nested = f.contentDocument.createElement("iframe");
				f.contentDocument.body.appendChild(nested);
				assert(nested.contentDocument, "origin inheritance works through a blank grandchild");
				assertEqual(nested.contentWindow.eval("parent.parent.document"), document,
					"a blank grandchild can read its same-origin grandparent document");
				f.remove();
			`,
		})
	),
];
