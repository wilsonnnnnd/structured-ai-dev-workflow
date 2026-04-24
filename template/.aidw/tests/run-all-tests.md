# Run All Test Cases

You are running a full regression check for this repository's AI development workflow.

Read these files first:

- AGENTS.md
- skill.md
- .aidw/project.md
- .aidw/rules.md
- .aidw/task-entry.md
- .aidw/tests/test-case.md
- .aidw/tests/expected-good-output.md
- .aidw/tests/evaluation-prompt.md
- .claude/skills/project-scan/SKILL.md
- .claude/skills/prompt-design/SKILL.md
- .claude/skills/prompt-review/SKILL.md

---

## Goal

Run all existing test cases from `.aidw/tests/test-case.md`.

For each test case:

1. Simulate the expected system response using the current controller + skills workflow
2. Evaluate that response against `.aidw/tests/expected-good-output.md`
3. Assign a score from 0 to 10
4. Record:
   - classification
   - whether behavior passed
   - whether structure passed
   - whether minimum acceptance passed
   - any red flags
   - exact improvements needed

---

## Test Execution Rules

- Use the current repository rules and controller behavior as source of truth
- Do NOT generate code
- Do NOT invent project source files that are not in this repo
- Be strict
- If behavior is ambiguous, score lower rather than higher
- Keep each case evaluation concise but concrete

---

## Output Format

# Regression Test Summary

## Overall Score
- Average score: X/10
- Passed cases: X/3
- Failed cases: X/3

## Results Table

| Test Case | Score | Classification | Pass/Fail | Notes |
|----------|-------|----------------|-----------|-------|

## Detailed Results

### Test Case 1
#### Simulated Response
[short simulated output]

#### Evaluation
- Score: X/10
- Classification: ...
- Behavior: pass/fail
- Structure: pass/fail
- Minimum Acceptance: pass/fail
- Red Flags: none / list
- Improvements:
  - ...
  - ...

### Test Case 2
#### Simulated Response
[short simulated output]

#### Evaluation
- Score: X/10
- Classification: ...
- Behavior: pass/fail
- Structure: pass/fail
- Minimum Acceptance: pass/fail
- Red Flags: none / list
- Improvements:
  - ...
  - ...

### Test Case 3
#### Simulated Response
[short simulated output]

#### Evaluation
- Score: X/10
- Classification: ...
- Behavior: pass/fail
- Structure: pass/fail
- Minimum Acceptance: pass/fail
- Red Flags: none / list
- Improvements:
  - ...
  - ...

## Final Judgment

Summarize:
- whether the workflow is stable
- which area is weakest
- what one change would improve the system most