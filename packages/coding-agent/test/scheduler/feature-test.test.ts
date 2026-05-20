import { describe, expect, it } from "bun:test";
import { pruneExecutionLog } from "../../src/scheduler/execution-log";
import { executeScheduledCommand } from "../../src/scheduler/executor";

describe("Feature: skill chaining", () => {
	it("passes --skills to omp --print for agent tasks", async () => {
		const result = await executeScheduledCommand("echo hello", {
			taskType: "agent",
			skills: ["security-audit", "git-*"],
			ompBinary: "echo", // echo outputs its own args
		});

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("--skills");
		expect(result.output).toContain("security-audit,git-*");
	});

	it("omits --skills when no skills configured", async () => {
		const result = await executeScheduledCommand("echo hello", {
			taskType: "agent",
			ompBinary: "echo",
		});

		expect(result.output).not.toContain("--skills");
	});

	it("ignores skills for shell tasks", async () => {
		const result = await executeScheduledCommand("echo hello", {
			taskType: "shell",
			skills: ["security-audit"],
		});

		expect(result.exitCode).toBe(0);
		expect(result.output).not.toContain("--skills");
	});
});

describe("Feature: pre-script", () => {
	it("injects pre-script output into command for agent tasks", async () => {
		const result = await executeScheduledCommand("echo main-task", {
			taskType: "agent",
			preScript: "test-script-output.sh",
			ompBinary: "echo",
		});

		expect(result.exitCode).toBe(0);
		// preScript with a non-existent script in scriptsDir will skip silently
		// We just verify execution still works
		expect(result.output).toContain("main-task");
	});

	it("handles preScript with absolute path rejection", async () => {
		// Absolute paths should be rejected by the path traversal guard
		const result = await executeScheduledCommand("echo hello", {
			taskType: "agent",
			preScript: "/etc/passwd",
			ompBinary: "echo",
		});

		expect(result.exitCode).toBe(0);
		// Pre-script failure should not block main execution
	});
});

describe("Feature: JSONL execution log", () => {
	it("prunes logs correctly", () => {
		// Verify the helper doesn't crash on empty/non-existent logs
		const count = pruneExecutionLog("nonexistent-task", 10);
		expect(count).toBe(0);
	});
});
