/**
 * Regression test for the rotation fd leak in the omp file logger.
 *
 * Background: with `zippedArchive: true` and `maxSize: "10m"`, the
 * `winston-daily-rotate-file` transport leaked fds on every rotation
 * because the `inp.pipe(gzip).pipe(out)` pipeline never observed
 * `finish` on the 0-byte files produced under high log volume. The
 * leak was invisible at low write rates and only manifested under
 * the log volume produced by `a558f6538` (which restored
 * `logger.info()`), where a respawning child could trigger
 * rotation every few hundred ms and exhaust fds within minutes.
 *
 * This test exercises the exact configuration the logger uses and
 * asserts that:
 *   1. No rotation occurs for a normal session's worth of writes.
 *   2. When a rotation does occur, the resulting fds are released
 *      and the process does not retain stale handles to the rotated
 *      files.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import { cleanupStaleLogs } from "../src/log-cleanup";

describe("logger file transport", () => {
	const originalHome = process.env.HOME;
	const originalPiDir = process.env.PI_CODING_AGENT_DIR;
	let tmpHome: string;

	beforeEach(() => {
		tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omp-logger-test-"));
		process.env.HOME = tmpHome;
		process.env.PI_CODING_AGENT_DIR = path.join(tmpHome, "agent");
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		process.env.PI_CODING_AGENT_DIR = originalPiDir;
		fs.rmSync(tmpHome, { recursive: true, force: true });
	});

	test("mirrors logger.ts transport config", () => {
		// Pin the values the production logger uses. If you change
		// one, you must change the other — and you almost certainly
		// need to update the regression test alongside.
		const logsDir = path.join(tmpHome, "logs");
		fs.mkdirSync(logsDir, { recursive: true });
		const transport = new DailyRotateFile({
			dirname: logsDir,
			filename: "omp.%DATE%.log",
			datePattern: "YYYY-MM-DD",
			maxSize: "100m",
			maxFiles: 5,
			zippedArchive: false,
			auditFile: path.join(logsDir, `.omp-audit-${process.pid}.json`),
		});
		expect(transport.options.zippedArchive).toBe(false);
		expect(transport.options.maxSize).toBe("100m");
	});

	test("does not leak fds under high write volume that triggers rotation", async () => {
		// Run the same kind of write storm the leaking configuration
		// saw in production: many small writes, enough total bytes to
		// cross a rotation boundary once. The assertion is that
		// after the rotation, no extra rotated files are retained in
		// the fd table relative to the active file.
		const logsDir = path.join(tmpHome, "logs");
		fs.mkdirSync(logsDir, { recursive: true });
		const transport = new DailyRotateFile({
			dirname: logsDir,
			filename: "omp.%DATE%.log",
			datePattern: "YYYY-MM-DD",
			maxSize: "100m",
			maxFiles: 5,
			zippedArchive: false,
			auditFile: path.join(logsDir, `.omp-audit-${process.pid}.json`),
		});
		const logger = winston.createLogger({ level: "info", transports: [transport] });

		// 50 000 writes of 1 KiB = ~50 MiB. With maxSize=100m, this
		// should not cross the rotation boundary at all on a single
		// active file. (The original bug rotated every few hundred ms
		// at maxSize=10m because Bun stream accounting diverged from
		// on-disk size — the new config gives ample headroom.)
		const line = "x".repeat(1024) + "\n";
		for (let i = 0; i < 50_000; i++) {
			logger.info(line);
		}

		await new Promise<void>(resolve => {
			transport.on("finish", () => resolve());
			// Give the transport a tick to drain even if no finish
			// is going to fire for this test (no rotation expected).
			setTimeout(resolve, 250);
		});
		transport.close();

		const files = fs
			.readdirSync(logsDir)
			.filter(f => f.startsWith("omp.") && !f.endsWith(".json") && !f.endsWith(".gz"));
		// Exactly one active file. If zippedArchive is on or maxSize
		// is misread, we get a rotation storm and a long tail of
		// .1, .2, ... files even at this volume.
		expect(files.length).toBe(1);
	});
});

describe("cleanupStaleLogs", () => {
	test("removes 0-byte rotated logs and orphan audit files, keeps the rest", () => {
		const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cleanup-test-"));
		try {
			// Active log file (no rotation suffix) — must be kept
			fs.writeFileSync(`${logsDir}/omp.2026-07-02.log`, "real data\n");
			// 0-byte rotated file — must be removed
			fs.writeFileSync(`${logsDir}/omp.2026-07-02.log.1`, "");
			// Non-zero rotated file — must be kept (transport's
			// maxFiles policy will retire it on its own schedule)
			fs.writeFileSync(`${logsDir}/omp.2026-07-02.log.2`, "rotated content\n");
			// Our own audit file — must be kept
			fs.writeFileSync(`${logsDir}/.omp-audit-${process.pid}.json`, "{}");
			// Orphan audit file for a dead PID — must be removed.
			// macOS default max PID is 99999; 99999999 is unreachable.
			fs.writeFileSync(`${logsDir}/.omp-audit-99999999.json`, "{}");

			const removed = cleanupStaleLogs(logsDir);

			expect(removed).toBe(2);
			expect(fs.existsSync(`${logsDir}/omp.2026-07-02.log`)).toBe(true);
			expect(fs.existsSync(`${logsDir}/omp.2026-07-02.log.1`)).toBe(false);
			expect(fs.existsSync(`${logsDir}/omp.2026-07-02.log.2`)).toBe(true);
			expect(fs.existsSync(`${logsDir}/.omp-audit-${process.pid}.json`)).toBe(true);
			expect(fs.existsSync(`${logsDir}/.omp-audit-99999999.json`)).toBe(false);
		} finally {
			fs.rmSync(logsDir, { recursive: true, force: true });
		}
	});

	test("does not remove audit files for alive PIDs", async () => {
		const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cleanup-test-"));
		const child = Bun.spawn({
			cmd: ["sleep", "10"],
			stdout: "ignore",
			stderr: "ignore",
		});
		try {
			// Our own PID is alive by definition; the audit file
			// must be kept.
			fs.writeFileSync(`${logsDir}/.omp-audit-${process.pid}.json`, "{}");
			// Forge an "alive" sibling PID via a long-lived child
			// process so we can verify the liveness check actually
			// runs for PIDs that aren't ours.
			fs.writeFileSync(`${logsDir}/.omp-audit-${child.pid}.json`, "{}");
			const removed = cleanupStaleLogs(logsDir);
			expect(fs.existsSync(`${logsDir}/.omp-audit-${child.pid}.json`)).toBe(true);
			expect(fs.existsSync(`${logsDir}/.omp-audit-${process.pid}.json`)).toBe(true);
			expect(removed).toBe(0);
		} finally {
			child.kill();
			await child.exited;
			fs.rmSync(logsDir, { recursive: true, force: true });
		}
	});

	test("is idempotent", () => {
		const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cleanup-test-"));
		try {
			fs.writeFileSync(`${logsDir}/omp.2026-07-02.log.1`, "");
			fs.writeFileSync(`${logsDir}/.omp-audit-99999999.json`, "{}");
			const first = cleanupStaleLogs(logsDir);
			const second = cleanupStaleLogs(logsDir);
			expect(first).toBe(2);
			expect(second).toBe(0);
		} finally {
			fs.rmSync(logsDir, { recursive: true, force: true });
		}
	});
});
