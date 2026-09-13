import { GlobalScope, ScramjetClient } from "@client/index";
import { Type } from "@client/webidl";
import { String_indexOf, String_substring } from "@/shared/snapshot";

/**
 * Separates the controller's frame id from the page's own `window.name`.
 *
 * Must match `FRAME_ID_SEPARATOR` in the controller's `symbols.ts`. The two
 * packages ship separately, so this is a shared constant rather than an import;
 * `sbxdiff/pages/framename.html` is what keeps them honest.
 */
const FRAME_ID_SEPARATOR = "|";

/**
 * `window.name` belongs to the page.
 *
 * The controller needs a per-frame id and keeps it in `window.name`, because
 * that is the one string that survives a navigation and is reachable from the
 * parent. But it is also a property any page can simply read, and it was being
 * handed the id: measured against unmodified Chromium, a fresh document
 * reported `window.name === "f1"` where the browser reports `""`. Nothing about
 * that is subtle -- a site checks one property and knows.
 *
 * So the two share it, separated by {@link FRAME_ID_SEPARATOR}: the id in
 * front, the page's own value behind. The page is served its half and writes
 * its half; the controller reads the other (`frameIdOf` in `inject.ts`).
 *
 * Storing the page's value in the real `name` rather than in a variable here is
 * deliberate. `window.name` persisting across a navigation is the whole reason
 * anyone uses it, and a client-side copy is discarded with the document.
 */
export default function (client: ScramjetClient, self: Self) {
	const nativeName = (): string => String(new client.native.window(self).name);

	const idPart = (raw: string): string => {
		const at = String_indexOf(raw, FRAME_ID_SEPARATOR);

		return at === -1 ? raw : String_substring(raw, 0, at);
	};

	client.Intercept(class extends GlobalScope {
		/**
		 * `[Replaceable] attribute DOMString name` -- both halves are declared
		 * because unlike `origin` this one is writable.
		 */
		@Type("DOMString")
		static get name(): string {
			// Through the receiver, so a page that calls the accessor with a
			// foreign `this` gets the brand check it would get natively.
			const raw = String(new client.native.window(this).name);
			const at = String_indexOf(raw, FRAME_ID_SEPARATOR);

			// No separator means nothing has claimed this frame -- the top-level
			// document, or one the controller has not injected into -- so the
			// whole string is the page's.
			return at === -1 ? raw : String_substring(raw, at + 1);
		}

		@Type("DOMString")
		static set name(value: string) {
			const id = idPart(nativeName());
			new client.native.window(this).name =
				id === "" ? value : `${id}${FRAME_ID_SEPARATOR}${value}`;
		}
	});
}
