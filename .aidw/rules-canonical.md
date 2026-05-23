# Canonical Rules & Constraints

**Canonical reference for all rules, constraints, and execution discipline.**

---

## Rule Groups

### Reuse & Backward Compatibility
- Always reuse existing components, hooks, utilities, and services first
- Do not duplicate logic; extend existing structures before creating new ones
- Any shared-module change must remain backward compatible
- Existing usage must keep working

### Implementation Order (Logic First)
1. Business logic, data models, API contracts
2. Data flows, state management, backend services
3. UI and frontend interactions (last)

### Scope Control
- Change only files directly related to the task
- Avoid unrelated refactors and unrelated renames
- Do not rename keys, APIs, or exported contracts unless required

### UI/Frontend Discipline
- Always inspect existing UI design system before writing new UI
- Reuse project UI conventions (colors, spacing, sizing, shadows, layout patterns)
- Inspect existing components/styles/theme directories first
- Do not invent separate visual styles unless explicitly required

### Code Quality
- Match existing naming, structure, and patterns
- Prefer readable code over clever code
- Avoid over-abstraction and generic AI-style wrappers

### Dependency Rule
- Do not add new dependencies unless clearly necessary

### Documentation Alignment
- For new features, add or update relevant documentation
- For changes to existing behavior, update existing docs
- Prefer updating existing docs instead of creating duplicates

### Safety
- Do not break existing functionality
- Keep types valid; ensure behavior is predictable and reviewable
- Preserve: safety gates, confirmation protocol, budget policy

### Priority Order
- Reuse > New
- Consistency > Cleverness
- Safety > Speed
- Simplicity > Flexibility

---

## AI Behavior Constraints

### Never
- Write code directly unless explicitly requested
- Skip clarification for ambiguous requests
- Create duplicate structures unnecessarily
- Perform unrelated refactors
- Write new UI code without inspecting project's existing UI design system

### Required for Frontend Tasks
- Read UI Design Context in .aidw/AI_project.md
- Inspect components/ui, styles, theme directories
- Reuse existing components, tokens, conventions before new UI code

### Workflow Discipline
1. Read AGENTS.md → PROJECT.md → .aidw/AI_project.md → .aidw/rules-canonical.md
2. For frontend tasks: Read UI Design Context section
3. Implement in order: Logic → Data/State → UI (where applicable)
4. Run task's test command before marking complete

---

## Protected Areas (Default Deny)
- Secrets/env: `.env*`, tokens, keys, credential files, CI/CD secret config
- Deployment: `deploy/`, `infra/`, `k8s/`, `helm/`, `terraform/`, `docker-compose*`, Dockerfiles
- Release workflows: `.github/workflows/**`
- Generated files: Do not edit manually unless explicitly required

---

## Context Discipline

### Compact Output (Default)
- Default for normal read-only work, low-risk status, routine summaries, and final reports
- Prefer concise fields: `State`, `Goal`, `Scope`, `Checks`, `Changed`, `Tests`, `Risk`, `Need`, `Note`
- Final reports: `Done`, `Tests`, `Note`
- Do not render protocol metadata, gating booleans, full AC, DoD, Background, or large task trees unless needed

### Smart Protocol Output (Hard Boundary)
- Use when confirmation is required for file writes, command/test execution, destructive or external side effects, meaningful risk, unresolved scope, or scope changes
- Show only relevant `Files`, `Commands`, `Reason`, `Risk`, and `Need`
- Do not render full `## State` / `## Output` / `## Confirm` blocks

### Full Audit Output (Explicit Only)
- Use only for `--audit`, `--protocol`, `--verbose`, debug/audit request, or machine-readable protocol transcript
- Full audit may include protocol metadata, gating booleans, full AC, DoD, and acceptance report detail

### Context Budget
- Digest only by default
- Upgrade only on: high risk, test failure, stale scan, auth/payment/security touched
- All upgrades must be: explainable, deterministic, bounded
