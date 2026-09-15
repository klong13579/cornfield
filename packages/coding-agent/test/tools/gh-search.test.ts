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

describe("github search ops", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("searches code with the code field list and renders each hit's path, commit and match", async () => {
		const jsonSpy = vi.spyOn(git.github, "json").mockResolvedValue([
			{
				path: "src/tools/gh.ts",
				repository: { nameWithOwner: "owner/repo" },
				sha: "abcdef1234567890abcdef",
				textMatches: [{ fragment: "  const query = requireNonEmpty(\n  more", property: "content" }],
				url: "https://github.com/owner/repo/blob/abc/src/tools/gh.ts",
			},
		] as never);

		const tool = new GithubTool(createSession());
		const result = await tool.execute("search-code", {
			op: "search_code",
			query: "requireNonEmpty repo:owner/repo",
			repo: "owner/repo",
			limit: 5,
		});
		const text = textOf(result);

		expect(jsonSpy.mock.calls[0]?.[1]).toEqual([
			"search",
			"code",
			"--limit",
			"5",
			"--json",
			"path,repository,sha,textMatches,url",
			"--repo",
			"owner/repo",
			"--",
			"requireNonEmpty repo:owner/repo",
		]);
		expect(text).toContain("# GitHub code search");
		expect(text).toContain("Query: requireNonEmpty repo:owner/repo");
		expect(text).toContain("Repository: owner/repo");
		expect(text).toContain("Results: 1");
		expect(text).toContain("- src/tools/gh.ts");
		expect(text).toContain("  Repo: owner/repo");
		expect(text).toContain("  Commit: abcdef123456");
		expect(text).toContain("  URL: https://github.com/owner/repo/blob/abc/src/tools/gh.ts");
		expect(text).toContain("  Match: const query = requireNonEmpty(");
	});

	it("searches commits and collapses each message to its subject line", async () => {
		const jsonSpy = vi.spyOn(git.github, "json").mockResolvedValue([
			{
				author: { login: "octocat" },
				commit: {
					author: { name: "Mona", date: "2026-04-01T10:00:00Z" },
					message: "Fix the flaky retry test\n\n(with a long explanation body)",
				},
				id: "sha-node",
				repository: { nameWithOwner: "owner/repo" },
				sha: "0123456789abcdef",
				url: "https://github.com/owner/repo/commit/0123456789abcdef",
			},
		] as never);

		const tool = new GithubTool(createSession());
		const result = await tool.execute("search-commits", {
			op: "search_commits",
			query: "flaky retry",
			repo: "owner/repo",
		});
		const text = textOf(result);

		expect(jsonSpy.mock.calls[0]?.[1]).toEqual([
			"search",
			"commits",
			"--limit",
			"10",
			"--json",
			"author,commit,committer,id,repository,sha,url",
			"--repo",
			"owner/repo",
			"--",
			"flaky retry",
		]);
		expect(text).toContain("# GitHub commits search");
		expect(text).toContain("- 0123456789ab Fix the flaky retry test");
		expect(text).toContain("  Author: @octocat");
		expect(text).toContain("  Date: 2026-04-01T10:00:00Z");
		// The message body must not leak into the result list.
		expect(text).not.toContain("long explanation body");
	});

	it("searches repositories without a repo scope", async () => {
		const jsonSpy = vi.spyOn(git.github, "json").mockResolvedValue([
			{
				description: "A terminal coding agent\nwith a multi-line description",
				forksCount: 12,
				fullName: "owner/cornfield",
				language: "TypeScript",
				openIssuesCount: 3,
				stargazersCount: 4567,
				updatedAt: "2026-04-01T10:00:00Z",
				url: "https://github.com/owner/cornfield",
				visibility: "public",
			},
		] as never);

		const tool = new GithubTool(createSession());
		const result = await tool.execute("search-repos", { op: "search_repos", query: "agent cli", limit: 3 });
		const text = textOf(result);

		expect(jsonSpy.mock.calls[0]?.[1]).toEqual([
			"search",
			"repos",
			"--limit",
			"3",
			"--json",
			"createdAt,description,forksCount,fullName,isArchived,isFork,isPrivate,language,openIssuesCount,owner,stargazersCount,updatedAt,url,visibility",
			"--",
			"agent cli",
		]);
		expect(text).toContain("# GitHub repositories search");
		expect(text).toContain("- owner/cornfield");
		expect(text).toContain("  Description: A terminal coding agent");
		expect(text).toContain("  Language: TypeScript");
		expect(text).toContain("  Stars: 4567");
		expect(text).toContain("  Forks: 12");
		expect(text).toContain("  Open issues: 3");
		expect(text).toContain("  Visibility: public");
	});

	it("rejects a repo scope on search_repos instead of silently dropping it", async () => {
		const jsonSpy = vi.spyOn(git.github, "json").mockResolvedValue([] as never);

		const tool = new GithubTool(createSession());
		await expect(
			tool.execute("search-repos", { op: "search_repos", query: "x", repo: "owner/repo" }),
		).rejects.toThrow(/repository search does not take a repo scope/);
		expect(jsonSpy).not.toHaveBeenCalled();
	});

	it("reports empty result sets with an op-specific message", async () => {
		vi.spyOn(git.github, "json").mockResolvedValue([] as never);
		const tool = new GithubTool(createSession());

		expect(textOf(await tool.execute("c", { op: "search_code", query: "nothing" }))).toContain(
			"No code matches found.",
		);
		expect(textOf(await tool.execute("c", { op: "search_commits", query: "nothing" }))).toContain(
			"No commits found.",
		);
		expect(textOf(await tool.execute("c", { op: "search_repos", query: "nothing" }))).toContain(
			"No repositories found.",
		);
	});

	it("caps limit at the search maximum and rejects non-positive values", async () => {
		const jsonSpy = vi.spyOn(git.github, "json").mockResolvedValue([] as never);
		const tool = new GithubTool(createSession());

		await tool.execute("c", { op: "search_code", query: "q", limit: 500 });
		expect(jsonSpy.mock.calls[0]?.[1]?.[2]).toBe("--limit");
		expect(jsonSpy.mock.calls[0]?.[1]?.[3]).toBe("50");

		await expect(tool.execute("c", { op: "search_code", query: "q", limit: 0 })).rejects.toThrow(
			"limit must be a positive number",
		);
	});

	it("omits --repo for an unscoped search and requires a query", async () => {
		const jsonSpy = vi.spyOn(git.github, "json").mockResolvedValue([] as never);
		const tool = new GithubTool(createSession());

		await tool.execute("c", { op: "search_code", query: "let x = 1" });
		expect(jsonSpy.mock.calls[0]?.[1]).toEqual([
			"search",
			"code",
			"--limit",
			"10",
			"--json",
			"path,repository,sha,textMatches,url",
			"--",
			"let x = 1",
		]);

		await expect(tool.execute("c", { op: "search_code" })).rejects.toThrow("query must not be empty");
	});

	it("keeps the existing issue and pull request search argument order", async () => {
		const jsonSpy = vi.spyOn(git.github, "json").mockResolvedValue([] as never);
		const tool = new GithubTool(createSession());

		await tool.execute("c", { op: "search_issues", query: "-label:bug", repo: "owner/repo", limit: 1 });
		await tool.execute("c", { op: "search_prs", query: "-label:bug", repo: "owner/repo", limit: 1 });

		const issueArgs = jsonSpy.mock.calls[0]?.[1];
		const prArgs = jsonSpy.mock.calls[1]?.[1];
		expect(issueArgs?.slice(0, 2)).toEqual(["search", "issues"]);
		expect(issueArgs?.at(-2)).toBe("--");
		expect(issueArgs?.at(-1)).toBe("-label:bug");
		expect(issueArgs).toContain("--repo");
		expect(prArgs?.slice(0, 2)).toEqual(["search", "prs"]);
		expect(prArgs?.at(-1)).toBe("-label:bug");
	});

	it("exposes every new op in the schema", () => {
		const tool = new GithubTool(createSession());
		// `StringEnum` may render the op list as `enum` or an `anyOf` of consts;
		// assert on the serialized property so the check survives either form.
		const opProperty = JSON.stringify(tool.parameters.properties.op);
		for (const op of ["file_read", "pr_create", "search_code", "search_commits", "search_repos"]) {
			expect(opProperty).toContain(`"${op}"`);
		}
	});
});
