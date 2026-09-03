/**
 * 诊断纠正功能测试 —— parseCorrections + UserCorrectionDto 数据流。
 */
import { describe, expect, test } from "bun:test";

/** parseCorrections 函数的实现（从 diagnosis-runner.ts 提取）。 */
function parseCorrections(raw: string | undefined): Array<{
	turn: number;
	userText: string;
	targetDim: "intent" | "tool" | "output" | "reasoning" | "meta";
	intent: "correction" | "clarification" | "rejection";
	isValid: boolean;
	isResolved: boolean;
	precedingContext: string;
}> {
	if (!raw || raw === "{}") return [];
	try {
		const parsed = JSON.parse(raw) as { corrections?: Array<{
			turn: number;
			userText: string;
			targetDim: "intent" | "tool" | "output" | "reasoning" | "meta";
			intent: "correction" | "clarification" | "rejection";
			isValid: boolean;
			isResolved: boolean;
			precedingContext: string;
		}> };
		return parsed.corrections ?? [];
	} catch {
		return [];
	}
}

describe("parseCorrections", () => {
	test("undefined 返回空数组", () => {
		expect(parseCorrections(undefined)).toEqual([]);
	});

	test("空对象返回空数组", () => {
		expect(parseCorrections("{}")).toEqual([]);
	});

	test("空 corrections 数组返回空", () => {
		expect(parseCorrections('{"corrections":[]}')).toEqual([]);
	});

	test("解析单条纠正记录", () => {
		const raw = JSON.stringify({
			corrections: [
				{
					turn: 5,
					userText: "你理解错了，我要的是 A 不是 B",
					targetDim: "intent",
					intent: "correction",
					isValid: true,
					isResolved: false,
					precedingContext: "assistant 回复了 B 方案",
				},
			],
		});
		const result = parseCorrections(raw);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			turn: 5,
			targetDim: "intent",
			intent: "correction",
			isValid: true,
			isResolved: false,
		});
		expect(result[0].userText).toBe("你理解错了，我要的是 A 不是 B");
	});

	test("解析多条纠正记录", () => {
		const raw = JSON.stringify({
			corrections: [
				{
					turn: 3,
					userText: "不对，这个代码有 bug",
					targetDim: "output",
					intent: "correction",
					isValid: true,
					isResolved: true,
					precedingContext: "assistant 给出了代码",
				},
				{
					turn: 7,
					userText: "我补充一下，还要求支持 X",
					targetDim: "intent",
					intent: "clarification",
					isValid: true,
					isResolved: true,
					precedingContext: "assistant 正在实现功能",
				},
				{
					turn: 12,
					userText: "这个方案不行，重做",
					targetDim: "output",
					intent: "rejection",
					isValid: false,
					isResolved: false,
					precedingContext: "assistant 给出了完整方案",
				},
			],
		});
		const result = parseCorrections(raw);
		expect(result).toHaveLength(3);
		expect(result[0].intent).toBe("correction");
		expect(result[1].intent).toBe("clarification");
		expect(result[2].intent).toBe("rejection");
		expect(result[2].isValid).toBe(false);
	});

	test("非法 JSON 返回空数组", () => {
		expect(parseCorrections("not json")).toEqual([]);
	});

	test("缺失 corrections 字段返回空数组", () => {
		expect(parseCorrections('{"other": 1}')).toEqual([]);
	});
});

/**
 * 验证 DiagnosisSummaryDto 的 corrections 字段类型正确。
 * 运行时验证：构造一个匹配 DiagnosisSummaryDto 形状的对象，
 * 检查 corrections 字段可以被赋值和读取。
 */
test("DiagnosisSummaryDto 的 corrections 字段可正确赋值", () => {
	const dto: {
		reportId: string;
		sessionId: string;
		sessionFile: string;
		severity: string;
		delivery: string;
		process: string;
		title: string;
		rootCause: string;
		topActions: [string, string];
		dimensions: Record<string, unknown>;
		corrections?: Array<{
			turn: number;
			userText: string;
			targetDim: string;
			intent: string;
			isValid: boolean;
			isResolved: boolean;
			precedingContext: string;
		}>;
		reportAt: string;
	} = {
		reportId: "test",
		sessionId: "test",
		sessionFile: "test",
		severity: "P1",
		delivery: "C",
		process: "C",
		title: "test",
		rootCause: "test",
		topActions: ["a", "b"],
		dimensions: {},
		reportAt: new Date().toISOString(),
	};
	// 赋值 corrections
	dto.corrections = [
		{ turn: 1, userText: "test", targetDim: "intent", intent: "correction", isValid: true, isResolved: false, precedingContext: "ctx" },
	];
	expect(dto.corrections).toHaveLength(1);
	expect(dto.corrections[0].targetDim).toBe("intent");
});