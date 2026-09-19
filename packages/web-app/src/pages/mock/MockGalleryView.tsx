import {
	ArrowUpRight,
	Bot,
	Brain,
	CalendarClock,
	ChevronRight,
	Cpu,
	FileText,
	FolderOpen,
	Gauge,
	GitBranch,
	History,
	House,
	Image,
	Layers3,
	ListChecks,
	Mic,
	PanelRight,
	Settings2,
	Sparkles,
	WandSparkles,
} from "lucide-react";
import { useState } from "react";

const PAGES = [
	["home", "首页", House],
	["workspace", "会话工作台", Layers3],
	["records", "会话记录", History],
	["agents", "Agent 总览", Bot],
	["skills", "Skills", Sparkles],
	["memory", "Memory", Brain],
	["todo", "Todo", ListChecks],
	["models", "模型", Cpu],
	["voice", "语音", Mic],
	["tasks", "定时任务", CalendarClock],
	["insights", "用量", Gauge],
	["settings", "设置", Settings2],
] as const;
type PageId = (typeof PAGES)[number][0];

// All content is deliberately local fixture data; no service or business state is read or written.
const AGENTS = [
	{
		id: "default",
		name: "个人助理",
		role: "经营与日常协调",
		status: "运行中",
		workspace: "cornfield",
		work: "整理 DTC 本周经营数据",
		reply: "本周经营数据已整理。请确认区域目标与转化差异，再讨论预算建议。",
		todo: "确认直营渠道的区域目标",
		task: "weekly-dtc-report",
		schedule: "每周一 09:00",
		taskStatus: "已暂停",
		skill: "经营分析",
		discover: "会议整理",
		memory: "DTC 区域目标按国内与海外拆分",
		preference: "短句沟通，预算只出建议",
		model: "deepseek-v4-flash",
		inherit: true,
		requests: 420,
		tokens: 1600000,
		cost: 42,
	},
	{
		id: "hr",
		name: "人力伙伴",
		role: "招聘与组织",
		status: "待确认",
		workspace: "people",
		work: "候选人面试反馈",
		reply: "两位候选人的反馈已汇总。录用判断需要你确认，不会自动发出通知。",
		todo: "确认候选人的下一轮面试安排",
		task: "hiring-context-refresh",
		schedule: "每天 08:00",
		taskStatus: "运行中",
		skill: "招聘评估",
		discover: "组织调研",
		memory: "本周重点：行为智能岗位面试",
		preference: "面试反馈区分事实与判断",
		model: "MiniMax-M2.5",
		inherit: false,
		requests: 240,
		tokens: 800000,
		cost: 24,
	},
	{
		id: "algorithm",
		name: "算法伙伴",
		role: "模型与评估",
		status: "已完成",
		workspace: "robot-learning",
		work: "模型评估报告",
		reply: "评估报告已完成，已区分离线指标与真实场景结果，建议先复核失败样本。",
		todo: "复核抓取失败样本",
		task: "daily-eval-sync",
		schedule: "每天 20:00",
		taskStatus: "运行中",
		skill: "模型评估",
		discover: "论文研究",
		memory: "评估优先覆盖家庭场景长尾样本",
		preference: "报告必须标注实验条件",
		model: "deepseek-v4-flash",
		inherit: true,
		requests: 180,
		tokens: 1200000,
		cost: 18,
	},
	{
		id: "sw",
		name: "软件伙伴",
		role: "软件系统与质量",
		status: "空闲",
		workspace: "client",
		work: "客户端语音回归记录",
		reply: "语音回归记录已整理。弱网恢复与权限拒绝仍需单独验证。",
		todo: "验证弱网下的语音恢复",
		task: "weekly-quality-review",
		schedule: "每周五 16:00",
		taskStatus: "已暂停",
		skill: "代码审查",
		discover: "回归分析",
		memory: "客户端采用统一内核与多端适配",
		preference: "变更必须附验证证据",
		model: "qwen3-coder-plus",
		inherit: false,
		requests: 160,
		tokens: 600000,
		cost: 16,
	},
] as const;
type Agent = (typeof AGENTS)[number];
type AgentId = Agent["id"];
type Scope = AgentId | "all";
const CARD = "min-w-0 rounded-xl border border-hairline bg-surface p-4";

function SectionTitle({ title, eyebrow }: { title: string; eyebrow?: string }): React.JSX.Element {
	return (
		<div className="mb-5">
			<div className="mb-1 text-[11px] tracking-[0.1em] text-ink-faint">{eyebrow}</div>
			<h1 className="text-[28px] font-semibold tracking-[-0.7px]">{title}</h1>
		</div>
	);
}

function AgentPicker({
	value,
	onChange,
	all = false,
}: {
	value: Scope;
	onChange: (value: Scope) => void;
	all?: boolean;
}): React.JSX.Element {
	return (
		<label className="flex min-w-0 flex-wrap items-center gap-2 text-[12px] text-ink-subtle">
			{all ? "筛选 Agent" : "当前 Agent"}
			<select
				aria-label={all ? "筛选 Agent" : "当前 Agent"}
				className="min-w-0 max-w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-ink"
				value={value}
				onChange={event => {
					const next = event.target.value;
					if (next === "all" && all) onChange("all");
					else if (AGENTS.some(agent => agent.id === next)) onChange(next as AgentId);
				}}
			>
				{all && <option value="all">全部 Agent</option>}
				{AGENTS.map(agent => (
					<option key={agent.id} value={agent.id}>
						{agent.id} · {agent.name}
					</option>
				))}
			</select>
		</label>
	);
}

function Tabs({
	options,
	value,
	onChange,
}: {
	options: readonly string[];
	value: string;
	onChange: (value: string) => void;
}): React.JSX.Element {
	return (
		<div className="mb-4 flex flex-wrap gap-1" aria-label="分类" role="tablist">
			{options.map(option => (
				<button
					type="button"
					key={option}
					aria-pressed={value === option}
					onClick={() => onChange(option)}
					className={`rounded-lg px-3 py-2 text-[12px] ${value === option ? "bg-accent text-on-accent" : "bg-surface-2 text-ink-subtle"}`}
				>
					{option}
				</button>
			))}
		</div>
	);
}

function HomeMock({ agent, navigate }: { agent: Agent; navigate: (page: PageId) => void }): React.JSX.Element {
	return (
		<div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_280px]">
			<div className="min-w-0">
				<SectionTitle eyebrow="示例工作日 · 9 月 19 日" title="晚上好，彭梦龙" />
				<p className="mb-6 text-[14px] text-ink-subtle">
					{agent.name}负责{agent.role}，当前状态：{agent.status}。
				</p>
				<div className={CARD}>
					<div className="mb-3 text-[12px] text-ink-subtle">交代一件事 · 发送给 {agent.id}</div>
					<p className="min-h-28 rounded-lg bg-surface-2 p-4 text-[14px]">示例指令：{agent.work}</p>
					<div className="mt-4 flex flex-wrap items-center justify-between gap-3">
						<span className="text-[11px] text-ink-faint">工作区：{agent.workspace}</span>
						<button type="button" className="btn flex items-center gap-2" onClick={() => navigate("workspace")}>
							预览会话 <ArrowUpRight size={14} />
						</button>
					</div>
				</div>
				<h2 className="mb-3 mt-6 text-[15px] font-medium">{agent.id} 的最近工作</h2>
				<div className={CARD}>
					<FileText size={16} className="mb-2 text-ink-subtle" />
					<p className="text-[13px]">{agent.work}</p>
					<p className="mt-2 text-[12px] text-ink-faint">{agent.reply}</p>
				</div>
			</div>
			<aside className="space-y-4">
				<div className={CARD}>
					<h2 className="mb-3 text-[13px] font-medium">当前 Agent 待办</h2>
					<p className="text-[13px]">{agent.todo}</p>
					<button type="button" className="mt-4 text-[12px] text-info" onClick={() => navigate("todo")}>
						查看全部 Agent 待办 →
					</button>
				</div>
				<div className={CARD}>
					<h2 className="mb-3 text-[13px] font-medium">全局 · Agent 状态</h2>
					{AGENTS.map(item => (
						<div
							className="flex flex-wrap justify-between gap-2 border-t border-hairline py-3 text-[12px]"
							key={item.id}
						>
							<span>{item.id}</span>
							<span className="text-ink-subtle">{item.status}</span>
						</div>
					))}
				</div>
			</aside>
		</div>
	);
}

function WorkspaceMock({ agent }: { agent: Agent }): React.JSX.Element {
	const [panelTab, setPanelTab] = useState<"files" | "artifacts" | "changes">("files");
	const [panelOpen, setPanelOpen] = useState(false);
	const [selection, setSelection] = useState<{ owner: AgentId; name: string; source: string } | null>(null);
	const [folderOpen, setFolderOpen] = useState(true);
	const tabs = [
		{ id: "files" as const, label: "文件", icon: FolderOpen },
		{ id: "artifacts" as const, label: "产物", icon: Image },
		{ id: "changes" as const, label: "改动", icon: GitBranch },
	];
	const session = `${agent.id} / ${agent.work}`;
	const files = [`${agent.id}-brief.md`, `${agent.id}-report.md`];
	const selected = selection?.owner === agent.id ? selection : null;
	const preview = selected ? (
		<section className="mt-4 rounded-lg border border-hairline bg-surface p-3" aria-label="示例文件预览">
			<div className="flex items-start justify-between gap-2">
				<h3 className="break-all text-[13px] font-medium">{selected.name}</h3>
				<button
					type="button"
					aria-label="关闭文件预览"
					onClick={() => setSelection(null)}
					className="text-[11px] text-ink-subtle"
				>
					关闭
				</button>
			</div>
			<p className="my-2 text-[11px] text-ink-faint">{selected.source} · 只读示例</p>
			<p className="text-[13px] leading-6">{agent.reply}</p>
			<p className="mt-3 text-[12px] text-ink-subtle">下一步：{agent.todo}</p>
		</section>
	) : (
		<p className="mt-4 rounded-lg border border-dashed border-hairline p-4 text-[12px] text-ink-subtle">
			选择文件查看示例内容。这里不读取或保存真实文件。
		</p>
	);
	return (
		<div
			className={`grid min-h-[540px] gap-4 lg:grid-cols-[180px_minmax(0,1fr)] ${panelOpen ? "xl:grid-cols-[180px_minmax(0,1fr)_320px]" : ""}`}
		>
			<aside className={`${CARD} hidden lg:block`}>
				<h2 className="mb-3 text-[12px] font-medium">当前 Agent 会话</h2>
				<div className="rounded-lg bg-accent p-3 text-[12px] text-on-accent">
					<p>{agent.id}</p>
					<p className="mt-1">{agent.work}</p>
				</div>
			</aside>
			<section className={`${CARD} flex min-w-0 flex-col`}>
				<div className="flex items-start justify-between gap-3 border-b border-hairline pb-4">
					<div className="min-w-0">
						<h1 className="text-[16px] font-medium">{agent.work}</h1>
						<p className="mt-1 text-[11px] text-ink-faint">
							{agent.id} · {agent.workspace} · 示例会话
						</p>
					</div>
					<button
						type="button"
						className="btn btn-secondary shrink-0 px-2 py-1 text-[11px]"
						aria-label={panelOpen ? "收起右侧辅助面板" : "打开右侧辅助面板"}
						aria-expanded={panelOpen}
						onClick={() => setPanelOpen(value => !value)}
					>
						<PanelRight size={14} />
						<span>{panelOpen ? "收起" : "文件与产物"}</span>
					</button>
				</div>
				<div className="flex-1 space-y-6 py-6">
					<div className="rounded-xl bg-accent p-4 text-[13px] text-on-accent">请帮我完成：{agent.work}</div>
					<p className="text-[14px] leading-7">{agent.reply}</p>
				</div>
				<div className="rounded-xl bg-surface-2 p-4 text-[13px] text-ink-faint">
					发送给 {agent.id} · 静态预览，不发送消息
				</div>
			</section>
			{panelOpen && (
				<>
					<button
						type="button"
						className="fixed inset-0 z-40 bg-black/25 xl:hidden"
						aria-label="关闭右栏遮罩"
						onClick={() => setPanelOpen(false)}
					/>
					<aside
						className={`${CARD} fixed inset-y-0 right-0 z-50 w-[min(360px,100vw)] overflow-y-auto shadow-xl xl:static xl:z-auto xl:w-auto xl:shadow-none`}
						aria-label="会话工作台右侧辅助面板"
						onKeyDown={event => {
							if (event.key === "Escape") setPanelOpen(false);
						}}
					>
						<div className="mb-3 flex items-center justify-between">
							<h2 className="text-[14px] font-medium">会话资源</h2>
							<button
								type="button"
								aria-label="关闭右侧辅助面板"
								onClick={() => setPanelOpen(false)}
								className="text-[12px] text-ink-subtle"
							>
								关闭
							</button>
						</div>
						<div className="mb-4 rounded-lg bg-surface-2 p-3 text-[11px] leading-5">
							<p className="font-medium">{session}</p>
							<p className="text-ink-subtle">工作区：{agent.workspace}</p>
							<p className="text-ink-faint">固定示例 · 不连接真实文件系统</p>
						</div>
						<div className="mb-4 flex border-b border-hairline" role="tablist" aria-label="右侧辅助面板标签">
							{tabs.map(({ id, label, icon: Icon }) => (
								<button
									type="button"
									role="tab"
									key={id}
									id={`mock-${id}`}
									aria-controls="mock-right-content"
									aria-selected={panelTab === id}
									aria-label={`右侧面板${label}标签`}
									onClick={() => {
										setPanelTab(id);
										setSelection(null);
									}}
									className={`flex flex-1 items-center justify-center gap-1 border-b-2 py-2 text-[12px] ${panelTab === id ? "border-accent text-ink" : "border-transparent text-ink-subtle"}`}
								>
									<Icon size={13} />
									{label}
								</button>
							))}
						</div>
						<div role="tabpanel" id="mock-right-content" aria-labelledby={`mock-${panelTab}`}>
							{panelTab === "files" && (
								<>
									<button
										type="button"
										aria-expanded={folderOpen}
										className="flex w-full items-center gap-2 rounded-lg bg-surface-2 p-2 text-[12px]"
										onClick={() => setFolderOpen(value => !value)}
									>
										<FolderOpen size={14} />
										{folderOpen ? "收起" : "展开"} docs / {agent.id}
									</button>
									{folderOpen &&
										files.map(name => (
											<button
												key={name}
												type="button"
												className="mt-1 flex w-full items-center gap-2 rounded-lg py-2 pl-4 text-left text-[12px] hover:bg-surface-2"
												onClick={() => setSelection({ owner: agent.id, name, source: session })}
											>
												<FileText size={13} />
												{name}
											</button>
										))}
									{preview}
								</>
							)}
							{panelTab === "artifacts" && (
								<>
									<p className="mb-3 text-[11px] text-ink-subtle">仅本示例会话的产物，不混入其他会话。</p>
									{[`${agent.id}-summary.md`, `${agent.id}-analysis.md`].map(name => (
										<button
											key={name}
											type="button"
											className="mb-2 block w-full rounded-lg bg-surface-2 p-3 text-left"
											onClick={() =>
												setSelection({ owner: agent.id, name, source: `本会话产物 / ${session}` })
											}
										>
											<span className="block break-all text-[12px] font-medium">{name}</span>
											<span className="mt-1 block text-[11px] text-ink-subtle">Markdown · 点击预览</span>
										</button>
									))}
									{selected && preview}
								</>
							)}
							{panelTab === "changes" && (
								<>
									<p className="mb-3 text-[11px] leading-5 text-ink-subtle">
										按读取来源分组，不代表是谁修改的；同一工作区可能被多个会话使用。
									</p>
									{["本会话工作区", "子会话读取来源"].map((source, index) => (
										<section className="mb-4 rounded-lg border border-hairline p-3" key={source}>
											<h3 className="text-[12px] font-medium">{source}</h3>
											<p className="my-1 text-[11px] text-ink-faint">
												{agent.workspace} · {index === 0 ? agent.work : `${agent.id} / 资料核对示例`}
											</p>
											<button
												type="button"
												className="mt-2 flex w-full items-center gap-2 rounded bg-surface-2 p-2 text-left text-[12px]"
												onClick={() => {
													setSelection({ owner: agent.id, name: files[index], source });
													setPanelTab("files");
												}}
											>
												<span className="text-warning">M</span>
												<span className="min-w-0 break-all">docs/{files[index]}</span>
											</button>
										</section>
									))}
									<p className="text-[11px] text-ink-faint">
										点击打开示例文件；不提供虚构 diff、提交或回滚操作。
									</p>
								</>
							)}
						</div>
					</aside>
				</>
			)}
		</div>
	);
}

type ListKind = "records" | "todo" | "tasks";
function ListMock({ kind }: { kind: ListKind }): React.JSX.Element {
	const [scope, setScope] = useState<Scope>("all");
	const [category, setCategory] = useState("全部");
	const options = kind === "tasks" ? ["全部", "运行中", "已暂停"] : ["全部", "待确认", "已完成"];
	const groups = AGENTS.filter(agent => scope === "all" || agent.id === scope).filter(
		agent =>
			category === "全部" ||
			(kind === "tasks" ? agent.taskStatus : kind === "todo" ? "待确认" : agent.status) === category,
	);
	return (
		<div>
			<SectionTitle
				eyebrow="跨 Agent 工作 · 按归属分组"
				title={kind === "records" ? "会话记录" : kind === "todo" ? "待办" : "定时任务"}
			/>
			<div className="mb-4">
				<AgentPicker value={scope} onChange={setScope} all />
			</div>
			<Tabs options={options} value={category} onChange={setCategory} />
			<div className="space-y-4">
				{groups.map(agent => (
					<section className={CARD} key={agent.id}>
						<h2 className="mb-3 text-[13px] font-medium">
							{agent.id} · {agent.name} <span className="text-[11px] font-normal text-ink-faint">1 项示例</span>
						</h2>
						<div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-3">
							<div className="min-w-0">
								<p className="break-words text-[13px]">
									{kind === "records" ? agent.work : kind === "todo" ? agent.todo : agent.task}
								</p>
								<p className="mt-1 text-[11px] text-ink-faint">
									{kind === "tasks" ? agent.schedule : "9 月 19 日 · 示例"}
								</p>
							</div>
							<span className="rounded-full bg-surface-2 px-2 py-1 text-[11px] text-ink-subtle">
								{kind === "tasks" ? agent.taskStatus : kind === "todo" ? "待确认" : agent.status}
							</span>
						</div>
					</section>
				))}
				{groups.length === 0 && <p className={CARD}>该筛选下没有示例记录。</p>}
			</div>
		</div>
	);
}

function KnowledgeMock({ kind, agent }: { kind: "skills" | "memory"; agent: Agent }): React.JSX.Element {
	const options = kind === "skills" ? ["已加载", "可发现"] : ["用户偏好", "Agent 事实", "项目知识"];
	const [category, setCategory] = useState(options[0]);
	const content =
		kind === "skills"
			? category === "已加载"
				? agent.skill
				: agent.discover
			: category === "用户偏好"
				? agent.preference
				: category === "Agent 事实"
					? `${agent.name}负责${agent.role}，工作区为 ${agent.workspace}`
					: agent.memory;
	return (
		<div>
			<SectionTitle eyebrow={`${agent.id} · 独立能力与知识`} title={kind === "skills" ? "Skills" : "Memory"} />
			<Tabs options={options} value={category} onChange={setCategory} />
			<div className={CARD}>
				<p className="mb-2 text-[11px] text-ink-faint">
					{agent.id} / {category} / 示例
				</p>
				<h2 className="text-[15px] font-medium">{content}</h2>
				<p className="mt-3 text-[12px] text-ink-subtle">
					{kind === "skills"
						? `服务于${agent.role}；仅展示该 Agent 的技能。`
						: "此处是所选 Agent 的知识视图，不与其他 Agent 合并。"}
				</p>
			</div>
		</div>
	);
}

function AgentsMock({ open }: { open: (id: AgentId) => void }): React.JSX.Element {
	return (
		<div>
			<SectionTitle eyebrow="团队 · 全部 Agent" title="Agent 总览" />
			<div className="grid gap-4 sm:grid-cols-2">
				{AGENTS.map(agent => (
					<article className={CARD} key={agent.id}>
						<div className="mb-4 flex items-center gap-3">
							<Bot size={22} />
							<div className="min-w-0 flex-1">
								<h2 className="text-[15px] font-medium">{agent.name}</h2>
								<p className="text-[11px] text-ink-faint">
									{agent.id} · {agent.role}
								</p>
							</div>
							<span className="text-[11px] text-ink-subtle">{agent.status}</span>
						</div>
						<p className="text-[13px]">{agent.work}</p>
						<p className="mt-2 text-[11px] text-ink-faint">工作区：{agent.workspace}</p>
						<button type="button" className="btn btn-secondary mt-4 text-[12px]" onClick={() => open(agent.id)}>
							进入该 Agent 工作台
						</button>
					</article>
				))}
			</div>
		</div>
	);
}

function ModelsMock({ agent }: { agent: Agent }): React.JSX.Element {
	return (
		<div>
			<SectionTitle eyebrow="配置 · 全局资源与 Agent 选择分开" title="模型" />
			<section className={`${CARD} mb-5`}>
				<h2 className="mb-3 text-[14px] font-medium">全局 · Provider 与模型目录</h2>
				<p className="text-[12px] text-ink-subtle">
					示例 Provider：Bailian · 供所有 Agent 共享，不随 Agent 重复配置
				</p>
				<div className="mt-4 grid gap-3 sm:grid-cols-3">
					{["deepseek-v4-flash", "qwen3-coder-plus", "MiniMax-M2.5"].map(model => (
						<div className="min-w-0 break-words rounded-lg bg-surface-2 p-3 text-[12px]" key={model}>
							{model}
						</div>
					))}
				</div>
				<p className="mt-3 text-[12px]">全局默认：deepseek-v4-flash</p>
			</section>
			<section className={CARD}>
				<h2 className="text-[14px] font-medium">Agent · {agent.id} 的模型策略</h2>
				<p className="mt-3 text-[20px] font-medium">{agent.model}</p>
				<p className="mt-2 text-[12px] text-ink-subtle">
					{agent.inherit ? "继承全局默认" : "Agent 独立覆盖全局默认"} · 示例配置，只读
				</p>
			</section>
		</div>
	);
}

function InsightsMock(): React.JSX.Element {
	const [scope, setScope] = useState<Scope>("all");
	const agents = AGENTS.filter(agent => scope === "all" || agent.id === scope);
	const totals = agents.reduce(
		(sum, agent) => ({
			requests: sum.requests + agent.requests,
			tokens: sum.tokens + agent.tokens,
			cost: sum.cost + agent.cost,
		}),
		{ requests: 0, tokens: 0, cost: 0 },
	);
	return (
		<div>
			<SectionTitle eyebrow="最近 30 天 · 固定示例，不代表实际账单" title="用量概览" />
			<div className="mb-5">
				<AgentPicker value={scope} onChange={setScope} all />
			</div>
			<h2 className="mb-3 text-[14px] font-medium">{scope === "all" ? "全局汇总" : `${scope} 用量`}</h2>
			<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
				{[
					["请求次数", totals.requests.toLocaleString()],
					["总 Tokens", totals.tokens.toLocaleString()],
					["Agent 数", agents.length],
					["估算成本", `¥${totals.cost.toFixed(2)}`],
				].map(([label, value]) => (
					<div className={CARD} key={label}>
						<p className="text-[11px] text-ink-faint">{label}</p>
						<p className="mt-2 text-[24px] font-semibold">{value}</p>
					</div>
				))}
			</div>
			<section className={`${CARD} mt-5`}>
				<h2 className="mb-4 text-[14px] font-medium">示例趋势 · 最近 7 天</h2>
				<div className="flex h-36 items-end gap-2 border-b border-hairline pb-2">
					{[42, 58, 48, 76, 64, 88, 70].map((value, index) => (
						<div className="flex h-full min-w-0 flex-1 flex-col justify-end items-center gap-2" key={index}>
							<div
								className="w-full rounded-t bg-accent"
								style={{ height: `${value * (scope === "all" ? 1 : agents[0].requests / 1000)}%` }}
								aria-label={`第 ${index + 1} 日示例趋势`}
							/>
							<span className="text-[10px] text-ink-faint">{index + 1}日</span>
						</div>
					))}
				</div>
			</section>
			<section className={`${CARD} mt-5`}>
				<h2 className="mb-4 text-[14px] font-medium">按 Agent 统计</h2>
				{agents.map(agent => (
					<div className="mb-5 last:mb-0" key={agent.id}>
						<div className="mb-2 flex flex-wrap justify-between gap-2 text-[12px]">
							<span>
								{agent.id} · {agent.name}
							</span>
							<span className="text-ink-subtle">
								{agent.requests} 次 / {agent.tokens.toLocaleString()} Tokens / ¥{agent.cost.toFixed(2)}
							</span>
						</div>
						<div className="h-2 rounded-full bg-surface-2">
							<div
								className="h-2 rounded-full bg-accent"
								style={{ width: `${(agent.requests / Math.max(totals.requests, 1)) * 100}%` }}
							/>
						</div>
					</div>
				))}
			</section>
		</div>
	);
}

function SettingsMock({ agent }: { agent: Agent }): React.JSX.Element {
	const [section, setSection] = useState<"global" | "agent">("global");
	return (
		<div>
			<SectionTitle eyebrow="设置 · 作用域明确" title="全局与 Agent 设置" />
			<div className="mb-5 flex flex-wrap gap-1" aria-label="设置二级导航" role="tablist">
				<button
					type="button"
					aria-pressed={section === "global"}
					onClick={() => setSection("global")}
					className={`rounded-lg px-3 py-2 text-[12px] ${section === "global" ? "bg-accent text-on-accent" : "bg-surface-2 text-ink-subtle"}`}
				>
					全局
				</button>
				<button
					type="button"
					aria-pressed={section === "agent"}
					onClick={() => setSection("agent")}
					className={`rounded-lg px-3 py-2 text-[12px] ${section === "agent" ? "bg-accent text-on-accent" : "bg-surface-2 text-ink-subtle"}`}
				>
					Agent
				</button>
			</div>
			<p className="mb-4 text-[11px] text-ink-faint">
				当前 Agent：{agent.id} · {section === "global" ? "正在查看全局设置" : "正在查看所选 Agent 设置"}
			</p>
			<div className="grid gap-5 xl:grid-cols-2">
				<section className={`${CARD} ${section === "global" ? "ring-1 ring-accent/40" : ""}`}>
					<h2 className="text-[15px] font-medium">全局 · 应用设置</h2>
					<p className="mb-4 mt-2 text-[12px] text-ink-subtle">所有 Agent 共享，仅配置一次</p>
					{[
						["Serve 连接示例", "ws://127.0.0.1:7891"],
						["外观", "跟随系统"],
						["语音设备", "系统默认麦克风"],
						["通知", "需要确认时提醒"],
					].map(([label, value]) => (
						<div
							className="flex flex-wrap justify-between gap-2 border-t border-hairline py-3 text-[12px]"
							key={label}
						>
							<span className="text-ink-subtle">{label}</span>
							<span className="break-all">{value}</span>
						</div>
					))}
				</section>
				<section className={`${CARD} ${section === "agent" ? "ring-1 ring-accent/40" : ""}`}>
					<h2 className="text-[15px] font-medium">Agent · {agent.id}</h2>
					<p className="mb-4 mt-2 text-[12px] text-ink-subtle">所选 Agent 的示例配置，只读</p>
					{[
						["工作区", agent.workspace],
						["职责", agent.role],
						["沟通与约束", agent.preference],
						["模型策略", agent.inherit ? "继承全局" : "Agent 覆盖"],
					].map(([label, value]) => (
						<div className="border-t border-hairline py-3 text-[12px]" key={label}>
							<p className="text-ink-faint">{label}</p>
							<p className="mt-1">{value}</p>
						</div>
					))}
				</section>
			</div>
		</div>
	);
}

function VoiceMock({ agent }: { agent: Agent }): React.JSX.Element {
	const [preview, setPreview] = useState(false);
	return (
		<div className="mx-auto max-w-[760px]">
			<SectionTitle eyebrow={`${agent.id} · 中文普通话`} title="语音工作台" />
			<div className={`${CARD} py-8 text-center`}>
				<div className="mx-auto flex h-24 w-24 items-center justify-center rounded-full bg-accent text-on-accent">
					<Mic size={28} />
				</div>
				<h2 className="mt-6 text-[15px] font-medium">对 {agent.name} 交代一件事</h2>
				<p className="mt-2 text-[12px] text-ink-subtle">
					目标 Agent：{agent.id} · {agent.workspace}
				</p>
				<button type="button" className="btn mt-6" onClick={() => setPreview(value => !value)}>
					{preview ? "收起转写示例" : "预览语音转写"}
				</button>
				<p className="mt-3 text-[11px] text-ink-faint">不会访问麦克风，也不会发送指令</p>
				{preview && (
					<div className="mt-6 rounded-lg bg-surface-2 p-4 text-left text-[13px]">
						<p className="mb-2 text-[11px] text-ink-faint">{agent.id} · 示例转写</p>请帮我{agent.work}。
					</div>
				)}
			</div>
		</div>
	);
}

export function MockGalleryView(): React.JSX.Element {
	const [page, setPage] = useState<PageId>("home");
	const [agentId, setAgentId] = useState<AgentId>("default");
	const agent = AGENTS.find(item => item.id === agentId) ?? AGENTS[0];
	const current = PAGES.find(([id]) => id === page);
	const hasCurrentAgent = ["home", "workspace", "voice", "skills", "memory", "models", "settings"].includes(page);
	let content: React.JSX.Element;
	if (page === "home") content = <HomeMock agent={agent} navigate={setPage} />;
	else if (page === "workspace") content = <WorkspaceMock agent={agent} />;
	else if (page === "voice") content = <VoiceMock key={agent.id} agent={agent} />;
	else if (page === "skills" || page === "memory") content = <KnowledgeMock key={page} kind={page} agent={agent} />;
	else if (page === "records" || page === "todo" || page === "tasks") content = <ListMock key={page} kind={page} />;
	else if (page === "models") content = <ModelsMock agent={agent} />;
	else if (page === "settings") content = <SettingsMock agent={agent} />;
	else if (page === "insights") content = <InsightsMock />;
	else
		content = (
			<AgentsMock
				open={id => {
					setAgentId(id);
					setPage("workspace");
				}}
			/>
		);
	return (
		<div className="flex min-h-screen bg-canvas text-ink">
			<aside className="sticky top-0 hidden h-screen w-[220px] shrink-0 flex-col overflow-y-auto border-r border-hairline bg-surface px-3 py-4 lg:flex">
				<div className="px-3 pb-6 text-[17px] font-semibold">
					cornfield <span className="text-[10px] text-ink-faint">MOCK</span>
				</div>
				<nav className="space-y-0.5" aria-label="Mock 页面">
					{[
						{ title: "工作", ids: ["home", "workspace", "records"] },
						{ title: "Agent", ids: ["agents"] },
						{ title: "能力", ids: ["skills", "memory", "todo", "models", "voice"] },
						{ title: "系统", ids: ["tasks", "insights", "settings"] },
					].map(group => (
						<section key={group.title} className="mb-4">
							<h2 className="px-3 py-2 text-[11px] font-medium text-ink-faint">{group.title}</h2>
							{PAGES.filter(([id]) => group.ids.includes(id)).map(([id, label, Icon]) => (
								<button
									type="button"
									key={id}
									onClick={() => setPage(id)}
									aria-current={page === id ? "page" : undefined}
									className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[12.5px] ${page === id ? "bg-accent text-on-accent" : "text-ink-subtle hover:bg-surface-2"}`}
								>
									<Icon size={15} strokeWidth={1.7} />
									{label}
								</button>
							))}
						</section>
					))}
				</nav>
				<div className="mt-auto pt-6">
					<div className="rounded-xl bg-surface-2 p-3 text-[11px] leading-relaxed text-ink-subtle">
						<WandSparkles size={15} className="mb-2" />
						独立 Mock · 固定示例数据
						<br />
						不连接服务，不修改业务数据。
					</div>
				</div>
			</aside>
			<main className="min-w-0 flex-1">
				<header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b border-hairline bg-canvas/90 px-4 py-4 backdrop-blur sm:px-8">
					<div className="flex items-center gap-2 text-[12px] text-ink-faint">
						Mock <ChevronRight size={13} />
						<span className="text-ink-muted">{current?.[1]}</span>
					</div>
					<span className="text-[11px] text-ink-faint">示例数据 · 无真实操作</span>
				</header>
				<div className="mx-auto max-w-[1180px] px-4 py-6 [overflow-wrap:anywhere] sm:px-8">
					<label className="mb-5 block text-[12px] lg:hidden">
						页面
						<select
							aria-label="Mock 页面"
							className="mt-2 w-full rounded-lg border border-hairline bg-surface p-2"
							value={page}
							onChange={event => {
								const next = PAGES.find(([id]) => id === event.target.value);
								if (next) setPage(next[0]);
							}}
						>
							{PAGES.map(([id, label]) => (
								<option value={id} key={id}>
									{label}
								</option>
							))}
						</select>
					</label>
					{hasCurrentAgent && (
						<div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-hairline bg-surface-2 p-3">
							<AgentPicker
								value={agentId}
								onChange={id => {
									if (id !== "all") setAgentId(id);
								}}
							/>
							<span className="text-[11px] text-ink-faint">
								{agent.role} · {agent.workspace}
							</span>
						</div>
					)}
					{content}
				</div>
			</main>
		</div>
	);
}
