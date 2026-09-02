import { describe, expect, it } from "bun:test";
import type { ModelCatalogDto, ModelCatalogEntryDto } from "@cornfield/wire";
import {
	addCustomRole,
	addFallback,
	buildSpecCheckContext,
	checkSpec,
	computeRoutesDiff,
	computeTagsChanges,
	decodeDraft,
	deleteRole,
	describeRoleSave,
	draftFingerprint,
	draftStorageKey,
	duplicateRole,
	encodeDraft,
	initRoleDraft,
	isDraftDirty,
	isEntryDirty,
	moveFallback,
	normalizeRoutesValue,
	normalizeTagsValue,
	parseModelSpec,
	type RoleRoutes,
	type RoleTags,
	removeFallback,
	renameCustomRole,
	resetRole,
	roleDisplayMeta,
	seedRoute,
	serializeDraft,
	setPrimary,
	stripThinkingSuffix,
	toRoleListItems,
	validateDraft,
	validateRoleId,
	validateRoute,
} from "../src/pages/models/config/role-editor";

/**
 * 角色配置编辑器 #07 纯逻辑回归：草稿状态机 / diff 计算 / 校验闸门 / 序列化 /
 * 草稿持久化编解码 / modelTags 元数据变更 / 列表视图 / 保存文案。
 * 只测纯函数（无 React / 无 store / 无网络）；组件交互由壳层承载。
 */

// ── fixture ──

function catalogEntry(
	overrides: Partial<ModelCatalogEntryDto> & Pick<ModelCatalogEntryDto, "provider" | "id">,
): ModelCatalogEntryDto {
	return {
		name: overrides.id,
		status: "available",
		pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		capabilities: { thinking: false, vision: false, tools: true, inputModalities: ["text"] },
		contextWindowTokens: 200_000,
		roles: [],
		...overrides,
	};
}

function catalogDto(models: ModelCatalogEntryDto[]): ModelCatalogDto {
	return {
		models,
		providers: [],
		disabledProviders: [],
		disabledModels: [],
		generatedAt: "2026-09-02T00:00:00Z",
	};
}

const CTX = buildSpecCheckContext(
	catalogDto([
		catalogEntry({ provider: "prov", id: "m1" }),
		catalogEntry({ provider: "prov", id: "m2", status: "provider-not-configured" }),
		catalogEntry({ provider: "prov", id: "m3", status: "credential-invalid" }),
		catalogEntry({ provider: "prov", id: "m4", status: "disabled" }),
		catalogEntry({ provider: "local", id: "lm", status: "local-offline" }),
		catalogEntry({ provider: "stale", id: "sm", status: "catalog-stale" }),
	]),
);

const NO_CATALOG_CTX = buildSpecCheckContext(null);

// ── 草稿状态机 ──

describe("草稿初始化（initRoleDraft）", () => {
	it("基准为空：8 个内置角色按固定顺序在场，路由为空", () => {
		const draft = initRoleDraft({});
		expect(draft.entries.map(e => e.id)).toEqual([
			"default",
			"smol",
			"slow",
			"vision",
			"plan",
			"designer",
			"commit",
			"task",
		]);
		expect(draft.entries.every(e => e.primary === "" && e.fallbacks.length === 0 && !e.isNew)).toBe(true);
	});

	it("基准含自定义角色：内置在前，自定义按键序追加并带上路由", () => {
		const base: RoleRoutes = {
			custom1: { primary: "prov/m1", fallbacks: ["prov/m2"] },
			default: { fallbacks: ["prov/m1"] },
		};
		const draft = initRoleDraft(base);
		expect(draft.entries.map(e => e.id)).toEqual([
			"default",
			"smol",
			"slow",
			"vision",
			"plan",
			"designer",
			"commit",
			"task",
			"custom1",
		]);
		expect(draft.entries[0]?.primary).toBe("");
		expect(draft.entries[0]?.fallbacks).toEqual(["prov/m1"]);
		const custom = draft.entries.at(-1);
		expect(custom?.primary).toBe("prov/m1");
		expect(custom?.fallbacks).toEqual(["prov/m2"]);
		expect(custom?.isNew).toBe(false);
	});

	it("uid 唯一且自增", () => {
		const draft = initRoleDraft({ a: { fallbacks: [] }, b: { fallbacks: [] } });
		const uids = draft.entries.map(e => e.uid);
		expect(new Set(uids).size).toBe(uids.length);
	});
});

describe("路由编辑操作（setPrimary / addFallback / removeFallback / moveFallback / seedRoute）", () => {
	it("setPrimary：更新目标条目且不改入参（不可变）", () => {
		const before = initRoleDraft({});
		const after = setPrimary(before, before.entries[0].uid, "prov/m1");
		expect(after.ok).toBe(true);
		if (!after.ok) return;
		expect(after.draft.entries[0]?.primary).toBe("prov/m1");
		expect(before.entries[0]?.primary).toBe("");
		expect(after.draft).not.toBe(before);
	});

	it("addFallback：trim 后追加；空白拒绝；重复项允许进入草稿（由校验标红）", () => {
		const draft = initRoleDraft({});
		const uid = draft.entries[0].uid;
		const empty = addFallback(draft, uid, "   ");
		expect(empty.ok).toBe(false);
		const once = addFallback(draft, uid, " prov/m1 ");
		if (!once.ok) throw new Error("expected ok");
		expect(once.draft.entries[0]?.fallbacks).toEqual(["prov/m1"]);
		const twice = addFallback(once.draft, uid, "prov/m1");
		if (!twice.ok) throw new Error("expected ok");
		expect(twice.draft.entries[0]?.fallbacks).toEqual(["prov/m1", "prov/m1"]);
	});

	it("removeFallback：删除指定项；越界返回错误且不改草稿", () => {
		const draft = initRoleDraft({});
		const uid = draft.entries[0].uid;
		const one = addFallback(draft, uid, "prov/m1");
		const two = addFallback(one.ok ? one.draft : draft, uid, "prov/m2");
		if (!two.ok) throw new Error("expected ok");
		const removed = removeFallback(two.draft, uid, 0);
		if (!removed.ok) throw new Error("expected ok");
		expect(removed.draft.entries[0]?.fallbacks).toEqual(["prov/m2"]);
		const oob = removeFallback(two.draft, uid, 5);
		expect(oob.ok).toBe(false);
		expect(oob.ok ? null : oob.error).toContain("越界");
	});

	it("moveFallback：拖拽与键盘共用；原位 / 越界为无变化", () => {
		const draft = initRoleDraft({});
		const uid = draft.entries[0].uid;
		const a = addFallback(draft, uid, "prov/m1");
		const b = addFallback(a.ok ? a.draft : draft, uid, "prov/m2");
		const c = addFallback(b.ok ? b.draft : draft, uid, "prov/m3");
		if (!c.ok) throw new Error("expected ok");
		const moved = moveFallback(c.draft, uid, 0, 2);
		if (!moved.ok) throw new Error("expected ok");
		expect(moved.draft.entries[0]?.fallbacks).toEqual(["prov/m2", "prov/m3", "prov/m1"]);
		const same = moveFallback(c.draft, uid, 1, 1);
		if (!same.ok) throw new Error("expected ok");
		expect(same.draft.entries[0]?.fallbacks).toEqual(["prov/m1", "prov/m2", "prov/m3"]);
		const oob = moveFallback(c.draft, uid, 0, 9);
		if (!oob.ok) throw new Error("expected ok");
		expect(oob.draft.entries[0]?.fallbacks).toEqual(["prov/m1", "prov/m2", "prov/m3"]);
	});

	it("seedRoute：以生效值一键预填（另一层带入）", () => {
		const draft = initRoleDraft({});
		const uid = draft.entries[0].uid;
		const seeded = seedRoute(draft, uid, { primary: "prov/m1", fallbacks: ["prov/m2"] });
		if (!seeded.ok) throw new Error("expected ok");
		expect(seeded.draft.entries[0]?.primary).toBe("prov/m1");
		expect(seeded.draft.entries[0]?.fallbacks).toEqual(["prov/m2"]);
	});
});

describe("自定义角色生命周期（addCustomRole / renameCustomRole / duplicateRole / deleteRole / resetRole）", () => {
	it("新增自定义角色：默认追加在末尾；重名拒绝（内置名 / 自定义名）", () => {
		const draft = initRoleDraft({});
		const ok = addCustomRole(draft, " reviewer ", "accent");
		expect(ok.ok).toBe(true);
		if (!ok.ok) return;
		expect(ok.draft.entries.at(-1)?.id).toBe("reviewer");
		expect(ok.draft.entries.at(-1)?.isNew).toBe(true);
		expect(ok.draft.entries.at(-1)?.color).toBe("accent");
		expect(ok.draft.nextUid).toBe(draft.nextUid + 1);
		expect(addCustomRole(ok.draft, "default", null).ok).toBe(false);
		expect(addCustomRole(ok.draft, "reviewer", null).ok).toBe(false);
		const blank = addCustomRole(ok.draft, "  ", null);
		expect(blank.ok).toBe(false);
	});

	it("重命名：改 id 保 baseId；内置拒绝；重名拒绝；改回原名合法", () => {
		const base: RoleRoutes = { reviewer: { primary: "prov/m1", fallbacks: [] } };
		const draft = initRoleDraft(base);
		const reviewer = draft.entries.at(-1);
		if (!reviewer) throw new Error("missing entry");
		const renamed = renameCustomRole(draft, reviewer.uid, "auditor");
		expect(renamed.ok).toBe(true);
		if (!renamed.ok) return;
		expect(renamed.draft.entries.at(-1)?.id).toBe("auditor");
		expect(renamed.draft.entries.at(-1)?.baseId).toBe("reviewer");
		const builtin = draft.entries[0];
		expect(renameCustomRole(draft, builtin.uid, "x").ok).toBe(false);
		const dup = renameCustomRole(renamed.draft, reviewer.uid, "default");
		expect(dup.ok).toBe(false);
		const back = renameCustomRole(renamed.draft, reviewer.uid, "reviewer");
		expect(back.ok).toBe(true);
	});

	it("复制：路由完整复制为新条目；重名拒绝", () => {
		const base: RoleRoutes = { reviewer: { primary: "prov/m1", fallbacks: ["prov/m2"] } };
		const draft = initRoleDraft(base);
		const reviewer = draft.entries.at(-1);
		if (!reviewer) throw new Error("missing entry");
		const copy = duplicateRole(draft, reviewer.uid, "reviewer-2");
		expect(copy.ok).toBe(true);
		if (!copy.ok) return;
		const copied = copy.draft.entries.at(-1);
		expect(copied?.id).toBe("reviewer-2");
		expect(copied?.isNew).toBe(true);
		expect(copied?.primary).toBe("prov/m1");
		expect(copied?.fallbacks).toEqual(["prov/m2"]);
		expect(copied?.baseId).toBeNull();
		expect(duplicateRole(copy.draft, reviewer.uid, "reviewer-2").ok).toBe(false);
	});

	it("删除：内置拒绝；自定义从草稿移除", () => {
		const base: RoleRoutes = { reviewer: { primary: "prov/m1", fallbacks: [] } };
		const draft = initRoleDraft(base);
		const builtin = draft.entries[0];
		expect(deleteRole(draft, builtin.uid).ok).toBe(false);
		const reviewer = draft.entries.at(-1);
		if (!reviewer) throw new Error("missing entry");
		const deleted = deleteRole(draft, reviewer.uid);
		expect(deleted.ok).toBe(true);
		if (!deleted.ok) return;
		expect(deleted.draft.entries.some(e => e.id === "reviewer")).toBe(false);
	});

	it("恢复已保存值：改动还原为基准；新增角色等价于移除", () => {
		const base: RoleRoutes = { reviewer: { primary: "prov/m1", fallbacks: ["prov/m2"] } };
		const draft = initRoleDraft(base);
		const reviewer = draft.entries.at(-1);
		if (!reviewer) throw new Error("missing entry");
		const modified = setPrimary(draft, reviewer.uid, "prov/m9");
		const restored = resetRole(modified.ok ? modified.draft : draft, reviewer.uid, base);
		expect(restored.ok).toBe(true);
		if (!restored.ok) return;
		expect(restored.draft.entries.at(-1)?.primary).toBe("prov/m1");
		expect(restored.draft.entries.at(-1)?.id).toBe("reviewer");
		const added = addCustomRole(draft, "temp", null);
		if (!added.ok) throw new Error("expected ok");
		const temp = added.draft.entries.at(-1);
		if (!temp) throw new Error("missing entry");
		const removed = resetRole(added.draft, temp.uid, base);
		expect(removed.ok).toBe(true);
		if (!removed.ok) return;
		expect(removed.draft.entries.some(e => e.id === "temp")).toBe(false);
	});
});

// ── 序列化与脏判定 ──

describe("序列化（serializeDraft）", () => {
	it("trim 主模型与回退项；primary 为空时省略键；空角色条目丢弃", () => {
		const base: RoleRoutes = {};
		const draft = initRoleDraft(base);
		const d1 = setPrimary(draft, draft.entries[0].uid, " prov/m1 ");
		const d2 = d1.ok ? addFallback(d1.draft, d1.draft.entries[0].uid, " prov/m2 ") : null;
		if (!d2?.ok) throw new Error("expected ok");
		const out = serializeDraft(d2.draft);
		expect(out.default).toEqual({ primary: "prov/m1", fallbacks: ["prov/m2"] });
		// 未配置的内置角色不写入
		expect(Object.keys(out)).toEqual(["default"]);
	});

	it("空 primary 但有回退：仅回退链形状（无 primary 键）", () => {
		const draft = initRoleDraft({});
		const uid = draft.entries[0].uid;
		const d = addFallback(draft, uid, "prov/m1");
		if (!d.ok) throw new Error("expected ok");
		const out = serializeDraft(d.draft);
		expect(out.default).toEqual({ fallbacks: ["prov/m1"] });
		expect("primary" in (out.default ?? {})).toBe(false);
	});

	it("改动后清空的角色序列化为缺席（等价移除）", () => {
		const base: RoleRoutes = { default: { primary: "prov/m1", fallbacks: [] } };
		const draft = initRoleDraft(base);
		const d = setPrimary(draft, draft.entries[0].uid, "");
		if (!d.ok) throw new Error("expected ok");
		expect(serializeDraft(d.draft)).toEqual({});
	});
});

describe("脏判定（isEntryDirty / isDraftDirty）", () => {
	it("与基准一致为干净；trim 差异不算改动；新角色恒为脏", () => {
		const base: RoleRoutes = { default: { primary: "prov/m1", fallbacks: ["prov/m2"] } };
		const draft = initRoleDraft(base);
		expect(isDraftDirty(draft, base)).toBe(false);
		const entry = draft.entries[0];
		expect(isEntryDirty(entry, base)).toBe(false);
		const spaced = setPrimary(draft, entry.uid, " prov/m1 ");
		expect(isDraftDirty(spaced.ok ? spaced.draft : draft, base)).toBe(false);
		const changed = setPrimary(draft, entry.uid, "prov/m9");
		expect(isDraftDirty(changed.ok ? changed.draft : draft, base)).toBe(true);
		const withNew = addCustomRole(draft, "temp", null);
		expect(isDraftDirty(withNew.ok ? withNew.draft : draft, base)).toBe(true);
	});
});

// ── diff 计算 ──

describe("diff 计算（computeRoutesDiff）", () => {
	it("新增 / 移除角色；移除时另一层仍有值给出回落层", () => {
		const base: RoleRoutes = { old: { primary: "prov/m1", fallbacks: [] } };
		const next: RoleRoutes = { fresh: { primary: "prov/m2", fallbacks: [] } };
		const diff = computeRoutesDiff(base, next, {
			scope: "global",
			routes: { old: { primary: "g/m", fallbacks: [] } },
		});
		const added = diff.find(d => d.role === "fresh");
		const removed = diff.find(d => d.role === "old");
		expect(added?.kind).toBe("added");
		expect(removed?.kind).toBe("removed");
		expect(removed?.otherLayer).toBe("global");
		const withoutOther = computeRoutesDiff(base, next);
		expect(withoutOther.find(d => d.role === "old")?.otherLayer).toBeUndefined();
	});

	it("主模型变更：旧→新逐字段", () => {
		const base: RoleRoutes = { default: { primary: "prov/m1", fallbacks: ["prov/m2"] } };
		const next: RoleRoutes = { default: { primary: "prov/m9", fallbacks: ["prov/m2"] } };
		const diff = computeRoutesDiff(base, next);
		expect(diff[0]?.kind).toBe("changed");
		expect(diff[0]?.primary).toEqual({ from: "prov/m1", to: "prov/m9" });
		expect(diff[0]?.fallbacks).toBeNull();
	});

	it("回退链增删与重排判定（多重集）", () => {
		const base: RoleRoutes = { default: { primary: "prov/m1", fallbacks: ["a", "b", "c"] } };
		const reordered: RoleRoutes = { default: { primary: "prov/m1", fallbacks: ["c", "a", "b"] } };
		const d1 = computeRoutesDiff(base, reordered)[0];
		expect(d1?.fallbacks?.reordered).toBe(true);
		expect(d1?.fallbacks?.added).toEqual([]);
		expect(d1?.fallbacks?.removed).toEqual([]);
		const withChange: RoleRoutes = { default: { primary: "prov/m1", fallbacks: ["b", "a", "d"] } };
		const d2 = computeRoutesDiff(base, withChange)[0];
		expect(d2?.fallbacks?.added).toEqual(["d"]);
		expect(d2?.fallbacks?.removed).toEqual(["c"]);
		// 相同多重集但顺序不变 → 无变更
		const same = computeRoutesDiff(base, { default: { primary: "prov/m1", fallbacks: ["a", "b", "c"] } })[0];
		expect(same?.kind).toBe("same");
	});

	it("顺序稳定：内置在前，自定义按基准键序 + 新增键序", () => {
		const base: RoleRoutes = { zebra: { fallbacks: [] }, default: { fallbacks: [] } };
		const next: RoleRoutes = { zebra: { fallbacks: [] }, default: { fallbacks: [] }, alpaca: { fallbacks: [] } };
		const roles = computeRoutesDiff(base, next).map(d => d.role);
		expect(roles).toEqual(["default", "zebra", "alpaca"]);
	});
});

// ── spec 校验（保存闸门）──

describe("spec 校验（checkSpec）", () => {
	it("格式：空 / 无 provider 段 / 无 modelId 段为 error", () => {
		expect(checkSpec("", CTX)?.severity).toBe("error");
		expect(checkSpec("noprovider", CTX)?.kind).toBe("malformed");
		expect(checkSpec("prov/", CTX)?.kind).toBe("malformed");
	});

	it("目录命中：available 为 null；未接入为 error；凭据失效 / 本地离线 / 目录非权威为 warning", () => {
		expect(checkSpec("prov/m1", CTX)).toBeNull();
		expect(checkSpec("prov/m2", CTX)?.kind).toBe("provider-not-configured");
		expect(checkSpec("prov/m2", CTX)?.severity).toBe("error");
		expect(checkSpec("prov/m3", CTX)?.kind).toBe("credential-invalid");
		expect(checkSpec("prov/m3", CTX)?.severity).toBe("warning");
		expect(checkSpec("local/lm", CTX)?.severity).toBe("warning");
		expect(checkSpec("stale/sm", CTX)?.severity).toBe("warning");
	});

	it("停用：模型级 / provider 级停用名单为 error（先于目录查询）", () => {
		const ctx = buildSpecCheckContext(catalogDto([catalogEntry({ provider: "prov", id: "m1", status: "disabled" })]));
		expect(checkSpec("prov/m1", { ...ctx, disabledModels: ["prov/m1"] })?.kind).toBe("disabled");
		expect(checkSpec("prov/m1", { ...ctx, disabledProviders: ["prov"] })?.kind).toBe("disabled");
	});

	it("目录不存在为 error；目录不可用降级为 warning（不阻断）", () => {
		expect(checkSpec("prov/unknown", CTX)?.kind).toBe("not-in-catalog");
		expect(checkSpec("prov/unknown", CTX)?.severity).toBe("error");
		expect(checkSpec("prov/m1", NO_CATALOG_CTX)?.kind).toBe("unverifiable");
		expect(checkSpec("prov/m1", NO_CATALOG_CTX)?.severity).toBe("warning");
	});

	it("思考级别后缀剥离（目录查找用），非级别后缀保留", () => {
		expect(stripThinkingSuffix("m1:high")).toBe("m1");
		expect(stripThinkingSuffix("m1")).toBe("m1");
		expect(stripThinkingSuffix("m1:custom-thing")).toBe("m1:custom-thing");
		expect(checkSpec("prov/m1:high", CTX)).toBeNull();
	});

	it("parseModelSpec：首个 / 切分；边界拒绝", () => {
		expect(parseModelSpec("prov/m1")).toEqual({ provider: "prov", modelId: "m1" });
		expect(parseModelSpec("prov/ns/m1")).toEqual({ provider: "prov", modelId: "ns/m1" });
		expect(parseModelSpec("/m1")).toBeNull();
		expect(parseModelSpec("prov/")).toBeNull();
	});
});

describe("路由与草稿校验（validateRoute / validateDraft）", () => {
	it("重复模型：与主模型重复的回退项、重复回退项均标红（error），首个出现不标", () => {
		const issues = validateRoute({ primary: "prov/m1", fallbacks: ["prov/m1", "prov/m2", "prov/m2"] }, CTX);
		const dupIssues = issues.filter(i => i.kind === "duplicate");
		expect(dupIssues).toHaveLength(2);
		expect(dupIssues.every(i => i.severity === "error")).toBe(true);
		expect(dupIssues.map(i => i.index)).toEqual([0, 2]);
	});

	it("逐 spec 校验结果映射到字段位置", () => {
		const issues = validateRoute({ primary: "prov/m2", fallbacks: ["prov/m3"] }, CTX);
		expect(issues).toHaveLength(2);
		expect(issues[0]?.field).toBe("primary");
		expect(issues[0]?.severity).toBe("error");
		expect(issues[1]?.field).toBe("fallback");
		expect(issues[1]?.severity).toBe("warning");
	});

	it("保存闸门：error 阻止保存；仅 warning 不阻止", () => {
		const blocked = initRoleDraft({});
		const d1 = setPrimary(blocked, blocked.entries[0].uid, "prov/unknown");
		const v1 = validateDraft(d1.ok ? d1.draft : blocked, CTX);
		expect(v1.blocked).toBe(true);
		expect(v1.errorCount).toBeGreaterThan(0);
		const warned = initRoleDraft({});
		const d2 = setPrimary(warned, warned.entries[0].uid, "prov/m3");
		const v2 = validateDraft(d2.ok ? d2.draft : warned, CTX);
		expect(v2.blocked).toBe(false);
		expect(v2.warningCount).toBeGreaterThan(0);
	});

	it("空 primary 但有回退：允许保存并标记 fallbackOnly（仅回退链生效）", () => {
		const draft = initRoleDraft({});
		const uid = draft.entries[0].uid;
		const d = addFallback(draft, uid, "prov/m1");
		const v = validateDraft(d.ok ? d.draft : draft, CTX);
		expect(v.blocked).toBe(false);
		expect(v.perEntry[0]?.fallbackOnly).toBe(true);
	});

	it("新增角色未配置任何模型：阻止保存（emptyNew）；已有角色清空不阻止（序列化为移除）", () => {
		const withNew = addCustomRole(initRoleDraft({}), "temp", null);
		if (!withNew.ok) throw new Error("expected ok");
		const v1 = validateDraft(withNew.draft, CTX);
		expect(v1.blocked).toBe(true);
		const temp = withNew.draft.entries.at(-1);
		expect(v1.perEntry.find(p => p.uid === temp?.uid)?.emptyNew).toBe(true);
		const base: RoleRoutes = { default: { primary: "prov/m1", fallbacks: [] } };
		const cleared = setPrimary(initRoleDraft(base), initRoleDraft(base).entries[0].uid, "");
		const v2 = validateDraft(cleared.ok ? cleared.draft : initRoleDraft(base), CTX);
		expect(v2.blocked).toBe(false);
	});

	it("角色重名：重命名冲突在操作层拒绝；草稿中重名（如从存储恢复的损坏草稿）由校验闸门拦截", () => {
		const base: RoleRoutes = { dup: { primary: "prov/m1", fallbacks: [] } };
		const draft = initRoleDraft(base);
		const added = addCustomRole(draft, "dup2", null);
		if (!added.ok) throw new Error("expected ok");
		const dupEntry = added.draft.entries.at(-1);
		if (!dupEntry) throw new Error("missing entry");
		const rejected = renameCustomRole(added.draft, dupEntry.uid, "dup");
		expect(rejected.ok).toBe(false);
		// 损坏草稿（重复 id，如存储恢复路径）→ nameError 阻止保存
		const corrupted = {
			entries: [...added.draft.entries, { ...dupEntry, id: "dup" }],
			nextUid: added.draft.nextUid,
		};
		const v = validateDraft(corrupted, CTX);
		expect(v.blocked).toBe(true);
		expect(v.perEntry.some(p => p.nameError?.includes("已存在"))).toBe(true);
	});
});

// ── 草稿持久化（sessionStorage 载荷）──

describe("草稿持久化编解码（encodeDraft / decodeDraft / draftFingerprint）", () => {
	it("编解码往返还原草稿", () => {
		const base: RoleRoutes = { default: { primary: "prov/m1", fallbacks: [] } };
		const d0 = initRoleDraft(base);
		const d1 = addCustomRole(d0, "temp", "accent");
		if (!d1.ok) throw new Error("expected ok");
		const tempUid = d1.draft.entries.at(-1)?.uid;
		const d2 = setPrimary(d1.draft, tempUid ?? 0, "prov/m2");
		if (!d2.ok) throw new Error("expected ok");
		const stored = encodeDraft(d2.draft, "project", base);
		expect(stored.writeTarget).toBe("project");
		expect(stored.baseFingerprint).toBe(draftFingerprint(base));
		const restored = decodeDraft(JSON.stringify(stored), "project", base);
		expect(restored).not.toBeNull();
		expect(restored?.entries.at(-1)?.id).toBe("temp");
		expect(restored?.entries.at(-1)?.color).toBe("accent");
		expect(restored?.entries.at(-1)?.primary).toBe("prov/m2");
		expect(restored?.nextUid).toBe(d2.draft.nextUid);
	});

	it("作用域不匹配 / 指纹不匹配 / 非法 JSON / 形状非法 → null（丢弃过期草稿）", () => {
		const base: RoleRoutes = {};
		const stored = encodeDraft(initRoleDraft(base), "global", base);
		expect(decodeDraft(JSON.stringify(stored), "project", base)).toBeNull();
		expect(decodeDraft(JSON.stringify(stored), "global", { other: { fallbacks: [] } })).toBeNull();
		expect(decodeDraft("not json", "global", base)).toBeNull();
		expect(decodeDraft("[]", "global", base)).toBeNull();
		const bad = { ...stored, entries: [{ uid: "x", id: "", fallbacks: "no" }] };
		expect(decodeDraft(JSON.stringify(bad), "global", base)).toBeNull();
	});

	it("持久化键按作用域分键", () => {
		expect(draftStorageKey("global")).not.toBe(draftStorageKey("project"));
		expect(draftStorageKey("global")).toContain("global");
	});
});

// ── modelTags 展示元数据 ──

describe("modelTags 变更计算（computeTagsChanges）与角色展示（roleDisplayMeta）", () => {
	it("新增角色颜色写入；无变更返回 null", () => {
		const draft = initRoleDraft({});
		const added = addCustomRole(draft, "temp", "accent");
		if (!added.ok) throw new Error("expected ok");
		const change = computeTagsChanges(added.draft, {});
		expect(change?.tags.temp?.color).toBe("accent");
		expect(change?.summary.join("")).toContain("accent");
		expect(computeTagsChanges(draft, {})).toBeNull();
		expect(computeTagsChanges(added.draft, { temp: { color: "accent" } })).toBeNull();
	});

	it("重命名移动元数据；删除角色移除元数据；内置条目不触碰", () => {
		const base: RoleTags = { old: { color: "accent" }, gone: { color: "warning" }, default: { color: "success" } };
		const baseRoutes: RoleRoutes = {
			old: { primary: "prov/m1", fallbacks: [] },
			gone: { primary: "prov/m1", fallbacks: [] },
		};
		const d0 = initRoleDraft(baseRoutes);
		const old = d0.entries.find(e => e.id === "old");
		const gone = d0.entries.find(e => e.id === "gone");
		if (!old || !gone) throw new Error("missing entries");
		const renamed = renameCustomRole(d0, old.uid, "new");
		if (!renamed.ok) throw new Error("expected ok");
		const deleted = deleteRole(renamed.draft, gone.uid);
		if (!deleted.ok) throw new Error("expected ok");
		const change = computeTagsChanges(deleted.draft, base);
		expect(change?.tags.new?.color).toBe("accent");
		expect(change?.tags.old).toBeUndefined();
		expect(change?.tags.gone).toBeUndefined();
		expect(change?.tags.default?.color).toBe("success");
		expect(change?.summary.join("")).toContain("old → new");
		expect(change?.summary.join("")).toContain("gone");
	});

	it("roleDisplayMeta：内置标签 / modelTags 覆盖 / 自定义回落角色 id；非法色回落 null", () => {
		expect(roleDisplayMeta("default", {})).toMatchObject({
			name: "默认",
			tag: "DEFAULT",
			color: "success",
			builtin: true,
		});
		expect(roleDisplayMeta("default", { default: { name: "MyDefault", color: "error" } })).toMatchObject({
			name: "MyDefault",
			color: "error",
		});
		expect(roleDisplayMeta("custom", {})).toMatchObject({ name: "custom", color: null, builtin: false });
		expect(roleDisplayMeta("custom", { custom: { name: "自审", color: "not-a-color" } })).toMatchObject({
			name: "自审",
			color: null,
		});
	});
});

// ── 取值容错解析与列表视图 ──

describe("取值容错解析（normalizeRoutesValue / normalizeTagsValue）", () => {
	it("非法形状返回空对象；空路由丢弃；trim 规整", () => {
		expect(normalizeRoutesValue(null)).toEqual({});
		expect(normalizeRoutesValue("x")).toEqual({});
		expect(normalizeRoutesValue([])).toEqual({});
		expect(normalizeRoutesValue({ a: "not-an-object", b: { primary: " p/m ", fallbacks: [" x ", 5, ""] } })).toEqual({
			b: { primary: "p/m", fallbacks: ["x"] },
		});
		expect(normalizeRoutesValue({ c: { fallbacks: [] } })).toEqual({});
		expect(normalizeTagsValue({ a: { name: " n ", color: " accent " }, b: "x" })).toEqual({
			a: { name: "n", color: "accent" },
		});
	});
});

describe("角色列表视图（toRoleListItems）", () => {
	it("键为各层并集（内置固定在前）；来源 / 是否在写入目标 / 失效状态正确", () => {
		const projectValue: RoleRoutes = {
			default: { primary: "prov/m1", fallbacks: [] },
			projOnly: { primary: "prov/m2", fallbacks: [] },
		};
		const globalValue: RoleRoutes = {
			smol: { primary: "prov/m3", fallbacks: ["prov/unknown"] },
			globOnly: { fallbacks: [] },
		};
		const effective = { ...globalValue, ...projectValue, smol: globalValue.smol };
		const items = toRoleListItems(effective, projectValue, globalValue, "project", CTX);
		expect(items.map(i => i.role)).toEqual([
			"default",
			"smol",
			"slow",
			"vision",
			"plan",
			"designer",
			"commit",
			"task",
			"globOnly",
			"projOnly",
		]);
		const def = items.find(i => i.role === "default");
		const smol = items.find(i => i.role === "smol");
		const proj = items.find(i => i.role === "projOnly");
		const glob = items.find(i => i.role === "globOnly");
		const unset = items.find(i => i.role === "slow");
		expect(def).toMatchObject({
			provenance: "project",
			inTargetScope: true,
			primary: "prov/m1",
			fallbackCount: 0,
			health: { severity: "ok" },
		});
		expect(smol).toMatchObject({ provenance: "global", inTargetScope: false, health: { severity: "error" } });
		expect(smol?.health.messages.join("")).toContain("不存在");
		expect(proj).toMatchObject({ provenance: "project", inTargetScope: true });
		expect(glob).toMatchObject({ provenance: "global", inTargetScope: false, fallbackCount: 0 });
		expect(unset).toMatchObject({ provenance: "unset", inTargetScope: false, primary: "" });
	});
});

// ── 保存文案 ──

describe("保存结果文案（describeRoleSave）", () => {
	it("作用域 + 路径 + 变更数；部分失败如实追加", () => {
		const ok = describeRoleSave({
			scope: "global",
			scopePath: "/agents/config.yml",
			changedCount: 3,
			tagsWritten: false,
		});
		expect(ok).toContain("全局配置");
		expect(ok).toContain("/agents/config.yml");
		expect(ok).toContain("3 个角色");
		const project = describeRoleSave({ scope: "project", changedCount: 1, tagsWritten: true });
		expect(project).toContain("项目配置");
		expect(project).toContain(".cornfield/config.yml");
		expect(project).toContain("modelTags");
		const tagsFail = describeRoleSave({
			scope: "global",
			changedCount: 1,
			tagsWritten: true,
			tagsError: "disk full",
		});
		expect(tagsFail).toContain("颜色元数据");
		expect(tagsFail).toContain("disk full");
		expect(tagsFail).toContain("已生效");
		const refreshFail = describeRoleSave({
			scope: "global",
			changedCount: 1,
			tagsWritten: false,
			refreshError: "timeout",
		});
		expect(refreshFail).toContain("刷新");
		expect(refreshFail).toContain("timeout");
	});
});

// ── 语义守卫：确保导出的辅助无残留占位实现 ──

describe("语义守卫", () => {
	it("validateRoleId：排除自身 uid（重命名场景）", () => {
		const draft = initRoleDraft({});
		const selfExcluded = validateRoleId(draft, "default", draft.entries[0].uid);
		expect(selfExcluded).toBeNull();
		const conflicting = validateRoleId(draft, "default");
		expect(conflicting).toContain("已存在");
	});
});
