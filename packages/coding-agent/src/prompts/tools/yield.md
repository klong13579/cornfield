Finish the task with structured JSON output.

Submit success as `result: { data: <your output> }`, failure as `result: { error: "message" }`. The `data`/`error` wrapper is required — your output does not go directly in `result`.

## Incremental sections

Report parts of a larger result as you finish them by naming their section in `type`:

`result: { type: ["findings"], data: <this part> }`
- An array `type` is **incremental**: the task keeps going. Repeat a label to accumulate a list under it, and submit one element per call — an array-typed section is judged by its element schema, not by the list shape.
- A label names a top-level property of this task's output schema, and the payload is checked against that property's schema. When the schema forbids extra properties (`additionalProperties: false`), a label it does not declare is refused.
- When the task is done, submit the terminal result: `result: { data: {…} }` with no `type`, or `result: { type: "result" }` to hand back your final message verbatim. A terminal result with `data` is used exactly as written and replaces the accumulated sections, so submit sections only when the final result is meant to contain them.
