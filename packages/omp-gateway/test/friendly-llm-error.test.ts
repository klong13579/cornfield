/**
 * friendlyLlmError tests — internal retry/fallback machinery text must not
 * reach IM users verbatim; recognized provider idioms map to actionable hints.
 */
import { describe, expect, it } from "bun:test";
import { friendlyLlmError } from "../src/response-meta";

describe("friendlyLlmError", () => {
	it("rate limit idiom → concrete retry hint", () => {
		expect(friendlyLlmError("Error 429: Too many requests, rate limit exceeded")).toContain("频率受限");
	});

	it("overload idiom → overload hint", () => {
		expect(friendlyLlmError("503 Service overloaded")).toContain("过载");
	});

	it("timeout idiom → timeout hint", () => {
		expect(friendlyLlmError("Request timed out after 60000ms")).toContain("超时");
	});

	it("context overflow → new-session hint", () => {
		expect(friendlyLlmError("Context overflow: maximum context length exceeded")).toContain("新会话");
	});

	it("internal retry machinery text collapses to generic hint (never verbatim)", () => {
		const out = friendlyLlmError("Max retries (3) exhausted — trying fallback...");
		expect(out).not.toContain("retries");
		expect(out).not.toContain("fallback");
		expect(out).toContain("重试");
	});

	it("unrecognized garbage collapses to generic hint without leaking raw text", () => {
		const out = friendlyLlmError("some weird upstream internal stack trace detail xyz");
		expect(out).not.toContain("xyz");
		expect(out).toContain("重试");
	});
});
