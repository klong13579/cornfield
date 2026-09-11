import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@cornfield/coding-agent/config/settings";
import { getThemeByName } from "@cornfield/coding-agent/modes/theme/theme";
import type { ToolSession } from "@cornfield/coding-agent/tools";
import { ESSENTIAL_BUILTIN_TOOL_NAMES, resolveLoadMode } from "@cornfield/coding-agent/tools/essential-tools";
import {
	FindTool,
	type FindToolDetails,
	findToolRenderer,
	resolvePartialMatchPaths,
} from "@cornfield/coding-agent/tools/find";
import * as natives from "@cornfield/natives";

/**
 * Time budget for the timeout tests. Small keeps the suite fast; the fake walker
 * streams synchronously, so the budget only has to outlast a synchronous loop.
 */
const TEST_BUDGET_MS = 50;

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

interface StreamedMatch {
	path: string;
	mtime: number;
}

function toGlobMatch(entry: StreamedMatch): natives.GlobMatch {
	return { path: entry.path, fileType: natives.FileType.File, mtime: entry.mtime };
}

/**
 * Replace the native walker with a deterministic one that stalls mid-walk.
 *
 * `stream` is emitted synchronously, so every match is collected before the
 * tool's budget can fire; the call then hangs until that budget aborts the
 * signal. "What the search reached before the cut-off" therefore becomes a
 * controlled input instead of a race against real filesystem timing.
 */
function installStalledGlob(stream: readonly StreamedMatch[]) {
	return vi.spyOn(natives, "glob").mockImplementation(async (options, onMatch) => {
		for (const entry of stream) {
			onMatch?.(null, toGlobMatch(entry));
		}
		const signal = options.signal as AbortSignal | undefined;
		await new Promise<void>(resolve => {
			if (!signal) return; // nothing can end the walk; stay pending
			if (signal.aborted) return resolve();
			signal.addEventListener("abort", () => resolve(), { once: true });
		});
		return { matches: [], totalMatches: 0 };
	});
}

/** Replace the native walker with one that completes normally. */
function installCompletingGlob(stream: readonly StreamedMatch[]) {
	return vi.spyOn(natives, "glob").mockImplementation(async () => ({
		matches: stream.map(toGlobMatch),
		totalMatches: stream.length,
	}));
}

describe("resolvePartialMatchPaths", () => {
	it("keeps the first sighting of a duplicated display path", () => {
		const paths = resolvePartialMatchPaths([
			{ path: "a.ts", mtime: 1 },
			{ path: "a.ts", mtime: 99 },
		]);

		expect(paths).toEqual(["a.ts"]);
	});

	it("orders by mtime descending and breaks ties by path ascending", () => {
		const paths = resolvePartialMatchPaths([
			{ path: "z.ts", mtime: 7 },
			{ path: "b.ts", mtime: 7 },
			{ path: "old.ts", mtime: 1 },
			{ path: "a.ts", mtime: 7 },
		]);

		expect(paths).toEqual(["a.ts", "b.ts", "z.ts", "old.ts"]);
	});

	it("does not let input order decide the output for equal mtimes", () => {
		const forward = resolvePartialMatchPaths([
			{ path: "a.ts", mtime: 3 },
			{ path: "b.ts", mtime: 3 },
			{ path: "c.ts", mtime: 3 },
		]);
		const reversed = resolvePartialMatchPaths([
			{ path: "c.ts", mtime: 3 },
			{ path: "b.ts", mtime: 3 },
			{ path: "a.ts", mtime: 3 },
		]);

		expect(forward).toEqual(["a.ts", "b.ts", "c.ts"]);
		expect(reversed).toEqual(forward);
	});
});

describe("FindTool partial results on timeout", () => {
	let testDir: string;
	let session: ToolSession;
	let pattern: string;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "find-timeout-"));
		session = createSession(testDir);
		pattern = `${testDir}/**/*.ts`;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	it("returns the matches collected before the budget expired, marked incomplete", async () => {
		installStalledGlob([
			{ path: "src/a.ts", mtime: 1_000 },
			{ path: "src/b.ts", mtime: 3_000 },
			{ path: "src/c.ts", mtime: 2_000 },
		]);
		const tool = new FindTool(session, { globTimeoutMs: TEST_BUDGET_MS });

		const result = await tool.execute("call-timeout", { pattern });
		const text = getText(result);

		// The collected matches survive the cut, most recently modified first.
		expect(result.details?.files).toEqual(["src/b.ts", "src/c.ts", "src/a.ts"]);
		expect(result.details?.fileCount).toBe(3);
		// ...and are labelled partial rather than presented as the whole answer.
		expect(result.details?.incomplete).toEqual({ reason: "timeout", timeoutMs: TEST_BUDGET_MS });
		expect(text).toContain("[Incomplete:");
		expect(text).toContain(`find timed out after ${TEST_BUDGET_MS}ms`);
		expect(text).toContain("The scope was not fully searched");
		expect(text).toContain("src/b.ts");
		expect(text).not.toContain("No files found");
	});

	it("reports an empty timed-out search as incomplete instead of 'no files found'", async () => {
		installStalledGlob([]);
		const tool = new FindTool(session, { globTimeoutMs: TEST_BUDGET_MS });

		const result = await tool.execute("call-timeout-empty", { pattern });
		const text = getText(result);

		expect(result.details?.fileCount).toBe(0);
		expect(result.details?.files).toEqual([]);
		expect(result.details?.incomplete?.reason).toBe("timeout");
		// "No files found" would assert an absence the unfinished search never established.
		expect(text).not.toContain("No files found matching pattern");
		expect(text).toContain("no results were collected before the cut-off");
	});

	it("deduplicates by display path and orders equal mtimes deterministically", async () => {
		installStalledGlob([
			{ path: "src/z.ts", mtime: 5 },
			{ path: "src/a.ts", mtime: 5 },
			// Re-streamed with a newer mtime: the first sighting still wins.
			{ path: "src/z.ts", mtime: 9 },
			{ path: "src/m.ts", mtime: 5 },
		]);
		const tool = new FindTool(session, { globTimeoutMs: TEST_BUDGET_MS });

		const result = await tool.execute("call-timeout-dupes", { pattern });

		expect(result.details?.files).toEqual(["src/a.ts", "src/m.ts", "src/z.ts"]);
	});

	it("leaves a completed search unmarked", async () => {
		installCompletingGlob([
			{ path: "src/b.ts", mtime: 1 },
			{ path: "src/a.ts", mtime: 9 },
		]);
		const tool = new FindTool(session, { globTimeoutMs: TEST_BUDGET_MS });

		const result = await tool.execute("call-complete", { pattern });
		const text = getText(result);

		expect(result.details?.incomplete).toBeUndefined();
		expect(result.details?.truncated).toBe(false);
		expect(result.details?.files).toEqual(["src/a.ts", "src/b.ts"]);
		expect(text).not.toContain("[Incomplete:");
	});

	it("still aborts on caller cancellation instead of reporting a partial result", async () => {
		installStalledGlob([{ path: "src/a.ts", mtime: 1 }]);
		const tool = new FindTool(session, { globTimeoutMs: 60_000 });
		const controller = new AbortController();

		const pending = tool.execute("call-cancel", { pattern }, controller.signal);
		await Bun.sleep(10); // let the walk start, well inside the budget
		controller.abort();

		const outcome = await pending.then(
			() => ({ kind: "resolved" as const, name: "" }),
			(error: Error) => ({ kind: "rejected" as const, name: error.name }),
		);

		// A cancelled search must not masquerade as a partial success.
		expect(outcome.kind).toBe("rejected");
		expect(["AbortError", "ToolAbortError"]).toContain(outcome.name);
	});

	it("declares the essential load mode the centralized list expects, with a one-line summary", () => {
		const tool = new FindTool(session);

		expect(ESSENTIAL_BUILTIN_TOOL_NAMES).toContain(tool.name);
		expect(tool.loadMode).toBe("essential");
		expect(resolveLoadMode(tool.name, tool.loadMode)).toBe("essential");
		expect(tool.summary?.trim()).toBeTruthy();
		expect(tool.summary).not.toContain("\n");
	});
});

describe("findToolRenderer incomplete state", () => {
	const incomplete = { reason: "timeout" as const, timeoutMs: 5_000 };

	async function renderFind(details: FindToolDetails): Promise<string> {
		const uiTheme = (await getThemeByName("dark"))!;
		const component = findToolRenderer.renderResult(
			{ content: [{ type: "text", text: (details.files ?? []).join("\n") }], details } as never,
			{ expanded: false, isPartial: false },
			uiTheme,
			{ pattern: "**/*.ts" },
		);
		return natives.sanitizeText(component.render(200).join("\n"));
	}

	it("labels a partial list as incomplete", async () => {
		const rendered = await renderFind({
			scopePath: ".",
			fileCount: 2,
			files: ["a.ts", "b.ts"],
			truncated: false,
			incomplete,
		});

		expect(rendered).toContain("incomplete");
		expect(rendered).toContain("find timed out after 5s");
		expect(rendered).toContain("a.ts");
	});

	it("does not render an empty timed-out search as 'No files found'", async () => {
		const rendered = await renderFind({ scopePath: ".", fileCount: 0, files: [], truncated: false, incomplete });

		expect(rendered).toContain("incomplete");
		expect(rendered).not.toContain("No files found");
	});

	it("keeps the empty message for a completed search", async () => {
		const rendered = await renderFind({ scopePath: ".", fileCount: 0, files: [], truncated: false });

		expect(rendered).toContain("No files found");
	});
});
