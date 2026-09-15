import { describe, expect, it } from "bun:test";
import { githubToolRenderer } from "../../src/tools/gh-renderer";
import type { GhToolDetails } from "../../src/tools/gh-types";
import { toolRenderers } from "../../src/tools/renderers";
import { createRenderSurface } from "../helpers/render-assert";

describe("githubToolRenderer", () => {
	it("renders a compact ghw-style run summary", async () => {
		const surface = await createRenderSurface({ width: 64 });

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

		const component = githubToolRenderer.renderResult(result, { expanded: false, isPartial: true }, surface.theme);
		const rendered = surface.text(component);

		expect(toolRenderers.github).toBeDefined();
		expect(rendered).toContain("watching run #23856332053 on v12-security/v12x");
		expect(rendered).toContain("CI  dev  #23856332053");
		expect(rendered).toContain(`${surface.theme.status.success} Workflow Lint`);
		expect(rendered).toContain(`${surface.theme.status.enabled} Frontend Checks`);
		expect(rendered).toContain(`${surface.theme.status.shadowed} Rust Tests`);
		expect(rendered).toContain("55s");
		expect(rendered).toContain("40s");
		expect(rendered).toContain("5s");
		expect(rendered).not.toContain("llm-visible text stays unchanged");
	});

	it("shows failed log tails without dumping the full log when collapsed", async () => {
		const surface = await createRenderSurface({ width: 72 });

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

		const component = githubToolRenderer.renderResult(result, { expanded: false, isPartial: false }, surface.theme);
		const rendered = surface.text(component);

		expect(rendered).toContain("failed logs");
		expect(rendered).toContain("delta");
		expect(rendered).toContain("epsilon");
		expect(rendered).toContain("zeta");
		expect(rendered).not.toContain("alpha");
		expect(rendered).toContain("more log lines");
	});

	it("states why a commit watch gave up instead of claiming it is still waiting", async () => {
		const surface = await createRenderSurface({ width: 72 });
		const reason =
			"No workflow runs found for owner/repo@abc123def456 after 90s (23 polls). The commit may not trigger any GitHub " +
			"Actions workflows, or Actions may be disabled for this repository. Pass `run` to watch a specific run.";

		const rendered = surface.expectWithinWidth(
			githubToolRenderer.renderResult(
				{
					content: [{ type: "text", text: reason }],
					details: {
						watch: {
							mode: "commit",
							state: "completed",
							repo: "owner/repo",
							headSha: "abc123def456",
							pollCount: 23,
							runs: [],
							note: reason,
						},
					},
				},
				{ expanded: false, isPartial: false },
				surface.theme,
				{ op: "run_watch" },
			),
		);

		expect(rendered).toContain("workflow runs for abc123def456 on owner/repo");
		expect(rendered).toContain("No workflow runs found for owner/repo@abc123def456");
		expect(rendered).not.toContain("waiting for workflow runs");
	});

	it("keeps saying it is waiting while a commit watch is still looking for runs", async () => {
		const surface = await createRenderSurface({ width: 72 });

		const rendered = surface.text(
			githubToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "# Watching GitHub Actions for abc123def456" }],
					details: {
						watch: {
							mode: "commit",
							state: "watching",
							repo: "owner/repo",
							headSha: "abc123def456",
							pollCount: 1,
							runs: [],
						},
					},
				},
				{ expanded: false, isPartial: true },
				surface.theme,
				{ op: "run_watch" },
			),
		);

		expect(rendered).toContain("watching abc123def456 on owner/repo");
		expect(rendered).toContain("waiting for workflow runs...");
	});
});

/**
 * Non-watch ops render through the shared status line plus the LLM-visible text.
 * These assertions pin the title, the target metadata, byte stability, and the
 * width contract for every op the tool dispatches.
 */
describe("githubToolRenderer non-watch ops", () => {
	const renderOptions = { expanded: false, isPartial: false };

	it("names the op and its target on the call line", async () => {
		const surface = await createRenderSurface({ width: 120 });

		const fileCall = surface.text(
			githubToolRenderer.renderCall(
				{ op: "file_read", repo: "owner/repo", path: "docs/logo.png" },
				renderOptions,
				surface.theme,
			),
		);
		expect(fileCall).toContain("GitHub File");
		expect(fileCall).toContain("owner/repo");
		expect(fileCall).toContain("docs/logo.png");
		expect(fileCall).not.toContain("Run Watch");

		const searchCall = surface.text(
			githubToolRenderer.renderCall(
				{ op: "search_code", query: "requireNonEmpty", repo: "owner/repo" },
				renderOptions,
				surface.theme,
			),
		);
		expect(searchCall).toContain("GitHub Search Code");
		expect(searchCall).toContain("requireNonEmpty");
		expect(searchCall).toContain("owner/repo");
	});

	it("titles search results with the search op, not the run-watch title", async () => {
		const surface = await createRenderSurface({ width: 80 });
		const result = {
			content: [{ type: "text", text: "# GitHub code search\n\nQuery: needle\n\n- src/a.ts" }],
		};

		const component = githubToolRenderer.renderResult(result, renderOptions, surface.theme, {
			op: "search_code",
			query: "needle",
		});
		const rendered = surface.expectWithinWidth(component);

		expect(rendered).toContain("GitHub Search Code");
		expect(rendered).toContain("needle");
		expect(rendered).toContain("# GitHub code search");
		expect(rendered).toContain("src/a.ts");
		expect(rendered).not.toContain("Run Watch");
	});

	it("stays byte-stable across fresh instances and never emits tabs", async () => {
		const surface = await createRenderSurface({ width: 40 });
		const result = {
			content: [{ type: "text", text: "line one\n\tline two with a tab\nline three" }],
		};
		const args = { op: "file_read", repo: "owner/repo", path: "README.md" };

		const first = surface.expectStable(() =>
			githubToolRenderer.renderResult(result, renderOptions, surface.theme, args),
		);

		expect(first).toContain("GitHub File");
		expect(first).not.toContain("\t");
		expect(first).toContain("line one");
	});

	it("keeps every rendered line within the requested width", async () => {
		const surface = await createRenderSurface({ width: 48 });
		const result = {
			content: [
				{
					type: "text",
					text: `# GitHub repositories search\n\nResults: 1\n\n- owner/a-repository-with-a-long-name\n  URL: https://github.com/owner/a-repository-with-a-long-name`,
				},
			],
		};

		const rendered = surface.expectWithinWidth(
			githubToolRenderer.renderResult(result, renderOptions, surface.theme, { op: "search_repos", query: "agent" }),
		);

		expect(rendered).toContain("GitHub Search Repos");
		expect(rendered).toContain("a-repository-with-a-long-name");
	});

	it("renders a failed op with the error header and its message", async () => {
		const surface = await createRenderSurface({ width: 80 });
		const result = {
			content: [{ type: "text", text: "GitHub file read failed for 'owner/repo@HEAD:missing.md': 404" }],
			isError: true,
		};

		const rendered = surface.text(
			githubToolRenderer.renderResult(result, renderOptions, surface.theme, {
				op: "file_read",
				repo: "owner/repo",
				path: "missing.md",
			}),
		);

		expect(rendered).toContain("GitHub File");
		expect(rendered).toContain("missing.md");
		expect(rendered).toContain("GitHub file read failed");
	});

	it("renders an image attachment result through its text part", async () => {
		const surface = await createRenderSurface({ width: 80 });
		const result = {
			content: [
				{ type: "text", text: "Image file: docs/logo.png\nMIME: image/png\nSize: 26B\nDimensions: 3x2" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			],
		};

		const rendered = surface.text(
			githubToolRenderer.renderResult(result, renderOptions, surface.theme, {
				op: "file_read",
				repo: "owner/repo",
				path: "docs/logo.png",
			}),
		);

		expect(rendered).toContain("Image file: docs/logo.png");
		expect(rendered).toContain("MIME: image/png");
		expect(rendered).toContain("Dimensions: 3x2");
	});
});
