import * as fs from "node:fs/promises";

import { YAML } from "bun";
import type { TaskBoard, TaskTopic, TopicStatus } from "./types";

// File content cache with TTL
interface CacheEntry<T> {
	data: T;
	timestamp: number;
}

const fileCache = new Map<string, CacheEntry<string>>();
const CACHE_TTL_MS = 2000; // 2 seconds cache

function getCachedFileContent(yamlPath: string): string | null {
	const entry = fileCache.get(yamlPath);
	if (!entry) return null;
	const age = Date.now() - entry.timestamp;
	if (age > CACHE_TTL_MS) {
		fileCache.delete(yamlPath);
		return null;
	}
	return entry.data;
}

function setCachedFileContent(yamlPath: string, content: string): void {
	fileCache.set(yamlPath, { data: content, timestamp: Date.now() });
}

export function generateTopicId(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.replace(/--+/g, "-");
}

export interface TaskBoardOptions {
	cacheEnabled?: boolean;
	cacheTtlMs?: number;
}

export function createTaskBoard(options?: TaskBoardOptions): TaskBoard {
	const cacheEnabled = options?.cacheEnabled ?? true;
	const cacheTtlMs = options?.cacheTtlMs ?? CACHE_TTL_MS;
	let topics: TaskTopic[] = [];
	let loadedPath: string | null = null;
	let loadedTimestamp = 0;

	const invalidateCache = (path?: string): void => {
		if (path) {
			fileCache.delete(path);
		} else if (loadedPath) {
			fileCache.delete(loadedPath);
		}
	};

	return {
		load(yamlContent: string, path?: string): void {
			const parsed = YAML.parse(yamlContent) as { topics?: unknown[] };
			topics = (parsed.topics ?? []).map((raw: unknown) => raw as TaskTopic);
			if (path) {
				loadedPath = path;
				loadedTimestamp = Date.now();
				if (cacheEnabled) {
					setCachedFileContent(path, yamlContent);
				}
			}
		},
		getTopics(): TaskTopic[] {
			return topics;
		},
		getTopic(id: string): TaskTopic | undefined {
			return topics.find(t => t.id === id);
		},
		getByStatus(status: TopicStatus): TaskTopic[] {
			return topics.filter(t => t.status === status);
		},
		getByModule(module: string): TaskTopic[] {
			return topics.filter(t => t.modules?.includes(module));
		},
		getByTag(tag: string): TaskTopic[] {
			return topics.filter(t => t.tags?.includes(tag));
		},
		addTopic(topic: TaskTopic): void {
			topics.push(topic);
			invalidateCache();
		},
		async save(yamlPath: string): Promise<void> {
			const data = { topics };
			const yamlContent = YAML.stringify(data);
			await fs.writeFile(yamlPath, yamlContent, "utf-8");
			// Invalidate cache after save
			invalidateCache(yamlPath);
		},
		async reload(yamlPath: string): Promise<void> {
			const cached = cacheEnabled ? getCachedFileContent(yamlPath) : null;
			let content: string;
			if (cached) {
				content = cached;
			} else {
				try {
					content = await Bun.file(yamlPath).text();
					if (cacheEnabled) {
						setCachedFileContent(yamlPath, content);
					}
				} catch {
					throw new Error(`File not found: ${yamlPath}`);
				}
			}
			this.load(content, yamlPath);
		},
	};
}
