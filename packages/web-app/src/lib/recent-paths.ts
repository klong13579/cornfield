/**
 * 「本机用过的路径」—— 路径输入框的候选来源（datalist），存在 `localStorage`。
 *
 * 它**不是**权威，也不假装是：真正说了算的是 serve 的 Project registry
 * （`~/.cornfield/agent/projects.json`）与 agentDir 的 `workspace.json`。这里只记住
 * 「这台机器、这个浏览器里，你亲手用过哪些路径」，作用仅仅是少打一次字。
 *
 * 所以读失败（没写过 / 坏 JSON / 形状不对 / 存储不可用）一律当空列表 —— 一个记不住历史的
 * 副作用，不该让 Project 声明面板或设置页打不开。这与「Project registry 读不到 ≠ 没声明过」
 * 是两条不同的规矩，因为两边的代价完全不同：那边把读不到说成没有，用户会以为项目消失了。
 *
 * 按用途分键：Project root 与 sidecar 工作目录不是同一类路径，混在一个列表里会让
 * `<home>/workspace` 出现在项目根的候选里。
 */

/** 每个用途各记多少条。够用即止 —— 这是输入辅助，不是历史记录。 */
export const RECENT_PATH_LIMIT = 8;

export const RECENT_PATH_KEYS = {
	/** Project 声明面板的 root 字段。 */
	projectRoot: "cornfield:recent-paths:project-root",
	/** 设置页的 sidecar 工作目录。 */
	workspaceDir: "cornfield:recent-paths:workspace-dir",
} as const;

export type RecentPathKey = (typeof RECENT_PATH_KEYS)[keyof typeof RECENT_PATH_KEYS];

/**
 * 把一条路径推到队首：去重（同一个路径只留最近一次）、限长、丢弃空白。返回新数组。
 *
 * 纯函数，存储读写在外面 —— 判据可以脱离 `localStorage` 单独验证。
 */
export function pushRecentPath(list: readonly string[], path: string, limit = RECENT_PATH_LIMIT): string[] {
	const value = path.trim();
	if (value === "") return [...list];
	// 新值排在最前，`Set` 保留首次出现：重复项被去掉，已有过的路径被提到队首。
	return [...new Set([value, ...list])].slice(0, limit);
}

/**
 * 把存储里读到的原文收敛成路径列表：坏形状 = 空列表。
 *
 * 逐项 trim 并丢掉空的 —— 候选里的路径会直接被写进输入框，带一个尾空格就是一条错的路径。
 *
 * 不抛：这里没有「读不到」这个可报告的失败 —— 调用方对两种情况的处理本来就是同一件事
 * （没有候选就只是没有候选）。
 */
export function parseRecentPaths(raw: string | null, limit = RECENT_PATH_LIMIT): string[] {
	if (raw === null) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const paths = parsed.map(item => (typeof item === "string" ? item.trim() : "")).filter(item => item !== "");
	return [...new Set(paths)].slice(0, limit);
}

/** 读某个用途的已用路径；没有 / 读不出来都是空列表。 */
export function loadRecentPaths(key: RecentPathKey): string[] {
	if (typeof localStorage === "undefined") return [];
	try {
		return parseRecentPaths(localStorage.getItem(key));
	} catch {
		/* 存储不可用（隐私模式等）—— 没有候选，不是错误 */
		return [];
	}
}

/**
 * 记一条已用路径，返回记完之后的完整列表（调用方直接拿它更新界面，不必再读一次）。
 *
 * 写失败时仍返回「应当记下的那份」：调用方拿它渲染候选，界面不会因为一次写不进去而回退。
 */
export function rememberRecentPath(key: RecentPathKey, path: string): string[] {
	const next = pushRecentPath(loadRecentPaths(key), path);
	if (typeof localStorage === "undefined") return next;
	try {
		localStorage.setItem(key, JSON.stringify(next));
	} catch {
		/* quota / privacy mode —— 本次会话内仍然可用 */
	}
	return next;
}
