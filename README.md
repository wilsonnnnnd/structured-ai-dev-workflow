# repo-context-kit

Compact deterministic repository runtime for AI coding agents.

repo-context-kit is MCP-native first: MCP transport + runtime/v1 JSON state + minimal CLI fallback.

Primary interfaces:

1. MCP (`rck-mcp`)
2. runtime/v1 JSON (`.aidw/runtime/*.json`)
3. minimal CLI (`rck`)

It provides bounded repository context, runtime task state, verification framing, and confirmation-gated execution for AI coding agents.

## MCP

```bash
rck-mcp --root <repo>
```

The MCP server is read-only by default. Write, test, and external-side-effect tiers require explicit opt-in and still honor the confirmation gate.

## Runtime

JSON is the source of truth:

- `.aidw/runtime/task.json`
- `.aidw/runtime/context.json`
- `.aidw/runtime/execution.json`
- `.aidw/runtime/verification.json`

Markdown is a readable view only.

## Usage

```bash
rck init
rck scan [--check]
rck context brief
rck context next-task
rck context workset <taskId>
rck task prompt <taskId>
rck task checklist <taskId>
rck task pr <taskId>
rck gate status
rck gate confirm task <taskId>
rck gate confirm tests <taskId>
rck gate run-test <taskId> --token <token>
rck check
rck metrics
```
