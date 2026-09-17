import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@cornfield/agent";
import { Settings } from "@cornfield/coding-agent/config/settings";
import { SessionManager } from "@cornfield/coding-agent/session/session-manager";
import type { ToolSession } from "@cornfield/coding-agent/tools";
import { GithubTool } from "@cornfield/coding-agent/tools/gh";
import { githubToolRenderer } from "@cornfield/coding-agent/tools/gh-renderer";
import { resetGithubCacheForTests } from "@cornfield/coding-agent/tools/github-cache";
import { wrapToolWithMetaNotice } from "@cornfield/coding-agent/tools/output-meta";
import { ToolError } from "@cornfield/coding-agent/tools/tool-errors";
import * as git from "@cornfield/coding-agent/utils/git";
import { getClientDir, getGithubCacheDbPath, setClientDir, setConfigRootDir } from "@cornfield/utils";
import { createRenderSurface } from "../helpers/render-assert";

function createSession(
	cwd: string = "/tmp/test",
	// These tests assert formatting, run/PR tool behaviour and TUI rendering. The
	// view cache is exercised in `github-cache.test.ts` and in the wiring block
	// below; leaving it on here would let one test answer from a row another test
	// wrote (and write rows into the developer's real cache).
	settings: Settings = Settings.isolated({ "github.enabled": true, "github.cache.enabled": false }),
	artifactsDir?: string,
): ToolSession {
	let nextArtifactId = 0;
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getArtifactsDir: () => artifactsDir ?? null,
		allocateOutputArtifact: artifactsDir
			? async toolType => {
					const artifactId = String(nextArtifactId++);
					return {
						id: artifactId,
						path: path.join(artifactsDir, `${artifactId}-${toolType}.md`),
					};
				}
			: undefined,
		getSessionSpawns: () => null,
		settings,
	};
}

function createToolContext(settings: Settings): AgentToolContext {
	return {
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: {
			find: () => undefined,
			getAll: () => [],
			getApiKey: async () => undefined,
		} as unknown as AgentToolContext["modelRegistry"],
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	} as AgentToolContext;
}

function runGit(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test User",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test User",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	});
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr).trim()}`);
	}

	return new TextDecoder().decode(result.stdout).trim();
}

async function createPrFixture(): Promise<{
	baseDir: string;
	repoRoot: string;
	originBare: string;
	forkBare: string;
	headRefName: string;
	headRefOid: string;
}> {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-pr-tool-"));
	const repoRoot = path.join(baseDir, "repo");
	const originBare = path.join(baseDir, "origin.git");
	const forkBare = path.join(baseDir, "fork.git");
	const headRefName = "feature/contributor-fix";

	await fs.mkdir(repoRoot, { recursive: true });
	runGit(baseDir, ["init", "--bare", originBare]);
	runGit(baseDir, ["init", "--bare", forkBare]);
	runGit(baseDir, ["init", "-b", "main", repoRoot]);
	runGit(repoRoot, ["config", "user.name", "Test User"]);
	runGit(repoRoot, ["config", "user.email", "test@example.com"]);
	await fs.writeFile(path.join(repoRoot, "README.md"), "base\n");
	runGit(repoRoot, ["add", "README.md"]);
	runGit(repoRoot, ["commit", "-m", "base commit"]);
	runGit(repoRoot, ["remote", "add", "origin", originBare]);
	runGit(repoRoot, ["push", "-u", "origin", "main"]);
	runGit(repoRoot, ["remote", "add", "forksrc", forkBare]);
	runGit(repoRoot, ["checkout", "-b", headRefName]);
	await fs.writeFile(path.join(repoRoot, "README.md"), "base\nfeature\n");
	runGit(repoRoot, ["add", "README.md"]);
	runGit(repoRoot, ["commit", "-m", "feature commit"]);
	const headRefOid = runGit(repoRoot, ["rev-parse", "HEAD"]);
	runGit(repoRoot, ["push", "-u", "forksrc", headRefName]);
	runGit(repoRoot, ["checkout", "main"]);

	return {
		baseDir,
		repoRoot,
		originBare,
		forkBare,
		headRefName,
		headRefOid,
	};
}

/**
 * Stub `os.homedir()` AND rebuild the cached `dirs` resolver in pi-utils so
 * `getWorktreesDir()` resolves under an isolated temp home instead of the
 * user's real `~/.cornfield/wt`. Returns the temp home and a cleanup hook.
 */
async function setupTempHome(): Promise<{ home: string; cleanup: () => Promise<void> }> {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "gh-pr-tool-home-"));
	vi.spyOn(os, "homedir").mockReturnValue(home);
	// `dirs.configRoot` is computed at constructor time from `os.homedir()`, so
	// we must rebuild the resolver after the spy is in place. `setClientDir`
	// recreates it; we point it at the temp home's default agent dir.
	const originalAgentDir = getClientDir();
	setClientDir(path.join(home, ".cornfield", "agent"));
	return {
		home,
		cleanup: async () => {
			setClientDir(originalAgentDir);
			await fs.rm(home, { recursive: true, force: true });
		},
	};
}

/**
 * The auto-derived worktree path for a given primary repo root and local
 * branch, exactly as `pr_checkout` computes it before resolving symlinks.
 */
function rawWorktreePath(home: string, primaryRoot: string, localBranch: string): string {
	const encoded = path
		.resolve(primaryRoot)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-");
	return path.join(home, ".cornfield", "wt", encoded, localBranch);
}

/**
 * Compute the auto-derived worktree path for a given primary repo root and
 * local branch name, mirroring the encoding used by `pr_checkout`. Resolves
 * symlinks (matches the production `fs.realpath` step) so assertions match
 * the value rendered into the tool result.
 */
async function expectedWorktreePath(home: string, primaryRoot: string, localBranch: string): Promise<string> {
	return fs.realpath(rawWorktreePath(home, primaryRoot, localBranch));
}

/** Concatenated text parts of a tool result. */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(part => part.type === "text")
		.map(part => part.text ?? "")
		.join("\n");
}

/** gh's Actions run payload for a run in a given state. */
function actionsRunPayload(id: number, status: string, conclusion?: string): Record<string, unknown> {
	return {
		id,
		name: "CI",
		display_title: "PR checks",
		status,
		conclusion,
		head_branch: "main",
		head_sha: "abc123def456",
		created_at: "2026-04-01T08:00:00Z",
		updated_at: "2026-04-01T08:06:00Z",
		html_url: `https://github.com/owner/repo/actions/runs/${id}`,
	};
}

/** gh's Actions job payload. */
function actionsJobPayload(id: number, name: string, conclusion: string): Record<string, unknown> {
	return {
		id,
		name,
		status: "completed",
		conclusion,
		started_at: "2026-04-01T08:00:00Z",
		completed_at: "2026-04-01T08:02:00Z",
		html_url: `https://github.com/owner/repo/actions/runs/77/job/${id}`,
	};
}

/**
 * Drain microtasks until the run-watch loop is parked on its next sleep.
 *
 * Timers are faked, so a `setTimeout`-backed `abortableSleep` only completes on
 * an explicit `advanceTimersByTime`; a pending timer is therefore the signal
 * that the loop reached its sleep and the clock can be moved. Counting
 * microtask turns instead would couple every test to the loop's await depth.
 */
async function runToNextSleep(): Promise<void> {
	for (let round = 0; round < 500 && vi.getTimerCount() === 0; round += 1) {
		await Promise.resolve();
	}
}

/** Advance the faked clock one poll at a time, letting the loop work between ticks. */
async function advanceWatch(steps: number, ms: number): Promise<void> {
	for (let step = 0; step < steps; step += 1) {
		await runToNextSleep();
		vi.advanceTimersByTime(ms);
	}
	await runToNextSleep();
}

/** Let queued microtasks run without moving the clock. */
async function flushMicrotasks(rounds = 10): Promise<void> {
	for (let round = 0; round < rounds; round += 1) {
		await Promise.resolve();
	}
}

describe("github tool", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("formats repository metadata into readable text", async () => {
		vi.spyOn(git.github, "json").mockResolvedValue({
			nameWithOwner: "cli/cli",
			description: "GitHub CLI",
			url: "https://github.com/cli/cli",
			defaultBranchRef: { name: "trunk" },
			homepageUrl: "https://cli.github.com",
			forkCount: 1234,
			isArchived: false,
			isFork: false,
			primaryLanguage: { name: "Go" },
			repositoryTopics: [{ name: "cli" }, { name: "github" }],
			stargazerCount: 4567,
			updatedAt: "2026-04-01T10:00:00Z",
			viewerPermission: "WRITE",
			visibility: "PUBLIC",
		});

		const tool = new GithubTool(createSession());
		const result = await tool.execute("repo-view", { op: "repo_view", repo: "cli/cli" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("# cli/cli");
		expect(text).toContain("GitHub CLI");
		expect(text).toContain("Default branch: trunk");
		expect(text).toContain("Stars: 4567");
		expect(text).toContain("Topics: cli, github");
	});

	it("formats issue comments and omits minimized ones", async () => {
		vi.spyOn(git.github, "json").mockResolvedValue({
			number: 42,
			title: "Example issue",
			state: "OPEN",
			stateReason: null,
			author: { login: "octocat" },
			body: "Issue body",
			createdAt: "2026-04-01T09:00:00Z",
			updatedAt: "2026-04-01T10:00:00Z",
			url: "https://github.com/cli/cli/issues/42",
			labels: [{ name: "bug" }],
			comments: [
				{
					author: { login: "reviewer" },
					body: "Visible comment",
					createdAt: "2026-04-01T11:00:00Z",
					url: "https://github.com/cli/cli/issues/42#issuecomment-1",
					isMinimized: false,
				},
				{
					author: { login: "spam" },
					body: "Hidden comment",
					createdAt: "2026-04-01T12:00:00Z",
					url: "https://github.com/cli/cli/issues/42#issuecomment-2",
					isMinimized: true,
					minimizedReason: "SPAM",
				},
			],
		});

		const tool = new GithubTool(createSession());
		const result = await tool.execute("issue-view", {
			op: "issue_view",
			issue: "42",
			repo: "cli/cli",
			comments: true,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("# Issue #42: Example issue");
		expect(text).toContain("Labels: bug");
		expect(text).toContain("### @reviewer · 2026-04-01T11:00:00Z");
		expect(text).toContain("Visible comment");
		expect(text).toContain("Minimized comments omitted: 1.");
		expect(text).not.toContain("Hidden comment");
	});

	it("includes pull request reviews and inline review comments in the discussion context", async () => {
		vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
			if (args.includes("/repos/cli/cli/pulls/12/comments")) {
				return [
					{
						id: 501,
						body: "Please rename this helper.",
						path: "src/file.ts",
						line: 17,
						side: "RIGHT",
						user: { login: "inline-reviewer" },
						created_at: "2026-04-01T11:30:00Z",
						html_url: "https://github.com/cli/cli/pull/12#discussion_r1",
					},
				] as never;
			}

			return {
				number: 12,
				title: "Improve PR context",
				state: "OPEN",
				author: { login: "octocat" },
				body: "PR body",
				baseRefName: "main",
				headRefName: "feature/pr-reviews",
				isDraft: false,
				mergeStateStatus: "CLEAN",
				reviewDecision: "CHANGES_REQUESTED",
				createdAt: "2026-04-01T09:00:00Z",
				updatedAt: "2026-04-01T10:00:00Z",
				url: "https://github.com/cli/cli/pull/12",
				labels: [{ name: "bug" }],
				files: [{ path: "src/file.ts", additions: 3, deletions: 1, changeType: "MODIFIED" }],
				reviews: [
					{
						author: { login: "reviewer" },
						body: "Please add coverage for this path.",
						state: "CHANGES_REQUESTED",
						submittedAt: "2026-04-01T11:00:00Z",
						commit: { oid: "abcdef1234567890" },
					},
				],
				comments: [],
			} as never;
		});

		const tool = new GithubTool(createSession());
		const result = await tool.execute("pr-view", {
			op: "pr_view",
			pr: "12",
			repo: "cli/cli",
			comments: true,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("## Reviews (1)");
		expect(text).toContain("### @reviewer - 2026-04-01T11:00:00Z [CHANGES_REQUESTED]");
		expect(text).toContain("Commit: abcdef123456");
		expect(text).toContain("Please add coverage for this path.");
		expect(text).toContain("## Review Comments (1)");
		expect(text).toContain("### @inline-reviewer · 2026-04-01T11:30:00Z");
		expect(text).toContain("Location: src/file.ts:17");
		expect(text).toContain("Please rename this helper.");
	});

	it("formats pull request search results", async () => {
		vi.spyOn(git.github, "json").mockResolvedValue([
			{
				number: 101,
				title: "Add feature",
				state: "OPEN",
				author: { login: "dev1" },
				repository: { nameWithOwner: "owner/repo" },
				labels: [{ name: "feature" }],
				createdAt: "2026-04-01T08:00:00Z",
				updatedAt: "2026-04-01T09:00:00Z",
				url: "https://github.com/owner/repo/pull/101",
			},
			{
				number: 102,
				title: "Fix regression",
				state: "CLOSED",
				author: { login: "dev2" },
				repository: { nameWithOwner: "owner/repo" },
				labels: [],
				createdAt: "2026-03-31T08:00:00Z",
				updatedAt: "2026-03-31T09:00:00Z",
				url: "https://github.com/owner/repo/pull/102",
			},
		]);

		const tool = new GithubTool(createSession());
		const result = await tool.execute("search-prs", {
			op: "search_prs",
			query: "feature",
			repo: "owner/repo",
			limit: 2,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("# GitHub pull requests search");
		expect(text).toContain("Query: feature");
		expect(text).toContain("Repository: owner/repo");
		expect(text).toContain("- #101 Add feature");
		expect(text).toContain("  Labels: feature");
		expect(text).toContain("- #102 Fix regression");
	});

	it("passes leading-dash search queries after -- so gh does not parse them as flags", async () => {
		const runGhJsonSpy = vi.spyOn(git.github, "json").mockResolvedValue([]);

		const tool = new GithubTool(createSession());
		await tool.execute("search-issues", {
			op: "search_issues",
			query: "-label:bug",
			repo: "owner/repo",
			limit: 1,
		});
		await tool.execute("search-prs", {
			op: "search_prs",
			query: "-label:bug",
			repo: "owner/repo",
			limit: 1,
		});

		const issueArgs = runGhJsonSpy.mock.calls[0]?.[1];
		const prArgs = runGhJsonSpy.mock.calls[1]?.[1];

		expect(issueArgs?.slice(0, 2)).toEqual(["search", "issues"]);
		expect(issueArgs?.at(2)).toBe("--limit");
		expect(issueArgs?.at(-2)).toBe("--");
		expect(issueArgs?.at(-1)).toBe("-label:bug");
		expect(prArgs?.slice(0, 2)).toEqual(["search", "prs"]);
		expect(prArgs?.at(2)).toBe("--limit");
		expect(prArgs?.at(-2)).toBe("--");
		expect(prArgs?.at(-1)).toBe("-label:bug");
	});

	it("returns diff output under a stable heading without rewriting patch content", async () => {
		vi.spyOn(git.github, "text").mockResolvedValue("diff --git a/Makefile b/Makefile\n+\tgo test ./... \n");

		const tool = new GithubTool(createSession());
		const result = await tool.execute("pr-diff", { op: "pr_diff", pr: "7", repo: "owner/repo" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("# Pull Request Diff");
		expect(text).toContain("diff --git a/Makefile b/Makefile");
		expect(text).toContain("+\tgo test ./... ");
		expect(text).not.toContain("+    go test ./... ");
	});

	it("spills a large GitHub diff keeping head and tail with the middle elided", async () => {
		const diffOutput = Array.from({ length: 400 }, (_, index) => `diff line ${index + 1}`).join("\n");
		vi.spyOn(git.github, "text").mockResolvedValue(diffOutput);

		const settings = Settings.isolated({
			"github.enabled": true,
			"github.cache.enabled": false,
			"tools.artifactSpillThreshold": 1,
			"tools.artifactTailBytes": 1,
			"tools.artifactTailLines": 20,
		});
		const tool = wrapToolWithMetaNotice(new GithubTool(createSession("/tmp/test", settings)));
		const result = await tool.execute(
			"pr-diff",
			{ op: "pr_diff", pr: "7", repo: "owner/repo" },
			undefined,
			undefined,
			createToolContext(settings),
		);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		// Both ends survive: a diff's head names the files it touches, its tail carries the outcome.
		expect(text).toContain("diff line 1");
		expect(text).toContain("diff line 400");
		// The middle goes to the artifact and is announced, not silently dropped.
		expect(text).not.toContain("diff line 200");
		expect(text).toContain("elided");
		expect(text).toContain("Read artifact://");
		expect(text).not.toContain("Use offset=");

		const truncation = result.details?.meta?.truncation;
		expect(truncation?.direction).toBe("middle");
		expect(truncation?.truncatedBy).toBe("middle");
		expect(truncation?.elidedLines).toBeGreaterThan(0);
		expect(truncation?.artifactId).toBeTruthy();
	});

	it("falls back to a tail-only spill when the head budget is switched off", async () => {
		const diffOutput = Array.from({ length: 400 }, (_, index) => `diff line ${index + 1}`).join("\n");
		vi.spyOn(git.github, "text").mockResolvedValue(diffOutput);

		const settings = Settings.isolated({
			"github.enabled": true,
			"github.cache.enabled": false,
			"tools.artifactSpillThreshold": 1,
			"tools.artifactHeadBytes": 0,
			"tools.artifactTailBytes": 1,
			"tools.artifactTailLines": 20,
		});
		const tool = wrapToolWithMetaNotice(new GithubTool(createSession("/tmp/test", settings)));
		const result = await tool.execute(
			"pr-diff",
			{ op: "pr_diff", pr: "7", repo: "owner/repo" },
			undefined,
			undefined,
			createToolContext(settings),
		);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("diff line 400");
		expect(text).not.toContain("diff line 1");
		expect(text).toContain("Read artifact://");
		expect(text).not.toContain("Use offset=");
		expect(result.details?.meta?.truncation?.direction).toBe("tail");
	});

	it("checks out a pull request into a worktree and configures contributor push metadata", async () => {
		const fixture = await createPrFixture();
		const tempHome = await setupTempHome();
		try {
			vi.spyOn(git.github, "json")
				.mockResolvedValueOnce({
					number: 123,
					title: "Contributor fix",
					url: "https://github.com/base/repo/pull/123",
					baseRefName: "main",
					headRefName: fixture.headRefName,
					headRefOid: fixture.headRefOid,
					headRepository: { nameWithOwner: "contrib/repo" },
					headRepositoryOwner: { login: "contrib" },
					isCrossRepository: true,
					maintainerCanModify: true,
				})
				.mockResolvedValueOnce({
					nameWithOwner: "contrib/repo",
					sshUrl: fixture.forkBare,
					url: fixture.forkBare,
				});

			const tool = new GithubTool(createSession(fixture.repoRoot));
			const result = await tool.execute("pr-checkout", { op: "pr_checkout", pr: "123" });
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const primaryRoot = (await git.repo.primaryRoot(fixture.repoRoot)) ?? fixture.repoRoot;
			const worktreePath = await expectedWorktreePath(tempHome.home, primaryRoot, "pr-123");

			expect(text).toContain("Checked Out Pull Request #123");
			expect(text).toContain(`Worktree: ${worktreePath}`);
			expect(runGit(fixture.repoRoot, ["config", "--get", "branch.pr-123.pushRemote"])).toBe("forksrc");
			expect(runGit(fixture.repoRoot, ["config", "--get", "branch.pr-123.merge"])).toBe(
				`refs/heads/${fixture.headRefName}`,
			);
			expect(runGit(fixture.repoRoot, ["worktree", "list", "--porcelain"])).toContain(`worktree ${worktreePath}`);
			expect(runGit(worktreePath, ["branch", "--show-current"])).toBe("pr-123");
		} finally {
			await tempHome.cleanup();
			await fs.rm(fixture.baseDir, { recursive: true, force: true });
		}
	});

	it("treats git.remote.add as a no-op when the remote already exists with the same URL", async () => {
		const fixture = await createPrFixture();
		try {
			// Fixture already created `forksrc -> forkBare`. A second add with the
			// same URL must succeed silently — this is the cross-process / leftover-
			// state path that used to fail with `error: remote forksrc already exists`.
			await git.remote.add(fixture.repoRoot, "forksrc", fixture.forkBare);
			expect(runGit(fixture.repoRoot, ["remote", "get-url", "forksrc"])).toBe(fixture.forkBare);
		} finally {
			await fs.rm(fixture.baseDir, { recursive: true, force: true });
		}
	});

	it("rejects git.remote.add when the remote already exists with a different URL", async () => {
		const fixture = await createPrFixture();
		try {
			await expect(git.remote.add(fixture.repoRoot, "forksrc", fixture.originBare)).rejects.toThrow(
				/already exists with URL/,
			);
			// Existing URL is preserved — we never overwrote it.
			expect(runGit(fixture.repoRoot, ["remote", "get-url", "forksrc"])).toBe(fixture.forkBare);
		} finally {
			await fs.rm(fixture.baseDir, { recursive: true, force: true });
		}
	});

	it("serializes concurrent git mutations through withRepoLock so callers don't race git's internal locks", async () => {
		const fixture = await createPrFixture();
		try {
			// Without serialization, ~20 concurrent `git config` invocations against
			// the same `.git/config` produce "could not lock config file" failures
			// (the lock is O_EXCL with no waiter). Wrapping each write in
			// `withRepoLock` makes the queue per-repo so all 20 succeed.
			const writes = Array.from({ length: 20 }, (_, idx) =>
				git.withRepoLock(fixture.repoRoot, () =>
					git.config.set(fixture.repoRoot, `branch.race-test.key${idx}`, `value-${idx}`),
				),
			);
			await Promise.all(writes);
			for (let idx = 0; idx < 20; idx += 1) {
				expect(runGit(fixture.repoRoot, ["config", "--get", `branch.race-test.key${idx}`])).toBe(`value-${idx}`);
			}
		} finally {
			await fs.rm(fixture.baseDir, { recursive: true, force: true });
		}
	});

	it("checks out multiple pull requests in a single call when pr is an array", async () => {
		const fixture = await createPrFixture();
		const tempHome = await setupTempHome();
		try {
			// PR #100 reuses the fixture's contributor branch; push it to origin so
			// the non-cross-repo path (which fetches from origin) finds it.
			runGit(fixture.repoRoot, ["push", "origin", `${fixture.headRefName}:${fixture.headRefName}`]);

			// Add a second feature branch on origin so PR #200 has somewhere to come
			// from. Branch names differ to avoid worktree collisions.
			runGit(fixture.repoRoot, ["checkout", "-b", "feature/another", "main"]);
			await Bun.write(path.join(fixture.repoRoot, "OTHER.md"), "other\n");
			runGit(fixture.repoRoot, ["add", "OTHER.md"]);
			runGit(fixture.repoRoot, ["commit", "-m", "another"]);
			const otherOid = runGit(fixture.repoRoot, ["rev-parse", "HEAD"]);
			runGit(fixture.repoRoot, ["push", "-u", "origin", "feature/another"]);
			runGit(fixture.repoRoot, ["checkout", "main"]);

			vi.spyOn(git.github, "json")
				.mockResolvedValueOnce({
					number: 100,
					title: "Same-repo PR 100",
					url: "https://github.com/owner/repo/pull/100",
					baseRefName: "main",
					headRefName: fixture.headRefName,
					headRefOid: fixture.headRefOid,
					isCrossRepository: false,
					maintainerCanModify: true,
				})
				.mockResolvedValueOnce({
					number: 200,
					title: "Same-repo PR 200",
					url: "https://github.com/owner/repo/pull/200",
					baseRefName: "main",
					headRefName: "feature/another",
					headRefOid: otherOid,
					isCrossRepository: false,
					maintainerCanModify: true,
				});

			const tool = new GithubTool(createSession(fixture.repoRoot));
			const result = await tool.execute("pr-checkout", { op: "pr_checkout", pr: ["100", "200"] });
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const primaryRoot = (await git.repo.primaryRoot(fixture.repoRoot)) ?? fixture.repoRoot;
			const wt100 = await expectedWorktreePath(tempHome.home, primaryRoot, "pr-100");
			const wt200 = await expectedWorktreePath(tempHome.home, primaryRoot, "pr-200");

			expect(text).toContain("# 2 Pull Request Worktrees");
			expect(text).toContain("Checked Out Pull Request #100");
			expect(text).toContain("Checked Out Pull Request #200");
			expect(text).toContain(`Worktree: ${wt100}`);
			expect(text).toContain(`Worktree: ${wt200}`);
			expect(runGit(wt100, ["branch", "--show-current"])).toBe("pr-100");
			expect(runGit(wt200, ["branch", "--show-current"])).toBe("pr-200");
			expect(runGit(fixture.repoRoot, ["config", "--get", "branch.pr-100.ompPrUrl"])).toBe(
				"https://github.com/owner/repo/pull/100",
			);
			expect(runGit(fixture.repoRoot, ["config", "--get", "branch.pr-200.ompPrUrl"])).toBe(
				"https://github.com/owner/repo/pull/200",
			);

			const summaries = result.details?.checkouts;
			expect(summaries?.length).toBe(2);
			expect(summaries?.map(s => s.prNumber)).toEqual([100, 200]);
			expect(summaries?.every(s => s.reused === false)).toBe(true);
		} finally {
			await tempHome.cleanup();
			await fs.rm(fixture.baseDir, { recursive: true, force: true });
		}
	});

	it("aggregates multiple pull request diffs when pr is an array", async () => {
		vi.spyOn(git.github, "text")
			.mockResolvedValueOnce("diff --git a/one.ts b/one.ts\n+content one\n")
			.mockResolvedValueOnce("diff --git a/two.ts b/two.ts\n+content two\n");

		const tool = new GithubTool(createSession());
		const result = await tool.execute("pr-diff", { op: "pr_diff", pr: ["10", "20"], repo: "owner/repo" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("# 2 Pull Request Diffs");
		expect(text).toContain("## PR 10");
		expect(text).toContain("## PR 20");
		expect(text).toContain("content one");
		expect(text).toContain("content two");
		// Sections are separated by a horizontal rule.
		expect(text.match(/\n---\n/g)?.length).toBe(1);
	});

	it("aggregates multiple pull request views when pr is an array", async () => {
		vi.spyOn(git.github, "json")
			.mockResolvedValueOnce({
				number: 11,
				title: "First view",
				url: "https://github.com/owner/repo/pull/11",
				baseRefName: "main",
				headRefName: "feature/one",
				state: "OPEN",
				author: { login: "alice" },
				createdAt: "2026-04-01T09:00:00Z",
				updatedAt: "2026-04-01T10:00:00Z",
				comments: [],
				reviews: [],
			})
			.mockResolvedValueOnce({
				number: 22,
				title: "Second view",
				url: "https://github.com/owner/repo/pull/22",
				baseRefName: "main",
				headRefName: "feature/two",
				state: "OPEN",
				author: { login: "bob" },
				createdAt: "2026-04-01T11:00:00Z",
				updatedAt: "2026-04-01T12:00:00Z",
				comments: [],
				reviews: [],
			});

		const tool = new GithubTool(createSession());
		const result = await tool.execute("pr-view", {
			op: "pr_view",
			pr: ["11", "22"],
			repo: "owner/repo",
			comments: false,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("# 2 Pull Requests");
		expect(text).toContain("# Pull Request #11: First view");
		expect(text).toContain("# Pull Request #22: Second view");
	});

	it("rejects PR pushes from branches without checkout metadata", async () => {
		const fixture = await createPrFixture();
		try {
			const originMainBefore = runGit(fixture.baseDir, [
				"--git-dir",
				fixture.originBare,
				"rev-parse",
				"refs/heads/main",
			]);
			runGit(fixture.repoRoot, ["checkout", "-b", "manual-branch", "origin/main"]);
			await Bun.write(path.join(fixture.repoRoot, "README.md"), "base\nmanual\n");
			runGit(fixture.repoRoot, ["add", "README.md"]);
			runGit(fixture.repoRoot, ["commit", "-m", "manual branch commit"]);

			const tool = new GithubTool(createSession(fixture.repoRoot));

			await expect(tool.execute("pr-push", { op: "pr_push" })).rejects.toThrow(
				"branch manual-branch has no PR push metadata; check it out via op: pr_checkout first",
			);
			expect(runGit(fixture.baseDir, ["--git-dir", fixture.originBare, "rev-parse", "refs/heads/main"])).toBe(
				originMainBefore,
			);
		} finally {
			await fs.rm(fixture.baseDir, { recursive: true, force: true });
		}
	});

	it("exposes a flat op-based schema without legacy run_watch parameters", () => {
		const tool = new GithubTool(createSession());
		const properties = tool.parameters.properties as Record<string, unknown>;
		expect(properties.op).toBeDefined();
		expect(properties.interval).toBeUndefined();
		expect(properties.grace).toBeUndefined();
	});

	it("tails failed job logs inline and saves the full failed-job logs as an artifact", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-run-watch-artifacts-"));
		vi.spyOn(git.github, "json")
			.mockResolvedValueOnce({
				id: 77,
				name: "CI",
				display_title: "PR checks",
				status: "completed",
				conclusion: "failure",
				head_branch: "feature/bugfix",
				created_at: "2026-04-01T08:00:00Z",
				updated_at: "2026-04-01T08:06:00Z",
				html_url: "https://github.com/owner/repo/actions/runs/77",
			})
			.mockResolvedValueOnce({
				total_count: 2,
				jobs: [
					{
						id: 201,
						name: "build",
						status: "completed",
						conclusion: "success",
						started_at: "2026-04-01T08:00:00Z",
						completed_at: "2026-04-01T08:02:00Z",
						html_url: "https://github.com/owner/repo/actions/runs/77/job/201",
					},
					{
						id: 202,
						name: "test",
						status: "completed",
						conclusion: "failure",
						started_at: "2026-04-01T08:00:00Z",
						completed_at: "2026-04-01T08:06:00Z",
						html_url: "https://github.com/owner/repo/actions/runs/77/job/202",
					},
				],
			});
		vi.spyOn(git.github, "run").mockResolvedValue({
			exitCode: 0,
			stdout: "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta",
			stderr: "",
		});

		try {
			const tool = new GithubTool(
				createSession("/tmp/test", Settings.isolated({ "github.enabled": true }), artifactsDir),
			);
			const result = await tool.execute("run-watch", {
				op: "run_watch",
				run: "https://github.com/owner/repo/actions/runs/77",
				tail: 3,
			});
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";

			expect(text).toContain("# GitHub Actions Run #77");
			expect(text).toContain("Repository: owner/repo");
			expect(text).toContain("### test [failure]");
			expect(text).toContain("delta");
			expect(text).toContain("epsilon");
			expect(text).toContain("zeta");
			expect(text).not.toContain("alpha");
			expect(text).toContain("Run failed.");
			expect(text).toContain("Full failed-job logs: artifact://0");
			expect(result.details?.artifactId).toBe("0");
			expect(result.details?.watch?.mode).toBe("run");
			expect(result.details?.watch?.state).toBe("completed");
			expect(result.details?.watch?.failedLogs?.[0]?.jobName).toBe("test");
			expect(result.details?.watch?.failedLogs?.[0]?.tail).toContain("zeta");

			const artifactText = await Bun.file(path.join(artifactsDir, "0-github.md")).text();
			expect(artifactText).toContain("# GitHub Actions Run #77");
			expect(artifactText).toContain("Full log:");
			expect(artifactText).toContain("alpha");
			expect(artifactText).toContain("beta");
			expect(artifactText).toContain("gamma");
			expect(artifactText).toContain("delta");
			expect(artifactText).toContain("epsilon");
			expect(artifactText).toContain("zeta");
		} finally {
			await fs.rm(artifactsDir, { recursive: true, force: true });
		}
	});

	it("backs off and retries a rate-limited run_watch poll instead of failing the watch", async () => {
		vi.useFakeTimers();
		try {
			let runAttempts = 0;
			vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
				if (args.includes("/repos/owner/repo/actions/runs/77")) {
					runAttempts += 1;
					if (runAttempts === 1) {
						throw new ToolError("HTTP 403: API rate limit exceeded for user ID 1.");
					}
					return actionsRunPayload(77, "completed", "success") as never;
				}
				if (args.includes("/repos/owner/repo/actions/runs/77/jobs")) {
					return { total_count: 1, jobs: [actionsJobPayload(201, "build", "success")] } as never;
				}
				throw new Error(`unexpected gh call: ${args.join(" ")}`);
			});

			const tool = new GithubTool(createSession());
			let settled = false;
			const pending = tool
				.execute("run-watch", { op: "run_watch", run: "https://github.com/owner/repo/actions/runs/77" })
				.finally(() => {
					settled = true;
				});

			await runToNextSleep();
			expect(runAttempts).toBe(1);
			// The rate limit did not end the watch: it is waiting out the backoff.
			expect(settled).toBe(false);

			vi.advanceTimersByTime(14_000);
			await flushMicrotasks();
			expect(runAttempts).toBe(1);

			vi.advanceTimersByTime(1_000);
			const result = await pending;
			expect(runAttempts).toBe(2);
			expect(textOf(result)).toContain("All jobs passed.");
		} finally {
			vi.useRealTimers();
		}
	});

	it("fails a run_watch once the rate-limit retry budget is spent", async () => {
		vi.useFakeTimers();
		try {
			let runAttempts = 0;
			vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
				if (args.includes("/repos/owner/repo/actions/runs/77")) {
					runAttempts += 1;
				}
				throw new ToolError("You have exceeded a secondary rate limit for this endpoint.");
			});

			const tool = new GithubTool(createSession());
			let settled = false;
			let failure: unknown;
			const pending = tool.execute("run-watch", {
				op: "run_watch",
				run: "https://github.com/owner/repo/actions/runs/77",
			});
			void pending.then(
				() => {
					settled = true;
				},
				error => {
					settled = true;
					failure = error;
				},
			);

			// Five bounded retries, each paying the slow-cadence backoff.
			for (let step = 0; step < 10 && !settled; step += 1) {
				await runToNextSleep();
				vi.advanceTimersByTime(15_000);
			}
			await flushMicrotasks();

			expect(settled).toBe(true);
			expect(failure).toBeInstanceOf(Error);
			expect((failure as Error).message).toMatch(/secondary rate limit/);
			// The sixth consecutive failure is the one that ends the watch.
			expect(runAttempts).toBe(6);
		} finally {
			vi.useRealTimers();
		}
	});

	it("gives up with a reason when a watched commit never produces a workflow run", async () => {
		vi.useFakeTimers();
		try {
			vi.spyOn(git.github, "text").mockResolvedValue("owner/repo");
			let listCalls = 0;
			vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
				if (args.includes("/repos/owner/repo/branches/main")) {
					return { commit: { sha: "abc123def456" } } as never;
				}
				if (args.includes("/repos/owner/repo/actions/runs")) {
					listCalls += 1;
					return { workflow_runs: [] } as never;
				}
				throw new Error(`unexpected gh call: ${args.join(" ")}`);
			});

			const tool = new GithubTool(createSession());
			let settled = false;
			const pending = tool.execute("run-watch", { op: "run_watch", branch: "main" });
			pending.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);

			for (let step = 0; step < 45 && !settled; step += 1) {
				await runToNextSleep();
				vi.advanceTimersByTime(3_000);
			}

			const result = await pending;
			const text = textOf(result);
			const watch = result.details?.watch;

			expect(text).toContain("No workflow runs found for owner/repo@abc123def456");
			expect(text).toContain("Actions may be disabled");
			expect(watch?.mode).toBe("commit");
			expect(watch?.state).toBe("completed");
			expect(watch?.note).toContain("No workflow runs found");
			// 21 fast polls cover the first 60s, then 15s polls: the watch both
			// switched cadence and stopped on its own instead of polling forever.
			expect(watch?.pollCount).toBeGreaterThanOrEqual(21);
			expect(watch?.pollCount).toBeLessThanOrEqual(25);
			expect(listCalls).toBe(watch?.pollCount ?? 0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("confirms a settled commit watch on the fast cadence while the watch is young", async () => {
		vi.useFakeTimers();
		try {
			vi.spyOn(git.github, "text").mockResolvedValue("owner/repo");
			vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
				if (args.includes("/repos/owner/repo/branches/main")) {
					return { commit: { sha: "abc123def456" } } as never;
				}
				if (args.includes("/repos/owner/repo/actions/runs/77/jobs")) {
					return { total_count: 1, jobs: [actionsJobPayload(201, "build", "success")] } as never;
				}
				if (args.includes("/repos/owner/repo/actions/runs")) {
					return { workflow_runs: [actionsRunPayload(77, "completed", "success")] } as never;
				}
				throw new Error(`unexpected gh call: ${args.join(" ")}`);
			});

			const updates: string[] = [];
			const tool = new GithubTool(createSession());
			const pending = tool.execute("run-watch", { op: "run_watch", branch: "main" }, undefined, update => {
				for (const part of update.content) {
					if (part.type === "text" && part.text) updates.push(part.text);
				}
			});

			await advanceWatch(2, 3_000);
			const result = await pending;

			expect(updates.join("\n")).toContain("Waiting 3s to ensure no additional runs appear");
			expect(textOf(result)).toContain("All workflow runs for this commit passed.");
		} finally {
			vi.useRealTimers();
		}
	});

	it("switches a commit watch to the slow cadence once it runs past the fast window", async () => {
		vi.useFakeTimers();
		try {
			vi.spyOn(git.github, "text").mockResolvedValue("owner/repo");
			let listCalls = 0;
			let releaseRuns = false;
			vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
				if (args.includes("/repos/owner/repo/branches/main")) {
					return { commit: { sha: "abc123def456" } } as never;
				}
				if (args.includes("/repos/owner/repo/actions/runs/77/jobs")) {
					return { total_count: 1, jobs: [actionsJobPayload(201, "build", "success")] } as never;
				}
				if (args.includes("/repos/owner/repo/actions/runs")) {
					listCalls += 1;
					return {
						workflow_runs: releaseRuns ? [actionsRunPayload(77, "completed", "success")] : [],
					} as never;
				}
				throw new Error(`unexpected gh call: ${args.join(" ")}`);
			});

			const updates: string[] = [];
			const tool = new GithubTool(createSession());
			const pending = tool.execute("run-watch", { op: "run_watch", branch: "main" }, undefined, update => {
				for (const part of update.content) {
					if (part.type === "text" && part.text) updates.push(part.text);
				}
			});

			// 63s of empty polls on the fast tier: one list call per 3s tick.
			await advanceWatch(21, 3_000);
			expect(listCalls).toBeGreaterThanOrEqual(20);

			releaseRuns = true;
			// The sleep scheduled after the 60s poll is a 15s one, so the next two
			// polls land at 75s and 90s.
			await advanceWatch(9, 3_000);
			const result = await pending;

			expect(updates.join("\n")).toContain("Waiting 15s to ensure no additional runs appear");
			expect(listCalls).toBe(23);
			expect(textOf(result)).toContain("All workflow runs for this commit passed.");
		} finally {
			vi.useRealTimers();
		}
	});

	it("serves completed-run jobs from cache and refetches them after a re-run", async () => {
		vi.useFakeTimers();
		try {
			vi.spyOn(git.github, "text").mockResolvedValue("owner/repo");
			let listCalls = 0;
			let jobsFetches = 0;
			vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
				if (args.includes("/repos/owner/repo/branches/main")) {
					return { commit: { sha: "abc123def456" } } as never;
				}
				if (args.includes("/repos/owner/repo/actions/runs/77/jobs")) {
					jobsFetches += 1;
					return {
						total_count: 1,
						jobs: [actionsJobPayload(201, `job-${jobsFetches}`, "success")],
					} as never;
				}
				if (args.includes("/repos/owner/repo/actions/runs")) {
					listCalls += 1;
					// Poll 3 is an auto-retry: the run flips back off "completed",
					// which must evict the cached job list for run 77.
					const completed = listCalls === 2 || listCalls >= 4;
					return {
						workflow_runs: [
							actionsRunPayload(77, completed ? "completed" : "in_progress", completed ? "success" : undefined),
						],
					} as never;
				}
				throw new Error(`unexpected gh call: ${args.join(" ")}`);
			});

			const tool = new GithubTool(createSession());
			const pending = tool.execute("run-watch", { op: "run_watch", branch: "main" });

			await advanceWatch(5, 3_000);
			const result = await pending;
			const text = textOf(result);

			expect(listCalls).toBe(5);
			// Polls 1-4 each fetch jobs (in-progress, completed, re-run, completed);
			// poll 5 confirms the settled run and reuses poll 4's result.
			expect(jobsFetches).toBe(4);
			expect(text).toContain("job-4");
			expect(text).not.toContain("job-2");
		} finally {
			vi.useRealTimers();
		}
	});

	it("checks a pull request out beside a stale worktree directory instead of failing", async () => {
		const fixture = await createPrFixture();
		const tempHome = await setupTempHome();
		try {
			vi.spyOn(git.github, "json")
				.mockResolvedValueOnce({
					number: 123,
					title: "Contributor fix",
					url: "https://github.com/base/repo/pull/123",
					baseRefName: "main",
					headRefName: fixture.headRefName,
					headRefOid: fixture.headRefOid,
					headRepository: { nameWithOwner: "contrib/repo" },
					headRepositoryOwner: { login: "contrib" },
					isCrossRepository: true,
					maintainerCanModify: true,
				})
				.mockResolvedValueOnce({
					nameWithOwner: "contrib/repo",
					sshUrl: fixture.forkBare,
					url: fixture.forkBare,
				});

			const primaryRoot = (await git.repo.primaryRoot(fixture.repoRoot)) ?? fixture.repoRoot;
			// A stale directory from an interrupted `git worktree add`, plus its
			// first disambiguation candidate, both taken.
			const occupiedPath = rawWorktreePath(tempHome.home, primaryRoot, "pr-123");
			await fs.mkdir(occupiedPath, { recursive: true });
			await fs.writeFile(path.join(occupiedPath, "leftover.txt"), "stale\n");
			await fs.mkdir(`${occupiedPath}-2`, { recursive: true });

			const tool = new GithubTool(createSession(fixture.repoRoot));
			const result = await tool.execute("pr-checkout", { op: "pr_checkout", pr: "123" });
			const expectedPath = await fs.realpath(`${occupiedPath}-3`);

			expect(textOf(result)).toContain(`Checked Out Pull Request #123`);
			expect(textOf(result)).toContain(`Worktree: ${expectedPath}`);
			expect(runGit(fixture.repoRoot, ["worktree", "list", "--porcelain"])).toContain(`worktree ${expectedPath}`);
			expect(runGit(expectedPath, ["branch", "--show-current"])).toBe("pr-123");

			// The path the agent sees is the rendered one, not a pre-resolution guess.
			const surface = await createRenderSurface({ width: 200 });
			const rendered = surface.expectWithinWidth(
				githubToolRenderer.renderResult(result, { expanded: false, isPartial: false }, surface.theme, {
					op: "pr_checkout",
					pr: "123",
				}),
			);
			expect(rendered).toContain("GitHub PR Checkout");
			expect(rendered).toContain(expectedPath);
		} finally {
			await tempHome.cleanup();
			await fs.rm(fixture.baseDir, { recursive: true, force: true });
		}
	});

	it("steps past a worktree path git still has registered when its directory is gone", async () => {
		const fixture = await createPrFixture();
		const tempHome = await setupTempHome();
		try {
			vi.spyOn(git.github, "json")
				.mockResolvedValueOnce({
					number: 123,
					title: "Contributor fix",
					url: "https://github.com/base/repo/pull/123",
					baseRefName: "main",
					headRefName: fixture.headRefName,
					headRefOid: fixture.headRefOid,
					headRepository: { nameWithOwner: "contrib/repo" },
					headRepositoryOwner: { login: "contrib" },
					isCrossRepository: true,
					maintainerCanModify: true,
				})
				.mockResolvedValueOnce({
					nameWithOwner: "contrib/repo",
					sshUrl: fixture.forkBare,
					url: fixture.forkBare,
				});

			const primaryRoot = (await git.repo.primaryRoot(fixture.repoRoot)) ?? fixture.repoRoot;
			const occupiedPath = rawWorktreePath(tempHome.home, primaryRoot, "pr-123");
			await fs.mkdir(path.dirname(occupiedPath), { recursive: true });
			runGit(fixture.repoRoot, ["worktree", "add", "--detach", occupiedPath]);
			// The directory is gone but git still registers it: creating it again
			// would fail with "already registered", so the resolver must step aside.
			await fs.rm(occupiedPath, { recursive: true, force: true });

			const tool = new GithubTool(createSession(fixture.repoRoot));
			const result = await tool.execute("pr-checkout", { op: "pr_checkout", pr: "123" });
			const expectedPath = await fs.realpath(`${occupiedPath}-2`);

			expect(textOf(result)).toContain(`Worktree: ${expectedPath}`);
			expect(runGit(expectedPath, ["branch", "--show-current"])).toBe("pr-123");
		} finally {
			await tempHome.cleanup();
			await fs.rm(fixture.baseDir, { recursive: true, force: true });
		}
	});

	it("retries gh issue view without stateReason when the CLI does not know the field", async () => {
		const jsonSpy = vi
			.spyOn(git.github, "json")
			.mockRejectedValueOnce(new ToolError('Unknown JSON field: "stateReason"'))
			.mockResolvedValueOnce({
				number: 42,
				title: "Example issue",
				state: "OPEN",
				author: { login: "octocat" },
				body: "Issue body",
				createdAt: "2026-04-01T09:00:00Z",
				updatedAt: "2026-04-01T10:00:00Z",
				url: "https://github.com/cli/cli/issues/42",
				comments: [],
			} as never);

		const tool = new GithubTool(createSession());
		const result = await tool.execute("issue-view", {
			op: "issue_view",
			issue: "42",
			repo: "cli/cli",
			comments: false,
		});

		const firstArgs = (jsonSpy.mock.calls[0]?.[1] ?? []).join(",");
		const retryArgs = (jsonSpy.mock.calls[1]?.[1] ?? []).join(",");
		expect(firstArgs).toContain("stateReason");
		expect(retryArgs).not.toContain("stateReason");
		// Only the unsupported field is dropped from the retry.
		expect(retryArgs).toContain("number");

		const text = textOf(result);
		expect(text).toContain("# Issue #42: Example issue");
		expect(text).not.toContain("State reason");

		const surface = await createRenderSurface({ width: 100 });
		const rendered = surface.expectWithinWidth(
			githubToolRenderer.renderResult(result, { expanded: false, isPartial: false }, surface.theme, {
				op: "issue_view",
				repo: "cli/cli",
			}),
		);
		expect(rendered).toContain("GitHub Issue");
		expect(rendered).toContain("# Issue #42: Example issue");
		expect(rendered).not.toContain("State reason");
	});

	it("renders an issue response with no stateReason field without throwing", async () => {
		vi.spyOn(git.github, "json").mockResolvedValue({
			number: 7,
			title: "No reason",
			state: "OPEN",
			author: { login: "octocat" },
			body: "Issue body",
			url: "https://github.com/cli/cli/issues/7",
			comments: [],
		} as never);

		const tool = new GithubTool(createSession());
		const result = await tool.execute("issue-view", {
			op: "issue_view",
			issue: "7",
			repo: "cli/cli",
			comments: false,
		});
		const text = textOf(result);

		expect(text).toContain("# Issue #7: No reason");
		expect(text).toContain("State: OPEN");
		expect(text).not.toContain("State reason");
	});

	it("does not retry an issue view that failed for a reason other than the unknown field", async () => {
		const jsonSpy = vi.spyOn(git.github, "json").mockRejectedValue(new ToolError("HTTP 404: Not Found"));

		const tool = new GithubTool(createSession());
		await expect(
			tool.execute("issue-view", { op: "issue_view", issue: "42", repo: "cli/cli", comments: false }),
		).rejects.toThrow(/404/);
		expect(jsonSpy).toHaveBeenCalledTimes(1);
	});
});

/**
 * Point the view cache at a temp root and give it a credential fingerprint, so
 * a wiring test exercises the real cache without reading or writing the
 * developer's `~/.cornfield` or their own `gh` login. Throws when the cache
 * would escape the temp root, so an XDG override can never silently redirect
 * these rows into a real cache.
 */
async function setupCacheIsolation(): Promise<{ root: string; cleanup: () => Promise<void> }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gh-cache-tool-"));
	const ghConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-cache-tool-gh-"));
	const savedToken = process.env.GH_TOKEN;
	const savedGhConfigDir = process.env.GH_CONFIG_DIR;
	process.env.GH_TOKEN = "wiring-token";
	process.env.GH_CONFIG_DIR = ghConfigDir;
	setConfigRootDir(root);
	resetGithubCacheForTests();
	if (!getGithubCacheDbPath().startsWith(root)) {
		throw new Error(`view cache escaped the temp root: ${getGithubCacheDbPath()}`);
	}

	return {
		root,
		cleanup: async () => {
			resetGithubCacheForTests();
			setConfigRootDir(undefined);
			if (savedToken === undefined) delete process.env.GH_TOKEN;
			else process.env.GH_TOKEN = savedToken;
			if (savedGhConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
			else process.env.GH_CONFIG_DIR = savedGhConfigDir;
			await fs.rm(root, { recursive: true, force: true });
			await fs.rm(ghConfigDir, { recursive: true, force: true });
		},
	};
}

/** `gh issue view --json` payload for an issue. */
function issuePayload(number: number, title: string): Record<string, unknown> {
	return {
		number,
		title,
		state: "OPEN",
		author: { login: "octocat" },
		body: "Issue body",
		createdAt: "2026-04-01T09:00:00Z",
		updatedAt: "2026-04-01T10:00:00Z",
		url: `https://github.com/cli/cli/issues/${number}`,
		comments: [],
	};
}

describe("github view cache wiring", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("serves a repeated issue view from the cache and marks it as cached", async () => {
		const isolation = await setupCacheIsolation();
		try {
			const jsonSpy = vi.spyOn(git.github, "json").mockResolvedValue(issuePayload(42, "Cached issue") as never);
			const tool = new GithubTool(createSession("/tmp/test", Settings.isolated({ "github.enabled": true })));
			const params = { op: "issue_view", issue: "42", repo: "cli/cli", comments: true } as const;

			const first = await tool.execute("issue-view", params);
			const second = await tool.execute("issue-view", params);

			expect(jsonSpy).toHaveBeenCalledTimes(1);
			expect(textOf(second)).toContain("# Issue #42: Cached issue");
			// A cache hit has to announce itself; a copy that reads as live data is
			// the failure the marker exists to prevent.
			expect(textOf(first)).not.toContain("[Cached:");
			expect(textOf(second)).toContain("[Cached: fetched 0s ago]");
		} finally {
			await isolation.cleanup();
		}
	});

	it("re-fetches an issue view after the credential fingerprint changes", async () => {
		const isolation = await setupCacheIsolation();
		try {
			const jsonSpy = vi.spyOn(git.github, "json").mockResolvedValue(issuePayload(42, "Cached issue") as never);
			const tool = new GithubTool(createSession("/tmp/test", Settings.isolated({ "github.enabled": true })));
			const params = { op: "issue_view", issue: "42", repo: "cli/cli", comments: true } as const;

			await tool.execute("issue-view", params);
			process.env.GH_TOKEN = "rotated-token";
			const afterRotation = await tool.execute("issue-view", params);

			expect(jsonSpy).toHaveBeenCalledTimes(2);
			expect(textOf(afterRotation)).not.toContain("[Cached:");
		} finally {
			await isolation.cleanup();
		}
	});

	it("does not cache a view identified only by a branch name", async () => {
		const isolation = await setupCacheIsolation();
		try {
			const jsonSpy = vi.spyOn(git.github, "json").mockResolvedValue({
				number: 12,
				title: "Branch view",
				state: "OPEN",
				url: "https://github.com/cli/cli/pull/12",
				comments: [],
			} as never);
			const tool = new GithubTool(createSession("/tmp/test", Settings.isolated({ "github.enabled": true })));
			const params = { op: "pr_view", pr: "feature/retry-fix", repo: "cli/cli", comments: false } as const;

			await tool.execute("pr-view", params);
			await tool.execute("pr-view", params);

			expect(jsonSpy).toHaveBeenCalledTimes(2);
		} finally {
			await isolation.cleanup();
		}
	});

	it("does not cache a failed view", async () => {
		const isolation = await setupCacheIsolation();
		try {
			const jsonSpy = vi
				.spyOn(git.github, "json")
				.mockRejectedValueOnce(new ToolError("HTTP 404: Not Found"))
				.mockResolvedValueOnce(issuePayload(42, "Recovered issue") as never);
			const tool = new GithubTool(createSession("/tmp/test", Settings.isolated({ "github.enabled": true })));
			const params = { op: "issue_view", issue: "42", repo: "cli/cli", comments: true } as const;

			await expect(tool.execute("issue-view", params)).rejects.toThrow(/404/);
			const recovered = await tool.execute("issue-view", params);

			expect(jsonSpy).toHaveBeenCalledTimes(2);
			expect(textOf(recovered)).toContain("# Issue #42: Recovered issue");
		} finally {
			await isolation.cleanup();
		}
	});

	it("keeps pr_diff filter variants in separate rows", async () => {
		const isolation = await setupCacheIsolation();
		try {
			const textSpy = vi.spyOn(git.github, "text").mockResolvedValue("diff --git a/x b/x\n");
			const tool = new GithubTool(createSession("/tmp/test", Settings.isolated({ "github.enabled": true })));
			const names = { op: "pr_diff", pr: "7", repo: "cli/cli", nameOnly: true } as const;
			const full = { op: "pr_diff", pr: "7", repo: "cli/cli" } as const;

			const nameList = await tool.execute("pr-diff", names);
			await tool.execute("pr-diff", full);
			const repeated = await tool.execute("pr-diff", names);

			expect(textSpy).toHaveBeenCalledTimes(2);
			expect(textOf(nameList)).toContain("# Pull Request Files");
			expect(textOf(repeated)).toContain("[Cached: fetched 0s ago]");
		} finally {
			await isolation.cleanup();
		}
	});

	it("leaves ops other than the view ops uncached", async () => {
		const isolation = await setupCacheIsolation();
		try {
			const jsonSpy = vi
				.spyOn(git.github, "json")
				.mockResolvedValue({ nameWithOwner: "cli/cli", url: "https://github.com/cli/cli" } as never);
			const tool = new GithubTool(createSession("/tmp/test", Settings.isolated({ "github.enabled": true })));
			const params = { op: "repo_view", repo: "cli/cli" } as const;

			const first = await tool.execute("repo-view", params);
			const second = await tool.execute("repo-view", params);

			expect(jsonSpy).toHaveBeenCalledTimes(2);
			expect(textOf(first)).not.toContain("[Cached:");
			expect(textOf(second)).not.toContain("[Cached:");
		} finally {
			await isolation.cleanup();
		}
	});
});
