import { describe, expect, it } from "bun:test";

import { isLikelyCredentialAuthFailureForTitle } from "../src/utils/title-generator";

describe("isLikelyCredentialAuthFailureForTitle", () => {
	it("matches DashScope / OpenAI-compat 401 title errors from logs", () => {
		expect(
			isLikelyCredentialAuthFailureForTitle(
				"401 invalid access token or token expired\ninvalid access token or token expired (type=invalid_request_error param=invalid_api_key)",
			),
		).toBe(true);
		expect(
			isLikelyCredentialAuthFailureForTitle(
				"401 Invalid API-key provided. ... (type=invalid_request_error param=invalid_api_key)",
			),
		).toBe(true);
	});

	it("does not match unrelated validation text", () => {
		expect(isLikelyCredentialAuthFailureForTitle("400 model not found")).toBe(false);
		expect(isLikelyCredentialAuthFailureForTitle(undefined)).toBe(false);
		expect(isLikelyCredentialAuthFailureForTitle("")).toBe(false);
	});
});
