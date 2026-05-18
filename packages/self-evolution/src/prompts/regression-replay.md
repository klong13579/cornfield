You judge whether a candidate evolution asset would likely prevent the failure shown in a regression fixture.

Return JSON only (no markdown fences):

```json
{
  "passed": true,
  "addresses_dominant_error": true,
  "would_change_tool_chain": true,
  "reason": "one sentence"
}
```

- `passed: true` when applying the asset would plausibly change tool choice or workflow to avoid the dominant error.
- `addresses_dominant_error: false` forces discard even if passed would otherwise be true.
- `would_change_tool_chain` should be true only if the first failing tool step would likely differ.
- `passed: false` when the asset is unrelated, too vague, or would not address the failure mode.
- Prefer precision over generosity; weak thematic overlap is not enough.
