export const CONTROLLERFRAME = Symbol.for("controller frame handle");

/**
 * Marks an iframe element the controller has already injected into.
 *
 * A symbol rather than the element's `name`, which is what this used to be.
 * `name` is a content attribute the PAGE can read: a guest that created an
 * iframe and looked at `myFrame.name` got "f1.1" where a browser reports "",
 * the same leak `window.name` had one level up. A symbol keyed this way is
 * invisible to `getAttribute`, to attribute enumeration and to the IDL
 * reflection, and serves the only purpose `name` served here -- not injecting
 * into the same frame twice.
 */
export const FRAMEINJECTED = Symbol.for("controller frame injected");

/**
 * Separates the controller's frame id from the page's own `window.name`.
 *
 * The id has to live somewhere that survives a navigation and is reachable
 * from the parent, and `window.name` is the only such string -- but it belongs
 * to the page, which can simply read it. It used to be overwritten outright, so
 * a document reported `window.name === "f1"` where a browser reports `""`.
 *
 * Now the two share it: id, separator, then whatever the page put there. The
 * client's `dom/framename.ts` serves the page its half and must use the same
 * separator; `sbxdiff/pages/framename.html` keeps the two in agreement.
 */
export const FRAME_ID_SEPARATOR = "|";

/** The controller's half of a shared `window.name`. */
export function frameIdOf(name: string | undefined): string {
	if (!name) return "";
	const at = name.indexOf(FRAME_ID_SEPARATOR);

	return at === -1 ? name : name.slice(0, at);
}
