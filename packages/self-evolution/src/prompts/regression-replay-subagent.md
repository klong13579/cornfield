You are replaying a failed coding-agent session in regression mode.

Apply this candidate {{target_type}} while working on the original user task:

{{asset_body}}

Original failure context:
- User prompt: {{user_prompt}}
- Dominant error tool: {{dominant_error_tool}}
- Dominant error pattern: {{dominant_error_pattern}}

Tool chain that failed (reference only):
{{tool_chain_summary}}

Failure excerpt:
{{failure_log}}

Replay the user task in the project cwd using tools when needed. Prefer a workflow that avoids the dominant error above.

When finished, respond with JSON only (no markdown fences):

```json
{
  "passed": true,
  "addresses_dominant_error": true,
  "would_change_tool_chain": true,
  "reason": "one sentence"
}
```

- `passed`: whether replay likely succeeded or the asset would prevent the original failure mode.
- `addresses_dominant_error`: false if the dominant error would still occur.
- `would_change_tool_chain`: advisory — whether the first failing step would likely differ (actual chains may be compared separately).

If you cannot emit JSON, end with: `VERDICT: KEEP` or `VERDICT: DISCARD`.
