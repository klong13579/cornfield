import type { ConfigScope, ConfigScopeDto, ModelCatalogDto } from "@cornfield/wire";
import { useEffect, useMemo, useState } from "react";
import {
	addCustomRole,
	addFallback,
	buildSpecCheckContext,
	computeRoutesDiff,
	computeTagsChanges,
	type DraftOpResult,
	type DraftValidation,
	decodeDraft,
	deleteRole,
	draftFingerprint,
	draftStorageKey,
	duplicateRole,
	encodeDraft,
	initRoleDraft,
	isDraftDirty,
	isEntryDirty,
	MODEL_ROUTES_KEY,
	moveFallback,
	normalizeRoutesValue,
	normalizeTagsValue,
	type OtherLayerRef,
	ROLE_COLOR_PALETTE,
	type RoleColor,
	type RoleDraft,
	type RoleEditorSavePayload,
	type RoleListItem,
	type RoleRouteDiff,
	type RoleRoutes,
	type RoleSaveResult,
	type RoleTags,
	removeFallback,
	renameCustomRole,
	resetRole,
	roleDisplayMeta,
	seedRoute,
	serializeDraft,
	setPrimary,
	toRoleListItems,
	validateDraft,
	validateRoleId,
} from "./role-editor";

/**
 * 角色配置编辑器（#07）：modelRoutes 的原子化编辑界面（替换原 RoleConfigPlaceholder）。
 *
 * - 草稿：所有修改先进本地草稿（按写入作用域分键的 sessionStorage 持久化 + 基准指纹校验），
 *   提供放弃修改与逐角色恢复已保存值；刷新 / 页面内跳转后草稿自动还原；
 *   配置在别处被修改（指纹不匹配）则丢弃过期草稿并提示，不还原过期状态。
 * - 保存闸门：重复模型 / 已停用 / 未接入 provider / 目录不存在的 spec / 新角色空配置 / 角色重名
 *   为 error（禁止保存，不调用写入）；凭据失效 / 本地离线 / 目录非权威为 warning；
 *   空主模型但有回退链允许保存并明示「仅回退链生效」。
 * - 保存：确认弹窗展示作用域 + 逐角色逐字段 diff，确认后由页面层一次 setConfigValue 整键写入
 *   modelRoutes（失败时草稿保留且不应用部分配置），成功后页面重拉作用域与目录。
 * - 键盘可达：回退排序提供 ▲▼ 按钮作为拖拽的等价替代；模型选择为原生 datalist（输入即过滤）。
 */
interface RoleEditorSectionProps {
	scope: ConfigScopeDto;
	/** 页面级作用域切换器选定的写入目标（全局 / 当前项目）。 */
	writeTarget: ConfigScope;
	/** 全量模型目录（get_model_catalog）；拉取失败为 null（存在性校验降级为 warning）。 */
	catalog: ModelCatalogDto | null;
	/** 页面 in-flight 动作标记，期间禁用全部动作。 */
	busy: string | null;
	onSave(payload: RoleEditorSavePayload): Promise<RoleSaveResult>;
	/** 恢复继承入口（modelRoutes 键被项目覆盖时可用；页面层调 restoreConfigInheritance）。 */
	onRestoreInheritance(): void;
}

const MODEL_TAGS_KEY = "modelTags";

const ROLE_COLOR_CLASS: Record<RoleColor, string> = {
	accent: "bg-accent-dim text-accent",
	success: "bg-success/10 text-success",
	warning: "bg-warning/10 text-warning",
	error: "bg-danger/10 text-danger",
	muted: "bg-surface-2 text-ink-subtle",
	dim: "bg-surface-2 text-ink-faint",
};

const PROVENANCE_META: Record<RoleListItem["provenance"], { label: string; className: string }> = {
	project: { label: "项目覆盖", className: "bg-accent-dim text-accent" },
	global: { label: "全局", className: "text-ink-faint" },
	unset: { label: "未设置", className: "text-ink-faint" },
};

export function RoleEditorSection({
	scope,
	writeTarget,
	catalog,
	busy,
	onSave,
	onRestoreInheritance,
}: RoleEditorSectionProps): React.JSX.Element {
	const routesRow = scope.keys.find(k => k.key === MODEL_ROUTES_KEY);
	const tagsRow = scope.keys.find(k => k.key === MODEL_TAGS_KEY);
	const overridden = routesRow?.overridden ?? false;

	// ── 基准与生效视图：基准 = 写入目标作用域当前值（写入=整键替换该层），生效 = 合并视图 ──
	const projectRoutes = useMemo(() => normalizeRoutesValue(routesRow?.projectValue), [routesRow]);
	const globalRoutes = useMemo(() => normalizeRoutesValue(routesRow?.globalValue), [routesRow]);
	const base: RoleRoutes = useMemo(
		() => normalizeRoutesValue(writeTarget === "project" ? routesRow?.projectValue : routesRow?.globalValue),
		[routesRow, writeTarget],
	);
	const effective = useMemo(() => normalizeRoutesValue(routesRow?.effectiveValue), [routesRow]);
	const otherLayer: OtherLayerRef = useMemo(
		() =>
			writeTarget === "project"
				? { scope: "global", routes: globalRoutes }
				: { scope: "project", routes: projectRoutes },
		[writeTarget, globalRoutes, projectRoutes],
	);
	const baseTags: RoleTags = useMemo(
		() => normalizeTagsValue(writeTarget === "project" ? tagsRow?.projectValue : tagsRow?.globalValue),
		[tagsRow, writeTarget],
	);
	const displayTags = useMemo(() => normalizeTagsValue(tagsRow?.effectiveValue), [tagsRow]);
	const ctx = useMemo(() => buildSpecCheckContext(catalog), [catalog]);
	const baseFingerprint = draftFingerprint(base);

	// ── 草稿状态 ──
	const [draft, setDraft] = useState<RoleDraft>(() => initRoleDraft(base));
	/** 当前草稿所属作用域（防止作用域切换瞬间把旧作用域草稿写进新作用域的持久化键）。 */
	const [draftTarget, setDraftTarget] = useState<ConfigScope>(writeTarget);
	const [staleNotice, setStaleNotice] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
	const [fallbackInput, setFallbackInput] = useState<Record<number, string>>({});
	const [createForm, setCreateForm] = useState<{ name: string; color: RoleColor | null } | null>(null);
	const [activeForm, setActiveForm] = useState<{ kind: "rename" | "duplicate"; uid: number; value: string } | null>(
		null,
	);
	const [armDeleteUid, setArmDeleteUid] = useState<number | null>(null);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);

	// ── 派生视图 ──
	const validation: DraftValidation = useMemo(() => validateDraft(draft, ctx), [draft, ctx]);
	const dirty = useMemo(() => isDraftDirty(draft, base), [draft, base]);
	const nextRoutes = useMemo(() => serializeDraft(draft), [draft]);
	const diff = useMemo(() => computeRoutesDiff(base, nextRoutes, otherLayer), [base, nextRoutes, otherLayer]);
	const changedCount = diff.filter(d => d.kind !== "same").length;
	const tagsChange = useMemo(() => computeTagsChanges(draft, baseTags), [draft, baseTags]);
	const validationByUid = useMemo(() => new Map(validation.perEntry.map(v => [v.uid, v])), [validation]);
	const listItems = useMemo(
		() => toRoleListItems(effective, projectRoutes, globalRoutes, writeTarget, ctx),
		[effective, projectRoutes, globalRoutes, writeTarget, ctx],
	);
	const otherLayerItems = useMemo(
		() =>
			listItems.filter(
				item => !item.inTargetScope && !draft.entries.some(e => e.id === item.role || e.baseId === item.role),
			),
		[listItems, draft.entries],
	);
	const warningLines = useMemo(
		() =>
			validation.perEntry.flatMap(v => {
				const entry = draft.entries.find(e => e.uid === v.uid);
				if (!entry || v.severity !== "warning") return [];
				return v.issues.filter(i => i.severity === "warning").map(i => `${entry.id}: ${i.message}`);
			}),
		[validation, draft.entries],
	);

	/** 行内来源徽章：保存值所在层（重命名按 baseId），新增条目标注其实际来源层或未设置。 */
	const entryProvenance = (entry: {
		id: string;
		baseId: string | null;
		isNew: boolean;
	}): RoleListItem["provenance"] => {
		const key = entry.isNew ? entry.id : (entry.baseId ?? entry.id);
		if (projectRoutes[key] !== undefined) return "project";
		if (globalRoutes[key] !== undefined) return "global";
		return "unset";
	};

	// ── 草稿持久化（恢复：挂载 / 基准指纹或作用域变化时）──
	useEffect(() => {
		const raw = safeStorageGet(draftStorageKey(writeTarget));
		if (raw) {
			const restored = decodeDraft(raw, writeTarget, base);
			if (restored) {
				setDraft(restored);
				setDraftTarget(writeTarget);
				setStaleNotice(null);
				return;
			}
			safeStorageRemove(draftStorageKey(writeTarget));
			setStaleNotice("已保存的草稿与当前配置不一致（配置可能在别处被修改），已重置");
		}
		setDraft(initRoleDraft(base));
		setDraftTarget(writeTarget);
	}, [baseFingerprint, writeTarget]); // base 对象身份每次刷新变化，以内容指纹为依赖

	// ── 草稿持久化（写入：仅当草稿属于当前作用域）──
	useEffect(() => {
		if (draftTarget !== writeTarget) return;
		if (dirty) {
			safeStorageSet(draftStorageKey(writeTarget), JSON.stringify(encodeDraft(draft, writeTarget, base)));
		} else {
			safeStorageRemove(draftStorageKey(writeTarget));
		}
	}, [draft, draftTarget, writeTarget, dirty, baseFingerprint]); // base 随指纹依赖同步更新

	// ── 未保存离开提示：页面内路径由还原机制兜底；刷新 / 关闭标签页走 beforeunload 原生提示 ──
	useEffect(() => {
		if (!dirty) return;
		const handler = (event: BeforeUnloadEvent): void => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", handler);
		return () => window.removeEventListener("beforeunload", handler);
	}, [dirty]);

	// ── 确认弹窗：Escape 关闭（取消语义；焦点在弹窗内或页面任意处均生效）──
	useEffect(() => {
		if (!confirmOpen) return;
		const handler = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				setConfirmOpen(false);
				setSaveError(null);
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [confirmOpen]);

	const mutate = (op: DraftOpResult): void => {
		if (op.ok) {
			setDraft(op.draft);
			setActionError(null);
			setArmDeleteUid(null);
		} else {
			setActionError(op.error);
		}
	};

	const discard = (): void => {
		safeStorageRemove(draftStorageKey(writeTarget));
		setDraft(initRoleDraft(base));
		setDraftTarget(writeTarget);
		setConfirmOpen(false);
		setSaveError(null);
		setStaleNotice(null);
		setArmDeleteUid(null);
		setActiveForm(null);
		setCreateForm(null);
		setExpanded(new Set());
	};

	const confirmSave = async (): Promise<void> => {
		if (!dirty || validation.blocked || busy) return;
		setSaveError(null);
		const result = await onSave({
			scope: writeTarget,
			routes: nextRoutes,
			tags: tagsChange?.tags ?? null,
			changedCount,
		});
		if (result.ok) {
			safeStorageRemove(draftStorageKey(writeTarget));
			setDraft(initRoleDraft(base));
			setDraftTarget(writeTarget);
			setConfirmOpen(false);
			setSaveError(null);
			setExpanded(new Set());
		} else {
			// 写入失败：草稿保留、弹窗保持打开，错误可见可重试（不应用部分配置）
			setSaveError(result.error ?? "写入失败（原因未知）");
		}
	};

	const writeTargetText = writeTarget === "global" ? "全局配置" : "项目配置";
	const writeTargetPath =
		writeTarget === "global" ? scope.globalConfigPath : (scope.projectConfigPath ?? "首次写入时新建");
	const catalogModels = catalog?.models ?? [];
	const emptyNewUids = new Set(validation.perEntry.filter(v => v.emptyNew).map(v => v.uid));

	return (
		<div className="space-y-3">
			{/* 过期草稿提示（配置在别处被修改后丢弃过期草稿，可见不静默） */}
			{staleNotice && (
				<div className="flex items-center gap-3 rounded-lg border border-accent/40 bg-accent-dim/40 px-4 py-2.5 text-[12px] text-ink">
					<span className="flex-1">{staleNotice}</span>
					<button
						type="button"
						className="shrink-0 rounded border border-accent/30 px-2 py-0.5 transition-colors hover:bg-accent-dim"
						onClick={() => setStaleNotice(null)}
					>
						清除
					</button>
				</div>
			)}

			<div className="overflow-hidden rounded-xl border border-hairline bg-surface">
				{/* 工具栏：状态摘要 + 恢复继承 / 新增 / 放弃 / 保存 */}
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline px-5 py-3">
					<span className="text-[12px] text-ink-subtle">
						{draft.entries.length} 个角色 · 写入目标 <span className="font-mono text-ink">{writeTargetText}</span>
					</span>
					{dirty && (
						<span className="rounded bg-accent-dim px-1.5 py-px font-mono text-3xs text-accent">
							有未保存修改
						</span>
					)}
					{dirty && validation.blocked && (
						<span className="text-[11.5px] text-danger">
							{validation.errorCount} 个校验错误，禁止保存（重复 / 已停用 / 未接入 / 目录不存在等）
						</span>
					)}
					{!validation.blocked && validation.warningCount > 0 && (
						<span className="text-[11.5px] text-warning">{validation.warningCount} 个警告（不阻止保存）</span>
					)}
					<span className="ml-auto flex shrink-0 gap-1.5">
						{overridden && (
							<button
								type="button"
								disabled={busy !== null}
								title="删除项目对 modelRoutes 的覆盖（恢复继承），不把全局值复制进项目文件"
								className="rounded border border-hairline bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
								onClick={onRestoreInheritance}
							>
								恢复继承
							</button>
						)}
						<button
							type="button"
							disabled={busy !== null}
							className="rounded border border-hairline bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
							onClick={() => setCreateForm(createForm ? null : { name: "", color: null })}
						>
							{createForm ? "取消新增" : "新增角色"}
						</button>
						{dirty && (
							<button
								type="button"
								disabled={busy !== null}
								title="放弃全部未保存修改，恢复为写入目标作用域的已保存值"
								className="rounded border border-hairline bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
								onClick={discard}
							>
								放弃修改
							</button>
						)}
						<button
							type="button"
							className="btn btn-sm"
							disabled={!dirty || validation.blocked || busy !== null}
							title={
								validation.blocked
									? "存在校验错误（红色项），修正后才能保存"
									: `展示作用域与逐角色 diff 后写入${writeTargetText}（一次 setConfigValue 整键替换）`
							}
							onClick={() => {
								setSaveError(null);
								setConfirmOpen(true);
							}}
						>
							保存（{changedCount} 个角色变更）
						</button>
					</span>
				</div>

				{actionError && (
					<div className="flex items-center gap-3 border-b border-hairline bg-danger/5 px-5 py-2 text-[12px] text-danger">
						<span className="flex-1">{actionError}</span>
						<button
							type="button"
							className="shrink-0 rounded border border-danger/30 px-2 py-0.5 transition-colors hover:bg-danger/10"
							onClick={() => setActionError(null)}
						>
							清除
						</button>
					</div>
				)}

				{/* 新增角色表单（名称 + 可选颜色；重名即时提示并禁止创建） */}
				{createForm && (
					<div className="border-b border-hairline bg-surface-2 px-5 py-3">
						<div className="flex flex-wrap items-center gap-2">
							<span className="text-[12px] text-ink-subtle">新角色名称</span>
							<input
								className="w-[220px] rounded-md border border-hairline bg-surface px-2.5 py-1 font-mono text-[12px] text-ink outline-none focus:border-accent"
								value={createForm.name}
								placeholder="如 reviewer"
								spellCheck={false}
								// biome-ignore lint/a11y/noAutofocus: 表单展开后聚焦首个输入，键盘路径入口
								autoFocus
								onChange={e => setCreateForm({ ...createForm, name: e.target.value })}
								onKeyDown={e => {
									if (e.key === "Escape") setCreateForm(null);
									if (e.key === "Enter" && createForm.name.trim() && !validateRoleId(draft, createForm.name)) {
										mutate(addCustomRole(draft, createForm.name, createForm.color));
										setCreateForm(null);
									}
								}}
							/>
							<span className="text-[12px] text-ink-subtle">颜色（可选）</span>
							<div className="flex gap-1">
								{ROLE_COLOR_PALETTE.map(color => (
									<button
										key={color}
										type="button"
										title={color}
										aria-label={`颜色 ${color}`}
										className={`h-5 w-5 rounded-full border ${createForm.color === color ? "border-ink" : "border-transparent"} ${ROLE_COLOR_CLASS[color]}`}
										onClick={() =>
											setCreateForm({ ...createForm, color: createForm.color === color ? null : color })
										}
									/>
								))}
							</div>
							<span className="ml-auto flex gap-1.5">
								<button
									type="button"
									className="btn btn-sm"
									disabled={Boolean(validateRoleId(draft, createForm.name))}
									onClick={() => {
										mutate(addCustomRole(draft, createForm.name, createForm.color));
										setCreateForm(null);
									}}
								>
									创建
								</button>
								<button
									type="button"
									className="rounded border border-hairline bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink"
									onClick={() => setCreateForm(null)}
								>
									取消
								</button>
							</span>
						</div>
						{createForm.name.trim() && validateRoleId(draft, createForm.name) && (
							<div className="mt-1.5 text-[11.5px] text-danger">{validateRoleId(draft, createForm.name)}</div>
						)}
					</div>
				)}

				{/* 草稿角色行（内置 + 自定义，含新增 / 重命名条目） */}
				{draft.entries.map(entry => {
					const entryValidation = validationByUid.get(entry.uid);
					const meta = roleDisplayMeta(entry.id, displayTags);
					const color = entry.isNew && entry.color ? entry.color : meta.color;
					const entryDirty = isEntryDirty(entry, base);
					const effectiveRoute = effective[entry.baseId ?? entry.id];
					const inBase = entry.baseId !== null && base[entry.baseId] !== undefined;
					const isExpanded = expanded.has(entry.uid);
					const renaming = activeForm?.kind === "rename" && activeForm.uid === entry.uid;
					const duplicating = activeForm?.kind === "duplicate" && activeForm.uid === entry.uid;
					const armDelete = armDeleteUid === entry.uid;
					const provenance = PROVENANCE_META[entryProvenance(entry)];
					const nameError = activeForm
						? validateRoleId(draft, activeForm.value, renaming ? entry.uid : undefined)
						: null;
					return (
						<div
							key={entry.uid}
							className={`border-b border-hairline px-5 py-3 last:border-b-0 ${entryDirty ? "border-l-2 border-l-accent bg-accent-dim/20" : ""}`}
						>
							<div className="flex flex-wrap items-center gap-2">
								{color && (
									<span
										aria-hidden
										className={`h-2.5 w-2.5 shrink-0 rounded-full ${ROLE_COLOR_CLASS[color]}`}
									/>
								)}
								<span className="text-[13px] font-medium text-ink">{meta.name}</span>
								{meta.tag && (
									<span className="rounded bg-surface-2 px-1.5 py-px font-mono text-3xs text-ink-faint">
										{meta.tag}
									</span>
								)}
								{!meta.builtin && <span className="font-mono text-[11.5px] text-ink-faint">{entry.id}</span>}
								{entry.isNew && (
									<span className="rounded bg-accent-dim px-1.5 py-px font-mono text-3xs text-accent">
										新增
									</span>
								)}
								{!entry.isNew && entry.id !== entry.baseId && (
									<span
										className="rounded bg-accent-dim px-1.5 py-px font-mono text-3xs text-accent"
										title={`重命名自 ${entry.baseId}`}
									>
										重命名自 {entry.baseId}
									</span>
								)}
								{entryDirty && !entry.isNew && (
									<span className="rounded bg-accent-dim px-1.5 py-px font-mono text-3xs text-accent">
										已修改
									</span>
								)}
								{entryValidation?.fallbackOnly && (
									<span className="rounded bg-warning/10 px-1.5 py-px font-mono text-3xs text-warning">
										仅回退链生效
									</span>
								)}
								<span className={`rounded px-1.5 py-px font-mono text-3xs ${provenance.className}`}>
									{provenance.label}
								</span>
								<span className="ml-auto flex shrink-0 items-center gap-2">
									{entryValidation && entryValidation.severity !== "ok" && (
										<span
											className={`text-[11.5px] ${entryValidation.severity === "error" ? "text-danger" : "text-warning"}`}
											title={entryValidation.issues.map(i => i.message).join("；")}
										>
											{entryValidation.severity === "error" ? "✕" : "△"} {entryValidation.issues.length}{" "}
											项问题
										</span>
									)}
									<span
										className="font-mono text-[12px] text-ink-subtle"
										title={entry.primary.trim() || "未设置主模型"}
									>
										{entry.primary.trim() || <span className="text-ink-faint">未设置主模型</span>}
									</span>
									<span className="text-[11.5px] text-ink-faint">回退 ×{entry.fallbacks.length}</span>
									{!meta.builtin && (
										<span className="flex gap-1">
											<button
												type="button"
												disabled={busy !== null}
												className="rounded border border-hairline bg-surface-2 px-2 py-0.5 text-[11px] text-ink-subtle transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
												onClick={() => {
													setActiveForm(
														renaming ? null : { kind: "rename", uid: entry.uid, value: entry.id },
													);
													setArmDeleteUid(null);
												}}
											>
												重命名
											</button>
											<button
												type="button"
												disabled={busy !== null}
												className="rounded border border-hairline bg-surface-2 px-2 py-0.5 text-[11px] text-ink-subtle transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
												onClick={() => {
													setActiveForm(
														duplicating
															? null
															: { kind: "duplicate", uid: entry.uid, value: `${entry.id}-copy` },
													);
													setArmDeleteUid(null);
												}}
											>
												复制
											</button>
											{armDelete ? (
												<span className="flex items-center gap-1">
													<button
														type="button"
														className="rounded border border-danger/40 bg-danger/5 px-2 py-0.5 text-[11px] text-danger"
														onClick={() => mutate(deleteRole(draft, entry.uid))}
													>
														确认删除
													</button>
													<button
														type="button"
														className="rounded border border-hairline bg-surface-2 px-2 py-0.5 text-[11px] text-ink-subtle"
														onClick={() => setArmDeleteUid(null)}
													>
														取消
													</button>
												</span>
											) : (
												<button
													type="button"
													disabled={busy !== null}
													title="从写入目标作用域删除该角色；另一层仍有时生效值回落（diff 中说明）"
													className="rounded border border-hairline bg-surface-2 px-2 py-0.5 text-[11px] text-ink-subtle transition-colors hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
													onClick={() => setArmDeleteUid(entry.uid)}
												>
													删除
												</button>
											)}
										</span>
									)}
									<button
										type="button"
										aria-expanded={isExpanded}
										className="rounded border border-hairline bg-surface-2 px-2 py-0.5 text-[11px] text-ink-subtle transition-colors hover:text-ink"
										onClick={() => {
											const next = new Set(expanded);
											if (isExpanded) next.delete(entry.uid);
											else next.add(entry.uid);
											setExpanded(next);
										}}
									>
										{isExpanded ? "收起" : "编辑"}
									</button>
								</span>
							</div>

							{/* 重命名 / 复制内联表单（重名即时提示，确认按钮禁用） */}
							{activeForm && (renaming || duplicating) && (
								<div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-hairline bg-surface-2 px-3 py-2">
									<span className="text-[11.5px] text-ink-subtle">
										{renaming ? "重命名为" : "复制为新角色"}
									</span>
									<input
										className="w-[220px] rounded-md border border-hairline bg-surface px-2.5 py-1 font-mono text-[12px] text-ink outline-none focus:border-accent"
										value={activeForm.value}
										spellCheck={false}
										// biome-ignore lint/a11y/noAutofocus: 表单展开后聚焦首个输入，键盘路径入口
										autoFocus
										onChange={e => setActiveForm({ ...activeForm, value: e.target.value })}
										onKeyDown={e => {
											if (e.key === "Escape") setActiveForm(null);
											if (e.key === "Enter" && activeForm.value.trim() && !nameError) {
												mutate(
													renaming
														? renameCustomRole(draft, entry.uid, activeForm.value)
														: duplicateRole(draft, entry.uid, activeForm.value),
												);
												setActiveForm(null);
											}
										}}
									/>
									{nameError && <span className="text-[11.5px] text-danger">{nameError}</span>}
									<span className="ml-auto flex gap-1.5">
										<button
											type="button"
											className="btn btn-sm"
											disabled={Boolean(nameError)}
											onClick={() => {
												mutate(
													renaming
														? renameCustomRole(draft, entry.uid, activeForm.value)
														: duplicateRole(draft, entry.uid, activeForm.value),
												);
												setActiveForm(null);
											}}
										>
											确认
										</button>
										<button
											type="button"
											className="rounded border border-hairline bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink"
											onClick={() => setActiveForm(null)}
										>
											取消
										</button>
									</span>
								</div>
							)}

							{/* 新角色空配置（阻止保存，指明出路） */}
							{emptyNewUids.has(entry.uid) && (
								<div className="mt-2 text-[11.5px] text-danger">
									新角色未配置任何模型：设置主模型或回退链，否则保存后该角色不会出现在配置中（或直接删除该角色）
								</div>
							)}

							{/* 收起态：未在写入目标配置但另一层有值时，避免误以为未配置 */}
							{!isExpanded && !inBase && effectiveRoute && (
								<div className="mt-1.5 text-[11.5px] text-ink-faint">
									生效值来自{otherLayer.scope === "global" ? "全局" : "项目"}：
									<span className="font-mono">{effectiveRoute.primary ?? "（无主模型）"}</span>
									{effectiveRoute.fallbacks.length > 0 && (
										<span className="font-mono"> + {effectiveRoute.fallbacks.length} 回退</span>
									)}
									；编辑并保存将在{writeTargetText}创建覆盖
								</div>
							)}

							{/* 展开态：主模型 / 回退链编辑器 */}
							{isExpanded && (
								<div className="mt-3 space-y-3 rounded-lg border border-hairline bg-surface-2 px-3.5 py-3">
									<div>
										<div className="mb-1.5 flex items-baseline gap-2 text-[11px] text-ink-faint">
											<span>主模型</span>
											<span>搜索选择或直接输入 provider/modelId（可带 :thinking 级别后缀）</span>
											{entry.primary.trim() && (
												<button
													type="button"
													className="ml-auto text-[11px] text-ink-subtle underline-offset-2 hover:underline"
													onClick={() => mutate(setPrimary(draft, entry.uid, ""))}
												>
													清除
												</button>
											)}
										</div>
										<input
											className="w-full rounded-md border border-hairline bg-surface px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-accent"
											value={entry.primary}
											list="role-editor-model-options"
											placeholder={effectiveRoute?.primary ?? "provider/modelId"}
											spellCheck={false}
											onChange={e => mutate(setPrimary(draft, entry.uid, e.target.value))}
										/>
										{entryValidation?.issues
											.filter(i => i.field === "primary")
											.map((issue, i) => (
												<div
													key={`${issue.kind}-${i}`}
													className={`mt-1 text-[11.5px] ${issue.severity === "error" ? "text-danger" : "text-warning"}`}
												>
													主模型：{issue.message}
												</div>
											))}
									</div>

									<div>
										<div className="mb-1.5 text-[11px] text-ink-faint">
											回退链（主模型失败时按顺序重试；拖动或 ▲▼ 调整顺序，键盘可达）
										</div>
										{entry.fallbacks.length === 0 && (
											<div className="text-[11.5px] text-ink-faint">（无回退项）</div>
										)}
										<ol className="space-y-1">
											{entry.fallbacks.map((spec, index) => {
												const issues =
													entryValidation?.issues.filter(
														i => i.field === "fallback" && i.index === index,
													) ?? [];
												const hasError = issues.some(i => i.severity === "error");
												return (
													<li
														key={`fb-${entry.uid}-${index}`}
														draggable
														onDragStart={e => e.dataTransfer.setData("text/plain", String(index))}
														onDragOver={e => e.preventDefault()}
														onDrop={e => {
															e.preventDefault();
															const from = Number(e.dataTransfer.getData("text/plain"));
															if (Number.isInteger(from))
																mutate(moveFallback(draft, entry.uid, from, index));
														}}
														className={`flex items-center gap-2 rounded-md border px-2 py-1 ${hasError ? "border-danger/50 bg-danger/5" : "border-hairline bg-surface"}`}
													>
														<span aria-hidden className="cursor-grab select-none px-1 text-ink-faint">
															⠿
														</span>
														<span
															className={`min-w-0 flex-1 truncate font-mono text-[12px] ${hasError ? "text-danger" : "text-ink"}`}
														>
															{index + 1}.{" "}
															{spec.trim() || <span className="text-ink-faint">（空，保存时忽略）</span>}
														</span>
														{issues.map((issue, i) => (
															<span
																key={`${issue.kind}-${i}`}
																className={`shrink-0 text-[11px] ${issue.severity === "error" ? "text-danger" : "text-warning"}`}
															>
																{issue.message}
															</span>
														))}
														<span className="flex shrink-0 gap-1">
															<button
																type="button"
																aria-label={`上移回退项 ${index + 1}`}
																disabled={index === 0}
																className="rounded border border-hairline bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-subtle transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
																onClick={() => mutate(moveFallback(draft, entry.uid, index, index - 1))}
															>
																▲
															</button>
															<button
																type="button"
																aria-label={`下移回退项 ${index + 1}`}
																disabled={index === entry.fallbacks.length - 1}
																className="rounded border border-hairline bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-subtle transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
																onClick={() => mutate(moveFallback(draft, entry.uid, index, index + 1))}
															>
																▼
															</button>
															<button
																type="button"
																aria-label={`删除回退项 ${index + 1}`}
																className="rounded border border-hairline bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-subtle transition-colors hover:text-danger"
																onClick={() => mutate(removeFallback(draft, entry.uid, index))}
															>
																删除
															</button>
														</span>
													</li>
												);
											})}
										</ol>
										<div className="mt-2 flex items-center gap-2">
											<input
												className="min-w-0 flex-1 rounded-md border border-hairline bg-surface px-2.5 py-1 font-mono text-[12px] text-ink outline-none focus:border-accent"
												value={fallbackInput[entry.uid] ?? ""}
												list="role-editor-model-options"
												placeholder="添加回退模型：provider/modelId"
												spellCheck={false}
												onChange={e => setFallbackInput({ ...fallbackInput, [entry.uid]: e.target.value })}
												onKeyDown={e => {
													if (e.key === "Enter" && (fallbackInput[entry.uid] ?? "").trim()) {
														mutate(addFallback(draft, entry.uid, fallbackInput[entry.uid] ?? ""));
														setFallbackInput({ ...fallbackInput, [entry.uid]: "" });
													}
												}}
											/>
											<button
												type="button"
												className="btn btn-sm shrink-0"
												disabled={!(fallbackInput[entry.uid] ?? "").trim()}
												onClick={() => {
													mutate(addFallback(draft, entry.uid, fallbackInput[entry.uid] ?? ""));
													setFallbackInput({ ...fallbackInput, [entry.uid]: "" });
												}}
											>
												添加
											</button>
										</div>
									</div>

									<div className="flex flex-wrap items-center gap-2 text-[11.5px]">
										{entryValidation?.fallbackOnly && (
											<span className="text-warning">未设置主模型，仅回退链生效（已明示）</span>
										)}
										{!meta.builtin && entry.isNew && entry.color && (
											<span className="text-ink-faint">
												保存后颜色元数据将写入 modelTags（{entry.color}）
											</span>
										)}
										{!inBase && effectiveRoute && !entryDirty && (
											<button
												type="button"
												disabled={busy !== null}
												title="该角色未在写入目标作用域配置；点击将当前生效值带入草稿"
												className="rounded border border-hairline bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink disabled:opacity-40"
												onClick={() =>
													mutate(
														seedRoute(draft, entry.uid, {
															primary: effectiveRoute.primary ?? "",
															fallbacks: effectiveRoute.fallbacks,
														}),
													)
												}
											>
												以生效值预填
											</button>
										)}
										{entryDirty && !entry.isNew && (
											<button
												type="button"
												disabled={busy !== null}
												className="ml-auto rounded border border-hairline bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink disabled:opacity-40"
												onClick={() => mutate(resetRole(draft, entry.uid, base))}
											>
												恢复已保存值
											</button>
										)}
									</div>
								</div>
							)}
						</div>
					);
				})}

				{/* 仅存在于另一层的自定义角色（只读行，可一键带入写入目标） */}
				{otherLayerItems.map(item => (
					<div
						key={`other-${item.role}`}
						className="border-b border-hairline bg-surface-2/60 px-5 py-3 last:border-b-0"
					>
						<div className="flex flex-wrap items-center gap-2">
							<span className="text-[12.5px] text-ink-subtle">
								{roleDisplayMeta(item.role, displayTags).name}
							</span>
							<span className="font-mono text-[11.5px] text-ink-faint">{item.role}</span>
							<span
								className={`rounded px-1.5 py-px font-mono text-3xs ${PROVENANCE_META[item.provenance].className}`}
							>
								{PROVENANCE_META[item.provenance].label}
							</span>
							<span className="font-mono text-[12px] text-ink-subtle">{item.primary || "（无主模型）"}</span>
							<span className="text-[11.5px] text-ink-faint">回退 ×{item.fallbackCount}</span>
							{item.health.severity !== "ok" && (
								<span
									className={`text-[11.5px] ${item.health.severity === "error" ? "text-danger" : "text-warning"}`}
									title={item.health.messages.join("；")}
								>
									{item.health.severity === "error" ? "✕" : "△"} {item.health.messages.join("；")}
								</span>
							)}
							<span className="ml-auto flex shrink-0 items-center gap-2">
								<span className="text-[11px] text-ink-faint">不在写入目标作用域（当前生效）</span>
								<button
									type="button"
									disabled={busy !== null}
									className="rounded border border-hairline bg-surface-2 px-2 py-0.5 text-[11px] text-ink-subtle transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
									onClick={() => {
										const route = effective[item.role];
										mutate(
											addCustomRole(draft, item.role, null, {
												primary: route?.primary ?? "",
												fallbacks: route?.fallbacks ?? [],
											}),
										);
									}}
								>
									编辑（覆盖到{writeTargetText}）
								</button>
							</span>
						</div>
					</div>
				))}
			</div>

			{/* 模型搜索候选（原生 datalist：输入即过滤，键盘可达） */}
			<datalist id="role-editor-model-options">
				{catalogModels.map(m => (
					<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
						{m.name}
					</option>
				))}
			</datalist>

			{confirmOpen && (
				<SaveConfirmDialog
					diff={diff}
					tagsSummary={tagsChange?.summary ?? []}
					writeTargetText={writeTargetText}
					writeTargetPath={writeTargetPath}
					changedCount={changedCount}
					warningLines={warningLines}
					saveError={saveError}
					busy={busy !== null}
					displayTags={displayTags}
					onCancel={() => {
						setConfirmOpen(false);
						setSaveError(null);
					}}
					onConfirm={() => void confirmSave()}
				/>
			)}
		</div>
	);
}

// ── sessionStorage 安全包装（隐私模式 / 配额受限时不让草稿持久化失败影响编辑功能）──

function safeStorageGet(key: string): string | null {
	try {
		return sessionStorage.getItem(key);
	} catch {
		return null;
	}
}

function safeStorageSet(key: string, value: string): void {
	try {
		sessionStorage.setItem(key, value);
	} catch {
		// 存储不可用：草稿仅存活于组件状态（刷新即丢，编辑功能不受影响）
	}
}

function safeStorageRemove(key: string): void {
	try {
		sessionStorage.removeItem(key);
	} catch {
		// 同上
	}
}

// ── 保存确认弹窗（作用域 + 逐角色逐字段 diff；diff 必须在写入前可见）──

interface SaveConfirmDialogProps {
	diff: RoleRouteDiff[];
	tagsSummary: string[];
	writeTargetText: string;
	writeTargetPath: string;
	changedCount: number;
	warningLines: string[];
	saveError: string | null;
	busy: boolean;
	displayTags: RoleTags;
	onCancel(): void;
	onConfirm(): void;
}

function SaveConfirmDialog({
	diff,
	tagsSummary,
	writeTargetText,
	writeTargetPath,
	changedCount,
	warningLines,
	saveError,
	busy,
	displayTags,
	onCancel,
	onConfirm,
}: SaveConfirmDialogProps): React.JSX.Element {
	const changes = diff.filter(d => d.kind !== "same");
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
			<div
				role="dialog"
				aria-modal="true"
				aria-label="确认写入角色配置"
				className="max-h-[80vh] w-full max-w-[640px] overflow-y-auto rounded-xl border border-hairline bg-surface px-5 py-4 shadow-lg"
			>
				<div className="text-[14px] font-semibold text-ink">确认写入角色配置</div>
				<div className="mt-1 text-[12px] text-ink-subtle">
					写入目标：<span className="font-mono">{writeTargetText}</span>（
					<span className="font-mono">{writeTargetPath}</span>
					）· 一次 setConfigValue 整键替换「modelRoutes」
					{tagsSummary.length > 0 && <>；同时更新「modelTags」颜色元数据</>}
				</div>

				<div className="mt-3 space-y-2">
					{changes.length === 0 && tagsSummary.length === 0 && (
						<div className="text-[12px] text-ink-faint">（无角色路由变更）</div>
					)}
					{changes.map(d => {
						const name = roleDisplayMeta(d.role, displayTags).name;
						return (
							<div key={d.role} className="rounded-lg border border-hairline bg-surface-2 px-3 py-2">
								<div className="flex items-center gap-2">
									<span
										className={`rounded px-1.5 py-px font-mono text-3xs ${
											d.kind === "added"
												? "bg-success/10 text-success"
												: d.kind === "removed"
													? "bg-danger/10 text-danger"
													: "bg-accent-dim text-accent"
										}`}
									>
										{d.kind === "added" ? "新增" : d.kind === "removed" ? "移除" : "修改"}
									</span>
									<span className="text-[12.5px] font-medium text-ink">{name}</span>
									<span className="font-mono text-[11.5px] text-ink-faint">{d.role}</span>
								</div>
								{d.primary && (
									<div className="mt-1 font-mono text-[11.5px] text-ink-subtle">
										主模型：{d.primary.from ?? "（无）"} →{" "}
										<span className="text-ink">{d.primary.to ?? "（无）"}</span>
									</div>
								)}
								{d.fallbacks && (
									<div className="mt-1 font-mono text-[11.5px] text-ink-subtle">
										回退链：{d.fallbacks.from.length > 0 ? d.fallbacks.from.join(" → ") : "（空）"} →{" "}
										<span className="text-ink">
											{d.fallbacks.to.length > 0 ? d.fallbacks.to.join(" → ") : "（空）"}
										</span>
										{d.fallbacks.added.length > 0 && (
											<span className="text-success">（新增 {d.fallbacks.added.join("、")}）</span>
										)}
										{d.fallbacks.removed.length > 0 && (
											<span className="text-danger">（移除 {d.fallbacks.removed.join("、")}）</span>
										)}
										{d.fallbacks.reordered && <span className="text-accent">（顺序调整）</span>}
									</div>
								)}
								{d.kind === "removed" && d.otherLayer && (
									<div className="mt-1 text-[11.5px] text-warning">
										{d.otherLayer === "global" ? "全局" : "项目"}
										层仍有该角色：写入后生效值回落该层，不会真正消失
									</div>
								)}
							</div>
						);
					})}
					{tagsSummary.length > 0 && (
						<div className="rounded-lg border border-hairline bg-surface-2 px-3 py-2 text-[11.5px] text-ink-subtle">
							<div className="mb-1 text-[12px] text-ink">角色颜色元数据（modelTags）</div>
							{tagsSummary.map(line => (
								<div key={line} className="font-mono">
									{line}
								</div>
							))}
						</div>
					)}
				</div>

				{warningLines.length > 0 && (
					<div className="mt-3 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-[11.5px] text-warning">
						{warningLines.length} 个警告（不阻止保存，运行时可能失败）：
						{warningLines.map(line => (
							<div key={line}>{line}</div>
						))}
					</div>
				)}

				{saveError && (
					<div className="mt-3 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-[11.5px] text-danger">
						上次写入失败（草稿已保留，未应用部分配置）：{saveError}
					</div>
				)}

				<div className="mt-4 flex justify-end gap-2">
					<button
						type="button"
						disabled={busy}
						className="rounded border border-hairline bg-surface-2 px-3 py-1.5 text-[12px] text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
						onClick={onCancel}
					>
						取消
					</button>
					<button type="button" className="btn btn-sm" disabled={busy} onClick={onConfirm}>
						{busy ? "写入中…" : `确认写入（${changedCount} 个角色变更）`}
					</button>
				</div>
			</div>
		</div>
	);
}
