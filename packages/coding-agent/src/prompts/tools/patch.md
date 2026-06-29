Patches files given diff hunks. Primary tool for existing-file edits.

<instruction>
**Hunk Headers:**
- `@@` — bare header when context lines unique
- `@@ $ANCHOR` — anchor copied verbatim from file (full line or unique substring)
**Anchor Selection:**
1. Otherwise choose highly specific anchor copied from file:
   - full function signature
   - class declaration
   - unique string literal/error message
   - config key with uncommon name
2. On "Found multiple matches": add context lines, use multiple hunks with separate anchors, or use longer anchor substring
**Context Lines:**
Use enough ` `-prefixed lines to make match unique (usually 2–8)
When editing structured blocks (nested braces, tags, indented regions), include opening and closing lines so edit stays inside block
</instruction>

dd|<parameters>
mq|```ts
tz|// Input is { path: string, edits: Entry[] }. `path` is required and applies to every entry.
rg|// CRITICAL: `edits` is an ARRAY OF OBJECTS. Each element must be a plain object { … }.
nd|// Do NOT put strings, numbers, or other types in the edits array.
22rg|type Entry =
rt|   // Diff is one or more hunks for the top-level path.
lc|   // - Each hunk begins with "@@" (anchor optional).
ff|   // - Each hunk body only has lines starting with ' ' | '+' | '-'.
uc|   // - Each hunk includes at least one change (+ or -).
ix|   | { op: "update", diff: string }
xp|   // Diff is full file content, no prefixes.
qi|   | { op: "create", diff: string }
of|   // No diff for delete.
ro|   | { op: "delete" }
mi|   // New path for update+move from the top-level path.
nj|   | { op: "update", rename: string, diff: string }
hf|```
vv|
nd|**CRITICAL CONSTRAINTS:**
nd|1. ONLY the fields listed above (`path`, `edits`, `op`, `diff`, `rename`) are allowed.
nd|2. Do NOT add any extra fields like `old_text`, `new_text`, `loc`, `content`, or internal markers.
nd|3. Do NOT mix fields from other edit modes (e.g., `old_text`/`new_text` belong to replace mode, not patch).
nd|4. If validation fails with "must NOT have additional properties", remove all unknown fields.
nd|5. `edits` must be an array of objects. Never strings, numbers, or other types.

<output>
Returns success/failure; on failure, error message indicates:
- "Found multiple matches" — anchor/context not unique enough
- "No match found" — context lines don't exist in file (wrong content or stale read)
- Syntax errors in diff format
</output>

qw|<critical>
mi|- You **MUST** read the target file before editing
ph|- You **MUST** copy anchors and context lines verbatim (including whitespace)
tb|- You **MUST NOT** use anchors as comments (no line numbers, location labels, placeholders like `@@ @@`)
lw|- You **MUST NOT** place new lines outside the intended block
tl|- If edit fails or breaks structure, you **MUST** re-read the file and produce a new patch from current content — you **MUST NOT** retry the same diff
sk|- **NEVER** use edit to fix indentation, whitespace, or reformat code. Formatting is a single command run once at the end (`bun fmt`, `cargo fmt`, `prettier —write`, etc.)—not N individual edits. If you see inconsistent indentation after an edit, leave it; the formatter will fix all of it in one pass.
nd|- The `edits` array must contain **only objects**. Never strings, numbers, or other types.
nd|- Only use fields declared in the schema: `path`, `edits`, `op`, `diff`, `rename`. Do NOT add `old_text`, `new_text`, `loc`, `content`, or other fields.
nd|- If you see "must NOT have additional properties" error, remove all extra fields from the JSON.
nd|- This is **patch mode** (diff hunks). Do NOT use `old_text`/`new_text` — those belong to replace mode.
iu|</critical>

hf|<examples>
bt|# Create
bw|`edit {"path":"hello.txt","edits":[{"op":"create","diff":"Hello\n"}]}`
gd|# Update
ph|`edit {"path":"src/app.py","edits":[{"op":"update","diff":"@@ def greet():\n def greet():\n-print('Hi')\n+print('Hello')\n"}]}`
wl|# Rename
qa|`edit {"path":"src/app.py","edits":[{"op":"update","rename":"src/main.py","diff":"@@\n …\n"}]}`
zx|# Delete
sq|`edit {"path":"obsolete.txt","edits":[{"op":"delete"}]}`
ik|# Multiple entries
qa|All entries in one call apply to the top-level `path`; use separate calls for different files.
nd|# WRONG — edits contains a string instead of object
nd|`edit {"path":"src/app.py","edits":["this is wrong"]}`  ❌
nd|# WRONG — extra field 'old_text' (belongs to replace mode, not patch)
nd|`edit {"path":"src/app.py","edits":[{"op":"update","old_text":"foo","new_text":"bar"}]}`  ❌
nd|# WRONG — extra unknown field
nd|`edit {"path":"src/app.py","edits":[{"op":"update","diff":"…","extraField":123}]}`  ❌
nd|# CORRECT — patch mode uses diff hunks only
nd|`edit {"path":"src/app.py","edits":[{"op":"update","diff":"@@\n-old\n+new\n"}]}`  ✅
hb|</examples>

<avoid>
- Generic anchors: `import`, `export`, `describe`, `function`, `const`
- Repeating same addition in multiple hunks (duplicate blocks)
- Full-file overwrites for minor changes (acceptable for major restructures or short files)
</avoid>
