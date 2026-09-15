/**
 * The Child Session lifecycle report dialect.
 *
 * The parser is the boundary between "a child said something" and "the parent
 * moves a status", so the rejections get as much attention here as the happy
 * path: every case below is a way a parent could otherwise believe something the
 * child never said.
 */

import { describe, expect, test } from "bun:test";
import {
	CHILD_SESSION_REPORT_TAG,
	type ChildSessionLifecycle,
	childSessionLifecycleToStatus,
	formatChildSessionReport,
	hasChildSessionReportTag,
	parseChildSessionReport,
} from "../../src/session/child-session-report";

const LIFECYCLES: ChildSessionLifecycle[] = ["started", "progress", "waiting", "completed", "failed"];

function envelopeOf(text: string) {
	const parsed = parseChildSessionReport(text);
	if (!parsed) throw new Error(`expected a parsed report, got null for ${JSON.stringify(text)}`);
	return parsed;
}

describe("formatChildSessionReport / parseChildSessionReport", () => {
	test("round-trips every lifecycle, with and without a body", () => {
		for (const lifecycle of LIFECYCLES) {
			for (const body of [undefined, "what the child is doing"]) {
				const text = formatChildSessionReport({ runId: "run-1", lifecycle }, body);
				const parsed = envelopeOf(text);
				expect(parsed.report).toEqual({ runId: "run-1", lifecycle });
				expect(parsed.body).toBe(body);
				expect(hasChildSessionReportTag(text)).toBe(true);
			}
		}
	});

	test("carries the blocked-on kind of a waiting child", () => {
		for (const blocking of ["ask", "permission"] as const) {
			const text = formatChildSessionReport({ runId: "run-1", lifecycle: "waiting", blocking }, "may I?");
			expect(envelopeOf(text).report).toEqual({ runId: "run-1", lifecycle: "waiting", blocking });
		}
	});

	test("carries the result reference of a completed child, paths with spaces included", () => {
		const result = "/tmp/a dir/session log.jsonl";
		const text = formatChildSessionReport({ runId: "run-1", lifecycle: "completed", result }, "done");
		expect(envelopeOf(text).report.result).toBe(result);
	});

	test("keeps the prose body verbatim after the envelope line", () => {
		const body = "Subagent completed its task round.\nRun: r1\n\nsecond paragraph";
		const text = formatChildSessionReport({ runId: "r1", lifecycle: "completed" }, body);
		expect(text.startsWith(CHILD_SESSION_REPORT_TAG)).toBe(true);
		expect(envelopeOf(text).body).toBe(body);
	});
});

describe("parseChildSessionReport rejections", () => {
	const bad: Array<[string, string]> = [
		["ordinary prose", "Subagent completed its task round."],
		["the tag with no payload", `${CHILD_SESSION_REPORT_TAG}`],
		["the tag with whitespace only", `${CHILD_SESSION_REPORT_TAG}   `],
		["the tag with non-JSON payload", `${CHILD_SESSION_REPORT_TAG} run=1 lifecycle=started`],
		["a JSON array payload", `${CHILD_SESSION_REPORT_TAG} ["started"]`],
		["a JSON string payload", `${CHILD_SESSION_REPORT_TAG} "started"`],
		["a key this parser does not know", `${CHILD_SESSION_REPORT_TAG} {"runId":"r","lifecycle":"started","v":2}`],
		["a missing runId", `${CHILD_SESSION_REPORT_TAG} {"lifecycle":"started"}`],
		["an empty runId", `${CHILD_SESSION_REPORT_TAG} {"runId":"","lifecycle":"started"}`],
		["a non-string runId", `${CHILD_SESSION_REPORT_TAG} {"runId":7,"lifecycle":"started"}`],
		["a missing lifecycle", `${CHILD_SESSION_REPORT_TAG} {"runId":"r"}`],
		["an unknown lifecycle", `${CHILD_SESSION_REPORT_TAG} {"runId":"r","lifecycle":"cancelled"}`],
		[
			"a blocking on a non-waiting report",
			`${CHILD_SESSION_REPORT_TAG} {"runId":"r","lifecycle":"progress","blocking":"ask"}`,
		],
		["an unknown blocking", `${CHILD_SESSION_REPORT_TAG} {"runId":"r","lifecycle":"waiting","blocking":"music"}`],
		[
			"a result on a non-completed report",
			`${CHILD_SESSION_REPORT_TAG} {"runId":"r","lifecycle":"failed","result":"/x"}`,
		],
		["an empty result", `${CHILD_SESSION_REPORT_TAG} {"runId":"r","lifecycle":"completed","result":""}`],
	];

	for (const [name, text] of bad) {
		test(`rejects ${name}`, () => {
			expect(parseChildSessionReport(text)).toBeNull();
		});
	}

	test("still claims the tag, so a caller can tell 'not a report' from 'a report I cannot read'", () => {
		const malformed = `${CHILD_SESSION_REPORT_TAG} {"runId":"r","lifecycle":"teleported"}`;
		expect(hasChildSessionReportTag(malformed)).toBe(true);
		expect(parseChildSessionReport(malformed)).toBeNull();
		expect(hasChildSessionReportTag("Subagent logged an error")).toBe(false);
	});

	test("reads the envelope from the first line only", () => {
		const text = `prose first\n${CHILD_SESSION_REPORT_TAG} {"runId":"r","lifecycle":"started"}`;
		expect(parseChildSessionReport(text)).toBeNull();
	});

	test("tolerates leading whitespace on the envelope line", () => {
		const text = `\t ${CHILD_SESSION_REPORT_TAG} {"runId":"r","lifecycle":"started"}`;
		expect(envelopeOf(text).report.lifecycle).toBe("started");
	});
});

describe("childSessionLifecycleToStatus", () => {
	test("maps the child's vocabulary onto the session status vocabulary", () => {
		expect(childSessionLifecycleToStatus("started")).toBe("running");
		expect(childSessionLifecycleToStatus("progress")).toBe("running");
		expect(childSessionLifecycleToStatus("waiting")).toBe("waiting_user");
		expect(childSessionLifecycleToStatus("completed")).toBe("completed");
		expect(childSessionLifecycleToStatus("failed")).toBe("failed");
	});

	test("never reports a status the child cannot observe about itself", () => {
		// `cancelled` is the parent's verdict on a child it stopped; a child that
		// claimed it would be guessing about a decision it did not make.
		const reachable = LIFECYCLES.map(childSessionLifecycleToStatus);
		expect(reachable).not.toContain("cancelled");
	});
});
