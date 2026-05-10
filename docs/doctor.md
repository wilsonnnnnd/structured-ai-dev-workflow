# Bootstrap Doctor

`repo-context-kit bootstrap doctor` is a read-only preflight check for early project setup risks. It is intentionally conservative and does not execute installs, network calls, or file writes.

## Command

```bash
repo-context-kit bootstrap doctor
repo-context-kit bootstrap doctor --json
repo-context-kit bootstrap doctor --check
repo-context-kit bootstrap doctor --check --strict
repo-context-kit bootstrap doctor --check --max-risks 10
repo-context-kit bootstrap doctor --from-doc docs/new-project.md
repo-context-kit bootstrap doctor --from-doc docs/new-project.md --json
```

## Boundaries

- No installs
- No lockfile modifications
- No network access
- No file writes or code generation
- Output is deterministic and bounded

## JSON Contract

`repo-context-kit bootstrap doctor --json` emits a stable JSON object:

```json
{
  "schema": "repo-context-kit/bootstrap-doctor/v1",
  "status": "ok|warning|error",
  "projectShape": {},
  "dependencyCompatibility": {},
  "dryRunPlan": {},
  "risks": [],
  "suggestedActions": {
    "safe_actions": [],
    "manual_review_actions": []
  },
  "boundaries": {
    "writes": false,
    "installs": false,
    "lockfileChanges": false,
    "network": false
  }
}
```

Notes:
- `status` is derived from the highest severity seen in `risks` (`error` if any `severity=error` risk exists).
- `risks` is bounded and must not include `undefined`, circular references, or raw `Error` objects.
- `suggestedActions` is intended for UI/MCP/agent consumption (tiered into `safe_actions` vs `manual_review_actions`).

## Check Mode (CI / Gate)

`--check` turns the doctor into a deterministic gate:

```bash
repo-context-kit bootstrap doctor --check
repo-context-kit bootstrap doctor --check --strict
repo-context-kit bootstrap doctor --check --max-risks 10
repo-context-kit bootstrap doctor --check --json
```

Default policy:
- `status=error` → exit 1
- `status=warning|ok` → exit 0

Strict policy:
- `status=warning|error` → exit 1

Max risks policy:
- if `riskCount > maxRisks` → exit 1

When combined with `--json`, the output includes a machine-readable `check` object:

```json
{
  "schema": "repo-context-kit/bootstrap-doctor/v1",
  "check": {
    "passed": true,
    "strict": false,
    "maxRisks": 10
  }
}
```

## Risk Codes (RCK_*)

The doctor risk codes are stable identifiers intended for tests, UI/MCP consumption, and workflow automation.

### Dependency / Compatibility

- `RCK_DEP_PEER_MISMATCH`
  - Meaning: Detected dependency majors look mismatched (example: Next.js vs React).
  - Why it matters: Peer conflicts can block installs or cause runtime failures.
  - Action tier: manual_review_actions

- `RCK_DEP_UNKNOWN_RANGE`
  - Meaning: A dependency range could not be parsed into a major version (example: `workspace:*`, `latest`).
  - Why it matters: Compatibility checks become conservative.
  - Action tier: manual_review_actions

- `RCK_DEP_MISSING_PACKAGE_JSON`
  - Meaning: `package.json` is missing.
  - Why it matters: Dependency checks are limited.
  - Action tier: manual_review_actions

- `RCK_DEP_MISSING_REACT`
  - Meaning: Next.js present but `react` is missing.
  - Why it matters: The project cannot run/build correctly.
  - Action tier: manual_review_actions

- `RCK_DEP_MISSING_REACT_DOM`
  - Meaning: `react` present but `react-dom` missing.
  - Why it matters: React runtime is incomplete.
  - Action tier: manual_review_actions

- `RCK_DEP_MISSING_TAILWIND`
  - Meaning: Tailwind config signals exist but `tailwindcss` dependency is missing.
  - Why it matters: Build/config drift; toolchain likely incomplete.
  - Action tier: manual_review_actions

- `RCK_DEP_MISSING_POSTCSS`
  - Meaning: Tailwind present but `postcss` and/or `autoprefixer` is missing.
  - Why it matters: Styling pipeline often fails at build time.
  - Action tier: manual_review_actions

- `RCK_DEP_UNSUPPORTED_COMBO`
  - Meaning: A combination is known to be risky for common scaffolds (example: tailwindcss@4).
  - Why it matters: Scaffolds and configs may require manual adjustment.
  - Action tier: manual_review_actions

### Next.js Shape

- `RCK_NEXT_MISSING_LAYOUT`
  - Meaning: App router detected but root layout is missing.
  - Why it matters: Next.js app router requires a root layout component.
  - Action tier: safe_actions + manual_review_actions

- `RCK_NEXT_MISSING_NEXT_ENV`
  - Meaning: TypeScript detected but `next-env.d.ts` missing.
  - Why it matters: TS integration can break with missing Next.js types bootstrap.
  - Action tier: safe_actions

- `RCK_NEXT_UNKNOWN_SHAPE`
  - Meaning: Next.js detected but routing shape cannot be determined from files.
  - Why it matters: Scaffolds and required files differ by router mode.
  - Action tier: manual_review_actions

### Config

- `RCK_CONFIG_MISSING_SCRIPT`
  - Meaning: Important `package.json` scripts are missing (dev/build/start).
  - Why it matters: Standard workflow commands may not work.
  - Action tier: safe_actions

- `RCK_CONFIG_MISSING_TSCONFIG`
  - Meaning: `typescript` dependency exists but `tsconfig.json` is missing.
  - Why it matters: TypeScript projects often fail to compile or generate types.
  - Action tier: safe_actions

- `RCK_TAILWIND_CONFIG_MISSING`
  - Meaning: `tailwindcss` dependency exists but Tailwind config is missing.
  - Why it matters: Styling pipeline cannot be configured deterministically.
  - Action tier: safe_actions

### Git / Artifacts

- `RCK_GIT_MISSING_IGNORE`
  - Meaning: A common build artifact directory exists but is not covered by `.gitignore`.
  - Why it matters: Artifacts may be accidentally committed, adding noise and CI instability.
  - Action tier: safe_actions

- `RCK_GIT_BUILD_ARTIFACT_TRACKED`
  - Meaning: A build artifact path appears to be tracked by git (heuristic).
  - Why it matters: Tracked artifacts increase review noise and can break workflows.
  - Action tier: manual_review_actions

### React / Client Components

- `RCK_NEXT_CLIENT_COMPONENT_RISK`
  - Meaning: React hooks or browser APIs detected without a `"use client"` directive (heuristic).
  - Why it matters: Next.js app router server components cannot use client-only APIs.
  - Action tier: manual_review_actions

## Example Output (Trimmed)

```json
{
  "schema": "repo-context-kit/bootstrap-doctor/v1",
  "status": "error",
  "risks": [
    {
      "code": "RCK_NEXT_MISSING_LAYOUT",
      "severity": "error",
      "category": "project-shape",
      "message": "Next.js app router requires a root layout component.",
      "whyItMatters": "Next.js app router requires a root layout component.",
      "safe_actions": ["Create src/app/layout.tsx"],
      "manual_review_actions": ["If you intended pages router, move routing files under pages/ instead of app/."]
    }
  ],
  "suggestedActions": {
    "safe_actions": ["Create src/app/layout.tsx"],
    "manual_review_actions": []
  },
  "boundaries": {
    "writes": false,
    "installs": false,
    "lockfileChanges": false,
    "network": false
  }
}
```
