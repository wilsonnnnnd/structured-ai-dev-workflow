# Runtime Governance

repo-context-kit is a bounded, review-first workflow layer for AI-assisted coding. It prepares context, keeps work explicit, and enforces hard safety gates before any controlled execution.

This document clarifies:

- What each layer is responsible for
- Which mechanisms are hard gates vs signals
- What the default workflow is
- What repo-context-kit does not do (by design)

## Default Workflow (Recommended)

Use this as the default, human-controlled journey:

1. `repo-context-kit init`
2. `repo-context-kit scan`
3. `repo-context-kit bootstrap doctor`
4. `repo-context-kit task prompt <taskId>`
5. Implement changes with human control (manual edits, review, no autonomous execution)
6. `repo-context-kit task checklist <taskId>`
7. `repo-context-kit task pr <taskId>`
8. `repo-context-kit scan --check`
9. `repo-context-kit bootstrap doctor --check`

## Preflight Bundle (CI / Local)

The recommended, read-only preflight bundle is:

```bash
repo-context-kit scan --check
repo-context-kit bootstrap doctor --check
```

This bundle:

- Does not install dependencies
- no automatic install
- Does not write files
- Does not apply fixes
- no arbitrary shell
- Only checks and exits with a status code

## Layers and Responsibilities

### init

Initializes the workflow scaffold (files under `.aidw/`, `task/`, and other managed workflow paths). Writes are conservative by default and avoid overwriting existing files unless explicitly forced.

### scan

Builds the repository map and indexes under `.aidw/` for bounded context generation.

- `scan` refreshes generated context artifacts.
- `scan --check` is a read-only CI-style check: it verifies that required generated context artifacts are present and up to date.

### bootstrap doctor

Read-only preflight risk gate. It analyzes project shape and dependency compatibility signals and reports risks with severities.

- `bootstrap doctor` prints a human-readable preflight report.
- `bootstrap doctor --check` is a deterministic gate with exit codes based on risk severity and policy flags (e.g., `--strict`, `--max-risks`).

Doctor is not an auto-fixer. It does not install, does not write, and does not silently apply changes.

### task workflow

Task-level outputs that keep work reviewable:

- `task prompt` produces an implementation prompt with bounded context references.
- `task checklist` produces a verification checklist.
- `task pr` produces PR/review-ready text and scoped cleanup steps.

Task outputs are designed to be bounded and avoid dumping full indexes.

### confirmation protocol

Explicit human confirmation points that gate controlled actions. It provides traceable approval state (task confirmation, tests confirmation) that other components must respect.

### gate / run-test

Controlled test execution gate. It requires explicit confirmation and a token, and it enforces a strict allowlist of supported test commands.

This is the only supported command execution surface, and it is intentionally narrow.

### lessons / context-loop / budget

Signals that influence how much context is produced and what guidance is surfaced. These are not ultimate gates.

- lessons: curated checks and guidance patterns
- context-loop: recent execution outcomes and signals
- budget: bounded context level selection (off/auto/full)

### MCP

A runtime interface for AI tools. It is read-only by default.

- Write and test tools require explicit opt-in flags.
- Even with opt-in, tools are expected to respect hard gates (confirmation state, allowlists, bounded paths).

## Hard Gates vs Signals

### Hard gates

These mechanisms can block progress with exit codes or explicit refusal:

- Confirmation protocol (task/test confirmations)
- Bootstrap apply boundary (whitelisted ops and paths only; requires explicit confirmation)
- gate/run-test allowlist (no arbitrary shell; strict command set)
- `scan --check`
- `bootstrap doctor --check`

### Signals (not ultimate gates)

These mechanisms are guidance and context shaping inputs:

- lessons
- context-loop
- budget decision
- doctor summary included in task outputs

## Determinism Notes (Freshness)

`scan --check` and related freshness checks may use filesystem modification times (mtime) for some decisions. This is bounded and practical, but it can differ across machines or CI runners (e.g., archive extraction, checkout strategies, file timestamp normalization).

Future improvements may move more freshness checks to content hashes, but the current design prioritizes bounded runtime cost and minimal architecture churn.

## Non-goals (By Design)

repo-context-kit does not:

- Automatically install dependencies
- Perform automatic git operations (commit/push/PR creation)
- Execute arbitrary shell commands
- Read or write files outside repoRoot
- Autonomously modify business code
- Act as an autonomous fixer
