import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	_resetKernelRuntimeSelectionForTest,
	enumeratePythonRuntimes,
	resolvePythonRuntime,
	selectKernelRuntime,
} from "@cornfield/coding-agent/ipy/runtime";
import { getConfigRootDir, Snowflake, setConfigRootDir } from "@cornfield/utils";

/**
 * Contract: the Python preflight must pick the first interpreter that actually
 * provides the kernel dependencies, not the first path that exists on disk.
 *
 * Why (measured 2026-09-16): resolution committed to `<cwd>/.venv` as soon as the
 * directory existed, so a project venv without `jupyter_kernel_gateway` /
 * `ipykernel` shadowed the managed environment and the `python` tool disappeared
 * for that working directory — with nothing but a log line. One agent lost it for
 * six weeks, another for eight days, both unnoticed.
 *
 * These tests drive real subprocesses: a "python" candidate is a shell script
 * whose exit status stands in for "has the kernel packages", so enumeration
 * order, probing, the first-match rule and the caching are exercised end to end
 * rather than against a mock of the selection logic.
 */
let tmpRoot: string;
let cwd: string;
let venvPython: string;
let managedPython: string;
let originalEnv: string | undefined;

const BASE_ENV: Record<string, string | undefined> = { PATH: "/usr/bin:/bin" };

/** A candidate interpreter whose probe outcome is its exit status (existence is all resolution checks). */
function fakePython(target: string, exitCode: number): string {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, `#!/bin/sh\nexit ${exitCode}\n`, { mode: 0o755 });
	return target;
}

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `py-select-${Snowflake.next()}-`));
	cwd = path.join(tmpRoot, "work");
	fs.mkdirSync(cwd, { recursive: true });
	originalEnv = process.env.CORNFIELD_AGENT_DIR;
	// Isolate the managed environment: without this the real ~/.cornfield/python-env
	// would decide the outcome and the assertions would depend on the machine.
	setConfigRootDir(path.join(tmpRoot, "config"));
	fs.mkdirSync(getConfigRootDir(), { recursive: true });
	venvPython = path.join(cwd, ".venv", "bin", "python");
	managedPython = path.join(getConfigRootDir(), "python-env", "bin", "python");
	_resetKernelRuntimeSelectionForTest();
});

afterEach(() => {
	_resetKernelRuntimeSelectionForTest();
	if (originalEnv === undefined) {
		delete process.env.CORNFIELD_AGENT_DIR;
	} else {
		process.env.CORNFIELD_AGENT_DIR = originalEnv;
	}
	setConfigRootDir(undefined);
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("enumeratePythonRuntimes", () => {
	it("orders the project venv, the managed environment, then PATH", () => {
		fakePython(venvPython, 1);
		fakePython(managedPython, 1);

		const paths = enumeratePythonRuntimes(cwd, BASE_ENV).map(runtime => runtime.pythonPath);

		expect(paths[0]).toBe(venvPython);
		expect(paths[1]).toBe(managedPython);
	});

	it("lists an interpreter named by both VIRTUAL_ENV and the cwd venv exactly once", () => {
		fakePython(venvPython, 1);

		const paths = enumeratePythonRuntimes(cwd, {
			...BASE_ENV,
			VIRTUAL_ENV: path.dirname(path.dirname(venvPython)),
		}).map(runtime => runtime.pythonPath);

		expect(paths).toEqual([venvPython, ...paths.filter(candidate => candidate !== venvPython)]);
		expect(paths.filter(candidate => candidate === venvPython)).toHaveLength(1);
	});

	it("carries the venv activation env for a venv candidate", () => {
		fakePython(venvPython, 1);

		const [runtime] = enumeratePythonRuntimes(cwd, BASE_ENV);
		const venvRoot = path.dirname(path.dirname(venvPython));

		expect(runtime.venvPath).toBe(venvRoot);
		expect(runtime.env.VIRTUAL_ENV).toBe(venvRoot);
		expect(runtime.env.PATH?.startsWith(path.join(venvRoot, "bin"))).toBe(true);
	});
});

describe("selectKernelRuntime", () => {
	it("selects the first candidate that provides the kernel dependencies, not the first that exists", async () => {
		fakePython(venvPython, 1); // project venv exists but cannot host a kernel
		fakePython(managedPython, 0);

		const selection = await selectKernelRuntime(cwd, BASE_ENV);

		expect(selection.runtime?.pythonPath).toBe(managedPython);
		expect(selection.tried.map(runtime => runtime.pythonPath)).toEqual([venvPython, managedPython]);
	});

	it("keeps the project interpreter first in the tried list when nothing can host a kernel", async () => {
		fakePython(venvPython, 1);
		fakePython(managedPython, 1);

		const selection = await selectKernelRuntime(cwd, BASE_ENV);

		expect(selection.runtime).toBeNull();
		expect(selection.tried[0].pythonPath).toBe(venvPython);
		expect(selection.tried.map(runtime => runtime.pythonPath)).toContain(managedPython);
	});

	it("caches a successful selection per cwd so every kernel of a session reuses one interpreter", async () => {
		fakePython(venvPython, 1);
		fakePython(managedPython, 0);
		await selectKernelRuntime(cwd, BASE_ENV);

		fs.rmSync(path.join(cwd, ".venv"), { recursive: true, force: true });
		const second = await selectKernelRuntime(cwd, BASE_ENV);

		expect(second.runtime?.pythonPath).toBe(managedPython);
		expect(second.tried.map(runtime => runtime.pythonPath)).toEqual([managedPython]);
	});

	it("does not cache a failure, so installing the packages mid-session is picked up", async () => {
		fakePython(venvPython, 1);
		fakePython(managedPython, 1);
		expect((await selectKernelRuntime(cwd, BASE_ENV)).runtime).toBeNull();

		fakePython(managedPython, 0);
		const retry = await selectKernelRuntime(cwd, BASE_ENV);

		expect(retry.runtime?.pythonPath).toBe(managedPython);
	});
});

describe("resolvePythonRuntime", () => {
	it("returns the highest-priority candidate unprobed — the PI_PYTHON_SKIP_CHECK escape hatch", () => {
		fakePython(venvPython, 1); // would fail the probe
		fakePython(managedPython, 0);

		expect(resolvePythonRuntime(cwd, BASE_ENV).pythonPath).toBe(venvPython);
	});
});
