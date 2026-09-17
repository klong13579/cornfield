import type { AgentCreateDto, AgentCreateInput } from "@cornfield/wire";
import { serveVerdictOf } from "../../lib/serve-verdict";

/**
 * 「创建员工」的行内表单（Agent 列表页那两个入口共用的同一个面板）。
 *
 * 它做的只有一件事：把三个字段交给 `create_agent`，把 serve 的答复**原样**带回来。所以这里
 * 既不拼 agentDir 路径（`--dir` 给父目录时客户端算不出最终路径），也不翻译错误（名字非法 /
 * 目录不可写 / mission 文件不存在 —— 那句原文就是用户唯一能据以修的东西）。
 *
 * 三态与「另一种成功」分得开：
 *   - `submitting` 里按钮禁用、状态行写「创建中」（不发第二次、也不显示上一次的结论）；
 *   - `failed` 留表单可改可重提（失败不是终点，名字就在上面等着改）；
 *   - `existing` = serve 答 `created:false`：同名 agentDir 本来就在，这次只补齐缺的骨架文件。
 *     这是**成功**，但和「新建了一个」不是一件事，所以不自动跳走 —— 跳走就等于用「建好了」
 *     替用户把「本来就有」这件事抹掉。
 *   - `created:true` 的那次成功**不在这里渲染**：列表已经刷成 serve 的现状，列表页直接进它的
 *     详情页，没有什么需要用户在这里确认的。
 */

/** 表单三个字段。空串 = 不指定（本地不替调用方把 `""` 变成某个具体目录/文件）。 */
export interface CreateAgentValues {
	/** 新 agent 的名字。 */
	name: string;
	/** `--dir`：已存在的目录当父目录（其下建 `<name>/`），不存在的路径按原样用；空 = 默认位置。 */
	dir: string;
	/** `--mission`：mission **文件路径**（不是文本）—— 它的内容成为新 agentDir 的 `mission.md`。 */
	mission: string;
}

export const EMPTY_CREATE_AGENT_VALUES: CreateAgentValues = { name: "", dir: "", mission: "" };

/** 面板此刻在说哪件事（见文件头：`created:true` 的成功由列表页直接跳详情，不落在面板状态里）。 */
export type CreateAgentPhase =
	| { kind: "idle" }
	| { kind: "submitting" }
	/** serve 答 `created:false`：同名目录本来就在，这次只补齐了缺的文件。 */
	| { kind: "existing"; agent: AgentCreateDto }
	| { kind: "failed"; message: string };

/** 提交面（`SessionStore` 与测试替身都满足它）。 */
export interface CreateAgentSubmitter {
	createAgent(input: AgentCreateInput): Promise<AgentCreateDto>;
}

export type CreateAgentOutcome = { ok: true; agent: AgentCreateDto } | { ok: false; message: string };

/** 表单值 → 命令入参：空串就是「不指定」，不把空串当成一个空目录/空路径发出去。 */
export function createAgentInputOf(values: CreateAgentValues): AgentCreateInput {
	const name = values.name.trim();
	const dir = values.dir.trim();
	const mission = values.mission.trim();
	return {
		name,
		...(dir ? { dir } : {}),
		...(mission ? { mission } : {}),
	};
}

/**
 * 提交一次创建。失败**不抛**而是原样带出 serve 的原话：调用的那一步（设置面板状态）本来就要
 * 分流成功/失败，而「失败的原因是 serve 说的哪句话」在这里就已经定了，不该让调用方再猜一遍。
 */
export async function submitCreateAgent(
	submitter: CreateAgentSubmitter,
	values: CreateAgentValues,
): Promise<CreateAgentOutcome> {
	try {
		return { ok: true, agent: await submitter.createAgent(createAgentInputOf(values)) };
	} catch (err) {
		return { ok: false, message: serveVerdictOf(err).message };
	}
}

const FIELD_CLASS =
	"w-full rounded border border-hairline bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-accent";

export function CreateAgentPanel({
	values,
	phase,
	onChange,
	onSubmit,
	onClose,
	onOpenAgent,
}: {
	values: CreateAgentValues;
	phase: CreateAgentPhase;
	onChange: (patch: Partial<CreateAgentValues>) => void;
	onSubmit: () => void;
	onClose: () => void;
	/** 进某个 agent 的详情页（「同名已存在」时由用户点，不自动跳）。 */
	onOpenAgent: (agentName: string) => void;
}): React.JSX.Element {
	const busy = phase.kind === "submitting";
	const name = values.name.trim();

	return (
		<form
			className="mb-6 rounded-lg border border-hairline bg-surface px-5 py-4"
			onSubmit={event => {
				event.preventDefault();
				if (!busy && name) onSubmit();
			}}
		>
			<div className="mb-1 flex items-baseline gap-2.5">
				<h2 className="text-[14px] font-semibold text-ink">创建员工</h2>
				<span className="text-[11px] text-ink-faint">serve 上真建一个 agentDir，并登记进 registry</span>
				<button
					type="button"
					className="ml-auto text-[12px] text-ink-subtle hover:text-ink"
					onClick={onClose}
					aria-label="收起创建表单"
				>
					收起
				</button>
			</div>

			<div className="mt-3 flex flex-col gap-2.5">
				<label className="flex items-center gap-3 text-[12px] text-ink-subtle" htmlFor="create-agent-name">
					<span className="w-[92px] shrink-0">名字</span>
					<input
						id="create-agent-name"
						value={values.name}
						onChange={event => onChange({ name: event.target.value })}
						placeholder="hr-bot"
						disabled={busy}
						className={FIELD_CLASS}
					/>
				</label>
				<label className="flex items-center gap-3 text-[12px] text-ink-subtle" htmlFor="create-agent-dir">
					<span className="w-[92px] shrink-0">目录（可选）</span>
					<input
						id="create-agent-dir"
						value={values.dir}
						onChange={event => onChange({ dir: event.target.value })}
						placeholder="留空 = ~/.cornfield/agents/<名字>"
						disabled={busy}
						className={FIELD_CLASS}
					/>
				</label>
				<label className="flex items-center gap-3 text-[12px] text-ink-subtle" htmlFor="create-agent-mission">
					<span className="w-[92px] shrink-0">mission（可选）</span>
					<input
						id="create-agent-mission"
						value={values.mission}
						onChange={event => onChange({ mission: event.target.value })}
						placeholder="/absolute/path/mission.md"
						disabled={busy}
						className={FIELD_CLASS}
					/>
				</label>
			</div>

			<div className="mt-2.5 text-[11px] text-ink-faint">
				目录与 mission 都是 serve 进程的路径（相对路径按 serve 的启动目录解析，填绝对路径最稳）。 mission
				填的是文件路径 —— 那个文件的内容会成为新 agent 的 mission.md。
			</div>

			<div className="mt-3.5 flex items-center gap-2">
				<button type="submit" className="btn btn-sm" disabled={busy || !name}>
					{busy ? "创建中…" : "创建"}
				</button>
				<button type="button" className="btn btn-secondary btn-sm" onClick={onClose} disabled={busy}>
					取消
				</button>
				{busy && (
					<span role="status" className="text-[12px] text-ink-subtle">
						正在创建 {name}…（serve 真写盘，别关页面）
					</span>
				)}
			</div>

			{phase.kind === "failed" && (
				<div role="alert" className="mt-3 rounded border border-danger/40 bg-danger/5 px-3 py-2">
					<div className="text-[11px] text-ink-faint">serve 的答复（原文）</div>
					<div className="mt-0.5 whitespace-pre-wrap font-mono text-[12px] text-danger">{phase.message}</div>
				</div>
			)}

			{phase.kind === "existing" && (
				<div className="mt-3 rounded border border-hairline-strong bg-surface-2 px-3 py-2">
					<div className="text-[12px] text-ink">
						这个名字的 agentDir 本来就在，这次只把缺的骨架文件补齐了（没有新建）。
					</div>
					<div className="mt-0.5 break-all font-mono text-[11px] text-ink-faint">{phase.agent.agentDir}</div>
					<div className="mt-2 flex gap-2">
						<button
							type="button"
							className="btn btn-secondary btn-sm"
							onClick={() => onOpenAgent(phase.agent.name)}
						>
							打开详情
						</button>
					</div>
				</div>
			)}
		</form>
	);
}
