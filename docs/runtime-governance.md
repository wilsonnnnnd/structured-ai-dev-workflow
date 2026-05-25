# Runtime Governance

repo-context-kit governs AI coding agents. It does not act as one.

## Canonical Runtime

Agents should prefer:

1. MCP tools
2. `.aidw/runtime/*.json`
3. bounded context/workset commands

Markdown is a compatibility view and legacy fallback.

## Hard Gates

- MCP default is read-only.
- `workflow-write` requires explicit write enablement.
- `test-exec` requires test enablement plus confirmation gate state.
- `external-side-effect` requires explicit external-side-effect opt-in.
- Test execution remains allowlisted.
- Arbitrary shell execution is not supported.

## Signals

Doctor output, lessons, context-loop data, budget decisions, and risk summaries are signals. They may shape context or warnings. They must not trigger writes, tests, fixes, approvals, or external side effects without a hard gate.

`rck scan --auto` is a managed refresh mode for gated or MCP-driven flows. It may refresh generated runtime context after approval, but it is not the default human workflow and it does not bypass write gates.

## Compact-First Output

Runtime presentation uses three tiers:

1. Compact by default for normal read-only work, routine status, and final reports.
2. Smart Protocol for hard boundaries such as file writes, test/command execution, destructive or external side effects, meaningful risk, unresolved scope, or scope changes.
3. Full Audit only for explicit audit/debug/protocol requests or machine-readable protocol transcripts.

Compact presentation does not weaken gates. The same MCP tiers, confirmation state, and allowlisted test execution rules still apply.

Human-facing labels may follow the user's language, but machine-facing terms remain English: protocol ids, state names, JSON keys, MCP/tool names, paths, commands, task ids, enums, and CLI flags.

Default reports show the current behavior as `Example` rather than `Before/After`. Comparisons are reserved for explicit verbose/audit/protocol/debug requests, explicit compare/diff requests, or major breaking UX changes.

## Confirmation Attestation Direction

Current MCP confirmation tools require explicit `humanConfirmation` evidence. That is enough for lightweight host accountability today, but it is not cryptographic proof of a human click.

Future attestation is only worth adding if hosts need stronger audit trails. A minimal direction would be host-signed confirmation metadata over task id, action, timestamp, and prompt/session id. Avoid adding auth infrastructure, key management, or breaking protocol fields unless a concrete host integration requires it.

## Non-goals

repo-context-kit is not:

- an autonomous agent
- a general shell executor
- a project manager UI
- a replacement for human approval
- an auto-fixer
