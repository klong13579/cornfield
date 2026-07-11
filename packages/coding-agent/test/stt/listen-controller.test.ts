/**
 * Tests for ListenController — file naming, state machine, callbacks.
 *
 * vi.mock overrides module resolution so named imports in the source
 * (`import { detectRecordingTools } from "./recorder"`) are intercepted.
 * The factory creates mocks; beforeEach resets and configures per-test.
 * fs/promises is namespace-imported in source so vi.spyOn works directly.
 *
 * Settings must be initialized (inMemory) because listen-controller reads
 * `settings.get("stt.modelName")` in stopRecording/transcribeFile.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { ListenController, buildFilename } from "@oh-my-pi/pi-coding-agent/stt/listen-controller";
import * as fsp from "node:fs/promises";

// Shared mock instances — hoisted before static imports, shared across tests.
const detectRecordingTools = vi.fn<string[]>();
const startRecording = vi.fn<Promise<{ stop: () => Promise<void> }>>();
const verifyRecordingFile = vi.fn<Promise<number>>();
const transcribe = vi.fn<Promise<string>>();

vi.mock("@oh-my-pi/pi-coding-agent/stt/recorder", () => ({
	detectRecordingTools,
	startRecording,
	verifyRecordingFile,
}));
vi.mock("@oh-my-pi/pi-coding-agent/stt/transcriber", () => ({ transcribe }));

// Import Settings AFTER vi.mock registrations (hoisted)
let Settings: Awaited<typeof import("@oh-my-pi/pi-coding-agent/config/settings")>["Settings"];

// ────────────────────────────────────────────────────────────────────────────
// buildFilename
// ────────────────────────────────────────────────────────────────────────────

describe("buildFilename", () => {
	test("uses description when provided", () => {
		const name = buildFilename("英勇面试");
		expect(name).toMatch(/^\d{4}-\d{2}-\d{2}-英勇面试\.json$/);
	});

	test("sanitizes special characters from description", () => {
		const name = buildFilename("foo/bar:test*baz?");
		expect(name).toMatch(/^\d{4}-\d{2}-\d{2}-foobartestbaz\.json$/);
	});

	test("replaces whitespace with hyphens", () => {
		const name = buildFilename("hello   world\tday");
		expect(name).toMatch(/^\d{4}-\d{2}-\d{2}-hello-world-day\.json$/);
	});

	test("truncates long descriptions to 80 chars", () => {
		const name = buildFilename("a".repeat(200));
		expect(name).toMatch(/^\d{4}-\d{2}-\d{2}-/);
		expect(name.length).toBeLessThanOrEqual(96);
	});

	test("falls back to HHMMSS when no description", () => {
		const name = buildFilename();
		expect(name).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}\.json$/);
	});

	test("empty safe description after sanitization still produces valid filename", () => {
		const name = buildFilename("<>:\"");
		expect(name).toMatch(/^\d{4}-\d{2}-\d{2}-\.json$/);
	});

	test("already-safe CJK description passes through", () => {
		const name = buildFilename("产品评审-2026-03");
		expect(name).toMatch(/^\d{4}-\d{2}-\d{2}-产品评审-2026-03\.json$/);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// ListenController — state machine + callbacks
// ────────────────────────────────────────────────────────────────────────────

describe("ListenController", () => {
	let ctrl: ListenController;
	let showWarning: ReturnType<typeof vi.fn>;
	let showStatus: ReturnType<typeof vi.fn>;
	let onStatusChange: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		// Initialize Settings singleton (inMemory) so settings.get() doesn't
		// throw "Settings not initialized" in stopRecording/transcribeFile.
		if (!Settings) {
			const mod = await import("@oh-my-pi/pi-coding-agent/config/settings");
			Settings = mod.Settings;
		}
		await Settings.init({ inMemory: true });

		showWarning = vi.fn();
		showStatus = vi.fn();
		onStatusChange = vi.fn();

		detectRecordingTools.mockReset().mockReturnValue([]);
		startRecording.mockReset();
		verifyRecordingFile.mockReset().mockResolvedValue(1000);
		transcribe.mockReset().mockResolvedValue("");

		ctrl = new ListenController({ showWarning, showStatus, onStatusChange });
	});

	afterEach(async () => {
		ctrl?.dispose();
		vi.restoreAllMocks();
		// Reset settings singleton for next test
		await Settings.init({ inMemory: true });
	});

	// ── initial state ──

	test("starts in idle state", () => {
		expect(ctrl.state).toBe("idle");
		expect(ctrl.elapsed).toBeUndefined();
	});

	// ── startRecording — no tools ──

	test("startRecording warns when no recording tools available", async () => {
		detectRecordingTools.mockReturnValue([]);
		await ctrl.startRecording();
		expect(showWarning).toHaveBeenCalledWith(
			expect.stringContaining("No recording tool found"),
		);
		expect(ctrl.state).toBe("idle");
		expect(detectRecordingTools).toHaveBeenCalled();
	});

	// ── startRecording — already recording ──

	test("startRecording warns when already recording", async () => {
		detectRecordingTools.mockReturnValue(["ffmpeg"]);
		startRecording.mockResolvedValue({ stop: vi.fn().mockResolvedValue(undefined) });

		await ctrl.startRecording();
		expect(ctrl.state).toBe("recording");

		await ctrl.startRecording();
		expect(showWarning).toHaveBeenCalledWith(
			expect.stringContaining("Already recording"),
		);
		expect(ctrl.state).toBe("recording");
	});

	// ── stopRecording — when idle ──

	test("stopRecording is no-op when idle", async () => {
		await ctrl.stopRecording();
		expect(ctrl.state).toBe("idle");
		expect(showWarning).not.toHaveBeenCalled();
	});

	// ── full cycle: start → stop → transcribe → save ──

	test("full recording lifecycle", async () => {
		detectRecordingTools.mockReturnValue(["ffmpeg"]);
		const fakeHandle = { stop: vi.fn().mockResolvedValue(undefined) };
		startRecording.mockResolvedValue(fakeHandle);
		transcribe.mockResolvedValue("你好 大家好");

		await ctrl.startRecording();
		expect(ctrl.state).toBe("recording");

		await ctrl.stopRecording("测试录音");
		expect(ctrl.state).toBe("idle");
		expect(fakeHandle.stop).toHaveBeenCalledTimes(1);
		expect(verifyRecordingFile).toHaveBeenCalled();
		expect(transcribe).toHaveBeenCalled();
	});

	test("state transitions are reported via onStatusChange", async () => {
		detectRecordingTools.mockReturnValue(["ffmpeg"]);
		startRecording.mockResolvedValue({ stop: vi.fn().mockResolvedValue(undefined) });
		transcribe.mockResolvedValue("text");

		await ctrl.startRecording();
		await ctrl.stopRecording();

		const stateCalls = onStatusChange.mock.calls.map((c: any[]) => c[0].state);
		expect(stateCalls).toContain("recording");
		expect(stateCalls).toContain("transcribing");
		expect(stateCalls[stateCalls.length - 1]).toBe("idle");
	});

	test("transcribed text is saved as JSON with correct shape", async () => {
		detectRecordingTools.mockReturnValue(["ffmpeg"]);
		startRecording.mockResolvedValue({ stop: vi.fn().mockResolvedValue(undefined) });
		transcribe.mockResolvedValue("这是测试转写文本");

		const fspWriteSpy = vi.spyOn(fsp, "writeFile").mockResolvedValue(undefined);

		await ctrl.startRecording();
		await ctrl.stopRecording();

		const writeCall = fspWriteSpy.mock.calls[0];
		const filePath = writeCall[0] as string;
		const content = writeCall[1] as string;
		const parsed = JSON.parse(content);

		expect(filePath).toMatch(/\.omp\/listen\/\d{4}-\d{2}-\d{2}-/);
		expect(parsed.version).toBe(1);
		expect(parsed.text).toBe("这是测试转写文本");
		expect(parsed.recorded_at).toBeDefined();
	});

	// ── transcribeFile ──

	test("transcribeFile warns when file not found", async () => {
		vi.spyOn(fsp, "access").mockRejectedValue(new Error("ENOENT"));
		await ctrl.transcribeFile("/nonexistent/file.wav", "test");
		expect(showWarning).toHaveBeenCalledWith(
			expect.stringContaining("File not found"),
		);
		expect(ctrl.state).toBe("idle");
	});

	test("transcribeFile warns when currently recording", async () => {
		detectRecordingTools.mockReturnValue(["ffmpeg"]);
		startRecording.mockResolvedValue({ stop: vi.fn().mockResolvedValue(undefined) });

		await ctrl.startRecording();
		await ctrl.transcribeFile("/some/file.wav", "test");
		expect(showWarning).toHaveBeenCalledWith(
			expect.stringContaining("Recording in progress"),
		);
	});

	test("transcribeFile succeeds with valid file path", async () => {
		vi.spyOn(fsp, "access").mockResolvedValue(undefined);
		const fspWriteSpy = vi.spyOn(fsp, "writeFile").mockResolvedValue(undefined);
		transcribe.mockResolvedValue("转写结果文本");

		await ctrl.transcribeFile("/valid/file.wav", "测试文件");
		expect(ctrl.state).toBe("idle");
		expect(fspWriteSpy).toHaveBeenCalled();

		const content = fspWriteSpy.mock.calls[0][1] as string;
		const parsed = JSON.parse(content);
		expect(parsed.text).toBe("转写结果文本");
	});

	// ── cancelRecording ──

	test("cancelRecording warns when idle", async () => {
		await ctrl.cancelRecording();
		expect(showWarning).toHaveBeenCalledWith(
			expect.stringContaining("No active recording"),
		);
	});

	test("cancelRecording returns to idle and cleans up", async () => {
		detectRecordingTools.mockReturnValue(["ffmpeg"]);
		const fakeHandle = { stop: vi.fn().mockResolvedValue(undefined) };
		startRecording.mockResolvedValue(fakeHandle);

		await ctrl.startRecording();
		expect(ctrl.state).toBe("recording");

		await ctrl.cancelRecording();
		expect(ctrl.state).toBe("idle");
		expect(fakeHandle.stop).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledWith(
			expect.stringContaining("cancelled"),
		);
	});

	// ── elapsed ──

	test("elapsed is undefined when not recording", () => {
		expect(ctrl.elapsed).toBeUndefined();
	});

	test("elapsed becomes defined during recording", async () => {
		detectRecordingTools.mockReturnValue(["ffmpeg"]);
		startRecording.mockResolvedValue({ stop: vi.fn().mockResolvedValue(undefined) });

		await ctrl.startRecording();
		expect(ctrl.elapsed).toBeGreaterThanOrEqual(0);
	});

	// ── dispose ──

	test("dispose cleans up active recording", async () => {
		detectRecordingTools.mockReturnValue(["ffmpeg"]);
		startRecording.mockResolvedValue({ stop: vi.fn().mockResolvedValue(undefined) });

		await ctrl.startRecording();
		ctrl.dispose();
		expect(ctrl.state).toBe("idle");
	});

	test("dispose is safe to call multiple times", () => {
		ctrl.dispose();
		ctrl.dispose();
		expect(ctrl.state).toBe("idle");
	});

	// ── startRecording — tool failure ──

	test("startRecording shows warning when recorder throws", async () => {
		detectRecordingTools.mockReturnValue(["ffmpeg"]);
		startRecording.mockRejectedValue(new Error("ffmpeg not found"));

		await ctrl.startRecording();
		expect(ctrl.state).toBe("idle");
		expect(showWarning).toHaveBeenCalledWith(
			expect.stringContaining("ffmpeg not found"),
		);
	});
});
