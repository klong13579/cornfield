/**
 * SlashPalette —— composer 斜杠命令补全下拉（W1-2）。
 *
 * 视觉基准：v8-hermes-full.html 的 .cmd-palette 段（浮层列表，圆角 12px、mono 命令名 + 描述）。
 * 交互抄 hermes commands.js：输入 / 弹出、继续输入过滤、↑↓ 选择、Enter 填充、Esc 关闭。
 *
 * 数据源：ComposerBar 通过 store.listCommands() 拉取真实命令表，以 commands prop 传入；
 * DEFAULT_COMMANDS 仅在未加载或失败时兜底（不闪空）。filterSlashCommands 纯过滤语义不变。
 */

export interface SlashCommandDef {
	name: string;
	description: string;
	/** serve list_commands 带出的分组（系统命令/会话控制/扩展命令/自定义命令/技能命令）；缺省归系统命令。 */
	group?: string;
}

/** 默认命令表——store.listCommands() 失败/为空时的 fallback（不闪空）。 */
export const DEFAULT_COMMANDS: SlashCommandDef[] = [
	{ name: "/compact", description: "手动压缩当前会话上下文" },
	{ name: "/undo", description: "撤销最近一轮对话" },
	{ name: "/model", description: "切换模型" },
	{ name: "/yolo", description: "切换免审批模式（危险）" },
	{ name: "/retry", description: "重试失败的上一轮" },
	{ name: "/usage", description: "查看 token 用量与费用" },
];

/**
 * 过滤命令：query 为空返回全部；否则按 name 子串匹配（大小写不敏感）。
 * query 是去掉前导 `/` 之后的输入片段。
 */
export function filterSlashCommands(commands: SlashCommandDef[], query: string): SlashCommandDef[] {
	const q = query.trim().toLowerCase();
	if (!q) return commands;
	return commands.filter(c => c.name.toLowerCase().includes(q));
}

export function SlashPalette({
	commands,
	query,
	activeIndex,
	onSelect,
	onHover,
}: {
	/** 全量命令表：ComposerBar 传 store.listCommands() 结果；未加载/失败时传 DEFAULT_COMMANDS。 */
	commands: SlashCommandDef[];
	/** 去掉前导 `/` 的输入片段。 */
	query: string;
	activeIndex: number;
	onSelect: (cmd: SlashCommandDef) => void;
	onHover: (index: number) => void;
}): React.JSX.Element | null {
	const filtered = filterSlashCommands(commands, query);
	if (filtered.length === 0) return null;

	return (
		<div className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-menu mx-auto max-w-[560px] rounded-[12px] border border-hairline-strong bg-surface p-1.5 shadow-xl">
			<div className="max-h-[min(45vh,420px)] overflow-y-auto overscroll-contain">
				{filtered.map((cmd, i) => {
					const prev = i > 0 ? filtered[i - 1] : undefined;
					const groupStart = !prev || prev.group !== cmd.group;
					return (
						<div key={cmd.name}>
							{groupStart && (
								<div className="sticky top-0 border-b border-hairline bg-surface px-2.5 pt-2 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
									{cmd.group ?? "系统命令"}
								</div>
							)}
							<button
								type="button"
								className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors ${i === activeIndex ? "bg-surface-2 text-ink" : "hover:bg-surface-2"}`}
								onMouseEnter={() => onHover(i)}
								onClick={() => onSelect(cmd)}
							>
								<span className="shrink-0 font-mono text-[12.5px] font-semibold text-ink">{cmd.name}</span>
								<span className="min-w-0 truncate text-[11.5px] text-ink-muted">{cmd.description}</span>
							</button>
						</div>
					);
				})}
			</div>
		</div>
	);
}
