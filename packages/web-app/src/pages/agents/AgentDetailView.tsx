import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ModelInfoDto } from "../../lib/wire-dto";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";
import { KindBadge } from "./AgentsView";

/**
 * Agent 详情（FR-2 / mock agent-detail）—— 5 tab：Skills / Cron / 模型 / 工具 / 用户画像。
 * P3 阶段骨架：Skills/Cron/工具/画像为本地 mock 结构（数据源待协议扩展，见 todo 标注）；
 * 模型配置 tab 已接 get_available_models（adapter）+ set_model/set_thinking_level 真实命令。
 */

type TabId = "skills" | "cron" | "model" | "tools" | "profile";

const TABS: { id: TabId; label: string; count?: number }[] = [
	{ id: "skills", label: "Skills", count: 6 },
	{ id: "cron", label: "定时任务", count: 2 },
	{ id: "model", label: "模型配置" },
	{ id: "tools", label: "工具开关" },
	{ id: "profile", label: "用户画像" },
];

// TODO(@be-dev): serve get_snapshot 扩展 skills 字段（skill-management.md 3.2）后替换为真实数据
const SKILLS = [
	{ name: "diagnosing-bugs", desc: "诊断循环：硬 bug 和性能回归的诊断流程", version: "v1.2", enabled: true },
	{ name: "tdd", desc: "测试驱动开发，red-green-refactor 流程", version: "v2.0", enabled: true },
	{ name: "codebase-design", desc: "深度模块设计词汇，接口设计、seam 定位", version: "v1.0", enabled: true },
	{ name: "cross-modal-review", desc: "第二模型质量门禁，跨模型代码审查", version: "v0.25", enabled: true },
	{ name: "project-todo", desc: "项目任务板维护，TODO.md 增删改查", version: "v1.1", enabled: false },
	{
		name: "session-diagnosis-orchestrator",
		desc: "Agent 会话六维度诊断，失败原因分析",
		version: "v1.0",
		enabled: true,
	},
];

// TODO(@be-dev): cron 数据接口（wire 协议扩展）就绪后替换
const CRONS = [
	{
		name: "每日代码审查报告",
		schedule: "0 9 * * 1-5",
		desc: "每个工作日早上 9 点，扫描昨日提交的 PR，生成代码审查摘要",
		runs: [
			{ ok: true, at: "8/16 09:00" },
			{ ok: true, at: "8/15 09:00" },
			{ ok: false, at: "8/14 09:00" },
		],
	},
	{
		name: "每周架构健康检查",
		schedule: "0 10 * * 1",
		desc: "每周一早上 10 点，全仓库架构扫描，检查循环依赖和设计漂移",
		runs: [
			{ ok: true, at: "8/11 10:00" },
			{ ok: true, at: "8/4 10:00" },
		],
	},
];

const THINKING_LEVELS = ["off", "low", "medium", "high"];

export function AgentDetailView(): React.JSX.Element {
	const { id = "" } = useParams();
	const view = useSession();
	const store = useSessionStore();
	const [tab, setTab] = useState<TabId>("skills");
	const [models, setModels] = useState<ModelInfoDto[]>([]);
	const [selProvider, setSelProvider] = useState("anthropic");
	const [tools, setTools] = useState<Record<string, boolean>>({
		read: true,
		write: true,
		edit: true,
		bash: true,
		search: true,
		find: true,
		ast_grep: true,
		ast_edit: true,
		lsp: true,
		python: true,
		notebook: false,
		debug: true,
		task: true,
		web_search: true,
		puppeteer: false,
		todo_write: true,
	});

	useEffect(() => {
		void store.fetchModels().then(setModels);
	}, [store]);

	const agent = view.agents.find(a => a.id === id);
	const name = agent?.name ?? (view.agents.length === 0 ? "等待 Agent 注册表" : "未知 Agent");
	const provider = agent?.model?.split("/")[0] ?? (view.model ?? "").split("/")[0] ?? "anthropic";
	const currentModel = agent?.model ?? view.model ?? "";
	const providers = Array.from(new Set(models.map(m => m.provider)));

	return (
		<div className="px-10 pt-8 pb-12">
			<div className="mx-auto max-w-[860px]">
				{/* 头部（编辑式排版，无装饰图形） */}
				<div className="mb-8">
					<div className="mb-2.5 flex items-center gap-2 text-[12px] text-ink-subtle">
						<span
							className={`h-2 w-2 rounded-full ${agent?.status === "busy" ? "bg-warning animate-pulse" : agent?.status === "idle" || agent?.status === "online" ? "bg-success" : "bg-ink-faint"}`}
						/>
						{agent ? `${statusText(agent.status)} · 最近活跃 ${agent.lastAction ?? "—"}` : "会话未注册"}
						{agent?.dingtalkBound && <span className="badge done">钉钉已绑定</span>}
					</div>
					<div className="flex items-baseline gap-4">
						<h1 className="text-[32px] font-semibold leading-snug tracking-[-0.8px] text-ink">{name}</h1>
						<span className="rounded bg-accent-dim px-2.5 py-1 font-mono text-[12px] text-ink">
							{currentModel}
						</span>
						{agent && <KindBadge kind={agent.kind} />}
					</div>
					<div className="mt-2 text-[15px] text-ink-subtle">
						{agent
							? `${agent.workspace} · 最近活跃 ${agent.lastAction ?? "—"}`
							: "角色待注册表推送 · 代码审查 · 架构设计 · 调试（骨架描述）"}
					</div>
				</div>

				{/* 5 tabs */}
				<div className="mb-7 flex gap-0.5 border-b border-hairline">
					{TABS.map(t => (
						<button
							key={t.id}
							type="button"
							className={`-mb-px cursor-pointer border-b-2 px-4 py-2.5 text-[13px] font-medium transition-colors ${tab === t.id ? "border-accent text-accent-hover" : "border-transparent text-ink-subtle hover:text-ink"}`}
							onClick={() => setTab(t.id)}
						>
							{t.label}
							{t.count !== undefined && (
								<span className="ml-1 text-[11px] text-ink-faint">
									{t.id === "skills" ? (agent?.skillsCount ?? t.count) : t.count}
								</span>
							)}
						</button>
					))}
				</div>

				{tab === "skills" && (
					<div>
						{SKILLS.map(skill => (
							<div
								key={skill.name}
								className="flex items-baseline gap-3 border-b border-hairline px-1 py-3.5 transition-colors hover:bg-surface"
							>
								<span className="w-[220px] shrink-0 font-mono text-[13px] font-medium text-ink">
									{skill.name}
								</span>
								<span className="min-w-0 flex-1 text-[12px] text-ink-subtle">{skill.desc}</span>
								<span className="shrink-0 font-mono text-[12px] text-ink-faint">{skill.version}</span>
								<button
									type="button"
									className={`toggle shrink-0${skill.enabled ? " on" : ""}`}
									aria-checked={skill.enabled}
									role="switch"
									onClick={() => {
										/* TODO(@be-dev): set_skill_enabled 协议（skill-management.md 3.2） | 当前仅本地展示态 */
									}}
								/>
							</div>
						))}
						<div className="mt-3 text-[11px] text-ink-faint">
							Skills 启用/停用需 serve get_snapshot 扩展 skills 字段（skill-management.md L1，P3 同批）
						</div>
					</div>
				)}

				{tab === "cron" && (
					<div>
						<div className="mb-5">
							<button
								type="button"
								className="btn btn-sm"
								onClick={() => {
									/* TODO: cron 新增协议 */
								}}
							>
								+ 新建定时任务（TODO）
							</button>
						</div>
						{CRONS.map(cron => (
							<div key={cron.name} className="border-b border-hairline px-1 py-4">
								<div className="mb-1 flex items-center gap-2.5">
									<span className="text-[14px] font-medium text-ink">{cron.name}</span>
									<span className="badge done">运行中</span>
									<span className="rounded bg-surface-3 px-2 py-0.5 font-mono text-[12px] text-ink">
										{cron.schedule}
									</span>
								</div>
								<div className="mb-2 text-[12px] text-ink-subtle">{cron.desc}</div>
								<div className="flex items-center gap-3 text-[12px] text-ink-faint">
									<span>最近运行</span>
									{cron.runs.map((r, i) => (
										<span key={i} className={r.ok ? "text-success" : "text-danger"}>
											{r.ok ? "✓" : "✗"} {r.at}
										</span>
									))}
								</div>
								<div className="mt-2.5 flex gap-1.5">
									<button type="button" className="cbtn shrink-0 border border-hairline">
										暂停
									</button>
									<button type="button" className="cbtn shrink-0 border border-hairline">
										立即运行
									</button>
									<button type="button" className="cbtn shrink-0 border border-hairline">
										日志
									</button>
								</div>
							</div>
						))}
						<div className="mt-3 text-[11px] text-ink-faint">cron 数据接口wire 协议扩展后就绪（be-dev P3）</div>
					</div>
				)}

				{tab === "model" && (
					<div>
						<h4 className="mb-3.5 text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
							模型选择
						</h4>
						<div className="flex max-w-[420px] flex-col gap-2.5">
							<label className="flex items-center gap-3 text-[13px] text-ink-subtle">
								<span className="w-[90px] shrink-0">Provider</span>
								<select
									value={selProvider}
									onChange={e => setSelProvider(e.target.value)}
									className="flex-1 rounded border border-hairline bg-surface-2 px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent"
								>
									{providers.length > 0 ? (
										providers.map(p => <option key={p}>{p}</option>)
									) : (
										<option>{provider}</option>
									)}
								</select>
							</label>
							<label className="flex items-center gap-3 text-[13px] text-ink-subtle">
								<span className="w-[90px] shrink-0">Model</span>
								<select
									value={currentModel}
									onChange={e => {
										if (e.target.value) store.setModel(e.target.value, selProvider);
									}}
									className="flex-1 rounded border border-hairline bg-surface-2 px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent"
								>
									{models
										.filter(m => m.provider === selProvider)
										.map(m => (
											<option key={m.id}>{m.id}</option>
										))}
									{models.length === 0 && <option>{currentModel || "—"}</option>}
								</select>
							</label>
							<label className="flex items-center gap-3 text-[13px] text-ink-subtle">
								<span className="w-[90px] shrink-0">Thinking</span>
								<select
									value={view.thinkingLevel ?? "off"}
									onChange={e => store.setThinkingLevel(e.target.value)}
									className="flex-1 rounded border border-hairline bg-surface-2 px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent"
								>
									{THINKING_LEVELS.map(l => (
										<option key={l}>{l}</option>
									))}
								</select>
							</label>
						</div>
						<div className="mt-4 text-[11px] text-ink-faint">context 与 token 用量待 get_session_stats 接入</div>
					</div>
				)}

				{tab === "tools" && (
					<div>
						<div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-0.5">
							{Object.entries(tools).map(([name, on]) => (
								<div
									key={name}
									className="flex items-center gap-2.5 rounded px-2 py-2 transition-colors hover:bg-surface"
								>
									<span className="flex-1 font-mono text-[13px] text-ink-muted">{name}</span>
									<span
										className={`toggle small shrink-0${on ? " on" : ""}`}
										role="switch"
										aria-checked={on}
										tabIndex={0}
										onClick={() => setTools(t => ({ ...t, [name]: !t[name] }))}
										onKeyDown={e => e.key === "Enter" && setTools(t => ({ ...t, [name]: !t[name] }))}
									/>
								</div>
							))}
						</div>
						<div className="mt-3 text-[11px] text-ink-faint">
							本地切换演示态 — set_host_tools 协议（host_tool_* 帧）待 fe-dev/be-dev 同步落地后持久化（当前 serve
							返回 not_implemented）
						</div>
					</div>
				)}

				{tab === "profile" && (
					<div>
						<div className="mb-1 text-[15px] font-semibold text-ink">基于钉钉消息的用户建模</div>
						<div className="mb-4 text-[12px] text-ink-subtle">
							来源：钉钉机器人会话 · 128 条消息 · 最近更新 2 小时前（mock，真实入口待连接器数据只读路径）
						</div>
						<div className="mb-2.5 text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
							关注领域
						</div>
						<div className="mb-5 flex flex-wrap gap-2">
							{["机器人", "扫地机", "日程", "投融资", "代码审查", "架构设计"].map(tag => (
								<span key={tag} className="rounded bg-surface-3 px-3 py-1 text-[12px] text-ink-subtle">
									{tag}
								</span>
							))}
						</div>
						<div className="mb-5 rounded-lg border border-hairline bg-surface px-4 py-3 text-[14px] leading-relaxed text-ink">
							关注研发效率与商业决策，偏好短句直接沟通。技术背景深厚但不逐行审代码，关注架构方向与
							tradeoff。对投融资话题敏感，习惯用数字说话。
						</div>
						<div className="flex gap-2">
							<button type="button" className="btn btn-sm">
								重新建模
							</button>
							<button type="button" className="btn btn-secondary btn-sm">
								导出画像 JSON
							</button>
							<button
								type="button"
								className="btn btn-sm border border-danger bg-transparent text-danger hover:bg-danger/10"
								onClick={() => {
									if (window.confirm("确认清除用户画像？此操作不可恢复。")) {
										/* TODO: 清除画像协议 */
									}
								}}
							>
								清除画像
							</button>
						</div>
					</div>
				)}

				<div className="mt-6">
					<Link to="/agents" className="text-[12px] text-ink-muted no-underline hover:text-ink hover:underline">
						← 返回 Agent 列表
					</Link>
				</div>
			</div>
		</div>
	);
}

function statusText(status?: string): string {
	switch (status) {
		case "online":
			return "运行中";
		case "busy":
			return "执行中";
		case "idle":
			return "空闲";
		case "stopped":
			return "已停用";
		default:
			return "状态未知";
	}
}
