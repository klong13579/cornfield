Save durable information to persistent memory that survives across sessions. Memory is injected into future turns, so keep it compact and focused on facts that will still matter later.

WHEN TO SAVE (do this proactively, don't wait to be asked):
- User corrects you or says 'remember this' / 'don't do that again'
- User says '记住', '请记住', '以后注意', '以后记住'
- User says '以后都用 X', '以后用 X 来处理', '以后注意要 X' — pattern match, exact wording not required
- User shares a preference, habit, or personal detail (name, role, timezone, coding style)
- You discover something about the environment (OS, installed tools, project structure)
- You learn a convention, API quirk, or workflow specific to this user's setup
- You identify a stable fact that will be useful again in future sessions

If you recognized something in retrospect that should have been saved, save it immediately without being asked.

PRIORITY: User preferences and corrections > environment facts > procedural knowledge. The most valuable memory prevents the user from having to repeat themselves.

Do NOT save task progress, session outcomes, completed-work logs, or temporary TODO state to memory; use session_search to recall those from past transcripts.
If you've discovered a new way to do something, solved a problem that could be necessary later, save it as a skill with the skill tool.

TWO TARGETS:
- 'user': who the user is -- name, role, preferences, communication style, pet peeves
- 'memory': your notes -- environment facts, project conventions, tool quirks, lessons learned

WRITING STYLE:
- 'preference' entries should be written as IMPERATIVE RULES. Use MUST/NEVER/ALWAYS/IF...THEN.
  Good: "MUST use dws CLI for all DingTalk URLs. NEVER use read tool on alidocs.dingtalk.com."
  Bad: "The user likes to use dws for DingTalk."
- 'procedure' entries should be written as numbered steps or IF-THEN workflows.
  Good: "IF url contains alidocs.dingtalk.com THEN 1) run dws doc info, 2) check doc type, 3) use dws doc read or dws aitable accordingly."
  Bad: "There is a way to access DingTalk docs using dws."
- 'fact' entries should be concise statements.
  Good: "User: 彭梦龙, GM of 云鲸扫地机事业部."
  Bad: "I learned that the user is someone named 彭梦龙."

ACTIONS: add (new entry), replace (update existing -- old_text identifies it), remove (delete -- old_text identifies it).

SKIP: trivial/obvious info, things easily re-discovered, raw data dumps, and temporary task state.
