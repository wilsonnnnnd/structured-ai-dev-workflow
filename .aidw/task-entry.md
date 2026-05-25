Load:
- AGENTS.md
- PROJECT.md
- .aidw/AI_project.md
- .aidw/rules-canonical.md (canonical source for all rules)
- .aidw/workflow.md
- .aidw/safety.md
- .aidw/system-overview.md
- .aidw/confirmation-protocol.md
- current task file, when one exists

# Task

My request:
[WRITE YOUR REQUIREMENT HERE]

# Instructions

Use `AGENTS.md` as the source of truth. See `.aidw/rules-canonical.md` for all rules and constraints.

- Decide mode:
  - REVIEW: user asks to review or provides an existing prompt/plan/task/implementation.
  - IMPLEMENT: otherwise.
- If vague: ask only implementation-boundary questions, then stop.
- If clear: draft a compact task summary (Goal, Scope, Checks/Requirements, Tests, Need), request confirmation, then implement and verify. Keep full Background/AC/DoD for audit mode or when needed.
- Prefer running tests via `rck gate run-test <taskId>` when available.
- For REVIEW without Task/AC: draft minimal Task/AC first, then review against it.

# Constraints

Follow `.aidw/rules-canonical.md` for:
- Reuse first and backward compatibility
- Logic first implementation order
- Scope control
- UI discipline (for frontend tasks)
- Code quality and safety
- Protected areas (secrets, deployment, release workflows)

For frontend tasks:
- Read UI Design Context in .aidw/AI_project.md first
- Inspect existing components, tokens, and theme directories
- Reuse before writing new UI code

# Output Rules

- Do not write code unless the user explicitly requests implementation and confirms the task draft.
- Do not skip clarification for vague requests.
- Compact output is default; use Smart Protocol only for hard boundaries and Full Audit only when explicitly requested.
- Default status: `State: ...`, `Goal: ...`, `Scope: ...`, `Checks: ...`, `Tests: ...`, `Need: ...`
- Default final report: `Done: ...`, `Tests: ...`, `Note: ...`
- Prefer `Example` of current behavior over `Before/After`; only compare when explicitly requested or in audit/debug mode.
- Reference rules by name/section, not full text (e.g., "per Reuse First rule")
