/**
 * Memory persistence uses the same SQLite file as self-evolution (per-project or legacy global).
 */

import type { Database as DatabaseType } from "bun:sqlite";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveEvolutionPathLayout } from "../paths";
import { closeEvolutionDb, getEvolutionDb } from "../storage/db";
import { initMemoryTables } from "./schema";

export function getMemoryDb(cwd: string, globalStore = false): DatabaseType {
	return getEvolutionDb(cwd, globalStore);
}

export function releaseMemoryDb(cwd: string, globalStore = false): void {
	closeEvolutionDb(cwd, globalStore);
}

export function resolveMemoryDbPath(cwd: string, globalStore = false): string {
	return resolveEvolutionPathLayout(cwd, globalStore).dbPath;
}

/** Standalone DB open for tests (not ref-counted with evolution cache). */
export function openMemoryDb(dbPath: string): DatabaseType {
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode=WAL;");
	db.exec("PRAGMA synchronous=NORMAL;");
	db.exec("PRAGMA busy_timeout=5000;");
	initMemoryTables(db);
	return db;
}

export function closeMemoryDb(db: DatabaseType): void {
	db.close();
}
