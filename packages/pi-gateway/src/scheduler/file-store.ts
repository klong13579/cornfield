/**
 * File-based task store — reads task definitions from JSON5 files.
 *
 * Tasks are stored as individual .json5 files in a directory,
 * making them human-readable, git-trackable, and editable outside the CLI.
 *
 * The file store is the "source of truth" for task definitions.
 * A sync process imports file tasks into the SQLite DB for runtime execution,
 * merging file-level config with DB-level runtime state (nextRunAt, runCount, etc.).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { SchedulerStorage, TaskFileDefinition } from "./types";
import { parseSchedule } from "./types";

const TASK_FILE_GLOB = /\.json5?$/i;

export class SchedulerFileStore {
	readonly #dir: string;
	readonly #storage: SchedulerStorage;

	constructor(dir: string, storage: SchedulerStorage) {
		this.#dir = dir;
		this.#storage = storage;
		this.#ensureDir();
	}

	get dir(): string {
		return this.#dir;
	}

	#ensureDir(): void {
		if (this.#dir) {
			fs.mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
		}
	}

	/**
	 * List all task file paths in the directory.
	 */
	listFiles(): string[] {
		if (!this.#dir) return [];
		try {
			return fs
				.readdirSync(this.#dir)
				.filter(f => TASK_FILE_GLOB.test(f))
				.map(f => path.join(this.#dir, f));
		} catch {
			return [];
		}
	}

	/**
	 * Read a single task definition from a file.
	 */
	readFile(filePath: string): TaskFileDefinition | null {
		try {
			const content = fs.readFileSync(filePath, "utf8");
			const data = Bun.JSON5.parse(content) as {
				name?: string;
				description?: string;
				cron?: string;
				command?: string;
				type?: string;
				model?: string;
				provider?: string;
				enabledToolsets?: string[];
				repeatCount?: number;
				timeoutMs?: number;
				retry?: import("./types").RetryConfig;
				skills?: string[];
				preScript?: string;
				agentDir?: string;
				delivery?: import("./types").TaskFileDefinition["delivery"];
				accountId?: string;
				deliver?: string;
				deliverUser?: string;
			};
			if (!data.name || !data.cron || !data.command) {
				logger.warn("Invalid task file, missing required fields", { path: filePath });
				return null;
			}
			return {
				name: data.name,
				description: data.description,
				cron: data.cron,
				command: data.command,
				type: (data.type as "shell" | "agent" | undefined) ?? "shell",
				model: data.model,
				provider: data.provider,
				enabledToolsets: data.enabledToolsets,
				repeatCount: data.repeatCount,
				timeoutMs: data.timeoutMs,
				retry: data.retry,
				skills: data.skills,
				preScript: data.preScript,
				agentDir: data.agentDir,
				delivery: data.delivery,
				accountId: data.accountId,
				deliver: data.deliver,
				deliverUser: data.deliverUser,
			};
		} catch (error) {
			logger.warn("Failed to read task file", { path: filePath, error: String(error) });
			return null;
		}
	}

	/**
	 * Load all task definitions from files, merging with DB runtime state.
	 * Returns definitions keyed by task name.
	 */
	loadAll(): Map<string, TaskFileDefinition> {
		const tasks = new Map<string, TaskFileDefinition>();
		for (const filePath of this.listFiles()) {
			const def = this.readFile(filePath);
			if (def) {
				tasks.set(def.name, def);
			}
		}
		return tasks;
	}

	/**
	 * Sync file-based task definitions into the storage DB.
	 *
	 * - New tasks (in files but not in DB): added as active
	 * - Updated tasks (changed cron/command): updated in DB, rescheduled
	 * - Removed tasks (in DB but not in files): deleted from DB
	 */
	syncToDb(): { added: number; updated: number; removed: number; errors: string[] } {
		const result = { added: 0, updated: 0, removed: 0, errors: [] as string[] };
		if (!this.#dir) return result;

		const fileTasks = this.loadAll();
		const dbTasks = this.#storage.listTasks();
		const dbByName = new Map(dbTasks.map(t => [t.name, t]));

		// Add or update from files
		for (const [name, def] of fileTasks) {
			const existing = dbByName.get(name);
			if (!existing) {
				try {
					this.#storage.addTask({
						name: def.name,
						description: def.description,
						cron: def.cron,
						command: def.command,
						taskType: def.type ?? "shell",
						model: def.model,
						provider: def.provider,
						enabledToolsets: def.enabledToolsets,
						repeatCount: def.repeatCount,
						repeatCompleted: 0,
						timeoutMs: def.timeoutMs ?? (def.type === "agent" ? 120_000 : 30_000),
						retry: def.retry,
						skills: def.skills,
						preScript: def.preScript,
						agentDir: def.agentDir,
						delivery: def.delivery,
						accountId: def.accountId,
						deliver: def.deliver,
						deliverUser: def.deliverUser,
						consecutiveFailures: 0,
						scheduleType: parseSchedule(def.cron).type,
						status: "active",
						createdAt: Date.now(),
						updatedAt: Date.now(),
						runCount: 0,
						failCount: 0,
					});
					result.added++;
				} catch (error) {
					result.errors.push(`Failed to add task "${name}": ${String(error)}`);
				}
			} else {
				const cronChanged = existing.cron !== def.cron;
				const commandChanged = existing.command !== def.command;
				const typeChanged = existing.taskType !== (def.type ?? "shell");
				const modelChanged = existing.model !== (def.model ?? undefined);
				const providerChanged = existing.provider !== (def.provider ?? undefined);
				const deliverChanged = existing.deliver !== (def.deliver ?? undefined);
				const deliverUserChanged = existing.deliverUser !== (def.deliverUser ?? undefined);
				const agentDirChanged = existing.agentDir !== (def.agentDir ?? undefined);
				const deliveryChanged = JSON.stringify(existing.delivery ?? null) !== JSON.stringify(def.delivery ?? null);
				const accountIdChanged = existing.accountId !== (def.accountId ?? undefined);
				if (
					cronChanged ||
					commandChanged ||
					typeChanged ||
					modelChanged ||
					providerChanged ||
					deliverChanged ||
					deliverUserChanged ||
					agentDirChanged ||
					deliveryChanged ||
					accountIdChanged
				) {
					try {
						this.#storage.updateTask(existing.id, {
							cron: def.cron,
							command: def.command,
							taskType: def.type ?? "shell",
							model: def.model,
							provider: def.provider,
							enabledToolsets: def.enabledToolsets,
							repeatCount: def.repeatCount,
							timeoutMs: def.timeoutMs,
							retry: def.retry,
							skills: def.skills,
							preScript: def.preScript,
							agentDir: def.agentDir,
							delivery: def.delivery,
							accountId: def.accountId,
							deliver: def.deliver,
							deliverUser: def.deliverUser,
						});
						result.updated++;
					} catch (error) {
						result.errors.push(`Failed to update task "${name}": ${String(error)}`);
					}
				}
			}
		}

		// Note: DB tasks without file backing are NOT auto-removed.

		// Tasks created via CLI are DB-only; only files → DB sync direction.

		if (result.added > 0 || result.removed > 0 || result.updated > 0) {
			logger.debug("File store synced to DB", result);
		}
		return result;
	}

	/**
	 * Write a task definition to a file.
	 */
	writeFile(name: string, def: TaskFileDefinition): string {
		this.#ensureDir();
		const filePath = path.join(this.#dir, `${name}.json5`);
		const content = `${JSON.stringify(def, null, 2)}\n`;
		fs.writeFileSync(filePath, content, "utf8");
		logger.debug("Task file written", { path: filePath });
		return filePath;
	}

	/**
	 * Delete a task file.
	 */
	deleteFile(name: string): boolean {
		const filePath = path.join(this.#dir, `${name}.json5`);
		try {
			fs.unlinkSync(filePath);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Check if a task name exists as a file.
	 */
	hasFile(name: string): boolean {
		if (!this.#dir) return false;
		try {
			return fs.existsSync(path.join(this.#dir, `${name}.json5`));
		} catch {
			return false;
		}
	}
}
