# ai-dev-workflow

[![npm version](https://img.shields.io/npm/v/ai-dev-workflow)](https://www.npmjs.com/package/ai-dev-workflow)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/wilsonnnnnd/structured-ai-dev-workflow?style=social)](https://github.com/wilsonnnnnd/structured-ai-dev-workflow)

`ai-dev-workflow` is a small npm CLI that initializes a structured AI development workflow inside an existing repository and scans the project to generate reusable project context for AI-assisted development.

It is meant for teams that want AI tools to work from stable repository guidance instead of starting every task from scratch.

## Why this exists

AI tools lose project context between sessions, tools, and handoffs. `ai-dev-workflow` creates persistent project memory inside the repository so assistants can start from the same structure, rules, and constraints every time.

This helps AI tools like Claude, Codex, and Cursor stay consistent instead of requiring repeated prompt explanations for the same project.

## Use cases

- switching between AI tools
- maintaining consistent AI workflow
- avoiding repeated prompt explanations

## Quick Start

Run in an existing project directory:

```bash
npx ai-dev-workflow init
npx ai-dev-workflow scan
```

Then review `ai/project.md` and add project-specific constraints under `## Manual Notes`.

## Commands

### `npx ai-dev-workflow init`

Copies the workflow template into the current repository.

The template includes:

- `ai/project.md`
- `ai/rules.md`
- `ai/task-entry.md`
- `ai/tests/`
- `skill.md`
- `AGENTS.md`
- `.claude/skills/`
- `.github/copilot-instructions.md`
- `.github/agents/project-prompt.agent.md`

Existing files are left in place when they already exist.

### `npx ai-dev-workflow scan`

Scans the current repository and updates the AUTO-GENERATED section of `ai/project.md`.

The scan output includes:

- project type
- overview and tech stack
- package metadata
- structure overview
- entry points
- reusable system areas
- risk areas

Manual notes below the AUTO-GENERATED block are preserved.

## Supported Project Types

The scanner currently detects these high-level project types:

- `cli-tool`
- `web-app`
- `fullstack-app`
- `backend-app`
- `template-repo`
- `generic`

Detection is based on common repository structure and package metadata. The result is intended to provide useful project context, not a complete architecture model.

## What Gets Added To A Project

After `init`, the target repository gets a plain-text workflow scaffold that helps AI tools:

- understand the project before suggesting implementation
- follow shared engineering rules
- ask clarification questions when scope is unclear
- generate or review structured implementation prompts

The workflow is intentionally markdown-first so teams can inspect and adapt it over time.

This repository is the package source. The full workflow experience is created in the target project after you run `init`, so evaluate the initialized output there rather than assuming this source repo is itself a complete example project.

## Package Layout

The published package includes:

- `bin/` for CLI entrypoints
- `src/scan/` for modular scan logic
- `template/` for the files copied by `init`
- `README.md`
- `LICENSE`

## Typical Usage

1. Run `npx ai-dev-workflow init` in the repository you want to prepare for AI-assisted work.
2. Run `npx ai-dev-workflow scan` to generate project-aware context in `ai/project.md`.
3. Review the generated context and add stable project-specific notes under `## Manual Notes`.
4. Use `ai/task-entry.md` and `skill.md` as the main workflow entry points for future requests.

## Notes

- `scan` is safe to re-run and only updates the AUTO-GENERATED section of `ai/project.md`
- project-specific constraints should live under `## Manual Notes`
- the initialized workflow is designed to stay simple, reviewable, and easy to version
- lightweight release smoke test: run `npm pack --dry-run`, then try `npx ai-dev-workflow init` and `npx ai-dev-workflow scan` in a temporary target project

## Support

If this package is useful to you, consider giving the GitHub repository a star to support future improvements and maintenance.

## License

This project is released under the MIT License. See [LICENSE](./LICENSE) for details.
