/**
 * Skills 工作台的 scope 投影（WP10 · T10B）。
 *
 * 页面要回答五个问题，每一个都必须来自既有事实源 —— 这里不建第二套技能登记表，
 * 也不重跑一次 discovery 去猜运行时状态：
 *
 * 范围 scope       ← SKILL.md 路径相对 agentDir / 会话 Project root 的位置
 *                      （判定规则在 `@cornfield/wire` 的 `classifyScope` —— 与 composer 的上下文
 *                      条目共用同一份；本模块只把 serve 侧的锚点与包含判定 pathIsWithin 递进去）
 *   来源 source      ← discovery 的 `provider:level`（`Skill.source`，与运行时同一份）
 *   版本 version     ← frontmatter 声明（多数技能没有）+ 内容指纹 + mtime（文件系统真相）
 *   激活 activation  ← session.skills（本次会话真的加载了）/ settings 停用名单 / 发现警告
 *   错误 errors      ← session.skillWarnings（解析失败、同名冲突、扫描失败）
 *
 * 版本为什么不是一个字段：`docs/skills/telemetry.md` §4.1 已验证大量 skill 的 frontmatter
 * **没有** version 字段且写法不统一。所以「版本」拆成三个独立事实：声明的 version（可能没有）、
 * 内容指纹（sha256 前 8 位，任何文件都有）、mtime。把指纹冒充成版本号才是假数据。
 *
 * 失败模型：SKILL.md 读不到 ≠ 「这个技能没有版本」。读失败 → status "unavailable" 且原因
 * 进 errors —— 不能让页面把「读坏了」显示成「没标版本」。
 *
 * 输出形状由 `@cornfield/wire` 拥有（`results/skills.ts`）：本模块是唯一生产者，不另立一份同形接口 ——
 * 两端（serve / web-app）都从 wire 引入，接口漂移在编译期就暴露。
 */

import * as path from "node:path";
import { isEnoent, parseFrontmatter, pathIsWithin } from "@cornfield/utils";
import { classifyScope, type SkillBlockedDto, type SkillLoadErrorDto, type SkillScopeRowDto } from "@cornfield/wire";
import type { Skill, SkillWarning } from "../extensibility/skills";

/**
 * 范围判定的依据（全部是绝对路径；两个根都由调用方按 Agent/Project 解析后传入）。
 * 三个路径锚点正是 wire `ScopeAnchors` 要的全部输入（多出的 `agentId` 是「查的是谁的技能」，
 * 不参与路径判定），所以本对象结构上满足 `ScopeAnchors`，直接递给 `classifyScope`。
 * 与 wire 的 `SkillScopeFactsDto` 不同：那个是**响应里**回给客户端的锚点（带 projectError），
 * 这个是判定**输入**。
 */
export interface SkillScopeAnchor {
	/** 被查询的 Agent（default = 进程自身的会话）。 */
	agentId: string;
	/** Agent 的物理 home；default agent 用 getAgentDir()（meta.agentDir 在 default 上是 cwd，不是家）。 */
	agentDir: string;
	/** 会话 cwd（未 attach 的 agent：调用方传 agentDir —— 它就是那个 agent 的会话根）。 */
	sessionCwd: string;
	/** 会话所属 Project 的 root（未归属 = undefined）。 */
	projectRoot?: string;
}

/** 从 SKILL.md 读到的事实。 */
export interface SkillFileFacts {
	path: string;
	/** frontmatter 声明（缺省 = 没声明，不是「空字符串」）。 */
	description?: string;
	version?: string;
	deprecated: boolean;
	/** 内容 sha256 前 8 位（文件系统真相，与版本声明无关）。 */
	fingerprint: string;
	/** mtimeMs。 */
	updatedAt: number;
}

/** 读 SKILL.md 的事实（不存在/读不了返回 error，由调用方决定是 unavailable 还是跳过）。 */
export async function readSkillFileFacts(filePath: string): Promise<SkillFileFacts | { error: string }> {
	let content: string;
	let updatedAt: number;
	try {
		const file = Bun.file(filePath);
		content = await file.text();
		updatedAt = (await file.stat()).mtimeMs;
	} catch (err) {
		if (isEnoent(err)) return { error: `SKILL.md 不存在：${filePath}` };
		return { error: `SKILL.md 读取失败：${err instanceof Error ? err.message : String(err)}` };
	}
	const { frontmatter } = parseFrontmatter(content, { source: filePath });
	const declared = frontmatter.version;
	const facts: SkillFileFacts = {
		path: filePath,
		deprecated: frontmatter.deprecated === true,
		fingerprint: new Bun.CryptoHasher("sha256").update(content).digest("hex").slice(0, 8),
		// mtimeMs 在 macOS 上是小数毫秒：除成整数，与库里其它时间戳同一形状。
		updatedAt: Math.floor(updatedAt),
	};
	const description = frontmatter.description;
	if (typeof description === "string" && description.length > 0) facts.description = description;
	if (typeof declared === "string" && declared.trim().length > 0) facts.version = declared.trim();
	return facts;
}

/** 已加载技能 → 行（activation 恒为 loaded：它就是 session.skills 的同源投影）。 */
export async function projectLoadedSkills(
	anchor: SkillScopeAnchor,
	skills: readonly Skill[],
): Promise<{ rows: SkillScopeRowDto[]; errors: SkillLoadErrorDto[] }> {
	const rows: SkillScopeRowDto[] = [];
	const errors: SkillLoadErrorDto[] = [];
	for (const skill of skills) {
		const filePath = skill.filePath;
		const row: SkillScopeRowDto = {
			name: skill.name,
			description: skill.description,
			source: skill.source,
			level: skill._source?.level ?? "native",
			provider: skill._source?.provider ?? "native",
			path: filePath,
			scope: classifyScope(filePath, anchor, pathIsWithin),
			activation: "loaded",
			status: "enabled",
		};
		if (skill._source?.providerName) row.providerName = skill._source.providerName;
		const fileFacts = await readSkillFileFacts(filePath);
		if ("error" in fileFacts) {
			// 加载进来了但文件读不到（刚被删/权限）——不猜版本，标 unavailable 并报原因。
			row.status = "unavailable";
			row.reason = fileFacts.error;
			errors.push({ path: filePath, message: fileFacts.error });
		} else {
			if (fileFacts.version) row.version = fileFacts.version;
			row.fingerprint = fileFacts.fingerprint;
			row.updatedAt = fileFacts.updatedAt;
			if (fileFacts.deprecated) row.status = "deprecated";
		}
		rows.push(row);
	}
	return { rows, errors };
}

/**
 * 按名字在既有发现根里找 SKILL.md（停用名单只有名字，没有路径）。
 * 候选顺序 = 发现顺序，且带上 discovery 会给这个目录的 `provider:level`：
 * agentDir/skills（native user 级）→ agentDir/.cornfield/skills → 会话 cwd 的 .cornfield/skills（都是 project 级）。
 */
export function skillPathCandidates(
	name: string,
	anchor: SkillScopeAnchor,
): Array<{ path: string; level: "user" | "project" }> {
	return [
		{ path: path.join(anchor.agentDir, "skills", name, "SKILL.md"), level: "user" },
		{ path: path.join(anchor.agentDir, ".cornfield", "skills", name, "SKILL.md"), level: "project" },
		{ path: path.join(anchor.sessionCwd, ".cornfield", "skills", name, "SKILL.md"), level: "project" },
	];
}

export interface DisabledSkillInput {
	name: string;
	/** 停用来源（settings 键名），进 reason，可区分「名单停用」与「扩展停用」。 */
	reason: string;
}

/**
 * 停用名单 → 行。
 *
 * 停用项可能根本不存在于磁盘（名单里留了个已删技能的名字）：那时 status 是 unavailable，
 * 不是 disabled —— 「停用」是它对设置的服从，「不存在」是它的事实，两者不能合并成一个词。
 */
export async function projectDisabledSkills(
	anchor: SkillScopeAnchor,
	disabled: readonly DisabledSkillInput[],
): Promise<SkillScopeRowDto[]> {
	const rows: SkillScopeRowDto[] = [];
	for (const item of disabled) {
		const candidates = skillPathCandidates(item.name, anchor);
		let fileFacts: SkillFileFacts | undefined;
		let resolved: { path: string; level: "user" | "project" } | undefined;
		for (const candidate of candidates) {
			const read = await readSkillFileFacts(candidate.path);
			if (!("error" in read)) {
				fileFacts = read;
				resolved = candidate;
				break;
			}
		}
		const target = resolved ?? candidates[0];
		const row: SkillScopeRowDto = {
			name: item.name,
			description: fileFacts?.description ?? "",
			source: `native:${target.level}`,
			level: target.level,
			provider: "native",
			path: target.path,
			scope: classifyScope(target.path, anchor, pathIsWithin),
			activation: "discoverable",
			status: "disabled",
			reason: item.reason,
		};
		if (!resolved) {
			// 名字在名单里、磁盘上没有：它对设置是「停用」，对磁盘是「不存在」，两个事实都要留。
			row.status = "unavailable";
			row.reason = `${item.reason}；磁盘上找不到它的 SKILL.md`;
		} else if (fileFacts) {
			row.fingerprint = fileFacts.fingerprint;
			row.updatedAt = fileFacts.updatedAt;
			if (fileFacts.version) row.version = fileFacts.version;
			if (fileFacts.deprecated) row.status = "deprecated";
		}
		rows.push(row);
	}
	return rows;
}

/** 发现警告分流：带技能路径的 = 某个具体技能被挡住；不带的 = 扫描级失败。 */
export function splitSkillWarnings(warnings: readonly SkillWarning[]): {
	blocked: SkillBlockedDto[];
	errors: SkillLoadErrorDto[];
} {
	const blocked: SkillBlockedDto[] = [];
	const errors: SkillLoadErrorDto[] = [];
	for (const warning of warnings) {
		if (warning.skillPath.length === 0) {
			errors.push({ path: "", message: warning.message });
			continue;
		}
		blocked.push({
			name: path.basename(path.dirname(warning.skillPath)),
			path: warning.skillPath,
			reason: warning.message,
		});
	}
	return { blocked, errors };
}

/** 把停用名单（settings 两个键）规范成停用输入；扩展停用的 `skill:` 前缀在这里剥掉。 */
export function collectDisabledInputs(
	ignoredSkills: readonly string[],
	disabledExtensions: readonly string[],
): DisabledSkillInput[] {
	const inputs: DisabledSkillInput[] = [];
	const seen = new Set<string>();
	for (const name of ignoredSkills) {
		if (seen.has(name)) continue;
		seen.add(name);
		inputs.push({ name, reason: "settings.skills.ignoredSkills" });
	}
	for (const id of disabledExtensions) {
		if (!id.startsWith("skill:")) continue;
		const name = id.slice("skill:".length);
		if (name.length === 0 || seen.has(name)) continue;
		seen.add(name);
		inputs.push({ name, reason: "settings.disabledExtensions" });
	}
	return inputs;
}
