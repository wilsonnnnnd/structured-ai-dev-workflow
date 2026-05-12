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

## Compact Output

CLI output should stay compact. Full protocol rendering is only for confirmations, tests, destructive/write/external side effects, unresolved scope, audit/debug, or machine-readable integrations.

## Non-goals

repo-context-kit is not:

- an autonomous agent
- a general shell executor
- a project manager UI
- a replacement for human approval
- an auto-fixer
