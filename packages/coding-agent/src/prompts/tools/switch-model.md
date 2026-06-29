Switch the current LLM model for this omp session.

<instruction>
- `query` accepts any of:
  - `provider/modelId` (e.g. `anthropic/claude-opus-4-5`, `narwal-plan/minimax-m3`)
  - `provider:modelId` (colon form, equivalent)
  - bare `modelId` (e.g. `minimax-m3`, `kimi-k2.6`)
  - bare `provider` (e.g. `narwal-plan`)
  - fuzzy substring matched against provider, id, and display name (e.g. `minimax` → `narwal-plan/minimax-m3`, `claude-opus` → `anthropic/claude-opus-4-5`)
- Match priority: exact provider/id > exact id > normalized substring (strips `-`, `_`, `.`) > display name substring.
- If multiple models match, the first match wins. If the user clearly meant a specific one and you can read it, pass `provider/modelId` explicitly to avoid ambiguity.
- On success, the new model is applied immediately to the active session; the next assistant turn uses it. Confirm in chat using the exact format returned by the tool.
- On failure, the error message lists up to 10 candidate models — surface those to the user verbatim and ask them to pick.
- `role` controls persistence: `default` writes the choice back to settings (recommended for "切换模型到 X" / "switch to X"); `temporary` is a one-shot override that resets on next session start. Default is `default`.
</instruction>

<boundary>
- This tool only changes the model for the **current omp session**. It does not affect the gateway daemon, other agent accounts, or cron tasks.
- Slash command `/model <provider>/<id>` is a fast path handled by the gateway directly (bypasses the LLM); both paths end up at the same `session.setModel()`.
- Do **not** try to switch models by editing config files, sending RPC commands to the bridge, or reading/writing SQLite — use this tool.
- The bridge's `set_model` RPC command is the underlying transport; you should not invoke it directly. RPC is bridge→agent, not agent→bridge.
</boundary>

<output>
- success: `已切换模型：<provider>/<modelId>` (and display name if different from id)
- failure: error message listing available candidates
</output>
