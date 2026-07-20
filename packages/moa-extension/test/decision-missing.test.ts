import { describe, expect, it } from "bun:test";
import { filterDecisionMissing, isDefinitionStyleQuestion } from "../src/decision-missing";
import type { TcoMissingInput } from "../src/tco";

describe("isDefinitionStyleQuestion", () => {
	it("flags 本项目指什么 / 是什么 definition asks", () => {
		expect(isDefinitionStyleQuestion("workbuddy 在 OMP 项目中具体指什么？")).toBe(true);
		expect(isDefinitionStyleQuestion("hermes agent 是什么？")).toBe(true);
		expect(isDefinitionStyleQuestion("代码中没有找到这个名称的包或模块")).toBe(true);
		expect(isDefinitionStyleQuestion("What is WorkBuddy in this repo?")).toBe(true);
		expect(isDefinitionStyleQuestion("workbuddy 和 openclaw 分别是什么？请提供简要描述或相关链接")).toBe(true);
		expect(isDefinitionStyleQuestion("workbuddy 具体是哪个项目/工具？能提供 URL 或准确名称吗？")).toBe(true);
	});

	it("keeps decision-dimension questions", () => {
		expect(isDefinitionStyleQuestion("您希望从哪个维度对比？技术架构/使用场景")).toBe(false);
		expect(isDefinitionStyleQuestion("对比深度要功能层面还是架构层面？")).toBe(false);
		expect(isDefinitionStyleQuestion("受众是开发者还是业务方？")).toBe(false);
	});
});

describe("filterDecisionMissing", () => {
	it("drops definition-style items and keeps decision ones", () => {
		const items: TcoMissingInput[] = [
			{
				key: "workbuddy_definition",
				question: "workbuddy 在 OMP 项目中具体指什么？",
				type: "text",
				required: true,
				why_critical: "need def",
			},
			{
				key: "workbuddy_identity",
				question: "确认一下身份",
				type: "text",
				required: true,
				why_critical: "id",
			},
			{
				key: "project_names",
				question: "哪两个项目？",
				type: "text",
				required: true,
				why_critical: "names",
			},
			{
				key: "comparison_context",
				question: "您希望从哪个维度对比？",
				type: "list",
				required: false,
				why_critical: "depth",
			},
		];
		const kept = filterDecisionMissing(items);
		expect(kept.map(i => i.key)).toEqual(["comparison_context"]);
	});
});
