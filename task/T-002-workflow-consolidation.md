# T-002 Workflow Consolidation

## Goal

Make the default repo-context-kit workflow explicit and cohesive: governance checks enter the mainline, preflight bundle is documented, and governance layers are clearly defined as hard gates vs signals.

## Background

The project has multiple control planes (scan/check, confirmation protocol, gate, loop, budget, lessons, MCP). Phase 2B consolidates the user-facing mainline without adding new automation.

## Scope

Allowed to change:

- `README.md`
- `docs/runtime-governance.md`
- `bin/cli.js` (help text only, if needed)
- `test/cli.test.js`

Do not change:

- No new auto-execution capabilities
- No new preflight command surface (bundle is documentation-first)
- No changes that expand MCP write capabilities

## Requirements

- README default workflow: `init -> scan -> check -> task prompt -> human implementation -> task checklist -> task pr -> scan --check -> check --strict`.
- Document the preflight bundle (`scan --check` + `check --strict`) for CI/local usage.
- Add governance layer documentation clarifying responsibilities and gates/signals.
- Keep docs discoverable via README links.

## Acceptance Criteria

- README includes the consolidated default workflow and explains the two check layers.
- Governance doc exists and clearly separates hard gates vs signals.
- Tests assert docs and README content for discoverability and correctness.
- `npm test` passes.

## Test Command

```bash
npm test
```

## Definition of Done

- Docs updated.
- Tests added/updated.
- Test command passes.
