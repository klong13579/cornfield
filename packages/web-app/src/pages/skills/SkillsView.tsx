import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
	EvolvedSkillDto,
	EvolvedSkillsDto,
	RemoteSkillItemDto,
	Scope,
	SkillScopeRowDto,
	SkillsResultDto,
} from "../../lib/pi-client-api";
import { SCOPE_LABELS } from "../../lib/scope-display";
import { activeAgentIdOf } from "../../state/agent-context";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";
import {
	evolvedDeprecationText,
	evolvedGroupState,
	evolvedQualityText,
	evolvedRatingText,
	evolvedUsageText,
	evolvedVersionText,
	SKILL_ACTIVATION_LABELS,
	SKILL_OVERRIDE_RULE,
	SKILL_STATUS_LABELS,
	skillBlockedDetail,
	skillDayText,
	skillReasonText,
	skillStatusClass,
	skillVersionText,
} from "./skill-display";

/**
 * 技能工作台（T10B）—— 回答五个问题，每个都来自 serve 端既有事实源，前端不自己猜：
 *
 *   范围 scope        按 SKILL.md 路径相对 agentDir / 会话 Project root 判定（agent/project/global）
 *   来源 source       discovery 的 provider:level + SKILL.md 绝对路径
 *   版本 version      frontmatter 声明的版本（可能没有）+ 内容指纹 + mtime（文件系统真相）
 *   激活 activation   本次会话加载了（loaded）/ 磁盘上有但没进会话（discoverable）/ 被挡住（blocked）
 *   错误              发现警告（同名冲突、扫描失败、SKILL.md 读不到）
 *
 * 数据：serve get_skills（session.skills 同源 = agent 实际加载的技能集 + 停用名单 + 发现错误）。
 * 换 Agent 必须重读：列表锚在焦点 Agent（activeAgentIdOf）上，不重读就会把上一个 Agent 的
 * 技能显示成这一个的。
 *
 * 另外两栏与上面那套不是同一件事，分开展示、不合并：
 *   受阻技能  同名落选者（`name collision`）—— 先到者生效，后到的同名不加载（SKILL_OVERRIDE_RULE）；
 *           但 `blocked` 不只装同名：自定义目录的扫描告警也走这条（path 是目录），逐行看 serve 的原因。
 *   演化技能  get_evolved_skills 读 evolution.db 的 skills 表（提炼/评分/使用统计）。
 *           它与磁盘技能可以同名不同源；**读失败按错误显示，不显示成空组**。
 *
 * 顶部「开源 Skill Hub」（h2）：list_remote_skills 浏览远程技能市场 + install_remote_skill 装到本机 skills。
 */

/** 范围分组的展示顺序（本页专有：Agent 详情页不按范围分组）。 */
const SCOPE_ORDER: Scope[] = ["agent", "project", "global"];

export function SkillsView(): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const agentId = activeAgentIdOf(view);
	const [data, setData] = useState<SkillsResultDto | null>(null);
	const [query, setQuery] = useState("");
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const [showDisabled, setShowDisabled] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);

	// ── 演化技能（get_evolved_skills）：另一条命令、另一套事实，自己持有自己的状态 ──
	/** `null` = 还没读到（不是空组）；读失败走 evolvedError，不落进空清单。 */
	const [evolved, setEvolved] = useState<EvolvedSkillsDto | null>(null);
	const [evolvedError, setEvolvedError] = useState<string | null>(null);
	/** 展开详情的演化技能名（做法/工具/坑都在详情里，收起时只给统计行）。 */
	const [expandedEvolved, setExpandedEvolved] = useState<string | null>(null);
	/**
	 * 读取代际。两个列表锚在同一个焦点 Agent 上，所以共用一道门 —— 各自放行就会出现
	 * 「技能列表已经是新 Agent 的、演化技能还是旧的」这种半对半错的屏。
	 */
	const readGeneration = useRef(0);

	// ── 开源 Skill Hub（h2）：远程技能市场浏览 + 安装。remote 为 null = 尚未加载 ──
	const [remote, setRemote] = useState<RemoteSkillItemDto[] | null>(null);
	const [hubLoading, setHubLoading] = useState(false);
	const [hubError, setHubError] = useState<string | null>(null);
	/** 安装中的技能名（in-flight 防重入）。 */
	const [installingName, setInstallingName] = useState<string | null>(null);
	/** 安装成功提示（含 alreadyInstalled 的路径回显）。 */
	const [hubNotice, setHubNotice] = useState<string | null>(null);
	/** 本次会话已确认安装过的远程项（install 返回 alreadyInstalled 时也计入）。 */
	const [installedRemote, setInstalledRemote] = useState<ReadonlySet<string>>(new Set());
	/** Hub 详情展开中的远程项名（null = 全部收起）。 */
	const [expandedName, setExpandedName] = useState<string | null>(null);
	/** 折叠的分组：主组存 type（如「插件」），子组存 `${type}#${label}`。空集 = 全展开。 */
	const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
	const toggleGroup = (key: string): void => {
		setCollapsedGroups(prev => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};
	/** 远程项按 name 排序（稳定序号=排名；catalog 无评分字段，排序序号是唯一确定性排名语义）。 */
	const sortedRemote = useMemo(
		() => (remote ? [...remote].sort((a, b) => a.name.localeCompare(b.name)) : null),
		[remote],
	);

	/** Hub 分组：type 主分组（技能/插件）→ category 子分组（无 category 归「未分类」）。保留全局排名序号。 */
	const hubGroups = useMemo(() => {
		if (!sortedRemote) return null;
		const typeOrder = ["技能", "插件"] as const;
		const byType = new Map<string, Array<{ item: RemoteSkillItemDto; rank: number }>>();
		sortedRemote.forEach((item, rank) => {
			const key = item.type === "skill" ? "技能" : "插件";
			const list = byType.get(key) ?? [];
			list.push({ item, rank: rank + 1 });
			byType.set(key, list);
		});
		const groups: Array<{
			type: string;
			categories: Array<{ label: string; items: Array<{ item: RemoteSkillItemDto; rank: number }> }>;
		}> = [];
		for (const type of typeOrder) {
			const entries = byType.get(type);
			if (!entries || entries.length === 0) continue;
			const cats = new Map<string, typeof entries>();
			for (const e of entries) {
				const label = e.item.category?.trim() || "未分类";
				const list = cats.get(label) ?? [];
				list.push(e);
				cats.set(label, list);
			}
			groups.push({
				type,
				categories: [...cats.entries()]
					.sort(([a], [b]) => (a === "未分类" ? 1 : b === "未分类" ? -1 : a.localeCompare(b)))
					.map(([label, items]) => ({ label, items })),
			});
		}
		return groups;
	}, [sortedRemote]);

	/** 加载远程技能市场（list_remote_skills）：失败写 hubError，不崩页。 */
	const loadRemote = async (): Promise<void> => {
		if (!view.connected || hubLoading) return;
		setHubLoading(true);
		setHubError(null);
		setHubNotice(null);
		try {
			const items = await store.fetchRemoteSkills();
			setRemote(items);
		} catch (err) {
			setHubError(err instanceof Error ? err.message : String(err));
		} finally {
			setHubLoading(false);
		}
	};

	/**
	 * 重读本地技能列表与演化技能（焦点 Agent 定向；换 Agent / 启停后都走这一条）。
	 *
	 * 两条命令并行发、各记各的结果：它们问的是两件事（磁盘上装了什么 vs 演化系统沉淀了什么），
	 * 一条读失败不能连坐另一条 —— 也不能把失败的一方写成对方的空态。
	 */
	const refresh = async (): Promise<void> => {
		const ticket = ++readGeneration.current;
		const [skills, evolvedSkills] = await Promise.allSettled([
			store.fetchSkills(agentId),
			store.fetchEvolvedSkills(agentId),
		]);
		// 焦点 Agent 已经换了：这份答复答的是别人，两半一起丢。
		if (ticket !== readGeneration.current) return;
		if (skills.status === "fulfilled") {
			setData(skills.value);
			setError(null);
		} else {
			setData(null);
			setError(skills.reason instanceof Error ? skills.reason.message : String(skills.reason));
		}
		if (evolvedSkills.status === "fulfilled") {
			setEvolved(evolvedSkills.value);
			setEvolvedError(null);
		} else {
			setEvolved(null);
			setEvolvedError(
				evolvedSkills.reason instanceof Error ? evolvedSkills.reason.message : String(evolvedSkills.reason),
			);
		}
	};

	/** 安装远程技能（install_remote_skill）：成功后重拉本地技能列表（新装技能进列表/已安装态 disabled）。 */
	const installRemote = async (item: RemoteSkillItemDto): Promise<void> => {
		if (!view.connected || installingName) return;
		setInstallingName(item.name);
		setHubError(null);
		setHubNotice(null);
		try {
			const r = await store.installRemoteSkill(item.source, item.name);
			// 已安装（alreadyInstalled 或首次安装）都计入已安装态；路径回显给用户确认落点
			setInstalledRemote(prev => new Set(prev).add(item.name));
			setHubNotice(
				r.alreadyInstalled
					? `「${item.name}」已在 ${r.path}，无需重复安装`
					: `「${item.name}」安装完成 → ${r.path}`,
			);
			await refresh(); // 本地列表重拉：新技能出现在已启用/已停用分组
		} catch (err) {
			setHubError(`安装「${item.name}」失败：${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setInstallingName(null);
		}
	};

	/** 启停（P2-W3-3 B3 写协议）：写焦点 Agent 自己的配置，重发现后重拉列表。 */
	const toggleSkill = async (row: SkillScopeRowDto, enabled: boolean) => {
		if (busy) return;
		setBusy(row.name);
		try {
			await store.setSkillEnabled(row.name, enabled, agentId);
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	useEffect(() => {
		if (!view.connected) {
			setData(null);
			// 断开时两个列表一起清：留着一个页面的旧数据，重连后会在重读回来之前先露一次脸
			setEvolved(null);
			setEvolvedError(null);
			return;
		}
		void refresh();
		// 进入即拉远程技能市场；失败仅写 hubError（h1 契约命令 serve 端并行实现，未就绪时页面不崩）
		void store
			.fetchRemoteSkills()
			.then(setRemote)
			.catch(err => setHubError(err instanceof Error ? err.message : String(err)));
	}, [store, view.connected, agentId]);

	const loaded = data?.skills ?? [];
	const disabled = data?.disabled ?? [];
	const groups = useMemo(() => {
		const q = query.trim().toLowerCase();
		const filtered = q
			? loaded.filter(s => s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q))
			: loaded;
		return SCOPE_ORDER.map(scope => ({ scope, rows: filtered.filter(s => s.scope === scope) })).filter(
			group => group.rows.length > 0,
		);
	}, [loaded, query]);

	const disabledFiltered = useMemo(() => {
		const q = query.trim().toLowerCase();
		return q ? disabled.filter(d => d.name.toLowerCase().includes(q)) : disabled;
	}, [disabled, query]);

	/** 本地已存在的技能名（已启用 + 已停用）→ 远程条目同名视为已安装。 */
	const localInstalled = useMemo(() => {
		const names = new Set<string>();
		for (const s of loaded) names.add(s.name);
		for (const d of disabled) names.add(d.name);
		return names;
	}, [loaded, disabled]);
	const isInstalledRemote = (name: string): boolean => localInstalled.has(name) || installedRemote.has(name);

	/** 需要人看见的问题：Project registry 读不出来 + 发现阶段错误。
	 * 受阻技能（同名落选者）不在这里 —— 它不是「发现出错」，是「没轮到它」，另立一栏带覆盖规则。 */
	const problems = useMemo(() => {
		const items: Array<{ title: string; detail: string }> = [];
		if (data?.scope.projectError) {
			items.push({ title: "Project 归属未知", detail: data.scope.projectError });
		}
		for (const err of data?.errors ?? []) {
			items.push({ title: "发现错误", detail: err.path ? `${err.path} —— ${err.message}` : err.message });
		}
		return items;
	}, [data]);

	/** 演化技能分组的显示态（读失败 / 未连接 / 读中 / 空集 / 清单，五态分开）。 */
	const evolvedState = evolvedGroupState({ connected: view.connected, dto: evolved, error: evolvedError });

	/** 演化技能列表跟着同一个搜索框过滤（与本地技能一套规则，不搞两个过滤器）。 */
	const evolvedRows = useMemo(() => {
		const rows = evolved?.skills ?? [];
		const q = query.trim().toLowerCase();
		if (!q) return rows;
		return rows.filter(
			s =>
				s.name.toLowerCase().includes(q) ||
				s.description.toLowerCase().includes(q) ||
				s.taskPattern.toLowerCase().includes(q),
		);
	}, [evolved, query]);

	const toggleCollapsed = (level: string) => {
		setCollapsed(prev => {
			const next = new Set(prev);
			if (next.has(level)) next.delete(level);
			else next.add(level);
			return next;
		});
	};

	return (
		<div className="px-10 pt-8 pb-12">
			<div className="mx-auto page-narrow">
				<div className="mb-6 flex items-center justify-between gap-4">
					<h1 className="text-[32px] font-semibold tracking-[-0.8px] text-ink">技能</h1>
					<div className="flex items-center gap-3">
						<label className="flex items-center gap-1.5 text-2xs text-ink-subtle">
							<input
								type="checkbox"
								checked={showDisabled}
								onChange={e => setShowDisabled(e.target.checked)}
								className="h-3.5 w-3.5 accent-accent"
							/>
							显示已停用
						</label>
						<div className="flex h-8 w-56 items-center gap-2 rounded-md border border-hairline bg-surface px-2.5 focus-within:border-hairline-strong">
							<Search size={13} strokeWidth={1.5} className="shrink-0 text-ink-faint" />
							<input
								id="skills-search"
								value={query}
								onChange={e => setQuery(e.target.value)}
								placeholder="过滤技能…"
								className="w-full border-none bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
							/>
						</div>
					</div>
				</div>

				{/* 范围锚点：这份列表是「谁的、按哪个根判定的」。同屏多个 Agent 时没有它就会读错人。 */}
				<div className="mb-4 rounded-xl border border-hairline bg-surface px-5 py-3">
					<div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-3xs text-ink-faint">
						<span>
							Agent <b className="text-ink-subtle">{data?.scope.agentId ?? agentId ?? "—"}</b>
						</span>
						<span className="truncate" title={data?.scope.agentDir}>
							agentDir {data?.scope.agentDir ?? "—"}
						</span>
						<span className="truncate" title={data?.scope.sessionCwd}>
							会话根 {data?.scope.sessionCwd ?? "—"}
						</span>
						<span className="truncate" title={data?.scope.projectRoot ?? ""}>
							Project {data?.scope.projectRoot ?? "未归属"}
						</span>
					</div>
				</div>

				{/* 错误与受阻：读失败/冲突必须可见，不能折叠成一个「空列表」。 */}
				{problems.length > 0 && (
					<div className="mb-4 rounded-xl border border-danger/30 bg-danger/5 px-5 py-3">
						<div className="mb-1 text-xs font-semibold text-danger">发现错误 {problems.length} 项</div>
						<div className="space-y-1">
							{problems.map(problem => (
								<div key={`${problem.title}:${problem.detail}`} className="text-2xs text-ink-subtle">
									<span className="font-medium text-ink">{problem.title}</span>：{problem.detail}
								</div>
							))}
						</div>
					</div>
				)}

				{/* 受阻技能：进不了本次会话的行（同名落选者是一类，校验失败的目录扫描是另一类），
				    逐行给 serve 的原文原因；覆盖规则作为“同名时怎么算”的规则放在上面。 */}
				{(data?.blocked.length ?? 0) > 0 && (
					<div className="mb-4 overflow-hidden rounded-xl border border-hairline bg-surface">
						<div className="flex items-center gap-2.5 px-5 py-3">
							<span className="text-xs font-semibold tracking-[0.06em] text-ink uppercase">受阻技能</span>
							<span className="font-mono text-xs text-ink-faint">未进入本次会话</span>
							<span className="ml-auto font-mono text-xs text-ink-faint">{data?.blocked.length}</span>
						</div>
						<div className="border-t border-hairline px-5 py-2.5 text-2xs leading-relaxed text-ink-subtle">
							{SKILL_OVERRIDE_RULE}
						</div>
						<div className="border-t border-hairline">
							{(data?.blocked ?? []).map(blocked => (
								<div
									key={`${blocked.name}:${blocked.path}`}
									className="border-b border-hairline px-5 py-3 last:border-b-0"
								>
									<div className="text-xs font-medium text-ink">{blocked.name}</div>
									<div className="mt-0.5 font-mono text-3xs break-all text-ink-faint">
										{skillBlockedDetail(blocked)}
									</div>
								</div>
							))}
						</div>
					</div>
				)}

				{/* 开源 Skill Hub（h2）——远程技能市场浏览 + 安装。加载/安装中/失败均可见，不崩页。 */}
				<div className="mb-6 overflow-hidden rounded-xl border border-hairline bg-surface">
					<div className="flex items-center gap-2.5 px-5 py-3">
						<span className="text-xs font-semibold tracking-[0.06em] text-ink uppercase">开源 Skill Hub</span>
						<span className="font-mono text-xs text-ink-faint">远程技能市场</span>
						<span className="ml-auto flex items-center gap-2">
							{hubNotice && <span className="text-2xs text-success">{hubNotice}</span>}
							<button
								type="button"
								onClick={() => void loadRemote()}
								disabled={!view.connected || hubLoading}
								className="rounded-md border border-hairline bg-surface-2 px-2.5 py-1 text-2xs text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-default disabled:opacity-60"
							>
								{hubLoading ? "加载中…" : remote ? "刷新" : "加载"}
							</button>
						</span>
					</div>

					<div className="border-t border-hairline">
						{!view.connected ? (
							<div className="px-5 py-6 text-center text-xs text-ink-faint">未连接——远程技能市场不可用</div>
						) : hubLoading && remote === null ? (
							<div className="px-5 py-6 text-center text-xs text-ink-faint">正在加载远程技能市场…</div>
						) : hubError && remote === null ? (
							<div className="px-5 py-6 text-center text-xs text-ink-faint">远程技能市场不可用：{hubError}</div>
						) : remote === null ? (
							<div className="px-5 py-6 text-center text-xs text-ink-faint">点击「加载」浏览开源技能市场</div>
						) : remote.length === 0 ? (
							<div className="px-5 py-6 text-center text-xs text-ink-faint">远程技能市场当前无可安装项</div>
						) : (
							<div>
								{(hubGroups ?? []).map(group => (
									<div key={group.type} className="border-t border-hairline first:border-t-0">
										<div className="sticky top-0 z-sticky border-b border-hairline bg-surface">
											<button
												type="button"
												onClick={() => toggleGroup(group.type)}
												className="flex w-full items-center gap-1.5 px-5 py-1.5 text-left text-xs font-semibold section-title text-ink-faint uppercase transition-colors hover:bg-surface-2 hover:text-ink-subtle"
												aria-expanded={!collapsedGroups.has(group.type)}
											>
												<span className="inline-block w-3 text-[9px]">
													{collapsedGroups.has(group.type) ? "▸" : "▾"}
												</span>
												<span>{group.type}</span>
												<span className="ml-1 font-mono text-xs">
													{group.categories.reduce((n, c) => n + c.items.length, 0)}
												</span>
											</button>
										</div>
										{!collapsedGroups.has(group.type) &&
											group.categories.map(cat => (
												<div key={cat.label}>
													<button
														type="button"
														onClick={() => toggleGroup(`${group.type}#${cat.label}`)}
														className="flex w-full items-center gap-1.5 px-5 pt-2 pb-0.5 text-left"
														aria-expanded={!collapsedGroups.has(`${group.type}#${cat.label}`)}
													>
														<span className="inline-block w-3 text-[9px] text-ink-faint">
															{collapsedGroups.has(`${group.type}#${cat.label}`) ? "▸" : "▾"}
														</span>
														<span className="text-3xs font-semibold text-ink-subtle">{cat.label}</span>
														<span className="font-mono text-2xs text-ink-faint">{cat.items.length}</span>
													</button>
													{!collapsedGroups.has(`${group.type}#${cat.label}`) &&
														cat.items.map(({ item, rank }) => {
															const expanded = expandedName === item.name;
															const link = item.homepage ?? item.repository;
															return (
																<div
																	key={`${item.source}:${item.name}`}
																	className="border-b border-hairline px-5 py-3 last:border-b-0"
																>
																	<div className="flex items-start gap-3">
																		<div className="min-w-0 flex-1">
																			<div className="flex flex-wrap items-center gap-2">
																				<span className="font-mono text-3xs text-ink-faint">
																					#{rank}
																				</span>
																				<button
																					type="button"
																					onClick={() =>
																						setExpandedName(expanded ? null : item.name)
																					}
																					className="text-xs font-medium text-ink transition-colors hover:text-accent"
																					title="查看详情"
																				>
																					{item.name}
																				</button>
																				<span
																					className={`rounded px-1.5 py-0.5 font-mono text-xs ${
																						item.type === "plugin"
																							? "bg-accent-dim text-accent"
																							: "bg-surface-2 text-ink-faint"
																					}`}
																				>
																					{item.type}
																				</span>
																				<span
																					className="max-w-[180px] truncate font-mono text-3xs text-ink-faint"
																					title={item.source}
																				>
																					{item.source}
																				</span>
																				{link && (
																					<a
																						href={link}
																						target="_blank"
																						rel="noreferrer"
																						className="max-w-[160px] truncate font-mono text-3xs text-accent underline-offset-2 hover:underline"
																						title={link}
																						onClick={e => e.stopPropagation()}
																					>
																						{link
																							.replace(/^https?:\/\//, "")
																							.replace(/^www\./, "")}
																					</a>
																				)}
																			</div>
																			{item.description && (
																				<div
																					className={`mt-0.5 text-xs text-ink-subtle ${expanded ? "" : "line-clamp-2"}`}
																				>
																					{item.description}
																				</div>
																			)}
																			{expanded && (
																				<div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-3xs text-ink-faint">
																					{item.version && <span>v{item.version}</span>}
																					{item.author && <span>作者：{item.author}</span>}
																					{item.repository && (
																						<span>
																							仓库：{item.repository.replace(/^https?:\/\//, "")}
																						</span>
																					)}
																					<span>来源：{item.source}</span>
																				</div>
																			)}
																		</div>
																		<button
																			type="button"
																			data-testid={`install-skill-${item.name}`}
																			onClick={() => void installRemote(item)}
																			disabled={
																				!view.connected ||
																				installingName !== null ||
																				isInstalledRemote(item.name)
																			}
																			aria-label={`安装远程技能 ${item.name}`}
																			className={`mt-0.5 shrink-0 rounded-md border px-2.5 py-1 text-2xs transition-colors disabled:cursor-default ${
																				isInstalledRemote(item.name)
																					? "border-hairline bg-surface-2 text-ink-faint opacity-70"
																					: "border-hairline bg-surface-2 text-ink-subtle hover:border-hairline-strong hover:text-ink"
																			}`}
																		>
																			{installingName === item.name
																				? "安装中…"
																				: isInstalledRemote(item.name)
																					? "已安装"
																					: "安装"}
																		</button>
																	</div>
																</div>
															);
														})}
												</div>
											))}
									</div>
								))}
							</div>
						)}
					</div>
				</div>

				{!view.connected && (
					<div className="py-20 text-center text-[13px] text-ink-faint">未连接——技能列表不可用</div>
				)}
				{error && <div className="py-20 text-center text-[13px] text-ink-faint">技能列表不可用：{error}</div>}
				{view.connected && !error && loaded.length === 0 && !query && (
					<div className="py-20 text-center text-[13px] text-ink-faint">
						当前 Agent 未加载任何技能（停用名单 {disabled.length} 项）
					</div>
				)}

				{groups.map(group => (
					<div key={group.scope} className="mb-4 overflow-hidden rounded-xl border border-hairline bg-surface">
						<button
							type="button"
							onClick={() => toggleCollapsed(group.scope)}
							className="flex w-full items-center gap-2.5 px-5 py-3 text-left"
						>
							<span
								className={`text-xs text-ink-faint transition-transform ${collapsed.has(group.scope) ? "" : "rotate-90"}`}
							>
								▶
							</span>
							<span className="text-xs font-semibold tracking-[0.06em] text-ink uppercase">
								{SCOPE_LABELS[group.scope]}
							</span>
							<span className="ml-auto font-mono text-xs text-ink-faint">{group.rows.length}</span>
						</button>

						{!collapsed.has(group.scope) && (
							<div className="border-t border-hairline">
								{group.rows.map(row => (
									<SkillRowView
										key={row.name}
										row={row}
										busy={busy === row.name}
										onToggle={() => void toggleSkill(row, false)}
									/>
								))}
							</div>
						)}
					</div>
				))}

				{/* 演化技能：self-evolution 从会话里提炼出来的技能（evolution.db 的 skills 表）。
				    与上面的磁盘技能是两套事实（同名也不合并）：读失败按错误显示，绝不显示成空组。 */}
				<div className="mb-4 overflow-hidden rounded-xl border border-hairline bg-surface">
					<div className="flex items-center gap-2.5 px-5 py-3">
						<span className="text-xs font-semibold tracking-[0.06em] text-ink uppercase">演化技能</span>
						<span className="font-mono text-xs text-ink-faint">演化系统沉淀</span>
						<span className="ml-auto font-mono text-xs text-ink-faint">
							{evolvedState.kind === "rows" ? evolvedRows.length : "—"}
						</span>
					</div>
					<div className="border-t border-hairline">
						{evolvedState.kind === "disconnected" ? (
							<div className="px-5 py-6 text-center text-xs text-ink-faint">未连接——演化技能不可用</div>
						) : evolvedState.kind === "loading" ? (
							<div className="px-5 py-6 text-center text-xs text-ink-faint">正在读演化技能…</div>
						) : evolvedState.kind === "error" ? (
							<div className="px-5 py-6 text-center text-xs text-danger">
								演化技能读不到（不是「还没演化出技能」）：{evolvedState.message}
							</div>
						) : evolvedState.kind === "empty" ? (
							<div className="px-5 py-6 text-center text-xs text-ink-faint">
								演化库里还没有技能（读到了，确实没有）
								{evolvedState.degraded && (
									<span className="mt-1 block text-danger">部分行没读全：{evolvedState.degraded}</span>
								)}
							</div>
						) : (
							<>
								{evolvedState.degraded && (
									<div className="border-b border-hairline px-5 py-2 text-2xs text-danger">
										部分行没读全（整份读不到不走这里）：{evolvedState.degraded}
									</div>
								)}
								{evolvedRows.length === 0 ? (
									<div className="px-5 py-6 text-center text-xs text-ink-faint">
										没有匹配「{query}」的演化技能
									</div>
								) : (
									evolvedRows.map(skill => (
										<EvolvedSkillRow
											key={skill.name}
											skill={skill}
											expanded={expandedEvolved === skill.name}
											onToggle={() => setExpandedEvolved(expandedEvolved === skill.name ? null : skill.name)}
										/>
									))
								)}
							</>
						)}
					</div>
				</div>

				{/* 已停用组（显示已停用 开关）——灰显 + 启用回切 */}
				{showDisabled && (
					<div className="mb-4 overflow-hidden rounded-xl border border-hairline bg-surface">
						<div className="flex items-center gap-2.5 px-5 py-3">
							<span className="text-xs text-ink-faint">▶</span>
							<span className="text-xs font-semibold tracking-[0.06em] text-ink-faint uppercase">已停用</span>
							<span className="ml-auto font-mono text-xs text-ink-faint">{disabledFiltered.length}</span>
						</div>
						{disabledFiltered.length === 0 ? (
							<div className="border-t border-hairline px-5 py-6 text-center text-xs text-ink-faint">
								暂无已停用技能
							</div>
						) : (
							<div className="border-t border-hairline">
								{disabledFiltered.map(row => {
									const reason = skillReasonText(row);
									return (
										<div
											key={row.name}
											className="flex items-start gap-3 border-b border-hairline px-5 py-3 opacity-70 last:border-b-0"
										>
											<div className="min-w-0 flex-1">
												<div className="flex items-baseline gap-2">
													<span className="text-xs font-medium text-ink-faint line-through">
														{row.name}
													</span>
													<span
														className={`rounded px-1.5 py-0.5 font-mono text-2xs ${skillStatusClass(row.status)}`}
													>
														{SKILL_STATUS_LABELS[row.status]}
													</span>
													<span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-2xs text-ink-faint">
														{SCOPE_LABELS[row.scope]}
													</span>
												</div>
												{row.description && (
													<div className="mt-0.5 line-clamp-2 text-xs text-ink-faint">
														{row.description}
													</div>
												)}
												{reason && <div className="mt-0.5 font-mono text-3xs text-ink-faint">{reason}</div>}
											</div>
											<button
												type="button"
												onClick={() => void toggleSkill(row, true)}
												disabled={busy === row.name}
												aria-label={`${row.name} 启用`}
												className="mt-0.5 shrink-0 rounded-md border border-hairline bg-surface-2 px-2.5 py-1 text-2xs text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-default"
											>
												{busy === row.name ? "启用中…" : "启用"}
											</button>
										</div>
									);
								})}
							</div>
						)}
					</div>
				)}

				{view.connected && !error && query && groups.length === 0 && evolvedRows.length === 0 && (
					<div className="py-16 text-center text-[13px] text-ink-faint">没有匹配「{query}」的技能</div>
				)}
			</div>
		</div>
	);
}

/** 一行技能：名字 + 来源 + 范围 + 版本 + 激活/状态 + 原因 + 启停开关。 */
function SkillRowView({
	row,
	busy,
	onToggle,
}: {
	row: SkillScopeRowDto;
	busy: boolean;
	onToggle: () => void;
}): React.JSX.Element {
	const day = skillDayText(row.updatedAt);
	// 已加载的行也可能有原因：SKILL.md 刚被删/读不了时 serve 把它标成 unavailable 并带出失败原文。
	const reason = skillReasonText(row);
	return (
		<div className="flex items-start gap-3 border-b border-hairline px-5 py-3 last:border-b-0">
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-baseline gap-2">
					<span className="text-xs font-medium text-ink">{row.name}</span>
					<span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-ink-faint">
						{row.providerName ?? row.provider}
					</span>
					<span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-2xs text-ink-faint">
						{row.source}
					</span>
					<span className={`rounded px-1.5 py-0.5 font-mono text-2xs ${skillStatusClass(row.status)}`}>
						{SKILL_STATUS_LABELS[row.status]}
					</span>
					<span
						className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-2xs text-ink-faint"
						title={`激活态：${SKILL_ACTIVATION_LABELS[row.activation]}`}
					>
						{SKILL_ACTIVATION_LABELS[row.activation]}
					</span>
				</div>
				{row.description && <div className="mt-0.5 line-clamp-2 text-xs text-ink-subtle">{row.description}</div>}
				<div className="mt-0.5 flex flex-wrap items-center gap-x-3 font-mono text-3xs text-ink-faint">
					<span title={row.path} className="max-w-[420px] truncate">
						{row.path || "路径未知"}
					</span>
					<span>{skillVersionText(row)}</span>
					{day && <span>更新 {day}</span>}
					{reason && (
						<span
							className={`max-w-[560px] truncate ${row.status === "unavailable" ? "text-danger" : "text-ink-faint"}`}
							title={reason}
						>
							原因：{reason}
						</span>
					)}
				</div>
			</div>

			{/* 启停 toggle（P2-W3-3 B3 写协议）：点击停用；当前列表=已启用集，停用后进「已停用」组 */}
			<button
				type="button"
				onClick={onToggle}
				disabled={busy}
				title="停用该技能（写该 Agent 生效层的 config.yml：skills.ignoredSkills）"
				aria-label={`${row.name} 启停开关（当前已启用）`}
				className="mt-0.5 flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full bg-success/40 px-0.5 transition-colors hover:bg-success/60 disabled:cursor-not-allowed"
			>
				<span className="ml-auto h-4 w-4 rounded-full bg-ink" />
			</button>
		</div>
	);
}

/**
 * 一行演化技能：名字 + 版本 + 废弃态 + 质量/评分 + 使用统计；展开给做法与坑。
 *
 * 字段一律「有就说、没有就不说」：`qualityScore` / `userRating` 缺省是「没评过」，不是 0 ——
 * 编一个 0 出来会让「从没评分」和「评分很低」长得一样。`lastUsedAt` 同理：`usageCount` 为 0 时
 * 不拿创建时间冒充「最近使用」（提炼时会写一次 `Date.now()`，它不是一次使用）。
 */
function EvolvedSkillRow({
	skill,
	expanded,
	onToggle,
}: {
	skill: EvolvedSkillDto;
	expanded: boolean;
	onToggle: () => void;
}): React.JSX.Element {
	const quality = evolvedQualityText(skill);
	const rating = evolvedRatingText(skill);
	const created = skillDayText(skill.createdAt);
	// 「使用过」才谈得上「最近使用」：0 次的行的 lastUsedAt 是提炼时间，不是使用时间。
	const lastUsed = skill.usageCount > 0 ? skillDayText(skill.lastUsedAt) : null;
	const lastOptimized = skillDayText(skill.lastOptimizedAt);
	const deprecated = skill.deprecated === true;
	return (
		<div className="border-b border-hairline px-5 py-3 last:border-b-0">
			<div className="flex flex-wrap items-baseline gap-2">
				<button
					type="button"
					onClick={onToggle}
					title="查看详情"
					className={`text-xs font-medium transition-colors hover:text-accent ${deprecated ? "text-ink-faint line-through" : "text-ink"}`}
				>
					{skill.name}
				</button>
				<span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-2xs text-ink-faint">
					{evolvedVersionText(skill)}
				</span>
				<span
					className={`rounded px-1.5 py-0.5 font-mono text-2xs ${deprecated ? "bg-surface-2 text-ink-faint" : "bg-success/10 text-success"}`}
				>
					{evolvedDeprecationText(skill)}
				</span>
				{quality && (
					<span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-2xs text-ink-faint">{quality}</span>
				)}
				{rating && (
					<span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-2xs text-ink-faint">{rating}</span>
				)}
			</div>
			{skill.description && (
				<div className={`mt-0.5 text-xs text-ink-subtle ${expanded ? "" : "line-clamp-2"}`}>
					{skill.description}
				</div>
			)}
			<div className="mt-0.5 flex flex-wrap items-center gap-x-3 font-mono text-3xs text-ink-faint">
				<span>{evolvedUsageText(skill)}</span>
				{created && <span>创建 {created}</span>}
				{lastUsed && <span>最近使用 {lastUsed}</span>}
			</div>
			{expanded && (
				<div className="mt-2 space-y-1.5 rounded-md border border-hairline bg-surface-2 px-3 py-2">
					{skill.taskPattern && (
						<div className="text-2xs leading-relaxed text-ink-subtle">
							<span className="font-medium text-ink">适用任务</span>：{skill.taskPattern}
						</div>
					)}
					{skill.approach && (
						<div className="text-2xs leading-relaxed text-ink-subtle">
							<span className="font-medium text-ink">做法</span>：{skill.approach}
						</div>
					)}
					{skill.tools.length > 0 && (
						<div className="flex flex-wrap items-center gap-1.5 text-2xs text-ink-subtle">
							<span className="font-medium text-ink">工具</span>
							{skill.tools.map((tool, index) => (
								<span
									key={`${tool}:${index}`}
									className="rounded bg-surface px-1.5 py-0.5 font-mono text-3xs text-ink-faint"
								>
									{tool}
								</span>
							))}
						</div>
					)}
					{skill.pitfalls.length > 0 && (
						<div className="text-2xs leading-relaxed text-ink-subtle">
							<span className="font-medium text-ink">坑</span>
							<ul className="mt-0.5 list-disc pl-4">
								{skill.pitfalls.map((pitfall, index) => (
									<li key={`${pitfall}:${index}`}>{pitfall}</li>
								))}
							</ul>
						</div>
					)}
					{skill.autonomyNotes && (
						<div className="text-2xs leading-relaxed text-ink-subtle">
							<span className="font-medium text-ink">自主性备注</span>：{skill.autonomyNotes}
						</div>
					)}
					{lastOptimized && <div className="font-mono text-3xs text-ink-faint">最近优化 {lastOptimized}</div>}
					{skill.optimizedPrompt && (
						<pre className="max-h-48 overflow-auto rounded border border-hairline bg-surface px-2.5 py-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap text-ink-subtle">
							{skill.optimizedPrompt}
						</pre>
					)}
				</div>
			)}
		</div>
	);
}
