# AI System Overview

<!-- AUTO-GENERATED: repo-context-kit. Do not edit manually. -->

## Purpose

This file summarizes the AI-readable context system for this repository.

## Context Sources

- `PROJECT.md` - status: present - Human-owned project brief and requirements
- `.aidw/AI_project.md` - status: present - Generated AI project context compiled from scan data and PROJECT.md
- `.aidw/index/summary.json` - status: present - Scan metadata and index counts
- `.aidw/index/entrypoints.json` - status: present - Detected CLI, app, and execution entry points
- `.aidw/index/file-groups.json` - status: present - Directory-level groups and key files
- `.aidw/index/files.json` - status: present - Important files with AI-readable descriptions
- `.aidw/index/file-summaries.json` - status: present - Per-file summaries including exports, imports, and detected calls
- `.aidw/index/symbols.json` - status: present - Detected functions, classes, components, and exports

## Rule Sources

- `AGENTS.md` - status: present - Main AI workflow entry point
- `PROJECT.md` - status: present - Human-owned project purpose, stack, and requirements
- `.aidw/rules.md` - status: present - Repository engineering rules and constraints
- `.aidw/confirmation-protocol.md` - status: present - Click-to-confirm execution protocol and compact presentation rules
- `.aidw/workflow.md` - status: present - Standard AI-assisted development workflow
- `.aidw/safety.md` - status: present - Protected areas and AI change safety rules
- `.aidw/lessons.json` - status: present - Learned hard-blocking rules derived from recent failures
- `.github/copilot-instructions.md` - status: present - GitHub Copilot repository instructions
- `.trae/rules/project_rules.md` - status: present - Trae repository rules adapter
- `skill.md` - status: present - Claude-style skill workflow adapter

## Task Sources

- `.aidw/task-entry.md` - status: present - Reusable task request template
- `task/*.md` - status: present - Markdown task files (3 detected)
  - `task/T-001-governance-boundary-hardening.md`
  - `task/T-002-workflow-consolidation.md`
  - `task/T-003-deterministic-scan-cleanup.md`
- `.aidw/context/tasks.json` - status: present - Generated task-to-file mapping index

## Task Registry

- Registry file: task/task.md (present)
- Total tasks: 3
- Status breakdown:
  - todo: 1
  - in_progress: 1
  - done: 1
  - blocked: 0
  - cancelled: 0

- Task health:
  - tasks with acceptance criteria: 3 / 3
  - tasks with test command: 3 / 3
  - tasks with definition of done: 3 / 3

## Task Health

- Task count: 3
- Tasks with acceptance criteria: 3
- Tasks with test command: 3
- Tasks with definition of done: 3

## Generated Indexes

- `.aidw/index/summary.json` - status: present - Scan metadata and index counts
- `.aidw/index/entrypoints.json` - status: present - Detected execution entry points
- `.aidw/index/file-groups.json` - status: present - Directory groups and key files
- `.aidw/index/files.json` - status: present - Important file map
- `.aidw/index/file-summaries.json` - status: present - File summaries and symbol hints
- `.aidw/index/symbols.json` - status: present - Detected source symbols

## AI Tool Adapters

- `AGENTS.md` - status: present - Main AI entry point
- `.github/copilot-instructions.md` - status: present - GitHub Copilot
- `.trae/rules/project_rules.md` - status: present - Trae

## Execution Loop (Optional)

- `.aidw/confirmation-gate.json` - status: runtime - Local gate state for task/test confirmations (runtime file)
- `.aidw/context-loop.jsonl` - status: runtime - Append-only context loop log for recent confirmations and test runs (runtime file)
- `.aidw/context-cache.md` - status: runtime - Cached token-efficient brief context output (runtime file)
- `repo-context-kit metrics` - status: missing - Print compact runtime metrics JSON
- `repo-context-kit check` - status: missing - Run checks derived from lessons (blocker rules fail by default)

## Recommended AI Workflow

1. Read AGENTS.md first.
2. Read PROJECT.md for human project intent.
3. Read .aidw/AI_project.md for generated AI context.
4. Read .aidw/rules.md for repository rules.
5. Read .aidw/system-overview.md to understand available context sources.
6. Read the current task file before making changes.
7. Use .aidw/index/* files to locate relevant code.
8. Preserve project structure and update tests.
