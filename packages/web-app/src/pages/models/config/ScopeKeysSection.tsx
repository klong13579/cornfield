import type { ConfigScope, ConfigScopeDto, ConfigScopeKeyDto } from "@cornfield/wire";
import { useState } from "react";
import { FEATURED_SCOPE_KEY_META, splitScopeKeys, type ScopeKeyEditor } from "./scope-keys";
import { formatConfigValue, parseConfigDraft, toScopeKeyView } from "./scope-view";

/**
 * 逐键三层展示（#05 + UX 策展）：精选高频键置顶（中文人话标签 + 说明），
 * 其余键收进「高级」折叠组（默认收起，展开后功能完整）。每个键展示
 * 项目值 / 全局值 / 生效值 三层，overridden 键高亮并可「恢复继承」（删除项目
 * 覆盖）；每键内联编辑器按页面级写入作用域（writeTarget）提交 setConfigValue
 * （JSON 校验，非法输入不提交）。草稿与编辑状态统一持有于本组件（同一时刻
 * 至多一个编辑器打开）。
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

/** 单键卡片头：精选键显示中文标签为主标题（键名 mono 副标题），高级键直接显示键名。 */
function ScopeKeyTitle({ dto, featured }: { dto: ConfigScopeKeyDto; featured: boolean }): React.JSX.Element {
	const meta = FEATURED_SCOPE_KEY_META.get(dto.key);
	if (featured && meta) {
		return (
			<span className="flex min-w-0 items-baseline gap-2">
				<span className="text-[13.5px] font-semibold text-ink">{meta.label}</span>
				<span className="truncate font-mono text-[11px] text-ink-faint" title={dto.key}>
					{dto.key}
				</span>
			</span>
		);
	}
	return <span className="font-mono text-[14px] font-semibold text-ink">{dto.key}</span>;
}

/** 单键卡片：徽章 + 恢复继承 / 编辑 + 三层取值 + 内联编辑器（草稿状态由上层传入）。 */
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
	const editor: ScopeKeyEditor | undefined = FEATURED_SCOPE_KEY_META.get(dto.key)?.editor;

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
			className="h-28 w-full resize-y rounded-md border border-hairline bg-surface px-2.5 py-2 font-mono text-[12px] text-ink outline-none focus:border-accent"
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
				className="w-full rounded-md border border-hairline bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-accent"
				value={draft}
				onChange={e => onDraftChange(e.target.value)}
			>
				{draft !== "" && !editor.values.includes(draft) && <option value={draft}>{`${draft}（当前配置值）`}</option>}
				{editor.values.map(v => (
					<option key={v} value={v}>
						{v}
					</option>
				))}
			</select>
		) : editor.kind === "boolean" ? (
			<select
				className="w-full rounded-md border border-hairline bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-accent"
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
				className="w-full rounded-md border border-hairline bg-surface px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-accent"
				value={draft}
				onChange={e => onDraftChange(e.target.value)}
			/>
		);

	return (
		<div
			className={`border-b border-hairline px-5 py-4 last:border-b-0 ${dto.overridden ? "border-l-2 border-l-accent bg-accent-dim/30" : ""}`}
		>
			<div className="flex items-center gap-2.5">
				<ScopeKeyTitle dto={dto} featured={featured} />
				{dto.overridden ? (
					<span className="rounded bg-accent-dim px-1.5 py-px font-mono text-3xs text-accent">覆盖</span>
				) : (
					<span className="rounded px-1.5 py-px font-mono text-3xs text-ink-faint">继承</span>
				)}
				<span className="ml-auto flex shrink-0 gap-1.5">
					{dto.overridden && (
						<button
							type="button"
							disabled={busy !== null}
							title="删除项目覆盖（恢复继承），不把全局值复制进项目文件"
							className="rounded border border-hairline bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
							onClick={() => onRestore(dto.key)}
						>
							{restoring ? "恢复中…" : "恢复继承"}
						</button>
					)}
					<button
						type="button"
						disabled={busy !== null}
						className="btn btn-sm"
						onClick={() => onOpenEditor(dto.key, prefillBase ?? dto.effectiveValue)}
					>
						{editing ? "编辑中" : "编辑"}
					</button>
				</span>
			</div>
			{featured && meta && <div className="mt-1 text-[11.5px] text-ink-subtle">{meta.description}</div>}

			{/* 三层取值：项目值 / 全局值 / 生效值（生效值为主展示） */}
			<div className="mt-2.5 space-y-1">
				{view.rows.map(row => (
					<div key={row.layer} className="flex items-baseline gap-3">
						<span className="w-[52px] shrink-0 text-[11px] text-ink-faint">{row.label}</span>
						{row.present ? (
							<span
								className={`min-w-0 flex-1 truncate font-mono text-[12.5px] ${row.layer === "effective" ? "font-semibold text-ink" : "text-ink-subtle"}`}
								title={row.text}
							>
								{row.text}
							</span>
						) : (
							<span
								className="min-w-0 flex-1 truncate text-[12px] text-ink-faint"
								title={row.absentNote}
							>
								{row.absentNote}
							</span>
						)}
					</div>
				))}
			</div>

			{/* 内联编辑器：JSON 校验，按页面级写入作用域提交 */}
			{editing && (
				<div className="mt-3 rounded-lg border border-hairline bg-surface-2 px-3.5 py-3">
					<div className="mb-2 flex items-baseline gap-2 text-[11px] text-ink-faint">
						<span>写入目标</span>
						<span className="font-mono text-ink-subtle">
							{writeTarget === "global" ? "全局配置" : "项目配置"}
						</span>
						<span>· {editorHint}；当前生效值 {formatConfigValue(dto.effectiveValue)}</span>
					</div>
					{editorControl}
					{draftError && <div className="mt-1.5 text-[11.5px] text-danger">{draftError}</div>}
					<div className="mt-2.5 flex gap-2">
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
	const [advancedOpen, setAdvancedOpen] = useState(false);

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

	const renderCard = (dto: ConfigScopeKeyDto, isFeatured: boolean): React.JSX.Element => (
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
	);

	return (
		<div className="space-y-3">
			{/* 精选高频键：人话标签 + 说明置顶 */}
			<div className="overflow-hidden rounded-xl border border-hairline bg-surface">
				{featured.map(dto => renderCard(dto, true))}
			</div>

			{/* 高级键：默认折叠，展开后功能完整 */}
			{advanced.length > 0 && (
				<div className="overflow-hidden rounded-xl border border-hairline bg-surface">
					<button
						type="button"
						className="flex w-full items-center gap-2 px-5 py-3 text-left transition-colors hover:bg-surface-2"
						onClick={() => setAdvancedOpen(open => !open)}
					>
						<span className="text-[13px] font-semibold text-ink">高级配置</span>
						<span className="rounded bg-surface-2 px-1.5 py-px font-mono text-3xs text-ink-faint">
							{advanced.length} 项
						</span>
						<span className="ml-auto text-[11.5px] text-ink-faint">{advancedOpen ? "收起" : "展开"}</span>
					</button>
					{advancedOpen && advanced.map(dto => renderCard(dto, false))}
				</div>
			)}
		</div>
	);
}
