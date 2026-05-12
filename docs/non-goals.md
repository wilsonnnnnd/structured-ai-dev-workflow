# Non-goals and Automation Boundaries

repo-context-kit is a repository runtime and context governance layer for AI coding agents, not an autonomous agent.

This project intentionally does not automate high-risk work just because it can detect, describe, or plan it.

## Do Not Automate

repo-context-kit must not automatically:

- Modify application or business source code.
- Install, upgrade, or remove dependencies.
- Run arbitrary shell commands.
- Approve task or test gates on behalf of a user.
- Commit, push, merge, or create pull requests.
- Convert lessons, budget decisions, doctor summaries, or context-loop signals into writes.
- Read or write files outside the repository root.
- Expand doctor into a framework lint suite.
- Replace human approval, review, or final decision making.
- Act as a general project manager UI.

## Allowed Automation

Allowed automation must stay bounded and review-first:

- Read-only context loading and summaries for AI tools and MCP clients.
- Deterministic preflight checks.
- Managed workflow-file writes after explicit confirmation.
- Allowlisted test execution through the confirmation gate.
- External side effects only through explicit highest-risk confirmation.

## Design Rule

Signals may influence warnings, context size, risk summaries, and suggested next steps. Signals must not directly trigger writes, command execution, fixes, gate approval, or external side effects.
