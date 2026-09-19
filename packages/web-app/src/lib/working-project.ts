/**
 * 「工作上下文选中的 Project」在**本机这个浏览器**里被记住的那一份（localStorage）。
 *
 * 它**不是**权威，也不假装是：权威是 serve 的 Project registry
 * （`~/.cornfield/agent/projects.json`）。这里只记住「我上次把下一个新会话指到哪个 Project」，
 * 让刷新页面不再把它悄悄退回「不指定」—— 那正是「选了但没地方保存」的那件事。
 *
 * 存的是 **projectId**，不是 root：归属的身份是 id（root 由存储归一，同一个 root 只属于一个
 * Project），拿路径当键会在归一之后对不上。
 *
 * 读失败（没写过 / 存储不可用）一律当「没记过」：一个记不住偏好的副作用，不该让工作台打不开。
 * 这与「Project registry 读不到 ≠ 没声明过」是两条不同的规矩 —— 那边的代价是用户以为项目消失了。
 *
 * **恢复之后必须校验**：记下的那个 Project 可能在页面关着的这段时间里被删了。校验不放在这一层
 * （这里看不到注册表），由 `SessionStore` 在**第一次真的读到一份名单**时判一次：还在就留，
 * 不在就丢（连同存储）。
 */

/** 存储键。与 `cornfield:recent-paths:*` 同族：都是「这台机器、这个浏览器里记住的东西」。 */
export const WORKING_PROJECT_KEY = "cornfield:working-project";

/**
 * 存储里的原文 → 一个 projectId；空串表示「没记过」。
 *
 * 纯函数，存储读写在外面 —— 判据可以脱离 `localStorage` 单独验证。
 * 必须 trim：写进去的值会被直接当 id 用，带一个前后空格就是一条永远匹配不上的记录（而它看起来
 * 与真 id 一模一样）。
 */
export function parseWorkingProjectId(raw: string | null): string {
	return raw === null ? "" : raw.trim();
}

/** 读记下的 projectId。没写过 / 存储不可用都是空串（对调用方本来就是同一件事）。 */
export function loadWorkingProjectId(): string {
	if (typeof localStorage === "undefined") return "";
	try {
		return parseWorkingProjectId(localStorage.getItem(WORKING_PROJECT_KEY));
	} catch {
		/* 存储不可用（隐私模式等）—— 没有记住的偏好，不是错误 */
		return "";
	}
}

/**
 * 记一条工作上下文。空串 = 忘掉它（用户选回了「不指定」，那就没有可记住的）。
 *
 * 写失败不抛：内存里那份才是当前有效值，本次会话照常生效，只是下次打开记不起来。
 */
export function rememberWorkingProjectId(projectId: string): void {
	if (typeof localStorage === "undefined") return;
	const value = parseWorkingProjectId(projectId);
	try {
		if (value === "") localStorage.removeItem(WORKING_PROJECT_KEY);
		else localStorage.setItem(WORKING_PROJECT_KEY, value);
	} catch {
		/* quota / privacy mode —— 本次会话内仍然可用 */
	}
}
