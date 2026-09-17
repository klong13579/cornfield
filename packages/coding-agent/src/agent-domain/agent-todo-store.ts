/**
 * Agent Todo store — the authority for `AgentTodo` (WP10 / §37 D4).
 *
 * WP1 recorded AgentTodo as having no store yet ("§37 明确 Markdown 板 / 结构化存储尚未
 * 决策"), pending WP10. This is that decision, and this is that store.
 *
 * ## Why structured, not a Markdown board
 *
 * §9 offered `<agentDir>/TODO.md` as the Markdown shape. It is rejected here because the
 * domain record is structured and a board would be lossy: `status`, `priority`, `dueAt`
 * and `reminders` have no Markdown form, so a round trip through one would either invent
 * an ad-hoc syntax or silently drop fields the design declared. §37 left the choice open
 * ("Markdown 还是结构化存储另行决策"), so nothing is migrated or redefined here — the
 * Project board keeps its file and its skill.
 *
 * ## Where it lives
 *
 * `<agentDir>/.cornfield/agent-todos.json` — the Agent's home, next to
 * `<agentDir>/.cornfield/workspace.json`. Same principle the workspace declaration states
 * for itself (`skeleton/workspace.ts`): the file travels with the directory, so `cp -r`
 * an agentDir and the Agent's todos come with it. Store agent-owned data anywhere else
 * and AgentTodo becomes the one agent-owned concept whose record does not live in the
 * Agent's home.
 *
 * The path is deliberately **not** `<agentDir>/TODO.md`: that is the Project board owned
 * by the `project-todo` skill, and one file cannot be two boards (§9). The two paths
 * cannot be equal, so `validateTodoBoardPaths` has nothing to report — the separation is
 * structural, not a convention someone has to remember.
 *
 * ## Failure policy
 *
 * Same as `project-store`: a store that cannot be trusted is a hard error, never an empty
 * board. Degrading to "no todos" would tell a user their tasks vanished. Only ENOENT —
 * the file genuinely not existing yet — reads as an empty board.
 *
 * ## Version gate
 *
 * Readers normalize each record to the fields `AgentTodo` declares and **drop unknown
 * fields**. Adding a field is therefore a store change: bump
 * {@link AGENT_TODO_STORE_VERSION} in the same change, so an older build refuses to read
 * a shape it would silently rewrite. Do not add a field to version 1.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { isEnoent } from "@cornfield/utils";
import { WORKSPACE_DIR_NAME } from "../skeleton/workspace";
import { validateAgentTodoTransition } from "./relations";
import type {
	AgentTodo,
	AgentTodoId,
	AgentTodoPriority,
	AgentTodoReminder,
	AgentTodoSource,
	AgentTodoStatus,
} from "./types";

export const AGENT_TODO_STORE_VERSION = 1;
export const AGENT_TODO_STORE_FILE_NAME = "agent-todos.json";

const STATUSES: readonly AgentTodoStatus[] = ["open", "in_progress", "completed", "cancelled"];
const PRIORITIES: readonly AgentTodoPriority[] = ["low", "medium", "high"];
const SOURCES: readonly AgentTodoSource[] = ["agent", "user", "schedule", "session"];

export interface AgentTodoStoreFile {
	version: number;
	todos: Record<AgentTodoId, AgentTodo>;
}

/** Absolute path of one Agent's Todo board. */
export function agentTodosFilePath(agentDir: string): string {
	return path.join(agentDir, WORKSPACE_DIR_NAME, AGENT_TODO_STORE_FILE_NAME);
}

/**
 * Every Todo owned by the Agent whose home is `agentDir`, in stored order.
 *
 * Order is the store's own (insertion order, stable), not a display order: the first
 * component to sort a list decides what "the third one" means for everyone downstream.
 * A caller that wants a display order sorts it itself.
 */
export async function loadAgentTodos(agentDir: string): Promise<AgentTodo[]> {
	const file = agentTodosFilePath(agentDir);
	let parsed: unknown;
	try {
		parsed = await Bun.file(file).json();
	} catch (err) {
		if (isEnoent(err)) return [];
		if (err instanceof SyntaxError) {
			throw new Error(`Agent Todo store at "${file}" is not valid JSON: ${err.message}`);
		}
		throw err;
	}

	const store = parsed as Partial<AgentTodoStoreFile> | null;
	if (!store || typeof store !== "object" || typeof store.todos !== "object" || store.todos === null) {
		throw new Error(`Agent Todo store at "${file}" is malformed: expected { version, todos }.`);
	}
	if (store.version !== AGENT_TODO_STORE_VERSION) {
		throw new Error(
			`Agent Todo store at "${file}" has version ${String(store.version)}; this build reads version ${AGENT_TODO_STORE_VERSION}.`,
		);
	}

	return Object.entries(store.todos).map(([todoId, record]) => normalizeTodo(file, todoId, record));
}

/**
 * Insert or replace one Todo, keyed by `todo.id`.
 *
 * The caller supplies the id and it must not be empty. Upsert-by-id is what makes a
 * retried write safe: re-sending the same record after a dropped response updates the
 * record it already created instead of adding a duplicate task. A store that minted ids
 * would turn every retry into a second todo.
 *
 * Three fields belong to the store, and the caller's values for them are **rejected, not
 * ignored** — a silently dropped field is how a caller ends up believing it wrote
 * something it did not:
 *   - `createdAt` — stamped on create, preserved on update. A client clock must not be
 *     able to reorder a board other clients read.
 *   - `updatedAt` — stamped on every write.
 *   - `sessionRefs` — which sessions advanced a Todo is recorded by whatever advances it
 *     (§37: a Session advances a Todo, it never completes one). A caller may only send
 *     back what it read; a divergence is an error.
 *
 * Lifecycle is enforced against the **stored** previous status, not the caller's idea of
 * it (`validateAgentTodoTransition`).
 */
export async function upsertAgentTodo(agentDir: string, input: AgentTodo): Promise<AgentTodo> {
	const fields = requireWritableFields(input.id, input);
	const todos = await loadAgentTodos(agentDir);
	const previous = todos.find(todo => todo.id === input.id);
	const now = Date.now();

	if (!previous && fields.sessionRefs.length > 0) {
		throw new Error(
			`AgentTodo "${input.id}" cannot be created with sessionRefs: they record which sessions advanced it, ` +
				`not what the caller has on screen.`,
		);
	}
	if (previous) {
		const violation = validateAgentTodoTransition(input.id, previous.status, fields.status);
		if (violation) throw new Error(violation.message);
		if (!sameRefs(previous.sessionRefs, fields.sessionRefs)) {
			throw new Error(
				`AgentTodo "${input.id}" sessionRefs is not writable through this store: it records which sessions ` +
					`advanced the Todo, not what the caller currently has on screen.`,
			);
		}
	}

	const next: AgentTodo = {
		id: input.id,
		agentId: fields.agentId,
		title: fields.title,
		status: fields.status,
		priority: fields.priority,
		source: fields.source,
		createdAt: previous?.createdAt ?? now,
		updatedAt: now,
		sessionRefs: previous?.sessionRefs ?? [],
	};
	if (fields.projectId !== undefined) next.projectId = fields.projectId;
	if (fields.notes !== undefined) next.notes = fields.notes;
	if (fields.dueAt !== undefined) next.dueAt = fields.dueAt;
	if (fields.reminders !== undefined) next.reminders = fields.reminders;

	const merged = previous ? todos.map(todo => (todo.id === next.id ? next : todo)) : [...todos, next];
	await writeAgentTodos(agentDir, merged);
	return next;
}

/** Remove one Todo. Returns true when it existed. */
export async function removeAgentTodo(agentDir: string, todoId: AgentTodoId): Promise<boolean> {
	const todos = await loadAgentTodos(agentDir);
	const next = todos.filter(todo => todo.id !== todoId);
	if (next.length === todos.length) return false;
	await writeAgentTodos(agentDir, next);
	return true;
}

async function writeAgentTodos(agentDir: string, todos: readonly AgentTodo[]): Promise<void> {
	const file: AgentTodoStoreFile = {
		version: AGENT_TODO_STORE_VERSION,
		todos: Object.fromEntries(todos.map(todo => [todo.id, todo])),
	};
	const target = agentTodosFilePath(agentDir);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await Bun.write(target, `${JSON.stringify(file, null, 2)}\n`);
}

/** Reference equality by value — `sessionRefs` is a list, and a new array is not a new fact. */
function sameRefs(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((ref, i) => ref === b[i]);
}

/** The fields a caller may write. `createdAt` / `updatedAt` are absent on purpose. */
interface WritableFields {
	agentId: string;
	title: string;
	status: AgentTodoStatus;
	priority: AgentTodoPriority;
	source: AgentTodoSource;
	sessionRefs: string[];
	projectId?: string;
	notes?: string;
	dueAt?: number;
	reminders?: AgentTodoReminder[];
}

/**
 * Validate a caller-supplied record and project it onto the writable fields.
 *
 * The store is the last gate before disk, so this runs for every writer — the wire
 * bridge parses JSON into this shape and gets the same checks an in-process caller does
 * from the type system.
 */
function requireWritableFields(todoId: unknown, raw: AgentTodo | null | undefined): WritableFields {
	const where = `AgentTodo "${String(todoId)}"`;
	if (typeof todoId !== "string" || todoId.trim() === "") {
		throw new Error("AgentTodo.id is required (the caller supplies it; the store does not invent ids).");
	}
	if (!raw || typeof raw !== "object") throw new Error(`${where} is not an object.`);
	if (typeof raw.agentId !== "string" || raw.agentId.trim() === "") {
		throw new Error(`${where} has no owning agentId; an AgentTodo is owned by exactly one Agent.`);
	}
	if (typeof raw.title !== "string" || raw.title.trim() === "") throw new Error(`${where} has an empty title.`);

	const fields: WritableFields = {
		agentId: raw.agentId,
		title: raw.title,
		status: requireEnum(where, "status", raw.status, STATUSES),
		priority: requireEnum(where, "priority", raw.priority, PRIORITIES),
		source: requireEnum(where, "source", raw.source, SOURCES),
		sessionRefs: requireStringList(where, "sessionRefs", raw.sessionRefs),
	};
	if (raw.projectId !== undefined) {
		if (typeof raw.projectId !== "string") throw new Error(`${where} has a non-string projectId.`);
		fields.projectId = raw.projectId;
	}
	if (raw.notes !== undefined) {
		if (typeof raw.notes !== "string") throw new Error(`${where} has non-string notes.`);
		fields.notes = raw.notes;
	}
	if (raw.dueAt !== undefined) fields.dueAt = requireNumber(where, "dueAt", raw.dueAt);
	if (raw.reminders !== undefined) fields.reminders = requireReminders(where, raw.reminders);
	return fields;
}

/**
 * Validate one stored record and project it onto `AgentTodo`.
 *
 * Anything that disagrees with the declared shape throws: a record this build cannot
 * describe is not one it may show or rewrite. The key must equal `record.id` — otherwise
 * the map key and the record name two different Todos.
 */
function normalizeTodo(file: string, todoId: string, record: unknown): AgentTodo {
	const raw = record as Partial<AgentTodo> | null;
	const where = `Agent Todo store at "${file}", todo "${todoId}"`;
	if (!raw || typeof raw !== "object") throw new Error(`${where} is not an object.`);
	if (raw.id !== todoId) throw new Error(`${where} declares id "${String(raw.id)}".`);

	const todo: AgentTodo = {
		...requireWritableFields(todoId, raw as AgentTodo),
		id: todoId,
		createdAt: requireNumber(where, "createdAt", raw.createdAt),
		updatedAt: requireNumber(where, "updatedAt", raw.updatedAt),
	};
	return todo;
}

function requireEnum<T extends string>(where: string, field: string, value: unknown, allowed: readonly T[]): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		throw new Error(`${where} has ${field} "${String(value)}"; expected one of ${allowed.join(" | ")}.`);
	}
	return value as T;
}

function requireNumber(where: string, field: string, value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${where} has a non-numeric ${field}.`);
	}
	return value;
}

function requireStringList(where: string, field: string, value: unknown): string[] {
	if (!Array.isArray(value) || value.some(entry => typeof entry !== "string")) {
		throw new Error(`${where} has a ${field} that is not a list of strings.`);
	}
	return value.slice() as string[];
}

function requireReminders(where: string, value: unknown): AgentTodoReminder[] {
	if (!Array.isArray(value)) throw new Error(`${where} has reminders that are not a list.`);
	return value.map((entry, i) => {
		const raw = entry as Partial<AgentTodoReminder> | null;
		if (!raw || typeof raw !== "object" || typeof raw.at !== "number" || !Number.isFinite(raw.at)) {
			throw new Error(`${where} reminder #${i} has no numeric "at".`);
		}
		return { at: raw.at };
	});
}
