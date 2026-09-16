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

/**
 * 并列（split）视图里的一格：某一侧文件里的一行。
 *
 * 行号沿用服务端的编号规则（del/context 是旧文件行号，add 是新文件行号）—— 两侧的行号
 * 各自来自它所属的那份文件，不是前端另算的一套。
 */
export interface SplitCell {
	lineNo: number;
	kind: "add" | "del" | "context";
	text: string;
}

/** 并列视图的一行：marker 跨两栏（hunk 头 / 拆不出来的原文），pair 是左右两格（某侧可空）。 */
export type SplitRow =
	| { kind: "marker"; text: string }
	| { kind: "pair"; left: SplitCell | null; right: SplitCell | null };

/** 真正的 hunk 头（`@@ -a,b +c,d @@`）；拆不出来的原文行不叫 hunk 头。 */
const HUNK_HEADER = /^@@/;

/** 一行是不是改动行（add/del）；不是（hunk/context）返回 null。 */
function changeCell(row: DiffRow | undefined): SplitCell | null {
	if (!row || (row.kind !== "add" && row.kind !== "del")) return null;
	return { lineNo: row.lineNo, kind: row.kind, text: row.text };
}

/**
 * 把统一 diff 的展示行配成并列视图的两栏。
 *
 * 三条规则，都是为了「屏幕上两栏对齐的那两行，就是同一次改动」：
 *   1. 一段连续的改动（夹在 hunk 头或上下文行之间）里，删除行与新增行按**下标**左右对齐；
 *      多出来的一侧留空格 —— 不是补一行假内容，也不是把多出来那几行藏起来。
 *   2. 上下文行左右同一份内容、两侧各自的**真实行号**：旧行号直接用服务端给的，
 *      新行号 = 旧行号 + 本 hunk 内此前的 (新增数 − 删除数)。
 *   3. hunk 头（`@@`）与拆不出来的原文（`diff --git` 之类）跨两栏整行显示；偏移只在本 hunk
 *      内成立，所以只有真正的 hunk 头让它归零。
 */
export function pairForSplit(rows: DiffRow[]): SplitRow[] {
	const out: SplitRow[] = [];
	/** hunk 内的新旧行号偏移：new = old + offset；每个 hunk 头归零。 */
	let offset = 0;
	let index = 0;
	while (index < rows.length) {
		const row = rows[index];
		if (row.kind === "hunk") {
			// 只有**真正的 hunk 头**（`@@`）划分段边界。其余拆不出来的原文（`diff --git`、
			// `\ No newline at end of file`）只是跨两栏的原文行：它们不改变「本 hunk 内新增
			// 减删除」的计数，拿它们把偏移归零会算出错的新文件行号。
			if (HUNK_HEADER.test(row.text)) offset = 0;
			out.push({ kind: "marker", text: row.text });
			index++;
			continue;
		}
		if (row.kind === "context") {
			out.push({
				kind: "pair",
				left: { lineNo: row.lineNo, kind: "context", text: row.text },
				right: { lineNo: row.lineNo + offset, kind: "context", text: row.text },
			});
			index++;
			continue;
		}

		const left: SplitCell[] = [];
		const right: SplitCell[] = [];
		for (let cell = changeCell(rows[index]); cell; cell = changeCell(rows[index])) {
			if (cell.kind === "del") left.push(cell);
			else right.push(cell);
			index++;
		}
		for (let i = 0; i < Math.max(left.length, right.length); i++) {
			out.push({ kind: "pair", left: left[i] ?? null, right: right[i] ?? null });
		}
		offset += right.length - left.length;
	}
	return out;
}
