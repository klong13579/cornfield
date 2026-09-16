import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { RemoteSkillItemDto, SkillScope, SkillScopeRowDto, SkillsResultDto } from "../../lib/pi-client-api";
import { activeAgentIdOf } from "../../state/agent-context";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";
import {
	SKILL_ACTIVATION_LABELS,
	SKILL_SCOPE_LABELS,
	SKILL_STATUS_LABELS,
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
 * 顶部「开源 Skill Hub」（h2）：list_remote_skills 浏览远程技能市场 + install_remote_skill 装到本机 skills。
 */

/** 范围分组的展示顺序（本页专有：Agent 详情页不按范围分组）。 */
const SCOPE_ORDER: SkillScope[] = ["agent", "project", "global"];

function fmtDay(ts: number | undefined): string | null {
	if (ts === undefined) return null;
	const date = new Date(ts);
	if (Number.isNaN(date.getTime())) return null;
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

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

	/** 重读技能工作台数据（焦点 Agent 定向；换 Agent / 启停后都走这一条）。 */
	const refresh = async (): Promise<void> => {
		try {
			const result = await store.fetchSkills(agentId);
			setData(result);
			setError(null);
		} catch (err) {
			setData(null);
			setError(err instanceof Error ? err.message : String(err));
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

	/** 需要人看见的问题：发现错误、被挡住的技能、Project registry 读不出来。 */
	const problems = useMemo(() => {
		const items: Array<{ title: string; detail: string }> = [];
		if (data?.scope.projectError) {
			items.push({ title: "Project 归属未知", detail: data.scope.projectError });
		}
		for (const blocked of data?.blocked ?? []) {
			items.push({ title: `受阻：${blocked.name}`, detail: `${blocked.path} —— ${blocked.reason}` });
		}
		for (const err of data?.errors ?? []) {
			items.push({ title: "发现错误", detail: err.path ? `${err.path} —— ${err.message}` : err.message });
		}
		return items;
	}, [data]);

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
								{SKILL_SCOPE_LABELS[group.scope]}
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
								{disabledFiltered.map(row => (
									<div
										key={row.name}
										className="flex items-start gap-3 border-b border-hairline px-5 py-3 opacity-70 last:border-b-0"
									>
										<div className="min-w-0 flex-1">
											<div className="flex items-baseline gap-2">
												<span className="text-xs font-medium text-ink-faint line-through">{row.name}</span>
												<span
													className={`rounded px-1.5 py-0.5 font-mono text-2xs ${skillStatusClass(row.status)}`}
												>
													{SKILL_STATUS_LABELS[row.status]}
												</span>
												<span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-2xs text-ink-faint">
													{SKILL_SCOPE_LABELS[row.scope]}
												</span>
											</div>
											{row.description && (
												<div className="mt-0.5 line-clamp-2 text-xs text-ink-faint">{row.description}</div>
											)}
											<div className="mt-0.5 font-mono text-3xs text-ink-faint">{row.reason ?? "—"}</div>
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
								))}
							</div>
						)}
					</div>
				)}

				{view.connected && !error && query && groups.length === 0 && (
					<div className="py-16 text-center text-[13px] text-ink-faint">没有匹配「{query}」的技能</div>
				)}
			</div>
		</div>
	);
}

/** 一行技能：名字 + 来源 + 范围 + 版本 + 激活/状态 + 启停开关。 */
function SkillRowView({
	row,
	busy,
	onToggle,
}: {
	row: SkillScopeRowDto;
	busy: boolean;
	onToggle: () => void;
}): React.JSX.Element {
	const day = fmtDay(row.updatedAt);
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
				</div>
			</div>

			{/* 启停 toggle（P2-W3-3 B3 写协议）：点击停用；当前列表=已启用集，停用后进「已停用」组 */}
			<button
				type="button"
				onClick={onToggle}
				disabled={busy}
				title="停用该技能（写该 Agent 的 config.yml skills.ignoredSkills）"
				aria-label={`${row.name} 启停开关（当前已启用）`}
				className="mt-0.5 flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full bg-success/40 px-0.5 transition-colors hover:bg-success/60 disabled:cursor-not-allowed"
			>
				<span className="ml-auto h-4 w-4 rounded-full bg-ink" />
			</button>
		</div>
	);
}
