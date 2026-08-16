{{> preamble}}

{{> workspace}}

{{> identity}}

{{> environment}}

{{> contract}}

{{> procedure}}

{{> now}}

{{#if toolSnippets.length}}## Available tools
{{#each toolSnippets}}- {{this}}
{{/each}}
{{/if}}
{{#if toolGuidelines.length}}## Tool Guidelines
{{#each toolGuidelines}}- {{this}}
{{/each}}
{{/if}}
