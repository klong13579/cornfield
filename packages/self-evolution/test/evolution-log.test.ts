import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	generateEvolutionLogMd,
	groupByDate,
	type LogEntry,
	projectEvolutionLog,
	readActivityLog,
} from "../src/logging/evolution-log";

describe("groupByDate", () => {
	test("groups entries by ISO date", () => {
		const entries: LogEntry[] = [
			{
				timestamp: new Date("2026-05-10T10:00:00Z").getTime(),
				event: "skill_extracted",
				details: { skillName: "a" },
			},
			{ timestamp: new Date("2026-05-10T14:00:00Z").getTime(), event: "skill_merged", details: { skillName: "b" } },
			{
				timestamp: new Date("2026-05-11T08:00:00Z").getTime(),
				event: "skill_deprecated",
				details: { skillName: "c" },
			},
		];
		const groups = groupByDate(entries);
		expect(groups.size).toBe(2);
		expect(groups.get("2026-05-10")).toHaveLength(2);
		expect(groups.get("2026-05-11")).toHaveLength(1);
	});
});

describe("generateEvolutionLogMd", () => {
	test("renders empty state", () => {
		const md = generateEvolutionLogMd([]);
		expect(md).toContain("No evolution events recorded yet");
	});

	test("renders skill events", () => {
		const entries: LogEntry[] = [
			{
				timestamp: new Date("2026-05-10T10:30:00Z").getTime(),
				event: "skill_extracted",
				details: { skillName: "refactor-ts", qualityScore: 85 },
			},
			{
				timestamp: new Date("2026-05-10T11:15:00Z").getTime(),
				event: "skill_merged",
				details: { skillName: "refactor-ts", oldVersion: 1, newVersion: 2 },
			},
			{
				timestamp: new Date("2026-05-10T14:00:00Z").getTime(),
				event: "skill_deprecated",
				details: { skillName: "old-pattern", reason: "superseded" },
			},
		];
		const md = generateEvolutionLogMd(entries);
		expect(md).toContain("## 2026-05-10");
		expect(md).toContain("**Skill extracted**: `refactor-ts` (quality: 85)");
		expect(md).toContain("**Skill merged**: `refactor-ts` v1 → v2");
		expect(md).toContain("**Skill deprecated**: `old-pattern` — superseded");
	});

	test("filters non-evolution events", () => {
		const entries: LogEntry[] = [
			{
				timestamp: new Date("2026-05-10T10:00:00Z").getTime(),
				event: "skill_extracted",
				details: { skillName: "a" },
			},
			{ timestamp: new Date("2026-05-10T10:01:00Z").getTime(), event: "tool_called", details: { toolName: "read" } },
		];
		const _md = generateEvolutionLogMd(entries);
	});
	test("respects maxEventsPerDay", () => {
		const entries: LogEntry[] = Array.from({ length: 5 }, (_, i) => ({
			timestamp: new Date(`2026-05-10T${10 + i}:00:00Z`).getTime(),
			event: "skill_extracted",
			details: { skillName: `skill-${i}` },
		}));
		const md = generateEvolutionLogMd(entries, { maxEventsPerDay: 2 });
		const matches = md.match(/\*\*Skill extracted\*\*/g);
		expect(matches).toHaveLength(2);
		expect(md).toContain("and 3 more events");
	});

	test("sorts dates in reverse chronological order", () => {
		const entries: LogEntry[] = [
			{
				timestamp: new Date("2026-05-08T10:00:00Z").getTime(),
				event: "skill_extracted",
				details: { skillName: "a" },
			},
			{
				timestamp: new Date("2026-05-10T10:00:00Z").getTime(),
				event: "skill_extracted",
				details: { skillName: "b" },
			},
			{
				timestamp: new Date("2026-05-09T10:00:00Z").getTime(),
				event: "skill_extracted",
				details: { skillName: "c" },
			},
		];
		const md = generateEvolutionLogMd(entries);
		const idx10 = md.indexOf("## 2026-05-10");
		const idx09 = md.indexOf("## 2026-05-09");
		const idx08 = md.indexOf("## 2026-05-08");
		expect(idx10).toBeLessThan(idx09);
		expect(idx09).toBeLessThan(idx08);
	});
});

describe("readActivityLog", () => {
	test("reads JSONL entries", async () => {
		const tmpPath = path.join(os.tmpdir(), `activity-${Date.now()}.log`);
		const lines = [
			JSON.stringify({ timestamp: 1000, event: "skill_extracted", details: { skillName: "a" } }),
			JSON.stringify({ timestamp: 2000, event: "skill_merged", details: { skillName: "b" } }),
		].join("\n");
		await Bun.write(tmpPath, lines);

		const entries = await readActivityLog(tmpPath);
		expect(entries).toHaveLength(2);
		expect(entries[0]!.event).toBe("skill_extracted");
		expect(entries[1]!.event).toBe("skill_merged");
	});

	test("returns empty for missing file", async () => {
		const entries = await readActivityLog("/nonexistent/activity.log");
		expect(entries).toHaveLength(0);
	});

	test("skips corrupt lines", async () => {
		const tmpPath = path.join(os.tmpdir(), `activity-corrupt-${Date.now()}.log`);
		await Bun.write(tmpPath, `{invalid json\n${JSON.stringify({ timestamp: 1000, event: "a", details: {} })}`);

		const entries = await readActivityLog(tmpPath);
		expect(entries).toHaveLength(1);
	});
});

describe("projectEvolutionLog", () => {
	test("writes evolution_log.md from activity log", async () => {
		const tmpDir = os.tmpdir();
		const logPath = path.join(tmpDir, `activity-proj-${Date.now()}.log`);
		const lines = [
			JSON.stringify({
				timestamp: new Date("2026-05-10T10:00:00Z").getTime(),
				event: "skill_extracted",
				details: { skillName: "test-skill", qualityScore: 90 },
			}),
		].join("\n");
		await Bun.write(logPath, lines);

		const outPath = await projectEvolutionLog(logPath, { outputDir: tmpDir });
		expect(outPath).toEndWith("evolution_log.md");

		const md = await Bun.file(outPath).text();
		expect(md).toContain("# Evolution Log");
		expect(md).toContain("test-skill");
		expect(md).toContain("quality: 90");
	});
});
