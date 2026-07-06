---
name: project-todo
description: >-
  Maintain the project task board at <projectRoot>/TODO.md. Use when the user
  adds (增加/添加/记录/新增/加 todo, add a todo, add todo, new todo, track this),
  marks done (完成待办, 这条做完了, done, finish), or removes (删掉待办, 移除待办,
  remove todo). Skip if the user is just reading or brainstorming.
---

# Project Task Board

> **Task board** — the project-level ledger, anchored at `<projectRoot>/TODO.md`
> and rendered in the TUI's top panel. Human-/agent-curated; never written
> by automation.

## When to load

Three branches, all targeting the same file:

| Branch     | Triggers                                                                                  | Operation                                                          |
| ---------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Add        | 增加/添加/记录/新增/加 todo, add a todo, add todo, new todo, `todo: <text>`, track this    | Append `- [ ] <text>` under `## 待办`                              |
| Mark done  | 完成待办, 这条做完了, done, finish todo `<text>`                                           | Flip `- [ ]` → `- [x]`; move to `## 已完成` if that section exists |
| Remove     | 删掉待办, 移除待办, remove todo                                                           | Delete the matching line                                           |

If the intent is ambiguous (e.g. "处理一下" with no clear direction), ask
which branch before writing.

## Path resolution

`<projectRoot>` is the **git toplevel** of the agent's `cwd`:

```bash
git rev-parse --show-toplevel
```

If the repo is not under git, walk up from `cwd` until a `TODO.md` is found,
or stop at `$HOME` / filesystem root (max 5 levels). Otherwise the project
root is `cwd` and the file is `<cwd>/TODO.md`.

The agent's `cwd` is the monorepo subpackage (e.g. `packages/coding-agent`
under `bun dev`), so the **git toplevel** rule is what anchors TODO.md to
the real project root, not the subpackage.

**Scope guard**: the target file is exactly `<projectRoot>/TODO.md`. Do not
search, read, or edit any other `TODO.md` — agent templates, build assets
(`src/skeleton/assets/TODO.md`), per-agent `agentDir` task boards, or files
in unrelated repositories are out of scope. If the matching text is not in
the project file, the operation no-ops — do not fall back to a broader
search to "find" a match elsewhere.

## File format

```markdown
# TODO

> Current task state. The agent updates this file as work progresses; an
> empty TODO is a valid state.

## 待办

- [ ] Open item
- [ ] Another open item

## 已完成

- [x] Completed item
```

- Open items live under `## 待办`, completed under `## 已完成`.
- Other H2 sections are preserved untouched.
- If the file is missing, create it from the skeleton (omit `## 已完成` if
  no completed items yet).

## Tool discipline

- Always use the `edit` tool — never `write` the whole file. Every edit
  preserves existing content byte-for-byte.
- **Idempotency is the leading test**:
  - Add: if the line already exists verbatim under `## 待办`, no-op.
  - Mark done: if the line is already `- [x]`, no-op.
  - Remove: if the line is missing, no-op.
  - In each case, **tell the user the current state** instead of silently
    doing nothing.
- Never reorder, deduplicate, or "tidy" existing items without being asked.

## Operations

### Add

1. Read `<projectRoot>/TODO.md` with `read`.
2. If missing, create the skeleton.
3. Insert `- [ ] <text>` immediately under the `## 待办` heading. If the
   heading is missing, insert `## 待办` followed by the new line at the top
   of the body.

### Mark done

1. Find the matching `- [ ] <text>` line under `## 待办`.
2. Flip to `- [x] <text>`. If a `## 已完成` section exists, move the line
   there (just under the heading); otherwise leave it in place.

### Remove

1. Find the matching line in either section.
2. Delete the line (and its trailing newline).

## Standing rules

- **TUI refresh**: the panel reads TODO.md once at startup. After editing
  mid-session, the user must restart `omp` to see the panel refresh — tell
  the user, do not pretend the panel updated live.

## Common misuse

- Don't move a line to `## 已完成` from a "mark done" branch unless that
  section already exists; otherwise the line stays where it was.
- Don't ask "where is the project root?" when `git rev-parse --show-toplevel`
  would answer it.
- Don't broaden the search when a todo isn't found in the project file —
  the item simply isn't tracked here; tell the user and stop.
