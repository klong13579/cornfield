/**
 * 「工作上下文选中的 Project」在**本机这个浏览器**里被记住的那一份（localStorage）。
 *
 * 它**不是**权威，也不假装是：权威是 serve 的 Project registry
 * （`~/.cornfield/agent/projects.json`）。这里只记住「这个 Agent 的下一个新会话指到哪个
 * Project」，让刷新页面不再把它悄悄退回「不指定」—— 那正是「选了但没地方保存」的那件事。
 *
 * **按 Agent 存**（`agentId → projectId` 一张表），因为「我在哪个项目上干活」是**每个 Agent
 * 各自**的事：不同 Agent 服务不同的项目，共用一格就会出现「改一个，所有 Agent 都跟着变」
 * —— 那不是选择，是串台。
 *
 * 存的是 **projectId**，不是 root：归属的身份是 id（root 由存储归一，同一个 root 只属于一个
 * Project），拿路径当键会在归一之后对不上。
 *
 * 读失败（没写过 / 坏 JSON / 形状不对 / 存储不可用）一律当「没记过」：一个记不住偏好的副作用，
 * 不该让工作台打不开。这与「Project registry 读不到 ≠ 没声明过」是两条不同的规矩 —— 那边的
 * 代价是用户以为项目消失了。
 *
 * **恢复之后必须校验**：记下的那个 Project 可能在页面关着的这段时间里被删了。校验不放在这一层
 * （这里看不到注册表），由 `SessionStore` 在**第一次真的读到一份名单**时把那批恢复出来的记录
 * 逐条判一次：还在就留，不在就丢（连同存储）。
 */

/** 存储键。与 `cornfield:recent-paths:*` 同族：都是「这台机器、这个浏览器里记住的东西」。 */
export const WORKING_PROJECT_KEY = "cornfield:working-project";

/**
 * 表的内容：Agent → Project。写走 {@link saveWorkingProjects}。
 *
 * **空串是一个有意义的取值**：「这个 Agent 显式不指定」——与「没记过」（键不存在）是两件事。
 * 少了这个区分，在注册表里声明了该 Agent 的 Project 面前，用户选的「不指定」会被兜底顶掉。
 */
export type WorkingProjects = ReadonlyMap<string, string>;

/**
 * 存储里的原文 → 一张表；读不出来就是空表。
 *
 * 纯函数，存储读写在外面 —— 判据可以脱离 `localStorage` 单独验证。
 * 键与值都 trim，并丢掉键为空的项：写进去的值会被直接当 id 用，带一个前后空格就是一条永远匹配
 * 不上的记录（而它看起来与真 id 一模一样）。值为空串保留（见 `WorkingProjects`）。
 *
 * 旧形状（单个字符串）在这里自然作废：它不是对象，解析不出表 —— 那正是我们要的，一个「全局
 * 一格」的值不能猜给哪个 Agent。
 */
export function parseWorkingProjects(raw: string | null): Map<string, string> {
	const empty = new Map<string, string>();
	if (raw === null) return empty;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return empty;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return empty;
	const projects = new Map<string, string>();
	for (const [agentId, projectId] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof projectId !== "string") continue;
		const agent = agentId.trim();
		if (agent === "") continue;
		// 值可以是空串：那是「这个 Agent 显式不指定」，不能当坏数据丢掉（丢掉就会被兜底顶回一个）。
		projects.set(agent, projectId.trim());
	}
	return projects;
}

/** 读整张表。没写过 / 存储不可用都是空表（对调用方本来就是同一件事）。 */
export function loadWorkingProjects(): Map<string, string> {
	if (typeof localStorage === "undefined") return new Map();
	try {
		return parseWorkingProjects(localStorage.getItem(WORKING_PROJECT_KEY));
	} catch {
		/* 存储不可用（隐私模式等）—— 没有记住的偏好，不是错误 */
		return new Map();
	}
}

/**
 * 写整张表。空表 = 忘掉这件事（删掉那条键，不留一个永远不再成立的空壳）。
 *
 * 写失败不抛：内存里那份才是当前有效值，本次会话照常生效，只是下次打开记不起来。
 */
export function saveWorkingProjects(projects: WorkingProjects): void {
	if (typeof localStorage === "undefined") return;
	try {
		if (projects.size === 0) {
			localStorage.removeItem(WORKING_PROJECT_KEY);
			return;
		}
		localStorage.setItem(WORKING_PROJECT_KEY, JSON.stringify(Object.fromEntries(projects)));
	} catch {
		/* quota / privacy mode —— 本次会话内仍然可用 */
	}
}
