Creates or overwrites file at specified path.

<conditions>
- Creating new files explicitly required by task
- Replacing entire file contents when editing would be more complex
- Supports `.tar`, `.tar.gz`, `.tgz`, and `.zip` archive entries via `archive.ext:path/inside/archive`
- Supports SQLite row operations via `db.sqlite:table` (insert), `db.sqlite:table:key` (update with JSON content, delete with empty content)
- Content is the file text as a string; `.json`, `.ipynb`, `.webmanifest` and comment-free `.jsonc`/`.json5` targets also accept an object or array, serialized with the target's existing indentation (tab when new)
- Archive entries, SQLite rows and `.jsonl` take a string only — JSON-encode it yourself. A commented `.jsonc`/`.json5` is never rewritten from an object: that would delete the comments
</conditions>

<critical>
- You **SHOULD** use Edit tool for modifying existing files (more precise, preserves formatting)
- You **MUST NOT** create documentation files (*.md, README) unless explicitly requested
- You **MUST NOT** use emojis unless requested
</critical>
