List all LLM models the current omp session can call.

<instruction>
- Returns a markdown table of `provider / model / context / reasoning` plus the current model.
- `query` is an optional case-insensitive substring filter applied to both `provider` and `model id`. Use it to narrow down before listing.
  - `/list_models` or `list_models()` with no args — list everything.
  - `list_models({query: "kimi"})` — only entries whose provider or id contains "kimi".
  - `list_models({query: "claude"})` — only Anthropic Claude entries.
- Output is a single markdown table; trim to first 50 rows if there are more (and tell the user there are more available).
- Use this when the user asks:
  - "有什么模型" / "可用模型" / "支持哪些模型" / "what models are available"
  - "列出 anthropic 的模型" / "show claude models" → pass `query: "anthropic"` or `query: "claude"`
  - "现在用的什么模型" → call once and look at the "current: …" line
- Do **not** use this to actually switch the model — that's `switch_model`'s job. `list_models` is read-only.
- If the table is empty, the user has no providers configured. Tell them to check `~/.omp/agent/config.yml` and `auth.db`.
</instruction>

<boundary>
- Read-only. Does not modify any state, does not consume any quota.
- The user-facing hint in the output must point to a slash command the user can actually type (`/model <provider>/<modelId>`), NOT the `switch_model` LLM tool. The user does not call LLM tools; only the agent does. Suggesting `switch_model({query: "…"})` to the user is a bug because there is no UI for them to invoke it. If you also want the LLM to be able to drive a switch from the same answer, do it in the LLM-side reply ("I'll switch to that for you") and call `switch_model` in your own tool call, not in the user-facing hint.
</boundary>

<output>
- success: markdown table with header row `| provider | model | context | reasoning |`, then a footer line `current: <provider>/<modelId>`.
- filtered to nothing: short text `没有匹配 "<query>" 的模型。` (no table).
- empty registry: short text `当前没有可用的模型。请检查 API key 配置。`.
</output>
