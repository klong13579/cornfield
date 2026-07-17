import { describe, expect, it } from "bun:test";
import {
	applyResearchSourcesPenalty,
	enrichSchemaWithSources,
	inferResearchMode,
	renderResearchGuidance,
} from "../src/research-mode";
import { DEFAULT_OUTPUT_SCHEMA, type MoaOutputSchema } from "../src/types";

describe("inferResearchMode", () => {
	it("returns required for explicit external-research cues", () => {
		expect(inferResearchMode("调研业界实践并给出参考方案")).toBe("required");
		expect(inferResearchMode("compare industry best practices and papers")).toBe("required");
		expect(inferResearchMode("看看竞品和开源方案怎么做")).toBe("required");
	});

	it("returns encouraged for open architecture / tradeoff tasks", () => {
		expect(inferResearchMode("为 omp 设计长会话上下文膨胀治理方案，给出可选架构与取舍")).toBe(
			"encouraged",
		);
		expect(inferResearchMode("design an architecture with tradeoffs for session compaction")).toBe(
			"encouraged",
		);
	});

	it("returns none for narrowly constrained implementation tasks", () => {
		expect(
			inferResearchMode(
				"设计一个仅含 GET /health 的最小 TypeScript HTTP 健康检查：Bun 原生、端口 3000、文件 examples/health-server.ts",
			),
		).toBe("none");
		expect(inferResearchMode("fix the typo in agent-loop.ts")).toBe("none");
	});
});

describe("renderResearchGuidance", () => {
	it("returns empty for none", () => {
		expect(renderResearchGuidance("none")).toBe("");
	});

	it("encourages tool-backed citations for encouraged", () => {
		const text = renderResearchGuidance("encouraged");
		expect(text).toMatch(/web_search/i);
		expect(text).toMatch(/## sources|sources/i);
		expect(text).toMatch(/must not|do not cite|from memory|不得.*记忆|Do not invent URLs/i);
	});

	it("requires at least one web_search for required", () => {
		const text = renderResearchGuidance("required");
		expect(text).toMatch(/MUST|必须/i);
		expect(text).toMatch(/web_search/i);
		expect(text).toMatch(/## sources|sources/i);
	});
});

describe("enrichSchemaWithSources", () => {
	it("leaves schema unchanged when researchMode is none", () => {
		const out = enrichSchemaWithSources(DEFAULT_OUTPUT_SCHEMA, "none");
		expect(out.sections.map(s => s.name)).toEqual(DEFAULT_OUTPUT_SCHEMA.sections.map(s => s.name));
	});

	it("adds optional sources for encouraged", () => {
		const out = enrichSchemaWithSources(DEFAULT_OUTPUT_SCHEMA, "encouraged");
		const sources = out.sections.find(s => s.name === "sources");
		expect(sources).toEqual({
			name: "sources",
			required: false,
			type: "list",
			item: { claim: "string", url: "string", relevance: "string" },
		});
	});

	it("adds required sources for required", () => {
		const out = enrichSchemaWithSources(DEFAULT_OUTPUT_SCHEMA, "required");
		const sources = out.sections.find(s => s.name === "sources");
		expect(sources?.required).toBe(true);
	});

	it("does not duplicate an existing sources section", () => {
		const schema: MoaOutputSchema = {
			sections: [
				{ name: "plan", required: true, type: "markdown" },
				{ name: "sources", required: false, type: "list" },
			],
		};
		const out = enrichSchemaWithSources(schema, "required");
		expect(out.sections.filter(s => s.name === "sources")).toHaveLength(1);
		expect(out.sections.find(s => s.name === "sources")?.required).toBe(true);
	});
});

describe("applyResearchSourcesPenalty", () => {
	it("caps at 60 when required and sources lack URLs", () => {
		expect(applyResearchSourcesPenalty(90, "- claim: x | url: | relevance: y", "required")).toBe(60);
		expect(applyResearchSourcesPenalty(90, undefined, "required")).toBe(60);
	});

	it("soft-penalizes encouraged without URLs", () => {
		expect(applyResearchSourcesPenalty(80, "", "encouraged")).toBe(70);
	});

	it("leaves score alone when a URL is present or mode is none", () => {
		expect(applyResearchSourcesPenalty(90, "- claim: x | url: https://ex.com | relevance: y", "required")).toBe(90);
		expect(applyResearchSourcesPenalty(90, undefined, "none")).toBe(90);
	});
});
