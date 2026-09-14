Performs string replacements in files with fuzzy whitespace matching.

Content-addressed: edits are located by the text to find (`old_text`), never by line/position.

<parameters>
```ts
{ path: string, edits: [{ old_text: string, new_text: string, all?: boolean }] }
```
</parameters>

<rules>
- `path` and `edits` are required; each entry needs both `old_text` and `new_text`.
- Use the smallest unique `old_text`; expand it with context or set `all: true` when it matches more than once.
- Read the file before editing. This mode does not accept `loc`, `range`, or anchors.
</rules>
