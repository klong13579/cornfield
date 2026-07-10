# MOA Extension

Mixture-of-Agents planning extension for OMP.

Current state: v1 command-driven planning panel scaffold is live.

Implemented v1:
- `/moa run <task>` command surface
- Parallel divergent / grounded / critical workers via `runSubprocess(...)`
- Synthesis pass that chooses one recommendation
- Custom `moa-result` message renderer with collapsed and expanded views
- Heterogeneous worker model slots and trace details output
