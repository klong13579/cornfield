import { afterEach, describe, expect, test } from "bun:test";
import { resolveSettings } from "../src/settings";

describe("moa settings runtime overrides", () => {
	afterEach(() => {
		delete Bun.env.PI_MOA_SETTINGS_JSON;
	});

	test("merges PI_MOA_SETTINGS_JSON into resolved settings", () => {
		Bun.env.PI_MOA_SETTINGS_JSON = JSON.stringify({
			workers: [
				{ name: "divergent", role: "Generate options", model: "provider/divergent" },
				{ name: "grounded", role: "Check realism", model: "provider/grounded" },
				{ name: "critical", role: "Find failure modes", model: "provider/critical" },
			],
			synthesisModel: "provider/synthesis",
		});

		const settings = resolveSettings();

		expect(settings.workers.map(worker => worker.model)).toEqual([
			"provider/divergent",
			"provider/grounded",
			"provider/critical",
		]);
		expect(settings.synthesisModel).toBe("provider/synthesis");
	});

	test("explicit resolveSettings overrides win over PI_MOA_SETTINGS_JSON", () => {
		Bun.env.PI_MOA_SETTINGS_JSON = JSON.stringify({
			workers: [{ name: "divergent", role: "Generate options", model: "provider/from-env" }],
		});

		const settings = resolveSettings({
			workers: [{ name: "divergent", role: "Generate options", model: "provider/from-call" }],
		});

		expect(settings.workers[0]?.model).toBe("provider/from-call");
	});
});
