---
name: "evolution"
version: "2"
source: "evolution"
status: "active"
quality_score: 88
last_used_at: "+058353-03-11T12:31:46.000Z"
description: "Extracted from session"
---

# evolution

## Task Pattern
请查看一下刚才其他的会话 evolution 系统做了什么？

## Approach
Tool sequence: read → find → search → bash.

## Pitfalls
["Causal diagnosis: 1 read failure(s) of type \"other\". Review read arguments and preconditions carefully.","Cascade risk: read failure can trigger find failure. Root cause: read failure led to find remediation attempt.","Redundant search chains detected; prefer find or ast_grep for structural queries.","Slow tool loop: many calls with no successful modifications. Re-evaluate approach earlier.","Watch for errors when running similar tasks; 1 error(s) occurred.","Agent recovered from an error mid-task; verify outputs when retrying.","Causal diagnosis: 2 read failure(s) of type \"other\". Review read arguments and preconditions carefully.","Watch for errors when running similar tasks; 2 error(s) occurred."]
