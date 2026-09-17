import type { ProjectRecordDto, SessionProjectSourceDto } from "./pi-client-api";

/**
 * Project 的**读模型** —— 全应用唯一一份「关于 Project，我们现在知道什么」的判据。
 *
 * 这不是一个 store，也不做 I/O：入参是渲染已经有的事实（`SessionView` 结构上就满足它），
 * 出参是**能说出口的话**。chip、新建表单、用量面板三处曾经各写一份，于是三处对同一个
 * 「还没读到」给出了三种不同的说法 —— 这里收口成一份，各处只负责把状态画成自己的样子。
 *
 * 两条纪律贯穿全篇，任何一处折叠都会造成同一类错误：
 *
 *   1. **「读不到」不是「没有」**。registry 读失败、还没读到、没连上，都只能得出「不知道」；
 *      把它渲染成「未声明 / 未归属 / 没有 Project」就是替一个尚未得到的答案发言 —— 用户会
 *      据此以为自己的项目或归属真的不存在。
 *   2. **「会话在哪」与「我要在哪干活」是两件事**。前者是 serve 的读数（`currentProjectId`，
 *      且它自带来源：会话记下的 / 按目录匹配算出的），后者是客户端的选择
 *      （`workingProjectId`）。两者各有各的状态机，谁也不许拿对方顶替。
 *
 * 两个问题各有各的入口，不合成一个：**名单**读到哪一步（`projectRegistryState`，选择器用），
 * 与**归属**有没有算出来（`sessionAttributionOf`，读数用）。切会话只影响后者。
 */

/** 渲染 Project 相关的全部事实。`SessionView` 满足它，测试也可以只造够用的字段。 */
export interface ProjectFacts {
	connected: boolean;
	/** 已声明的 Project；`undefined` = 还没读到（与 `[]` = 读到了、确实没有，不是一回事）。 */
	projects?: ProjectRecordDto[];
	/** 当前会话的归属还没算出来（切会话后的窗口期 / 还没读过）—— 与「未归属」是两件事。 */
	projectsPending?: boolean;
	/** registry 读不出来的原文（存储损坏 / 版本不符）。读失败 ≠ 没声明过。 */
	projectsError?: string;
	/** 当前会话的权威归属（serve 的 `list_projects` 读数）。 */
	currentProjectId?: string;
	/** 上面那个归属的来源；缺省 = 没问过（没有会话可查）。 */
	currentProjectSource?: SessionProjectSourceDto;
	/** 工作上下文选中的 Project（客户端选择，不是 serve 的读数）。 */
	workingProjectId?: string;
}

/**
 * 「已声明的 Project 名单」现在读到哪一步 —— 所有 Project 显示面共用的第一问。
 *
 * 它问的是**名单**，不是归属：`projectsPending`（归属正在重算）不影响这个判据 —— 手上那份名单
 * 是上一次真读到的，而「归属重算完了没有」是另一件事（`sessionAttributionOf`）。把两者混在一个
 * 状态里，会让切会话的那一瞬间顶栏的工作上下文选择器莫名变成「读取中」。
 */
export type ProjectRegistryState =
	| { kind: "disconnected" }
	| { kind: "error"; message: string }
	| { kind: "unread" }
	| { kind: "empty" }
	| { kind: "ready"; projects: ProjectRecordDto[] };

export function projectRegistryState(facts: ProjectFacts): ProjectRegistryState {
	if (!facts.connected) return { kind: "disconnected" };
	if (facts.projectsError !== undefined) return { kind: "error", message: facts.projectsError };
	if (facts.projects === undefined) return { kind: "unread" };
	if (facts.projects.length === 0) return { kind: "empty" };
	return { kind: "ready", projects: facts.projects };
}

/**
 * 当前**会话**属于哪个 Project —— serve 的权威读数，连同它的可信度来源。
 *
 * `unknown` 与 `none` 必须分开：前者是「没问到」（registry 读不到 / serve 没被问过），
 * 后者是「问了，确实没有任何东西声明过归属」。把前者说成后者，就是在替 serve 回答一个
 * 它还没回答的问题。
 */
export type SessionAttribution =
	| { kind: "unknown" }
	| { kind: "none" }
	| { kind: "unlisted"; projectId: string }
	| { kind: "attributed"; projectId: string; project: ProjectRecordDto; from: "session" | "cwd" };

export function sessionAttributionOf(facts: ProjectFacts): SessionAttribution {
	const registry = projectRegistryState(facts);
	// 只有**读不到**时才答不上来：读到一份空名单也是一个确定的答案（里面确实没有别的 Project），
	// 归属该是什么就是什么（`none` / `unlisted`），不因为名单空就退成「不知道」。
	if (registry.kind !== "ready" && registry.kind !== "empty") return { kind: "unknown" };
	const declared = registry.kind === "ready" ? registry.projects : [];
	const projectId = facts.currentProjectId;
	if (projectId === undefined) {
		return facts.currentProjectSource === undefined ? { kind: "unknown" } : { kind: "none" };
	}
	const project = declared.find(item => item.projectId === projectId);
	if (!project) return { kind: "unlisted", projectId };
	// 来源缺省时按 **cwd** 报：`"session"` 是「会话记录里的事实」，缺了来源就无从证明它是，
	// 高报可信度比低报危险。
	return {
		kind: "attributed",
		projectId,
		project,
		from: facts.currentProjectSource === "session" ? "session" : "cwd",
	};
}

/**
 * 归属来源的人话（顶栏面板与用量面板共用一份，免得同一个来源在两处叫两个名字）。
 *
 * 来源必须能被用户看见：会话记录里的事实与按目录猜出来的答案不是一个可信度。
 */
export function attributionSourceLabel(from: "session" | "cwd"): string {
	return from === "session" ? "会话记录" : "按目录匹配（旧会话回落）";
}

/**
 * 会话归属的三段文案（短标签 / 悬停说明 / 一行细节）—— 首页上下文条、顶栏面板共用一份。
 *
 * 三段的措辞就是「不拿未知当没有」这条纪律的可见形式：`unknown` 说「归属未知」、`none` 才说
 * 「未归属」，两者在任何一处都不许合写成同一句话。
 */
export function attributionTextOf(attribution: SessionAttribution): {
	label: string;
	title: string;
	detail: string;
} {
	switch (attribution.kind) {
		case "unknown":
			return {
				label: "归属未知",
				title: "registry 还没读到 / serve 还没被问过 —— 这不是「未归属」",
				detail: "读不到 registry / 还没问过 —— 不知道它属于谁（不是「未归属」）",
			};
		case "none":
			return {
				label: "未归属",
				title: "serve 查过：没有任何东西声明过这个会话的归属",
				detail: "serve 说没有任何东西声明过它（source: none）",
			};
		case "unlisted":
			return {
				label: `${attribution.projectId}（注册表里找不到）`,
				title: `归属指向的 projectId 在注册表里不存在：${attribution.projectId}`,
				detail: "归属指向的 projectId 不在已声明清单里",
			};
		case "attributed":
			return {
				label: attribution.project.name,
				title: `${attribution.project.name} · ${attribution.project.root}`,
				detail: `来源：${attributionSourceLabel(attribution.from)}`,
			};
	}
}

/**
 * **工作上下文**选中的 Project（客户端选择：「接下来建的会话落在哪」）。
 *
 * `unresolved` 与 `stale` 必须分开：前者是 registry 还没读到，所以**判不出**选中的那个还在不在；
 * 后者是**读到了**、里面确实没有它。把前者说成「已不在注册表」就是替一次还没回来的读取下结论。
 */
export type WorkingProject =
	| { kind: "none" }
	| { kind: "unresolved"; projectId: string }
	| { kind: "stale"; projectId: string }
	| { kind: "set"; projectId: string; project: ProjectRecordDto };

export function workingProjectOf(facts: ProjectFacts): WorkingProject {
	const projectId = facts.workingProjectId;
	if (projectId === undefined || projectId === "") return { kind: "none" };
	if (facts.projects === undefined) return { kind: "unresolved", projectId };
	const project = facts.projects.find(item => item.projectId === projectId);
	return project ? { kind: "set", projectId, project } : { kind: "stale", projectId };
}

/**
 * 顶栏 chip 的短标签 —— 它显示的是**工作上下文**（下次新会话落在哪），不是当前会话的归属：
 * chip 是一个选择器（agent-hub §4「从只读标签升级为项目选择器」），一个显示别的东西的选择器
 * 会让人以为切换没生效。当前会话在哪，面板里单独一行说。
 */
export function projectLabelOf(facts: ProjectFacts): { label: string; title: string } {
	const registry = projectRegistryState(facts);
	const working = workingProjectOf(facts);
	switch (registry.kind) {
		case "disconnected":
			return { label: "未连接", title: "未连接——Project registry 不可用，工作上下文无从选择" };
		case "error":
			return { label: "读取失败", title: `Project registry 读不出来：${registry.message}` };
		case "unread":
			return {
				label: "…",
				title:
					working.kind === "unresolved"
						? `Project registry 读取中——工作上下文选了 ${working.projectId}，此刻判不出它还在不在`
						: "Project registry 读取中",
			};
		case "empty":
			// 读到了空名单：确实没声明过任何 Project。但若选择器里选过一个，那个选择现在也是陈旧的 ——
			// 「没声明过」不能把「你选的那个已经没了」吃掉。
			if (working.kind === "stale") {
				return {
					label: `${working.projectId}（已不在注册表）`,
					title: `没声明过任何 Project；工作上下文选中的 ${working.projectId} 已不在注册表里`,
				};
			}
			return { label: "未声明", title: "还没有声明任何 Project（~/.cornfield/agent/projects.json）" };
		case "ready":
			break;
	}
	if (working.kind === "set") {
		return { label: working.project.name, title: `工作上下文：${working.project.name} · ${working.project.root}` };
	}
	if (working.kind === "stale") {
		return {
			label: `${working.projectId}（已不在注册表）`,
			title: `工作上下文选中的 Project 已不在注册表里：${working.projectId}——新会话不会落在它上面`,
		};
	}
	if (working.kind === "unresolved") {
		// `projects` 没读到就判不出选中的那个还在不在 —— 绝不先说它没了。
		return { label: "…", title: `工作上下文选了 ${working.projectId}，但 registry 还没读到——判不出它还在不在` };
	}
	return {
		label: "不指定",
		title: `工作上下文：不指定（新会话不声明归属，落在 serve 的启动根）；已声明 ${registry.projects.length} 个 Project`,
	};
}

/**
 * 新建会话表单的 Project 字段状态 —— 同一份 registry 判据的第五种画法。
 *
 * `undeclared` 与 `error` / `pending` / `disconnected` 必须分开：只有**真的读到过**一个空名单，
 * 才能说「还没声明过任何 Project」。
 */
export type ProjectFieldState =
	| { kind: "disconnected" }
	| { kind: "pending" }
	| { kind: "error"; message: string }
	| { kind: "undeclared" }
	| { kind: "declared"; projects: ProjectRecordDto[]; currentProjectId?: string };

export function projectFieldState(facts: ProjectFacts): ProjectFieldState {
	const registry = projectRegistryState(facts);
	switch (registry.kind) {
		case "disconnected":
			return { kind: "disconnected" };
		case "error":
			return { kind: "error", message: registry.message };
		case "unread":
			return { kind: "pending" };
		case "empty":
			return { kind: "undeclared" };
		case "ready":
			break;
	}
	const state: ProjectFieldState = { kind: "declared", projects: registry.projects };
	if (facts.currentProjectId !== undefined) state.currentProjectId = facts.currentProjectId;
	return state;
}
