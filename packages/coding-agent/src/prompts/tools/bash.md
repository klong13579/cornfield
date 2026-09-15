Executes bash command in shell session for terminal operations like git, bun, cargo, python.

<instruction>
- You **MUST** use `cwd` parameter to set working directory instead of `cd dir && …`
- Quote variable expansions like `"$NAME"` to preserve exact content.
- You **MUST** use `;` only when later commands should run regardless of earlier failures.
- Internal URIs (`skill://`, `agent://`, etc.) auto-resolve to filesystem paths. Write `\skill://…` to keep one literal, and note that a quoted heredoc body (`<<'EOF'`) is never expanded — use it to paste literal URIs into a file.
- `timeout` is seconds and is clamped to 1-3600; `timeout: 0` disables the command deadline entirely (use it for long builds, not as a way to shorten the default).
- For inline scripts >3 lines, dry-run syntax check first with `python3 -c "compile(…)"` or `node --check`.
{{#if asyncEnabled}}
- Use `async: true` for long-running commands. Inspect with `read jobs://`, wait with `job({poll: […]})`.
{{/if}}
{{#if autoBackgroundEnabled}}
- Non-PTY commands auto-background after ~{{autoBackgroundThresholdSeconds}}s. Inspect with `read jobs://`, wait with `job({poll: […]})`.
{{/if}}
</instruction>

<output>
Returns output and exit code.
- Truncated output: `artifact://<id>`
- Exit codes shown on non-zero exit
</output>

<critical>
- Use specialized tools (read/grep/glob/edit/write) instead of bash for file/string ops — the interceptor blocks and redirects when you type the wrong command.
- You **MUST NOT** use `2>&1` or `2>/dev/null` — stdout and stderr are already merged.
- You **MUST NOT** read line ranges with `sed -n 'A,Bp'`, `awk 'NR≥A && NR≤B'` — use `read` with `offset`/`limit`.
</critical>
