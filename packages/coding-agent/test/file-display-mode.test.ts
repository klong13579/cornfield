import { describe, expect, it } from "bun:test";
import { type FileDisplayModeSession, resolveFileDisplayMode } from "../src/utils/file-display-mode";

/** Session double: only the fields resolveFileDisplayMode reads. */
function makeSession(settings: Record<string, unknown>, hasEditTool = true): FileDisplayModeSession {
	return {
		hasEditTool,
		settings: { get: (key: string) => settings[key] },
	} as unknown as FileDisplayModeSession;
}

const hashline = { "edit.mode": "hashline" };

describe("resolveFileDisplayMode", () => {
	it("gives anchors and line numbers to an editable read in hashline mode", () => {
		expect(resolveFileDisplayMode(makeSession(hashline))).toEqual({ hashLines: true, lineNumbers: true });
	});

	it("drops anchors but keeps line numbers for an immutable resource", () => {
		expect(resolveFileDisplayMode(makeSession(hashline), { immutable: true })).toEqual({
			hashLines: false,
			lineNumbers: true,
		});
	});

	it("gives nothing for a raw read, immutable or not", () => {
		expect(resolveFileDisplayMode(makeSession(hashline), { raw: true, immutable: true })).toEqual({
			hashLines: false,
			lineNumbers: false,
		});
	});

	it("leaves a non-hashline session unchanged when the resource is immutable", () => {
		const session = makeSession({ "edit.mode": "replace" });
		expect(resolveFileDisplayMode(session, { immutable: true })).toEqual({ hashLines: false, lineNumbers: false });
		expect(
			resolveFileDisplayMode(makeSession({ "edit.mode": "replace", readLineNumbers: true }), {
				immutable: true,
			}),
		).toEqual({ hashLines: false, lineNumbers: true });
	});

	it("drops anchors when the session disables them or has no edit tool", () => {
		expect(resolveFileDisplayMode(makeSession({ ...hashline, readHashLines: false }))).toEqual({
			hashLines: false,
			lineNumbers: false,
		});
		expect(resolveFileDisplayMode(makeSession(hashline, false))).toEqual({ hashLines: false, lineNumbers: false });
	});
});
