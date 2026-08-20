/**
 * One-way sync of <projectRoot>/TODO.md backlog rows into the herdr-board "todo" board.
 *
 * - 幂等：按标题查重，已存在的卡跳过（不更新描述）。
 * - 带 topic 的行（`- [ ] <text> → topics/<slug>.md`）会把 topic frontmatter 摘要
 *   写进卡片描述；无 topic 的行建普通卡。
 * - 只同步 `## 待办` 节；`## 已完成` 不导入。
 * - TODO.md 是事实源：本脚本只往看板建卡，绝不写回 TODO.md。
 *
 * 用法：bun run scripts/todo-to-board.ts [--dry-run]
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const dryRun = process.argv.includes("--dry-run");
const repoRoot = path.resolve(import.meta.dir, "..");
const todoPath = path.join(repoRoot, "TODO.md");
const topicsDir = path.join(repoRoot, "topics");
const BOARD_NAME = "todo";
const COLUMN_NAME = "Todo";

type TopicSummary = {
	status?: string;
	objective?: string;
	nextAction?: string;
	doneWhenFirst?: string;
};

/** 简单 frontmatter 解析：单行字段 + 列表字段首项。 */
function parseTopicSummary(fileText: string): TopicSummary {
	const fm = fileText.match(/^---\n([\s\S]*?)\n---/);
	if (!fm) return {};

	const result: TopicSummary = {};
	let listKey: keyof TopicSummary | undefined;
	for (const raw of fm[1].split("\n")) {
		const single = raw.match(/^(\w+):\s*(.*)$/);
		if (single) {
			const key = single[1] as "status" | "objective" | "nextAction" | "doneWhen";
			const value = single[2].trim();
			if (key === "status") result.status = value;
			if (key === "objective") result.objective = value;
			if (key === "nextAction") result.nextAction = value;
			if (key === "doneWhen" && value.length > 0 && value !== "|" && value !== "|-" && !result.doneWhenFirst) {
				result.doneWhenFirst = value;
			}
			listKey = key === "doneWhen" ? "doneWhenFirst" : undefined;
			continue;
		}
		const listItem = raw.match(/^\s*-\s+(.*)$/);
		if (listItem && listKey) {
			if (!result[listKey]) result[listKey] = listItem[1].trim();
			listKey = undefined;
		}
	}
	return result;
}

async function run(cmd: string[]): Promise<string> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([proc.stdout.text(), proc.stderr.text()]);
	const code = await proc.exited;
	if (code !== 0) {
		throw new Error(`${cmd.join(" ")} exited ${code}: ${stderr}`);
	}
	return stdout;
}

async function boardIdByName(): Promise<string> {
	const out = await run(["board", "board", "list", "--json"]);
	const boards = JSON.parse(out) as { id: number; name: string }[];
	const found = boards.find((b) => b.name === BOARD_NAME);
	if (!found) throw new Error(`board "${BOARD_NAME}" not found; create it first: board board create ${BOARD_NAME}`);
	return String(found.id);
}

function parseBacklogRows(fileText: string): Array<{ text: string; topic?: string }> {
	const section = fileText.split(/^## /m).find((s) => s.startsWith("待办"));
	if (!section) return [];
	return section
		.split("\n")
		.filter((line) => /^- \[ \]/.test(line))
		.map((line) => {
			const topic = line.match(/→\s*topics\/([a-z0-9-]+\.md)/)?.[1];
			return { text: line.replace(/^- \[ \]\s*/, "").replace(/\s*→\s*topics\/[a-z0-9-]+\.md\s*$/, "").trim(), topic };
		});
}

async function topicSummary(topic: string): Promise<TopicSummary> {
	try {
		const text = await fs.readFile(path.join(topicsDir, topic), "utf8");
		return parseTopicSummary(text);
	} catch {
		return {};
	}
}

function descriptionFor(row: { text: string; topic?: string }, summary: TopicSummary): string {
	if (!row.topic) return "（无 topic）";
	const lines = [`topic: topics/${row.topic}`];
	if (summary.status) lines.push(`status: ${summary.status}`);
	if (summary.objective) lines.push(`objective: ${summary.objective}`);
	if (summary.doneWhenFirst) lines.push(`doneWhen: ${summary.doneWhenFirst}`);
	if (summary.nextAction) lines.push(`nextAction: ${summary.nextAction}`);
	return lines.join("\n");
}

async function main(): Promise<void> {
	const todoText = await fs.readFile(todoPath, "utf8");
	const rows = parseBacklogRows(todoText);
	if (rows.length === 0) {
		console.log("no backlog rows under ## 待办");
		return;
	}

	const boardId = await boardIdByName();
	const existingOut = await run(["board", "card", "list", "--board", boardId, "--json"]);
	const existing = new Set(
		(JSON.parse(existingOut) as Array<{ title: string }>).map((c) => c.title),
	);

	let created = 0;
	const skipped: string[] = [];
	for (const row of rows) {
		if (existing.has(row.text)) {
			skipped.push(row.text);
			continue;
		}
		const desc = descriptionFor(row, await topicSummary(row.topic ?? ""));
		if (!dryRun) {
			await run([
				"board", "card", "create", "--board", boardId,
				"--title", row.text,
				"--description", desc,
				"--column", COLUMN_NAME,
				"--json",
			]);
		}
		created += 1;
	}

	console.log(`TODO backlog: ${rows.length} rows, board "${BOARD_NAME}" (id ${boardId})`);
	console.log(`created: ${created}${dryRun ? " (dry-run, not executed)" : ""}, skipped (already on board): ${skipped.length}`);
	for (const s of skipped) console.log(`  skip: ${s}`);
}

await main().catch((err) => {
	console.error(String(err));
	process.exit(1);
});