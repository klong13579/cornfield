import { Fragment, useEffect, useMemo, useState } from "react";
import type { CronLogEntryDto, TaskRowDto } from "@oh-my-pi/pi-wire"
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";
import {
	buildCronExpression,
	CRON_SCHEDULE_PRESETS,
	type CronPresetId,
	type CronPresetValues,
	cronFieldBounds,
	cronPreset,
	previewCronExpression,
	stateFromCronExpression,
} from "./cron-schedule";

/**
 * 定时任务面板（W3 D4 TasksPanel 壳）—— preset 体系 + 表达式实时预览 + 任务列表空态。
 *
 * 数据层（列表/创建/运行/日志）等 B6 gateway cron 代理命令落地后接入（wire-dto TaskRowDto
 * 已按 ScheduledTask 预留形状）；当前一律渲染空态/禁用态，不 mock 数据。
 * 表达式预览用 croner——与 gateway scheduler 同库，语义一致。
 */

const WEEKDAYS: { value: number; label: string }[] = [
	{ value: 1, label: "周一" },
	{ value: 2, label: "周二" },
	{ value: 3, label: "周三" },
	{ value: 4, label: "周四" },
	{ value: 5, label: "周五" },
	{ value: 6, label: "周六" },
	{ value: 0, label: "周日" },
];

function fmtRun(ts: number): string {
	const d = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 未指定 agent 的分组标识（jobs.json 无 accountId 字段的任务归此组，不伪造数据）。 */
export const UNSPECIFIED_AGENT_LABEL = "未指定";

export interface CronTaskGroupDto {
	/** 分组键：accountId；空串 = 未指定。 */
	accountId: string;
	/** 组头展示名：accountId 或「未指定」。 */
	label: string;
	tasks: TaskRowDto[];
}

/**
 * 定时任务按 agent（accountId）分组：组内保持 serve 顺序，组间保持首现顺序，
 * 「未指定」组（无 accountId 或空串）固定垫底。纯函数——从 TaskListCard 提出，便于单测
 * （无 accountId 归组、多 accountId 分桶）。
 */
export function groupTasksByAccount(tasks: TaskRowDto[]): CronTaskGroupDto[] {
	const byAccount = new Map<string, TaskRowDto[]>();
	for (const task of tasks) {
		const key = task.accountId?.trim() || "";
		const list = byAccount.get(key);
		if (list) list.push(task);
		else byAccount.set(key, [task]);
	}
	const groups: CronTaskGroupDto[] = [];
	for (const [accountId, list] of byAccount) {
		if (accountId === "") continue; // 未指定组垫底
		groups.push({ accountId, label: accountId, tasks: list });
	}
	const unspecified = byAccount.get("");
	if (unspecified) groups.push({ accountId: "", label: UNSPECIFIED_AGENT_LABEL, tasks: unspecified });
	return groups;
}

export function TasksView(): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const [tasks, setTasks] = useState<TaskRowDto[]>([]);
	const [logs, setLogs] = useState<CronLogEntryDto[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [logTask, setLogTask] = useState<TaskRowDto | null>(null);

	useEffect(() => {
		if (!view.connected) return;
		setError(null);
		void store
			.fetchCronTasks()
			.then(r => setTasks(r.tasks))
			.catch(err => setError(err instanceof Error ? err.message : String(err)));
		void store
			.fetchCronLogs({ days: 3, limit: 200 })
			.then(r => setLogs(r.logs))
			.catch(() => undefined);
	}, [store, view.connected]);

	return (
		<div className="px-10 pt-8 pb-12">
			<div className="mx-auto max-w-[1000px]">
				<h1 className="mb-7 text-[32px] font-semibold tracking-[-0.8px] text-ink">定时任务</h1>
				<div className="space-y-8">
					<CronFormCard />
					<TaskListCard
						tasks={tasks}
						logs={logs}
						error={error}
						connected={view.connected}
						onShowLogs={setLogTask}
					/>
				</div>
			</div>

			{logTask && <TaskLogPanel task={logTask} onClose={() => setLogTask(null)} />}
		</div>
	);
}

function CronFormCard(): React.JSX.Element {
	const [presetId, setPresetId] = useState<CronPresetId>("daily");
	const [minute, setMinute] = useState("0");
	const [time, setTime] = useState("09:00");
	const [weekday, setWeekday] = useState("1");
	const [monthDay, setMonthDay] = useState("1");
	const [raw, setRaw] = useState("");

	const preset = cronPreset(presetId) ?? CRON_SCHEDULE_PRESETS[1];

	const values: CronPresetValues = useMemo(() => {
		if (presetId === "hourly") return { minute: Number(minute) };
		const [h = "9", m = "0"] = time.split(":");
		return {
			hour: Number(h),
			minute: Number(m),
			...(presetId === "weekly" ? { weekday: Number(weekday) } : {}),
			...(presetId === "monthly" ? { monthDay: Number(monthDay) } : {}),
		};
	}, [presetId, minute, time, weekday, monthDay]);

	const expr = presetId === "custom" ? raw.trim() : buildCronExpression(presetId, values);

	const preview = useMemo(() => previewCronExpression(expr, 3), [expr]);

	// 反向识别：用户改了非 custom 字段时不做改写，仅 custom 输入合法时提示可识别预设
	const detected = useMemo(
		() => (presetId === "custom" && preview.valid ? stateFromCronExpression(expr) : null),
		[presetId, preview.valid, expr],
	);

	return (
		<div className="rounded-xl border border-hairline bg-surface">
			<div className="px-5 pt-4 pb-2 text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
				新建定时任务 · 配置预览
			</div>

			<div className="space-y-4 px-5 pb-5">
				{/* 预设 */}
				<div>
					<label className="block">
						<span className="mb-1 block text-[12px] font-medium text-ink-subtle">预设</span>
						<select
							value={presetId}
							onChange={e => {
								const id = e.target.value as CronPresetId;
								setPresetId(id);
								// 切预设时把当前表达式反向映射回字段值（custom → 识别出的预设控件）
								if (id === "custom") {
									setRaw(buildCronExpression(presetId, values));
								} else if (presetId === "custom") {
									const state = stateFromCronExpression(raw);
									if (state.presetId === id) {
										if (state.values.hour !== undefined)
											setTime(
												`${String(state.values.hour).padStart(2, "0")}:${String(state.values.minute ?? 0).padStart(2, "0")}`,
											);
										if (state.values.minute !== undefined) setMinute(String(state.values.minute));
										if (state.values.weekday !== undefined) setWeekday(String(state.values.weekday));
										if (state.values.monthDay !== undefined) setMonthDay(String(state.values.monthDay));
									}
								}
							}}
							className="w-full rounded-md border border-hairline bg-surface-2 px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-dim)]"
						>
							{CRON_SCHEDULE_PRESETS.map(p => (
								<option key={p.id} value={p.id}>
									{p.label}
								</option>
							))}
						</select>
					</label>
				</div>

				{/* 预设字段 */}
				{presetId !== "custom" && (
					<div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
						{preset.fields.includes("minute") && (
							<Field id="cron-minute" label="分钟" hint="每小时的第几分钟">
								<NumberField
									id="cron-minute"
									bounds={cronFieldBounds("minute")}
									value={minute}
									onChange={setMinute}
								/>
							</Field>
						)}
						{preset.fields.includes("time") && (
							<Field id="cron-time" label="时间" hint="HH:MM">
								<input
									id="cron-time"
									type="time"
									value={time}
									onChange={e => setTime(e.target.value)}
									className="w-full rounded-md border border-hairline bg-surface-2 px-2.5 py-2 font-mono text-[13px] text-ink outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-dim)]"
								/>
							</Field>
						)}
						{preset.fields.includes("weekday") && (
							<Field id="cron-weekday" label="星期" hint="cron：0=周日">
								<select
									id="cron-weekday"
									value={weekday}
									onChange={e => setWeekday(e.target.value)}
									className="w-full rounded-md border border-hairline bg-surface-2 px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-dim)]"
								>
									{WEEKDAYS.map(w => (
										<option key={w.value} value={w.value}>
											{w.label}（{w.value}）
										</option>
									))}
								</select>
							</Field>
						)}
						{preset.fields.includes("monthDay") && (
							<Field id="cron-monthDay" label="每月第几天" hint="1-31">
								<NumberField
									id="cron-monthDay"
									bounds={cronFieldBounds("monthDay")}
									value={monthDay}
									onChange={setMonthDay}
								/>
							</Field>
						)}
					</div>
				)}

				{/* 自定义原始表达式 */}
				{presetId === "custom" && (
					<Field id="cron-custom" label="cron 表达式" hint="5 字段：分 时 日 月 星期（周日=0）">
						<input
							id="cron-custom"
							value={raw}
							onChange={e => setRaw(e.target.value)}
							placeholder="0 9 * * 1-5"
							spellCheck={false}
							className="w-full rounded-md border border-hairline bg-surface-2 px-2.5 py-2 font-mono text-[13px] text-ink outline-none placeholder:text-ink-faint focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-dim)]"
						/>
					</Field>
				)}

				{/* 表达式 + 下次触发预览 */}
				<div className="rounded-md border border-hairline bg-surface-2 px-3 py-2.5">
					<div className="flex items-baseline justify-between">
						<div className="text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase">表达式</div>
						{preview.valid && presetId !== "custom" && (
							<div className="font-mono text-[11px] text-ink-faint">cron 表达式（预览）</div>
						)}
					</div>
					<div className="mt-1 font-mono text-[14px] text-ink">
						{expr || <span className="text-ink-faint">（空）</span>}
					</div>
					{!preview.valid && expr && (
						<div className="mt-1 text-[11.5px] text-ink-faint">表达式无效：{preview.error}</div>
					)}
					{preview.valid && preview.nextRuns.length > 0 && (
						<div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
							{preview.nextRuns.map((ts, i) => (
								<div key={ts} className="font-mono text-[11.5px] text-ink-subtle">
									<span className="mr-1 text-ink-faint">{i === 0 ? "下次" : `第 ${i + 1} 次`}</span>
									{fmtRun(ts)}
								</div>
							))}
						</div>
					)}
					{detected && detected.presetId !== "custom" && (
						<div className="mt-1 text-[11px] text-ink-faint">
							识别为预设「{cronPreset(detected.presetId)?.label}」——切换预设可直接编辑
						</div>
					)}
				</div>

				{/* 保存：B6 网关代理命令落地前禁用 */}
				<div className="flex items-center gap-3">
					<button
						type="button"
						disabled
						title="B6 gateway cron 代理命令落地后可创建任务"
						className="cursor-not-allowed rounded-md bg-accent/40 px-4 py-2 text-[13px] font-semibold text-on-accent/60"
					>
						创建任务
					</button>
					<span className="text-[11.5px] text-ink-faint">
						创建/保存待 B6 gateway 代理命令接入（当前仅配置预览）
					</span>
				</div>
			</div>
		</div>
	);
}

function Field({
	id,
	label,
	hint,
	children,
}: {
	id: string;
	label: string;
	hint: string;
	children: React.ReactNode;
}): React.JSX.Element {
	return (
		<div>
			<label htmlFor={id} className="mb-1 block text-[12px] font-medium text-ink-subtle">
				{label}
				<span className="ml-1.5 font-mono text-[10.5px] text-ink-faint">{hint}</span>
			</label>
			{children}
		</div>
	);
}

function NumberField({
	id,
	bounds,
	value,
	onChange,
}: {
	id: string;
	bounds: { min: number; max: number };
	value: string;
	onChange: (v: string) => void;
}): React.JSX.Element {
	return (
		<input
			id={id}
			type="number"
			min={bounds.min}
			max={bounds.max}
			value={value}
			onChange={e => onChange(e.target.value)}
			className="w-full rounded-md border border-hairline bg-surface-2 px-2.5 py-2 font-mono text-[13px] text-ink outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-dim)]"
		/>
	);
}

function TaskRow({
	task,
	lastLog,
	onShowLogs,
}: {
	task: TaskRowDto;
	lastLog: CronLogEntryDto | undefined;
	onShowLogs: (task: TaskRowDto) => void;
}): React.JSX.Element {
	return (
		<div className="flex items-start gap-3 border-t border-hairline px-5 py-3">
			<div className="min-w-0 flex-1">
				<div className="flex items-baseline gap-2">
					<span className="text-[13.5px] font-medium text-ink">{task.name}</span>
					<span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-faint">
						{task.scheduleType}
					</span>
					{task.accountId && (
						<span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-faint">
							{task.accountId}
						</span>
					)}
					{!task.enabled && (
						<span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-faint">
							disabled
						</span>
					)}
				</div>
				{task.cron && <div className="mt-0.5 font-mono text-[11.5px] text-ink-subtle">{task.cron}</div>}
				<div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-ink-faint">
					{task.nextRunAt !== undefined && task.nextRunAt > 0 && <span>下次：{fmtRun(task.nextRunAt)}</span>}
					{task.runCount !== undefined && <span>已运行 {task.runCount} 次</span>}
					{(task.consecutiveFailures ?? 0) > 0 && (
						<span className="text-warning">连续失败 {task.consecutiveFailures} 次</span>
					)}
				</div>
				{(() => {
					if (!lastLog) return null;
					return (
						<div className="mt-1 flex items-baseline gap-2 text-[11px] text-ink-faint">
							<span
								className={
									lastLog.status === "success" ? "font-medium text-success" : "font-medium text-danger"
								}
							>
								{lastLog.status}
							</span>
							<span className="font-mono">{fmtRun(lastLog.ts)}</span>
							{lastLog.durationMs !== null && <span>{(lastLog.durationMs / 1000).toFixed(1)}s</span>}
							{lastLog.output && (
								<span className="truncate pl-1 text-ink-faint">{lastLog.output.slice(0, 80)}</span>
							)}
						</div>
					);
				})()}
			</div>

			<div className="mt-0.5 flex shrink-0 gap-1.5">
				<button
					type="button"
					onClick={() => onShowLogs(task)}
					aria-label={`${task.name} 查看日志`}
					className="rounded-md border border-hairline bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink"
				>
					日志
				</button>
				{/* 运行/修改：B6 代理只读；写操作仍走 gateway 直连（未接） */}
				<button
					type="button"
					disabled
					title="立即运行/修改调度需 gateway 侧直连（当前为只读代理）"
					aria-label={`${task.name} 运行操作`}
					className="cursor-not-allowed rounded-md border border-hairline bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-faint"
				>
					运行
				</button>
			</div>
		</div>
	);
}

function TaskListCard({
	tasks,
	logs,
	error,
	connected,
	onShowLogs,
}: {
	tasks: TaskRowDto[];
	logs: CronLogEntryDto[];
	error: string | null;
	connected: boolean;
	onShowLogs: (task: TaskRowDto) => void;
}): React.JSX.Element {
	// 最近一次运行（按 ts 取各任务最新）
	const lastRunByTask = useMemo(() => {
		const map = new Map<string, CronLogEntryDto>();
		for (const log of logs) {
			const prev = map.get(log.taskId);
			if (!prev || log.ts > prev.ts) map.set(log.taskId, log);
		}
		return map;
	}, [logs]);

	const groups = useMemo(() => groupTasksByAccount(tasks), [tasks]);

	return (
		<div className="rounded-xl border border-hairline bg-surface">
			<div className="flex items-baseline justify-between px-5 pt-4 pb-2">
				<div className="text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase">任务列表</div>
				<div className="font-mono text-[11px] text-ink-faint">
					{connected && !error ? `${tasks.length} 个任务 · 来自 gateway jobs.json（只读代理）` : ""}
				</div>
			</div>

			{!connected && <div className="px-5 pb-6 text-center text-[12px] text-ink-faint">未连接——任务列表不可用</div>}
			{error && <div className="px-5 pb-6 text-center text-[12px] text-ink-faint">任务列表不可用：{error}</div>}
			{connected && !error && tasks.length === 0 && (
				<div className="px-5 pb-6 text-center text-[12px] text-ink-faint">
					暂无定时任务——serve 直读 ~/.omp/gateway-data/scheduler/jobs.json（B6 只读代理）
				</div>
			)}

			{connected && !error && tasks.length > 0 && (
				<div className="pb-2">
					{groups.map((group, gi) => (
						<Fragment key={group.accountId || UNSPECIFIED_AGENT_LABEL}>
							<div
								className={`flex items-baseline justify-between border-t border-hairline px-5 py-2 ${gi === 0 ? "border-t-0" : ""}`}
							>
								<span className="text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
									{group.label}
								</span>
								<span className="font-mono text-[11px] text-ink-faint">{group.tasks.length} 个任务</span>
							</div>
							{group.tasks.map(task => (
								<TaskRow
									key={task.id}
									task={task}
									lastLog={lastRunByTask.get(task.name)}
									onShowLogs={onShowLogs}
								/>
							))}
						</Fragment>
					))}
				</div>
			)}
		</div>
	);
}

/** 任务日志弹层：get_cron_logs(taskId) 最近 30 条运行记录（只读，直读日志文件）。 */
function TaskLogPanel({ task, onClose }: { task: TaskRowDto; onClose: () => void }): React.JSX.Element {
	const store = useSessionStore();
	const [entries, setEntries] = useState<CronLogEntryDto[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());

	useEffect(() => {
		let alive = true;
		setEntries(null);
		setError(null);
		void store
			.fetchCronLogs({ taskId: task.name, days: 7, limit: 30 })
			.then(r => {
				if (alive) setEntries(r.logs);
			})
			.catch(err => {
				if (alive) setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			alive = false;
		};
	}, [store, task.name]);

	const toggleExpand = (id: string) => {
		setExpanded(prev => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	return (
		<div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/40 p-6" role="dialog" aria-modal="true">
			<div className="mt-8 max-h-[80vh] w-full max-w-2xl overflow-hidden rounded-xl border border-hairline bg-surface shadow-2xl">
				<div className="flex items-baseline justify-between border-b border-hairline px-5 py-3">
					<div className="min-w-0">
						<span className="text-[14px] font-semibold text-ink">{task.name}</span>
						<span className="ml-2 font-mono text-[11px] text-ink-faint">运行日志 · 最近 7 天</span>
					</div>
					<button
						type="button"
						onClick={onClose}
						aria-label="关闭日志"
						className="rounded-md px-2 py-1 text-[12px] text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
					>
						关闭 ✕
					</button>
				</div>

				<div className="max-h-[70vh] overflow-y-auto">
					{error && <div className="px-5 py-8 text-center text-[12px] text-ink-faint">日志不可用：{error}</div>}
					{!error && entries === null && (
						<div className="px-5 py-8 text-center text-[12px] text-ink-faint">加载日志…</div>
					)}
					{!error && entries !== null && entries.length === 0 && (
						<div className="px-5 py-8 text-center text-[12px] text-ink-faint">该任务近 7 天无运行记录</div>
					)}
					{entries?.map(entry => (
						<div key={entry.id} className="border-b border-hairline px-5 py-2.5 last:border-b-0">
							<div className="flex items-baseline gap-2.5">
								<span
									className={
										entry.status === "success"
											? "font-mono text-[10.5px] font-semibold text-success"
											: entry.status === "failed" || entry.status === "fail"
												? "font-mono text-[10.5px] font-semibold text-danger"
												: "font-mono text-[10.5px] font-semibold text-ink-subtle"
									}
								>
									{entry.status}
								</span>
								<span className="font-mono text-[11px] text-ink-subtle">{fmtRun(entry.ts)}</span>
								{entry.durationMs !== null && (
									<span className="font-mono text-[10.5px] text-ink-faint">
										{(entry.durationMs / 1000).toFixed(1)}s
									</span>
								)}
								{entry.exitCode !== null && (
									<span className="font-mono text-[10.5px] text-ink-faint">exit {entry.exitCode}</span>
								)}
								<button
									type="button"
									onClick={() => toggleExpand(entry.id)}
									disabled={!entry.output}
									className="ml-auto rounded px-1.5 py-0.5 font-mono text-[10.5px] text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink disabled:cursor-default disabled:hover:bg-transparent"
								>
									{entry.output ? (expanded.has(entry.id) ? "收起" : "展开") : "—"}
								</button>
							</div>
							{(expanded.has(entry.id) || (entry.output?.length ?? 0) < 120) && entry.output && (
								<div className="mt-1">
									<pre className="max-h-56 overflow-auto rounded-md border border-hairline bg-surface-2 px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-subtle">
										{entry.output}
									</pre>
									{entry.outputTruncated && (
										<div className="mt-0.5 text-[10px] text-ink-faint">输出超过 2KB 已截断</div>
									)}
								</div>
							)}
							{(entry.output?.length ?? 0) >= 120 && !expanded.has(entry.id) && entry.output && (
								<div className="mt-1 max-h-16 overflow-hidden font-mono text-[10.5px] text-ink-faint">
									{entry.output.slice(0, 140)}…
								</div>
							)}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
