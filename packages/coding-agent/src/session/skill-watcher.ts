/**
 * Skill directory watcher for hot-reload.
 *
 * Monitors skill directories for file changes and triggers a reload callback
 * when SKILL.md files are created, modified, or deleted.
 *
 * Uses Node.js built-in `fs.watch` with `recursive: true` (macOS/Windows).
 * Includes debouncing to coalesce rapid file system events.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

export interface SkillWatcherOptions {
	/** Absolute paths of directories to watch recursively */
	directories: string[];
	/** Called when skill file changes are detected (debounced) */
	onReload: () => void;
	/** Debounce interval in milliseconds (default: 500) */
	debounceMs?: number;
}

/**
 * Watch skill directories for changes and trigger reloads.
 *
 * Only watches directories that exist at construction time.
 * Non-existent directories are silently skipped.
 */
export class SkillWatcher {
	#watchers: fs.FSWatcher[] = [];
	#timer: ReturnType<typeof setTimeout> | undefined;
	#callback: () => void;
	#debounceMs: number;
	#closed = false;

	constructor(options: SkillWatcherOptions) {
		this.#callback = options.onReload;
		this.#debounceMs = options.debounceMs ?? 500;

		for (const dir of options.directories) {
			this.#watchDirectory(dir);
		}

		if (this.#watchers.length > 0) {
			logger.debug("SkillWatcher started", {
				directories: options.directories,
				watchedCount: this.#watchers.length,
			});
		}
	}

	/** Stop all file watchers and clear pending timers. */
	close(): void {
		this.#closed = true;
		for (const watcher of this.#watchers) {
			watcher.close();
		}
		this.#watchers = [];
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	}

	#watchDirectory(dir: string): void {
		try {
			fs.accessSync(dir);
		} catch {
			return;
		}

		try {
			const watcher = fs.watch(dir, { recursive: true }, (_eventType, filename) => {
				if (this.#closed) return;
				if (!filename) return;
				// Only react to SKILL.md changes — ignore other files in skill directories
				if (!filename.endsWith("SKILL.md")) return;
				// Ignore dotfiles (editor temp files, etc.)
				const base = path.basename(filename);
				if (base.startsWith(".")) return;
				this.#scheduleReload(dir);
			});

			watcher.on("error", error => {
				logger.warn("Skill watcher error", { dir, error: String(error) });
			});

			this.#watchers.push(watcher);
		} catch (error) {
			logger.warn("Failed to watch skill directory", { dir, error: String(error) });
		}
	}

	#scheduleReload(dir: string): void {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			logger.info("Skill file change detected, triggering reload", { dir });
			try {
				this.#callback();
			} catch (error) {
				logger.warn("Skill reload callback failed", { error: String(error) });
			}
		}, this.#debounceMs);
	}
}
