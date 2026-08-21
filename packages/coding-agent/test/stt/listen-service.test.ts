/**
 * ListenService 单测 —— 录音转写/落盘/列表的公共数据路径（wire record_transcribe 与
 * TUI /record 共用）。mock transcriber 隔离真实模型；fs 落盘用真实临时目录。
 *
 * 覆盖：
 * - transcribeAudioWithDefaults：本地 whisper 路径转发 + model 短名返回
 * - saveListenText：json 形状（version/recorded_at/text）+ 文件名（desc/时间）
 * - listListenRecordings：解析、排序（名称倒序）、目录缺失空数组
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { setConfigRootDir } from "@oh-my-pi/pi-utils";
import {
	buildFilename,
	listListenRecordings,
	saveListenText,
	transcribeAudioWithDefaults,
} from "@oh-my-pi/pi-coding-agent/stt/listen-service";

const transcribe = vi.fn<() => Promise<string>>();
const transcribeViaApi = vi.fn<() => Promise<string>>();

vi.mock("@oh-my-pi/pi-coding-agent/stt/transcriber", () => ({ transcribe, transcribeViaApi }));

let Settings: Awaited<typeof import("@oh-my-pi/pi-coding-agent/config/settings")>["Settings"];

// 隔离 config 根，避免污染真实 ~/.omp/listen
const isoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-listen-service-test-"));

async function clearListenDir(): Promise<void> {
	await fsp.rm(path.join(isoRoot, "listen"), { recursive: true, force: true });
}

beforeEach(async () => {
	setConfigRootDir(isoRoot);
	await clearListenDir();
	if (!Settings) {
		Settings = (await import("@oh-my-pi/pi-coding-agent/config/settings")).Settings;
	}
	await Settings.init({ inMemory: true });
	transcribe.mockReset().mockResolvedValue("测试转写");
	transcribeViaApi.mockReset().mockResolvedValue("api转写");
});

afterEach(async () => {
	vi.restoreAllMocks();
	setConfigRootDir(undefined);
	await Settings.init({ inMemory: true });
});

// ── buildFilename ──

describe("buildFilename", () => {
	test("uses description when provided", () => {
		expect(buildFilename("宏大会")).toMatch(/^\d{4}-\d{2}-\d{2}-宏大会\.json$/);
	});
	test("sanitizes illegal chars", () => {
		expect(buildFilename("a/b:c*d?")).toMatch(/^\d{4}-\d{2}-\d{2}-abcd\.json$/);
	});
});

// ── transcribeAudioWithDefaults ──

describe("transcribeAudioWithDefaults", () => {
	test("local path calls transcribe() and returns short model name", async () => {
		const wav = path.join(isoRoot, "sample.wav");
		await fsp.writeFile(wav, "x".repeat(1024));

		const res = await transcribeAudioWithDefaults(wav, {});
		expect(transcribe).toHaveBeenCalled();
		expect(transcribeViaApi).not.toHaveBeenCalled();
		expect(res.text).toBe("测试转写");
		// 默认模型短名（shortModelName 只取最后一段）
		expect(res.model).not.toContain("/");
	});

	test("API path (record.model set) calls transcribeViaApi with provider", async () => {
		settings.set("record.model", "narwal-plan/qwen3-asr-flash-filetrans");
		const wav = path.join(isoRoot, "sample2.wav");
		await fsp.writeFile(wav, "x".repeat(1024));

		// API 分支需要 modelRegistry（与 ListenController 语义一致）；transcribeViaApi 已被 mock，
		// 传入 stub 仅用于通过分支判断。
		const res = await transcribeAudioWithDefaults(wav, {
			modelRegistry: {} as ModelRegistry,
		});
		expect(transcribe).not.toHaveBeenCalled();
		expect(transcribeViaApi).toHaveBeenCalled();
		expect(res.text).toBe("api转写");
		expect(res.model).toBe("qwen3-asr-flash-filetrans");
		settings.set("record.model", undefined as never);
	});
});

// ── saveListenText + listListenRecordings（真实 fs，隔离根） ──

describe("saveListenText / listListenRecordings", () => {
	test("save writes {version, recorded_at, text} json under listen dir", async () => {
		const saved = await saveListenText("第一段录音", "听记测试");
		expect(saved).toContain(isoRoot);
		expect(path.basename(saved)).toMatch(/^\d{4}-\d{2}-\d{2}-听记测试\.json$/);

		const parsed = JSON.parse(await fsp.readFile(saved, "utf-8"));
		expect(parsed.version).toBe(1);
		expect(parsed.text).toBe("第一段录音");
		expect(typeof parsed.recorded_at).toBe("string");
	});

	test("list sorts by name desc and returns full text", async () => {
		await saveListenText("旧录音", "aaa");
		await fsp.writeFile(path.join(isoRoot, "listen", "2026-08-20-较早.json"), JSON.stringify({ text: "较早" }));

		const recs = await listListenRecordings();
		expect(recs.length).toBe(2);
		// 名称倒序（含日期前缀，天然按日期+时间倒排）
		const names = recs.map(r => r.name);
		expect(names).toEqual([...names].sort().reverse());
		// 两条都在，文本对应正确
		expect(recs.find(r => r.name.includes("-aaa."))?.text).toBe("旧录音");
		expect(recs.find(r => r.name.includes("较早"))?.text).toBe("较早");
	});

	test("list returns [] when dir missing", async () => {
		const gone = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-listen-empty-"));
		setConfigRootDir(gone);
		try {
			expect(await listListenRecordings()).toEqual([]);
		} finally {
			setConfigRootDir(isoRoot);
		}
	});
});