import { PiServerError } from "@cornfield/client";

/**
 * 写命令失败时 serve 的**判决** vs 传输层失败 —— 两者必须分得开，用一处、只有一处。
 *
 * 一条写命令（`set_agent_todo` / `new_session` / `set_project` …）失败的原因只有两类，而它们
 * 的证据力完全不同：
 *   - **serve 拒了**（`ok:false`）：命令**到了**、serve **看过**、并给出了拒绝理由。这是一次
 *     确定的否定 —— 调用方可以据此说「没做成」；
 *   - **没等到答复**（断线 / 超时）：命令发出去之后发生了什么**不知道** —— 说「没做成」就是把
 *     一个没发生的否定当成事实。
 *
 * 所以这一层只回答「serve 的原话是什么」，判定「确定没做」与「说不准」由各命令面自己做
 * （它们才知道那条命令的语义），见 `SessionStore.newSession` 的 `NewSessionOutcome`。
 */

export interface ServeVerdict {
	/** serve 给的原文（如 `todo.status-transition: illegal AgentTodo transition completed → open`）。 */
	message: string;
	/** 结构化错误码（协议批 B-4 的 `{ code, message }` 形状才有）。 */
	code?: string;
}

/**
 * 从一次写入失败里取出 **serve 的原话**。
 *
 * `PiServerError.message` 是 `Server rejected "<命令>": <serve 的话>` —— 前缀是客户端加的，
 * 界面要显示的是后面那半句。其余错误（断线 / 超时）没有「判决」，就说它自己的话。
 *
 * 不在这里做「翻译成友好文案」：serve 拒它的理由（owner 不对、未知 projectId、状态非法）
 * 是用户唯一能据以修的东西，改写成一句「保存失败」就把它丢了。
 */
export function serveVerdictOf(err: unknown): ServeVerdict {
	if (err instanceof PiServerError) {
		return typeof err.serverError === "string"
			? { message: err.serverError }
			: { message: err.serverError.message, code: err.serverError.code };
	}
	if (err instanceof Error) return { message: err.message };
	return { message: String(err) };
}

/**
 * 这次失败**是不是 serve 的判决**（而不是没等到答复）。
 *
 * 需要单独一个判据的地方（如 `new_session`：serve 拒了 = 确定没建，断线超时 = 建没建不知道）
 * 用它分流，别自己写 `instanceof` —— 少一处判据就少一处将来会跟这里不一致的地方。
 */
export function isServeVerdict(err: unknown): boolean {
	return err instanceof PiServerError;
}
