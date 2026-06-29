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
  - "现在用的什么模型" → call once and look at the "current: ..." line
- Do **not** use this to actually switch the model — that's `switch_model`'s job. `list_models` is read-only.
- If the table is empty, the user has no providers configured. Tell them to check `~/.omp/agent/config.yml` and `auth.db`.
</instruction>

<boundary>
- Read-only. Does not modify any state, does not consume any quota.
- Slash command `/models` / `/list-models` is a fast path handled by the gateway directly (bypasses the LLM); both paths show the same data.
- Does not include models the session cannot call (e.g. providers with no API key configured).
</boundary>

<output>
- success: markdown table with header row `| provider | model | context | reasoning |`, then a footer line `current: <provider>/<modelId>`.
- filtered to nothing: short text `没有匹配 "<query>" 的模型。` (no table).
- empty registry: short text `当前没有可用的模型。请检查 API key 配置。`.
</output>
