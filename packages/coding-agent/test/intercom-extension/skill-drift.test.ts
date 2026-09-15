/**
 * skill-drift.test.ts — 把 pi-intercom 的 prose 契约钉到代码上
 *
 * 为什么需要它：`skills/pi-intercom/SKILL.md` 被编进 binary、会话启动时落盘，是 agent 读
 * intercom 用法的唯一来源，而它此前**零测试** —— 2026-09-15 一次复核查出四处与代码不符
 * （attachment 声称没有 `path` 字段、`send` 的「忙时会丢」前提、结果字段名写成 `result.delivered`、
 * `/name` 不是 cornfield 的命令），没有一处会自报。这份测试只断言「两份表示必须一致」的硬事实，
 * 不锁措辞：改措辞不会红，改事实才会红。
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { INTERCOM_ACTION_NAMES } from "../../src/intercom-extension/index";

const extensionDir = path.resolve(import.meta.dirname!, "../../src/intercom-extension");
const skillMd = fs.readFileSync(path.join(extensionDir, "skills/pi-intercom/SKILL.md"), "utf8");
const readmeMd = fs.readFileSync(path.join(extensionDir, "README.md"), "utf8");

/** 取 `## Key Differences` 表格第一列的反引号动作名（跳过表头行，遇非表格行即止）。 */
function actionsFromSkill(): string[] {
	const lines = skillMd.split("\n");
	const start = lines.findIndex(line => line.trim() === "## Key Differences");
	expect(start).toBeGreaterThanOrEqual(0);
	const actions: string[] = [];
	let inTable = false;
	for (const line of lines.slice(start + 1)) {
		const match = /^\|\s*`([a-z-]+)`/.exec(line);
		if (match?.[1]) {
			inTable = true;
			actions.push(match[1]);
			continue;
		}
		if (inTable) break;
	}
	return actions;
}

describe("SKILL.md ↔ 代码：action 词表", () => {
	test("Key Differences 表里的 action 集合 == INTERCOM_ACTION_NAMES（不多不少）", () => {
		expect(actionsFromSkill().sort()).toEqual([...INTERCOM_ACTION_NAMES].sort());
	});

	test("schema 的 action 说明由名称表生成，不再手写第二份", () => {
		// 2026-09-15 的形态：enum 数组 / 补全表 / description 三处并列，`children` 漏在补全表里。
		const source = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf8");
		expect(source).not.toContain("Action: 'list', 'list-cwd'");
	});
});

describe("SKILL.md ↔ 代码：已知会写错的那些事实", () => {
	test("结果字段用 details，不是裸字段", () => {
		for (const needle of ["result.delivered", "result.reason", "result.isError"]) {
			expect({ needle, found: skillMd.includes(needle) }).toEqual({ needle, found: false });
		}
	});

	test("attachment 用 `path` 携带文件，不把路径塞进 `name`", () => {
		expect(skillMd).toContain("`Attachment` 有独立的 `path` 字段");
		expect(skillMd).not.toContain("`name` 放绝对路径");
	});

	test("会话命名用 `/rename`，不是 `/name`", () => {
		expect(skillMd).not.toContain("/name ");
		expect(readmeMd).not.toContain("/name planner");
	});

	test("README 的同源错误不得回潮", () => {
		expect(readmeMd).not.toContain("`name` = path");
	});

	test("pending / history 的覆盖范围写清了（只列 ask；send 不会出现）", () => {
		// 2026-09-16：说明只写 “inbound asks” 时，读的人（含 agent）会当成「全部来信」——
		// 实测 4/4 个 squad worker 把它当收件箱探针，四次全空。锁的是覆盖范围这个事实（pending 只
		// 装带 expectsReply 的 `ask`，见 src/intercom-extension/index.ts 的那两处 expectsReply），
		// 不是措辞：改写法可以，把「send 不会出现」丢掉就会红。
		const pendingRow = skillMd.split("\n").find(line => line.startsWith("| `pending`"));
		expect(pendingRow).toBeTruthy();
		expect(pendingRow).toContain("send");
		const source = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf8");
		expect(source).not.toContain("List unresolved inbound asks");
		expect(skillMd).not.toContain("Lists unresolved inbound asks");
	});
});
