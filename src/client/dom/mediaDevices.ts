import { ScramjetClient } from "@client/index";

export default function (client: ScramjetClient, self: Self) {
	//@ts-expect-error chrome only untyped api
	delete self.MediaDevices.prototype.setCaptureHandleConfig;
}
