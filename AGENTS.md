# AGENTS.md

This repository uses a structured AI development workflow.

## Read first
- .aidw/project.md
- .aidw/rules.md
- .aidw/task-entry.md

## Required behavior
1. Understand the project before suggesting implementation
2. Reuse existing components, hooks, utilities, and services
3. Keep changes minimal and localized
4. Protect shared modules and preserve backward compatibility
5. If the request is vague, ask clarification questions before generating a prompt
6. If the request is clear, generate a structured implementation prompt
7. If a prompt already exists, review and refine it

## Never
- write code directly unless explicitly requested
- skip clarification for ambiguous requests
- create duplicate structures unnecessarily
- perform unrelated refactors