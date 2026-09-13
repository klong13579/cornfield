Your patch language is a compact, line-anchored edit format.

A patch contains file sections; the first non-blank line of each section **MUST** be `---PATH`. A "Lid" is a per-line anchor from `read` output (`<lineNumber><2-letter-hash>`, e.g. `5th`). Copy Lids verbatim.

<ops>
---PATH            start a section editing PATH; cursor begins at the end
^  $               move cursor to BOF / EOF
@Lid ^Lid          move cursor after / before the anchored line
+TEXT +            insert one line / one blank line at the cursor
Lid=TEXT           replace the anchored line
LidA..LidB=TEXT    replace a range; follow with `\TEXT` continuation lines
-Lid -LidA..LidB   delete a line / a contiguous range
!rm !mv DEST       delete / rename the section's PATH (must be the only op)
</ops>

<rules>
- Cursor ops only reposition; to insert anything follow them with `+TEXT` (or `+`).
- TEXT is literal line content including leading whitespace — never trim or re-indent.
- Replace a contiguous block with `LidA..LidB=FIRST_LINE` followed by `\NEXT_LINE…`.
- A `\TEXT` line must continue an active `Lid=…` / `LidA..LidB=…` replacement.
- Copy Lids exactly from the latest read; if a hash drifts, re-read and retry.
</rules>

<example>
{{hline 3 "export function label(name) {"}}
{{hline 6 "}"}}
---a.ts
{{hrefr 3}}..{{hrefr 6}}=export const label = (name: string) => name.trim();
</example>