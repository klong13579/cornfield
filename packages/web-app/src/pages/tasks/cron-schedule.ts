import { Cron } from "croner";

/**
 * 定时面板 cron 预设逻辑（W3 D4 TasksPanel）——纯函数，浏览器端可测。
 *
 * 预设体系与 hermes 规格（tmp/hermes-webui/static/panels.js CRON_SCHEDULE_PRESETS）
 * 对齐：hourly/daily/weekdays/weekly/monthly/custom，5 字段 cron
 * （minute hour day-of-month month day-of-week，周日=0、周一=1）。
 * 表达式实时预览用 croner（web-app 直接依赖；gateway scheduler 同款，语义一致）。
 */

export type CronPresetId = "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "custom";

export interface CronPresetDef {
	id: CronPresetId;
	label: string;
	/** 可见字段：time（HH:MM 共用 hour+minute）/ minute / weekday / monthDay。 */
	fields: string[];
	defaults: Partial<Record<CronField, number>>;
}

export type CronField = "hour" | "minute" | "weekday" | "monthDay";

export const CRON_SCHEDULE_PRESETS: CronPresetDef[] = [
	{ id: "hourly", label: "每小时", fields: ["minute"], defaults: { minute: 0 } },
	{ id: "daily", label: "每天", fields: ["time"], defaults: { hour: 9, minute: 0 } },
	{ id: "weekdays", label: "工作日（周一至周五）", fields: ["time"], defaults: { hour: 9, minute: 0 } },
	{ id: "weekly", label: "每周", fields: ["weekday", "time"], defaults: { hour: 9, minute: 0, weekday: 1 } },
	{ id: "monthly", label: "每月", fields: ["monthDay", "time"], defaults: { hour: 9, minute: 0, monthDay: 1 } },
	{ id: "custom", label: "自定义 cron", fields: [], defaults: {} },
];

export function cronPreset(id: string): CronPresetDef | undefined {
	return CRON_SCHEDULE_PRESETS.find(p => p.id === id);
}

const FIELD_BOUNDS: Record<CronField, { min: number; max: number }> = {
	hour: { min: 0, max: 23 },
	minute: { min: 0, max: 59 },
	weekday: { min: 0, max: 6 },
	monthDay: { min: 1, max: 31 },
};

/** 字段值取值范围（表单 select 范围/校验用）。 */
export function cronFieldBounds(field: CronField): { min: number; max: number } {
	return FIELD_BOUNDS[field];
}

/** 数值约束钳制（非法/越界回退到 fallback 或边界）。 */
export function normalizeCronField(field: CronField, value: number | string | undefined, fallback?: number): number {
	const parsed = Number.parseInt(String(value ?? "").trim(), 10);
	const bounds = FIELD_BOUNDS[field];
	const fallbackParsed = Number.parseInt(String(fallback ?? bounds.min).trim(), 10);
	const safeFallback = Number.isFinite(fallbackParsed) ? fallbackParsed : bounds.min;
	const n = Number.isFinite(parsed) ? parsed : safeFallback;
	return Math.min(bounds.max, Math.max(bounds.min, n));
}

export interface CronPresetValues {
	hour?: number;
	minute?: number;
	weekday?: number;
	monthDay?: number;
}

/**
 * 预设 + 字段值 → 5 字段 cron 表达式。
 * custom 返回 ""（原始输入自行校验）；unknown preset 返回 ""。
 */
export function buildCronExpression(presetId: CronPresetId, values: CronPresetValues): string {
	switch (presetId) {
		case "hourly": {
			const minute = normalizeCronField("minute", values.minute, 0);
			return `${minute} * * * *`;
		}
		case "daily": {
			const minute = normalizeCronField("minute", values.minute, 0);
			const hour = normalizeCronField("hour", values.hour, 9);
			return `${minute} ${hour} * * *`;
		}
		case "weekdays": {
			const minute = normalizeCronField("minute", values.minute, 0);
			const hour = normalizeCronField("hour", values.hour, 9);
			return `${minute} ${hour} * * 1-5`;
		}
		case "weekly": {
			const minute = normalizeCronField("minute", values.minute, 0);
			const hour = normalizeCronField("hour", values.hour, 9);
			const weekday = normalizeCronField("weekday", values.weekday, 1);
			return `${minute} ${hour} * * ${weekday}`;
		}
		case "monthly": {
			const minute = normalizeCronField("minute", values.minute, 0);
			const hour = normalizeCronField("hour", values.hour, 9);
			const monthDay = normalizeCronField("monthDay", values.monthDay, 1);
			return `${minute} ${hour} ${monthDay} * *`;
		}
		default:
			return "";
	}
}

export interface CronExpressionState {
	presetId: CronPresetId;
	values: CronPresetValues;
}

/**
 * 5 字段 cron 表达式 → 预设 + 字段值（反向识别；hermes 同款规则）。
 * 识别不出则 presetId=custom（原始输入态）。
 */
export function stateFromCronExpression(expr: string): CronExpressionState {
	const schedule = String(expr ?? "").trim();
	if (!schedule) return { presetId: "custom", values: {} };
	const parts = schedule.split(/\s+/);
	if (parts.length !== 5) return { presetId: "custom", values: {} };
	const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
	if (!isPlainInt(minute)) return { presetId: "custom", values: {} };

	if (isPlainInt(hour) && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
		return { presetId: "daily", values: { minute: Number(minute), hour: Number(hour) } };
	}
	if (isPlainInt(hour) && dayOfMonth === "*" && month === "*" && dayOfWeek === "1-5") {
		return { presetId: "weekdays", values: { minute: Number(minute), hour: Number(hour) } };
	}
	if (hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
		return { presetId: "hourly", values: { minute: Number(minute) } };
	}
	if (isPlainInt(hour) && dayOfMonth === "*" && month === "*" && (isPlainInt(dayOfWeek) || dayOfWeek === "7")) {
		return {
			presetId: "weekly",
			values: { minute: Number(minute), hour: Number(hour), weekday: dayOfWeek === "7" ? 0 : Number(dayOfWeek) },
		};
	}
	if (isPlainInt(hour) && isPlainInt(dayOfMonth) && month === "*" && dayOfWeek === "*") {
		return {
			presetId: "monthly",
			values: { minute: Number(minute), hour: Number(hour), monthDay: Number(dayOfMonth) },
		};
	}
	return { presetId: "custom", values: {} };
}

function isPlainInt(s: string): boolean {
	return /^\d+$/.test(s);
}

export interface CronPreview {
	/** 表达式是否可解析（croner 校验）。 */
	valid: boolean;
	/** 解析失败原因；valid=true 时 undefined。 */
	error?: string;
	/** 接下来 N 次触发时间（本地时间毫秒，升序）。 */
	nextRuns: number[];
}

/**
 * 表达式实时预览：croner 校验 + 未来 N 次触发（从 now 起往后找）。
 * 非法表达式返回 valid=false（UI 显示错误空态，不造数据）。
 */
export function previewCronExpression(expr: string, maxRuns = 3): CronPreview {
	const schedule = String(expr ?? "").trim();
	if (!schedule) return { valid: false, error: "表达式为空", nextRuns: [] };
	let cron: Cron;
	try {
		cron = new Cron(schedule, { paused: true, protect: true });
	} catch (err) {
		return { valid: false, error: err instanceof Error ? err.message : String(err), nextRuns: [] };
	}
	try {
		const runs = cron.nextRuns(maxRuns) as Date[];
		return { valid: runs.length > 0, nextRuns: runs.map(d => d.getTime()) };
	} catch (err) {
		return { valid: false, error: err instanceof Error ? err.message : String(err), nextRuns: [] };
	}
}
