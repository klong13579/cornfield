import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { migrateLegacyModelConfig, normalizeRoute } from "../src/config/model-routes";
import { Settings } from "../src/config/settings";

describe("migrateLegacyModelConfig（纯迁移）", () => {
	test("旧 modelRoles 字符串 → 角色 primary，fallbacks 为空", () => {
		const { routes, changed } = migrateLegacyModelConfig({ modelRoles: { default: "a/one", plan: "b/two:high" } });
		expect(changed).toBe(true);
		expect(routes.default).toEqual({ primary: "a/one", fallbacks: [] });
		expect(routes.plan).toEqual({ primary: "b/two:high", fallbacks: [] });
	});

	test("旧 modelFallbacks → default 角色回退链（去重、剔除与 primary 相同项）", () => {
		const { routes } = migrateLegacyModelConfig({
			modelRoles: { default: "a/one" },
			modelFallbacks: ["b/two", "b/two", "a/one", "c/three"],
		});
		expect(routes.default).toEqual({ primary: "a/one", fallbacks: ["b/two", "c/three"] });
	});

	test("无 default 角色时旧回退链仍迁移为 default（仅 fallbacks，primary 缺省）", () => {
		const { routes } = migrateLegacyModelConfig({ modelFallbacks: ["b/two"] });
		expect(routes.default).toEqual({ primary: undefined, fallbacks: ["b/two"] });
	});

	test("已有 modelRoutes 条目优先：旧 modelRoles 不覆盖已定义角色", () => {
		const { routes, changed } = migrateLegacyModelConfig({
			modelRoutes: { plan: { primary: "new/p", fallbacks: ["keep/f"] } },
			modelRoles: { plan: "old/p", smol: "a/one" },
		});
		expect(routes.plan).toEqual({ primary: "new/p", fallbacks: ["keep/f"] });
		expect(routes.smol).toEqual({ primary: "a/one", fallbacks: [] });
		expect(changed).toBe(true); // 旧键仍需删除
	});

	test("default 已有非空回退链时旧 modelFallbacks 跳过（部分迁移中断不回退）", () => {
		const { routes } = migrateLegacyModelConfig({
			modelRoutes: { default: { primary: "a/one", fallbacks: ["keep/f"] } },
			modelFallbacks: ["legacy/f"],
		});
		expect(routes.default?.fallbacks).toEqual(["keep/f"]);
	});

	test("空值/非法值被丢弃且报告 changed", () => {
		const { routes, changed } = migrateLegacyModelConfig({
			modelRoles: { empty: "", bad: 42 },
			modelFallbacks: "not-an-array",
		});
		expect(routes).toEqual({});
		expect(changed).toBe(true);
	});

	test("已迁移配置（无旧键）幂等：changed=false", () => {
		const raw = { modelRoutes: { default: { primary: "a/one", fallbacks: ["b/two"] } } };
		const first = migrateLegacyModelConfig(raw);
		expect(first.changed).toBe(false);
		const second = migrateLegacyModelConfig({ ...raw, modelRoutes: first.routes });
		expect(second.changed).toBe(false);
		expect(second.routes).toEqual(first.routes);
	});
});

describe("normalizeRoute", () => {
	test("去重、剔除 primary、丢弃非字符串，全空返回 undefined", () => {
		expect(normalizeRoute({ primary: " a/one ", fallbacks: ["b/two", "b/two", "a/one", 42, ""] })).toEqual({
			primary: "a/one",
			fallbacks: ["b/two"],
		});
		expect(normalizeRoute({})).toBeUndefined();
		expect(normalizeRoute("b/two")).toBeUndefined();
	});
});

describe("Settings 文件级迁移（modelRoles/modelFallbacks → modelRoutes）", () => {
	test("加载时迁移并重写 config.yml，删除旧键；二次加载幂等", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "cornfield-routes-mig-"));
		try {
			const configPath = path.join(agentDir, "config.yml");
			await fs.writeFile(
				configPath,
				["theme: dark", "modelRoles:", "  default: a/one", "modelFallbacks:", "  - b/two", "  - b/two", ""].join(
					"\n",
				),
			);

			const settings = await Settings.create({ agentDir, inMemory: false });
			expect(settings.getModelRole("default")).toBe("a/one");
			expect(settings.getModelRoute("default")?.fallbacks).toEqual(["b/two"]);

			const rewritten = await fs.readFile(configPath, "utf8");
			expect(rewritten).toContain("modelRoutes");
			expect(rewritten).toContain("primary: a/one");
			expect(rewritten).not.toContain("modelRoles");
			expect(rewritten).not.toContain("modelFallbacks");
			expect(rewritten).toContain("theme: dark"); // 其他键原样保留

			// 二次加载幂等：不再改写（无旧键）
			const before = await fs.readFile(configPath, "utf8");
			const again = await Settings.create({ agentDir, inMemory: false });
			expect(again.getModelRole("default")).toBe("a/one");
			expect(await fs.readFile(configPath, "utf8")).toBe(before);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});
});
