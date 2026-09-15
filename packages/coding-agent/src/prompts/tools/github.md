GitHub CLI tool with a single op-based dispatch. Wraps `gh` for repository, file, issue, pull request, search, checkout, push, and Actions watch workflows.

<instruction>
Pick the operation via `op`. Each op uses a subset of the parameters:
- `repo_view` — Read repository metadata. Optional `repo` (owner/repo) and `branch`. Falls back to the current checkout or default `gh` repo.
- `file_read` — Read a single file from a repository. Required `path` (repository-relative; a leading `/` is rejected). Optional `repo` and `branch`. Text files return their contents; images return an attachment the model can see; files that are not UTF-8 text report why they cannot be shown instead of returning mojibake.
- `issue_view` — Read an issue. Required `issue` (number or URL). Optional `repo`. Set `comments: false` to skip discussion.
- `pr_view` — Read one or more pull requests, including reviews and inline review comments. Optional `pr` (number, URL, branch, or array of any — pass an array to fetch multiple PRs in one call); omitting it targets the current branch's PR. Optional `repo`. Set `comments: false` for a lighter summary.
- `pr_diff` — Read one or more pull request diffs. Optional `pr` (single identifier or array for batch). Optional `repo`. Set `nameOnly: true` for changed file names. Use `exclude` to drop generated paths from the diff.
- `pr_create` — Open a pull request. Requires `title`, unless `fill: true` (which derives title and body from the branch commits and is mutually exclusive with `title`/`body`). Optional `body`, `base`, `head`, `draft`, `repo`, `reviewer`, `assignee`, `label`. Returns the created pull request's URL and details.
- `pr_checkout` — Check one or more pull requests out into dedicated git worktrees. Optional `pr` (number, URL, branch, or array of any of those — pass an array to batch-check-out multiple PRs in one call), `repo`, `force` (reset existing local branch).
- `pr_push` — Push a checked-out PR branch back to its source branch. Requires the branch to have been checked out via `op: pr_checkout` (carries push metadata). Optional `branch`; defaults to the current checked-out git branch. Optional `forceWithLease`.
- `search_issues` — Search issues using normal GitHub issue search syntax. Required `query`. Optional `repo`, `limit`.
- `search_prs` — Search pull requests using normal GitHub PR search syntax. Required `query`. Optional `repo`, `limit`.
- `search_code` — Search code across GitHub or within one repository. Required `query`. Optional `repo`, `limit`. Each hit reports the path, the commit it was found at, and the first matching fragment.
- `search_commits` — Search commits. Required `query`. Optional `repo`, `limit`. Each hit reports the short SHA, the commit subject, and the author date.
- `search_repos` — Search repositories. Required `query`. Optional `limit`. Scope the search with `owner:`, `org:`, or `user:` qualifiers inside `query` — this op takes no `repo` parameter.
- `run_watch` — Watch a GitHub Actions workflow run. Optional `run` (id or URL). Omitting `run` watches all workflow runs for the current HEAD commit; `branch` falls back to the current branch. Optional `tail` (log lines per failed job). Streams snapshots, fast-fails on the first detected job failure (with a brief grace period to capture concurrent failures), then fetches tailed logs for the failed jobs. The full failed-job logs are saved as a session artifact for on-demand reads.
</instruction>

<output>
Returns a concise readable summary tailored to the chosen op (repo/file/issue/PR metadata, file contents or an image attachment, diff text, created-PR details, search results, checkout info, push target, or workflow run snapshot). For `run_watch`, the full failed-job logs are saved as a session artifact when failures occur.
</output>
