Query and update identity information.

<instruction>
- `whoRu`: Returns the current agent's operational identity — name, version, working directory, active model, provider, and session. Role and working style live in the system prompt.
- `whoisme`: Returns the user's declarative persona from `~/.omp/agent/user.md`. If absent, returns an empty template.
- `update_persona`: Updates one section of `~/.omp/agent/user.md`. Provide `section` (one of: basics, career, interests, preferences, interaction, thinking, constraints) and `data` (a partial object whose entries are merged into that section as markdown bullets).
</instruction>

<boundary>
`user.md` holds hand-authored, stable user identity (name, role, timezone, standing instructions) — the user-side analog of `mission.md`. Learned behavioral preferences discovered at runtime belong in `write_memory` (target: "user"), NOT here. Do not duplicate identity facts across both.
</boundary>

<output>
- whoRu: structured agent identity summary
- whoisme: full user.md content, or empty template if not yet created
- update_persona: confirmation with the section updated and fields added
</output>
