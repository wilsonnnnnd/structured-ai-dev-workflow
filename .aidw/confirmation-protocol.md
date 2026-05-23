# AI Execution Confirmation Protocol (v1)

The protocol is still enforced internally. Default external output is compact.

## Flow

`INTAKE` -> `CLASSIFY` -> (`CLARIFY`)? -> `TASK_DRAFT` -> `TASK_CONFIRM` -> `IMPLEMENT` -> `TESTS_CONFIRM` -> (`RUN_TESTS`)? -> `AC_REPORT` -> `DONE`

## Hard Gates

1. Before `TASK_CONFIRM`: do not modify files and do not run commands.
2. Before `TESTS_CONFIRM`: do not run commands, including tests.
3. Review mode: review against Task/AC; if missing, draft minimal Task/AC first.
4. If information is insufficient, ask focused boundary questions and stop.

## Output Model

Human-facing labels and explanations should follow the user's dominant language. Machine-facing fields stay English and deterministic: commands, paths, schema names, protocol identifiers, MCP/tool names, runtime names, state names, enums, CLI flags, JSON keys, task ids, and gate field names.

### 1. Compact Mode (Default)

Use for normal read-only work, low-risk status, routine summaries, and final reports.

```md
State: REVIEW

Goal:
Code health review (read-only)

Scope:
* bin
* src
* test

Checks:
* architecture
* CLI behavior
* testing gaps

Tests:
Not run

Need:
Confirm / Adjust / Cancel
```

Rules:
- Do not render `## State`, protocol name, gating booleans, DoD, AC, background, or risk unless they are needed.
- Keep wording human-readable and short.
- Prefer `State`, `Goal`, `Scope`, `Checks`, `Changed`, `Tests`, `Risk`, `Need`, `Note`.
- For Chinese users, labels may be bilingual, such as `目标 Goal`, while values like `REVIEW`, `npm test`, and `confirmation-protocol/v1` remain English.
- Final reports usually use `Done`, `Tests`, `Note`.
- Default reports should use `Example`, not `Before/After`. Show comparison only for explicit verbose/audit/protocol/debug mode, explicit compare/diff requests, or major breaking UX changes.

### 2. Smart Protocol Mode (Hard Boundary)

Use when the user must approve a boundary: file writes, test/command execution, destructive action, external side effect, meaningful risk, unresolved scope, or scope change.

```md
Need confirmation

Files:
* src/task.js
* test/cli.test.js

Reason:
Source file modifications required.

Commands:
* npm test

Need:
Confirm / Adjust / Cancel
```

Rules:
- Show only the relevant gate, files, commands, reason, and meaningful risk.
- Do not render full state-machine metadata.
- Keep confirmation choices explicit.

### 3. Full Audit Mode (Explicit)

Use only when the user asks for audit/debug/protocol detail, or when a host integration requires fixed protocol blocks.

Triggers:
- `--audit`, `--protocol`, `--verbose`, debug mode, or explicit user request.
- Machine-readable protocol transcript requirements.

Only Full Audit Mode renders:
- `## State`
- `protocol: confirmation-protocol/v1`
- `state`, `mode`, `gating`, `next`
- full task draft including Background, Requirements, Risk, Test Strategy, AC, Test Command, DoD
- full acceptance report details

## Full Audit Format

```md
## State
- protocol: confirmation-protocol/v1
- state: <STATE>
- mode: <IMPLEMENT | REVIEW>
- gating:
  - allow_file_edits: <true|false>
  - allow_commands: <true|false>
- next: <NEXT_STATE>

## Output
<full protocol/audit content>

## Confirm
<options or None>
```

## State Machine

- `INTAKE`: receive request
- `CLASSIFY`: decide review vs implementation
- `CLARIFY`: ask boundary questions
- `TASK_DRAFT`: create task framing
- `TASK_CONFIRM`: wait for task approval
- `IMPLEMENT`: perform approved edits
- `TESTS_CONFIRM`: wait for test approval
- `RUN_TESTS`: run approved test command
- `AC_REPORT`: report against acceptance criteria
- `DONE`: finish

## Host Compatibility

- Hosts may render Smart Protocol `Need` lines as buttons.
- If buttons are unavailable, use fixed phrases: `Confirm`, `Adjust`, `Cancel`, `Run tests`, `Skip tests`.
- Codex and CLI tools must still honor gate state; compact presentation never weakens execution gates.
