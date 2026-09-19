import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as drey from "../src/lsp/drey";

/**
 * Unit tests for the drey integration (LSP server multiplexing).
 *
 * No test runs a real drey: the binary lookup, the daemon liveness probe and the
 * daemon spawn are all mocked, so nothing is started and nothing is written
 * outside the process.
 */

function fakeProc(exit: number = 0, onUnref?: () => void) {
	return {
		exited: Promise.resolve(exit),
		kill: () => {},
		unref: () => onUnref?.(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("isDreySupported", () => {
	it("accepts typescript-language-server, by name and by path", () => {
		expect(drey.isDreySupported("typescript-language-server")).toBe(true);
		expect(drey.isDreySupported("/opt/homebrew/bin/typescript-language-server")).toBe(true);
	});

	it("rejects servers drey has no profile for", () => {
		expect(drey.isDreySupported("rust-analyzer")).toBe(false);
		expect(drey.isDreySupported("pyright")).toBe(false);
		expect(drey.isDreySupported("bash-language-server")).toBe(false);
		expect(drey.isDreySupported("")).toBe(false);
	});
});

describe("wrapWithDrey", () => {
	const binaryPath = "/fake/bin/drey";

	it("returns the original command when drey is unavailable", () => {
		expect(drey.wrapWithDrey("typescript-language-server", ["--stdio"], null)).toEqual({
			command: "typescript-language-server",
			args: ["--stdio"],
		});
	});

	it("returns the original command for a server drey cannot front", () => {
		expect(drey.wrapWithDrey("rust-analyzer", [], binaryPath)).toEqual({ command: "rust-analyzer", args: [] });
	});

	it("wraps into a drey shim when the args match its builtin profile", () => {
		expect(drey.wrapWithDrey("typescript-language-server", ["--stdio"], binaryPath)).toEqual({
			command: binaryPath,
			args: ["serve", "typescript"],
		});
	});

	it("wraps a path-qualified server command by base name", () => {
		const wrapped = drey.wrapWithDrey("/opt/homebrew/bin/typescript-language-server", ["--stdio"], binaryPath);
		expect(wrapped).toEqual({ command: binaryPath, args: ["serve", "typescript"] });
	});

	it("treats absent args as the builtin profile", () => {
		expect(drey.wrapWithDrey("typescript-language-server", undefined, binaryPath)).toEqual({
			command: binaryPath,
			args: ["serve", "typescript"],
		});
	});

	it("declines when configured args differ, rather than letting the daemon drop them", () => {
		const custom = ["--stdio", "--log-level", "4"];
		expect(drey.wrapWithDrey("typescript-language-server", custom, binaryPath)).toEqual({
			command: "typescript-language-server",
			args: custom,
		});
		expect(drey.wrapWithDrey("typescript-language-server", [], binaryPath).command).toBe(
			"typescript-language-server",
		);
	});
});

describe("getDreyCommand", () => {
	it("skips detection entirely for a server drey cannot front", async () => {
		const findSpy = vi.spyOn(drey, "findDreyBinary");
		const wrapped = await drey.getDreyCommand("rust-analyzer", []);
		expect(wrapped).toEqual({ command: "rust-analyzer", args: [] });
		expect(findSpy).not.toHaveBeenCalled();
	});

	it("spawns directly when drey is not installed", async () => {
		vi.spyOn(drey, "findDreyBinary").mockResolvedValue(null);
		const ensureSpy = vi.spyOn(drey, "ensureDreyDaemon");
		const wrapped = await drey.getDreyCommand("typescript-language-server", ["--stdio"]);
		expect(wrapped).toEqual({ command: "typescript-language-server", args: ["--stdio"] });
		expect(ensureSpy).not.toHaveBeenCalled();
	});

	it("uses the shim without touching the daemon when one is already answering", async () => {
		vi.spyOn(drey, "findDreyBinary").mockResolvedValue("/fake/bin/drey");
		vi.spyOn(drey, "checkDaemonRunning").mockResolvedValue(true);
		const ensureSpy = vi.spyOn(drey, "ensureDreyDaemon").mockResolvedValue(true);

		const wrapped = await drey.getDreyCommand("typescript-language-server", ["--stdio"]);

		expect(wrapped).toEqual({ command: "/fake/bin/drey", args: ["serve", "typescript"] });
		expect(ensureSpy).not.toHaveBeenCalled();
	});

	it("starts the daemon first when none is running, then uses the shim", async () => {
		vi.spyOn(drey, "findDreyBinary").mockResolvedValue("/fake/bin/drey");
		vi.spyOn(drey, "checkDaemonRunning").mockResolvedValue(false);
		const ensureSpy = vi.spyOn(drey, "ensureDreyDaemon").mockResolvedValue(true);

		const wrapped = await drey.getDreyCommand("typescript-language-server", ["--stdio"]);

		expect(ensureSpy).toHaveBeenCalledTimes(1);
		expect(wrapped).toEqual({ command: "/fake/bin/drey", args: ["serve", "typescript"] });
	});

	it("never hands out the shim without a daemon", async () => {
		// A shim that autostarts its own daemon makes the daemon inherit this
		// process's stdio, so it would outlive the session holding the pipe.
		vi.spyOn(drey, "findDreyBinary").mockResolvedValue("/fake/bin/drey");
		vi.spyOn(drey, "checkDaemonRunning").mockResolvedValue(false);
		vi.spyOn(drey, "ensureDreyDaemon").mockResolvedValue(false);

		const wrapped = await drey.getDreyCommand("typescript-language-server", ["--stdio"]);

		expect(wrapped).toEqual({ command: "typescript-language-server", args: ["--stdio"] });
	});
});

describe("ensureDreyDaemon", () => {
	it("starts the daemon detached with its stdio on the log file", async () => {
		const writeMock = vi.spyOn(Bun, "write").mockResolvedValue(0);
		const openMock = vi.spyOn(fs, "openSync").mockReturnValue(3);
		const closeMock = vi.spyOn(fs, "closeSync").mockReturnValue(undefined);
		const unref = vi.fn();
		const spawnMock = vi.spyOn(Bun, "spawn").mockImplementation((() => fakeProc(0, unref)) as never);

		const started = await drey.ensureDreyDaemon("/fake/bin/drey");

		expect(started).toBe(true);
		expect(writeMock).toHaveBeenCalledTimes(1);
		expect(String(writeMock.mock.calls[0][0])).toContain("drey.log");

		expect(openMock).toHaveBeenCalledWith(drey.getDreyLogPath(), "a");
		const [argv, options] = spawnMock.mock.calls[0] as [string[], Record<string, unknown>];
		expect(argv).toEqual(["/fake/bin/drey", "daemon"]);
		expect(options.detached).toBe(true);
		expect(options.stdin).toBe("ignore");
		expect(options.stdout).toBe(3);
		expect(unref).toHaveBeenCalledTimes(1);
		// The child holds its own descriptor copy; ours is closed to avoid a leak.
		expect(closeMock).toHaveBeenCalledWith(3);
	});

	it("reports failure when the daemon never answers", async () => {
		vi.spyOn(Bun, "write").mockResolvedValue(0);
		vi.spyOn(fs, "openSync").mockReturnValue(3);
		vi.spyOn(fs, "closeSync").mockReturnValue(undefined);
		vi.spyOn(Bun, "spawn").mockImplementation((() => fakeProc(0)) as never);
		vi.spyOn(drey, "pollDaemonRunning").mockResolvedValue(false);

		expect(await drey.ensureDreyDaemon("/fake/bin/drey")).toBe(false);
	});

	it("reports failure when the daemon cannot be spawned", async () => {
		vi.spyOn(Bun, "write").mockResolvedValue(0);
		vi.spyOn(fs, "openSync").mockReturnValue(3);
		vi.spyOn(fs, "closeSync").mockReturnValue(undefined);
		vi.spyOn(Bun, "spawn").mockImplementation((() => {
			throw new Error("ENOENT");
		}) as never);

		expect(await drey.ensureDreyDaemon("/fake/bin/drey")).toBe(false);
	});
});

describe("daemon liveness", () => {
	it("checkDaemonRunning is false when drey cannot be executed", async () => {
		vi.spyOn(Bun, "spawn").mockImplementation((() => {
			throw new Error("ENOENT");
		}) as never);
		expect(await drey.checkDaemonRunning("/fake/bin/drey")).toBe(false);
	});

	it("pollDaemonRunning returns false when the daemon never answers", async () => {
		vi.spyOn(Bun, "spawn").mockImplementation((() => fakeProc(1)) as never);
		// A 300ms budget keeps the test fast.
		expect(await drey.pollDaemonRunning("/fake/bin/drey", 300)).toBe(false);
	});

	it("pollDaemonRunning returns true as soon as the daemon answers", async () => {
		const spawnMock = vi
			.spyOn(Bun, "spawn")
			.mockImplementationOnce((() => fakeProc(1)) as never)
			.mockImplementationOnce((() => fakeProc(0)) as never);
		expect(await drey.pollDaemonRunning("/fake/bin/drey", 2_000)).toBe(true);
		expect(spawnMock).toHaveBeenCalledTimes(2);
	});
});

describe("findDreyBinary", () => {
	it("logs under the cornfield logs directory", () => {
		expect(drey.getDreyLogPath()).toContain("drey.log");
	});

	it("returns null when multiplexing is disabled by env", async () => {
		process.env.CORNFIELD_DISABLE_DREY = "1";
		try {
			expect(await drey.findDreyBinary()).toBeNull();
		} finally {
			delete process.env.CORNFIELD_DISABLE_DREY;
		}
	});
});
