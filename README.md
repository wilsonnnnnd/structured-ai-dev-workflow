# repo-context-kit

Compact deterministic repository runtime for AI coding agents.

repo-context-kit gives Codex, Cursor, Claude, Trae, and MCP clients bounded repository context, runtime task state, verification views, and confirmation-gated execution surfaces.

## Usage

```bash
repo-context-kit init
repo-context-kit scan [--check]
repo-context-kit context brief
repo-context-kit context next-task
repo-context-kit context workset <taskId>
repo-context-kit task prompt <taskId>
repo-context-kit task checklist <taskId>
repo-context-kit task pr <taskId>
repo-context-kit gate status
repo-context-kit gate confirm task <taskId>
repo-context-kit gate confirm tests <taskId>
repo-context-kit gate run-test <taskId> --token <token>
repo-context-kit check
repo-context-kit metrics
```

## MCP

```bash
repo-context-kit-mcp --root <repo>
```

The MCP server is read-only by default. Write, test, and external-side-effect tiers require explicit opt-in and still honor the confirmation gate.

## Runtime

JSON is the source of truth:

- `.aidw/runtime/task.json`
- `.aidw/runtime/context.json`
- `.aidw/runtime/execution.json`
- `.aidw/runtime/verification.json`

Markdown is a readable view only.
