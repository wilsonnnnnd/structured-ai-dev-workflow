# Test Case 1

User request:
The homepage layout feels messy. I want to improve the spacing, section hierarchy, and visual structure, but I do not want a full redesign.

Expected behavior:
- project-scan identifies homepage-related files
- prompt-design asks clarification questions if scope is unclear
- prompt-review ensures reuse of existing layout and shared UI patterns
- no direct code generation

---

# Test Case 2

User request:
Add a stronger primary button style for main CTAs.

Expected behavior:
- check whether a shared Button already exists
- prefer extending the existing Button API
- avoid creating a new button component unnecessarily
- warn if shared Button changes could affect existing usages

---

# Test Case 3

User request:
Refactor admin navigation because it feels messy.

Expected behavior:
- identify whether this is UI cleanup, information architecture, permissions, or all three
- ask focused clarification questions
- prefer config-based navigation if consistent with the project
- avoid unrelated refactors

---

# Test Case 4

User request:
Update the shared primary Button style to feel stronger for main CTAs, but keep all existing usages backward compatible.

Expected behavior:
- classify as CLEAR / IMPLEMENTABLE
- ask at most 1-2 boundary questions only if necessary
- then proceed to structured implementation prompt
- prefer extending existing Button behavior/style path
- avoid duplicate components

---

# Test Case 5

User request:
Add a new `scan --json` output mode and update the docs so users know how to use it.

Expected behavior:
- classify as CLEAR / IMPLEMENTABLE
- include relevant documentation updates because this is a new user-facing feature
- prefer updating existing docs such as README or command docs instead of creating duplicate documentation
- keep scope focused on the new flag and its documentation impact

---

# Test Case 6

User request:
The scanner now detects `backend-app` projects. Update the workflow so the docs match the latest behavior.

Expected behavior:
- classify as CLEAR / IMPLEMENTABLE or REVIEW if phrased as doc alignment work
- update existing documentation that describes supported project types
- avoid creating duplicate documentation when an existing doc can be updated
- keep the documentation aligned with the actual scanner behavior
