import { X } from "lucide-react";
import { useEffect, useState } from "react";
import type { HostToolDefinitionDto, ModelInfoDto } from "../../lib/wire-dto";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";
import { FileExplorer } from "../workspace/FileExplorer";
import { KindBadge } from "./AgentsView";

/**
 * Agent 详情（FR-2）—— 7 tab：Skills / Cron / 模型 / 工具 / 画像 / 文件 / Prompts。
 * 数据源：Skills 读 .omp/skills 真实列表（fs_list+SKILL.md）、画像读 mission.md+user.md、
 * 模型接 get_available_models/set_model 真命令、Cron 待 wire 命令缺口 B4（disabled 占位）、
 * 画像实时建模待连接器路径（缺口 B5）。
 */

type TabId = "skills" | "cron" | "model" | "tools" | "profile" | "files" | "prompts";

const TABS: { id: TabId; label: string; count?: number }[] = [
	{ id: "skills", label: "Skills", count: 6 },
	{ id: "cron", label: "定时任务", count: 2 },
	{ id: "model", label: "模型配置" },
	{ id: "tools", label: "工具开关" },
	{ id: "profile", label: "用户画像" },
	{ id: "files", label: "文件" },
	{ id: "prompts", label: "Prompts" },
];

// 技能列表改为真实数据：fs_list 读 .omp/skills/ 目录（serve skillCount 同源）。
// 版本/描述从各 skill 的 SKILL.md frontmatter 解析（fs_read）。

// cron 数据为骨架展示：wire 命令缺口 B4
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

export function AgentDetailView({ agentId, onClose }: { agentId: string; onClose: () => void }): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const [tab, setTab] = useState<TabId>("skills");
	const [models, setModels] = useState<ModelInfoDto[]>([]);
	const [selProvider, setSelProvider] = useState("anthropic");
	// C3：host tool 注册态（set_host_tools 真命令本地权威态；snapshot 无工具开关数据，wire 面未提供）
	const [hostTools, setHostToolsState] = useState<HostToolDefinitionDto[]>(() => store.getHostTools());
	const [newHostName, setNewHostName] = useState("");
	const [newHostDesc, setNewHostDesc] = useState("");

	const registerHostTool = () => {
		const name = newHostName.trim();
		if (!name) return;
		const next = [
			...hostTools.filter(t => t.name !== name),
			{ name, description: newHostDesc.trim() || `host tool ${name}`, parameters: {} },
		];
		setHostToolsState(next);
		store.setHostTools(next);
		setNewHostName("");
		setNewHostDesc("");
	};

	const unregisterHostTool = (name: string) => {
		const next = hostTools.filter(t => t.name !== name);
		setHostToolsState(next);
		store.setHostTools(next);
	};

	useEffect(() => {
		void store.fetchModels().then(result => setModels(result.models));
	}, [store]);

	const agent = view.agents.find(a => a.id === agentId);
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
						<button
							type="button"
							onClick={onClose}
							aria-label="关闭详情"
							title="关闭详情"
							className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
						>
							<X size={16} strokeWidth={1.8} />
						</button>
					</div>
					<div className="flex items-baseline gap-4">
						<h1 className="text-[32px] font-semibold leading-snug tracking-[-0.8px] text-ink">{name}</h1>
						<span className="rounded bg-accent-dim px-2.5 py-1 font-mono text-[12px] text-ink">
							{currentModel}
						</span>
						{agent && <KindBadge kind={agent.kind} />}
					</div>
					<div className="mt-2 text-[15px] text-ink-subtle">
						{agent ? `${agent.workspace} · 最近活跃 ${agent.lastAction ?? "—"}` : "等待 Agent 注册表推送"}
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

				{tab === "skills" && <SkillsView agentId={agentId} />}

				{tab === "cron" && (
					<div>
						<div className="mb-5">
							<button type="button" className="btn btn-sm" disabled title="cron wire 命令待后端（缺口 B4）">
								+ 新建定时任务（待后端命令）
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
									<button
										type="button"
										className="cbtn shrink-0 border border-hairline"
										disabled
										title="cron wire 命令待后端（缺口 B4）"
									>
										暂停
									</button>
									<button
										type="button"
										className="cbtn shrink-0 border border-hairline"
										disabled
										title="cron wire 命令待后端（缺口 B4）"
									>
										立即运行
									</button>
									<button
										type="button"
										className="cbtn shrink-0 border border-hairline"
										disabled
										title="cron wire 命令待后端（缺口 B4）"
									>
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
						<h4 className="mb-3 text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
							host 工具注册（set_host_tools）
						</h4>
						{hostTools.length === 0 ? (
							<div className="rounded-lg border border-dashed border-hairline-strong bg-surface px-4 py-6 text-center text-[12px] text-ink-faint">
								尚未注册任何 host 工具。host tool 由前端声明（如浏览器/桌面能力），声明后 LLM 可调用，
								执行结果经 host_tool_result 帧回传（pi-client 裸帧能力待补）。
							</div>
						) : (
							<div className="divide-y divide-hairline rounded-lg border border-hairline bg-surface">
								{hostTools.map(t => (
									<div key={t.name} className="flex items-center gap-3 px-4 py-2.5">
										<span className="min-w-0 flex-1">
											<span className="block font-mono text-[13px] text-ink">{t.name}</span>
											<span className="block truncate text-[11px] text-ink-faint">{t.description}</span>
										</span>
										<button
											type="button"
											className="btn btn-secondary btn-sm shrink-0"
											onClick={() => unregisterHostTool(t.name)}
										>
											移除
										</button>
									</div>
								))}
							</div>
						)}
						<div className="mt-4 flex items-center gap-2">
							<input
								value={newHostName}
								onChange={e => setNewHostName(e.target.value)}
								placeholder="工具名（如 browser_capture）"
								className="min-w-0 flex-1 rounded border border-hairline bg-surface-2 px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-dim)]"
							/>
							<button type="button" className="btn btn-sm shrink-0" onClick={registerHostTool}>
								注册
							</button>
						</div>
						<div className="mt-3 text-[11px] text-ink-faint">
							set_host_tools 已实现：注册后 serve 推 host_tool_call 帧 → 前端执行 → host_tool_result
							回传（pi-client 裸帧发送待补）。session 内置工具开关 wire 面无命令，本 tab 为前端 host tool
							注册管理。
						</div>
					</div>
				)}

				{tab === "profile" && <ProfileView agentId={agentId} />}

				{tab === "files" && <FileExplorer agentId={agentId} />}

				{tab === "prompts" && <PromptsView agentId={agentId} />}

				<div className="mt-6">
					<button
						type="button"
						className="text-[12px] text-ink-muted no-underline hover:text-ink hover:underline"
						onClick={onClose}
					>
						← 返回 Agent 列表
					</button>
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

// ─────────────────────────────────────────────────────────────────────
// Skills tab：真实技能列表（fs_list 读 .omp/skills/，SKILL.md frontmatter 解析）
// ─────────────────────────────────────────────────────────────────────

interface SkillInfo {
	name: string;
	desc?: string;
	version?: string;
}

/** 解析 skills/<name>/SKILL.md 的 frontmatter（name/description/version）。 */
function parseFrontmatter(text: string): { desc?: string; version?: string; name?: string } {
	const out: { desc?: string; version?: string; name?: string } = {};
	const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
	if (!m) return out;
	for (const line of m[1].split("\n")) {
		const mm = line.match(/^(name|description|version)\s*:\s*(.+)$/);
		if (mm) {
			const val = mm[2].trim().replace(/^["']|["']$/g, "");
			if (mm[1] === "description") out.desc = val;
			else if (mm[1] === "version") out.version = val;
			else out.name = val;
		}
	}
	return out;
}

function SkillsView({ agentId }: { agentId: string }): React.JSX.Element {
	const store = useSessionStore();
	const view = useSession();
	const [skills, setSkills] = useState<SkillInfo[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		if (!view.connected) return; // 连接就绪后再拉，避免 fs_list 在握手期失败
		const load = async (): Promise<void> => {
			try {
				const { entries } = await store.fsList(agentId, ".omp/skills");
				const dirs = entries.filter(e => e.type === "dir");
				const infos = await Promise.all(
					dirs.map(async d => {
						// 读 SKILL.md frontmatter（可能不在顶层而在一级子目录，容错）
						try {
							const { text } = await store.fsRead(agentId, `.omp/skills/${d.name}/SKILL.md`);
							const fm = parseFrontmatter(text);
							return { name: fm.name ?? d.name, desc: fm.desc, version: fm.version };
						} catch {
							// 无 SKILL.md（纯目录/素材）——仅列目录名
							return { name: d.name };
						}
					}),
				);
				if (!cancelled) setSkills(infos);
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			}
		};
		void load();
		return () => {
			cancelled = true;
		};
	}, [agentId, store, view.connected]);

	if (error) {
		return <div className="px-1 py-3 text-[12px] text-danger">技能列表加载失败：{error}</div>;
	}
	if (!skills) {
		return <div className="px-1 py-3 text-[12px] text-ink-faint">加载中…</div>;
	}
	if (skills.length === 0) {
		return (
			<div className="px-1 py-8 text-center text-[12px] text-ink-faint">
				该 agent 没有已安装技能（.omp/skills/ 为空）
			</div>
		);
	}

	return (
		<div>
			{skills.map(skill => (
				<div
					key={skill.name}
					className="flex items-baseline gap-3 border-b border-hairline px-1 py-3.5 transition-colors hover:bg-surface"
				>
					<span className="w-[220px] shrink-0 font-mono text-[13px] font-medium text-ink">{skill.name}</span>
					<span className="min-w-0 flex-1 text-[12px] text-ink-subtle">{skill.desc ?? "—"}</span>
					<span className="shrink-0 font-mono text-[12px] text-ink-faint">{skill.version ?? ""}</span>
					<button
						type="button"
						className="toggle shrink-0 on"
						aria-checked={true}
						role="switch"
						disabled
						title="技能启停待 set_skill_enabled 协议（后端缺口 B3）"
					/>
				</div>
			))}
			<div className="mt-3 text-[11px] text-ink-faint">
				{skills.length} 个已安装技能（.omp/skills/ 真实列表）；启用/停用待 set_skill_enabled 协议。
			</div>
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────
// 用户画像 tab：真实数据源 agentDir/user.md（declarative persona）+
// mission.md（agent 职责）——fs_read 读取，替代原硬编码文案
// ─────────────────────────────────────────────────────────────────────

function ProfileView({ agentId }: { agentId: string }): React.JSX.Element {
	const store = useSessionStore();
	const view = useSession();
	const [userMd, setUserMd] = useState<string | null>(null);
	const [missionMd, setMissionMd] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		if (!view.connected) return; // 连接就绪后再拉
		const load = async (): Promise<void> => {
			try {
				const [u, m] = await Promise.all([
					store.fsRead(agentId, "user.md").catch(() => null),
					store.fsRead(agentId, "mission.md").catch(() => null),
				]);
				if (cancelled) return;
				setUserMd(u?.text ?? null);
				setMissionMd(m?.text ?? null);
				if (!u && !m) setError("该 agent 没有 user.md / mission.md（画像未配置）");
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			}
		};
		void load();
		return () => {
			cancelled = true;
		};
	}, [agentId, store, view.connected]);

	if (error && !userMd && !missionMd) {
		return <div className="px-1 py-6 text-[12px] text-ink-faint">{error}</div>;
	}

	return (
		<div className="flex flex-col gap-6">
			{missionMd && (
				<section>
					<h4 className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
						mission.md（agent 职责）
					</h4>
					<pre className="max-h-[260px] overflow-auto whitespace-pre-wrap rounded-lg border border-hairline bg-surface px-4 py-3 text-[13px] leading-relaxed text-ink-muted">
						{missionMd}
					</pre>
				</section>
			)}
			{userMd && (
				<section>
					<h4 className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
						user.md（用户画像声明）
					</h4>
					<pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-lg border border-hairline bg-surface px-4 py-3 text-[13px] leading-relaxed text-ink-muted">
						{userMd}
					</pre>
				</section>
			)}
			<div className="text-[11px] text-ink-faint">
				画像数据来自 agentDir/user.md + mission.md（fs_read 真读）；钉钉对话实时建模待连接器只读路径（缺口 B5）。
			</div>
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────
// Prompts tab：聚合 agent 的各类 prompt 配置源
// ─────────────────────────────────────────────────────────────────────

const FS_MAX_READ_HINT = ">128KB 仅显示前段";

interface PromptSource {
	path: string;
	title: string;
	desc: string;
}

const PROMPT_SOURCES: PromptSource[] = [
	{ path: "mission.md", title: "mission.md", desc: "agent 使命/人格定义（工作方式与长期目标）" },
	{ path: "user.md", title: "user.md", desc: "用户身份声明（草稿/权威版本之一）" },
	{ path: ".omp/SYSTEM.md", title: ".omp/SYSTEM.md", desc: "Gateway Agent 系统提示词（IM 场景纪律）" },
	{ path: "AGENTS.md", title: "AGENTS.md", desc: "仓库级 agent 指南（项目规则/约定）" },
	{ path: "AGENTS-personal.md", title: "AGENTS-personal.md", desc: "个人版 agent 指南（若存在）" },
	{ path: "CONTEXT.md", title: "CONTEXT.md", desc: "长期上下文/背景注入" },
	{ path: "prompt-includes.json", title: "prompt-includes.json", desc: "系统提示注入清单（插件/技能白名单）" },
];

function PromptsView({ agentId }: { agentId: string }): React.JSX.Element {
	const store = useSessionStore();
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [content, setContent] = useState<{ text: string; truncated: boolean } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const open = async (path: string): Promise<void> => {
		setSelectedPath(path);
		setLoading(true);
		setError(null);
		// 文件不存在是常态（如 AGENTS-personal.md 可能没有）——失败标记为不可用而非报错
		try {
			const result = await store.fsRead(agentId, path);
			setContent(result);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setContent(null);
		}
		setLoading(false);
	};

	return (
		<div className="grid min-h-0 grid-cols-[minmax(220px,320px)_1fr] gap-4">
			<div className="rounded-lg border border-hairline bg-surface py-1">
				{PROMPT_SOURCES.map(s => (
					<button
						key={s.path}
						type="button"
						className={`flex w-full cursor-pointer flex-col gap-0.5 px-3 py-2.5 text-left transition-colors hover:bg-surface-2 ${selectedPath === s.path ? "bg-accent-dim" : ""}`}
						onClick={() => void open(s.path)}
					>
						<span className="font-mono text-[12.5px] font-medium text-ink">{s.title}</span>
						<span className="text-[11px] leading-snug text-ink-faint">{s.desc}</span>
					</button>
				))}
			</div>
			<div className="min-h-0 overflow-auto rounded-lg border border-hairline bg-surface px-4 py-3">
				{loading && <div className="py-8 text-center text-[12px] text-ink-faint">加载中…</div>}
				{!loading && selectedPath && content && (
					<>
						<div className="mb-2 flex items-center gap-2">
							<span className="truncate font-mono text-[12px] font-medium text-ink">{selectedPath}</span>
							{content.truncated && <span className="badge fail">{FS_MAX_READ_HINT}</span>}
						</div>
						<pre className="max-h-[420px] overflow-auto whitespace-pre-wrap text-[12px] leading-relaxed text-ink-muted">
							{content.text}
						</pre>
					</>
				)}
				{!loading && selectedPath && error && (
					<div className="py-8 text-center text-[12px] text-ink-faint">该文件不存在或不可读（{error}）</div>
				)}
				{!loading && !selectedPath && (
					<div className="py-10 text-center text-[12px] text-ink-faint">点击左侧浏览 agent 的各份 prompt 配置</div>
				)}
			</div>
		</div>
	);
}
