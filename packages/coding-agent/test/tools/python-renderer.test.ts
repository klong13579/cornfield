import { describe, expect, it } from "bun:test";
import { pythonToolRenderer } from "@cornfield/coding-agent/tools/python";
import { createRenderSurface } from "../helpers/render-assert";

describe("pythonToolRenderer", () => {
	it("renders truncated output when collapsed and full output when expanded", async () => {
		const surface = await createRenderSurface();

		const fullOutput = ["line 1", "line 2", "line 3", "line 4"].join("\n");

		const result = {
			content: [{ type: "text", text: fullOutput }],
			details: {
				cells: [
					{
						index: 0,
						title: "run",
						code: "print('hello')",
						output: fullOutput,
						status: "complete" as const,
						durationMs: 12,
					},
				],
			},
		};

		const collapsedOptions = { expanded: false, isPartial: false, renderContext: { previewLines: 2 } };
		const collapsed = surface.expectStable(() =>
			pythonToolRenderer.renderResult(result, collapsedOptions, surface.theme),
		);
		expect(collapsed).toContain("line 4");
		expect(collapsed).not.toContain("line 1");
		expect(collapsed).toContain("more lines");

		const expandedOptions = { expanded: true, isPartial: false };
		const expanded = surface.expectStable(() =>
			pythonToolRenderer.renderResult(result, expandedOptions, surface.theme),
		);
		expect(expanded).toContain("line 1");
		expect(expanded).toContain("line 4");
		expect(expanded).not.toContain("more lines");

		surface.expectWithinWidth(pythonToolRenderer.renderResult(result, collapsedOptions, surface.theme));
		surface.expectWithinWidth(pythonToolRenderer.renderResult(result, expandedOptions, surface.theme));
	});
});
