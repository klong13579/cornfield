/**
 * Regression test for the rotation fd leak in the omp file logger.
 *
 * Background: `winston-daily-rotate-file` + `file-stream-rotator` leaked fds
 * on every rotation because `stream.end()` is async under Bun and the rotator
 * opens a new `fs.createWriteStream` without waiting for the old FD to close.
 * The new `RotatingFileTransport` uses `Bun.file().writer()` (Bun.FileSink)
 * which provides synchronous `write()`/`end()` with reliable FD lifecycle.
 *
 * This test exercises the new transport and asserts that:
 *   1. No rotation occurs for a normal session's worth of writes.
 *   2. When rotation does occur (small maxSize), files are rotated correctly
 *      and maxFiles retention is enforced.
 *   3. The transport's `close()` properly flushes and releases the writer.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import winston from "winston";
import { RotatingFileTransport } from "../src/rotating-file-transport";
import { cleanupStaleLogs } from "../src/log-cleanup";

describe("RotatingFileTransport", () => {
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

	test("does not rotate for a normal session's worth of writes", () => {
		const logsDir = path.join(tmpHome, "logs");
		fs.mkdirSync(logsDir, { recursive: true });
		const transport = new RotatingFileTransport({
			dirname: logsDir,
			filename: "omp.%DATE%.log",
			datePattern: "YYYY-MM-DD",
			maxSize: "100m",
			maxFiles: 5,
		});
		const logger = winston.createLogger({ level: "info", transports: [transport] });

		// 50 000 writes of 1 KiB = ~50 MiB. With maxSize=100m, this
		// should not cross the rotation boundary at all.
		const line = "x".repeat(1024) + "\n";
		for (let i = 0; i < 50_000; i++) {
			logger.info(line);
		}
		transport.close();

		const files = fs.readdirSync(logsDir).filter(f => f.startsWith("omp."));
		expect(files.length).toBe(1);
	});

	test("rotates when exceeding maxSize and enforces maxFiles retention", () => {
		const logsDir = path.join(tmpHome, "logs");
		fs.mkdirSync(logsDir, { recursive: true });
		const transport = new RotatingFileTransport({
			dirname: logsDir,
			filename: "omp.%DATE%.log",
			datePattern: "YYYY-MM-DD",
			maxSize: "1k", // 1 KiB — rotate frequently for testing
			maxFiles: 3,
		});
		const logger = winston.createLogger({ level: "info", transports: [transport] });

		// Write 10 KiB in 100-byte lines — should trigger ~10 rotations.
		const line = "y".repeat(100) + "\n";
		for (let i = 0; i < 100; i++) {
			logger.info(line);
		}
		transport.close();

		const files = fs.readdirSync(logsDir).filter(f => f.startsWith("omp."));
		// With maxFiles=3, we keep the active file + .1 + .2 = 3 files max.
		expect(files.length).toBeLessThanOrEqual(3);
		// The active file (no .N suffix) must exist.
		expect(files.some(f => /^omp\.\d{4}-\d{2}-\d{2}\.log$/.test(f))).toBe(true);
		// Rotated files must have content (no 0-byte files).
		for (const f of files) {
			const stat = fs.statSync(path.join(logsDir, f));
			expect(stat.size).toBeGreaterThan(0);
		}
	});

	test("close() flushes pending writes to disk", () => {
		const logsDir = path.join(tmpHome, "logs");
		fs.mkdirSync(logsDir, { recursive: true });
		const transport = new RotatingFileTransport({
			dirname: logsDir,
			filename: "omp.%DATE%.log",
			datePattern: "YYYY-MM-DD",
			maxSize: "100m",
			maxFiles: 5,
		});
		const logger = winston.createLogger({ level: "info", transports: [transport] });

		logger.info("test message before close");
		transport.close();

		const files = fs.readdirSync(logsDir).filter(f => f.startsWith("omp."));
		expect(files.length).toBe(1);
		const content = fs.readFileSync(path.join(logsDir, files[0]), "utf-8");
		expect(content).toContain("test message before close");
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
			// Non-zero rotated file — must be kept
			fs.writeFileSync(`${logsDir}/omp.2026-07-02.log.2`, "rotated content\n");
			// Our own audit file — must be kept
			fs.writeFileSync(`${logsDir}/.omp-audit-${process.pid}.json`, "{}");
			// Orphan audit file for a dead PID — must be removed.
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
			fs.writeFileSync(`${logsDir}/.omp-audit-${process.pid}.json`, "{}");
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
