Applies precise edits using full anchors from `read` output (example `160sr`). Read the file first and copy anchors exactly.

<parameters>
```ts
{ path: string, edits: [{ loc, content }] }
```
- `loc`: `"append"` | `"prepend"` | `{ append: "Lid" }` | `{ prepend: "Lid" }` | `{ range: { pos: "Lid", end: "Lid" } }`
- `content`: `string[]` (one element per line; `null` deletes the range).
</parameters>

<example>
```ts title="a.ts"
{{hline 1 "const flip = false;"}}
{{hline 2 "function run() {"}}
{{hline 3 "\treturn flip;"}}
{{hline 4 "}"}}
```
Replace line 2:
`{path:"a.ts",edits:[{loc:{range:{pos:{{href 2}},end:{{href 2}}}},content:["function run(force) {"]}]}`
</example>

<rules>
- `range` requires both `pos` and `end`; set `pos == end` to replace one line.
- `content` is literal — match indentation exactly and never reformat unrelated code.
</rules>