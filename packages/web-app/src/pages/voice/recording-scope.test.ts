/**
 * T10C · 听记 scope 分桶的单测。
 *
 * 断言的重点是**不替用户认领别人的录音**：没有 provenance 的旧记录进「未标注」，永不进「本 Agent」；
 * 一条录音只出现一次（最具体的桶胜出）；scope 锚点缺失时不乱归。
 */

import { describe, expect, test } from "bun:test";
import type { ListenRecordingDto } from "@cornfield/wire";
import {
	bucketOf,
	bucketRecordings,
	filterRecordings,
	RECORDING_BUCKET_LABELS,
	recordingScopeLabel,
} from "./recording-scope";

const HR_DIR = "/Users/me/.cornfield/agents/hr";
const CODING_DIR = "/Users/me/.cornfield/agents/coding";

function rec(over: Partial<ListenRecordingDto> & { name: string }): ListenRecordingDto {
	return { path: `/listen/${over.name}`, recordedAt: "2026-09-15T00:00:00.000Z", size: 10, text: "正文", ...over };
}

const SCOPE = {
	agentId: "hr",
	agentDir: HR_DIR,
	sessionFile: "/Users/me/.cornfield/agents/hr/sessions/conv.jsonl",
	projectId: "proj-hr",
};

describe("bucketOf", () => {
	test("本会话 > 本 Agent > 本 Project（最具体优先）", () => {
		expect(
			bucketOf(
				rec({
					name: "a",
					provenance: { agentId: "hr", agentDir: HR_DIR, sessionFile: SCOPE.sessionFile, projectId: "proj-hr" },
				}),
				SCOPE,
			),
		).toBe("session");
		expect(bucketOf(rec({ name: "b", provenance: { agentId: "hr", projectId: "proj-hr" } }), SCOPE)).toBe("agent");
		expect(bucketOf(rec({ name: "c", provenance: { projectId: "proj-hr" } }), SCOPE)).toBe("project");
	});

	test("只有 agentDir 匹配也算本 Agent（CLI 写入的记录没有注册表身份）", () => {
		expect(bucketOf(rec({ name: "cli", provenance: { agentDir: `${HR_DIR}/` } }), SCOPE)).toBe("agent");
	});

	test("sessionFile 比较先做路径归一（尾随分隔符 / 重复分隔符 / 反斜杠）", () => {
		const variants = [
			`${SCOPE.sessionFile}/`,
			SCOPE.sessionFile.replace("/sessions/", "//sessions/"),
			SCOPE.sessionFile.replaceAll("/", "\\"),
		];
		for (const variant of variants) {
			expect(bucketOf(rec({ name: `v-${variant.length}`, provenance: { sessionFile: variant } }), SCOPE)).toBe(
				"session",
			);
		}
	});

	test("agentDir 比较同样归一（否则同一个家会被判成别人的）", () => {
		expect(
			bucketOf(rec({ name: "a", provenance: { agentDir: `\\Users\\me\\.cornfield\\agents\\hr\\` } }), SCOPE),
		).toBe("agent");
	});

	test("不同会话文件不会被归成同一会话", () => {
		const other = SCOPE.sessionFile.replace("conv.jsonl", "other.jsonl");
		expect(bucketOf(rec({ name: "x", provenance: { sessionFile: other } }), SCOPE)).toBe("other");
	});

	test("有标注但不属于本 scope → 其他（不塞进本 Agent）", () => {
		expect(bucketOf(rec({ name: "x", provenance: { agentId: "coding", agentDir: CODING_DIR } }), SCOPE)).toBe(
			"other",
		);
		expect(bucketOf(rec({ name: "y", provenance: { projectId: "proj-other" } }), SCOPE)).toBe("other");
	});

	test("没有 provenance → 未标注（旧记录不得被当成当前的）", () => {
		expect(bucketOf(rec({ name: "old" }), SCOPE)).toBe("unlabeled");
	});

	test("scope 锚点缺省时不乱归：没有焦点 Agent 就没有「本 Agent」", () => {
		expect(bucketOf(rec({ name: "a", provenance: { agentId: "hr" } }), {})).toBe("other");
		expect(bucketOf(rec({ name: "b" }), {})).toBe("unlabeled");
	});

	test("空字符串来源字段不匹配（空值不是「同一个」）", () => {
		expect(bucketOf(rec({ name: "a", provenance: { agentId: "" } }), SCOPE)).toBe("other");
	});
});

describe("bucketRecordings", () => {
	test("一条录音只进一个桶；空桶不出现；顺序按具体度", () => {
		const buckets = bucketRecordings(
			[
				rec({ name: "s", provenance: { sessionFile: SCOPE.sessionFile } }),
				rec({ name: "a1", provenance: { agentId: "hr" } }),
				rec({ name: "a2", provenance: { agentId: "hr" } }),
				rec({ name: "p", provenance: { projectId: "proj-hr" } }),
				rec({ name: "o", provenance: { agentId: "coding" } }),
				rec({ name: "u" }),
			],
			SCOPE,
		);
		expect(buckets.map(b => b.bucket)).toEqual(["session", "agent", "project", "other", "unlabeled"]);
		expect(buckets.reduce((n, b) => n + b.recordings.length, 0)).toBe(6);
		expect(buckets.find(b => b.bucket === "agent")?.recordings.map(r => r.name)).toEqual(["a1", "a2"]);
		expect(buckets.find(b => b.bucket === "unlabeled")?.label).toBe(RECORDING_BUCKET_LABELS.unlabeled);
	});

	test("桶内保持传入顺序（listen_list 已是文件名倒序，不再重排）", () => {
		const buckets = bucketRecordings(
			[rec({ name: "z", provenance: { agentId: "hr" } }), rec({ name: "a", provenance: { agentId: "hr" } })],
			SCOPE,
		);
		expect(buckets[0]?.recordings.map(r => r.name)).toEqual(["z", "a"]);
	});

	test("空列表 → 空分桶", () => {
		expect(bucketRecordings([], SCOPE)).toEqual([]);
	});
});

describe("filterRecordings", () => {
	test("关键词匹配文件名或正文", () => {
		const rows = [
			rec({ name: "2026-09-15-meeting.json", text: "讨论预算" }),
			rec({ name: "other.json", text: "无关" }),
		];
		expect(filterRecordings(rows, "meeting").map(r => r.name)).toEqual(["2026-09-15-meeting.json"]);
		expect(filterRecordings(rows, "预算").map(r => r.name)).toEqual(["2026-09-15-meeting.json"]);
	});

	test("关键词 + 分桶同时生效", () => {
		const rows = [
			rec({ name: "mine.json", text: "预算", provenance: { agentId: "hr" } }),
			rec({ name: "theirs.json", text: "预算", provenance: { agentId: "coding" } }),
		];
		expect(filterRecordings(rows, "预算", "agent", SCOPE).map(r => r.name)).toEqual(["mine.json"]);
		expect(filterRecordings(rows, "", "unlabeled", SCOPE)).toEqual([]);
	});

	test("空关键词 = 不过滤", () => {
		expect(filterRecordings([rec({ name: "a" })], "   ").length).toBe(1);
	});
});

describe("recordingScopeLabel", () => {
	test("优先显示身份，退到 home / 会话 / 项目", () => {
		expect(recordingScopeLabel(rec({ name: "a", provenance: { agentId: "hr" } }))).toBe("hr");
		expect(recordingScopeLabel(rec({ name: "b", provenance: { agentDir: HR_DIR } }))).toBe(HR_DIR);
		expect(recordingScopeLabel(rec({ name: "c", provenance: { sessionFile: "/x/conv.jsonl" } }))).toBe("conv.jsonl");
		expect(recordingScopeLabel(rec({ name: "d", provenance: { projectId: "proj-hr" } }))).toBe("proj-hr");
	});

	test("未标注明确写出来（不留白）", () => {
		expect(recordingScopeLabel(rec({ name: "e" }))).toBe(RECORDING_BUCKET_LABELS.unlabeled);
	});
});
