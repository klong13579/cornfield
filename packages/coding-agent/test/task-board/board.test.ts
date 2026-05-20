import { describe, expect, test } from "bun:test";
import { createTaskBoard } from "@oh-my-pi/pi-coding-agent/task-board/board";

const sampleYaml = `
topics:
  - id: topic-a
    name: Topic A
    brief: First topic
    status: in-progress
    modules: [coding-agent]
  - id: topic-b
    name: Topic B
    brief: Second topic
    status: planned
    tags: [tui]
`;

describe("TaskBoard", () => {
	test("loads topics from YAML", () => {
		const board = createTaskBoard();
		board.load(sampleYaml);
		expect(board.getTopics()).toHaveLength(2);
	});

	test("getTopic returns matching topic", () => {
		const board = createTaskBoard();
		board.load(sampleYaml);
		expect(board.getTopic("topic-a")?.name).toBe("Topic A");
	});

	test("getByStatus filters correctly", () => {
		const board = createTaskBoard();
		board.load(sampleYaml);
		expect(board.getByStatus("planned")).toHaveLength(1);
	});

	test("getByModule filters correctly", () => {
		const board = createTaskBoard();
		board.load(sampleYaml);
		expect(board.getByModule("coding-agent")).toHaveLength(1);
	});

	test("getByTag filters correctly", () => {
		const board = createTaskBoard();
		board.load(sampleYaml);
		expect(board.getByTag("tui")).toHaveLength(1);
	});
});
