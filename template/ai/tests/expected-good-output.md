# Expected Good Output

## Test Case 1
### Classification
Must be classified as `VAGUE / HIGH-LEVEL`.

### Expected behavior
- Must route to `project-scan`.
- Must identify likely homepage-related areas in generic project terms without inventing source files that do not exist in this repo.
- Must ask only implementation-boundary clarification questions tied to scope, allowed edits, shared-module safety, or output type.
- Must reflect reuse-first, minimal localized change, and shared-module caution.
- Must stop after clarification and must not generate an implementation prompt.

### Expected Structure
- Clarification is required.
- Response should contain a short list of relevant areas or files to inspect first.
- Response should include `3-4` clarification questions maximum.
- Questions must be implementation-boundary questions only:
  - target file or directory
  - allowed level of structural change
  - whether shared modules/components may be modified
  - expected output type
- Prompt generation must not occur in the same response.

### Avoid
- Do not generate code.
- Do not propose a redesign plan or solution.
- Do not ask subjective design questions.
- Do not invent homepage source files in this repository.
- Do not continue into prompt generation before clarification.

### Red Flags
- Generates an implementation prompt in the same response.
- Asks subjective questions such as what feels messy or what should look better.
- Skips shared layout or global-style safety concerns.
- Invents concrete homepage files that are not present in the repo.
- Suggests a redesign rather than scoped clarification.

### Example good output
Relevant areas: homepage entry, shared layout wrappers, spacing patterns.
Files to inspect first: homepage route, shared section/layout components, global style tokens.
Clarification questions:
1. What file or directory contains the homepage?
2. Should this remain a localized cleanup, or may shared layout primitives be adjusted if backward compatible?
3. Do you want a structured implementation prompt only, or actual code changes?

### Minimum Acceptance Rule
A response is considered correct if:
- it prefers reuse of shared layout or section primitives over new structures
- it asks boundary clarification questions for the vague request
- it stops after clarification
- it does not generate a direct implementation prompt yet

## Test Case 2
### Classification
Must be classified as `CLEAR / IMPLEMENTABLE`, with at most `1-2` critical boundary questions if needed.

### Expected behavior
- Must route to `prompt-design`.
- Must infer that the likely target is an existing shared `Button` or button styling layer.
- Must prefer extending the current button API or shared style tokens instead of creating a new component.
- May ask `1-2` critical boundary questions if required to resolve scope or shared-module permission.
- Must produce one structured implementation prompt once the request is sufficiently bounded.

### Expected Structure
- Clarification is optional and must be minimal.
- If questions are asked, there should be no more than `1-2`.
- Allowed question types:
  - whether the change is global or limited to main CTAs
  - whether the shared button/component may be modified
- Prompt generation should occur if the request is already clear enough, or immediately after minimal clarification in the clear-path workflow.
- The prompt should include:
  - Task goal
  - Files to inspect first
  - Constraints
  - Implementation direction
  - Acceptance criteria
  - What must not be changed

### Avoid
- Do not create a duplicate button component by default.
- Do not skip warning about shared-button impact when the change touches common styles.
- Do not ask open-ended aesthetic questions.
- Do not generate code.
- Do not expand into unrelated CTA or layout refactors.

### Red Flags
- Treats the request as vague and stops without attempting prompt generation.
- Generates a prompt without checking or acknowledging the shared `Button`.
- Creates a new button component unnecessarily.
- Asks subjective design questions about preferred style or aesthetics.
- Ignores backward compatibility risks for shared button usages.
- Expands into unrelated layout, theme, or navigation refactors.

### Example good output
Task goal: strengthen the primary CTA style using the existing shared button system.
Files to inspect first: shared `Button`, shared button styles or tokens, main CTA usages.
Constraints: reuse first, keep changes minimal, preserve backward compatibility, do not add dependencies.
Implementation direction: extend the existing button API or styling path instead of creating a new component.
Acceptance criteria: stronger primary CTA treatment, existing button usages continue to work.
What must not be changed: unrelated button variants, layouts, or navigation.

### Minimum Acceptance Rule
A response is considered correct if:
- it reuses the existing shared `Button` or its current styling path
- it keeps any shared-button change backward compatible for existing usages
- it avoids creating a duplicate button component unnecessarily

## Test Case 3
### Classification
Must be classified as `VAGUE / HIGH-LEVEL`.

### Expected behavior
- Must route to `project-scan`.
- Must identify likely admin navigation areas in generic terms, such as admin layout, navigation config, sidebar or topbar components, and permission-aware route logic.
- Must ask focused clarification questions that distinguish between UI cleanup, information architecture, shared config, and route or permission boundaries.
- Must reflect reuse-first behavior and mention shared-module safety where relevant.
- Must stop after clarification and must not generate an implementation prompt.

### Expected Structure
- Clarification is required.
- Response should contain a short list of relevant areas or files to inspect first.
- Response should include `3-4` clarification questions maximum.
- Questions must be implementation-boundary questions only:
  - target file or directory
  - allowed level of structural change
  - whether shared navigation modules/config may be modified
  - expected output type
- Prompt generation must not occur in the same response.

### Avoid
- Do not assume this is only visual cleanup.
- Do not refactor routing, permissions, or broader admin layout without clarification.
- Do not invent admin files that are not present in this repo.
- Do not ask subjective questions about taste.
- Do not generate code or a final prompt before clarification.

### Red Flags
- Generates a prompt too early instead of stopping after clarification.
- Asks subjective or design-consulting questions about what feels messy.
- Ignores shared-module safety for navigation config or permission-aware logic.
- Over-refactors unrelated admin areas such as routing, permissions, or dashboard content.
- Assumes a config-based rewrite without first checking whether that pattern exists.
- Invents concrete admin source files that are not present in the repo.

### Example good output
Relevant areas: admin layout, nav components, shared nav config, permission-aware route logic.
Files to inspect first: admin layout entry, sidebar/topbar/menu components, existing route metadata.
Clarification questions:
1. What file or directory contains the current admin navigation?
2. Is this UI cleanup only, or may it also change grouping, ordering, or labels?
3. May shared navigation components or config be modified if backward compatible?
4. Do you want a structured implementation prompt only, or actual code changes?

### Minimum Acceptance Rule
A response is considered correct if:
- it treats navigation as potentially structural, not only visual
- it asks boundary questions before refactoring
- it avoids broad or unrelated refactors

## Test Case 4

User request:
Update the shared primary Button style to feel stronger for main CTAs, but keep all existing usages backward compatible.

Expected behavior:
- classify as CLEAR / IMPLEMENTABLE
- ask at most 1-2 boundary questions only if necessary
- then proceed to structured implementation prompt
- prefer extending existing Button behavior/style path
- avoid duplicate components
