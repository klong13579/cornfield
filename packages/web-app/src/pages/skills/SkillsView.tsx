import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { RemoteSkillItemDto } from "../../lib/pi-client-api";
import type { DisabledSkillDto, SkillDto } from "../../lib/wire-dto";
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
			<div className="mx-auto max-w-[900px]">
				<div className="mb-6 flex items-center justify-between gap-4">
					<h1 className="text-[32px] font-semibold tracking-[-0.8px] text-ink">技能</h1>
					<div className="flex items-center gap-3">
						<label className="flex items-center gap-1.5 text-[11.5px] text-ink-subtle">
							<input
								type="checkbox"
								checked={showDisabled}
								onChange={e => setShowDisabled(e.target.checked)}
								className="h-3.5 w-3.5 accent-[var(--color-accent)]"
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
						<span className="text-[12px] font-semibold tracking-[0.06em] text-ink uppercase">开源 Skill Hub</span>
						<span className="font-mono text-[11px] text-ink-faint">远程技能市场</span>
						<span className="ml-auto flex items-center gap-2">
							{hubNotice && <span className="text-[11.5px] text-success">{hubNotice}</span>}
							<button
								type="button"
								onClick={() => void loadRemote()}
								disabled={!view.connected || hubLoading}
								className="rounded-md border border-hairline bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-default disabled:opacity-60"
							>
								{hubLoading ? "加载中…" : remote ? "刷新" : "加载"}
							</button>
						</span>
					</div>

					<div className="border-t border-hairline">
						{!view.connected ? (
							<div className="px-5 py-6 text-center text-[12px] text-ink-faint">未连接——远程技能市场不可用</div>
						) : hubLoading && remote === null ? (
							<div className="px-5 py-6 text-center text-[12px] text-ink-faint">正在加载远程技能市场…</div>
						) : hubError && remote === null ? (
							<div className="px-5 py-6 text-center text-[12px] text-ink-faint">
								远程技能市场不可用：{hubError}
							</div>
						) : remote === null ? (
							<div className="px-5 py-6 text-center text-[12px] text-ink-faint">
								点击「加载」浏览开源技能市场
							</div>
						) : remote.length === 0 ? (
							<div className="px-5 py-6 text-center text-[12px] text-ink-faint">远程技能市场当前无可安装项</div>
						) : (
							<div>
								{remote.map(item => (
									<div
										key={`${item.source}:${item.name}`}
										className="flex items-start gap-3 border-b border-hairline px-5 py-3 last:border-b-0"
									>
										<div className="min-w-0 flex-1">
											<div className="flex flex-wrap items-baseline gap-2">
												<span className="text-[13.5px] font-medium text-ink">{item.name}</span>
												<span
													className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
														item.type === "plugin"
															? "bg-accent-dim text-accent"
															: "bg-surface-2 text-ink-faint"
													}`}
												>
													{item.type}
												</span>
												<span
													className="max-w-[180px] truncate font-mono text-[10.5px] text-ink-faint"
													title={item.source}
												>
													{item.source}
												</span>
											</div>
											{item.description && (
												<div className="mt-0.5 line-clamp-2 text-[12px] text-ink-subtle">
													{item.description}
												</div>
											)}
										</div>
										<button
											type="button"
											data-testid={`install-skill-${item.name}`}
											onClick={() => void installRemote(item)}
											disabled={!view.connected || installingName !== null || isInstalledRemote(item.name)}
											aria-label={`安装远程技能 ${item.name}`}
											className={`mt-0.5 shrink-0 rounded-md border px-2.5 py-1 text-[11.5px] transition-colors disabled:cursor-default ${
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
								className={`text-[10px] text-ink-faint transition-transform ${collapsed.has(group.level) ? "" : "rotate-90"}`}
							>
								▶
							</span>
							<span className="text-[12px] font-semibold tracking-[0.06em] text-ink uppercase">
								{LEVEL_LABELS[group.level]}
							</span>
							<span className="ml-auto font-mono text-[11px] text-ink-faint">{group.rows.length}</span>
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
							<span className="text-[10px] text-ink-faint">▶</span>
							<span className="text-[12px] font-semibold tracking-[0.06em] text-ink-faint uppercase">
								已停用
							</span>
							<span className="ml-auto font-mono text-[11px] text-ink-faint">{disabledFiltered.length}</span>
						</div>
						{disabledFiltered.length === 0 ? (
							<div className="border-t border-hairline px-5 py-6 text-center text-[12px] text-ink-faint">
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
												<span className="text-[13.5px] font-medium text-ink-faint line-through">
													{row.name}
												</span>
											</div>
											{row.description && (
												<div className="mt-0.5 line-clamp-2 text-[12px] text-ink-faint">
													{row.description}
												</div>
											)}
										</div>
										<button
											type="button"
											onClick={() => void toggleSkill(row.name, true)}
											disabled={busy === row.name}
											aria-label={`${row.name} 启用`}
											className="mt-0.5 shrink-0 rounded-md border border-hairline bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-default"
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
					<span className="text-[13.5px] font-medium text-ink">{row.name}</span>
					<span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-faint">
						{row.provider}
					</span>
				</div>
				{row.description && (
					<div className="mt-0.5 line-clamp-2 text-[12px] text-ink-subtle">{row.description}</div>
				)}
			</div>

			{/* 启停 toggle（P2-W3-3 B3 写协议）：点击停用；当前列表=已启用集，停用后技能移除 */}
			<button
				type="button"
				onClick={onToggle}
				title="停用该技能（写 config.yml skills.ignoredSkills）"
				aria-label={`${row.name} 启停开关（当前已启用）`}
				className="mt-0.5 flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full bg-success/40 px-0.5 transition-colors hover:bg-success/60"
			>
				<span className="ml-auto h-4 w-4 rounded-full bg-ink" />
			</button>
		</div>
	);
}
