import { describe, expect, it } from "bun:test";
import { sanitizeText } from "@cornfield/natives";
import { getThemeByName } from "../../src/modes/theme/theme";
import { githubToolRenderer } from "../../src/tools/gh-renderer";
import type { GhToolDetails } from "../../src/tools/gh-types";
import { toolRenderers } from "../../src/tools/renderers";

describe("githubToolRenderer", () => {
	it("renders a compact ghw-style run summary", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const result: {
			content: Array<{ type: string; text?: string }>;
			details?: GhToolDetails;
			isError?: boolean;
		} = {
			content: [{ type: "text", text: "llm-visible text stays unchanged" }],
			details: {
				watch: {
					mode: "run",
					state: "watching",
					repo: "v12-security/v12x",
					run: {
						id: 23856332053,
						workflowName: "CI",
						branch: "dev",
						jobs: [
							{
								id: 1,
								name: "Workflow Lint",
								status: "completed",
								conclusion: "success",
								durationSeconds: 55,
							},
							{
								id: 2,
								name: "Frontend Checks",
								status: "in_progress",
								durationSeconds: 40,
							},
							{
								id: 3,
								name: "Rust Tests",
								status: "queued",
								durationSeconds: 5,
							},
						],
					},
				},
			},
		};

		const component = githubToolRenderer.renderResult(result, { expanded: false, isPartial: true }, uiTheme);
		const rendered = sanitizeText(component.render(64).join("\n"));

		expect(toolRenderers.github).toBeDefined();
		expect(rendered).toContain("watching run #23856332053 on v12-security/v12x");
		expect(rendered).toContain("CI  dev  #23856332053");
		expect(rendered).toContain(`${uiTheme.status.success} Workflow Lint`);
		expect(rendered).toContain(`${uiTheme.status.enabled} Frontend Checks`);
		expect(rendered).toContain(`${uiTheme.status.shadowed} Rust Tests`);
		expect(rendered).toContain("55s");
		expect(rendered).toContain("40s");
		expect(rendered).toContain("5s");
		expect(rendered).not.toContain("llm-visible text stays unchanged");
	});

	it("shows failed log tails without dumping the full log when collapsed", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const result: {
			content: Array<{ type: string; text?: string }>;
			details?: GhToolDetails;
			isError?: boolean;
		} = {
			content: [{ type: "text", text: "full markdown result" }],
			details: {
				watch: {
					mode: "run",
					state: "completed",
					repo: "owner/repo",
					run: {
						id: 77,
						workflowName: "CI",
						branch: "feature/bugfix",
						conclusion: "failure",
						jobs: [
							{
								id: 202,
								name: "test",
								status: "completed",
								conclusion: "failure",
								durationSeconds: 360,
							},
						],
					},
					failedLogs: [
						{
							runId: 77,
							workflowName: "CI",
							jobName: "test",
							available: true,
							tail: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].join("\n"),
						},
					],
				},
			},
		};

		const component = githubToolRenderer.renderResult(result, { expanded: false, isPartial: false }, uiTheme);
		const rendered = sanitizeText(component.render(72).join("\n"));

		expect(rendered).toContain("failed logs");
		expect(rendered).toContain("delta");
		expect(rendered).toContain("epsilon");
		expect(rendered).toContain("zeta");
		expect(rendered).not.toContain("alpha");
		expect(rendered).toContain("more log lines");
	});
});

/**
 * Non-watch ops render through the shared status line plus the LLM-visible text.
 * These assertions pin the title, the target metadata, and byte stability at a
 * fixed width so a rendering change has to be deliberate.
 */
describe("githubToolRenderer non-watch ops", () => {
	const renderOptions = { expanded: false, isPartial: false };

	it("names the op and its target on the call line", async () => {
		const uiTheme = (await getThemeByName("dark"))!;

		const fileCall = sanitizeText(
			githubToolRenderer
				.renderCall({ op: "file_read", repo: "owner/repo", path: "docs/logo.png" }, renderOptions, uiTheme)
				.render(120)
				.join("\n"),
		);
		expect(fileCall).toContain("GitHub File");
		expect(fileCall).toContain("owner/repo");
		expect(fileCall).toContain("docs/logo.png");
		expect(fileCall).not.toContain("Run Watch");

		const searchCall = sanitizeText(
			githubToolRenderer
				.renderCall({ op: "search_code", query: "requireNonEmpty", repo: "owner/repo" }, renderOptions, uiTheme)
				.render(120)
				.join("\n"),
		);
		expect(searchCall).toContain("GitHub Search Code");
		expect(searchCall).toContain("requireNonEmpty");
		expect(searchCall).toContain("owner/repo");
	});

	it("keeps the op title off the run-watch title for search results", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const result = {
			content: [{ type: "text", text: "# GitHub code search\n\nQuery: needle\n\n- src/a.ts" }],
		};

		const component = githubToolRenderer.renderResult(result, renderOptions, uiTheme, {
			op: "search_code",
			query: "needle",
		});
		const rendered = sanitizeText(component.render(80).join("\n"));

		expect(rendered).toContain("GitHub Search Code");
		expect(rendered).toContain("needle");
		expect(rendered).toContain("# GitHub code search");
		expect(rendered).toContain("src/a.ts");
		expect(rendered).not.toContain("Run Watch");
	});

	it("is byte-stable for the same input at the same width", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const result = {
			content: [{ type: "text", text: "line one\n\tline two with a tab\nline three" }],
		};
		const args = { op: "file_read", repo: "owner/repo", path: "README.md" };

		const first = sanitizeText(
			githubToolRenderer.renderResult(result, renderOptions, uiTheme, args).render(40).join("\n"),
		);
		const second = sanitizeText(
			githubToolRenderer.renderResult(result, renderOptions, uiTheme, args).render(40).join("\n"),
		);

		expect(second).toBe(first);
		expect(first).toContain("GitHub File");
		// Tabs never reach the terminal.
		expect(first).not.toContain("\t");
		expect(first).toContain("line one");
	});

	it("renders a failed op with the error header and its message", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const result = {
			content: [{ type: "text", text: "GitHub file read failed for 'owner/repo@HEAD:missing.md': 404" }],
			isError: true,
		};

		const rendered = sanitizeText(
			githubToolRenderer
				.renderResult(result, renderOptions, uiTheme, {
					op: "file_read",
					repo: "owner/repo",
					path: "missing.md",
				})
				.render(80)
				.join("\n"),
		);

		expect(rendered).toContain("GitHub File");
		expect(rendered).toContain("missing.md");
		expect(rendered).toContain("GitHub file read failed");
	});

	it("renders an image attachment result through its text part", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const result = {
			content: [
				{ type: "text", text: "Image file: docs/logo.png\nMIME: image/png\nSize: 26B\nDimensions: 3x2" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			],
		};

		const rendered = sanitizeText(
			githubToolRenderer
				.renderResult(result, renderOptions, uiTheme, {
					op: "file_read",
					repo: "owner/repo",
					path: "docs/logo.png",
				})
				.render(80)
				.join("\n"),
		);

		expect(rendered).toContain("Image file: docs/logo.png");
		expect(rendered).toContain("MIME: image/png");
		expect(rendered).toContain("Dimensions: 3x2");
	});
});
