import type { ConfigScope, ConfigScopeDto } from "@cornfield/wire";
import { useState } from "react";
import { formatConfigValue, parseConfigDraft, toScopeKeyView } from "./scope-view";

/**
 * 逐键三层展示（#05）：每个可覆盖键展示 项目值 / 全局值 / 生效值 三层，
 * overridden 键高亮并可「恢复继承」（删除项目覆盖）；每键内联编辑器按页面级写入
 * 作用域（writeTarget）提交 setConfigValue（JSON 校验，非法输入不提交）。
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

	/** 打开内联编辑器：预填写入目标作用域的当前值（无则预填生效值），JSON 缩进便于编辑。 */
	const openEditor = (key: string, currentValue: unknown): void => {
		setEditingKey(key);
		setDraft(currentValue === undefined ? "" : JSON.stringify(currentValue, null, 2));
		setDraftError(null);
	};

	const closeEditor = (): void => {
		setEditingKey(null);
		setDraft("");
		setDraftError(null);
	};

	const submitDraft = (key: string): void => {
		const parsed = parseConfigDraft(draft);
		if (!parsed.ok) {
			setDraftError(parsed.error);
			return;
		}
		onWrite(key, parsed.value, writeTarget);
		closeEditor();
	};

	if (scope.keys.length === 0) {
		return (
			<div className="rounded-xl border border-hairline bg-surface px-5 py-10 text-center text-[13px] text-ink-faint">
				没有可覆盖的配置键
			</div>
		);
	}

	return (
		<div className="overflow-hidden rounded-xl border border-hairline bg-surface">
			{scope.keys.map(dto => {
				const view = toScopeKeyView(dto);
				const restoring = busy === `restore:${dto.key}`;
				const writing = busy === `write:${dto.key}`;
				/** 编辑器预填基准：写入目标作用域的当前值，未设置则用生效值。 */
				const prefillBase = writeTarget === "project" ? dto.projectValue : dto.globalValue;
				return (
					<div
						key={dto.key}
						className={`border-b border-hairline px-5 py-4 last:border-b-0 ${dto.overridden ? "border-l-2 border-l-accent bg-accent-dim/30" : ""}`}
					>
						<div className="flex items-center gap-2.5">
							<span className="font-mono text-[14px] font-semibold text-ink">{dto.key}</span>
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
									onClick={() => openEditor(dto.key, prefillBase ?? dto.effectiveValue)}
								>
									{editingKey === dto.key ? "编辑中" : "编辑"}
								</button>
							</span>
						</div>

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
						{editingKey === dto.key && (
							<div className="mt-3 rounded-lg border border-hairline bg-surface-2 px-3.5 py-3">
								<div className="mb-2 flex items-baseline gap-2 text-[11px] text-ink-faint">
									<span>写入目标</span>
									<span className="font-mono text-ink-subtle">
										{writeTarget === "global" ? "全局配置" : "项目配置"}
									</span>
									<span>· 整键替换（JSON）；当前生效值 {formatConfigValue(dto.effectiveValue)}</span>
								</div>
								<textarea
									className="h-28 w-full resize-y rounded-md border border-hairline bg-surface px-2.5 py-2 font-mono text-[12px] text-ink outline-none focus:border-accent"
									value={draft}
									onChange={e => {
										setDraft(e.target.value);
										setDraftError(null);
									}}
									spellCheck={false}
								/>
								{draftError && <div className="mt-1.5 text-[11.5px] text-danger">{draftError}</div>}
								<div className="mt-2.5 flex gap-2">
									<button
										type="button"
										className="btn btn-sm"
										disabled={busy !== null || writing}
										onClick={() => submitDraft(dto.key)}
									>
										{writing ? "写入中…" : writeTarget === "global" ? "写入全局配置" : "写入项目配置"}
									</button>
									<button
										type="button"
										disabled={busy !== null}
										className="rounded border border-hairline bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
										onClick={closeEditor}
									>
										取消
									</button>
								</div>
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}
