import type { ExtensionAPI } from "@cornfield/coding-agent";
import { prompt } from "@cornfield/utils";

export default function extension(pi: ExtensionAPI): void {
	const text = prompt.render("hello {{name}}", { name: "world" });
	pi.registerCommand("imported", {
		description: text,
		handler: async () => {},
	});
}
