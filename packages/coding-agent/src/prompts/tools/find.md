Finds files using fast pattern matching that works with any codebase size.

<instruction>
- You **SHOULD** perform multiple searches in parallel when potentially useful
- `pattern` may be a path-backed internal URL (`skill://<name>/`, `artifact://<id>`, `rule://<name>`, …). These accept **exact paths only** — glob characters are rejected, because a glob has no meaning inside a URL. To see what a resource contains, list it with `read` first (e.g. `read skill://<name>/`), then glob a concrete path.
</instruction>

<output>
Matching file paths sorted by modification time (most recent first). Truncated at 1000 entries or 50KB (configurable via `limit`).
</output>

<examples>
# Find files
`{"pattern": "src/**/*.ts", "limit": 1000}`
</examples>

<avoid>
For open-ended searches requiring multiple rounds of globbing and searching, you **MUST** use Task tool instead.
</avoid>

<critical>
- You **MUST** use the built-in `glob` tool for every filesystem lookup. Do **NOT** shell out to `find`, `fd`, `locate`, `ls`, or `git ls-files` via Bash — they ignore `.gitignore`, blow past result limits, and waste tokens.
- If you catch yourself typing `find -name`, `fd`, or `ls **/*.ext` in a Bash command, stop and re-issue the lookup through the `glob` tool with a glob pattern instead.
- You **MUST NOT** pass a glob pattern to an internal URL (`skill://…`, `agent://…`, `artifact://…`): it will be rejected. Use `read` to list the resource, then glob the path it reports.
</critical>
