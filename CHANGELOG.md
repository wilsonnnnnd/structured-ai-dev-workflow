# repo-context-kit

## 1.8.4

### Patch Changes

- f19ec0f: chore: update workflow documentation, enhance CLI help, and refine governance checks

## 1.8.3

### Patch Changes

- 4d54421: chore: update generated timestamps and add legacy CLI entries

  - Updated generatedAt timestamps in context.json, execution.json, task.json, and verification.json to "2026-05-24T15:27:07.060Z".
  - Added legacy CLI entries for `legacy-cli.js` and `legacy-mcp.js` in context.json.
  - Updated indexedFiles count from 65 to 67 in context.json.
  - Modified system-overview.md to reflect new command names from `repo-context-kit` to `rck`.
  - Refactored cli.js and mcp.js to remove unused imports and added utility functions for path resolution.
  - Updated package version from 1.8.1 to 1.8.2 in package-lock.json.

- Updated dependencies [4d54421]
  - repo-context-kit@1.8.3

## 1.8.2

### Patch Changes

- 4c135ad: Add --update-agent-files option to init command for agent file management

## 1.8.1

### Patch Changes

- fb86ab4: Rename commands and binaries from 'repo-context-kit' to 'rck' for consistency

## 1.8.0

### Minor Changes

- 82f0df3: Reduce default output to save on token usage.

## 1.7.3

### Patch Changes

- d2f98fc: remove dead code and improve context relevance scoring

## 1.7.2

### Patch Changes

- dac449c: This update focused on runtime transport hardening, deterministic JSON contracts, and token efficiency improvements for AI coding workflows. Runtime-facing CLI and MCP outputs now share the same centralized budget enforcement, helping reduce long-term token growth and keeping context payloads compact, stable, and predictable. Oversize payload handling was also improved to preserve schema shape under heavy truncation, while maintaining deterministic ordering and JSON-first transport behavior across runtime surfaces.

## 1.7.1

### Patch Changes

- 68ffe40: Introduce a compact, explainable Context Runtime layer for AI-assisted software engineering workflows.

  This release focuses on:

  - context compression
  - canonical references
  - runtime observability
  - relevance-aware injection
  - volatility-aware context handling
  - deterministic governance

  New runtime observability commands:

  - `context trace`
  - `context budget`
  - `metrics`

  The goal is not to generate more context, but to generate higher-density, lower-noise, explainable context for AI coding systems.

## 1.7.0

### Minor Changes

- Transition to a slim runtime-core architecture centered on runtime/v1 JSON (`task.json`, `context.json`, `execution.json`, `verification.json`) as the active source of truth.
- Keep Markdown outputs as readable views instead of runtime authority.
- Remove non-core CLI surfaces and deprecated debug/runtime helper command paths; retain a compact deterministic core (`init`, `scan`, `context`, `task`, `gate`, `check`, `metrics`).
- Align package surface with runtime-first operation and MCP-first usage direction.
- Reduce published package surface and tarball footprint after internal/runtime-chain removals.
- Refresh generated indexes and metadata after hard deletion to preserve deterministic scan outputs.

## 1.6.2

### Patch Changes

- Introduce a compact, explainable Context Runtime layer for AI-assisted software engineering workflows.

  - context compression
  - canonical references
  - runtime observability
  - relevance-aware injection
  - volatility-aware context handling
  - deterministic governance

  New runtime observability commands:

  - `context trace`
  - `context budget`
  - `metrics`

  The goal is not to generate more context, but to generate higher-density, lower-noise, explainable context for AI coding systems.

## 1.6.1

### Patch Changes

- 7c4b0d7: few update
- 3875fac: few update

## 1.6.0

### Minor Changes

- 0ab4c84: 重构运行时 CLI 并统一 JSON 处理工具

## 1.5.1

### Patch Changes

- Productized the default AI development runtime experience.

  - The default help now focuses on the main onboarding path, while advanced runtime controls remain available behind `--help --advanced`.
  - Added friendly aliases for common context and task flows: `context next`, `context for <taskId>`, `task from-doc <path>`, and `task plan --goal "..."`.
  - Added `status` as a lightweight entry point for repository freshness, task summary, approval state, and next action.
  - Runtime safety boundaries, confirmation gates, MCP write policy, hygiene apply rules, bootstrap apply allowlists, and snapshot contracts remain unchanged.

- b9f1f17: 添加 package.json 内容哈希校验以改进变更检测

## 1.5.0

### Minor Changes

- d84ecc0: update AI workflow

### Patch Changes

- 0261c86: test Adds MCP server support for Claude, Cursor, VS Code, and scripts.

## 1.4.1

### Patch Changes

- fbaf764: update lesson-based workflow learning

## 1.4.0

### Minor Changes

- 1f2ef7f: Fix npm package release blockers and improve Windows-safe CLI output.

## 1.3.2

### Patch Changes

- 802007c: udpate new feature to config the github token, allow ai to make pr directly

## 1.3.1

### Patch Changes

- Align workflow docs with actual CLI behavior, clarify gate test-command allowlist, and document the recommended changesets release flow.

## 1.3.0

### Minor Changes

- b87c063: Add a semi-auto executor (`execute` CLI) and deterministic completed-task cleanup (`task cleanup` and `task pr --cleanup`).

## 1.2.0

### Minor Changes

- Minor release (no functional changes).

## 1.1.1

### Patch Changes

- Add doc-to-tasks guidance for Trae and GitHub Copilot, including optional pre-authorization flow and per-task commits.

## 1.1.0

### Minor Changes

- Align README workflow with CLI behavior; add `budget show`, add `loop run` alias, improve invalid task exit codes, and harden UI asset checks.

## 1.0.0

### Major Changes

- c39b5eb: mplement task registry system with consistency checks and CLI integration

## 0.5.1

### Patch Changes

- 0ddc1be: 不同 AI 工具用同一套规则：先理解项目，再判断需求是否清楚，不清楚就问问题，清楚再生成结构化 implementation prompt。

## 0.5.0

### Minor Changes

- 010f467: Introduce scalable indexing with directory grouping and project summary layer

  - add file-groups.json for directory-level structure understanding
  - add summary.json for global scan metadata
  - prevent index explosion with controlled limits
  - improve CLI output consistency and CI integration

### Patch Changes

- f79fa5a: test

## 0.4.0

### Minor Changes

- 010f467: Introduce scalable indexing with directory grouping and project summary layer

  - add file-groups.json for directory-level structure understanding
  - add summary.json for global scan metadata
  - prevent index explosion with controlled limits
  - improve CLI output consistency and CI integration

## 0.3.1

### Patch Changes

- 1e3551f: Improve CLI output consistency and documentation.

  - Standardize init and scan output format
  - Improve scan --check and scan --auto messages
  - Group help text options
  - Document scan --check and scan --auto usage
  - Add tests for no-change and marker-missing cases

- 4d29e83: Refactor scan data generation and enhance CLI test coverage

## 0.3.0

### Minor Changes

- 32ac203: Add scan consistency modes.

  - Add scan --check for CI-friendly project context validation
  - Add scan --auto for non-interactive context updates
  - Improve scan output when no changes are detected
  - Preserve manual notes while comparing generated project context
  - Support both legacy and current AUTO-GENERATED markers

## 0.2.8

### Patch Changes

- 0ae003a: test

## 0.2.7

### Patch Changes

- cb5079f: test

## 0.2.6

### Patch Changes

- c35025d: test

## 0.2.5

### Patch Changes

- 057c190: test release 0.2.5

## 0.2.4

### Patch Changes

- 299fb97: test CI auto publish 0.2.4

## 0.2.3

### Patch Changes

- d6e1667: test trusted publishing with npm-publish environment

## 0.2.2

### Patch Changes

- b07f27e: test trusted publishing release flow

## 0.2.1

### Patch Changes

- 9704fec: test CI publish flow

## 0.2.0

### Minor Changes

- 064a7b8: add documentation alignment
