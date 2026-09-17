/**
 * 设置页「保存并重连」的连接配置决策（纯函数，便于单测锁回归）。
 *
 * Token 保留规则（曾用空串覆盖已存 token，断连后失去鉴权——最重的数据丢失）：
 * 用户没输入（空串或纯空白）时保留已存凭据；只有真正输入了才写新值。
 */
export function resolveNextToken(input: string, stored: string): string {
	const trimmed = input.trim();
	return trimmed !== "" ? trimmed : stored;
}
