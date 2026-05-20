# Project Overview

## Tech Stack
- Language: TypeScript (primary), Rust (crates/pi-natives for performance), Bash scripts.
- Runtime: Bun (Bun.file(), Bun.write(), etc.)
- Tooling: Biome for linting/formatting, tsgo for type checking, Cargo + Clippy for Rust.

## Repository Structure
Monorepo with packages: coding-agent (334 .ts files), ai (94), self-evolution (33), tui (20), utils (23), stats (9), pi-gateway (10), swarm-extension (7), cognitive-coordination (nearby), etc.

## Configuration
Three-tier merging: Global (~/.omp/agent/config.yml) ← Project (.omp/settings.yml, .claude/, .codex/, .gemini/) ← Overrides. Schema defined in settings-schema.ts.

## Self-Evolution System
- Located at packages/self-evolution/, uses SQLite.
- V3 default: learnings + SessionLearner; legacy conventions behind `--no-self-evolution-v2-writer`.
- Project data: `<repo>/.omp/{memory,evolution,skills}`.

## AI Providers & Models
- Providers: bailian-coding-plan, alibaba-coding-plan, kimi-code, fireworks, opencode-go, etc.
- Common failures: 401 invalid/expired token, quota exhausted (429), connection issues.
- Model configuration via ALIBABA_API_KEY, KIMI_API_KEY environment variables.

## Development Practices
- Prefer `git merge main` over `git rebase` on feature branches with large divergences.
- Never use console.log/console.warn in coding-agent package – use logger from @oh-my-pi/pi-utils.
- Use ast_grep for structural code search; use grep only for plain-text lookup.

## Testing
- Test cases must include boundary conditions proactively.
- Run targeted tests: `bun test <path>`; avoid full `bun test` unless user asks.

## Common Pitfalls
- Expired tokens cause 401 and 'Working...' hang; kill tmux session to recover.
- BOM handling: stripBom before processing; preserve BOM on write when needed.
- Do not edit packages/ai/src/models.json by hand; regenerate via generate-models script.
