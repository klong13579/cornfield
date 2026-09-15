/**
 * GitHub tool wire contract.
 *
 * The input schema lives here — not in an implementation module — because
 * `GithubInput` is derived from it via `Static<typeof githubSchema>`. Keeping
 * both in one place is what makes the schema the single source of truth for the
 * op parameters, so `gh.ts` and `gh-search.ts` can share the type without
 * either owning it or importing from the other.
 *
 * Also here: the `gh` CLI JSON DTOs and the detail shapes handed to the TUI.
 *
 * Implementations live in `gh.ts` (repo/issue/PR/Actions ops), `gh-search.ts`
 * (search ops), and `gh-common.ts` (shared helpers).
 */
import { StringEnum } from "@cornfield/ai";
import { type Static, Type } from "@sinclair/typebox";
import type { OutputMeta } from "./output-meta";

export const githubSchema = Type.Object({
	op: StringEnum(
		[
			"repo_view",
			"file_read",
			"issue_view",
			"pr_view",
			"pr_diff",
			"pr_create",
			"pr_checkout",
			"pr_push",
			"search_issues",
			"search_prs",
			"search_code",
			"search_commits",
			"search_repos",
			"run_watch",
		],
		{ description: "github operation" },
	),
	repo: Type.Optional(
		Type.String({
			description: "owner/repo for ops that take a repository scope (not search_repos)",
			examples: ["facebook/react"],
		}),
	),
	branch: Type.Optional(
		Type.String({
			description: "branch (repo_view, file_read, pr_push local branch, run_watch)",
			examples: ["main", "develop"],
		}),
	),
	path: Type.Optional(
		Type.String({
			description: "repository-relative file path (file_read)",
			examples: ["src/index.ts", "docs/logo.png"],
		}),
	),
	issue: Type.Optional(
		Type.String({
			description: "issue number or url (issue_view)",
			examples: ["123", "https://github.com/owner/repo/issues/123"],
		}),
	),
	pr: Type.Optional(
		Type.Union(
			[
				Type.String({ examples: ["123", "feature-branch"] }),
				Type.Array(Type.String(), {
					examples: [["123", "456"]],
				}),
			],
			{
				description:
					"pr number, url, or branch (pr_view, pr_diff, pr_checkout); pass an array to batch-process multiple pull requests in one call",
			},
		),
	),
	comments: Type.Optional(Type.Boolean({ description: "include comments (issue_view, pr_view)", default: true })),
	nameOnly: Type.Optional(Type.Boolean({ description: "return file names only (pr_diff)" })),
	exclude: Type.Optional(
		Type.Array(Type.String({ description: "glob to exclude" }), {
			description: "file globs to exclude (pr_diff)",
		}),
	),
	title: Type.Optional(
		Type.String({
			description: "pull request title (pr_create); required unless fill is true",
			examples: ["Fix flaky retry test"],
		}),
	),
	body: Type.Optional(
		Type.String({
			description: "pull request body markdown (pr_create); mutually exclusive with fill",
		}),
	),
	base: Type.Optional(
		Type.String({ description: "branch the pull request merges into (pr_create)", examples: ["main"] }),
	),
	head: Type.Optional(
		Type.String({
			description: "branch holding the changes (pr_create); defaults to the current branch",
			examples: ["feature/retry-fix"],
		}),
	),
	draft: Type.Optional(Type.Boolean({ description: "open the pull request as a draft (pr_create)", default: false })),
	fill: Type.Optional(
		Type.Boolean({
			description: "derive title and body from the branch commits; mutually exclusive with title/body (pr_create)",
			default: false,
		}),
	),
	reviewer: Type.Optional(
		Type.Array(Type.String({ description: "reviewer login or org/team" }), {
			description: "reviewers to request (pr_create)",
		}),
	),
	assignee: Type.Optional(
		Type.Array(Type.String({ description: "assignee login" }), { description: "assignees to set (pr_create)" }),
	),
	label: Type.Optional(
		Type.Array(Type.String({ description: "label name" }), { description: "labels to apply (pr_create)" }),
	),
	force: Type.Optional(Type.Boolean({ description: "reset existing local branch (pr_checkout)" })),
	forceWithLease: Type.Optional(Type.Boolean({ description: "force-with-lease push (pr_push)" })),
	query: Type.Optional(
		Type.String({
			description:
				"search query, in GitHub search syntax (search_issues, search_prs, search_code, search_commits, search_repos)",
			examples: ["is:open label:bug"],
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: "max results (search_issues, search_prs, search_code, search_commits, search_repos)",
			default: 10,
		}),
	),
	run: Type.Optional(Type.String({ description: "actions run id or url (run_watch)", examples: ["123456"] })),
	tail: Type.Optional(Type.Number({ description: "log lines per failed job (run_watch)", default: 15 })),
});

export type GithubInput = Static<typeof githubSchema>;

export interface GhToolDetails {
	meta?: OutputMeta;
	artifactId?: string;
	repo?: string;
	branch?: string;
	worktreePath?: string;
	remote?: string;
	remoteBranch?: string;
	headSha?: string;
	runId?: number;
	runIds?: number[];
	status?: string;
	conclusion?: string;
	failedJobs?: string[];
	watch?: GhRunWatchViewDetails;
	checkouts?: GhPrCheckoutSummary[];
}

export interface GhPrCheckoutSummary {
	prNumber?: number;
	url?: string;
	branch: string;
	worktreePath: string;
	remote: string;
	remoteBranch: string;
	reused: boolean;
}

export interface GhRunWatchJobDetails {
	id: number;
	name: string;
	status?: string;
	conclusion?: string;
	durationSeconds?: number;
	url?: string;
}

export interface GhRunWatchRunDetails {
	id: number;
	workflowName?: string;
	displayTitle?: string;
	status?: string;
	conclusion?: string;
	branch?: string;
	headSha?: string;
	url?: string;
	jobs: GhRunWatchJobDetails[];
}

export interface GhRunWatchFailedLogDetails {
	runId: number;
	workflowName?: string;
	jobName: string;
	conclusion?: string;
	tail?: string;
	available: boolean;
}

export interface GhRunWatchViewDetails {
	mode: "run" | "commit";
	state: "watching" | "completed";
	repo: string;
	branch?: string;
	headSha?: string;
	pollCount?: number;
	note?: string;
	run?: GhRunWatchRunDetails;
	runs?: GhRunWatchRunDetails[];
	failedLogs?: GhRunWatchFailedLogDetails[];
}

export interface GhUser {
	login?: string;
	name?: string | null;
}

export interface GhLabel {
	name?: string;
}

export interface GhComment {
	author?: GhUser | null;
	body?: string;
	createdAt?: string;
	url?: string;
	isMinimized?: boolean;
	minimizedReason?: string | null;
}

export interface GhRepoTopic {
	name?: string;
	topic?: { name?: string };
}

export interface GhRepoLanguage {
	name?: string;
}

export interface GhRepoBranch {
	name?: string;
}

export interface GhRepoViewData {
	nameWithOwner?: string;
	description?: string | null;
	url?: string;
	sshUrl?: string;
	defaultBranchRef?: GhRepoBranch | null;
	homepageUrl?: string | null;
	forkCount?: number;
	isArchived?: boolean;
	isFork?: boolean;
	primaryLanguage?: GhRepoLanguage | null;
	repositoryTopics?: GhRepoTopic[];
	stargazerCount?: number;
	updatedAt?: string;
	viewerPermission?: string | null;
	visibility?: string | null;
}

export interface GhIssueViewData {
	author?: GhUser | null;
	body?: string | null;
	comments?: GhComment[];
	createdAt?: string;
	labels?: GhLabel[];
	number?: number;
	state?: string;
	stateReason?: string | null;
	title?: string;
	updatedAt?: string;
	url?: string;
}

export interface GhPrFile {
	path?: string;
	additions?: number;
	deletions?: number;
	changeType?: string;
}

export interface GhPrViewData extends GhIssueViewData {
	baseRefName?: string;
	files?: GhPrFile[];
	headRefName?: string;
	headRefOid?: string;
	headRepository?: GhRepoViewData | null;
	headRepositoryOwner?: GhUser | null;
	isCrossRepository?: boolean;
	isDraft?: boolean;
	maintainerCanModify?: boolean;
	mergeStateStatus?: string;
	reviewComments?: GhPrReviewComment[];
	reviews?: GhPrReview[];
	reviewDecision?: string;
}

export interface GhPrReviewCommit {
	oid?: string | null;
}

export interface GhPrReview {
	author?: GhUser | null;
	body?: string | null;
	commit?: GhPrReviewCommit | null;
	state?: string | null;
	submittedAt?: string | null;
}

export interface GhPrReviewCommentApi {
	body?: string | null;
	created_at?: string | null;
	html_url?: string | null;
	id?: number;
	in_reply_to_id?: number | null;
	line?: number | null;
	original_line?: number | null;
	path?: string | null;
	side?: string | null;
	user?: GhUser | null;
}

export interface GhPrReviewComment {
	author?: GhUser | null;
	body?: string | null;
	createdAt?: string;
	id: number;
	inReplyToId?: number;
	line?: number;
	originalLine?: number;
	path?: string;
	side?: string;
	url?: string;
}

export interface GhBranchApiResponse {
	commit?: {
		sha?: string | null;
	} | null;
}

export interface GhSearchRepository {
	nameWithOwner?: string;
}

export interface GhSearchResult {
	author?: GhUser | null;
	createdAt?: string;
	labels?: GhLabel[];
	number?: number;
	repository?: GhSearchRepository | null;
	state?: string;
	title?: string;
	updatedAt?: string;
	url?: string;
}

/** `gh search code --json` text match fragment. */
export interface GhSearchCodeTextMatch {
	fragment?: string;
	property?: string;
}

export interface GhSearchCodeResult {
	path?: string;
	repository?: GhSearchRepository | null;
	sha?: string;
	textMatches?: GhSearchCodeTextMatch[];
	url?: string;
}

export interface GhSearchCommitGitActor {
	name?: string;
	email?: string;
	date?: string;
}

export interface GhSearchCommitDetail {
	author?: GhSearchCommitGitActor | null;
	committer?: GhSearchCommitGitActor | null;
	message?: string;
}

export interface GhSearchCommitResult {
	author?: GhUser | null;
	commit?: GhSearchCommitDetail | null;
	committer?: GhUser | null;
	id?: string;
	repository?: GhSearchRepository | null;
	sha?: string;
	url?: string;
}

export interface GhSearchRepoResult {
	createdAt?: string;
	description?: string | null;
	forksCount?: number;
	fullName?: string;
	isArchived?: boolean;
	isFork?: boolean;
	isPrivate?: boolean;
	language?: string | null;
	openIssuesCount?: number;
	owner?: GhUser | null;
	stargazersCount?: number;
	updatedAt?: string;
	url?: string;
	visibility?: string | null;
}

export interface GhRunReference {
	repo?: string;
	runId?: number;
}

/** `/repos/{owner}/{repo}/contents/{path}` response (subset). */
export interface GitHubContentsFile {
	type?: string;
	encoding?: string;
	size?: number;
	content?: string;
	html_url?: string | null;
}

export type GitHubContentsResponse = GitHubContentsFile | GitHubContentsFile[];

export interface GhActionsRunListResponse {
	workflow_runs?: GhActionsRunApi[];
}

export interface GhActionsRunApi {
	id?: number;
	name?: string | null;
	display_title?: string | null;
	status?: string | null;
	conclusion?: string | null;
	head_branch?: string | null;
	head_sha?: string | null;
	created_at?: string | null;
	updated_at?: string | null;
	html_url?: string | null;
}

export interface GhActionsJobsResponse {
	total_count?: number;
	jobs?: GhActionsJobApi[];
}

export interface GhActionsJobApi {
	id?: number;
	name?: string | null;
	status?: string | null;
	conclusion?: string | null;
	started_at?: string | null;
	completed_at?: string | null;
	html_url?: string | null;
}

export interface GhRunJobSnapshot {
	id: number;
	name: string;
	status?: string;
	conclusion?: string;
	startedAt?: string;
	completedAt?: string;
	url?: string;
}

export interface GhRunSnapshot {
	id: number;
	workflowName?: string;
	displayTitle?: string;
	status?: string;
	conclusion?: string;
	branch?: string;
	headSha?: string;
	createdAt?: string;
	updatedAt?: string;
	url?: string;
	jobs: GhRunJobSnapshot[];
}

export interface GhFailedJobLog {
	run: GhRunSnapshot;
	job: GhRunJobSnapshot;
	full?: string;
	tail?: string;
	available: boolean;
}
