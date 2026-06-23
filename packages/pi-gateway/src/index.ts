/**
 * @oh-my-pi/pi-gateway
 *
 * IM gateway for Oh My Pi — connects AI agents to messaging platforms.
 *
 * Architecture:
 *   [IM Platform] → [Channel] → [Gateway] → [Session Store] → [Agent Bridge]
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
