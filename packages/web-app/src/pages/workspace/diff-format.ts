/**
 * 文件编辑面板的 diff 解析（与渲染分离，便于按仓库既有 *-logic 惯例单测）。
 *
 * 线上只有**一种** diff 文本：`generateUnifiedDiffString`（coding-agent 侧）产出的
 * 带行号 unified diff。这里不做第二套生成/比对，只把它拆成可渲染的行。
 *
 * 形状固定为四种：
 *   @@ -oldStart,oldLines +newStart,newLines @@   hunk 头
 *   +<newLineNo>|<content>                        新增行
 *   -<oldLineNo>|<content>                        删除行
 *   <space><lineNo>|<content>                     上下文行
 *
 * 拆不出来的一律当作 hunk 原文透传 —— 宁可多显示一行，也不能静默吞掉内容。
 */

export type DiffRow =
	| { kind: "hunk"; text: string }
	| { kind: "add" | "del" | "context"; lineNo: number; text: string };

const DIGITS_ONLY = /^[0-9]+$/;

function parseRow(line: string): DiffRow {
	const prefix = line[0];
	if (prefix !== "+" && prefix !== "-" && prefix !== " ") {
		return { kind: "hunk", text: line };
	}

	const body = line.slice(1);
	// 只按**第一个** `|` 切分：行内容自身可能含 `|`（`const a = b | c;`）。
	const separator = body.indexOf("|");
	if (separator === -1) {
		return { kind: "hunk", text: line };
	}

	const lineNoText = body.slice(0, separator);
	if (!DIGITS_ONLY.test(lineNoText)) {
		return { kind: "hunk", text: line };
	}

	const lineNo = Number(lineNoText);
	if (lineNo < 1) {
		return { kind: "hunk", text: line };
	}

	const kind: "add" | "del" | "context" = prefix === "+" ? "add" : prefix === "-" ? "del" : "context";
	return { kind, lineNo, text: body.slice(separator + 1) };
}

/** 把带行号的 unified diff 文本拆成展示行。 */
export function parseNumberedDiff(diff: string): DiffRow[] {
	if (diff === "") return [];

	const lines = diff.split("\n");
	// 末尾换行只是行终止符，不是一行空内容 —— 否则每个 hunk 尾部都会多出一行幽灵行。
	if (lines[lines.length - 1] === "") {
		lines.pop();
	}

	return lines.map(line => parseRow(line.endsWith("\r") ? line.slice(0, -1) : line));
}

/** 审阅头部用的增删行数统计（只数 add/del，hunk 与 context 不计）。 */
export function summarizeDiff(rows: DiffRow[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const row of rows) {
		if (row.kind === "add") added++;
		else if (row.kind === "del") removed++;
	}
	return { added, removed };
}
