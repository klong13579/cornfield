import { AuthStorage } from "@oh-my-pi/pi-ai";
import { ModelRegistry, isAuthenticated } from "./packages/coding-agent/src/config/model-registry.ts";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";

async function main() {
	const dbPath = getAgentDbPath();
	const storage = await AuthStorage.create(dbPath);
	await storage.reload();

	const registry = new ModelRegistry(storage);

	console.log("=== After refresh() (default 'online-if-uncached') ===");
	await registry.refresh();
	const models1 = registry.getAvailable();
	console.log("bailian models:", models1.filter(m => m.provider === "bailian-coding-plan").map(m => m.id));

	console.log("\n=== After refresh('offline') ===");
	await registry.refresh("offline");
	const models2 = registry.getAvailable();
	console.log("bailian models:", models2.filter(m => m.provider === "bailian-coding-plan").map(m => m.id));

	const state = registry.getProviderDiscoveryState("bailian-coding-plan");
	console.log("\nbailian discovery state:", state);
}

main().catch(console.error);
