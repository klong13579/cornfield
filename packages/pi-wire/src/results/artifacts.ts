/**
 * 产物（artifacts）结果形状 —— list_artifacts 响应（serve 端权威数据面）。
 *
 * 「产物」是一本会话账，两个来源合在一起报：
 * - `agent`：会话 JSONL 里 write / edit / puppeteer screenshot 三个 Tool 写出的文件；
 * - `user`：用户发给这个会话的文件（当前是贴/选进来的图，落在会话 artifacts 目录的 uploads/）。
 *
 * 每条产物的来源由 `source` 明说 —— 前端因此不必猜，也没有「来源未知」这一态。
 * path 相对它所属的那个根。前端「产物」tab 消费：列表 + 点开预览
 * （html → iframe /preview 静态路由；image → 同路由；markdown/text → fs_read）。
 */

export type ArtifactKind = "html" | "image" | "markdown" | "text";

/** 这条产物是谁放进会话的：`agent` = Tool 写出的，`user` = 用户发进来的。 */
export type ArtifactSource = "agent" | "user";

export interface ArtifactDto {
	/** 唯一 id（相对路径，作 React key / 前端选择态）。 */
	id: string;
	/** 展示标题（文件名）。 */
	title: string;
	/** 产物类型（前端按类型选预览方式）。 */
	type: ArtifactKind;
	/** 谁放进来的（前端按它标来源：这本账里两种都有）。 */
	source: ArtifactSource;
	/** 相对它所属的那个根（roots 校验后；供 /preview 与 fs_read 复用）。 */
	path: string;
	/** 文件 mtime（毫秒 epoch；列表按此倒序）。 */
	updatedAt: number;
	/** 文件大小（字节）。 */
	size: number;
}

/** list_artifacts 响应（artifacts 按 updatedAt 倒序；无产物 → 空数组）。 */
export interface ArtifactsResultDto {
	artifacts: ArtifactDto[];
}
