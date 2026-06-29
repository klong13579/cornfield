{{SECTION_SEPARATOR "Workspace"}}

<workstation>
{{#list environment prefix="- " join="\n"}}{{label}}: {{value}}{{/list}}
</workstation>

{{#if contextFiles.length}}
<context>
Follow the context files below for all tasks:
{{#each contextFiles}}
<file path="{{path}}">
{{content}}
</file>
{{/each}}
</context>
{{/if}}

{{#if agentsMdSearch.files.length}}
<dir-context>
Some directories may have their own rules. Deeper rules override higher ones.
**MUST** read before making changes within:
{{#list agentsMdSearch.files join="\n"}}- {{this}}{{/list}}
</dir-context>
{{/if}}

{{#if appendPrompt}}
{{appendPrompt}}
{{/if}}
