/**
 * SQLite database initialization for self-evolution.
 *
 * Uses per-path reference counting to safely share DB connections across
 * sessions in the same process. Prevents one session's shutdown from
 * closing a DB still in use by another session.
 */
import { Database } from "bun:sqlite";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { initMemoryTables } from "../memory/schema";
import { resolveEvolutionPathLayout } from "../paths";
import { migrateAddAgentWrittenSource } from "./migrations/add-agent-written-source";
import { runStorageDedupMigrations } from "./migrations/storage-dedup";

interface DbEntry {
	db: Database;
	refCount: number;
}

const dbCache = new Map<string, DbEntry>();

function resolveDbPath(cwd: string, globalStore?: boolean): string {
	return resolveEvolutionPathLayout(cwd, globalStore).dbPath;
}

export function getEvolutionDb(cwd: string, globalStore?: boolean): Database {
	const dbPath = resolveDbPath(cwd, globalStore);

	const existing = dbCache.get(dbPath);
	if (existing) {
		existing.refCount++;
		return existing.db;
	}

	// Bun.write auto-creates parent dirs when writing files, but SQLite
	// open() needs the directory to exist. Use sync mkdir for init.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const fs = require("node:fs");
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });

	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA foreign_keys = ON;");
	db.exec("PRAGMA busy_timeout = 5000;");

	initSchema(db);
	logger.debug("Self-evolution DB initialized", { path: dbPath });
	dbCache.set(dbPath, { db, refCount: 1 });
	return db;
}

export function closeEvolutionDb(cwd?: string, globalStore?: boolean): void {
	const dbPath = resolveDbPath(cwd ?? "", globalStore);

	const entry = dbCache.get(dbPath);
	if (!entry) return;

	entry.refCount--;
	if (entry.refCount <= 0) {
		entry.db.close();
		dbCache.delete(dbPath);
		logger.debug("Self-evolution DB closed", { path: dbPath });
	}
}

/** V3: remove V2 convention tables (replaced by `learnings`). */
function dropV2ConventionTables(db: Database): void {
	const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conventions'").get() as
		| { name: string }
		| undefined;
	if (!row) return;
	db.exec("DROP TABLE IF EXISTS convention_feedback;");
	db.exec("DROP TABLE IF EXISTS conventions;");
}

export function initSchema(db: Database): void {
	initMemoryTables(db);

	// Create evolution_* namespace tables
	db.exec(`
		CREATE TABLE IF NOT EXISTS episodes (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			cwd TEXT NOT NULL,
			user_prompt TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			duration_ms INTEGER NOT NULL,
			tool_call_count INTEGER NOT NULL,
			error_count INTEGER NOT NULL,
			had_recovery INTEGER NOT NULL,
			completed_successfully INTEGER NOT NULL,
			summary TEXT NOT NULL,
			tools_used TEXT NOT NULL,
			files_modified TEXT NOT NULL
		);
	`);

	// FTS5 virtual table for full-text search over episodes
	db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
			user_prompt, summary, tools_used,
			content='episodes',
			content_rowid='rowid'
		);
	`);

	// Triggers to keep FTS5 in sync
	db.exec(`
		CREATE TRIGGER IF NOT EXISTS episodes_fts_insert AFTER INSERT ON episodes BEGIN
			INSERT INTO episodes_fts(rowid, user_prompt, summary, tools_used)
			VALUES (new.rowid, new.user_prompt, new.summary, new.tools_used);
		END;
	`);

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS episodes_fts_delete AFTER DELETE ON episodes BEGIN
			INSERT INTO episodes_fts(episodes_fts, rowid, user_prompt, summary, tools_used)
			VALUES ('delete', old.rowid, old.user_prompt, old.summary, old.tools_used);
		END;
	`);

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS episodes_fts_update AFTER UPDATE ON episodes BEGIN
			INSERT INTO episodes_fts(episodes_fts, rowid, user_prompt, summary, tools_used)
			VALUES ('delete', old.rowid, old.user_prompt, old.summary, old.tools_used);
			INSERT INTO episodes_fts(rowid, user_prompt, summary, tools_used)
			VALUES (new.rowid, new.user_prompt, new.summary, new.tools_used);
		END;
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS skills (
			name TEXT PRIMARY KEY,
			description TEXT NOT NULL,
			task_pattern TEXT NOT NULL,
			approach TEXT NOT NULL,
			tools TEXT NOT NULL,
			pitfalls TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			usage_count INTEGER NOT NULL,
			last_used_at INTEGER NOT NULL,
			success_count INTEGER NOT NULL,
			failure_count INTEGER NOT NULL,
			version INTEGER NOT NULL,
			quality_score INTEGER,
			optimized_prompt TEXT,
			deprecated INTEGER NOT NULL DEFAULT 0,
			deprecation_reason TEXT,
			intent TEXT,
			autonomy_notes TEXT,
			last_optimized_at INTEGER,
			user_rating INTEGER
		);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS skill_versions (
			name TEXT NOT NULL,
			version INTEGER NOT NULL,
			skill_json TEXT NOT NULL,
			changed_at INTEGER NOT NULL,
			change_type TEXT NOT NULL,
			change_reason TEXT,
			PRIMARY KEY (name, version)
		);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS stats (
			key TEXT PRIMARY KEY,
			value INTEGER NOT NULL
		);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS episode_intents (
			episode_id TEXT NOT NULL,
			intent TEXT NOT NULL,
			confidence REAL NOT NULL,
			source TEXT NOT NULL CHECK(source IN ('rule', 'llm')),
			PRIMARY KEY (episode_id, intent),
			FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
		);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS workflow_patterns (
			id TEXT PRIMARY KEY,
			intent TEXT NOT NULL,
			tool_sequence TEXT NOT NULL,
			command_sequence TEXT,
			occurrence_count INTEGER NOT NULL DEFAULT 1,
			avg_quality_score REAL,
			last_seen_at INTEGER NOT NULL
		);
	`);

	// Migration: add command_sequence column for existing databases
	try {
		db.exec("ALTER TABLE workflow_patterns ADD COLUMN command_sequence TEXT");
	} catch {
		// Column already exists — ignore
	}

	db.exec(`
		CREATE TABLE IF NOT EXISTS user_profiles (
			id TEXT PRIMARY KEY DEFAULT 'default',
			profile_json TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS episode_effectiveness (
			episode_id TEXT PRIMARY KEY,
			times_injected INTEGER NOT NULL DEFAULT 0,
			times_helped INTEGER NOT NULL DEFAULT 0,
			times_failed INTEGER NOT NULL DEFAULT 0,
			FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
		);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS skill_effectiveness (
			skill_name TEXT PRIMARY KEY,
			times_injected INTEGER NOT NULL DEFAULT 0,
			times_helped INTEGER NOT NULL DEFAULT 0,
			times_failed INTEGER NOT NULL DEFAULT 0,
			last_injected_at INTEGER NOT NULL DEFAULT 0
		);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS nudge_history (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			project TEXT NOT NULL DEFAULT '',
			type TEXT NOT NULL,
			severity TEXT NOT NULL,
			message TEXT NOT NULL,
			suggestion TEXT NOT NULL,
			detected_at INTEGER NOT NULL,
			dismissed_at INTEGER,
			acknowledged INTEGER NOT NULL DEFAULT 0
		);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS learnings (
			id TEXT PRIMARY KEY,
			cwd TEXT NOT NULL,
			kind TEXT NOT NULL CHECK(kind IN ('preference','fact','procedure','skill_hint')),
			content TEXT NOT NULL,
			source TEXT NOT NULL CHECK(source IN ('user_explicit','session_llm','manual_pin','agent_written')),
			confidence INTEGER NOT NULL CHECK(confidence BETWEEN 1 AND 5),
			lifecycle TEXT NOT NULL DEFAULT 'candidate' CHECK(lifecycle IN ('candidate','active','archived')),
			session_id TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			times_injected INTEGER NOT NULL DEFAULT 0,
			times_helped INTEGER NOT NULL DEFAULT 0,
			times_ignored INTEGER NOT NULL DEFAULT 0,
			scope TEXT NOT NULL DEFAULT 'project' CHECK(scope IN ('global','project','ephemeral'))
		);
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_learnings_cwd_lifecycle ON learnings(cwd, lifecycle);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS session_traces (
			session_id TEXT PRIMARY KEY,
			episode_id TEXT NOT NULL,
			cwd TEXT NOT NULL,
			trace_json TEXT NOT NULL,
			error_count INTEGER NOT NULL DEFAULT 0,
			completed_successfully INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL
		);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS regression_fixtures (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			episode_id TEXT NOT NULL,
			cwd TEXT NOT NULL,
			user_prompt TEXT NOT NULL,
			error_count INTEGER NOT NULL DEFAULT 0,
			completed_successfully INTEGER NOT NULL DEFAULT 0,
			dominant_error_tool TEXT,
			dominant_error_pattern TEXT,
			created_at INTEGER NOT NULL
		);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS regression_trials (
			id TEXT PRIMARY KEY,
			target_type TEXT NOT NULL CHECK(target_type IN ('convention', 'skill')),
			target_id TEXT NOT NULL,
			fixture_id TEXT NOT NULL,
			verdict TEXT NOT NULL CHECK(verdict IN ('keep', 'discard', 'pending')),
			reason TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			FOREIGN KEY (fixture_id) REFERENCES regression_fixtures(id) ON DELETE CASCADE
		);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS evolution_escalations (
			id TEXT PRIMARY KEY,
			pattern_key TEXT NOT NULL,
			pattern_label TEXT NOT NULL,
			dominant_error_tool TEXT,
			dominant_error_pattern TEXT,
			occurrence_count INTEGER NOT NULL DEFAULT 0,
			failed_improvement_count INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'acknowledged', 'resolved')),
			message TEXT NOT NULL,
			suggestion TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			acknowledged_at INTEGER,
			resolved_at INTEGER
		);
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_evolution_escalations_pattern_key
		ON evolution_escalations(pattern_key);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS episode_detailed_outcomes (
			episode_id TEXT PRIMARY KEY,
			helpfulness REAL NOT NULL DEFAULT 0,
			has_explicit_correction INTEGER NOT NULL DEFAULT 0,
			has_explicit_approval INTEGER NOT NULL DEFAULT 0,
			was_redundant INTEGER NOT NULL DEFAULT 0,
			avoided_previous_errors INTEGER NOT NULL DEFAULT 0,
			tool_efficiency REAL NOT NULL DEFAULT 0,
			recorded_at INTEGER NOT NULL DEFAULT 0,
			FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
		);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS episode_diagnoses (
			episode_id TEXT PRIMARY KEY,
			read_failures_json TEXT NOT NULL,
			cascade_patterns_json TEXT NOT NULL,
			redundant_searches INTEGER NOT NULL DEFAULT 0,
			slow_loop INTEGER NOT NULL DEFAULT 0,
			tool_efficiency REAL NOT NULL DEFAULT 1.0,
			dominant_error_tool TEXT,
			dominant_error_pattern TEXT,
			suggested_action TEXT NOT NULL DEFAULT '',
			recorded_at INTEGER NOT NULL DEFAULT 0,
			FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
		);
	`);

	// Create episodic_* namespace tables
	db.exec(`
		CREATE TABLE IF NOT EXISTS episodic_records (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			cwd TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			event_type TEXT NOT NULL,
			event_data TEXT NOT NULL,
			importance_score REAL NOT NULL DEFAULT 0,
			ttl_seconds INTEGER,
			expiration_time INTEGER,
			archived INTEGER NOT NULL DEFAULT 0,
			review_status TEXT NOT NULL DEFAULT 'active',
			reviewed_at INTEGER
		);
	`);

	// Add review_status column to existing tables (migration)
	try {
		db.exec("ALTER TABLE episodic_records ADD COLUMN review_status TEXT NOT NULL DEFAULT 'active'");
	} catch {
		/* column already exists */
	}
	try {
		db.exec("ALTER TABLE episodic_records ADD COLUMN reviewed_at INTEGER");
	} catch {
		/* column already exists */
	}

	// Add scope column to learnings (migration)
	try {
		db.exec(
			"ALTER TABLE learnings ADD COLUMN scope TEXT NOT NULL DEFAULT 'project' CHECK(scope IN ('global','project','ephemeral'))",
		);
	} catch {
		/* column already exists */
	}

	// Create vec_* namespace tables (using SQLite-vec for vector storage)
	db.exec(`
		CREATE TABLE IF NOT EXISTS vec_embeddings (
			id TEXT PRIMARY KEY,
			namespace TEXT NOT NULL,
			content TEXT NOT NULL,
			embedding BLOB NOT NULL, -- Vector as blob
			metadata_json TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
	`);

	// Create skill_population table with lifecycle state fields
	db.exec(`
		CREATE TABLE IF NOT EXISTS skill_population (
			name TEXT PRIMARY KEY,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			usage_count INTEGER NOT NULL DEFAULT 0,
			success_rate REAL NOT NULL DEFAULT 0,
			state TEXT NOT NULL DEFAULT 'candidate' CHECK(state IN ('candidate', 'experimental', 'graduated', 'deprecated', 'archived')),
			evolution_score INTEGER NOT NULL DEFAULT 0,
			last_evaluated_at INTEGER,
			next_evaluation_at INTEGER,
			quality_metrics_json TEXT,
			evolution_history_json TEXT
		);
	`);

	// Phase 5: Session model stats
	db.exec(`
		CREATE TABLE IF NOT EXISTS session_model_stats (
			session_id TEXT NOT NULL,
			model_name TEXT NOT NULL,
			prompt_tokens INTEGER NOT NULL DEFAULT 0,
			completion_tokens INTEGER NOT NULL DEFAULT 0,
			duration_ms INTEGER NOT NULL DEFAULT 0,
			success_count INTEGER NOT NULL DEFAULT 0,
			error_count INTEGER NOT NULL DEFAULT 0,
			timestamp INTEGER NOT NULL,
			task_type TEXT,
			PRIMARY KEY (session_id, model_name)
		);
	`);

	// Migrations for existing tables
	// Add intent column to skills table if missing
	const skillsColumns = db.prepare("PRAGMA table_info(skills)").all() as Array<{ name: string }>;
	const hasIntentCol = skillsColumns.some(c => c.name === "intent");
	if (!hasIntentCol) {
		db.exec(`ALTER TABLE skills ADD COLUMN intent TEXT;`);
	}

	const hasAutonomyNotesCol = skillsColumns.some(c => c.name === "autonomy_notes");
	if (!hasAutonomyNotesCol) {
		db.exec(`ALTER TABLE skills ADD COLUMN autonomy_notes TEXT;`);
	}

	const hasLastOptimizedAtCol = skillsColumns.some(c => c.name === "last_optimized_at");
	if (!hasLastOptimizedAtCol) {
		db.exec(`ALTER TABLE skills ADD COLUMN last_optimized_at INTEGER;`);
	}

	const hasUserRatingCol = skillsColumns.some(c => c.name === "user_rating");
	if (!hasUserRatingCol) {
		db.exec(`ALTER TABLE skills ADD COLUMN user_rating INTEGER;`);
	}

	// Migrate nudge_history table: add dismissed_at and acknowledged if missing
	const nudgeColumns = db.prepare("PRAGMA table_info(nudge_history)").all() as Array<{ name: string }>;
	const hasDismissedAtCol = nudgeColumns.some(c => c.name === "dismissed_at");
	if (!hasDismissedAtCol) {
		db.exec(`ALTER TABLE nudge_history ADD COLUMN dismissed_at INTEGER;`);
	}

	const hasAcknowledgedCol = nudgeColumns.some(c => c.name === "acknowledged");
	if (!hasAcknowledgedCol) {
		db.exec(`ALTER TABLE nudge_history ADD COLUMN acknowledged INTEGER NOT NULL DEFAULT 0;`);
	}
	const nudgeColNames = new Set(
		(db.prepare("PRAGMA table_info(nudge_history)").all() as Array<{ name: string }>).map(c => c.name),
	);
	if (!nudgeColNames.has("context_injected")) {
		db.exec(`ALTER TABLE nudge_history ADD COLUMN context_injected INTEGER NOT NULL DEFAULT 0;`);
	}
	if (!nudgeColNames.has("injected_at")) {
		db.exec(`ALTER TABLE nudge_history ADD COLUMN injected_at INTEGER;`);
	}
	if (!nudgeColNames.has("post_tool_calls")) {
		db.exec(`ALTER TABLE nudge_history ADD COLUMN post_tool_calls INTEGER NOT NULL DEFAULT 0;`);
	}
	if (!nudgeColNames.has("pattern_repeated")) {
		db.exec(`ALTER TABLE nudge_history ADD COLUMN pattern_repeated INTEGER NOT NULL DEFAULT 0;`);
	}
	if (!nudgeColNames.has("outcome_score")) {
		db.exec(`ALTER TABLE nudge_history ADD COLUMN outcome_score REAL;`);
	}
	if (!nudgeColNames.has("outcome_recorded_at")) {
		db.exec(`ALTER TABLE nudge_history ADD COLUMN outcome_recorded_at INTEGER;`);
	}
	dropV2ConventionTables(db);

	db.exec(`
		CREATE TABLE IF NOT EXISTS fit_scores (
			date TEXT PRIMARY KEY,
			total_score INTEGER NOT NULL,
			memory_score INTEGER NOT NULL,
			thinking_score INTEGER NOT NULL,
			style_score INTEGER NOT NULL,
			prediction_score INTEGER NOT NULL,
			history_score INTEGER NOT NULL,
			change_from_last INTEGER,
			verdict TEXT NOT NULL,
			detail_json TEXT NOT NULL,
			computed_at INTEGER NOT NULL
		);
	`);

	runStorageDedupMigrations(db);
	migrateAddAgentWrittenSource(db);
}
