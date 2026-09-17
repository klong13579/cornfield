/**
 * Python runtime resolution utilities.
 *
 * Centralizes environment filtering, venv detection, and Python executable resolution
 * for both the shared gateway and local kernel spawning.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { $env, $which, getPythonEnvDir } from "@cornfield/utils";
import { $ } from "bun";

/**
 * A kernel host must provide the gateway that serves the kernel *and* the kernel
 * implementation itself. Probing for anything weaker — "python runs" — accepts
 * an interpreter that fails at kernel start instead of at preflight.
 */
const KERNEL_DEPENDENCY_PROBE =
	"import importlib.util,sys;sys.exit(0 if importlib.util.find_spec('kernel_gateway') and importlib.util.find_spec('ipykernel') else 1)";

const DEFAULT_ENV_ALLOWLIST = new Set([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LC_MESSAGES",
	"TERM",
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"TMPDIR",
	"TEMP",
	"TMP",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_RUNTIME_DIR",
	"SSH_AUTH_SOCK",
	"SSH_AGENT_PID",
	"CONDA_PREFIX",
	"CONDA_DEFAULT_ENV",
	"VIRTUAL_ENV",
	"PYTHONPATH",
]);

const WINDOWS_ENV_ALLOWLIST = new Set([
	"APPDATA",
	"COMPUTERNAME",
	"COMSPEC",
	"HOMEDRIVE",
	"HOMEPATH",
	"LOCALAPPDATA",
	"NUMBER_OF_PROCESSORS",
	"OS",
	"PATH",
	"PATHEXT",
	"PROCESSOR_ARCHITECTURE",
	"PROCESSOR_IDENTIFIER",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PROGRAMW6432",
	"SESSIONNAME",
	"SYSTEMDRIVE",
	"SYSTEMROOT",
	"TEMP",
	"TMP",
	"USERDOMAIN",
	"USERDOMAIN_ROAMINGPROFILE",
	"USERPROFILE",
	"USERNAME",
	"WINDIR",
]);

const DEFAULT_ENV_DENYLIST = new Set([
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"GOOGLE_API_KEY",
	"GEMINI_API_KEY",
	"OPENROUTER_API_KEY",
	"PERPLEXITY_API_KEY",
	"PERPLEXITY_COOKIES",
	"EXA_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"MISTRAL_API_KEY",
]);

const DEFAULT_ENV_ALLOW_PREFIXES = ["LC_", "XDG_", "PI_"];

const CASE_INSENSITIVE_ENV = process.platform === "win32";
const BASE_ENV_ALLOWLIST = new Set([...DEFAULT_ENV_ALLOWLIST, ...WINDOWS_ENV_ALLOWLIST]);

const NORMALIZED_ALLOWLIST = new Set(
	Array.from(BASE_ENV_ALLOWLIST, key => (CASE_INSENSITIVE_ENV ? key.toUpperCase() : key)),
);
const NORMALIZED_DENYLIST = new Set(
	Array.from(DEFAULT_ENV_DENYLIST, key => (CASE_INSENSITIVE_ENV ? key.toUpperCase() : key)),
);
const NORMALIZED_ALLOW_PREFIXES = CASE_INSENSITIVE_ENV
	? DEFAULT_ENV_ALLOW_PREFIXES.map(prefix => prefix.toUpperCase())
	: DEFAULT_ENV_ALLOW_PREFIXES;

function normalizeEnvKey(key: string): string {
	return CASE_INSENSITIVE_ENV ? key.toUpperCase() : key;
}

function resolvePathKey(env: Record<string, string | undefined>): string {
	if (!CASE_INSENSITIVE_ENV) return "PATH";
	const match = Object.keys(env).find(candidate => candidate.toLowerCase() === "path");
	return match ?? "PATH";
}

function resolveManagedPythonEnv(): string {
	return getPythonEnvDir();
}

function resolveManagedPythonCandidate(): { venvPath: string; pythonPath: string } {
	const venvPath = resolveManagedPythonEnv();
	const binDir = process.platform === "win32" ? path.join(venvPath, "Scripts") : path.join(venvPath, "bin");
	const pythonPath = path.join(binDir, process.platform === "win32" ? "python.exe" : "python");
	return { venvPath, pythonPath };
}

export interface PythonRuntime {
	/** Path to python executable */
	pythonPath: string;
	/** Filtered environment variables */
	env: Record<string, string | undefined>;
	/** Path to virtual environment, if detected */
	venvPath?: string;
}

/**
 * Filter environment variables to a safe allowlist for Python subprocesses.
 * Removes sensitive API keys and limits to known-safe variables.
 */
export function filterEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
	const filtered: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		const normalizedKey = normalizeEnvKey(key);
		if (NORMALIZED_DENYLIST.has(normalizedKey)) continue;
		if (NORMALIZED_ALLOWLIST.has(normalizedKey)) {
			const destKey = normalizedKey === "PATH" ? "PATH" : key;
			filtered[destKey] = value;
			continue;
		}
		if (NORMALIZED_ALLOW_PREFIXES.some(prefix => normalizedKey.startsWith(prefix))) {
			filtered[key] = value;
		}
	}
	return filtered;
}

/**
 * Detect virtual environment path from VIRTUAL_ENV or common locations.
 */
export function resolveVenvPath(cwd: string): string | undefined {
	if ($env.VIRTUAL_ENV) return $env.VIRTUAL_ENV;
	const candidates = [path.join(cwd, ".venv"), path.join(cwd, "venv")];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

/**
 * Resolve the windowless Python executable (pythonw.exe) on Windows.
 * Falls back to the regular Python path if pythonw.exe is not available.
 */
function resolveWindowlessPython(pythonPath: string): string {
	if (process.platform !== "win32") return pythonPath;
	const pythonwPath = pythonPath.replace(/python\.exe$/i, "pythonw.exe");
	if (pythonwPath !== pythonPath && fs.existsSync(pythonwPath)) {
		return pythonwPath;
	}
	return pythonPath;
}

function venvBinDir(venvPath: string): string {
	return process.platform === "win32" ? path.join(venvPath, "Scripts") : path.join(venvPath, "bin");
}

/**
 * Apply a venv-style PATH/VIRTUAL_ENV layout onto a fresh copy of `baseEnv` for
 * the interpreter living in `binDir`.
 */
function applyVenvEnv(
	baseEnv: Record<string, string | undefined>,
	venvPath: string,
	binDir: string,
): Record<string, string | undefined> {
	const env = { ...baseEnv };
	env.VIRTUAL_ENV = venvPath;
	const pathKey = resolvePathKey(env);
	const currentPath = env[pathKey];
	env[pathKey] = currentPath ? `${binDir}${path.delimiter}${currentPath}` : binDir;
	return env;
}

/**
 * Enumerate candidate Python runtimes in priority order: an active/project venv,
 * the managed `~/.cornfield/python-env`, then the interpreter on PATH. Every
 * candidate that physically exists is returned, deduplicated by executable.
 *
 * Callers that need a *working* interpreter must probe the candidates in order
 * ({@link selectKernelRuntime}). Committing to the first path that exists on
 * disk lets a project venv without the kernel dependencies shadow a managed
 * environment that has them — which silently disabled the Python tool wherever
 * a `.venv` appeared (measured 2026-09-16).
 */
export function enumeratePythonRuntimes(cwd: string, baseEnv: Record<string, string | undefined>): PythonRuntime[] {
	const runtimes: PythonRuntime[] = [];
	const seen = new Set<string>();
	const push = (runtime: PythonRuntime): void => {
		if (seen.has(runtime.pythonPath)) return;
		seen.add(runtime.pythonPath);
		runtimes.push(runtime);
	};

	const venvPath = baseEnv.VIRTUAL_ENV ?? resolveVenvPath(cwd);
	if (venvPath) {
		const binDir = venvBinDir(venvPath);
		const pythonCandidate = path.join(binDir, process.platform === "win32" ? "python.exe" : "python");
		if (fs.existsSync(pythonCandidate)) {
			push({
				pythonPath: resolveWindowlessPython(pythonCandidate),
				env: applyVenvEnv(baseEnv, venvPath, binDir),
				venvPath,
			});
		}
	}

	const managed = resolveManagedPythonCandidate();
	if (fs.existsSync(managed.pythonPath)) {
		push({
			pythonPath: resolveWindowlessPython(managed.pythonPath),
			env: applyVenvEnv(baseEnv, managed.venvPath, venvBinDir(managed.venvPath)),
			venvPath: managed.venvPath,
		});
	}

	const systemPath = $which("python") ?? $which("python3");
	if (systemPath) {
		push({ pythonPath: resolveWindowlessPython(systemPath), env: { ...baseEnv } });
	}

	return runtimes;
}

/**
 * Resolve the highest-priority Python runtime without probing it.
 *
 * Only for the explicit preflight opt-out (`PI_PYTHON_SKIP_CHECK`), where the
 * operator has declared that the first candidate is the right one. Every other
 * path goes through {@link selectKernelRuntime}, so the runtime that hosts the
 * kernel is the one the preflight validated.
 */
export function resolvePythonRuntime(cwd: string, baseEnv: Record<string, string | undefined>): PythonRuntime {
	const [runtime] = enumeratePythonRuntimes(cwd, baseEnv);
	if (!runtime) {
		throw new Error("Python executable not found on PATH");
	}
	return runtime;
}

/** Whether `runtime` provides everything a Jupyter kernel host needs. */
export async function probeKernelRuntime(runtime: PythonRuntime, cwd: string): Promise<boolean> {
	const result = await $`${runtime.pythonPath} -c ${KERNEL_DEPENDENCY_PROBE}`
		.quiet()
		.nothrow()
		.cwd(cwd)
		.env(runtime.env);
	return result.exitCode === 0;
}

/**
 * Successful kernel-host selections, keyed by cwd. Failures are not cached, so
 * installing the packages mid-session is picked up on the next attempt.
 */
const kernelRuntimeSelection = new Map<string, PythonRuntime>();

/**
 * @internal
 */
export function _resetKernelRuntimeSelectionForTest(): void {
	kernelRuntimeSelection.clear();
}

export interface KernelRuntimeSelection {
	/** The selected runtime, or null when no candidate provides the dependencies. */
	runtime: PythonRuntime | null;
	/** Candidates probed, in priority order — `tried[0]` is the project's own interpreter. */
	tried: PythonRuntime[];
}

/**
 * Resolve the runtime that will host the kernel for `cwd`: the first candidate
 * from {@link enumeratePythonRuntimes} that provides the kernel dependencies.
 *
 * This is the single authority for "which Python runs the toolkit's kernels" —
 * the preflight, the gateway spawn, and kernel startup all consume it, so a
 * passing preflight cannot disagree with the interpreter a kernel actually runs
 * on. Selection is cached per cwd for the process lifetime, which also keeps the
 * expensive probe to one spawn per cwd instead of one per kernel.
 */
export async function selectKernelRuntime(
	cwd: string,
	baseEnv: Record<string, string | undefined>,
): Promise<KernelRuntimeSelection> {
	const cached = kernelRuntimeSelection.get(cwd);
	if (cached) {
		return { runtime: cached, tried: [cached] };
	}
	const tried: PythonRuntime[] = [];
	for (const runtime of enumeratePythonRuntimes(cwd, baseEnv)) {
		tried.push(runtime);
		if (await probeKernelRuntime(runtime, cwd)) {
			kernelRuntimeSelection.set(cwd, runtime);
			return { runtime, tried };
		}
	}
	return { runtime: null, tried };
}
