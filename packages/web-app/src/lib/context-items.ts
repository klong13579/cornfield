/**
 * 编辑器上下文条目（T9；T22 补 scope / version）—— composer 把「文件 / 选区 / 产物 / URL」
 * 附加到下一条消息的纯逻辑。
 *
 * 运行时关系（不另造注入通道）：
 *   - `@<path>` 提及由 agent 运行时 `packages/coding-agent/src/utils/file-mentions.ts` 读取
 *     （正则 `@([^\s@]+)` + 边界检查）并注入 FileMentionMessage。本文件只负责把条目
 *     序列化进 prompt 文本，不读文件、不缓存内容、不做第二次注入。
 *   - 运行时只能带整个文件，所以「选区」额外把选中文本原样内联进 prompt。
 *
 * kind 词表与 `packages/coding-agent/src/agent-domain/types.ts` 的 `ContextItemKind` 同源：
 * web-app 不依赖 coding-agent 包，故此处重述同一个联合类型，取值不增不减。
 *
 * 两件随附事实（票 22）—— 有就有、没有就说没有，都不编：
 *   scope    这条引用属于哪个范围。规则是 wire 的 `classifyScope`（与技能页同一份），
 *            本文件只把 workspace 相对路径摆成判定要的绝对路径，并给浏览器侧的包含判定。
 *   version  这条引用创建那一刻那份文件的内容版本（fs_read 的 version = 内容 sha256）。
 *            由 store 从打开文件时的 baseVersion 带进来；没读到就是缺省。
 */

import { classifyScope, type PathContainment, type Scope, type ScopeAnchors } from "@cornfield/wire";

export type ContextItemKind = "file" | "selection" | "artifact" | "url";

/** 条目的随附事实（由 store 从会话锚点与打开的文件算出来）。 */
export interface ContextItemFacts {
	/** 范围（共享规则判）；判不了 = 缺省，不写一个猜的。 */
	scope?: Scope;
	/** 文件内容版本；不知道 = 缺省，不写空串。 */
	version?: string;
}

export interface ContextItem {
	/** 稳定身份：同一条目重复添加得到同一个 id（React key + 去重都靠它）。 */
	id: string;
	kind: ContextItemKind;
	/** agent 工作区相对路径（file/selection/artifact）或 URL（url）。 */
	path: string;
	/** 选中的文本，仅 kind === "selection" 有。 */
	text?: string;
	/** 1-based 闭区间行范围，仅 kind === "selection" 有。 */
	lineStart?: number;
	lineEnd?: number;
	/** Agent 家 / 会话所在的 Project / 两者之外；缺省 = 判不了（拿不到锚点）。 */
	scope?: Scope;
	/** 创建这条引用时那份文件的版本；缺省 = 不知道（不是空串，也不编一个）。 */
	version?: string;
}

/** 条目的身份字段：id 与去重都从这一组字段派生，不各自定义。 */
type ContextItemIdentity = Pick<ContextItem, "kind" | "path" | "lineStart" | "lineEnd" | "text">;

const SELECTION_FENCE = "```";

/**
 * 身份 → id。票面写的是 kind + path + range，这里额外把选区文本一起放进身份，理由：
 * dedupe 把「同路径同范围但文本不同」视为两个条目，若 id 不含文本，这两个条目就会共用
 * 一个 React key（列表错位）。id 与去重必须共用同一个身份定义，否则两条规则迟早打架。
 *
 * 用 JSON 而不是分隔符拼接：选区文本是任意文本，任何分隔符都可能出现在文本里。
 */
function contextItemId(identity: ContextItemIdentity): string {
	return JSON.stringify([
		identity.kind,
		identity.path,
		identity.lineStart ?? null,
		identity.lineEnd ?? null,
		identity.text ?? null,
	]);
}

export function makeFileContextItem(path: string, facts: ContextItemFacts = {}): ContextItem {
	return withFacts({ id: contextItemId({ kind: "file", path }), kind: "file", path }, facts);
}

export function makeSelectionContextItem(
	input: {
		path: string;
		text: string;
		lineStart: number;
		lineEnd: number;
	},
	facts: ContextItemFacts = {},
): ContextItem {
	return withFacts({ id: contextItemId({ kind: "selection", ...input }), kind: "selection", ...input }, facts);
}

/** 事实是可选的（判不了/没读到就是缺省），但**不写 null 也不写空串**：缺省就是缺省。 */
function withFacts(item: ContextItem, facts: ContextItemFacts): ContextItem {
	const withScope = facts.scope === undefined ? item : { ...item, scope: facts.scope };
	return facts.version === undefined ? withScope : { ...withScope, version: facts.version };
}

/**
 * workspace 相对路径 → 判定用的绝对路径（serve 的 fs_read 也是按 agentDir 解析的，同一把尺子）。
 * 返回 null = 这条路径不在坐标里（空串 / 以 `/` 开头 / 含 `..` 段）：这时**判不了**范围，
 * 宁可缺省也不拍一个出来（`../x` 会被 serve 拒读，拿它判范围就是给一个不存在的文件定范围）。
 */
export function workspaceAbsolutePath(workspaceRoot: string, path: string): string | null {
	const root = workspaceRoot.replace(/\/+$/, "");
	const trimmed = path.trim();
	if (root.length === 0 || trimmed.length === 0 || trimmed.startsWith("/")) return null;
	if (trimmed.split("/").includes("..")) return null;
	return `${root}/${trimmed}`;
}

/**
 * 浏览器侧的包含判定（wire `classifyScope` 的 `contains` 入参）。
 *
 * 只做文本比较：浏览器没有 realpath，也拿不到平台路径语义 —— 做不到的归一就不假装做
 * （serve 侧用 utils 的 pathIsWithin，口径相同 + symlink 归一）。口径一致的部分：
 * 根自身算在范围内，兄弟目录不算（`/a/b-next` 不在 `/a/b` 里）。
 */
export const pathContains: PathContainment = (root, candidate) => {
	const trimmed = root.replace(/\/+$/, "");
	if (trimmed.length === 0) return candidate.startsWith("/");
	return candidate === trimmed || candidate.startsWith(`${trimmed}/`);
};

/**
 * 版本这个事实只对「文件类」条目成立（URL 不是文件）。
 * 对链接说「版本未知」是把「不适用」说成「没读到」—— 两件不同的事。
 */
export function hasFileVersion(kind: ContextItemKind): boolean {
	return kind !== "url";
}

/**
 * 条目的随附事实：scope 走共享规则判（拿不到锚点 / 路径判不了 = 缺省），version 取调用方给的那一份。
 *
 * URL 不是工作区路径（没有「相对哪个工作区」这回事），所以**不**跟 agentDir 拼接：直接拿它本身去
 * 问规则 —— 没有锚点包含它 ⇒ 两者之外（global）。拼接出一个 `…/https://…` 才是编事实。
 * `version: ""` 按「还不知道」处理：store 里 baseVersion 在读取途中就是空串，它不是版本。
 */
export function contextItemFacts(input: {
	kind: ContextItemKind;
	path: string;
	/** 这条引用归属 Agent 的家（绝对路径）；缺省 = 不知道它属于哪个 Agent 的工作区。 */
	agentDir?: string;
	/** 会话所属 Project 的 root；缺省 = 未归属（不是空串）。 */
	projectRoot?: string;
	/** 文件版本（fs_read 的 version）；"" / 缺省 = 还不知道。 */
	version?: string;
}): ContextItemFacts {
	const facts: ContextItemFacts = {};
	const version = input.version ?? "";
	if (hasFileVersion(input.kind) && version.length > 0) facts.version = version;
	if (input.agentDir === undefined || input.agentDir.length === 0) return facts;
	const reference = input.kind === "url" ? input.path : workspaceAbsolutePath(input.agentDir, input.path);
	if (reference === null) return facts;
	// 会话根：web-app 的条目路径本来就按 agentDir 解析（serve 的 resolveFsPath 同口径），
	// agent 会话的会话 cwd 就是它 —— 所以两个锚点同值，与 serve 侧传给技能判定的一样。
	const anchors: ScopeAnchors = { agentDir: input.agentDir, sessionCwd: input.agentDir };
	if (input.projectRoot !== undefined && input.projectRoot.length > 0) anchors.projectRoot = input.projectRoot;
	facts.scope = classifyScope(reference, anchors, pathContains);
	return facts;
}

/** 偏移量夹到 [0, length]；非有限值按「贴到最近端点」处理（NaN 视为文档起点）。 */
function clampOffset(offset: number, length: number): number {
	if (!Number.isFinite(offset)) return offset > 0 ? length : 0;
	return Math.min(Math.max(Math.floor(offset), 0), length);
}

/** 偏移量之前（不含该偏移）的换行数 → 1-based 行号。 */
function lineAt(document: string, offset: number): number {
	let line = 1;
	for (let index = 0; index < offset; index += 1) {
		if (document[index] === "\n") line += 1;
	}
	return line;
}

/**
 * 1-based 闭区间行范围，按整份文档文本计算 textarea 选区。
 *
 * 行号只数 `\n`；选区末尾正好落在某行行首时，最后一个被选中的字符是上一行的换行符，
 * 所以归上一行（`"a\nb\n"` 选第一行连同换行 ⇒ 1-1）。空选区退化成光标所在的那一行。
 * 越界或倒置的偏移夹回文档内，函数永不返回越界行号。
 */
export function selectionLineRange(
	document: string,
	selectionStart: number,
	selectionEnd: number,
): { lineStart: number; lineEnd: number } {
	const length = document.length;
	const rawStart = clampOffset(selectionStart, length);
	const rawEnd = clampOffset(selectionEnd, length);
	const from = Math.min(rawStart, rawEnd);
	const to = Math.max(rawStart, rawEnd);
	// 末字符下标：结束偏移本身不属于选区，落在行首时前移一位即上一行的换行符。
	const lastIndex = to > from ? to - 1 : from;
	return { lineStart: lineAt(document, from), lineEnd: lineAt(document, lastIndex) };
}

/** selection 的三件套缺一不可：缺了就会往 prompt 里写 `undefined-undefined`，宁可当场报错。 */
function requireSelectionPayload(item: ContextItem): { text: string; lineStart: number; lineEnd: number } {
	const { text, lineStart, lineEnd } = item;
	if (text === undefined || lineStart === undefined || lineEnd === undefined) {
		throw new Error(`formatContextItems: selection 条目缺少 text/lineStart/lineEnd 之一（path=${item.path}）`);
	}
	return { text, lineStart, lineEnd };
}

/**
 * 事实行：范围 + 版本。定位（类型/来源/选区范围）已经在各自的定位行上（`@path`、`[选区 …]`、URL），
 * 这里不重复。缺一件就写「未知」—— 空着会让模型以为没有这回事。
 */
function formatFactsLine(item: ContextItem): string {
	const parts = [`范围 ${item.scope ?? "未知"}`];
	if (hasFileVersion(item.kind)) parts.push(`版本 ${item.version ?? "未知"}`);
	return `[${parts.join(" · ")}]`;
}

function formatContextItem(item: ContextItem): string {
	switch (item.kind) {
		case "file":
		case "artifact":
			// 产物按路径寻址，与文件同形：都靠运行时的 @ 提及通道。
			return [`@${item.path}`, formatFactsLine(item)].join("\n");
		case "url":
			// URL 不是文件系统路径，交给模型自己去取，不发提及。
			return [item.path, formatFactsLine(item)].join("\n");
		case "selection": {
			const { text, lineStart, lineEnd } = requireSelectionPayload(item);
			// 选区文本原样进围栏：转义/裁剪都会篡改用户选中的内容。
			//
			// 已知边界（不要假设围栏能挡住正则）：运行时的提及提取（utils/file-mentions.ts）
			// 是对整段 prompt 做一次正则扫描并查边界字符，没有围栏感知，所以选区文本里
			// 形如 "@foo"、且 @ 前面是空白/开头的片段，仍可能被当成提及自动读取。
			// 这里不因此删改选区内容——选区必须逐字保留；会不会被读取由运行时说了算。
			return [
				`@${item.path}`,
				`[选区 ${item.path}:${lineStart}-${lineEnd}]`,
				formatFactsLine(item),
				SELECTION_FENCE,
				text,
				SELECTION_FENCE,
			].join("\n");
		}
		default: {
			const unreachable: never = item.kind;
			throw new Error(`formatContextItems: 未知的 ContextItem kind ${String(unreachable)}`);
		}
	}
}

/**
 * 序列化成附在草稿后面的提示块；空数组得到 `""`。条目块之间空一行，一条一块。
 *
 * 每条引用后面跟一行事实（范围 + 版本，见 {@link formatFactsLine}）：@ 提及行本身只说路径，
 * 模型看得到「引用了什么」，但看不到「这是谁的、哪个版本」—— §9 要求的正是后者。
 *
 * 已知限制：运行时的提及正则按空白切分，带空格的路径（`@my file.ts`）只会被运行时匹配到
 * `my` —— 那个文件不会被自动读取。条目本身照常发出（选区条目的 `[选区 …]` 行还带完整路径），
 * 不因为通道的限制就悄悄丢掉用户加的东西。
 */
export function formatContextItems(items: ContextItem[]): string {
	return items.map(formatContextItem).join("\n\n");
}

/** 草稿 + 提示块，就是发给 `prompt` 的整段文本。无条目时草稿原样返回。 */
export function composePrompt(draft: string, items: ContextItem[]): string {
	if (items.length === 0) return draft;
	const block = formatContextItems(items);
	// 草稿全是空白时不能把它的空白留在提示块前面（否则开头出现悬空空行）。
	if (draft.trim() === "") return block.trimStart();
	return `${draft}\n\n${block}`;
}

/**
 * 按身份去重，保留首次出现的顺序。
 *
 * 去重键重算而不是读 `item.id`：手工构造的条目可能带着与身份不符的 id，
 * 而「哪两个是同一个条目」是身份问题，不是那个字段说了算。
 */
export function dedupeContextItems(items: ContextItem[]): ContextItem[] {
	const seen = new Set<string>();
	const result: ContextItem[] = [];
	for (const item of items) {
		const identity = contextItemId(item);
		if (seen.has(identity)) continue;
		seen.add(identity);
		result.push(item);
	}
	return result;
}
