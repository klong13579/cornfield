import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { prompt } from "@oh-my-pi/pi-utils";

export default function extension(pi: ExtensionAPI): void {
	const text = prompt.render("hello {{name}}", { name: "world" });
	pi.registerCommand("imported", {
		description: text,
		handler: async () => {},
	});
}
