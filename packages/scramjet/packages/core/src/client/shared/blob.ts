import { rewriteBlob, unrewriteBlob } from "@rewriters/url";
import { ScramjetClient } from "@client/index";
import { String_startsWith } from "@/shared/snapshot";
import { Arguments, Returns } from "@client/webidl";

export default function (client: ScramjetClient) {
	client.Intercept(class extends URL {
		@Arguments("(Blob or MediaSource)")
		@Returns("DOMString")
		static createObjectURL(obj: Blob | MediaSource): string {
			const url = super.createObjectURL(obj);
			if (!String_startsWith(url, "blob:")) return url;

			return rewriteBlob(url, client.context, client.meta);
		}

		@Arguments("DOMString")
		@Returns("undefined")
		static revokeObjectURL(url: string): void {
			const real = unrewriteBlob(url, client.context, client.meta);

			// scramjet rewrites blob urls to pass through the service worker first
			// this is neccesary if rewrites need to be applied to the blob
			// the issue is that if you call revokeObjectURL immediately after using the blob
			// the service worker will not have had time to download the blob
			// for some reason this is not an issue natively
			// simple delay is enough
			// TODO: find a way to make this not necessary
			//
			// The EMBEDDER's timer, not the guest's -- native or otherwise.
			//
			// Reaching for `client.native.window(...).setTimeout` was the first
			// fix and it only solved half the problem. It stops the call being
			// seen as a guest op, and it does not stop the id being spent: the
			// timer id counter is a property of the WINDOW, shared by the
			// native entry point and the shimmed one, so a native call on the
			// guest's window still advances the number the page reads next.
			//
			// Measured on rateyourmusic, page realm, after that fix:
			//
			//     oracle   T(0)=1 T(0)=2 T(0)=3 Interval(86400000)=4 ...
			//     sandbox  T(0)=1 T(0)=2 T(0)=3 T(0)=4 Interval(86400000)=5 ...
			//
			// -- the shim's timer sitting in the middle of the page's own
			// sequence, shifting every id after it. RULES #137 again, one level
			// down.
			//
			// The embedder's window is outside the sandbox, so its counter is
			// not something the guest can read. Walk out to the first window
			// with no client of its own; if there is none, or it cannot be
			// reached, fall back to the guest's native timer, which is the
			// behaviour without this.
			const delayOwner = ((): Window => {
				try {
					let win = client.global as unknown as Window;
					// Bounded: a hang costs the whole run and the bound costs
					// nothing.
					for (let depth = 0; depth < 32; depth++) {
						const parent = win.parent;
						if (!parent || parent === win) break;
						if (!client.box.globals.get(parent as never)) return parent;
						win = parent;
					}
				} catch {
					// A parent that will not be read is a cross-origin one.
				}

				return client.native.window(client.global) as unknown as Window;
			})();
			delayOwner.setTimeout(() => super.revokeObjectURL(real), 1000);
		}
	});
}
