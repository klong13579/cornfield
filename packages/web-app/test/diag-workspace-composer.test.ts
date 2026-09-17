import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	filterModelList,
	groupModelsByProvider,
	imageFilesFromClipboardData,
	isCurrentModel,
	ModelList,
	shouldSendOnEnter,
} from "../src/pages/workspace/ComposerBar";
import { CompactButton, compactStageAfter } from "../src/pages/workspace/WorkspaceView";

/**
 * 工作台输入区四条判据（diag harness `--page '#/workspace'` 同源断言）：
 *   1. 粘贴图片 → 附件（纯文本粘贴不被吞）；
 *   2. 模型下拉「当前」徽标只落实际生效那条（同 id 多 provider 可区分）+ 列表可过滤；
 *   3. compact 需显式确认（一点不真压缩）；
 *   4. 中文输入法组合态按 Enter 不发送、非组合态仍发送（与 T4 同一判据）。
 * 环境约束：web-app 全仓走 react-dom/server 静态渲染、无 DOM（见 Transcript.render.test.ts 注释），
 * 因此交互逻辑全部提成纯函数/纯展示组件，逐一可复跑。
 */

/** 剪贴板/文件选择里的图片文件（无 DOM：只断言 type 前缀）。 */
function fakeFile(type: string): File {
	return { type } as File;
}

function fakeClipboard(files: File[]): DataTransfer {
	return { files: files as unknown as FileList } as unknown as DataTransfer;
}

describe("粘贴图片 → 附件，纯文本不被吞", () => {
	test("剪贴板里的图片文件被筛出（附件来源）", () => {
		const image = fakeFile("image/png");
		const text = fakeFile("text/plain");
		expect(imageFilesFromClipboardData(fakeClipboard([image, text]))).toEqual([image]);
		expect(imageFilesFromClipboardData(fakeClipboard([image])).map(f => f.type)).toEqual(["image/png"]);
	});

	test("无剪贴板 / 空文件列表 → 空数组（onPaste 不 preventDefault，默认行为不受影响）", () => {
		expect(imageFilesFromClipboardData(null)).toEqual([]);
		expect(imageFilesFromClipboardData(undefined)).toEqual([]);
		expect(imageFilesFromClipboardData(fakeClipboard([]))).toEqual([]);
	});

	test("纯文本粘贴返回空数组 → 不被吞（onPaste 命中图片才 preventDefault）", () => {
		expect(imageFilesFromClipboardData(fakeClipboard([fakeFile("text/plain")]))).toEqual([]);
		expect(imageFilesFromClipboardData(fakeClipboard([fakeFile("application/pdf")]))).toEqual([]);
	});
});

describe("中文输入法组合态 Enter 判据", () => {
	test("非组合态 Enter 无 Shift → 发送", () => {
		expect(shouldSendOnEnter("Enter", false, false)).toBe(true);
	});

	test("组合态（isComposing）Enter → 不发送（选字确认不被当成发消息）", () => {
		expect(shouldSendOnEnter("Enter", false, true)).toBe(false);
	});

	test("Shift+Enter → 换行不发送；非 Enter → 不发送", () => {
		expect(shouldSendOnEnter("Enter", true, false)).toBe(false);
		expect(shouldSendOnEnter("Enter", true, true)).toBe(false);
		expect(shouldSendOnEnter("a", false, false)).toBe(false);
	});
});

describe("模型下拉「当前」徽标去重与过滤", () => {
	const SAME_ID_TWO_PROVIDERS = [
		{ id: "glm-5", provider: "alibaba-coding-plan" },
		{ id: "glm-5", provider: "narwal-plan" },
	];

	test("isCurrentModel：同 id 多 provider 只认实际生效 provider 那条", () => {
		const [a, b] = SAME_ID_TWO_PROVIDERS;
		expect(isCurrentModel(a, "glm-5", "narwal-plan")).toBe(false);
		expect(isCurrentModel(b, "glm-5", "narwal-plan")).toBe(true);
		expect(isCurrentModel(a, "glm-5", "alibaba-coding-plan")).toBe(true);
	});

	test("isCurrentModel：id 不匹配 / 无当前 id → false；provider 未知退回按 id 匹配", () => {
		expect(isCurrentModel({ id: "x", provider: "a" }, "glm-5", "a")).toBe(false);
		expect(isCurrentModel({ id: "glm-5", provider: "a" }, null, "a")).toBe(false);
		expect(isCurrentModel({ id: "glm-5", provider: "a" }, "glm-5", null)).toBe(true);
	});

	test("渲染：同 id 多 provider 只落一个「当前」徽标", () => {
		const html = renderToStaticMarkup(
			createElement(ModelList, {
				modelList: SAME_ID_TWO_PROVIDERS,
				currentModelId: "glm-5",
				currentModelProvider: "narwal-plan",
				onSelect: () => undefined,
			}),
		);
		const badges = html.match(/>当前</g) ?? [];
		expect(badges).toHaveLength(1);
	});

	test("groupModelsByProvider：实际生效 provider 置顶（同 id 多 provider 不靠 find 撞第一个）", () => {
		const groups = groupModelsByProvider(
			[
				{ id: "glm-5", provider: "alibaba-coding-plan" },
				{ id: "glm-5", provider: "narwal-plan" },
				{ id: "x", provider: "other" },
			],
			"glm-5",
			"narwal-plan",
		);
		expect(groups[0]?.[0]).toBe("narwal-plan");
	});

	test("filterModelList：provider / id 子串过滤，大小写不敏感，空串原样返回", () => {
		const list = [
			{ id: "glm-5", provider: "alibaba-coding-plan" },
			{ id: "deepseek-v4-pro", provider: "narwal-plan" },
		];
		expect(filterModelList(list, "GLM")).toEqual([{ id: "glm-5", provider: "alibaba-coding-plan" }]);
		expect(filterModelList(list, "narwal")).toEqual([{ id: "deepseek-v4-pro", provider: "narwal-plan" }]);
		expect(filterModelList(list, "")).toEqual(list);
		expect(filterModelList([], "x")).toEqual([]);
	});

	test("渲染：过滤输入框存在（列表可过滤），当前 provider 组置顶可见", () => {
		const html = renderToStaticMarkup(
			createElement(ModelList, {
				modelList: SAME_ID_TWO_PROVIDERS,
				currentModelId: "glm-5",
				currentModelProvider: "narwal-plan",
				onSelect: () => undefined,
			}),
		);
		expect(html).toContain('placeholder="过滤模型（id / provider）…"');
		expect(html).toContain("narwal-plan");
		expect(html).toContain("alibaba-coding-plan");
	});
});

describe("compact 需显式确认（一点不真压缩）", () => {
	test("状态机：只有 arming 态点 confirm 才 fire；cancel 永不 fire", () => {
		expect(compactStageAfter("arming", "confirm")).toEqual({ stage: "idle", fire: true });
		expect(compactStageAfter("idle", "confirm")).toEqual({ stage: "idle", fire: false });
		expect(compactStageAfter("arming", "cancel")).toEqual({ stage: "idle", fire: false });
		expect(compactStageAfter("idle", "cancel")).toEqual({ stage: "idle", fire: false });
	});

	test("渲染：初始态只有 compact 按钮 + 压缩说明，不直接弹确认", () => {
		const html = renderToStaticMarkup(createElement(CompactButton, { onCompact: () => undefined }));
		expect(html).toContain(">compact<");
		expect(html).toContain("压缩");
		// 初始态不渲染「确认/取消」两个动作（不是一点就真压缩）
		expect(html).not.toContain(">确认<");
		expect(html).not.toContain(">取消<");
	});
});
