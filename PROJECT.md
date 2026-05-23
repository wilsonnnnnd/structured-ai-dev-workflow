# Project Brief

Human-owned project context for repo-context-kit.

Edit this file directly. repo-context-kit reads it during `scan` and summarizes it into `.aidw/AI_project.md`.

## Project Purpose

repo-context-kit is a repository runtime and context governance layer for AI coding agents. It gives Codex, Cursor, Claude, Trae, MCP clients, and other AI coding tools bounded repository context, task state, verification guidance, and gated action surfaces with explicit human approval boundaries.

It is not an autonomous agent. Humans remain responsible for installation, initialization, authorization, review, and final decisions.

## Tech Stack

- Language: JavaScript
- Runtime: Node.js
- Package manager: npm
- Module system: ESM
- Distribution: npm CLI package
- Main binaries: `rck`, `rck-mcp`

## Product / Domain Requirements

- Position MCP and runtime outputs as the primary agent-facing interface.
- Keep the CLI as a debugging interface, compatibility layer, manual fallback, and CI/preflight surface.
- Treat `.aidw/` as runtime/generated governance context.
- Treat `PROJECT.md` as the human-owned project brief.
- Keep protocol enforcement internal and compact output as the default external presentation.
- Preserve deterministic behavior for scan/check/doctor outputs.
- Preserve the runtime flow: AI agent -> repo-context-kit -> bounded repo context -> task runtime -> gated actions -> verification -> delivery report.

## Architecture Notes

- `bin/` contains CLI entry points and command handlers.
- `src/scan/` contains project detection, index generation, and generated context writers.
- `src/mcp/` exposes the MCP runtime interface.
- `template/` contains files copied by `rck init`.
- `test/cli.test.js` is the main regression suite.

## Development Requirements

- Prefer existing patterns over new abstractions.
- Keep changes minimal and backward-compatible unless a task explicitly requests a breaking migration.
- Update tests when CLI output, generated files, paths, or governance behavior changes.
- Run `npm test` before marking implementation complete.

## Safety / Boundaries

- Do not turn repo-context-kit into an autonomous agent.
- Do not add hidden execution, silent modification, or auto-fix behavior.
- Do not let signals such as doctor summaries, lessons, or budget decisions become actions without explicit gates.
- Keep MCP write/test/external side-effect capabilities opt-in and tiered.
- Do not make repo-context-kit a general shell executor, project manager UI, or replacement for human approval.

## AI Collaboration Preferences

- Preferred output style: compact by default.
- Expand only for confirmation, unresolved scope, test approval, high-risk operations, audit/debug/review, or unresolved risks.
- Keep final reports short: `Done`, `Tests`, `Note`.

## AI Runtime Project Design (PDGL) (v1)

<!-- PDGL:v1 START -->
### Project Identity
- Project Name: repo-context-kit
- One-line Summary: Repository runtime and context governance layer for AI coding agents.
- Target Users: AI coding tools, MCP clients, and developers using them in existing repositories.
- Non-goals: Autonomous agent behavior, hidden execution, silent source modification, general shell execution, project manager UI, replacement for human approval.

### Product / Runtime Intent
- What problem does this project solve?: It gives AI coding tools deterministic repo context, task runtime state, preflight checks, verification artifacts, and explicit gates before risky actions.
- What should AI optimize for?: Bounded context, review-first workflow, deterministic outputs, safety boundaries.
- What must AI avoid?: Auto-fixing, arbitrary shell execution, dependency installation, silent PR creation, broad unrelated refactors, approving gates on behalf of humans.
- What is intentionally out of scope?: Full IDE replacement, autonomous coding runtime, project management suite, general shell executor.

### Stack Decisions
- Language: JavaScript
- Framework: none
- Runtime: Node.js
- Package Manager: npm
- Database: none
- Deployment Environment: npm package / local CLI

### Runtime Constraints
- Files never touch: secrets, release credentials, generated indexes unless running scan
- Dangerous operations: hidden execution, external side effects, destructive git operations
- Deployment boundaries: npm package metadata and release config require explicit scope
- Network restrictions: no network use unless explicitly requested by a command/integration
- Command restrictions: tests only through explicit commands/gates; no arbitrary shell execution
- MCP write policy: tiered read-only / workflow-write / test-exec / external-side-effect

### Development Workflow
- Preferred workflow: AI agent -> repo-context-kit -> bounded repo context -> task runtime -> gated actions -> verification -> delivery report
- Testing strategy: npm test
- Definition of Done: scoped implementation, tests pass, generated context refreshed when relevant
- Required verification: run focused tests or full npm test for workflow/runtime changes
- Snapshot expectations: deterministic generated files and sorted indexes

### Architecture Notes
- Entry points: bin/cli.js, bin/mcp.js
- Directory conventions: bin for commands, src for implementation, template for initialized files, test for regression suite
- Config sources: package.json, template files, .aidw runtime context
- Critical modules: scan, runtime JSON, context/task views, MCP tools, gate/runtime policy
- Shared abstractions: stable sorting, bounded context, runtime gates, MCP capability tiers

### Bootstrap Guidance
- Recommended scaffold: existing repo init via `rck init`
- Manual setup steps: edit PROJECT.md, run scan, review doctor output
- Human-required setup: install, init, authorization, task scope confirmation, test approval, external side-effect approval, final decision
- Secrets/config setup expectations: never print or store secrets outside explicit auth helpers

### AI Collaboration Rules
- How AI should propose changes: compact by default, expand only for risk/confirmation/audit
- How AI should ask for clarification: ask focused boundary questions
- Preferred output structure: Done / Tests / Note
- What requires confirmation: scope changes, tests, writes, destructive actions, external side effects
<!-- PDGL:v1 END -->

## Stable Human Context (SHC) (v1)

<!-- SHC:v1 START -->
### Project Goal
- Provide a repository runtime and context governance layer for AI coding agents.

### Target Users
- AI coding tools, MCP clients, and developers or teams supervising them on real repositories.

### Non-goals
- Autonomous agent execution, silent fixes, arbitrary shell runtime, full IDE replacement, project manager UI, replacement for human approval.

### Stack Decisions
- Node.js ESM CLI distributed through npm.

### Runtime Constraints
- Keep writes explicit, bounded, and reviewable.

### Directory Conventions
- `bin/` for CLI, `src/` for logic, `template/` for initialized files, `.aidw/` for runtime/generated context.

### Config Sources
- `package.json`, `PROJECT.md`, `.aidw/AI_project.md`, template files.

### Testing Strategy
- `npm test`.

### Release Constraints
- Package metadata and release workflows require explicit task scope.

### Files Never Touch
- Secrets, credentials, unrelated release config, generated files outside scan.

### Deployment Boundaries
- npm package behavior and template output are user-facing compatibility surfaces.
<!-- SHC:v1 END -->
