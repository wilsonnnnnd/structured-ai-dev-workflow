# Engineering Rules

## Reuse First
- Always reuse existing components, hooks, utilities, and services first
- Do not duplicate logic
- Extend existing structures before creating new ones

## Shared Module Safety
- Modify shared modules only when strongly related to the task
- Any shared-module change must remain backward compatible
- Existing usage must keep working

## Scope Control
- Change only files directly related to the task
- Avoid unrelated refactors
- Do not rename keys, APIs, or exported contracts unless required

## UI Rules
- Follow hierarchy: global -> layout -> component -> element
- Prefer shared styles, tokens, and existing class patterns
- Avoid random inline styles, colors, spacing, or one-off patterns

## Code Quality
- Match existing naming, structure, and patterns
- Prefer readable code over clever code
- Avoid over-abstraction
- Avoid generic AI-style wrappers and helpers

## Dependency Rule
- Do not add new dependencies unless clearly necessary

## Documentation Alignment
- For new features, add or update relevant documentation so the new behavior is discoverable
- For changes to existing documented behavior, update the existing docs to match the latest implementation
- Prefer updating an existing doc instead of creating a duplicate doc that overlaps in purpose

## Safety
- Do not break existing functionality
- Keep types valid
- Ensure behavior is predictable and reviewable

## Priority Order
Reuse > New
Consistency > Cleverness
Safety > Speed
Simplicity > Flexibility
