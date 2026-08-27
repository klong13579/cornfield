import type { DisabledSkillDto, SkillDto } from "@oh-my-pi/pi-wire";
import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { RemoteSkillItemDto } from "../../lib/pi-client-api";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";

/**
 * 技能面板（W3 D5）—— 列表/搜索/分类折叠 + 启停 toggle 禁用态。
 * 数据：serve get_skills（session.skills 同源，即 agent 实际加载的「已启用」技能集）。
 * toggle 为 B3 技能管理协议的前置 UI：协议落地前渲染禁用态 + 提示，不做任何假写操作。
 *
 * 顶部「开源 Skill Hub」（h2，契约命令 h1 并行实现）：list_remote_skills 浏览远程技能市场 + install_remote_skill 装到本机 skills。
 */

const LEVEL_LABELS: Record<SkillDto["level"], string> = {
	user: "用户级",
	project: "项目级",
	native: "内置",
};

const LEVEL_ORDER: SkillDto["level"][] = ["user", "project", "native"];

interface SkillRow extends SkillDto {
	enabled: true;
}

export function SkillsView(): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const [skills, setSkills] = useState<SkillRow[]>([]);
	const [disabled, setDisabled] = useState<DisabledSkillDto[]>([]);
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
			await refreshBoth(); // 本地列表重拉：新技能出现在已启用/已停用分组
		} catch (err) {
			setHubError(`安装「${item.name}」失败：${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setInstallingName(null);
		}
	};

	/** 启停（P2-W3-3 B3 写协议）：停用/回切后重拉列表，技能在两集合间迁移；in-flight 防重入。 */
	const refreshBoth = async () => {
		try {
			const { skills: list, disabled: dropped } = await store.fetchSkills();
			setSkills(list.map(s => ({ ...s, enabled: true as const })));
			setDisabled(dropped);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};
	const toggleSkill = async (name: string, enabled: boolean) => {
		if (busy) return;
		setBusy(name);
		try {
			await store.setSkillEnabled(name, enabled);
			await refreshBoth();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	useEffect(() => {
		if (!view.connected) return;
		setError(null);
		void store
			.fetchSkills()
			.then(({ skills: list, disabled: dropped }) => {
				setSkills(list.map(s => ({ ...s, enabled: true as const })));
				setDisabled(dropped);
			})
			.catch(err => setError(err instanceof Error ? err.message : String(err)));
		// 进入即拉远程技能市场；失败仅写 hubError（h1 契约命令 serve 端并行实现，未就绪时页面不崩）
		void store
			.fetchRemoteSkills()
			.then(setRemote)
			.catch(err => setHubError(err instanceof Error ? err.message : String(err)));
	}, [store, view.connected]);

	const groups = useMemo(() => {
		const q = query.trim().toLowerCase();
		const filtered = q
			? skills.filter(s => s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q))
			: skills;
		return LEVEL_ORDER.map(level => ({ level, rows: filtered.filter(s => s.level === level) })).filter(
			g => g.rows.length > 0,
		);
	}, [skills, query]);

	const disabledFiltered = useMemo(() => {
		const q = query.trim().toLowerCase();
		return q ? disabled.filter(d => d.name.toLowerCase().includes(q)) : disabled;
	}, [disabled, query]);

	/** 本地已存在的技能名（已启用 + 已停用）→ 远程条目同名视为已安装。 */
	const localInstalled = useMemo(() => {
		const names = new Set<string>();
		for (const s of skills) names.add(s.name);
		for (const d of disabled) names.add(d.name);
		return names;
	}, [skills, disabled]);
	const isInstalledRemote = (name: string): boolean => localInstalled.has(name) || installedRemote.has(name);

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
				{view.connected && !error && skills.length === 0 && !query && (
					<div className="py-20 text-center text-[13px] text-ink-faint">当前 agent 未加载任何技能</div>
				)}

				{groups.map(group => (
					<div key={group.level} className="mb-4 overflow-hidden rounded-xl border border-hairline bg-surface">
						<button
							type="button"
							onClick={() => toggleCollapsed(group.level)}
							className="flex w-full items-center gap-2.5 px-5 py-3 text-left"
						>
							<span
								className={`text-xs text-ink-faint transition-transform ${collapsed.has(group.level) ? "" : "rotate-90"}`}
							>
								▶
							</span>
							<span className="text-xs font-semibold tracking-[0.06em] text-ink uppercase">
								{LEVEL_LABELS[group.level]}
							</span>
							<span className="ml-auto font-mono text-xs text-ink-faint">{group.rows.length}</span>
						</button>

						{!collapsed.has(group.level) && (
							<div className="border-t border-hairline">
								{group.rows.map(row => (
									<SkillRowView key={row.name} row={row} onToggle={() => void toggleSkill(row.name, false)} />
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
											</div>
											{row.description && (
												<div className="mt-0.5 line-clamp-2 text-xs text-ink-faint">{row.description}</div>
											)}
										</div>
										<button
											type="button"
											onClick={() => void toggleSkill(row.name, true)}
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

function SkillRowView({ row, onToggle }: { row: SkillRow; onToggle: () => void }): React.JSX.Element {
	return (
		<div className="flex items-start gap-3 border-b border-hairline px-5 py-3 last:border-b-0">
			<div className="min-w-0 flex-1">
				<div className="flex items-baseline gap-2">
					<span className="text-xs font-medium text-ink">{row.name}</span>
					<span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-ink-faint">
						{row.provider}
					</span>
				</div>
				{row.description && <div className="mt-0.5 line-clamp-2 text-xs text-ink-subtle">{row.description}</div>}
			</div>

			{/* 启停 toggle（P2-W3-3 B3 写协议）：点击停用；当前列表=已启用集，停用后技能移除 */}
			<button
				type="button"
				onClick={onToggle}
				title="停用该技能（写 config.yml skills.ignoredSkills）"
				aria-label={`${row.name} 启停开关（当前已启用）`}
				className="mt-0.5 flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full bg-success/40 px-0.5 transition-colors hover:bg-success/60 disabled:cursor-not-allowed"
			>
				<span className="ml-auto h-4 w-4 rounded-full bg-ink" />
			</button>
		</div>
	);
}
