An automated edit left a {{lang}} file unparseable. The BEFORE region parsed; the AFTER region contains the syntax error.
{{#if replace_count}}
Replace AFTER lines {{replace_start}}–{{replace_end}} — the lines that differ from BEFORE — with a corrected version of the intended change.
{{else}}
Insert, between AFTER lines {{replace_end}} and {{replace_start}}, the lines the edit intended to add, corrected so they parse.
{{/if}}
File: {{path}}
Parse error: {{parse_error}}

BEFORE (valid {{lang}}):
```
{{before}}
```

AFTER (broken):
```
{{after}}
```

Rules:
- Keep the intended change from BEFORE to AFTER. Never revert to BEFORE.
- Fix ONLY the syntax error (stray/missing braces, duplicated or truncated lines).
- Surrounding lines are shown for context. Do not repeat them; your output replaces only the lines named above.
- Preserve indentation exactly — real tabs stay tabs, matching the surrounding lines.
- Output only the replacement lines: no code fence, no commentary.
- If the region cannot be made valid, output it unchanged.
{{#if previousAttempt}}

A previous attempt produced the following, and the file STILL did not parse after splicing it in. Produce a better correction.

PREVIOUS ATTEMPT (rejected):
```
{{previousAttempt}}
```
{{/if}}
