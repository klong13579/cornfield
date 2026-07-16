import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createFatalHandler, installStdioErrorGuards, isBrokenStdioError } from "../src/stdio-guard";

describe("isBrokenStdioError", () => {
	test("recognizes EIO / EPIPE / ENOTTY and stream-destroyed codes", () => {
		expect(isBrokenStdioError(Object.assign(new Error("eio"), { code: "EIO" }))).toBe(true);
		expect(isBrokenStdioError(Object.assign(new Error("epipe"), { code: "EPIPE" }))).toBe(true);
		expect(isBrokenStdioError(Object.assign(new Error("enotty"), { code: "ENOTTY" }))).toBe(true);
		expect(isBrokenStdioError(Object.assign(new Error("badf"), { code: "EBADF" }))).toBe(true);
		expect(
			isBrokenStdioError(Object.assign(new Error("destroyed"), { code: "ERR_STREAM_DESTROYED" })),
		).toBe(true);
		expect(
			isBrokenStdioError(Object.assign(new Error("after end"), { code: "ERR_STREAM_WRITE_AFTER_END" })),
		).toBe(true);
	});

	test("rejects unrelated errors", () => {
		expect(isBrokenStdioError(new Error("boom"))).toBe(false);
		expect(isBrokenStdioError(Object.assign(new Error("enoent"), { code: "ENOENT" }))).toBe(false);
		expect(isBrokenStdioError(null)).toBe(false);
		expect(isBrokenStdioError("EIO")).toBe(false);
	});
});

describe("installStdioErrorGuards", () => {
	test("swallows stream error events so they do not become uncaughtException", () => {
		const stream = new EventEmitter() as EventEmitter & { writable: boolean };
		stream.writable = true;

		const uncaught: unknown[] = [];
		const onUncaught = (err: unknown) => {
			uncaught.push(err);
		};
		process.on("uncaughtException", onUncaught);
		try {
			// Without a listener, Node would treat this as uncaught. With the guard,
			// the error must be absorbed.
			installStdioErrorGuards(stream as unknown as NodeJS.WriteStream);
			stream.emit("error", Object.assign(new Error("eio"), { code: "EIO" }));
			expect(uncaught).toHaveLength(0);
			// Idempotent: second install must not throw or double-fire.
			installStdioErrorGuards(stream as unknown as NodeJS.WriteStream);
			stream.emit("error", Object.assign(new Error("epipe"), { code: "EPIPE" }));
			expect(uncaught).toHaveLength(0);
		} finally {
			process.removeListener("uncaughtException", onUncaught);
		}
	});
});

describe("createFatalHandler", () => {
	test("reentrant calls exit immediately without logging again", async () => {
		const writes: string[] = [];
		const logs: string[] = [];
		const exits: number[] = [];
		let cleanupCalls = 0;

		const handle = createFatalHandler({
			writeStderr: text => {
				writes.push(text);
			},
			logError: message => {
				logs.push(message);
			},
			runCleanup: async () => {
				cleanupCalls++;
			},
			exit: code => {
				exits.push(code);
			},
			logMessage: "Uncaught exception",
		});

		const err = Object.assign(new Error("eio"), { code: "EIO" });
		await handle("Uncaught Exception", err);
		await handle("Uncaught Exception", err);
		await handle("Uncaught Exception", err);

		expect(logs).toEqual(["Uncaught exception"]);
		expect(writes).toHaveLength(1);
		expect(cleanupCalls).toBe(0); // broken stdio → skip cleanup, exit ASAP
		expect(exits.length).toBeGreaterThanOrEqual(2);
		expect(exits.every(c => c === 1)).toBe(true);
	});

	test("non-stdio fatals run cleanup once then exit", async () => {
		const logs: string[] = [];
		const exits: number[] = [];
		let cleanupCalls = 0;

		const handle = createFatalHandler({
			writeStderr: () => {},
			logError: message => {
				logs.push(message);
			},
			runCleanup: async () => {
				cleanupCalls++;
			},
			exit: code => {
				exits.push(code);
			},
			logMessage: "Unhandled rejection",
		});

		await handle("Unhandled Rejection", new Error("logic boom"));
		expect(logs).toEqual(["Unhandled rejection"]);
		expect(cleanupCalls).toBe(1);
		expect(exits).toEqual([1]);
	});

	test("logging failures during fatal handling do not throw out of the handler", async () => {
		const exits: number[] = [];
		const handle = createFatalHandler({
			writeStderr: () => {
				throw Object.assign(new Error("eio"), { code: "EIO" });
			},
			logError: () => {
				throw Object.assign(new Error("eio"), { code: "EIO" });
			},
			runCleanup: async () => {},
			exit: code => {
				exits.push(code);
			},
			logMessage: "Uncaught exception",
		});

		await expect(handle("Uncaught Exception", new Error("original"))).resolves.toBeUndefined();
		expect(exits).toEqual([1]);
	});
});
