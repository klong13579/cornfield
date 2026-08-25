/**
 * cron 结果形状（B6 gateway 代理：get_cron_tasks / get_cron_logs）。
 * 字段对齐 omp-gateway scheduler 的 jobs.json / 执行日志。
 */

/** 定时任务行（对齐 omp-gateway ScheduledTask 可见字段）。 */
export interface TaskRowDto {
	id: string;
	name: string;
	description?: string;
	/** cron / interval / once。 */
	scheduleType: "cron" | "interval" | "once";
	/** 5 字段 cron 表达式（scheduleType=cron 时）。 */
	cron?: string;
	/** 下次触发（毫秒）。 */
	nextRunAt?: number;
	lastRunAt?: number;
	enabled: boolean;
	accountId?: string;
	/** 执行命令（jobs.json command）。 */
	command?: string;
	runCount?: number;
	failCount?: number;
	consecutiveFailures?: number;
}

/** cron 执行日志条目（output/stderr 服务端已截断 2KB）。 */
export interface CronLogEntryDto {
	taskId: string;
	id: string;
	ts: number;
	status: string;
	exitCode: number | null;
	durationMs: number | null;
	output?: string;
	outputTruncated?: boolean;
	stderr?: string;
}
