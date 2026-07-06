/**
 * Parser and file loader for the project-level `TODO.md` (the agent's
 * always-on task board). Pure functions only — the TUI rendering lives in
 * the welcome component's right column.
 */
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir, isEnoent, logger } from "@oh-my-pi/pi-utils";

/** Title text preferred when the file has multiple H2 sections. */
const PREFERRED_SECTION_TITLE = "待办";
/** How far up the tree we look for a project TODO.md before giving up. */
const MAX_TODO_WALK_DEPTH = 8;

export interface ParsedTodo {
	/** Section title (the H2 text, e.g. "待办" or "Tasks"). */
	sectionTitle: string;
	/** Unchecked items, in source order, with original whitespace trimmed. */
	open: string[];
	/** Completed `[x]` items in the same section, used for the summary footer. */
	doneCount: number;
}

/**
 * Parse a TODO.md body and return the first task section, preferring a
 * `## 待办` heading over any other H2. Returns `null` when the file has no
 * `## ` heading or the chosen section is empty.
 */
export function parseTodoMarkdown(markdown: string): ParsedTodo | null {
	if (!markdown) return null;
	const lines = markdown.split(/\r?\n/);

	const h2Indices: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (/^##\s+/.test(lines[i] ?? "")) h2Indices.push(i);
	}
	if (h2Indices.length === 0) return null;

	let startIdx = h2Indices.findIndex(i => /^##\s+待办\s*$/.test(lines[i] ?? ""));
	if (startIdx === -1) startIdx = 0;
	const start = h2Indices[startIdx] as number;
	const end = h2Indices[startIdx + 1] ?? lines.length;

	const sectionTitle = (lines[start] ?? "").replace(/^##\s+/, "").trim() || PREFERRED_SECTION_TITLE;
	const open: string[] = [];
	let doneCount = 0;
	for (let j = start + 1; j < end; j++) {
		const line = lines[j] ?? "";
		const m = /^\s*-\s+\[( |x|X)\]\s+(.+?)\s*$/.exec(line);
		if (!m) continue;
		if (m[1] === " ") open.push(m[2].trim());
		else doneCount++;
	}
	if (open.length === 0 && doneCount === 0) return null;
	return { sectionTitle, open, doneCount };
}

/**
 * Read a TODO.md from disk and parse it. Returns `null` when the file does
 * not exist or the body is empty. Other I/O errors are logged and surface
 * as `null` so the TUI never crashes on a broken TODO file.
 */
export async function loadTodoFile(absolutePath: string): Promise<ParsedTodo | null> {
	let text: string;
	try {
		text = await Bun.file(absolutePath).text();
	} catch (err) {
		if (!isEnoent(err)) {
			logger.warn("TODO.md unreadable; hiding TODO section", { absolutePath, error: String(err) });
		}
		return null;
	}
	const trimmed = text.replace(/^\uFEFF/, "").trim();
	if (!trimmed) return null;
	return parseTodoMarkdown(trimmed);
}

/**
 * Walk up from `getProjectDir()` looking for a `TODO.md`, stopping at the
 * user's home directory or the filesystem root. Returns the first match so
 * a project-level TODO takes precedence over a user's global one. Stops at
 * `MAX_TODO_WALK_DEPTH` to bound the search in pathological directory trees.
 */
export async function loadProjectTodo(): Promise<ParsedTodo | null> {
	let dir = getProjectDir();
	const home = os.homedir();
	for (let i = 0; i < MAX_TODO_WALK_DEPTH; i++) {
		const result = await loadTodoFile(path.join(dir, "TODO.md"));
		if (result) return result;
		if (dir === home) return null;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}
