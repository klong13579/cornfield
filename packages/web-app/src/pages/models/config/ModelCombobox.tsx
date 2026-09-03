import type { ModelCatalogEntryDto } from "@cornfield/wire";
import { useId, useMemo, useRef, useState } from "react";
import { availableModels, filterModels, groupModelsByProvider } from "./model-options";

/**
 * 角色编辑器的模型 combobox（#02/#03 UX 改进）：输入框 + provider 分组建议浮层。
 * - 候选仅 available 模型，按 provider 分组展示，输入即过滤（provider/modelId/名称子串）；
 * - **保留自由输入**：保存前校验闸门依赖「能输入目录外的 provider/modelId 来测禁存」，
 *   故本组件不是封闭 select——无匹配时提示但不清空输入；
 * - 键盘可达：↑↓ 移动高亮，Enter 选中高亮项（无高亮时回落到 onEnter 透传，
 *   供回退输入框沿用「回车即添加」语义），Esc 关闭浮层。
 */
interface ModelComboboxProps {
	/** 全量模型目录（组件内部过滤 available）。 */
	models: ModelCatalogEntryDto[];
	value: string;
	placeholder: string;
	/** 无障碍名（同时作为 e2e 定位锚点）。 */
	ariaLabel: string;
	disabled?: boolean;
	className: string;
	onChange(value: string): void;
	/** Enter 且无高亮项时透传（回退输入框的「回车即添加」）。 */
	onEnter?(): void;
}

export function ModelCombobox({
	models,
	value,
	placeholder,
	ariaLabel,
	disabled,
	className,
	onChange,
	onEnter,
}: ModelComboboxProps): React.JSX.Element {
	const [open, setOpen] = useState(false);
	const [hi, setHi] = useState(-1);
	const inputRef = useRef<HTMLInputElement>(null);
	const listboxId = useId();

	const suggestions = useMemo(() => filterModels(availableModels(models), value), [models, value]);
	const groups = useMemo(() => groupModelsByProvider(suggestions), [suggestions]);
	/** 展平的候选序（与浮层渲染顺序一致，供键盘高亮定位）。 */
	const flat = useMemo(() => groups.flatMap(g => g.models), [groups]);
	const indexByModel = useMemo(() => new Map(flat.map((m, i) => [m, i])), [flat]);

	const select = (m: ModelCatalogEntryDto): void => {
		onChange(`${m.provider}/${m.id}`);
		setOpen(false);
		setHi(-1);
		inputRef.current?.focus();
	};

	const close = (): void => {
		setOpen(false);
		setHi(-1);
	};

	return (
		<div className="relative">
			<input
				ref={inputRef}
				role="combobox"
				aria-label={ariaLabel}
				aria-expanded={open}
				aria-controls={open ? listboxId : undefined}
				aria-autocomplete="list"
				className={className}
				value={value}
				placeholder={placeholder}
				spellCheck={false}
				disabled={disabled}
				onChange={e => {
					onChange(e.target.value);
					setOpen(true);
					setHi(-1);
				}}
				onFocus={() => setOpen(true)}
				onBlur={() => close()}
				onKeyDown={e => {
					if (e.key === "ArrowDown") {
						e.preventDefault();
						setOpen(true);
						setHi(i => Math.min(i + 1, flat.length - 1));
					} else if (e.key === "ArrowUp") {
						e.preventDefault();
						setHi(i => Math.max(i - 1, -1));
					} else if (e.key === "Enter") {
						if (open && hi >= 0 && hi < flat.length) {
							e.preventDefault();
							select(flat[hi]);
						} else {
							onEnter?.();
						}
					} else if (e.key === "Escape") {
						close();
					}
				}}
			/>
			{open && !disabled && (
				<div
					id={listboxId}
					className="absolute top-full right-0 left-0 z-30 mt-1 max-h-64 overflow-auto rounded-md border border-hairline bg-surface shadow-lg"
					role="listbox"
					aria-label={`${ariaLabel}候选`}
				>
					{flat.length === 0 ? (
						<div className="px-3 py-2.5 text-[11.5px] text-ink-faint">
							无匹配的可用模型——可继续手动输入 provider/modelId（保存前会做存在性校验）
						</div>
					) : (
						groups.map(g => (
							<div key={g.provider}>
								<div className="sticky top-0 bg-surface-2 px-3 py-1 font-mono text-3xs text-ink-faint">
									{g.provider} · {g.models.length}
								</div>
								{g.models.map(m => {
									const index = indexByModel.get(m) ?? -1;
									return (
										<button
											key={`${m.provider}/${m.id}`}
											type="button"
											role="option"
											aria-selected={index === hi}
											className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left ${index === hi ? "bg-accent-dim/40" : "hover:bg-surface-2"}`}
											// onMouseDown 先于 input 的 onBlur 触发：preventDefault 保持焦点，
											// 选中后再主动关浮层，避免「点选项先失焦关浮层」的竞态
											onMouseDown={e => {
												e.preventDefault();
												select(m);
											}}
										>
											<span className="truncate font-mono text-[12px] text-ink">
												{m.provider}/{m.id}
											</span>
											<span className="ml-auto shrink-0 truncate text-[11px] text-ink-faint">{m.name}</span>
										</button>
									);
								})}
							</div>
						))
					)}
				</div>
			)}
		</div>
	);
}
