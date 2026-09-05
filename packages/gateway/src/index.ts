/**
 * @cornfield/gateway
 *
 * IM gateway for CornField — the standalone daemon binary (`cornfield-gateway`)
 * that hosts IM channels, the cron scheduler, and the agent bridge.
 *
 * Since the binary split: gateway daemon logic ships in this package and is
 * compiled to `~/.local/bin/cornfield-gateway`; the coding-agent (`omp`) is the
 * agent runtime and is spawned on demand via `omp --mode wire-stdio` (Wire
 * protocol, pi-wire frames on stdio).
 *
 * Architecture:
 *   [IM Platform] → [Channel] → [Gateway] → [Session Store] → [Agent Bridge] → [omp --mode wire-stdio]
 *
 * Channels supported: DingTalk (with Stream mode), Feishu, WeChat (planned).
 */

export { AgentBridge } from "./agent-bridge";
export { BaseChannel, ChannelRegistry, DingTalkChannel } from "./channels";
export { getConfigPath, getDataDir, getDingTalkConfig, getEnabledChannels, loadConfig } from "./config";
export { Gateway } from "./gateway";
export type {
	DaemonOptions,
	DaemonStatus,
	EngineOptions,
	ExecutionLogEntry,
	ExecutionOptions,
	ExecutionResult,
	ParsedSchedule,
	RetryConfig,
	ScheduledTask,
	SchedulerConfig,
	SchedulerStorage,
	TaskExecution,
	TaskFileDefinition,
	TaskStatus,
	TaskType,
} from "./scheduler";
export {
	appendExecutionLog,
	clearDaemonPid,
	DEFAULT_SCHEDULER_CONFIG,
	executeScheduledCommand,
	formatExecutionRow,
	formatNextRuns,
	formatTaskRow,
	generateExecutionId,
	generateTaskId,
	getNextRun,
	getNextRuns,
	getSchedulerDbPath,
	getSchedulerDir,
	getSchedulerLogPath,
	getSchedulerPidPath,
	getSchedulerScriptsDir,
	isDaemonRunning,
	JsonFileStorage,
	parseSchedule,
	pruneAllLogs,
	pruneExecutionLog,
	readDaemonPid,
	readExecutionLog,
	SchedulerDaemon,
	SchedulerDbStorage,
	SchedulerEngine,
	SchedulerFileStore,
	stopDaemon,
	validateCron,
	waitForDaemonStart,
	waitForDaemonStop,
	writeDaemonPid,
} from "./scheduler";
export {
	detectPlatform,
	getServiceStatus,
	installService,
	startService,
	stopService,
	uninstallService,
} from "./service-installer";
export { SessionManager } from "./session-manager";
export { SQLiteSessionStore } from "./session-store";
export type * from "./types";
export type { GatewayAccountPatch, GatewayGroupInfo, GatewayWireResult } from "./wire-endpoint";
