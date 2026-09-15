/**
 * GitHub search ops.
 *
 * All five go through `gh search <kind> --json <fields>` with the field lists
 * below, so every search op returns the same normalized shapes the formatters
 * render — and the ops that existed before (`search_issues`, `search_prs`)
 * keep the exact argument order their tests pin down.
 */
import type { AgentToolResult } from "@cornfield/agent";
import * as git from "../utils/git";
import type { ToolSession } from ".";
import {
	appendRepoFlag,
	buildTextResult,
	formatAuthor,
	formatLabels,
	normalizeOptionalString,
	normalizeText,
	pushLine,
	requireNonEmpty,
} from "./gh-common";
import { formatShortSha } from "./gh-format";
import type {
	GhSearchCodeResult,
	GhSearchCommitResult,
	GhSearchRepoResult,
	GhSearchResult,
	GhToolDetails,
	GithubInput,
} from "./gh-types";
import { ToolError } from "./tool-errors";

const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MAX = 50;

/** `gh search issues` / `gh search prs` JSON fields. */
const GH_SEARCH_FIELDS = [
	"author",
	"createdAt",
	"labels",
	"number",
	"repository",
	"state",
	"title",
	"updatedAt",
	"url",
];

const GH_CODE_SEARCH_FIELDS = ["path", "repository", "sha", "textMatches", "url"];
const GH_COMMIT_SEARCH_FIELDS = ["author", "commit", "committer", "id", "repository", "sha", "url"];
const GH_REPO_SEARCH_FIELDS = [
	"createdAt",
	"description",
	"forksCount",
	"fullName",
	"isArchived",
	"isFork",
	"isPrivate",
	"language",
	"openIssuesCount",
	"owner",
	"stargazersCount",
	"updatedAt",
	"url",
	"visibility",
];

type SearchCommand = "issues" | "prs" | "code" | "commits" | "repos";

const SEARCH_FIELDS: Record<SearchCommand, readonly string[]> = {
	issues: GH_SEARCH_FIELDS,
	prs: GH_SEARCH_FIELDS,
	code: GH_CODE_SEARCH_FIELDS,
	commits: GH_COMMIT_SEARCH_FIELDS,
	repos: GH_REPO_SEARCH_FIELDS,
};

function resolveSearchLimit(value: number | undefined): number {
	if (value === undefined) {
		return SEARCH_LIMIT_DEFAULT;
	}

	if (!Number.isFinite(value) || value <= 0) {
		throw new ToolError("limit must be a positive number");
	}

	return Math.min(Math.floor(value), SEARCH_LIMIT_MAX);
}

function buildGhSearchArgs(command: SearchCommand, query: string, limit: number, repo: string | undefined): string[] {
	const args = ["search", command, "--limit", String(limit), "--json", SEARCH_FIELDS[command].join(",")];
	if (command === "repos") {
		// `gh search repos` has no `--repo` flag, and a repository is not a
		// scope for repository search — the scope belongs in the query
		// (`owner:`, `org:`, `user:`). Reject instead of dropping the input.
		if (repo) {
			throw new ToolError("repository search does not take a repo scope; narrow it with owner:/org: in `query`");
		}
	} else {
		appendRepoFlag(args, repo);
	}
	args.push("--", query);
	return args;
}

function formatSearchResults(
	kind: "issues" | "pull requests",
	query: string,
	repo: string | undefined,
	items: GhSearchResult[],
): string {
	const lines: string[] = [`# GitHub ${kind} search`, "", `Query: ${query}`];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Results", items.length);

	if (items.length === 0) {
		lines.push("");
		lines.push(`No ${kind} found.`);
		return lines.join("\n").trim();
	}

	for (const item of items) {
		lines.push("");
		lines.push(`- #${item.number ?? "?"} ${item.title ?? "Untitled"}`);
		pushLine(lines, "  Repo", item.repository?.nameWithOwner);
		pushLine(lines, "  State", item.state);
		pushLine(lines, "  Author", formatAuthor(item.author));
		pushLine(lines, "  Labels", formatLabels(item.labels));
		pushLine(lines, "  Created", item.createdAt);
		pushLine(lines, "  Updated", item.updatedAt);
		pushLine(lines, "  URL", item.url);
	}

	return lines.join("\n").trim();
}

function formatSearchCodeResults(query: string, repo: string | undefined, items: GhSearchCodeResult[]): string {
	const lines: string[] = ["# GitHub code search", "", `Query: ${query}`];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Results", items.length);

	if (items.length === 0) {
		lines.push("");
		lines.push("No code matches found.");
		return lines.join("\n").trim();
	}

	for (const item of items) {
		lines.push("");
		lines.push(`- ${item.path ?? "(unknown path)"}`);
		pushLine(lines, "  Repo", item.repository?.nameWithOwner);
		pushLine(lines, "  Commit", formatShortSha(item.sha));
		pushLine(lines, "  URL", item.url);
		const fragment = item.textMatches?.find(match => match.fragment)?.fragment;
		if (fragment) {
			pushLine(lines, "  Match", normalizeText(fragment).split("\n", 1)[0]);
		}
	}

	return lines.join("\n").trim();
}

/** Commit search reports multi-line messages; a result list needs the subject. */
function formatSearchCommitMessage(message: string | undefined): string | undefined {
	if (!message) return undefined;
	const firstLine = normalizeText(message).split("\n", 1)[0];
	return firstLine || undefined;
}

function formatSearchCommitsResults(query: string, repo: string | undefined, items: GhSearchCommitResult[]): string {
	const lines: string[] = ["# GitHub commits search", "", `Query: ${query}`];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Results", items.length);

	if (items.length === 0) {
		lines.push("");
		lines.push("No commits found.");
		return lines.join("\n").trim();
	}

	for (const item of items) {
		lines.push("");
		const sha = formatShortSha(item.sha) ?? "(unknown sha)";
		const subject = formatSearchCommitMessage(item.commit?.message) ?? "(no commit message)";
		lines.push(`- ${sha} ${subject}`);
		pushLine(lines, "  Repo", item.repository?.nameWithOwner);
		pushLine(lines, "  Author", formatAuthor(item.author) ?? item.commit?.author?.name);
		pushLine(lines, "  Date", item.commit?.author?.date ?? item.commit?.committer?.date);
		pushLine(lines, "  URL", item.url);
	}

	return lines.join("\n").trim();
}

function formatSearchReposResults(query: string, items: GhSearchRepoResult[]): string {
	const lines: string[] = ["# GitHub repositories search", "", `Query: ${query}`];
	pushLine(lines, "Results", items.length);

	if (items.length === 0) {
		lines.push("");
		lines.push("No repositories found.");
		return lines.join("\n").trim();
	}

	for (const item of items) {
		lines.push("");
		lines.push(`- ${item.fullName ?? "(unknown repository)"}`);
		const description = normalizeText(item.description).split("\n", 1)[0];
		if (description) {
			pushLine(lines, "  Description", description);
		}
		pushLine(lines, "  Language", item.language ?? undefined);
		pushLine(lines, "  Stars", item.stargazersCount);
		pushLine(lines, "  Forks", item.forksCount);
		pushLine(lines, "  Open issues", item.openIssuesCount);
		pushLine(lines, "  Visibility", item.visibility ?? undefined);
		pushLine(lines, "  Archived", item.isArchived);
		pushLine(lines, "  Fork", item.isFork);
		pushLine(lines, "  Updated", item.updatedAt);
		pushLine(lines, "  URL", item.url);
	}

	return lines.join("\n").trim();
}

export async function executeSearchIssues(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const query = requireNonEmpty(params.query, "query");
	const repo = normalizeOptionalString(params.repo);
	const limit = resolveSearchLimit(params.limit);
	const args = buildGhSearchArgs("issues", query, limit, repo);

	const items = await git.github.json<GhSearchResult[]>(session.cwd, args, signal, {
		repoProvided: Boolean(repo),
	});
	return buildTextResult(formatSearchResults("issues", query, repo, items));
}

export async function executeSearchPrs(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const query = requireNonEmpty(params.query, "query");
	const repo = normalizeOptionalString(params.repo);
	const limit = resolveSearchLimit(params.limit);
	const args = buildGhSearchArgs("prs", query, limit, repo);

	const items = await git.github.json<GhSearchResult[]>(session.cwd, args, signal, {
		repoProvided: Boolean(repo),
	});
	return buildTextResult(formatSearchResults("pull requests", query, repo, items));
}

export async function executeSearchCode(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const query = requireNonEmpty(params.query, "query");
	const repo = normalizeOptionalString(params.repo);
	const limit = resolveSearchLimit(params.limit);
	const args = buildGhSearchArgs("code", query, limit, repo);

	const items = await git.github.json<GhSearchCodeResult[]>(session.cwd, args, signal, {
		repoProvided: Boolean(repo),
	});
	return buildTextResult(formatSearchCodeResults(query, repo, items));
}

export async function executeSearchCommits(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const query = requireNonEmpty(params.query, "query");
	const repo = normalizeOptionalString(params.repo);
	const limit = resolveSearchLimit(params.limit);
	const args = buildGhSearchArgs("commits", query, limit, repo);

	const items = await git.github.json<GhSearchCommitResult[]>(session.cwd, args, signal, {
		repoProvided: Boolean(repo),
	});
	return buildTextResult(formatSearchCommitsResults(query, repo, items));
}

export async function executeSearchRepos(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const query = requireNonEmpty(params.query, "query");
	const limit = resolveSearchLimit(params.limit);
	const args = buildGhSearchArgs("repos", query, limit, normalizeOptionalString(params.repo));

	// `search_repos` takes no repository scope, so "pass `repo` explicitly" would
	// be advice the caller cannot follow — keep the raw gh error instead.
	const items = await git.github.json<GhSearchRepoResult[]>(session.cwd, args, signal, { repoProvided: true });
	return buildTextResult(formatSearchReposResults(query, items));
}
