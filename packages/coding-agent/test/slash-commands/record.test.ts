/**
 * Tests for `/record` and `/listen` slash command bindings.
 *
 * Verifies that each command form correctly dispatches to the
 * listenController methods on InteractiveModeContext.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import * as os from "node:os";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { ListenController } from "@oh-my-pi/pi-coding-agent/stt/listen-controller";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const listenController = {
		startRecording: vi.fn().mockResolvedValue(undefined),
		stopRecording: vi.fn().mockResolvedValue(undefined),
		cancelRecording: vi.fn().mockResolvedValue(undefined),
		transcribeFile: vi.fn().mockResolvedValue(undefined),
		state: "idle" as const,
		elapsed: undefined as number | undefined,
		dispose: vi.fn(),
	} satisfies Partial<ListenController> as unknown as ListenController;

	const showStatus = vi.fn();
	const showWarning = vi.fn();
	const showError = vi.fn();
	const setText = vi.fn();

	const ctx = {
		listenController,
		editor: { setText } as unknown as InteractiveModeContext["editor"],
		showStatus,
		showWarning,
		showError,
	} as unknown as InteractiveModeContext;

	return {
		listenController,
		showStatus,
		showWarning,
		showError,
		setText,
		runtime: {
			ctx,
			handleBackgroundCommand: vi.fn(),
		} as any,
	};
}

// ────────────────────────────────────────────────────────────────────────────
// /record
// ────────────────────────────────────────────────────────────────────────────

describe("/record slash command", () => {
	let h: ReturnType<typeof createRuntime>;

	beforeEach(() => {
		h = createRuntime();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("/record starts mic recording", async () => {
		const handled = await executeBuiltinSlashCommand("/record", h.runtime);
		expect(handled).toBe(true);
		expect(h.listenController.startRecording).toHaveBeenCalledTimes(1);
		expect(h.listenController.stopRecording).not.toHaveBeenCalled();
	});

	test("/record stop stops recording", async () => {
		const handled = await executeBuiltinSlashCommand("/record stop", h.runtime);
		expect(handled).toBe(true);
		expect(h.listenController.stopRecording).toHaveBeenCalledTimes(1);
	});

	test("/record cancel cancels recording", async () => {
		const handled = await executeBuiltinSlashCommand("/record cancel", h.runtime);
		expect(handled).toBe(true);
		expect(h.listenController.cancelRecording).toHaveBeenCalledTimes(1);
	});

	test("/record <filepath> transcribes file with description from basename", async () => {
		const handled = await executeBuiltinSlashCommand("/record test-interview.wav", h.runtime);
		expect(handled).toBe(true);
		expect(h.listenController.transcribeFile).toHaveBeenCalledWith(
			"test-interview.wav",
			"test-interview",
		);
	});

	test("/record <filepath> expands ~ to homedir", async () => {
		const handled = await executeBuiltinSlashCommand("/record ~/audio/test.wav", h.runtime);
		expect(handled).toBe(true);
		const expectedPath = path.join(os.homedir(), "audio", "test.wav");
		expect(h.listenController.transcribeFile).toHaveBeenCalledWith(
			expectedPath,
			"test",
		);
	});

	test("/record with extra whitespace in path is handled", async () => {
		const handled = await executeBuiltinSlashCommand("/record   /path/to/file.wav", h.runtime);
		expect(handled).toBe(true);
		expect(h.listenController.transcribeFile).toHaveBeenCalledWith(
			"/path/to/file.wav",
			"file",
		);
	});

	test("unknown /record subcommand is treated as filepath", async () => {
		const handled = await executeBuiltinSlashCommand("/record resume", h.runtime);
		expect(handled).toBe(true);
		expect(h.listenController.transcribeFile).toHaveBeenCalledWith(
			"resume",
			"resume",
		);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// /listen
// ────────────────────────────────────────────────────────────────────────────

describe("/listen slash command", () => {
	let h: ReturnType<typeof createRuntime>;

	beforeEach(() => {
		h = createRuntime();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("/listen list invokes list handler", async () => {
		const handled = await executeBuiltinSlashCommand("/listen list", h.runtime);
		expect(handled).toBe(true);
	});

	test("/listen search without keyword shows usage", async () => {
		const handled = await executeBuiltinSlashCommand("/listen search", h.runtime);
		expect(handled).toBe(true);
		expect(h.showStatus).toHaveBeenCalledWith(
			expect.stringContaining("Usage"),
		);
	});

	test("/listen export without filename shows usage", async () => {
		const handled = await executeBuiltinSlashCommand("/listen export", h.runtime);
		expect(handled).toBe(true);
		expect(h.showStatus).toHaveBeenCalledWith(
			expect.stringContaining("Usage"),
		);
	});

	test("bare /listen without subcommand does not error", async () => {
		const handled = await executeBuiltinSlashCommand("/listen", h.runtime);
		expect(handled).toBe(true);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Edge cases
// ────────────────────────────────────────────────────────────────────────────

describe("unknown slash command", () => {
	test("unrecognised slash command returns false", async () => {
		const h = createRuntime();
		const handled = await executeBuiltinSlashCommand("/notarealcommand", h.runtime);
		expect(handled).toBe(false);
	});
});
