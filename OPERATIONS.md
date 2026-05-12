# Agent Operations

repo-context-kit is operated by AI coding agents through MCP/runtime surfaces. Humans install, initialize, authorize gated actions, and make final decisions.

## Agent Flow

1. Connect through `repo-context-kit-mcp --root <repo>`.
2. Read `runtime/v1` JSON under `.aidw/runtime/`.
3. Resolve bounded context with `context brief`, `context next-task`, or `context workset`.
4. Produce task prompt/checklist/PR notes from bounded context.
5. Request gated writes, tests, or external side effects only through allowed runtime tools.
6. Report verification and remaining risks.

## Essential CLI Fallback

```bash
npx repo-context-kit init
npx repo-context-kit scan
npx repo-context-kit scan --check
npx repo-context-kit context brief
npx repo-context-kit context workset T-001
npx repo-context-kit task prompt T-001 --compact
npx repo-context-kit task checklist T-001
npx repo-context-kit task pr T-001
```

Everything else is compatibility/debug surface.

## Runtime Ownership

| Area | Source of truth |
|---|---|
| Runtime task state | `.aidw/runtime/task.json` |
| Runtime context state | `.aidw/runtime/context.json` |
| Execution policy/state | `.aidw/runtime/execution.json` plus gate state |
| Verification state | `.aidw/runtime/verification.json` |
| Human-readable views | Markdown files under `.aidw/` and `task/` |

Markdown remains supported for legacy repositories, but agents should prefer runtime JSON.

## Gates

- MCP is read-only by default.
- Writes require `--enable-write`.
- Tests require `--enable-write --enable-tests` and confirmation gate tokens.
- External side effects require explicit external-side-effect opt-in.
- No arbitrary shell execution is supported.
