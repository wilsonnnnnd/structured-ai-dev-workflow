Load:
- .aidw/project.md
- .aidw/rules.md
- skill.md

# Task

My request:
[WRITE YOUR REQUIREMENT HERE]

# Instructions

Use the controller in `skill.md` to decide the correct path.

The clarification policy in `skill.md` is the source of truth.
If clarification is required, only ask implementation-boundary questions.

- If the request is vague or high-level:
  - identify relevant areas
  - ask focused clarification questions
  - stop after clarification

- If the request is clear and implementation-ready:
  - generate one structured implementation prompt

- If a prompt or plan already exists:
  - review and refine it only

# Constraints

- Follow .aidw/rules.md strictly
- Reuse existing components, hooks, utilities, and services
- Keep changes minimal and localized
- Do not break existing functionality
- Protect shared modules and keep them backward compatible

# Output Rules

- Do not write code unless explicitly requested
- Do not skip clarification for vague requests
- Output must match the selected behavior