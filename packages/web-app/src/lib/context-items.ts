/**
 * 编辑器上下文条目（T9）—— composer 把「文件 / 选区 / 产物 / URL」附加到下一条消息的纯逻辑。
 *
 * 运行时关系（不另造注入通道）：
 *   - `@<path>` 提及由 agent 运行时 `packages/coding-agent/src/utils/file-mentions.ts` 读取
 *     （正则 `@([^\s@]+)` + 边界检查）并注入 FileMentionMessage。本文件只负责把条目
 *     序列化进 prompt 文本，不读文件、不缓存内容、不做第二次注入。
 *   - 运行时只能带整个文件，所以「选区」额外把选中文本原样内联进 prompt。
 *
 * kind 词表与 `packages/coding-agent/src/agent-domain/types.ts` 的 `ContextItemKind` 同源：
 * web-app 不依赖 coding-agent 包，故此处重述同一个联合类型，取值不增不减。
 */

export type ContextItemKind = "file" | "selection" | "artifact" | "url";

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

export function makeFileContextItem(path: string): ContextItem {
	return { id: contextItemId({ kind: "file", path }), kind: "file", path };
}

export function makeSelectionContextItem(input: {
	path: string;
	text: string;
	lineStart: number;
	lineEnd: number;
}): ContextItem {
	return { id: contextItemId({ kind: "selection", ...input }), kind: "selection", ...input };
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

function formatContextItem(item: ContextItem): string {
	switch (item.kind) {
		case "file":
		case "artifact":
			// 产物按路径寻址，与文件同形：都靠运行时的 @ 提及通道。
			return `@${item.path}`;
		case "url":
			// URL 不是文件系统路径，交给模型自己去取，不发提及。
			return item.path;
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
