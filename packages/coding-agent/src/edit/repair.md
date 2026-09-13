Repair a broken edit. A file ceased to parse after an edit; fix ONLY the changed region so it is valid {{language}} again.

File: {{path}}
Parse error: {{parse_error}}
Changed region: lines {{region_start}}–{{region_end}} (1-based)

Rules:
- Return ONLY the corrected region text — no code fences, no commentary.
- Preserve the edit's intent where possible; never revert the change outright.
- Preserve indentation exactly (real tabs stay tabs).
- If the region cannot be made valid, return the region unchanged.