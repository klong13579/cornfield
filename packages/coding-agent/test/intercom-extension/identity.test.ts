/**
 * 一个会话的 intercom 身份只有一个来源,而且不是文件。
 *
 * `resolveIntercomSessionId` 是树里唯一推导 id 的地方。broker 拒绝顶掉一个活着的连接持有的 id,
 * 所以第二个来源(机器全局的 `config.json`,同机每个会话都会读到)会把「我是谁」变成
 * 「谁最后注册」——那正是活着的子会话被悄悄换掉、父会话再也找不到它的那条路。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../../src/intercom-extension/config";
import { resolveIntercomSessionId, STABLE_INTERCOM_SESSION_ID_ENV } from "../../src/intercom-extension/identity";

let runtimeDir: string;
let previousAgentDir: string | undefined;
let previousStableId: string | undefined;

/** 机器全局那一个:intercom 目录是 agent 目录的父级(`getIntercomDirPath`)。 */
async function writeMachineGlobalConfig(config: Record<string, unknown>): Promise<string> {
	const configPath = path.join(runtimeDir, "intercom", "config.json");
	await fs.mkdir(path.dirname(configPath), { recursive: true });
	await fs.writeFile(configPath, JSON.stringify(config), "utf-8");
	return configPath;
}

beforeEach(async () => {
	runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-intercom-identity-"));
	previousAgentDir = process.env.CORNFIELD_AGENT_DIR;
	previousStableId = process.env[STABLE_INTERCOM_SESSION_ID_ENV];
	delete process.env[STABLE_INTERCOM_SESSION_ID_ENV];
	process.env.CORNFIELD_AGENT_DIR = path.join(runtimeDir, "agent");
});

afterEach(async () => {
	if (previousAgentDir === undefined) delete process.env.CORNFIELD_AGENT_DIR;
	else process.env.CORNFIELD_AGENT_DIR = previousAgentDir;
	if (previousStableId === undefined) delete process.env[STABLE_INTERCOM_SESSION_ID_ENV];
	else process.env[STABLE_INTERCOM_SESSION_ID_ENV] = previousStableId;
	await fs.rm(runtimeDir, { recursive: true, force: true });
});

describe("resolveIntercomSessionId", () => {
	test("a session with no pinned address answers to its own session id", () => {
		expect(resolveIntercomSessionId("session-abc")).toBe("session-abc");
	});

	test("the pin is the launcher's, per process, and is trimmed", () => {
		process.env[STABLE_INTERCOM_SESSION_ID_ENV] = "  pinned-address  ";

		expect(resolveIntercomSessionId("session-abc")).toBe("pinned-address");
	});

	test("a blank pin is not a pin", () => {
		process.env[STABLE_INTERCOM_SESSION_ID_ENV] = "   ";

		expect(resolveIntercomSessionId("session-abc")).toBe("session-abc");
	});

	test("a machine-global config file decides nothing, even when it names an id", async () => {
		await writeMachineGlobalConfig({ stableId: "machine-wide-id" });

		// The file is still read for the settings it legitimately owns...
		expect(loadConfig()).not.toHaveProperty("stableId");
		// ...and it does not reach identity: only this process's environment can pin.
		expect(resolveIntercomSessionId("session-abc")).toBe("session-abc");

		process.env[STABLE_INTERCOM_SESSION_ID_ENV] = "pinned-address";
		expect(resolveIntercomSessionId("session-abc")).toBe("pinned-address");
	});

	test("the file's other keys still load: dropping identity did not break the loader", async () => {
		await writeMachineGlobalConfig({ stableId: "machine-wide-id", status: "busy", inboundMode: "interrupt" });

		const config = loadConfig();
		expect(config.status).toBe("busy");
		expect(config.inboundMode).toBe("interrupt");
	});
});
