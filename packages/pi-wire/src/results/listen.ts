/**
 * 听记结果形状（`listen_list`；T10C 补 provenance）。
 *
 * 一端一份、两端共用：serve 侧的 `stt/listen-service.ts` 就返回这些类型（它从本文件 import，
 * 不再自建同形接口），web-app 也从 `@cornfield/wire` import —— 字段加一处、两端同时看到。
 *
 * ## 为什么 provenance 必须在写入时落盘
 *
 * 听记存在客户端级目录（`~/.cornfield/listen/`），一个 Agent 的录音与另一个的落在同一个文件夹里。
 * 于是「这条是谁录的」有两个错误的来源：按时间碰会话、按磁盘顺序分组 —— 两者都是猜。
 * 唯一的真源是写入方当时就知道的事实（哪个 Agent、哪个会话、哪个 Project），落盘随记录走。
 * `provenance` 缺省 = 未标注（v1 旧记录，或写入方当时拿不到 scope）——**不等于**「属于当前 Agent」。
 */

/** 一条听记的来源。每个字段都可能缺省（缺省 = 那一项没标注，不是空字符串）。 */
export interface ListenProvenanceDto {
	/** 注册表 key（serve 写入时由 agent-scope 解析；CLI/TUI 无 agent 身份时缺省）。 */
	agentId?: string;
	/** Agent 的 home（CLI/TUI 用其配置根）。 */
	agentDir?: string;
	/** 写入方所在 Project（cwd/agentDir 命中 Project registry 时）。未归属 = 缺省。 */
	projectId?: string;
	/** 写入时所在会话文件（serve 写入时为当前 attach 会话）。 */
	sessionFile?: string;
}

/** 听记历史条目（单条录音的元数据 + 转写全文 + 来源标注）。 */
export interface ListenRecordingDto {
	name: string;
	path: string;
	/** ISO 时间（json recorded_at，缺失回退文件 mtime）。 */
	recordedAt: string;
	size: number;
	text: string;
	/** 原始音频文件名（/listen-audio/<audio>?token= 回放）；缺省 = 未留档。 */
	audio?: string;
	/** 写入方标注的来源；缺省 = 未标注（旧记录）。 */
	provenance?: ListenProvenanceDto;
}

/** `listen_list` 响应。 */
export interface ListenListResultDto {
	recordings: ListenRecordingDto[];
}
