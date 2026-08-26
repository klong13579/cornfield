/**
 * squad-programming validation boundary tests
 *
 * 测试 bootstrap.ts 的 validateBundle / resolveModel / isBanned 逻辑。
 * 通过构造临时 bundle JSON 文件 + 调用 `bootstrap.ts --check` 验证。
 *
 * 测试范围:
 *   1. squadVersion 校验（缺失/类型/新旧版本）
 *   2. modelTier 校验（合法档位/非法档位/禁用清单/未配置档位）
 *   3. model 字段直接指定/兜底 cheap
 *   4. 通用 bundle 校验（空 subtasks / 重复 id / 缺 acceptance / gate 护栏）
 */

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const BOOTSTRAP_SCRIPT = path.resolve(
	import.meta.dirname!, "..", "scripts", "bootstrap.ts",
);

function makeBundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		squadVersion: 1,
		squadId: "test-squad-boundary",
		taskType: "code",
		baseBranch: "main",
		maxConcurrency: 2,
		modelTiers: {
			cheap: "narwal-plan/deepseek-v4-flash",
			mid: "narwal-plan/deepseek-v4-pro",
			high: "narwal-plan/glm-5.3",
			banned: ["narwal-plan/claude-opus-*", "narwal-plan/claude-sonnet-*"],
		},
		parent: { target: "planner", sessionId: "sess-001", cwd: "/tmp" },
		subtasks: [
			{
				id: "T1",
				title: "单元测试",
				kind: "test",
				isolation: "worktree",
				scope: { files: ["packages/foo/**"] },
				deps: [],
				acceptance: "bun test packages/foo 全部通过",
				gate: {
					kind: "derived",
					verifiers: ["bun test packages/foo"],
					acceptance: "全部通过",
					mergePolicy: "auto",
				},
				modelTier: "cheap",
				branch: "feat/t1",
				budgetTokens: 100000,
			},
		],
		...overrides,
	};
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
	const result = { ...base };
	for (const [k, v] of Object.entries(patch)) {
		if (v !== undefined) result[k] = v;
		else delete result[k];
	}
	return result;
}

async function runCheck(bundle: Record<string, unknown>): Promise<{ code: number; stderr: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "squad-test-"));
	const bundlePath = path.join(tmpDir, "bundle.json");
	await fs.promises.writeFile(bundlePath, JSON.stringify(bundle, null, 2));

	const proc = Bun.spawn(["bun", "run", BOOTSTRAP_SCRIPT, "--check", bundlePath], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	const stderr = await new Response(proc.stderr).text();

	// 清理
	await fs.promises.rm(tmpDir, { recursive: true, force: true });

	return { code: exitCode ?? 1, stderr };
}

// ─── squadVersion 校验 ───────────────────────────────────────────────────────

describe("squadVersion validation", () => {
	test("squadVersion=1 通过", async () => {
		const { code } = await runCheck(makeBundle());
		expect(code).toBe(0);
	});

	test("缺少 squadVersion 拒绝", async () => {
		const bundle = makeBundle();
		delete bundle.squadVersion;
		const { code, stderr } = await runCheck(bundle);
		expect(code).not.toBe(0);
		expect(stderr).toMatch(/squadVersion/i);
	});

	test("squadVersion 非数字拒绝", async () => {
		const { code, stderr } = await runCheck(
			makeBundle({ squadVersion: "1" }),
		);
		expect(code).not.toBe(0);
		expect(stderr).toMatch(/整数/i);
	});

	test("squadVersion 浮点数拒绝", async () => {
		const { code, stderr } = await runCheck(
			makeBundle({ squadVersion: 1.5 }),
		);
		expect(code).not.toBe(0);
		expect(stderr).toMatch(/整数/i);
	});

	test("squadVersion=0 拒绝（过旧版本）", async () => {
		const { code, stderr } = await runCheck(
			makeBundle({ squadVersion: 0 }),
		);
		expect(code).not.toBe(0);
		expect(stderr).toMatch(/不匹配/);
	});

	test("squadVersion=2 拒绝（未来版本）", async () => {
		const { code, stderr } = await runCheck(
			makeBundle({ squadVersion: 2 }),
		);
		expect(code).not.toBe(0);
		expect(stderr).toMatch(/不匹配/);
	});

	test("squadVersion 负数拒绝", async () => {
		const { code, stderr } = await runCheck(
			makeBundle({ squadVersion: -1 }),
		);
		expect(code).not.toBe(0);
		expect(stderr).toMatch(/不匹配/);
	});

	test("squadVersion null 拒绝", async () => {
		const { code, stderr } = await runCheck(
			makeBundle({ squadVersion: null }),
		);
		expect(code).not.toBe(0);
		expect(stderr).toMatch(/squadVersion/);
	});
});

// ─── modelTier 校验 ──────────────────────────────────────────────────────────

describe("modelTier validation", () => {
	test("cheap 档位通过", async () => {
		const { code } = await runCheck(makeBundle());
		expect(code).toBe(0);
	});

	test("mid 档位通过", async () => {
		const { code } = await runCheck(
			makeBundle({
				subtasks: [
					{
						...(makeBundle().subtasks as Array<Record<string, unknown>>)[0],
						modelTier: "mid",
					},
				],
			}),
		);
		expect(code).toBe(0);
	});

	test("high 档位通过", async () => {
		const { code } = await runCheck(
			makeBundle({
				subtasks: [
					{
						...(makeBundle().subtasks as Array<Record<string, unknown>>)[0],
						modelTier: "high",
					},
				],
			}),
		);
		expect(code).toBe(0);
	});

	test("非法档位拒绝", async () => {
		const { code, stderr } = await runCheck(
			makeBundle({
				subtasks: [
					{
						...(makeBundle().subtasks as Array<Record<string, unknown>>)[0],
						modelTier: "pro",
					},
				],
			}),
		);
		expect(code).not.toBe(0);
		expect(stderr).toMatch(/pro/);
		expect(stderr).toMatch(/cheap|mid|high/);
	});

	test("model 字段直接指定覆盖档位", async () => {
		const { code } = await runCheck(
			makeBundle({
				subtasks: [
					{
						...(makeBundle().subtasks as Array<Record<string, unknown>>)[0],
						modelTier: undefined,
						model: "narwal-plan/deepseek-v4-flash",
					},
				],
			}),
		);
		expect(code).toBe(0);
	});

	test("model 在禁用清单拒绝", async () => {
		const { code, stderr } = await runCheck(
			makeBundle({
				subtasks: [
					{
						...(makeBundle().subtasks as Array<Record<string, unknown>>)[0],
						modelTier: undefined,
						model: "narwal-plan/claude-opus-4",
					},
				],
			}),
		);
		expect(code).not.toBe(0);
		expect(stderr).toMatch(/禁用/);
	});

	test("modelTier 在表里但未配置模型拒绝", async () => {
		const { code, stderr } = await runCheck(
			makeBundle({
				modelTiers: { cheap: "narwal-plan/deepseek-v4-flash", mid: "narwal-plan/deepseek-v4-pro" },
				subtasks: [
					{
						...(makeBundle().subtasks as Array<Record<string, unknown>>)[0],
						modelTier: "high",
					},
				],
			}),
		);
		expect(code).not.toBe(0);
		expect(stderr).toMatch(/解析不出/);
	});

	test("不指定 modelTier 也不指定 model 兜底 cheap", async () => {
		const { code } = await runCheck(
			makeBundle({
				subtasks: [
					{
						...(makeBundle().subtasks as Array<Record<string, unknown>>)[0],
						modelTier: undefined,
						model: undefined,
					},
				],
			}),
		);
		expect(code).toBe(0);
	});
});

// ─── 通用 bundle 校验 ────────────────────────────────────────────────────────

describe("general bundle validation", () => {
	test("空 subtasks 拒绝", async () => {
		const { code, stderr } = await runCheck(
			makeBundle({ subtasks: [] }),
		);
		expect(code).not.toBe(0);
		expect(stderr).toMatch(/至少 1 个/);
	});

	test("重复 subtask id 拒绝", async () => {
		const t = (makeBundle().subtasks as Array<Record<string, unknown>>)[0];
		const { code, stderr } = await runCheck(
			makeBundle({ subtasks: [t, { ...t, isolation: "shared-read", branch: undefined }] }),
		);
		expect(code).not.toBe(0);
		expect(stderr).toMatch(/重复/);
	});

	test("缺少 acceptance 拒绝", async () => {
		const { code, stderr } = await runCheck(
			makeBundle({
				subtasks: [
					{
						...(makeBundle().subtasks as Array<Record<string, unknown>>)[0],
						acceptance: undefined,
					},
				],
			}),
		);
		expect(code).not.toBe(0);
		expect(stderr).toMatch(/acceptance/);
	});

	test("unknown gate 必须 human-review", async () => {
		const { code, stderr } = await runCheck(
			makeBundle({
				subtasks: [
					{
						...(makeBundle().subtasks as Array<Record<string, unknown>>)[0],
						gate: { kind: "unknown", verifiers: [], acceptance: "?", mergePolicy: "auto" },
					},
				],
			}),
		);
		expect(code).not.toBe(0);
		expect(stderr).toMatch(/human-review/);
	});

	test("worktree isolation 需要 branch", async () => {
		const { code, stderr } = await runCheck(
			makeBundle({
				subtasks: [
					{
						...(makeBundle().subtasks as Array<Record<string, unknown>>)[0],
						branch: undefined,
					},
				],
			}),
		);
		expect(code).not.toBe(0);
		expect(stderr).toMatch(/branch/);
	});

	test("shared-read 不需要 branch（通过）", async () => {
		const { code } = await runCheck(
			makeBundle({
				subtasks: [
					{
						...(makeBundle().subtasks as Array<Record<string, unknown>>)[0],
						isolation: "shared-read",
						branch: undefined,
					},
				],
			}),
		);
		expect(code).toBe(0);
	});

	test("缺少 parent.target 拒绝", async () => {
		const { code, stderr } = await runCheck(
			makeBundle({ parent: { target: "", sessionId: "sess-001" } }),
		);
		expect(code).not.toBe(0);
		expect(stderr).toMatch(/parent\.target/);
	});

	test("缺少 modelTiers 拒绝", async () => {
		const { code, stderr } = await runCheck(
			makeBundle({ modelTiers: undefined }),
		);
		expect(code).not.toBe(0);
		expect(stderr).toMatch(/modelTiers/);
	});
});

// ─── 父模型 >= 子模型校验 ───────────────────────────────────────────────────

describe("parent model >= child model tier", () => {
	async function runCheckWithParent(
		bundle: Record<string, unknown>,
		parentModel: string,
	): Promise<{ code: number; stderr: string }> {
		const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "squad-test-"));
		const bundlePath = path.join(tmpDir, "bundle.json");
		await fs.promises.writeFile(bundlePath, JSON.stringify(bundle, null, 2));

		const proc = Bun.spawn(
			["bun", "run", BOOTSTRAP_SCRIPT, "--check", bundlePath, "--parent-model", parentModel],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const exitCode = await proc.exited;
		const stderr = await new Response(proc.stderr).text();
		await fs.promises.rm(tmpDir, { recursive: true, force: true });
		return { code: exitCode ?? 1, stderr };
	}

	function childWithTier(tier: string): Record<string, unknown> {
		return {
			...(makeBundle().subtasks as Array<Record<string, unknown>>)[0],
			modelTier: tier,
		};
	}

	test("父=mid, 子=cheap 通过", async () => {
		const { code } = await runCheckWithParent(
			makeBundle({ subtasks: [childWithTier("cheap")] }),
			"narwal-plan/deepseek-v4-pro",
		);
		expect(code).toBe(0);
	});

	test("父=mid, 子=mid 通过（同级允许）", async () => {
		const { code } = await runCheckWithParent(
			makeBundle({ subtasks: [childWithTier("mid")] }),
			"narwal-plan/deepseek-v4-pro",
		);
		expect(code).toBe(0);
	});

	test("父=mid, 子=high 拒绝", async () => {
		const { code, stderr } = await runCheckWithParent(
			makeBundle({ subtasks: [childWithTier("high")] }),
			"narwal-plan/deepseek-v4-pro",
		);
		expect(code).not.toBe(0);
		expect(stderr).toMatch(/高于/);
	});

	test("父=high, 子=high 通过", async () => {
		const { code } = await runCheckWithParent(
			makeBundle({ subtasks: [childWithTier("high")] }),
			"narwal-plan/glm-5.3",
		);
		expect(code).toBe(0);
	});

	test("父=high, 子=cheap 通过", async () => {
		const { code } = await runCheckWithParent(
			makeBundle({ subtasks: [childWithTier("cheap")] }),
			"narwal-plan/glm-5.3",
		);
		expect(code).toBe(0);
	});

	test("父=cheap, 子=mid 拒绝", async () => {
		const { code, stderr } = await runCheckWithParent(
			makeBundle({ subtasks: [childWithTier("mid")] }),
			"narwal-plan/deepseek-v4-flash",
		);
		expect(code).not.toBe(0);
		expect(stderr).toMatch(/高于/);
	});

	test("父模型不在标准档位表跳过校验", async () => {
		const { code } = await runCheckWithParent(
			makeBundle({ subtasks: [childWithTier("high")] }),
			"anthropic/claude-sonnet-4", // 不在 cheap/mid/high 中 → 跳过
		);
		expect(code).toBe(0);
	});

	test("子模型不在标准档位表跳过比较", async () => {
		const { code } = await runCheckWithParent(
			makeBundle({
				subtasks: [
					{
						...(makeBundle().subtasks as Array<Record<string, unknown>>)[0],
						modelTier: undefined,
						model: "anthropic/claude-sonnet-4",
					},
				],
			}),
			"narwal-plan/deepseek-v4-flash",
		);
		expect(code).toBe(0);
	});

	test("多个子任务，一个违规就拒绝", async () => {
		const t1 = childWithTier("cheap");
		const t2 = { ...childWithTier("high"), id: "T2", branch: "feat/t2" }; // 违规
		const { code, stderr } = await runCheckWithParent(
			makeBundle({ subtasks: [t1, t2] }),
			"narwal-plan/deepseek-v4-pro",
		);
		expect(code).not.toBe(0);
		expect(stderr).toMatch(/高于/);
	});
});