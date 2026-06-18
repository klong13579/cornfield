# TOOLS.md

> Tool usage guide + tool-level `MUST` / `MUST NOT` rules.
>
> This file is **always-on** (injected via `prompt-includes.json`).
> Per design §4 principle 2: **tool-level rules are co-located with the tool description**.
> Use `MUST` / `MUST NOT` / `NEVER` in this file — OMP extracts them into `<hard-constraints>`.

## OMP 内置工具

### `read`
Read a file or URL.

- MUST verify the path is inside `agentDir` unless the user names an explicit external path.
- MUST NOT read files larger than the configured `read.defaultLimit` without paging.

### `grep`
Search text across files.

- MUST narrow by `path` before running on a large repo.
- MUST prefer `grep` over manual `cat` / `head` / `tail` / `rg` pipelines.

### `bash`
Execute shell commands.

- MUST use `read` / `grep` instead of `cat` / `head` / `tail` for inspection.
- MUST NOT run interactive commands (`vim`, `less`, `ssh` without batch flags).
- MUST NOT pipe untrusted input to `sh` / `bash`.
- MUST redirect large output to a file and read it back with `read`.

### `write`
Create or overwrite a file.

- MUST NOT overwrite an existing file without reading the current content first.
- MUST verify the parent directory is correct before writing.

### `edit`
Edit an existing file via `atom` / `hashline` / `patch` mode.

- MUST read the file first to obtain current anchors.
- MUST NOT use `sed` / `awk` for structural edits; use `edit` instead.

## Project-specific tools

> Append project-specific tools here (DingTalk MCP, GitLab MCP, internal APIs, etc.).
> For each tool, list its purpose and any co-located `MUST` / `MUST NOT` rules.
