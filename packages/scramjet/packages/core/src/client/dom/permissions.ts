import { ScramjetClient } from "@client/index";

/**
 * Permissions a CROSS-ORIGIN iframe does not get, and a same-origin one does.
 *
 * A proxy collapses every origin onto its own, so a frame the real web would
 * treat as third-party looks first-party from inside. That is not an abstract
 * fidelity point: it is read directly, and it is read by the code whose job is
 * to decide whether this is a real browser.
 *
 * Measured on rateyourmusic, oracle against sandbox, scoped to the Turnstile
 * widget's own realm -- which is a cross-origin iframe on
 * challenges.cloudflare.com in a real browser and a same-origin one under the
 * proxy:
 *
 *     Notification.permission    "denied"  vs  "default"
 *     PermissionStatus.state     "denied"  vs  "prompt"
 *
 * Chromium answers "denied" there without prompting, because notifications are
 * not available to a cross-origin frame at all. Nothing in the sandbox was
 * emulating that, so the widget saw a permission state no third-party frame
 * ever has.
 *
 * A named set rather than "deny everything in a frame", because not every
 * permission behaves this way and denying one that does not would trade a
 * divergence in one direction for a divergence in the other. Two reasons a
 * name belongs here:
 *
 *   - Permissions Policy gives it the default allowlist `self`, so a
 *     cross-origin frame without an explicit `allow=` is blocked and
 *     `permissions.query` answers "denied" rather than "prompt". That covers
 *     everything below except notifications.
 *   - Chromium refuses it to cross-origin frames outright. That is
 *     notifications, which is not Permissions-Policy gated at all.
 *
 * An earlier version of this listed only notifications, on the reasoning that
 * a cross-origin frame prompts for geolocation like anywhere else. That is
 * wrong, and `perms.html` says so: oracle "denied" against sandbox "prompt".
 */
const DENIED_IN_CROSS_ORIGIN_FRAME = new Set([
	"notifications",
	"geolocation",
	"camera",
	"microphone",
	"midi",
	"display-capture",
	"local-fonts",
	"window-management",
	"accelerometer",
	"gyroscope",
	"magnetometer",
	"ambient-light-sensor",
]);

/**
 * Is this document a frame that the REAL web would treat as cross-origin?
 *
 * Compared against the outermost document that is still inside the sandbox,
 * because that is the page under test. The walk stops at the first window with
 * no client: that is the embedder's own page, which is not part of the site and
 * whose origin means nothing to the guest.
 */
function isRealCrossOriginFrame(client: ScramjetClient): boolean {
	try {
		let win = client.global as unknown as Window;
		let outermost = client;
		// Bounded: a hang costs the whole run and the bound costs nothing.
		for (let depth = 0; depth < 32; depth++) {
			const parent = win.parent;
			if (!parent || parent === win) break;
			const parentClient = client.box.globals.get(parent as never);
			if (!parentClient) break;
			outermost = parentClient;
			win = parent;
		}
		if (outermost === client) return false;

		return client.url.origin !== outermost.url.origin;
	} catch {
		// Reading `parent` threw, so this frame is cross-origin to the proxy
		// itself and certainly not the top document.
		return true;
	}
}

export default function (client: ScramjetClient) {
	client.Trap("Notification.permission", {
		get(ctx) {
			if (isRealCrossOriginFrame(client)) return "denied";

			return ctx.get();
		},
	});

	client.Trap("PermissionStatus.prototype.state", {
		get(ctx) {
			const status = ctx.this as PermissionStatus;
			// `name` rather than remembering what was queried: a PermissionStatus
			// carries it, and a page can hold one across a state change.
			if (
				DENIED_IN_CROSS_ORIGIN_FRAME.has(status.name) &&
				isRealCrossOriginFrame(client)
			) {
				return "denied";
			}

			return ctx.get();
		},
	});
}
