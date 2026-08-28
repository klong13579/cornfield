import { afterEach, describe, expect, it, vi } from "bun:test";
import * as lspmux from "../src/lsp/lspmux";

/**
 * Unit tests for the lspmux integration (LSP server multiplexing).
 *
 * The launchd-branch tests mock Bun.spawn / Bun.write / Bun.file so they
 * never touch the real LaunchAgents dir, launchctl, or ~/.cornfield/logs.
 */

function fakeProc(exit: number = 0) {
	return { exited: Promise.resolve(exit), kill: () => {}, unref: () => {} };
}

function enoentError(): Error & { code: string } {
	const err = new Error("no such file") as Error & { code: string };
	err.code = "ENOENT";
	return err;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("isLspmuxSupported", () => {
	it("accepts rust-analyzer", () => {
		expect(lspmux.isLspmuxSupported("rust-analyzer")).toBe(true);
	});

	it("accepts absolute paths by base name", () => {
		expect(lspmux.isLspmuxSupported("/Users/x/.cargo/bin/rust-analyzer")).toBe(true);
	});

	it("rejects typescript-language-server (lspmux handshake incompatibility) and others", () => {
		expect(lspmux.isLspmuxSupported("typescript-language-server")).toBe(false);
		expect(lspmux.isLspmuxSupported("pyright")).toBe(false);
		expect(lspmux.isLspmuxSupported("bash-language-server")).toBe(false);
	});
});

describe("wrapWithLspmux", () => {
	const binaryPath = "/fake/bin/lspmux";

	it("returns original when lspmux unavailable", () => {
		const state = { available: false, running: false, binaryPath: null, config: null };
		expect(lspmux.wrapWithLspmux("rust-analyzer", [], state)).toEqual({ command: "rust-analyzer", args: [] });
	});

	it("returns original when server not running", () => {
		const state = { available: true, running: false, binaryPath, config: null };
		expect(lspmux.wrapWithLspmux("rust-analyzer", [], state)).toEqual({ command: "rust-analyzer", args: [] });
	});

	it("wraps default rust-analyzer (no args) to bare lspmux", () => {
		const state = { available: true, running: true, binaryPath, config: null };
		expect(lspmux.wrapWithLspmux("rust-analyzer", [], state)).toEqual({ command: binaryPath, args: [] });
	});

	it("returns original for typescript-language-server (defers to direct spawn)", () => {
		const state = { available: true, running: true, binaryPath, config: null };
		const wrapped = lspmux.wrapWithLspmux("typescript-language-server", ["--stdio"], state);
		expect(wrapped).toEqual({ command: "typescript-language-server", args: ["--stdio"] });
	});

	it("wraps arg-carrying rust-analyzer to lspmux client with LSPMUX_SERVER env", () => {
		const state = { available: true, running: true, binaryPath, config: null };
		const wrapped = lspmux.wrapWithLspmux("rust-analyzer", ["--verbose"], state);
		expect(wrapped.command).toBe(binaryPath);
		expect(wrapped.args).toEqual(["client", "--", "--verbose"]);
		expect(wrapped.env).toEqual({ LSPMUX_SERVER: "rust-analyzer" });
	});
});

describe("generateLspmuxPlist", () => {
	it("emits a valid launchd agent pointing at the lspmux binary", () => {
		const plist = lspmux.generateLspmuxPlist("/fake/bin/lspmux", "/Users/test");
		expect(plist).toContain("<key>Label</key>");
		expect(plist).toContain("com.narwal.pi-lspmux");
		expect(plist).toContain("/fake/bin/lspmux");
		expect(plist).toContain("<string>server</string>");
		expect(plist).toContain("<key>RunAtLoad</key>");
		expect(plist).toContain("<key>KeepAlive</key>");
		expect(plist).toContain("StandardOutPath");
		expect(plist).toContain("lspmux.log");
		expect(plist).toContain(pathCargoBin());
	});

	function pathCargoBin(): string {
		// PATH literal includes <home>/.cargo/bin — assert on the normalized form.
		return "/Users/test/.cargo/bin";
	}
});

describe("ensureLspmuxServer", () => {
	it("returns state unchanged when lspmux unavailable", async () => {
		const state = { available: false, running: false, binaryPath: null, config: null };
		const result = await lspmux.ensureLspmuxServer(state);
		expect(result).toBe(state);
	});

	it("returns state unchanged when already running", async () => {
		const state = { available: true, running: true, binaryPath: "/fake/bin/lspmux", config: null };
		const result = await lspmux.ensureLspmuxServer(state);
		expect(result).toBe(state);
	});

	it("registers a launchd agent and waits for the server (macOS path)", async () => {
		const binaryPath = "/fake/bin/lspmux";
		const state = { available: true, running: false, binaryPath, config: null };

		// Plist does not exist → Bun.file throws ENOENT.
		vi.spyOn(Bun, "file").mockReturnValue({
			text: async () => {
				throw enoentError();
			},
			exists: async () => false,
		} as unknown as ReturnType<typeof Bun.file>);

		const writeMock = vi.spyOn(Bun, "write").mockResolvedValue(0);

		// launchctl print/bootstrap exit 0; `lspmux status` exits 0 (server up).
		vi.spyOn(Bun, "spawn").mockImplementation((() => fakeProc(0)) as never);

		const result = await lspmux.ensureLspmuxServer(state);

		expect(result.running).toBe(true);
		expect(result).not.toBe(state); // new object with running=true

		// plist was written with the launchd label and server args
		expect(writeMock).toHaveBeenCalledTimes(1);
		const [plistPath, content] = writeMock.mock.calls[0];
		expect(String(plistPath)).toContain("LaunchAgents");
		expect(String(content)).toContain("com.narwal.pi-lspmux");
		expect(String(content)).toContain(binaryPath);
		expect(String(content)).toContain("<string>server</string>");
	});

	it("does not rewrite the plist when it already exists", async () => {
		const state = { available: true, running: false, binaryPath: "/fake/bin/lspmux", config: null };

		vi.spyOn(Bun, "file").mockReturnValue({
			text: async () => '<plist version="1.0"></plist>',
			exists: async () => true,
		} as unknown as ReturnType<typeof Bun.file>);
		const writeMock = vi.spyOn(Bun, "write").mockResolvedValue(0);
		vi.spyOn(Bun, "spawn").mockImplementation((() => fakeProc(0)) as never);

		const result = await lspmux.ensureLspmuxServer(state);
		expect(result.running).toBe(true);
		expect(writeMock).not.toHaveBeenCalled();
	});

	it("pollServerRunning returns false when the server never answers", async () => {
		vi.spyOn(Bun, "spawn").mockImplementation((() => fakeProc(1)) as never);
		// 300ms budget keeps the test fast.
		const ok = await lspmux.pollServerRunning("/fake/bin/lspmux", 300);
		expect(ok).toBe(false);
	});

	it("pollServerRunning returns true as soon as the server answers", async () => {
		// First call fails, second answers — poller must retry, not give up.
		const status = vi
			.spyOn(Bun, "spawn")
			.mockImplementation((() => fakeProc(1)) as never)
			.mockImplementationOnce((() => fakeProc(1)) as never)
			.mockImplementationOnce((() => fakeProc(0)) as never);

		const ok = await lspmux.pollServerRunning("/fake/bin/lspmux", 2_000);
		expect(ok).toBe(true);
		expect(status).toHaveBeenCalledTimes(2);
	});
});

describe("getLspmuxCommand", () => {
	it("starts the server on demand and wraps the command", async () => {
		const installed = { available: true, running: false, binaryPath: "/fake/bin/lspmux", config: null };
		const running = { available: true, running: true, binaryPath: "/fake/bin/lspmux", config: null };

		const detectSpy = vi.spyOn(lspmux, "detectLspmux").mockResolvedValue(installed);
		const ensureSpy = vi.spyOn(lspmux, "ensureLspmuxServer").mockResolvedValue(running);

		const wrapped = await lspmux.getLspmuxCommand("rust-analyzer", []);

		expect(detectSpy).toHaveBeenCalledTimes(1);
		expect(ensureSpy).toHaveBeenCalledTimes(1);
		expect(ensureSpy).toHaveBeenCalledWith(installed);
		expect(wrapped).toEqual({ command: "/fake/bin/lspmux", args: [] });
	});

	it("skips ensure when already running", async () => {
		const running = { available: true, running: true, binaryPath: "/fake/bin/lspmux", config: null };
		vi.spyOn(lspmux, "detectLspmux").mockResolvedValue(running);
		const ensureSpy = vi.spyOn(lspmux, "ensureLspmuxServer").mockResolvedValue(running);

		const wrapped = await lspmux.getLspmuxCommand("rust-analyzer", []);

		expect(ensureSpy).not.toHaveBeenCalled();
		expect(wrapped.command).toBe("/fake/bin/lspmux");
	});

	it("falls back to the original command when lspmux is not installed", async () => {
		const unavailable = { available: false, running: false, binaryPath: null, config: null };
		vi.spyOn(lspmux, "detectLspmux").mockResolvedValue(unavailable);
		const ensureSpy = vi.spyOn(lspmux, "ensureLspmuxServer").mockResolvedValue(unavailable);

		const wrapped = await lspmux.getLspmuxCommand("rust-analyzer", ["--print-config"]);

		expect(ensureSpy).not.toHaveBeenCalled();
		expect(wrapped).toEqual({ command: "rust-analyzer", args: ["--print-config"] });
	});
});
