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

### Expected Structure
- The structured implementation prompt should still follow the standard prompt shape.
- It may mention documentation impact only if the button behavior change affects existing docs.

### Minimum Acceptance Rule
- The response remains correct if it preserves the existing shared button path, keeps changes backward compatible, and does not add unnecessary documentation work.

## Test Case 5
### Classification
Must be classified as `CLEAR / IMPLEMENTABLE`.

### Expected behavior
- Must route to `prompt-design`.
- Must include documentation work because this is a new user-facing feature.
- Must prefer updating existing docs such as README or command documentation instead of inventing duplicate docs.
- Must keep the feature scope and documentation scope aligned.

### Expected Structure
- The structured prompt should include:
  - Task goal
  - Files to inspect first
  - Constraints
  - Implementation direction
  - Documentation impact
  - Acceptance criteria
  - What must not be changed

### Avoid
- Do not treat documentation as optional when the new feature is user-facing.
- Do not create duplicate docs if an existing doc can be updated.
- Do not expand into unrelated scanner refactors.

### Red Flags
- Omits documentation updates entirely for the new feature.
- Suggests creating a brand new doc without checking existing docs.
- Expands beyond the requested feature and related documentation impact.

### Example good output
Task goal: add a new `scan --json` mode and document how users should invoke it.
Files to inspect first: scan CLI entry, scan runtime, existing README or command docs.
Constraints: keep CLI behavior backward compatible, reuse the existing scan path, do not add duplicate documentation.
Implementation direction: extend the current scan command flow, then update the existing user-facing docs to include the new flag and examples.
Documentation impact: update the existing README or command documentation to describe `scan --json`.
Acceptance criteria: `scan --json` works, existing scan behavior keeps working, and users can discover the new mode from the docs.
What must not be changed: unrelated scan behavior, command names, or duplicate docs.

### Minimum Acceptance Rule
A response is considered correct if:
- it includes documentation updates for the new user-facing feature
- it prefers updating an existing doc over adding duplicate docs
- it keeps the implementation prompt focused on the feature and its documentation impact

## Test Case 6
### Classification
Must be classified as `CLEAR / IMPLEMENTABLE` or a narrowly scoped `REVIEW REQUEST` if the request is framed as documentation alignment only.

### Expected behavior
- Must recognize that `backend-app` support already exists and the task is to align docs with current behavior.
- Must prefer updating the existing documentation that describes supported project types.
- Must avoid creating duplicate documentation for the same scanner capability.

### Expected Structure
- The response should identify the existing docs to inspect first.
- If it produces a structured implementation prompt, it should include documentation impact explicitly.

### Avoid
- Do not ignore the documentation request because the feature already exists.
- Do not propose a second parallel document for supported project types when an existing one can be updated.
- Do not refactor unrelated scanner logic.

### Red Flags
- Treats this as purely code work and ignores docs.
- Creates duplicate docs for supported project types.
- Expands into unrelated scanner feature work.

### Example good output
Task goal: align the existing docs with the current `backend-app` scanner support.
Files to inspect first: supported project type docs, README, scanner project type references.
Constraints: keep changes localized, do not duplicate documentation, do not change unrelated scanner behavior.
Implementation direction: update the existing supported-project-type documentation to include `backend-app` and match current scanner output.
Documentation impact: revise the existing user-facing docs that describe scanner-supported project types.
Acceptance criteria: docs mention `backend-app`, behavior descriptions match the implementation, and no duplicate documentation is introduced.
What must not be changed: unrelated scanner logic or unrelated docs.

### Minimum Acceptance Rule
A response is considered correct if:
- it updates existing documentation for the changed feature behavior
- it avoids duplicate documentation
- it keeps the task scoped to documentation alignment with current behavior
