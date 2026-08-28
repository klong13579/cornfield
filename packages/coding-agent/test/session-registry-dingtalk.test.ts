/**
 * session-registry dingtalk 绑定加载（并行传递的功能：Agent 详情页显示钉钉机器人配置）。
 *
 * loadAgentMetas 应：读 gateway.json 的 channels.dingtalk.accounts（config root 下），
 * 按 accountId（= registry key）挂到 AgentMeta.dingtalk。
 * - gateway.json 缺失 → 空 Map，不崩溃
 * - 启停状态（enabled:false）与可选字段（robotName/appKey/robotCode/hideThinkingBlock）映射正确
 *
 * 隔离：registry 读进程 HOME/.omp/agent/registry.json；gateway.json 读 config root。
 * 测试同时设 HOME 与 config root，afterEach 恢复。
 */
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir, setConfigRootDir } from "@cornfield/utils";
import { loadAgentMetas } from "../src/server/session-registry";

test("loadAgentMetas：gateway.json dingtalk accounts 映射到 AgentMeta", async () => {
	const isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-registry-dt-"));
	const savedHome = process.env.HOME;
	const savedConfigRoot = getConfigRootDir();
	process.env.HOME = isolatedHome;
	setConfigRootDir(isolatedHome);

	const hrDir = path.join(isolatedHome, "agents", "hr");
	const swDir = path.join(isolatedHome, "agents", "sw");
	for (const dir of [hrDir, swDir]) {
		await fs.mkdir(path.join(dir, ".omp"), { recursive: true });
		await Bun.write(
			path.join(dir, ".omp", "workspace.json"),
			JSON.stringify({
				schemaVersion: 2,
				id: path.basename(dir),
				name: `${path.basename(dir)}-agent`,
				type: "agent",
				root: ".",
				projectRoot: ".",
			}),
		);
	}
	const registryDir = path.join(isolatedHome, ".omp", "agent");
	await fs.mkdir(registryDir, { recursive: true });
	await Bun.write(
		path.join(registryDir, "registry.json"),
		JSON.stringify({
			version: 2,
			agents: {
				hr: { path: hrDir, registeredAt: new Date().toISOString(), template: "default" },
				sw: { path: swDir, registeredAt: new Date().toISOString(), template: "default" },
			},
		}),
	);
	await Bun.write(
		path.join(isolatedHome, "gateway.json"),
		JSON.stringify({
			channels: {
				dingtalk: {
					accounts: {
						hr: {
							appKey: "ding-hr-appkey",
							robotCode: "ding-hr-robot",
							enabled: true,
							robotName: "M-HR",
							hideThinkingBlock: true,
						},
						sw: {
							appKey: "ding-sw-appkey",
							enabled: false,
							robotName: "M-SW",
						},
					},
				},
			},
		}),
	);

	try {
		const metas = await loadAgentMetas();
		const hr = metas.find(m => m.id === "hr");
		const sw = metas.find(m => m.id === "sw");

		expect(hr?.dingtalk).toBeDefined();
		expect(hr?.dingtalk?.enabled).toBe(true);
		expect(hr?.dingtalk?.robotName).toBe("M-HR");
		expect(hr?.dingtalk?.appKey).toBe("ding-hr-appkey");
		expect(hr?.dingtalk?.robotCode).toBe("ding-hr-robot");
		expect(hr?.dingtalk?.hideThinkingBlock).toBe(true);

		// 停用账号：enabled=false，未提供的字段 undefined
		expect(sw?.dingtalk?.enabled).toBe(false);
		expect(sw?.dingtalk?.robotName).toBe("M-SW");
		expect(sw?.dingtalk?.robotCode).toBeUndefined();
		expect(sw?.dingtalk?.hideThinkingBlock).toBeUndefined();
	} finally {
		process.env.HOME = savedHome;
		setConfigRootDir(savedConfigRoot);
		await fs.rm(isolatedHome, { recursive: true, force: true });
	}
});

test("loadAgentMetas：gateway.json 缺失 → 空 Map 不崩溃，无 dingtalk 字段", async () => {
	const isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-registry-nogt-"));
	const savedHome = process.env.HOME;
	const savedConfigRoot = getConfigRootDir();
	process.env.HOME = isolatedHome;
	setConfigRootDir(isolatedHome);

	const hrDir = path.join(isolatedHome, "agents", "hr");
	await fs.mkdir(path.join(hrDir, ".omp"), { recursive: true });
	await Bun.write(
		path.join(hrDir, ".omp", "workspace.json"),
		JSON.stringify({
			schemaVersion: 2,
			id: "hr",
			name: "hr-agent",
			type: "agent",
			root: ".",
			projectRoot: ".",
		}),
	);
	const registryDir = path.join(isolatedHome, ".omp", "agent");
	await fs.mkdir(registryDir, { recursive: true });
	await Bun.write(
		path.join(registryDir, "registry.json"),
		JSON.stringify({
			version: 2,
			agents: { hr: { path: hrDir, registeredAt: new Date().toISOString(), template: "default" } },
		}),
	);

	try {
		const metas = await loadAgentMetas();
		const hr = metas.find(m => m.id === "hr");
		expect(hr?.dingtalk).toBeUndefined();
	} finally {
		process.env.HOME = savedHome;
		setConfigRootDir(savedConfigRoot);
		await fs.rm(isolatedHome, { recursive: true, force: true });
	}
});
