# Runtime Architecture

repo-context-kit is an agent-facing runtime/context layer. JSON is the source of truth; Markdown is a readable compatibility view.

```text
AI agent / MCP client
  -> rck-mcp
  -> .aidw/runtime/*.json
  -> bounded context/workset
  -> gated action
  -> verification report
```

## Runtime JSON Core

- `.aidw/runtime/task.json`: bounded task registry and task health signals.
- `.aidw/runtime/context.json`: bounded repo context/index summary.
- `.aidw/runtime/execution.json`: execution policy, gate expectations, MCP tiers.
- `.aidw/runtime/verification.json`: verification requirements and task health.

All runtime core files use `schemaVersion: "runtime/v1"` and deterministic bounded payloads.

## Compatibility Layers

- `task/*.md` and `.aidw/*.md` remain readable views and legacy inputs.
- CLI commands remain compatibility/debug/CI surfaces.
- MCP is the primary agent interface.

## Non-runtime Surfaces

Local UI, verbose command journeys, manual cleanup guides, and tutorial-style workflows are outside the product boundary.
