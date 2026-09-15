import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@cornfield/coding-agent/config/settings";
import type { ToolSession } from "@cornfield/coding-agent/tools";
import { GithubTool } from "@cornfield/coding-agent/tools/gh";
import * as git from "@cornfield/coding-agent/utils/git";

function createSession(settings: Settings = Settings.isolated({ "github.enabled": true })): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getArtifactsDir: () => null,
		getSessionSpawns: () => null,
		settings,
	};
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";
}

describe("github pr_create op", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("creates a pull request from a title and reads the result back", async () => {
		const textSpy = vi.spyOn(git.github, "text").mockResolvedValue("https://github.com/owner/repo/pull/42\n");
		const jsonSpy = vi.spyOn(git.github, "json").mockResolvedValue({
			number: 42,
			title: "Fix the flaky retry test",
			state: "OPEN",
			isDraft: false,
			baseRefName: "main",
			headRefName: "feature/retry-fix",
			author: { login: "octocat" },
			createdAt: "2026-04-01T10:00:00Z",
			url: "https://github.com/owner/repo/pull/42",
			labels: [{ name: "bug" }],
			body: "Fixes the retry race.",
		} as never);

		const tool = new GithubTool(createSession());
		const result = await tool.execute("pr-create", {
			op: "pr_create",
			repo: "owner/repo",
			title: "Fix the flaky retry test",
			base: "main",
			head: "feature/retry-fix",
			draft: true,
			reviewer: ["alice"],
			assignee: ["bob"],
			label: ["bug"],
		});
		const text = textOf(result);

		expect(textSpy.mock.calls[0]?.[1]).toEqual([
			"pr",
			"create",
			"--repo",
			"owner/repo",
			"--title",
			"Fix the flaky retry test",
			"--base",
			"main",
			"--head",
			"feature/retry-fix",
			"--draft",
			"--reviewer",
			"alice",
			"--assignee",
			"bob",
			"--label",
			"bug",
			// No body was given, so an explicit empty one keeps `gh` out of an editor.
			"--body",
			"",
		]);
		expect(jsonSpy.mock.calls[0]?.[1]?.slice(0, 5)).toEqual(["pr", "view", "42", "--repo", "owner/repo"]);
		expect(text).toContain("# Created Pull Request #42: Fix the flaky retry test");
		expect(text).toContain("State: OPEN");
		expect(text).toContain("Base: main");
		expect(text).toContain("Head: feature/retry-fix");
		expect(text).toContain("Author: @octocat");
		expect(text).toContain("Labels: bug");
		expect(text).toContain("## Body");
		expect(text).toContain("Fixes the retry race.");
		expect(result.details?.meta?.source?.value).toBe("https://github.com/owner/repo/pull/42");
	});

	it("passes a multi-line body through a temp file and removes it afterwards", async () => {
		const body = "## Summary\n\nBody with `code` and a very long line that must survive as-is.";
		let bodyFilePath: string | undefined;
		let bodyContent: string | undefined;
		vi.spyOn(git.github, "text").mockImplementation(async (_cwd, args) => {
			const index = args.indexOf("--body-file");
			if (index >= 0) {
				bodyFilePath = args[index + 1];
				bodyContent = await Bun.file(bodyFilePath ?? "").text();
			}
			return "https://github.com/owner/repo/pull/7";
		});
		vi.spyOn(git.github, "json").mockRejectedValue(new Error("read-back unavailable"));

		const tool = new GithubTool(createSession());
		const result = await tool.execute("pr-create", {
			op: "pr_create",
			repo: "owner/repo",
			title: "Documented change",
			body,
		});
		const text = textOf(result);

		expect(bodyContent).toBe(body);
		expect(bodyFilePath).toBeDefined();
		// The op must not leave the body file behind.
		expect(await Bun.file(bodyFilePath ?? "").exists()).toBe(false);
		// The summary falls back to the requested title when the read-back fails.
		expect(text).toContain("# Created Pull Request #7: Documented change");
		expect(text).toContain("URL: https://github.com/owner/repo/pull/7");
	});

	it("uses --fill and refuses to combine it with title or body", async () => {
		const textSpy = vi
			.spyOn(git.github, "text")
			.mockResolvedValue("Creating pull request for feature/x into main in owner/repo\n");
		const tool = new GithubTool(createSession());

		const result = await tool.execute("pr-create", { op: "pr_create", repo: "owner/repo", fill: true });
		const args = textSpy.mock.calls[0]?.[1] ?? [];

		expect(args).toContain("--fill");
		expect(args).not.toContain("--title");
		expect(args).not.toContain("--body");
		expect(args).not.toContain("--body-file");
		// No pull request URL came back, so the summary cannot invent a number.
		expect(textOf(result)).toContain("# Created Pull Request: Untitled");

		await expect(
			tool.execute("pr-create", { op: "pr_create", repo: "owner/repo", fill: true, title: "x" }),
		).rejects.toThrow("fill is mutually exclusive with title and body");
		await expect(
			tool.execute("pr-create", { op: "pr_create", repo: "owner/repo", fill: true, body: "x" }),
		).rejects.toThrow("fill is mutually exclusive with title and body");
	});

	it("requires a title unless fill is set", async () => {
		const tool = new GithubTool(createSession());
		await expect(tool.execute("pr-create", { op: "pr_create", repo: "owner/repo" })).rejects.toThrow(
			"title is required unless fill is true",
		);
	});

	it("still reports the created pull request when the read-back fails", async () => {
		vi.spyOn(git.github, "text").mockResolvedValue("https://github.com/owner/repo/pull/99");
		vi.spyOn(git.github, "json").mockRejectedValue(new Error("rate limited"));

		const tool = new GithubTool(createSession());
		const text = textOf(
			await tool.execute("pr-create", { op: "pr_create", repo: "owner/repo", title: "Only the title" }),
		);

		expect(text).toContain("# Created Pull Request #99: Only the title");
		expect(text).toContain("URL: https://github.com/owner/repo/pull/99");
	});

	it("surfaces a failed creation as an error", async () => {
		vi.spyOn(git.github, "text").mockRejectedValue(new Error("pull request create failed: branch not pushed"));

		const tool = new GithubTool(createSession());
		await expect(tool.execute("pr-create", { op: "pr_create", repo: "owner/repo", title: "Nope" })).rejects.toThrow(
			"branch not pushed",
		);
	});
});
