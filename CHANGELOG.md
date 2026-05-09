# repo-context-kit

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
