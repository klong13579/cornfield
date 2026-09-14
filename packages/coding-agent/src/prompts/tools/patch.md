Patches files with diff hunks. Primary tool for existing-file edits.

<parameters>
```ts
{ path: string, edits: [{ op: "update" | "create" | "delete", diff?: string, rename?: string }] }
```
- `op: "update"` — hunks applied to existing content.
- `op: "create"` — `diff` is the full file content, no prefixes.
- `op: "delete"` — remove the file.
- `rename` moves the file (with `op: "update"`).
</parameters>

<rules>
- Read the file first; copy anchors and context lines verbatim.
- Each hunk begins with `@@` (optional anchor) and contains ` ` (context), `-` (remove), `+` (add) lines.
- Do not mix fields from other modes (`old_text`/`new_text`/`loc`/`content` are invalid here).
</rules>
