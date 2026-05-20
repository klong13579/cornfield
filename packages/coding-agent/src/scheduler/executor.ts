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

export interface ExecutionOptions {
	taskType?: "shell" | "agent";
	timeoutMs?: number;
	ompBinary?: string;
	skills?: string[];
	preScript?: string;
}

/**
 * Run a scheduled task command, optionally preceded by a pre-script.
 *
 * - shell: executes via `sh -c <command>`
 * - agent: executes via `omp --print <command>` (requires ompBinary)
 * - preScript: optional Python script run before the command; its stdout is
 *   injected as prefix context. If it outputs [SILENT], execution is skipped.
 *
 * Returns the full stdout, stderr, exit code, and whether a timeout occurred.
 */
export async function executeScheduledCommand(
	command: string,
	options: ExecutionOptions = {},
): Promise<ExecutionResult> {
	const taskType = options.taskType ?? "shell";
	const timeoutMs = options.timeoutMs ?? (taskType === "agent" ? 120_000 : 30_000);

	// Run pre-script if configured
	const preScript = options.preScript;
	if (preScript) {
		const scriptResult = await runPreScript(preScript);
		if (scriptResult.silent) {
			// [SILENT] — script detected no meaningful change, skip execution
			return { exitCode: 0, output: "[SILENT]", stderr: "", timedOut: false };
		}
		if (scriptResult.output) {
			command = `Pre-script output:\n${scriptResult.output}\n\n${command}`;
		}
	}

	let proc: ReturnType<typeof Bun.spawn>;

	if (taskType === "agent") {
		const ompBinary = options.ompBinary ?? "omp";
		const args = [ompBinary, "--print"];
		if (options.skills?.length) {
			args.push("--skills", options.skills.join(","));
		}
		args.push(command);
		proc = Bun.spawn(args, {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
	} else {
		proc = Bun.spawn(["sh", "-c", command], {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
	}

	let output = "";
	let stderr = "";
	let _timedOut = false;

	const timeoutPromise = Bun.sleep(timeoutMs).then(() => {
		_timedOut = true;
		try {
			proc.kill();
		} catch {
			// process may already be gone
		}
		return { exitCode: 124, output, stderr, timedOut: true };
	});

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
		return { exitCode, output, stderr, timedOut: false };
	})();

	return Promise.race([execPromise, timeoutPromise]);
}

interface ScriptResult {
	silent: boolean;
	output: string;
}

/**
 * Run a pre-script and capture its output.
 *
 * Scripts must reside within ~/.omp/scheduler/scripts/.
 * Relative paths are resolved there; absolute paths are rejected.
 */
async function runPreScript(scriptPath: string): Promise<ScriptResult> {
	const path = require("node:path");
	const scriptsDir = path.join(require("node:os").homedir(), ".omp", "scheduler", "scripts");

	// Resolve and validate path: must stay within scriptsDir
	const resolved = path.resolve(scriptsDir, scriptPath);
	if (!resolved.startsWith(scriptsDir + path.sep) && resolved !== scriptsDir) {
		logger.warn("Pre-script path resolves outside scripts directory, skipping", { scriptPath: resolved });
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
			logger.warn("Pre-script failed", { scriptPath, exitCode, stderr: errText });
			return { silent: false, output: "" };
		}

		const output = outText.trim();
		if (output === SILENT_MARKER) {
			return { silent: true, output: "" };
		}

		return { silent: false, output };
	} catch (error) {
		logger.warn("Pre-script execution error", { scriptPath, error: String(error) });
		return { silent: false, output: "" };
	}
}
