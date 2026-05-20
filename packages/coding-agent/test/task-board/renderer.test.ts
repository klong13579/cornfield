import { beforeAll, describe, expect, test } from "bun:test";
import { renderTopicDetail, renderTopicList } from "@oh-my-pi/pi-coding-agent/task-board/renderer";
import type { TaskTopic } from "@oh-my-pi/pi-coding-agent/task-board/types";
import { getThemeByName, initTheme, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const sampleTopic: TaskTopic = {
	id: "sample",
	name: "Sample Topic",
	brief: "A brief description",
	status: "in-progress",
	progress: 42,
	modules: ["coding-agent"],
};

let theme: Theme;

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
	const resolved = await getThemeByName("dark");
	if (!resolved) throw new Error("theme not loaded");
	theme = resolved;
});

describe("TaskBoard Renderer", () => {
	test("renderTopicList includes status and name", () => {
		const lines = renderTopicList([sampleTopic], 120, theme);
		expect(lines[0]).toContain("Sample Topic");
	});

	test("renderTopicDetail includes name and brief", () => {
		const lines = renderTopicDetail(sampleTopic, 120, theme);
		const joined = lines.join("\n");
		expect(joined).toContain("Sample Topic");
		expect(joined).toContain("A brief description");
	});
});
