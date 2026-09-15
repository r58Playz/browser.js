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
			// The NATIVE timer, not the bare global one. A bare `setTimeout`
			// here resolves to the global scramjet has already intercepted, so
			// this delay was drawing a guest-visible timer id -- the shim
			// spending the page's counter, which is the bug RULES #137 exists
			// to stop. Measured on rateyourmusic: the oracle's page realm hands
			// its `setInterval` id 4 and the sandbox hands it 5, and every id
			// the page reads after that is shifted by one, in all three
			// realms.
			new client.native.window(client.global).setTimeout(
				() => super.revokeObjectURL(real),
				1000
			);
		}
	});
}
