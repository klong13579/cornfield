import { rebindWorkerPrompts } from "./planner";
import { formatMoaStatusBar, type MoaStatusBarInput } from "./status-bar";
import {
	type ExecutePlanOptions,
	qualityFailedSynthesis,
	resolvePlanOptions,
	runAskStage,
	runDiscoveryStage,
	runRewriteStage,
	runSynthesisStage,
	runWorkersStage,
} from "./stages";
import { formatDuration, formatTimingSummary, StageClock } from "./timing";
import { renderTcoForPrompt } from "./tco";
import type { MoaExecutionResult, MoaPlan } from "./types";

export type { ExecutePlanOptions } from "./stages";

function startLiveStage(options: {
	clock: StageClock;
	key: string;
	hasUI: boolean;
	workingBase: string;
	statusBase: MoaStatusBarInput;
	setWorking: (msg: string) => void;
	setMoaStatus: (text: string | undefined) => void;
}): { stop: () => number } {
	const { clock, key, hasUI, workingBase, statusBase, setWorking, setMoaStatus } = options;
	clock.start(key);
	const tick = () => {
		const elapsed = clock.elapsedMs(key);
		setWorking(`${workingBase} ${formatDuration(elapsed)}`);
		setMoaStatus(formatMoaStatusBar({ ...statusBase, elapsedMs: elapsed }));
	};
	tick();
	let interval: ReturnType<typeof setInterval> | undefined;
	if (hasUI) {
		interval = setInterval(tick, 500);
	}
	return {
		stop: () => {
			if (interval !== undefined) clearInterval(interval);
			return clock.stop(key);
		},
	};
}

export async function executePlan(plan: MoaPlan, options: ExecutePlanOptions): Promise<MoaExecutionResult> {
	const planOptions = resolvePlanOptions(plan, options);
	const effectiveMaxRounds = planOptions.hasUI ? planOptions.settings.maxRounds : 0;
	const stageCtx = { task: plan.task, settings: planOptions.settings };

	const ui = planOptions.hasUI ? options.ui : undefined;
	const notify = (msg: string, type?: "info" | "warning" | "error") => {
		if (ui && typeof (ui as { notify?: (m: string, t?: string) => void }).notify === "function") {
			(ui as { notify: (m: string, t?: string) => void }).notify(msg, type);
		}
	};
	const setWorking = (msg: string) => {
		if (ui && typeof (ui as { setWorkingMessage?: (m: string) => void }).setWorkingMessage === "function") {
			(ui as { setWorkingMessage: (m: string) => void }).setWorkingMessage(msg);
		}
	};
	const setMoaStatus = (text: string | undefined) => {
		if (ui && typeof (ui as { setStatus?: (k: string, t: string | undefined) => void }).setStatus === "function") {
			(ui as { setStatus: (k: string, t: string | undefined) => void }).setStatus("moa", text);
		}
	};
	const clearMoaStatus = () => setMoaStatus(undefined);

	const clock = new StageClock();
	clock.markTotalStart();
	const hasUI = planOptions.hasUI;

	const discoveryLive = startLiveStage({
		clock,
		key: "discovery",
		hasUI,
		workingBase: "MOA: 发现阶段 — 分析任务意图…",
		statusBase: { round: 1, maxRounds: effectiveMaxRounds || 1, phase: "discovery" },
		setWorking,
		setMoaStatus,
	});
	const discovery = await runDiscoveryStage(stageCtx, options);
	const discoveryMs = discoveryLive.stop();
	const { result: discoveryResult, tco, outputSchema } = discovery;
	notify(
		"发现完成 ✓ 识别 " +
			tco.known_inputs.length +
			" 个已知输入，" +
			tco.missing_inputs.length +
			" 个待确认 · " +
			formatDuration(discoveryMs),
	);

	const askLive = startLiveStage({
		clock,
		key: "ask",
		hasUI,
		workingBase: "MOA: 等待用户确认…",
		statusBase: {
			round: 1,
			maxRounds: effectiveMaxRounds || 1,
			phase: "asking",
			questionIndex: 1,
			questionTotal: 1,
		},
		setWorking,
		setMoaStatus,
	});
	const ask = await runAskStage(tco, stageCtx, options);
	const askMs = askLive.stop();
	const askSummary = ask.askSummary;
	if (askSummary.answered > 0) {
		notify(
			"已确认 " +
				askSummary.answered +
				" 项，" +
				askSummary.assumed +
				" 项使用假设值 · " +
				formatDuration(askMs),
		);
	}

	const schemaAwarePlan: MoaPlan = {
		...plan,
		workers: rebindWorkerPrompts(plan.workers, plan.task, outputSchema),
	};

	let tcoBlock = renderTcoForPrompt(tco, { maxBytes: planOptions.settings.tcoInjectMaxBytes });
	const rewriteLive = startLiveStage({
		clock,
		key: "rewrite",
		hasUI,
		workingBase: planOptions.settings.rewriteEnabled
			? "MOA: 改写阶段 — 生成 worker 专属提示…"
			: "MOA: worker 准备中…",
		statusBase: { round: 1, maxRounds: effectiveMaxRounds || 1, phase: "rewrite" },
		setWorking,
		setMoaStatus,
	});
	const rewrite = await runRewriteStage(tco, schemaAwarePlan, stageCtx, options, outputSchema);
	const rewriteMs = rewriteLive.stop();
	const rewriteResult = rewrite.result;
	const baseWorkers = rewrite.workers.length > 0 ? rewrite.workers : schemaAwarePlan.workers;
	if (rewriteResult?.ok) {
		notify("改写完成 ✓ 已定制 " + baseWorkers.length + " 个 worker 提示 · " + formatDuration(rewriteMs));
	} else if (rewriteResult && !rewriteResult.ok && planOptions.settings.rewriteEnabled) {
		notify(
			"改写跳过（" +
				(rewriteResult.stderr || "fallback to original") +
				"），使用原始提示 · " +
				formatDuration(rewriteMs),
			"warning",
		);
	} else {
		notify("改写已禁用，使用默认提示 · " + formatDuration(rewriteMs));
	}

	const workersResult = await runWorkersStage({
		plan: schemaAwarePlan,
		baseWorkers,
		tco,
		outputSchema,
		tcoBlock,
		ctx: stageCtx,
		options,
		effectiveMaxRounds,
		hooks: {
			notify,
			formatWorkersDone: (okCount, total, workersMs) =>
				"Worker 完成 " + okCount + "/" + total + " ✓ · " + formatDuration(workersMs),
			onRoundWorkers: ({ round, maxRounds, baseWorkers: bw }) =>
				startLiveStage({
					clock,
					key: `workers_r${round}`,
					hasUI,
					workingBase: "MOA: worker 执行中 — " + bw.length + " 个并发…",
					statusBase: {
						round,
						maxRounds,
						phase: "workers",
						workers: bw.map(w => ({ name: w.name, ok: true })),
					},
					setWorking,
					setMoaStatus,
				}),
			onRoundAskStart: ({ round, maxRounds, questionTotal, workerStatus }) => {
				const roundAskKey = `ask_r${round}`;
				return startLiveStage({
					clock,
					key: roundAskKey,
					hasUI,
					workingBase: "MOA: 等待用户确认…",
					statusBase: {
						round,
						maxRounds,
						phase: "asking",
						questionIndex: 1,
						questionTotal,
						workers: workerStatus,
					},
					setWorking,
					setMoaStatus,
				});
			},
			onAskProgress: ({ round, maxRounds, index, total, workerStatus }) => {
				setMoaStatus(
					formatMoaStatusBar({
						round,
						maxRounds,
						phase: "asking",
						questionIndex: index,
						questionTotal: total,
						workers: workerStatus,
						elapsedMs: clock.elapsedMs(`ask_r${round}`),
					}),
				);
			},
		},
	});

	tcoBlock = workersResult.tcoBlock;
	const finalPlan: MoaPlan = { ...schemaAwarePlan, workers: baseWorkers };

	const finishWithTimings = <T extends MoaExecutionResult>(result: T): T => {
		clock.stopTotal();
		const timings = clock.snapshot();
		notify(formatTimingSummary(timings));
		return { ...result, timings };
	};

	if (workersResult.surviving.length === 0) {
		clearMoaStatus();
		notify("MOA 失败：全部 worker 未通过质量检查", "error");
		return finishWithTimings({
			plan: finalPlan,
			tco: workersResult.tco,
			askSummary,
			discovery: discoveryResult,
			rewrite: rewriteResult,
			workers: workersResult.workers,
			synthesis: qualityFailedSynthesis(),
			outputSchema,
			rounds: workersResult.rounds,
			askRoundSummaries: workersResult.askRoundSummaries,
			dispatchLog: workersResult.dispatchLog,
		});
	}

	const synthesisLive = startLiveStage({
		clock,
		key: "synthesis",
		hasUI,
		workingBase: "MOA: 综合汇总中…",
		statusBase: {
			round: workersResult.rounds.length || 1,
			maxRounds: effectiveMaxRounds || 1,
			phase: "synthesis",
			workers: workersResult.surviving.map(w => ({
				name: w.name,
				ok: w.ok,
				qualityDropped: w.qualityDropped,
			})),
		},
		setWorking,
		setMoaStatus,
	});
	const synthesisOut = await runSynthesisStage(
		finalPlan,
		workersResult.surviving,
		stageCtx,
		options,
		tcoBlock,
	);
	const synthesisMs = synthesisLive.stop();
	clearMoaStatus();
	notify("MOA 完成 ✓ · " + formatDuration(synthesisMs));

	return finishWithTimings({
		plan: finalPlan,
		tco: workersResult.tco,
		askSummary,
		discovery: discoveryResult,
		rewrite: rewriteResult,
		workers: workersResult.workers,
		synthesis: synthesisOut.synthesis,
		outputSchema,
		rounds: workersResult.rounds,
		askRoundSummaries: workersResult.askRoundSummaries,
		dispatchLog: workersResult.dispatchLog,
	});
}
