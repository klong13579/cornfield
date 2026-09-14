Use `apply_patch` to edit files.

```
*** Begin Patch
[ one or more file sections ]
*** End Patch
```

Each section starts with one header:
- `*** Add File: <path>` — following lines are `+`-prefixed new content.
- `*** Delete File: <path>` — remove; nothing follows.
- `*** Update File: <path>` — hunks (optionally `*** Move to: <new path>` then hunks).

Each hunk starts with `@@`; hunk lines start with ` ` (context), `-` (remove), or `+` (add).

File references must be relative.
