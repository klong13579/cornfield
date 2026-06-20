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
	/**
	 * Working directory for the spawned process. For `agent` tasks, this
	 * is the agentDir (where omp finds its `.omp/config.yml`). For
	 * `shell` tasks, it can be set to scope the command's view of the
	 * filesystem. When unset, the gateway's cwd is used.
	 */
	cwd?: string;
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
			return { exitCode: 0, output: "[SILENT]", stderr: "", timedOut: false };
		}
		if (scriptResult.output) {
			if (taskType === "shell") {
				// Use a here-doc with a per-run random marker so the pre-script
				// output is printed verbatim (no shell interpretation, no
				// variable expansion, safe for arbitrary content).
				const marker = `OMP_PRESCRIPT_${Math.random().toString(36).slice(2, 10)}`;
				command = `cat <<'${marker}'\nPre-script output:\n${scriptResult.output}\n\n${marker}\n\n${command}`;
			} else {
				// agent: pass the pre-script output as prompt prefix; OMP
				// `--print` treats the whole string as a user message.
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
		args.push(command);
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

	// Timeout: kill the process, then let execPromise finish with whatever output
	// was buffered before the kill (streams close, text() resolves with partial data).
	const timeoutPromise = Bun.sleep(timeoutMs).then(async () => {
		_timedOut = true;
		try {
			proc.kill();
		} catch {
			// process may already be gone
		}
		// Wait for the exec promise to settle so we get partial output.
		// If execPromise already resolved, this returns immediately.
		return (await Promise.race([execPromise, Bun.sleep(1000).then(() => null)])) ??
			{ exitCode: 124, output, stderr, timedOut: true };
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
