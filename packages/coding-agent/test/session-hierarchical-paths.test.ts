import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dateStamp, sessionFilePath, sessionRelativePath, timeStamp } from "../src/session/session-paths";

describe("session-paths", () => {
	describe("dateStamp / timeStamp", () => {
		it("formats YYYY-MM-DD", () => {
			const d = new Date("2026-06-19T15:55:58.000Z");
			expect(dateStamp(d)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});

		it("formats HHMMSS", () => {
			const d = new Date("2026-06-19T15:55:58.000Z");
			expect(timeStamp(d)).toMatch(/^\d{6}$/);
		});

		it("pads single-digit hours/minutes/seconds", () => {
			const d = new Date(2026, 0, 1, 1, 2, 3);
			expect(timeStamp(d)).toBe("010203");
		});
	});

	describe("sessionRelativePath", () => {
		const id = "019ee098-9baf-7000-96ff-2b209e5ea180";
		const d = new Date("2026-06-19T15:55:58.000Z");

		it("uses by-date/<date>/<filename> layout", () => {
			const rel = sessionRelativePath(id, d);
			expect(rel).toMatch(/^by-date\/\d{4}-\d{2}-\d{2}\/\d{6}__[0-9a-f]{8}\.jsonl$/);
		});

		it("omits slug when no title", () => {
			const rel = sessionRelativePath(id, d);
			expect(rel).not.toContain("--");
		});

		it("includes slug when title given", () => {
			const rel = sessionRelativePath(id, d, "hr-initial-q");
			expect(rel).toMatch(/-hr-initial-q__[0-9a-f]{8}\.jsonl$/);
		});

		it("uses last 8 chars of session id as tail", () => {
			const rel = sessionRelativePath(id, d);
			expect(rel).toContain("__9e5ea180");
		});
	});

	describe("sessionFilePath", () => {
		it("joins sessionDir + relative", () => {
			const full = sessionFilePath("/tmp/sessions", "019ee098-9baf-7000-96ff-2b209e5ea180");
			expect(full.startsWith("/tmp/sessions/by-date/")).toBe(true);
		});
	});
});

describe("hierarchical session layout (integration)", () => {
	let tempDir = "";
	const STORAGE_ROOT = "/sessions";

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-hier-test-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("places a new session file under by-date/<today>/", () => {
		const filePath = sessionFilePath(tempDir, "019ee098-9baf-7000-96ff-2b209e5ea180");
		const dateDir = path.dirname(filePath);
		fs.mkdirSync(dateDir, { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify({ type: "session", id: "x" }) + "\n");

		const today = new Date();
		const expectedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
		expect(filePath).toContain(`/by-date/${expectedDate}/`);
		expect(fs.existsSync(filePath)).toBe(true);
	});

	it("coexists with legacy flat files (read-back scenario)", () => {
		// Legacy: a flat file at the root, written by older code
		const legacyFile = path.join(tempDir, "2026-06-15T09-18-46-865Z_019eca93-1234-7000-96ff-aaaaaaaaaaaa.jsonl");
		fs.writeFileSync(legacyFile, JSON.stringify({ type: "session", id: "legacy" }) + "\n");

		// New: a session in by-date/YYYY-MM-DD/
		const newFile = sessionFilePath(tempDir, "019ee098-9baf-7000-96ff-2b209e5ea180");
		fs.mkdirSync(path.dirname(newFile), { recursive: true });
		fs.writeFileSync(newFile, JSON.stringify({ type: "session", id: "new" }) + "\n");

		// Both should be visible
		expect(fs.existsSync(legacyFile)).toBe(true);
		expect(fs.existsSync(newFile)).toBe(true);
	});
});
