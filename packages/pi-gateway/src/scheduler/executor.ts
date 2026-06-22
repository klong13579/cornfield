/**
 * Shared task executor for the scheduler.
 *
 * Supports both shell execution (sh -c) and agent execution (omp --print).
 * All executions are bounded by a configurable timeout.
 */
import { logger } from "@oh-my-pi/pi-utils";

export interface ExecutionResult {
	exitCode: number;
	output: string;
	stderr: string;
	timedOut: boolean;
}

const SCRIPT_TIMEOUT_MS = 120_000;
const SILENT_MARKER = "[SILENT]";
/** Default inactivity budget for cron agent tasks when task.timeoutMs is not set.
 * Matches Hermes's HERMES_CRON_TIMEOUT default of 600s. */
const DEFAULT_INACTIVITY_MS = 5 * 60 * 1000;
/** Hard cap for inactivity: a task can't ask for more than 30 min of idle. */
const MAX_INACTIVITY_MS = 30 * 60 * 1000;

/**
 * Compute the inactivity budget for a warm-bridge cron prompt.
 *
 * The warm bridge uses two timers: a wall-clock `timeoutMs` (the absolute
 * upper bound) and an `inactivityMs` (resets on every session event, so a
 * slow-but-active prompt can run for the full wall clock).
 *
 * Rules:
 *   - If `timeoutMs` is set, inactivity budget is `min(timeoutMs, DEFAULT)` so
 *     a tight wall-clock task also has a tight inactivity window.
 *   - If `timeoutMs` is unset, use the default 5 min (matches Hermes's
 *     HERMES_CRON_TIMEOUT default).
 *   - Never exceed MAX_INACTIVITY_MS (30 min).
 */
export function computeInactivityBudgetMs(timeoutMs: number | undefined): number {
	if (timeoutMs !== undefined && timeoutMs > 0) {
		return Math.min(timeoutMs, DEFAULT_INACTIVITY_MS, MAX_INACTIVITY_MS);
	}
	return Math.min(DEFAULT_INACTIVITY_MS, MAX_INACTIVITY_MS);
}

export interface ExecutionOptions {
	taskType?: "shell" | "agent";
	timeoutMs?: number;
	ompBinary?: string;
	skills?: string[];
	preScript?: string;
	/**
	 * Soft recursion guard prefix. For agent tasks, this string is
	 * prepended to the prompt before it's sent to `omp --print`. Used
	 * by the gateway's cron path to inject "[CRON-CONTEXT]" framing
	 * that tells the agent it's running as a scheduled task and to
	 * avoid spawning follow-on cron jobs or messaging. Mirrors
	 * Hermes's `disabled_toolsets=["cronjob","messaging"]` for OMP,
	 * where no equivalent toolset filter exists at the CLI level.
	 */
	promptPrefix?: string;
	/**
	 * Working directory for the spawned process. For `agent` tasks, this
	 * is the agentDir (where omp finds its `.omp/config.yml`). For
	 * `shell` tasks, it can be set to scope the command's view of the
	 * filesystem. When unset, the gateway's cwd is used.
	 */
	cwd?: string;
}

interface InjectionPattern {
	pattern: RegExp;
	id: string;
}

const CRON_INJECTION_PATTERNS: InjectionPattern[] = [
	{ pattern: /ignore\s+(?:\w+\s+)*(?:previous|all|above|prior)\s+(?:\w+\s+)*instructions/i, id: "prompt_injection" },
	{ pattern: /do\s+not\s+tell\s+the\s+user/i, id: "deception_hide" },
	{ pattern: /system\s+prompt\s+override/i, id: "sys_prompt_override" },
	{ pattern: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, id: "disregard_rules" },
	{ pattern: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass)/i, id: "read_secrets" },
	{ pattern: /rm\s+-rf\s+\//i, id: "destructive_root_rm" },
];

function scanCronPrompt(prompt: string): string | null {
	for (const entry of CRON_INJECTION_PATTERNS) {
		if (entry.pattern.test(prompt)) {
			return entry.id;
		}
	}
	return null;
}

/**
 * Run a scheduled task command.
 *
 * - shell: executes via `sh -c <command>`
 * - agent: executes via `omp --print <command>` (requires ompBinary).
 *   If the command contains injection patterns, execution is blocked.
 *
 * preScript: optional script run before the command; its stdout is
 * injected as prefix context. If it outputs [SILENT], execution is skipped.
 */
export async function executeScheduledCommand(
	command: string,
	options: ExecutionOptions = {},
): Promise<ExecutionResult> {
	const taskType = options.taskType ?? "shell";
	const timeoutMs = options.timeoutMs ?? (taskType === "agent" ? 120_000 : 30_000);

	// Injection scan for agent task prompts
	if (taskType === "agent") {
		const blocked = scanCronPrompt(command);
		if (blocked) {
			logger.warn("Agent task prompt blocked by injection scanner", {
				pattern: blocked,
				preview: command.slice(0, 100),
			});
			return {
				exitCode: 1,
				output: "",
				stderr: `[BLOCKED] Task prompt matches threat pattern '${blocked}'.`,
				timedOut: false,
			};
		}
	}

	// Run pre-script if configured
	const preScript = options.preScript;
	if (preScript) {
		const scriptResult = await runPreScript(preScript);
		if (scriptResult.silent) {
			return { exitCode: 0, output: "[SILENT]", stderr: "", timedOut: false };
		}
		if (scriptResult.output) {
			if (taskType === "shell") {
				const marker = `OMP_PRESCRIPT_${Math.random().toString(36).slice(2, 10)}`;
				command = `cat <<'${marker}'\nPre-script output:\n${scriptResult.output}\n\n${marker}\n\n${command}`;
			} else {
				command = `Pre-script output:\n${scriptResult.output}\n\n${command}`;
			}
		}
	}

	let proc: ReturnType<typeof Bun.spawn>;

	if (taskType === "agent") {
		const ompBinary = options.ompBinary ?? "omp";
		const args = [ompBinary, "--print"];
		if (options.skills?.length) {
			args.push("--skills", options.skills.join(","));
		}
		const finalCommand = options.promptPrefix ? `${options.promptPrefix}${command}` : command;
		args.push(finalCommand);
		proc = Bun.spawn(args, {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
			...(options.cwd ? { cwd: options.cwd } : {}),
		});
	} else {
		proc = Bun.spawn(["sh", "-c", command], {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
			...(options.cwd ? { cwd: options.cwd } : {}),
		});
	}

	let output = "";
	let stderr = "";
	let _timedOut = false;

	const execPromise = (async () => {
		try {
			const [outText, errText] = await Promise.all([
				new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
				new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
			]);
			output = outText;
			stderr = errText;
		} catch (error) {
			logger.error("Failed to capture process output", { error: String(error) });
			stderr = error instanceof Error ? error.message : String(error);
		}

		const exitCode = await proc.exited;
		return { exitCode, output, stderr, timedOut: _timedOut };
	})();

	const timeoutPromise = Bun.sleep(timeoutMs).then(async () => {
		_timedOut = true;
		try {
			proc.kill();
		} catch {
			// process may already be gone
		}
		return (
			(await Promise.race([execPromise, Bun.sleep(1000).then(() => null)])) ?? {
				exitCode: 124,
				output,
				stderr,
				timedOut: true,
			}
		);
	});

	return Promise.race([execPromise, timeoutPromise]);
}

interface ScriptResult {
	silent: boolean;
	output: string;
}

/**
 * Run a pre-script and capture its output.
 *
 * Path resolution:
 * - **Absolute path** (`/foo/bar.py`, `~/baz.py`): used as-is. Caller is
 *   responsible for ensuring the path is readable and trusted.
 * - **Relative path** (`mine.py`, `subdir/x.sh`): resolved against
 *   `~/.omp/gateway-data/scheduler/scripts/`. Must stay within that
 *   directory; paths that escape it are rejected.
 *
 * If the script does not exist or is not readable, the call returns an
 * empty result (no prefix injected) and a warning is logged. Execution
 * does not fail — the pre-script is treated as a context injector, not
 * a hard requirement.
 */
async function runPreScript(scriptPath: string): Promise<ScriptResult> {
	const fs = require("node:fs") as typeof import("node:fs");
	const path = require("node:path") as typeof import("node:path");
	const os = require("node:os") as typeof import("node:os");

	// Expand leading ~ to $HOME (Node doesn't do this for us)
	const expanded =
		scriptPath === "~"
			? os.homedir()
			: scriptPath.startsWith("~/")
				? path.join(os.homedir(), scriptPath.slice(2))
				: scriptPath;

	const scriptsDir = path.join(os.homedir(), ".omp", "gateway-data", "scheduler", "scripts");

	let resolved: string;
	if (path.isAbsolute(expanded)) {
		// Absolute paths bypass the scriptsDir sandbox.
		resolved = path.resolve(expanded);
	} else {
		// Relative paths must stay inside scriptsDir (defense-in-depth).
		resolved = path.resolve(scriptsDir, expanded);
		const ok = resolved === scriptsDir || resolved.startsWith(scriptsDir + path.sep);
		if (!ok) {
			logger.warn("Pre-script path escapes scripts directory, skipping", { scriptPath: resolved });
			return { silent: false, output: "" };
		}
	}

	if (!fs.existsSync(resolved)) {
		logger.warn("Pre-script not found, skipping", { scriptPath: resolved });
		return { silent: false, output: "" };
	}

	try {
		const proc = Bun.spawn([resolved], {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});

		const [outText, errText] = await Promise.all([
			new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
			new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
		]);

		const exitCode = await Promise.race([
			proc.exited,
			Bun.sleep(SCRIPT_TIMEOUT_MS).then(() => {
				proc.kill();
				return 124;
			}),
		]);

		if (exitCode !== 0) {
			logger.warn("Pre-script failed", { scriptPath: resolved, exitCode, stderr: errText });
			return { silent: false, output: "" };
		}

		const output = outText.trim();
		if (output === SILENT_MARKER) {
			return { silent: true, output: "" };
		}

		return { silent: false, output };
	} catch (error) {
		logger.warn("Pre-script execution error", { scriptPath: resolved, error: String(error) });
		return { silent: false, output: "" };
	}
}
