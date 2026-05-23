# AGENTS.md

Single workflow entry point for AI coding tools in this repository.

## Required Reading

Primary sources:
- `PROJECT.md` — Human-owned project context
- `.aidw/AI_project.md` — Generated AI context (from scan)

Governance:
- `.aidw/rules-canonical.md` — All rules and execution discipline (canonical source)
- `.aidw/workflow.md` — AI-assisted development workflow
- `.aidw/confirmation-protocol.md` — Click-to-confirm execution protocol
- `.aidw/safety.md` — Protected areas and change safety rules
- `.aidw/system-overview.md` — Available context sources
- `.aidw/task-entry.md` — Task request template

Current task:
- `task/T-*.md` file when one exists (for UI context on frontend tasks: see `## UI Design Context` in `.aidw/AI_project.md`)

## Workflow Role

Classify requests into:
1. **Clarify** (vague) → ask focused boundary questions, then stop
2. **Implement** (clear) → draft task → confirm → implement → verify
3. **Review** → refine against Task/AC

## Execution Model

1. Understand project: read PROJECT.md + .aidw/AI_project.md
2. Read `.aidw/rules-canonical.md` for all rules (single source of truth)
3. For frontend tasks: read UI Design Context
4. Draft task (Goal, Background, Scope, Requirements, Acceptance Criteria, Test Command, DoD)
5. Confirm before implementation
6. Verify against acceptance criteria after implementation

**Reference:** `.aidw/rules-canonical.md` for AI behavior constraints, prioritization order, and discipline.

---

## Output Presentation

Use compact output by default. Keep normal read-only reviews and routine status updates short: `State`, `Goal`, `Scope`, `Checks`, `Tests`, `Need`, `Done`, `Note`.

Use Smart Protocol output when a hard boundary needs confirmation: file writes, command/test execution, destructive or external side effects, meaningful risk, unresolved scope, or scope changes. Show only the relevant files, commands, reason, risk, and confirmation choices.

Use Full Audit output only when explicitly requested (`--audit`, `--protocol`, `--verbose`, debug/audit request, or machine-readable protocol transcript). Full Audit may render `## State`, protocol metadata, gating booleans, AC, DoD, and full acceptance detail.

For mixed-language output, human-facing labels and explanations follow the user's dominant language; machine-facing terms remain English (`State`, `REVIEW`, commands, paths, protocol ids, JSON keys, MCP/tool names, task ids, CLI flags).

Do not include `Before/After` in normal reports. Prefer a single `Example` of current behavior; compare only for explicit verbose/audit/protocol/debug requests, explicit compare/diff requests, or major breaking UX changes.
