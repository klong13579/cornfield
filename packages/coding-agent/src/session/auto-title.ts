/**
 * 首条消息自动起名。
 *
 * 规则只收在这一处：起名与否取决于「这条消息是不是首条 user 消息」「会话有没有落过盘的名字」
 * 「PI_NO_TITLE 有没有开」三件事，以前它们内联在交互式 CLI 的提交流程里，于是只有 TUI
 * 起的会话有名字，WebUI/serve 与 gateway（wire-stdio）起的会话在列表里只能靠首条消息
 * 前 40 字或文件名兜底。三个驱动方各自触发一次，规则共用这一份，谁都不会漏。
 *
 * 起名要花一次模型调用，所以调用方一律 fire-and-forget（`void`）：本函数自己吞掉所有异常，
 * 失败即返回 undefined，绝不把错误抛进驱动方的消息通路，也绝不阻塞首条消息的提交。
 */
import { $env, logger } from "@cornfield/utils";
import { generateSessionTitle } from "../utils/title-generator";
import type { AgentSession } from "./agent-session";

/** 起名器的注入点：生产传 `generateSessionTitle`，测试传假实现（不打网络）。 */
export type TitleGenerator = typeof generateSessionTitle;

/**
 * 给会话起一个自动名字并落盘。
 *
 * @param session 目标会话（读它的消息历史、会话名、模型与配置）
 * @param firstMessageText 首条 user 消息的文本，交给起名器
 * @param generate 起名器，默认 `generateSessionTitle`
 * @returns 真正落上的名字；被规则挡掉 / 生成失败 / 用户已手动命名时为 undefined
 */
export async function maybeAutoTitle(
	session: AgentSession,
	firstMessageText: string,
	generate: TitleGenerator = generateSessionTitle,
): Promise<string | undefined> {
	try {
		// 只在首条 user 消息上起名：历史里已经有 user 消息说明名字该起早起了（或用户不想起）。
		if (session.messages.some(message => message.role === "user")) return undefined;
		// 判据是「有没有落过盘的名字」，不是「有没有名字」：getSessionName() 会回落到 PI_SESSION_NAME，
		// 而 gateway 把 accountId 注在那儿当子进程的 intercom 身份——它不是会话的标题。
		// titleSource 只有 setSessionName 会写，所以它才是「这个名字是被人/起名器定过的」的事实。
		if (session.sessionManager.titleSource !== undefined) return undefined;
		if ($env.PI_NO_TITLE) return undefined;

		const title = await generate(
			firstMessageText,
			session.modelRegistry,
			session.settings,
			session.sessionId,
			session.model,
		);
		if (!title) return undefined;

		// setSessionName 对 auto 名返回 false 只有一种原因：用户在这中间手动命名过（或名字被清洗成空）。
		// 此时不覆盖，也不算落上。
		const applied = await session.sessionManager.setSessionName(title, "auto");
		if (!applied) return undefined;
		// 返回会话里真正存下来的名字（setSessionName 会清洗），调用方拿它去更新外部显示。
		return session.sessionManager.getSessionName();
	} catch (err) {
		logger.debug("auto-title: 起名失败，忽略", {
			error: err instanceof Error ? err.message : String(err),
		});
		return undefined;
	}
}
