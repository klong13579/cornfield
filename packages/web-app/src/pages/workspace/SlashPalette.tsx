/**
 * SlashPalette —— composer 斜杠命令补全下拉（W1-2）。
 *
 * 视觉基准：v8-hermes-full.html 的 .cmd-palette 段（浮层列表，圆角 12px、mono 命令名 + 描述）。
 * 交互抄 hermes commands.js：输入 / 弹出、继续输入过滤、↑↓ 选择、Enter 填充、Esc 关闭。
 *
 * 数据源：先硬编码起步命令表（/compact /undo /model /yolo /retry /usage 六个）。
 * serve 的 list_commands 命令尚未实现——组件已留 fetch 接口（见 useCommands fetch 位置），
 * 后端命令就绪后把 DEFAULT_COMMANDS 替换为 `store.listCommands()` 即可，UI 不动。
 */

export interface SlashCommandDef {
	name: string;
	description: string;
}

/** 起步命令表（serve list_commands 未就绪前的本地兜底）。 */
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
	query,
	activeIndex,
	onSelect,
	onHover,
}: {
	/** 去掉前导 `/` 的输入片段。 */
	query: string;
	activeIndex: number;
	onSelect: (cmd: SlashCommandDef) => void;
	onHover: (index: number) => void;
}): React.JSX.Element | null {
	const filtered = filterSlashCommands(DEFAULT_COMMANDS, query);
	if (filtered.length === 0) return null;

	return (
		<div className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-40 mx-auto max-w-[520px] rounded-[12px] border border-hairline-strong bg-surface p-1.5 shadow-xl">
			{filtered.map((cmd, i) => (
				<button
					key={cmd.name}
					type="button"
					className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors ${i === activeIndex ? "bg-accent-dim" : "hover:bg-surface-2"}`}
					onMouseEnter={() => onHover(i)}
					onClick={() => onSelect(cmd)}
				>
					<span className="shrink-0 font-mono text-[12.5px] font-semibold text-ink">{cmd.name}</span>
					<span className="min-w-0 truncate text-[11.5px] text-ink-muted">{cmd.description}</span>
				</button>
			))}
		</div>
	);
}
