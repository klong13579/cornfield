/**
 * 产物（artifacts）结果形状 —— list_artifacts 响应（serve 端权威数据面）。
 *
 * 产物来源：该 agent 最近会话 JSONL 的工具调用（write / edit / puppeteer screenshot）
 * 写出的文件；path 相对 agentDir。前端「产物」tab 消费：列表 + 点开预览
 * （html → iframe /preview 静态路由；image → 同路由；markdown/text → fs_read）。
 */

export type ArtifactKind = "html" | "image" | "markdown" | "text";

export interface ArtifactDto {
	/** 唯一 id（相对路径，作 React key / 前端选择态）。 */
	id: string;
	/** 展示标题（文件名）。 */
	title: string;
	/** 产物类型（前端按类型选预览方式）。 */
	type: ArtifactKind;
	/** 相对 agentDir 路径（resolveFsPath 校验后；供 /preview 与 fs_read 复用）。 */
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
