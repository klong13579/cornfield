import type { ConfigScope, ConfigScopeDto, ConfigScopeKeyDto } from "@cornfield/wire";
import { useState } from "react";
import { FEATURED_SCOPE_KEY_META, groupAdvancedKeys, type ScopeKeyEditor, splitScopeKeys } from "./scope-keys";
import { formatConfigValue, parseConfigDraft, toScopeKeyView } from "./scope-view";

/**
 * 逐键配置平铺矩阵（#05 + UX 策展 v2）：精选高频键网格置顶；其余键按 schema ui.tab
 * 中文分组折叠（组内网格）。收起态只显示 标签/键名 + 覆盖徽标 + 生效值；点击整卡进入编辑——
 * 展开面板内保留完整三层取值（项目/全局/生效）、精选键中文说明、恢复继承与编辑控件。
 * 同一时刻至多一个编辑器打开。编辑器按页面级写入作用域（writeTarget）提交 setConfigValue
 * （JSON 校验，非法不提交）。
 */
interface ScopeKeysSectionProps {
	scope: ConfigScopeDto;
	/** 页面级作用域切换器选定的写入目标（全局 / 当前项目）。 */
	writeTarget: ConfigScope;
	/** in-flight 动作标记（`restore:<key>` / `write:<key>`），期间禁用全部按钮。 */
	busy: string | null;
	onRestore(key: string): void;
	onWrite(key: string, value: unknown, scope: ConfigScope): void;
}

/** 网格卡标题：精选键显示中文标签（键名进 tooltip），高级键直接显示键名。 */
function ScopeKeyTitle({ dto, featured }: { dto: ConfigScopeKeyDto; featured: boolean }): React.JSX.Element {
	const meta = FEATURED_SCOPE_KEY_META.get(dto.key);
	if (featured && meta) {
		return <span className="min-w-0 truncate text-[12.5px] font-semibold text-ink">{meta.label}</span>;
	}
	return <span className="min-w-0 truncate font-mono text-[12.5px] font-semibold text-ink">{dto.key}</span>;
}

/** 单键网格卡：收起态（标签 + 生效值 + 覆盖徽标）可整卡点击；展开态为编辑面板。 */
function ScopeKeyCard({
	dto,
	featured,
	writeTarget,
	busy,
	editing,
	draft,
	draftError,
	onOpenEditor,
	onDraftChange,
	onCloseEditor,
	onSubmit,
	onRestore,
}: {
	dto: ConfigScopeKeyDto;
	featured: boolean;
	writeTarget: ConfigScope;
	busy: string | null;
	editing: boolean;
	draft: string;
	draftError: string | null;
	onOpenEditor(key: string, prefill: unknown): void;
	onDraftChange(value: string): void;
	onCloseEditor(): void;
	onSubmit(key: string): void;
	onRestore(key: string): void;
}): React.JSX.Element {
	const view = toScopeKeyView(dto);
	const restoring = busy === `restore:${dto.key}`;
	const writing = busy === `write:${dto.key}`;
	const meta = FEATURED_SCOPE_KEY_META.get(dto.key);
	/** 编辑器预填基准：写入目标作用域的当前值，未设置则用生效值。 */
	const prefillBase = writeTarget === "project" ? dto.projectValue : dto.globalValue;
	const editor: ScopeKeyEditor | undefined = meta?.editor;
	const effective = view.rows.find(row => row.layer === "effective");

	/** 编辑面板头部提示随编辑器形态变化。 */
	const editorHint =
		editor === undefined
			? "整键替换（JSON）"
			: editor.kind === "enum"
				? "枚举值（下拉选择）"
				: editor.kind === "boolean"
					? "布尔值"
					: "数值";

	/** 非编辑器态的通用输入控件。 */
	const jsonEditor = (
		<textarea
			className="h-24 w-full resize-y rounded-md border border-hairline bg-surface px-2 py-1.5 font-mono text-[11.5px] text-ink outline-none focus:border-accent"
			value={draft}
			onChange={e => onDraftChange(e.target.value)}
			spellCheck={false}
		/>
	);

	const editorControl =
		editor === undefined ? (
			jsonEditor
		) : editor.kind === "enum" ? (
			<select
				className="w-full rounded-md border border-hairline bg-surface-2 px-2 py-1.5 font-mono text-[11.5px] text-ink outline-none focus:border-accent"
				value={draft}
				onChange={e => onDraftChange(e.target.value)}
			>
				{draft !== "" && !editor.values.includes(draft) && (
					<option value={draft}>{`${draft}（当前配置值）`}</option>
				)}
				{editor.values.map(v => (
					<option key={v} value={v}>
						{v}
					</option>
				))}
			</select>
		) : editor.kind === "boolean" ? (
			<select
				className="w-full rounded-md border border-hairline bg-surface-2 px-2 py-1.5 font-mono text-[11.5px] text-ink outline-none focus:border-accent"
				value={draft}
				onChange={e => onDraftChange(e.target.value)}
			>
				<option value="true">真（true）</option>
				<option value="false">假（false）</option>
			</select>
		) : (
			<input
				type="number"
				step="any"
				className="w-full rounded-md border border-hairline bg-surface px-2 py-1.5 font-mono text-[11.5px] text-ink outline-none focus:border-accent"
				value={draft}
				onChange={e => onDraftChange(e.target.value)}
			/>
		);

	const tooltip = featured && meta ? `${meta.label}（${dto.key}）：${meta.description}` : dto.key;

	return (
		<div
			className={`rounded-lg border bg-surface px-3 py-2.5 ${
				dto.overridden ? "border-hairline border-l-2 border-l-accent bg-accent-dim/30" : "border-hairline"
			}`}
		>
			{/* 收起态整卡可点：进编辑（已展开再点收起） */}
			<button
				type="button"
				disabled={busy !== null && !editing}
				title={tooltip}
				className="w-full text-left disabled:cursor-not-allowed"
				onClick={() => (editing ? onCloseEditor() : onOpenEditor(dto.key, prefillBase ?? dto.effectiveValue))}
			>
				<div className="flex min-w-0 items-center gap-1.5">
					<ScopeKeyTitle dto={dto} featured={featured} />
					{dto.overridden && (
						<span className="shrink-0 rounded bg-accent-dim px-1 py-px font-mono text-3xs text-accent">覆盖</span>
					)}
					{editing && (
						<span className="ml-auto shrink-0 rounded bg-accent-dim px-1 py-px font-mono text-3xs text-accent">
							编辑中
						</span>
					)}
				</div>
				<div className="mt-1 flex min-w-0 items-baseline gap-1.5">
					<span className="shrink-0 text-[10.5px] text-ink-faint">生效</span>
					<span
						className={`min-w-0 flex-1 truncate font-mono text-[11.5px] ${effective?.present ? "text-ink-subtle" : "text-ink-faint"}`}
					>
						{effective?.present ? effective.text : (effective?.absentNote ?? "未设置")}
					</span>
				</div>
			</button>

			{/* 展开面板：说明 + 三层取值 + 编辑控件 + 恢复继承 */}
			{editing && (
				<div className="mt-2 border-t border-hairline pt-2">
					{featured && meta && (
						<div className="mb-1.5 text-[11px] leading-relaxed text-ink-subtle">{meta.description}</div>
					)}
					<div className="mb-2 space-y-0.5">
						{view.rows.map(row => (
							<div key={row.layer} className="flex items-baseline gap-2">
								<span className="w-[46px] shrink-0 text-[10.5px] text-ink-faint">{row.label}</span>
								<span
									className={`min-w-0 flex-1 truncate font-mono text-[11px] ${row.present ? (row.layer === "effective" ? "font-semibold text-ink" : "text-ink-subtle") : "text-ink-faint"}`}
									title={row.present ? row.text : row.absentNote}
								>
									{row.present ? row.text : row.absentNote}
								</span>
							</div>
						))}
					</div>
					<div className="mb-1.5 flex items-baseline gap-2 text-[10.5px] text-ink-faint">
						<span>写入目标</span>
						<span className="font-mono text-ink-subtle">
							{writeTarget === "global" ? "全局配置" : "项目配置"}
						</span>
						<span>
							· {editorHint}；当前生效值 {formatConfigValue(dto.effectiveValue)}
						</span>
					</div>
					{editorControl}
					{draftError && <div className="mt-1.5 text-[11px] text-danger">{draftError}</div>}
					<div className="mt-2 flex flex-wrap gap-2">
						<button
							type="button"
							className="btn btn-sm"
							disabled={busy !== null || writing}
							onClick={() => onSubmit(dto.key)}
						>
							{writing ? "写入中…" : writeTarget === "global" ? "写入全局配置" : "写入项目配置"}
						</button>
						<button
							type="button"
							disabled={busy !== null}
							className="rounded border border-hairline bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
							onClick={onCloseEditor}
						>
							取消
						</button>
						{dto.overridden && (
							<button
								type="button"
								disabled={busy !== null}
								title="删除项目覆盖（恢复继承），不把全局值复制进项目文件"
								className="ml-auto rounded border border-hairline bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
								onClick={() => onRestore(dto.key)}
							>
								{restoring ? "恢复中…" : "恢复继承"}
							</button>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

export function ScopeKeysSection({
	scope,
	writeTarget,
	busy,
	onRestore,
	onWrite,
}: ScopeKeysSectionProps): React.JSX.Element {
	const [editingKey, setEditingKey] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [draftError, setDraftError] = useState<string | null>(null);
	/** 展开的分组（可多组并行；空 = 全部收起）。 */
	const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());

	const openEditor = (key: string, currentValue: unknown): void => {
		setEditingKey(key);
		const kind = FEATURED_SCOPE_KEY_META.get(key)?.editor?.kind;
		if (kind === "enum") {
			setDraft(currentValue === undefined || currentValue === null ? "" : String(currentValue));
		} else if (kind === "boolean") {
			setDraft(currentValue === undefined ? "false" : String(Boolean(currentValue)));
		} else if (kind === "number") {
			setDraft(currentValue === undefined || currentValue === null ? "" : String(currentValue));
		} else {
			setDraft(currentValue === undefined ? "" : JSON.stringify(currentValue, null, 2));
		}
		setDraftError(null);
	};

	const closeEditor = (): void => {
		setEditingKey(null);
		setDraft("");
		setDraftError(null);
	};

	const submitDraft = (key: string): void => {
		const editor = FEATURED_SCOPE_KEY_META.get(key)?.editor;
		let value: unknown;
		if (editor?.kind === "enum") {
			if (draft === "") {
				setDraftError("请选择一个值");
				return;
			}
			value = draft;
		} else if (editor?.kind === "boolean") {
			value = draft === "true";
		} else if (editor?.kind === "number") {
			const n = Number(draft);
			if (draft.trim() === "" || !Number.isFinite(n)) {
				setDraftError("请输入有效数字");
				return;
			}
			value = n;
		} else {
			const parsed = parseConfigDraft(draft);
			if (!parsed.ok) {
				setDraftError(parsed.error);
				return;
			}
			value = parsed.value;
		}
		onWrite(key, value, writeTarget);
		closeEditor();
	};

	if (scope.keys.length === 0) {
		return (
			<div className="rounded-xl border border-hairline bg-surface px-5 py-10 text-center text-[13px] text-ink-faint">
				没有可覆盖的配置键
			</div>
		);
	}

	const { featured, advanced } = splitScopeKeys(scope.keys);
	const groups = groupAdvancedKeys(advanced);

	/** 网格容器：响应式 1-4 列，items-start 保证展开的长卡不拉伸同排卡片。 */
	const renderGrid = (keys: ConfigScopeKeyDto[], isFeatured: boolean): React.JSX.Element => (
		<div className="grid items-start gap-2.5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
			{keys.map(dto => (
				<ScopeKeyCard
					key={dto.key}
					dto={dto}
					featured={isFeatured}
					writeTarget={writeTarget}
					busy={busy}
					editing={editingKey === dto.key}
					draft={draft}
					draftError={draftError}
					onOpenEditor={openEditor}
					onDraftChange={setDraft}
					onCloseEditor={closeEditor}
					onSubmit={submitDraft}
					onRestore={onRestore}
				/>
			))}
		</div>
	);

	return (
		<div className="space-y-3">
			{/* 精选高频键：人话标签平铺置顶 */}
			{renderGrid(featured, true)}

			{/* 高级键：按 schema ui.tab 中文分组折叠，组内同款网格，默认全收起 */}
			{groups.length > 0 && (
				<div className="space-y-2">
					{groups.map(g => {
						const open = openGroups.has(g.tab);
						return (
							<div key={g.tab} className="rounded-xl border border-hairline bg-surface">
								<button
									type="button"
									className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-surface-2"
									onClick={() =>
										setOpenGroups(prev => {
											const next = new Set(prev);
											if (next.has(g.tab)) next.delete(g.tab);
											else next.add(g.tab);
											return next;
										})
									}
								>
									<span className="text-[13px] font-semibold text-ink">{g.label}</span>
									<span className="rounded bg-surface-2 px-1.5 py-px font-mono text-3xs text-ink-faint">
										{g.keys.length} 项
									</span>
									{g.tab === "system" && (
										<span className="text-[10.5px] text-ink-faint">schema 未归类的名单与状态键</span>
									)}
									<span className="ml-auto text-[11.5px] text-ink-faint">{open ? "收起" : "展开"}</span>
								</button>
								{open && <div className="border-t border-hairline p-3">{renderGrid(g.keys, false)}</div>}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
