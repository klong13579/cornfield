/**
 * Python kernel gateway orphan sweep — contract test.
 *
 * The shared gateway is reachable only through its `gateway.json`. When that
 * record is lost the gateway keeps running with nothing to stop it and the next
 * session spawns another (observed 2026-09-19: 16 orphans, oldest 8 days old,
 * all PPID=1). The sweep is the missing garbage collector — and the only thing
 * standing between "reap a corpse" and "kill someone's live session", so the
 * selection rules are pinned here.
 *
 * Rules (all three must hold):
 *   1. `-m kernel_gateway` in argv;
 *   2. PPID 1 — nothing alive spawned it;
 *   3. no profile's `gateway.json` records its pid.
 */
import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import { reapOrphanKernelGateways, selectOrphanKernelGateways } from "../../src/ipy/gateway-coordinator";

const PY = "/Users/x/.cornfield/python-env/bin/python";
const GW_ARGS = `${PY} -m kernel_gateway --KernelGatewayApp.ip=127.0.0.1 --KernelGatewayApp.port=59146 --KernelGatewayApp.port_retries=0 --KernelGatewayApp.allow_origin=* --JupyterApp.answer_yes=true`;

/** One `ps -eo pid,ppid,args` row. */
function row(pid: number, ppid: number, args: string): string {
	return `${String(pid).padStart(6)} ${String(ppid).padStart(5)} ${args}`;
}

describe("selectOrphanKernelGateways", () => {
	test("selects a PPID=1 kernel gateway that no record references", () => {
		const ps = [row(1001, 1, GW_ARGS)].join("\n");
		expect(selectOrphanKernelGateways(ps, new Set())).toEqual([1001]);
	});

	test("leaves a recorded gateway alone — it is reachable, so it is not garbage", () => {
		const ps = [row(1002, 1, GW_ARGS)].join("\n");
		expect(selectOrphanKernelGateways(ps, new Set([1002]))).toEqual([]);
	});

	test("leaves a gateway whose parent is still alive", () => {
		const ps = [row(1003, 4242, GW_ARGS)].join("\n");
		expect(selectOrphanKernelGateways(ps, new Set())).toEqual([]);
	});

	test("never touches a non-gateway python process", () => {
		const ps = [
			row(1004, 1, `${PY} -m ipykernel_launcher -f /tmp/kernel.json`),
			row(1005, 1, `${PY} -m kernel_gateway_client`),
			row(1006, 1, `${PY} /Users/x/scripts/kernel_gateway.py`),
		].join("\n");
		expect(selectOrphanKernelGateways(ps, new Set())).toEqual([]);
	});

	test("never touches our own pid", () => {
		const ps = [row(process.pid, 1, GW_ARGS)].join("\n");
		expect(selectOrphanKernelGateways(ps, new Set())).toEqual([]);
	});

	test("ignores the ps header and malformed lines", () => {
		const ps = ["  PID  PPID COMMAND", "", "not-a-row", row(1007, 1, GW_ARGS), "   "].join("\n");
		expect(selectOrphanKernelGateways(ps, new Set())).toEqual([1007]);
	});

	test("mixed table: only unreferenced orphans are selected", () => {
		const ps = [
			"  PID  PPID COMMAND",
			row(2001, 1, GW_ARGS), // orphan → kill
			row(2002, 1, GW_ARGS), // referenced → keep
			row(2003, 900, GW_ARGS), // live parent → keep
			row(2004, 1, `${PY} -m ipykernel_launcher -f /tmp/k.json`), // not a gateway → keep
			row(2005, 1, GW_ARGS), // orphan → kill
		].join("\n");
		expect(selectOrphanKernelGateways(ps, new Set([2002]))).toEqual([2001, 2005]);
	});
});

describe("reapOrphanKernelGateways", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("SIGTERMs exactly the selected orphans and reports them", async () => {
		const ps = [row(3001, 1, GW_ARGS), row(3002, 1, GW_ARGS), row(3003, 1, GW_ARGS)].join("\n");
		spyOn(Bun, "spawnSync").mockReturnValue({
			exitCode: 0,
			signalCode: null,
			stdout: Buffer.from(ps),
			stderr: Buffer.from(""),
		} as unknown as ReturnType<typeof Bun.spawnSync>);
		const killSpy = spyOn(process, "kill").mockImplementation(() => true);

		const killed = await reapOrphanKernelGateways(new Set([3002]));

		expect(killed).toEqual([3001, 3003]);
		expect(killSpy).toHaveBeenCalledTimes(2);
		expect(killSpy).toHaveBeenCalledWith(3001, "SIGTERM");
		expect(killSpy).toHaveBeenCalledWith(3003, "SIGTERM");
	});

	test("kills nothing when ps fails — an unreadable process table is not evidence", async () => {
		spyOn(Bun, "spawnSync").mockReturnValue({
			exitCode: 1,
			signalCode: null,
			stdout: Buffer.from(""),
			stderr: Buffer.from("ps: not permitted"),
		} as unknown as ReturnType<typeof Bun.spawnSync>);
		const killSpy = spyOn(process, "kill").mockImplementation(() => true);

		const killed = await reapOrphanKernelGateways(new Set());

		expect(killed).toEqual([]);
		expect(killSpy).not.toHaveBeenCalled();
	});

	test("a kill that throws does not abort the sweep", async () => {
		const ps = [row(4001, 1, GW_ARGS), row(4002, 1, GW_ARGS)].join("\n");
		spyOn(Bun, "spawnSync").mockReturnValue({
			exitCode: 0,
			signalCode: null,
			stdout: Buffer.from(ps),
			stderr: Buffer.from(""),
		} as unknown as ReturnType<typeof Bun.spawnSync>);
		const killSpy = spyOn(process, "kill").mockImplementation((pid: number) => {
			if (pid === 4001) throw new Error("EPERM");
			return true;
		});

		const killed = await reapOrphanKernelGateways(new Set());

		expect(killed).toEqual([4002]);
		expect(killSpy).toHaveBeenCalledTimes(2);
	});
});
