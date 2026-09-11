<critical>
Plan approved. You **MUST** execute it now.
</critical>

Finalized plan artifact: `{{finalPlanFilePath}}`

## Plan

{{planContent}}

<instruction>
You **MUST** execute this plan step by step from `{{finalPlanFilePath}}`. You have full tool access.
You **MUST** verify each step before proceeding to the next.
{{#has tools "todo"}}
Before execution, you **MUST** initialize todo tracking for this plan with `todo`.
After each completed step, you **MUST** immediately update `todo` so progress stays visible.
If a `todo` call fails, you **MUST** fix the todo payload and retry before continuing silently.
{{/has}}
</instruction>

<critical>
You **MUST** keep going until complete. This matters.
</critical>
