<!--
  Prompt: test-run-completion (candidate 2 — summary + card pointer)
  Status:  production
  Use:     Rendered into a new user-message turn in the LLM's origin
           IM session, immediately after the cron task's card delivery
           completes. Rendered via `@oh-my-pi/pi-utils#prompt.render`
           with the context built by
           `CronLifecycle.#maybeNotifyOriginSession`.

  Variables (Handlebars):
    {{taskName}}        — task.name from jobs.json
    {{status}}          — "success" | "failure" | "timed_out"
    {{exitCode}}        — number | undefined
    {{durationSeconds}} — number, 1 decimal
    {{outputPreview}}   — first 200 chars of task output, or undefined
    {{error}}           — error message (failure/timed_out only), or undefined
    {{cardDelivered}}   — "true" | "false"
    {{recipientUserId}} — DingTalk user id the card went to

  Style notes:
    - candidate 2 is the default. Token cost ~150-300 per test-run.
    - Status / duration / preview give the LLM enough to react; the
      full output is in the card the user already saw.
    - The "是否需要..." line is the actionable handoff: the LLM can
      follow up, fix something, retry, change schedule, or stop.
    - When the card delivery itself failed and fell back to text,
      the prompt surfaces that so the LLM knows the user may not
      have seen the structured card.
-->

cron test-run `{{taskName}}` 已完成。

- 状态: **{{status}}**{{#if exitCode}} (exit {{exitCode}}){{/if}}
- 耗时: {{durationSeconds}}s
{{#if error}}
- 错误: {{error}}
{{/if}}
{{#if outputPreview}}
- 输出预览: `{{outputPreview}}`
{{/if}}

AI 卡片已{{#if cardDelivered}}发送{{else}}推送失败(已回退到文本){{/if}}到 {{recipientUserId}},含完整输出。

是否需要我针对结果做点什么?(例如:解读报告 / 修复发现的问题 / 重跑 / 改 schedule / 忽略)
