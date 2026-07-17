Performs string replacements in files with fuzzy whitespace matching.

**Content-based ONLY** — this mode does NOT support line numbers, line ranges, anchors,
hashes, or any position-based addressing. Edits are identified by **what text to find**
(`old_text`), not by **where in the file** the text is located. If you need to edit by
line number, use `bash` with `sed` instead — see the bash-alternatives section below.

<instruction>
- Params **MUST** be `{ path, edits }`; `path` is required at the top level and applies to every replacement
- You **MUST** use the smallest `old_text` that uniquely identifies the change
- If `old_text` is not unique, you **MUST** expand it with more context or use `all: true` to replace all occurrences
- You **SHOULD** prefer editing existing files over creating new ones
</instruction>

<output>
Returns success/failure status. On success, file modified in place with replacement applied. On failure (e.g., `old_text` not found or matches multiple locations without `all: true`), returns error describing issue.
</output>

<critical>
- You **MUST** read the file at least once in the conversation before editing. Tool errors if you attempt edit without reading file first.
</critical>

<bash-alternatives>
Replace for content-addressed changes—you identify \_what* to change by its text.

For position-addressed or pattern-addressed changes, bash more efficient:

|Operation|Command|
|---|---|
|Append to file|`cat >> file <<'EOF'`…`EOF`|
|Prepend to file|`{ cat - file; } <<'EOF' > tmp && mv tmp file`|
|Delete lines N-M|`sed -i 'N,Md' file`|
|Insert after line N|`sed -i 'Na\text' file`|
|Regex replace|`sd 'pattern' 'replacement' file`|
|Bulk replace across files|`sd 'pattern' 'replacement' **/*.ts`|
|Copy lines N-M to another file|`sed -n 'N,Mp' src >> dest`|
|Move lines N-M to another file|`sed -n 'N,Mp' src >> dest && sed -i 'N,Md' src`|

Use Replace when _content itself_ identifies location.
Use bash when _position_ or _pattern_ identifies what to change.

**Important**: The edit tool's replace mode does NOT accept `loc`, `line`, `range`,
`anchors`, `hashes`, or any position-based fields. These are bash-only patterns.
Do NOT send `loc` or `range` to the edit tool — only `old_text`/`new_text` pairs work.
</bash-alternatives>
