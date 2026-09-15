Replaces text in files written as raw blocks: what to find, what to put in its place. No line anchors, no context hashing.

<parameters>
```
<SM:EDIT path="src/foo.ts">
<SM:FIND>
const total = compute(a, b);
</SM:FIND>
<SM:PUT>
const total = compute(a, b, { strict: true });
</SM:PUT>
</SM:EDIT>
```
</parameters>

<rules>
- `input` is required and must hold at least one `<SM:EDIT>` block. Each block needs a `path` attribute.
- A block carries one or more `<SM:FIND>`/`<SM:PUT>` pairs, applied in the order written. A later pair sees the file as the earlier one left it.
- `<SM:FIND>` must match the file exactly once; widen it with surrounding lines when the text repeats. An empty `<SM:PUT>` deletes the matched text.
- The single newline directly after `<SM:FIND>`/`<SM:PUT>` and directly before the closing tag is formatting and is dropped. Everything else — indentation included — is content.
- Read the file first. This mode has no anchors, so an inexact find is an error, not a silent miss.
- Text outside `<SM:EDIT>` blocks is ignored. A payload that lands in your reply as plain text is recovered and executed as an edit, but send it in the tool call.
</rules>
