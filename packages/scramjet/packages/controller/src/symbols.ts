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
 *
 * Its value is the frame's id, which `createFrameId` reads back off the parent
 * to build a child's. That chain used to run through the parent's
 * `window.name`, a property the page owns and can read; keeping it here means
 * the id never reaches anywhere a page can see it.
 */
export const FRAMEINJECTED = Symbol.for("controller frame injected");
