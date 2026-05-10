import fs from "node:fs";
import path from "node:path";
import { withRepoRoot } from "../runtime/root-context.js";
import { getPackageJson } from "../scan/package-utils.js";
import { exists, isDirectory } from "../scan/fs-utils.js";
import { planBootstrapRuntime } from "./plan.js";

const DOCTOR_SCHEMA_V1 = "repo-context-kit/bootstrap-doctor/v1";
const MAX_RISKS = 120;
const MAX_ACTIONS = 20;
const MAX_REACT_RISK_FILES = 8;
const MAX_REACT_SCAN_FILES = 40;
const MAX_REACT_SCAN_DEPTH = 8;
const MAX_REACT_FILE_BYTES = 80_000;
const MAX_GIT_INDEX_BYTES = 5_000_000;
const ARTIFACT_DIRS = [".next", "dist", "build", "coverage", "node_modules"];

const DOCTOR_RISK_REGISTRY = {
    RCK_DEP_PEER_MISMATCH: {
        severity: "warning",
        whyItMatters: "Peer dependency mismatches can block installs or cause runtime failures.",
    },
    RCK_DEP_UNKNOWN_RANGE: {
        severity: "warning",
        whyItMatters: "Unparsed version ranges reduce the reliability of compatibility checks.",
    },
    RCK_DEP_MISSING_PACKAGE_JSON: {
        severity: "warning",
        whyItMatters: "Without package.json, dependency compatibility checks are limited.",
    },
    RCK_DEP_MISSING_REACT: {
        severity: "error",
        whyItMatters: "Next.js requires React to build and run.",
    },
    RCK_DEP_MISSING_REACT_DOM: {
        severity: "warning",
        whyItMatters: "React DOM is required for most React/Next.js web runtime scenarios.",
    },
    RCK_DEP_MISSING_TAILWIND: {
        severity: "warning",
        whyItMatters: "Tailwind configuration signals suggest styling pipeline drift or incomplete toolchain.",
    },
    RCK_DEP_MISSING_POSTCSS: {
        severity: "warning",
        whyItMatters: "Missing PostCSS tooling can break Tailwind builds.",
    },
    RCK_DEP_UNSUPPORTED_COMBO: {
        severity: "warning",
        whyItMatters: "Some dependency combinations often require manual adjustments to scaffold configs.",
    },
    RCK_DEP_INCOMPLETE_STACK: {
        severity: "warning",
        whyItMatters: "Detected config suggests a stack is intended but key pieces are missing.",
    },
    RCK_NEXT_MISSING_LAYOUT: {
        severity: "error",
        whyItMatters: "Next.js app router requires a root layout component.",
    },
    RCK_NEXT_MISSING_NEXT_ENV: {
        severity: "warning",
        whyItMatters: "Missing next-env.d.ts can break TypeScript type integration for Next.js.",
    },
    RCK_NEXT_UNKNOWN_SHAPE: {
        severity: "warning",
        whyItMatters: "Scaffolds and required files differ by router mode; unknown shape increases setup risk.",
    },
    RCK_CONFIG_MISSING_SCRIPT: {
        severity: "warning",
        whyItMatters: "Missing scripts (dev/build/start) can block common workflows and CI steps.",
    },
    RCK_CONFIG_MISSING_TSCONFIG: {
        severity: "warning",
        whyItMatters: "Missing tsconfig.json can break builds, tooling, or type generation.",
    },
    RCK_TAILWIND_CONFIG_MISSING: {
        severity: "warning",
        whyItMatters: "Tailwind dependency without config usually indicates incomplete setup.",
    },
    RCK_GIT_MISSING_IGNORE: {
        severity: "warning",
        whyItMatters: "Build artifacts or dependencies may be accidentally committed without ignore rules.",
    },
    RCK_GIT_BUILD_ARTIFACT_TRACKED: {
        severity: "error",
        whyItMatters: "Tracked build artifacts increase noise and can break review/CI workflows.",
    },
    RCK_NEXT_CLIENT_COMPONENT_RISK: {
        severity: "warning",
        whyItMatters: 'Using React hooks or browser APIs without "use client" can fail at runtime in Next.js app router.',
    },
};

function parseMajor(versionSpec) {
    const raw = String(versionSpec ?? "").trim();
    if (!raw) return null;
    const match = raw.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (!match) return null;
    const major = Number.parseInt(match[1], 10);
    return Number.isFinite(major) ? major : null;
}

function normalizeDeps(pkg) {
    return {
        ...(pkg?.dependencies && typeof pkg.dependencies === "object" ? pkg.dependencies : {}),
        ...(pkg?.devDependencies && typeof pkg.devDependencies === "object" ? pkg.devDependencies : {}),
    };
}

function normalizeDoctorSeverity(code) {
    const entry = DOCTOR_RISK_REGISTRY[String(code ?? "").trim()];
    const severity = String(entry?.severity ?? "").trim();
    if (severity === "error" || severity === "warning" || severity === "info") return severity;
    return "info";
}

function normalizeWhyItMatters(code) {
    const entry = DOCTOR_RISK_REGISTRY[String(code ?? "").trim()];
    const text = String(entry?.whyItMatters ?? "").trim();
    return text || "This risk may affect project setup or workflow stability.";
}

function buildDoctorRisk({
    id,
    code,
    category,
    message,
    evidence,
    safe_actions,
    manual_review_actions,
}) {
    const safe = Array.isArray(safe_actions)
        ? safe_actions.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 12)
        : [];
    const manual = Array.isArray(manual_review_actions)
        ? manual_review_actions.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 12)
        : [];
    const suggestedAction = safe[0] ?? manual[0] ?? "";

    return {
        id,
        code: code ?? null,
        source: "bootstrap.doctor",
        category,
        message,
        evidence: evidence && typeof evidence === "object" && !Array.isArray(evidence) ? evidence : {},
        suggestedAction,
        safe_actions: safe,
        manual_review_actions: manual,
    };
}

function severityWeight(severity) {
    const s = String(severity ?? "").trim();
    if (s === "error") return 3;
    if (s === "warning") return 2;
    if (s === "info") return 1;
    return 0;
}

function sortDoctorRisksStable(risks) {
    const list = Array.isArray(risks) ? risks.slice() : [];
    return list.sort((a, b) => {
        const sa = severityWeight(a?.severity);
        const sb = severityWeight(b?.severity);
        if (sb !== sa) return sb - sa;
        const ca = String(a?.code ?? "").trim();
        const cb = String(b?.code ?? "").trim();
        if (ca !== cb) return ca.localeCompare(cb);
        const ma = String(a?.message ?? "").trim();
        const mb = String(b?.message ?? "").trim();
        return ma.localeCompare(mb);
    });
}

function computeRiskSummary(risks) {
    const summary = { error: 0, warning: 0, info: 0 };
    for (const risk of Array.isArray(risks) ? risks : []) {
        const s = String(risk?.severity ?? "").trim();
        if (s === "error") summary.error += 1;
        else if (s === "warning") summary.warning += 1;
        else summary.info += 1;
    }
    return summary;
}

function computeDoctorStatusFromRisks(risks) {
    const summary = computeRiskSummary(risks);
    if (summary.error > 0) return { status: "error", highest_severity: "error", summary };
    if (summary.warning > 0) return { status: "warning", highest_severity: "warning", summary };
    return { status: "ok", highest_severity: summary.info > 0 ? "info" : "info", summary };
}

function normalizeDoctorRisks(rawRisks) {
    const list = Array.isArray(rawRisks) ? rawRisks : [];
    const normalized = list
        .filter((risk) => risk && typeof risk === "object")
        .map((risk) => {
            const code = String(risk.code ?? "").trim() || "RCK_UNSPECIFIED";
            const severity = normalizeDoctorSeverity(code);
            const whyItMatters = normalizeWhyItMatters(code);
            return {
                code,
                severity,
                category: String(risk.category ?? "").trim(),
                message: String(risk.message ?? "").trim(),
                whyItMatters,
                evidence: risk.evidence && typeof risk.evidence === "object" && !Array.isArray(risk.evidence) ? risk.evidence : {},
                safe_actions: Array.isArray(risk.safe_actions) ? risk.safe_actions : [],
                manual_review_actions: Array.isArray(risk.manual_review_actions) ? risk.manual_review_actions : [],
            };
        });
    return sortDoctorRisksStable(normalized).slice(0, MAX_RISKS);
}

function detectNextShape() {
    const hasAppDir = isDirectory("app") || isDirectory("src/app");
    const hasPagesDir = isDirectory("pages") || isDirectory("src/pages");
    const appLayoutCandidates = [
        "app/layout.tsx",
        "app/layout.jsx",
        "app/layout.ts",
        "app/layout.js",
        "src/app/layout.tsx",
        "src/app/layout.jsx",
        "src/app/layout.ts",
        "src/app/layout.js",
    ];
    const pagesAppCandidates = [
        "pages/_app.tsx",
        "pages/_app.jsx",
        "pages/_app.ts",
        "pages/_app.js",
        "src/pages/_app.tsx",
        "src/pages/_app.jsx",
        "src/pages/_app.ts",
        "src/pages/_app.js",
    ];
    const hasLayout = appLayoutCandidates.some((p) => exists(p));
    const hasPagesApp = pagesAppCandidates.some((p) => exists(p));
    const hasNextEnv = exists("next-env.d.ts");
    const usesTypeScript = exists("tsconfig.json");

    const isApp = hasAppDir || hasLayout;
    const isPages = hasPagesDir || hasPagesApp;

    const shape =
        isApp && isPages ? "hybrid" : isApp ? "app-router" : isPages ? "pages-router" : "unknown";

    return {
        shape,
        signals: {
            hasAppDir,
            hasPagesDir,
            hasLayout,
            hasPagesApp,
            usesTypeScript,
            hasNextEnv,
        },
    };
}

function preferredAppDir() {
    if (isDirectory("src/app")) return "src/app";
    return "app";
}

function buildDependencyCompatibilityRisks(pkg) {
    const deps = normalizeDeps(pkg);
    const nextSpec = deps.next ?? null;
    const reactSpec = deps.react ?? null;
    const reactDomSpec = deps["react-dom"] ?? null;
    const typescriptSpec = deps.typescript ?? null;
    const tailwindSpec = deps.tailwindcss ?? null;
    const postcssSpec = deps.postcss ?? null;
    const autoprefixerSpec = deps.autoprefixer ?? null;
    const hasTailwindConfig =
        exists("tailwind.config.js") ||
        exists("tailwind.config.cjs") ||
        exists("tailwind.config.mjs") ||
        exists("tailwind.config.ts");
    const hasPostCssConfig = exists("postcss.config.js") || exists("postcss.config.cjs") || exists("postcss.config.mjs") || exists("postcss.config.ts");
    const hasShadcnConfig = exists("components.json");

    const detected = {
        next: nextSpec ? { spec: nextSpec, major: parseMajor(nextSpec) } : null,
        react: reactSpec ? { spec: reactSpec, major: parseMajor(reactSpec) } : null,
        reactDom: reactDomSpec ? { spec: reactDomSpec, major: parseMajor(reactDomSpec) } : null,
        typescript: typescriptSpec ? { spec: typescriptSpec, major: parseMajor(typescriptSpec) } : null,
        tailwindcss: tailwindSpec ? { spec: tailwindSpec, major: parseMajor(tailwindSpec) } : null,
        postcss: postcssSpec ? { spec: postcssSpec, major: parseMajor(postcssSpec) } : null,
        autoprefixer: autoprefixerSpec ? { spec: autoprefixerSpec, major: parseMajor(autoprefixerSpec) } : null,
        shadcn: hasShadcnConfig ? { config: "components.json" } : null,
        configSignals: {
            hasTailwindConfig,
            hasPostCssConfig,
        },
    };

    const risks = [];
    if (!pkg) {
        risks.push(
            buildDoctorRisk({
                id: "bootstrap-doctor-missing-package-json",
                code: "RCK_DEP_MISSING_PACKAGE_JSON",
                category: "dependency",
                message: "package.json was not found. Dependency compatibility checks are limited.",
                evidence: {},
                safe_actions: [],
                manual_review_actions: ["Create package.json or run your scaffold tool to initialize the project."],
            }),
        );
        return { detected, risks };
    }

    const unknownRanges = {};
    for (const [name, item] of Object.entries(detected)) {
        if (!item || typeof item !== "object" || typeof item.spec !== "string") continue;
        if (item.major == null) {
            unknownRanges[name] = item.spec;
        }
    }
    if (Object.keys(unknownRanges).length) {
        risks.push(
            buildDoctorRisk({
                id: "bootstrap-doctor-unknown-range",
                code: "RCK_DEP_UNKNOWN_RANGE",
                category: "dependency",
                message: "Some dependency version ranges could not be parsed. Compatibility checks are conservative.",
                evidence: { unknownRanges },
                manual_review_actions: ["Pin exact versions or confirm peer requirements before running install."],
            }),
        );
    }

    if (nextSpec && !reactSpec) {
        risks.push(
            buildDoctorRisk({
                id: "bootstrap-doctor-missing-react",
                code: "RCK_DEP_MISSING_REACT",
                category: "dependency",
                message: "Next.js is present but React is missing from dependencies.",
                evidence: { next: nextSpec },
                manual_review_actions: ["Install React and React DOM: npm install react react-dom"],
            }),
        );
    }

    if (reactSpec && !reactDomSpec) {
        risks.push(
            buildDoctorRisk({
                id: "bootstrap-doctor-missing-react-dom",
                code: "RCK_DEP_MISSING_REACT_DOM",
                category: "dependency",
                message: "React is present but react-dom is missing from dependencies.",
                evidence: { react: reactSpec },
                manual_review_actions: ["Install React DOM: npm install react-dom"],
            }),
        );
    }

    if (nextSpec && reactSpec) {
        const nextMajor = parseMajor(nextSpec);
        const reactMajor = parseMajor(reactSpec);
        if (nextMajor != null && reactMajor != null) {
            if (nextMajor >= 15 && reactMajor < 18) {
                risks.push(
                    buildDoctorRisk({
                        id: "bootstrap-doctor-peer-mismatch-next-react",
                        code: "RCK_DEP_PEER_MISMATCH",
                        category: "dependency",
                        message: "Next.js and React major versions look mismatched. Confirm peer dependency compatibility before installing.",
                        evidence: { next: nextSpec, react: reactSpec },
                        manual_review_actions: ["Check Next.js/React peer requirements and adjust versions before running install."],
                    }),
                );
            }
        }
    }

    if ((tailwindSpec || hasTailwindConfig) && !tailwindSpec) {
        risks.push(
            buildDoctorRisk({
                id: "bootstrap-doctor-missing-tailwind",
                code: "RCK_DEP_MISSING_TAILWIND",
                category: "dependency",
                message: "Tailwind config signals are present but tailwindcss dependency is missing.",
                evidence: { hasTailwindConfig },
                manual_review_actions: ["Install Tailwind toolchain: npm install -D tailwindcss postcss autoprefixer"],
            }),
        );
    }

    if (tailwindSpec) {
        const major = parseMajor(tailwindSpec);
        if (major != null && major >= 4) {
            risks.push(
                buildDoctorRisk({
                    id: "bootstrap-doctor-tailwind-v4",
                    code: "RCK_DEP_UNSUPPORTED_COMBO",
                    category: "dependency",
                    message: "tailwindcss@4 detected. Some scaffold recipes and PostCSS setups may not be compatible without manual adjustments.",
                    evidence: { tailwindcss: tailwindSpec },
                    manual_review_actions: [
                        "If you hit build errors, consider switching to tailwindcss@3 and ensure postcss/autoprefixer are installed.",
                        "Alternative: use a fallback CSS scaffold instead of Tailwind.",
                    ],
                }),
            );
        }
    }

    if (tailwindSpec && !hasTailwindConfig) {
        risks.push(
            buildDoctorRisk({
                id: "bootstrap-doctor-missing-tailwind-config",
                code: "RCK_TAILWIND_CONFIG_MISSING",
                category: "config",
                message: "tailwindcss is present but no tailwind config file was found.",
                evidence: { tailwindcss: tailwindSpec },
                safe_actions: ["Create tailwind.config.{js,cjs,mjs,ts}"],
            }),
        );
    }

    if (tailwindSpec && (!postcssSpec || !autoprefixerSpec)) {
        risks.push(
            buildDoctorRisk({
                id: "bootstrap-doctor-missing-postcss-tooling",
                code: "RCK_DEP_MISSING_POSTCSS",
                category: "dependency",
                message: "Tailwind is present but PostCSS tooling dependencies are missing.",
                evidence: { tailwindcss: tailwindSpec, postcss: postcssSpec ?? null, autoprefixer: autoprefixerSpec ?? null },
                manual_review_actions: ["Install PostCSS tooling: npm install -D postcss autoprefixer"],
            }),
        );
    }

    if (hasShadcnConfig && !tailwindSpec) {
        risks.push(
            buildDoctorRisk({
                id: "bootstrap-doctor-shadcn-without-tailwind",
                code: "RCK_DEP_INCOMPLETE_STACK",
                category: "dependency",
                message: "Shadcn UI config (components.json) detected, but Tailwind is not present. Confirm intended styling stack.",
                evidence: { componentsJson: true },
                manual_review_actions: ["If using shadcn/ui, ensure Tailwind is configured and installed."],
            }),
        );
    }

    return { detected, risks };
}

function buildNextShapeRisks({ shape, signals }, pkg) {
    const deps = normalizeDeps(pkg);
    const nextSpec = deps.next ?? null;
    const risks = [];

    if (!nextSpec && shape === "unknown") {
        return { risks, shape };
    }

    if (shape === "unknown") {
        risks.push(
            buildDoctorRisk({
                id: "bootstrap-doctor-next-unknown-shape",
                code: "RCK_NEXT_UNKNOWN_SHAPE",
                category: "project-shape",
                message: "Next.js detected but project shape (app/pages router) could not be determined from files.",
                evidence: { next: nextSpec, signals },
                manual_review_actions: ["Confirm whether this is an app router or pages router project and ensure the expected directories exist."],
            }),
        );
        return { risks, shape };
    }

    if (shape === "app-router") {
        if (!signals.hasLayout) {
            const appDir = preferredAppDir();
            const usesTs = Boolean(signals.usesTypeScript);
            const suggested = `${appDir}/layout.${usesTs ? "tsx" : "js"}`;
            risks.push(
                buildDoctorRisk({
                    id: "bootstrap-doctor-next-missing-layout",
                    code: "RCK_NEXT_MISSING_LAYOUT",
                    category: "project-shape",
                    message: "Next.js app router requires a root layout component.",
                    evidence: { next: nextSpec, expected: suggested },
                    safe_actions: [`Create ${suggested}`],
                    manual_review_actions: ["If you intended pages router, move routing files under pages/ instead of app/."],
                }),
            );
        }
    }

    if (signals.usesTypeScript && !signals.hasNextEnv) {
        risks.push(
            buildDoctorRisk({
                id: "bootstrap-doctor-next-missing-next-env",
                code: "RCK_NEXT_MISSING_NEXT_ENV",
                category: "project-shape",
                message: "TypeScript detected but next-env.d.ts is missing.",
                evidence: { expected: "next-env.d.ts" },
                safe_actions: ["Create next-env.d.ts (as generated by Next.js)"],
            }),
        );
    }

    return { risks, shape };
}

function buildScriptRisks(pkg) {
    const risks = [];
    if (!pkg || !pkg.scripts || typeof pkg.scripts !== "object") {
        return risks;
    }
    const deps = normalizeDeps(pkg);
    const nextSpec = deps.next ?? null;
    if (!nextSpec) return risks;

    const scripts = pkg.scripts;
    const missing = [];
    if (!scripts.dev) missing.push("dev");
    if (!scripts.build) missing.push("build");
    if (!scripts.start) missing.push("start");

    if (missing.length) {
        const safe_actions = [];
        if (missing.includes("dev")) safe_actions.push('Add "dev": "next dev" to package.json scripts');
        if (missing.includes("build")) safe_actions.push('Add "build": "next build" to package.json scripts');
        if (missing.includes("start")) safe_actions.push('Add "start": "next start" to package.json scripts');
        risks.push(
            buildDoctorRisk({
                id: "bootstrap-doctor-missing-scripts",
                code: "RCK_CONFIG_MISSING_SCRIPT",
                category: "config",
                message: `package.json is missing important Next.js scripts: ${missing.join(", ")}`,
                evidence: { missing },
                safe_actions,
            }),
        );
    }
    return risks;
}

function buildConfigRisks(pkg) {
    const risks = [];
    const deps = normalizeDeps(pkg);
    const typescriptSpec = deps.typescript ?? null;
    if (typescriptSpec && !exists("tsconfig.json")) {
        risks.push(
            buildDoctorRisk({
                id: "bootstrap-doctor-missing-tsconfig",
                code: "RCK_CONFIG_MISSING_TSCONFIG",
                category: "config",
                message: "TypeScript dependency is present but tsconfig.json is missing.",
                evidence: { typescript: typescriptSpec },
                safe_actions: ["Create tsconfig.json"],
            }),
        );
    }
    return risks;
}

function readTextIfExists(fullPath, { maxBytes = null } = {}) {
    try {
        if (!fs.existsSync(fullPath)) return null;
        const buffer = fs.readFileSync(fullPath);
        if (Number.isFinite(maxBytes) && maxBytes > 0 && buffer.byteLength > maxBytes) {
            return buffer.subarray(0, maxBytes).toString("utf-8");
        }
        return buffer.toString("utf-8");
    } catch {
        return null;
    }
}

export function buildBootstrapDoctorJsonV1(report) {
    const risks = normalizeDoctorRisks(report?.risks);
    const suggestedActions = report?.actions && typeof report.actions === "object"
        ? {
              safe_actions: Array.isArray(report.actions.safe_actions) ? report.actions.safe_actions.slice(0, MAX_ACTIONS) : [],
              manual_review_actions: Array.isArray(report.actions.manual_review_actions) ? report.actions.manual_review_actions.slice(0, MAX_ACTIONS) : [],
          }
        : { safe_actions: [], manual_review_actions: [] };
    const statusInfo = computeDoctorStatusFromRisks(risks);
    return {
        schema: DOCTOR_SCHEMA_V1,
        status: statusInfo.status,
        projectShape: report?.projectShape ?? { shape: "unknown", signals: {}, missingRequiredFiles: [] },
        dependencyCompatibility: report?.dependencyCompatibility ?? { detected: {}, risks: [] },
        dryRunPlan: report?.dryRunPlan ?? { enabled: false },
        risks,
        suggestedActions,
        boundaries: {
            writes: false,
            installs: false,
            lockfileChanges: false,
            network: false,
        },
    };
}

function collectTieredActions(risks) {
    const safe = new Set();
    const manual = new Set();
    for (const risk of Array.isArray(risks) ? risks : []) {
        for (const action of Array.isArray(risk?.safe_actions) ? risk.safe_actions : []) {
            const text = String(action ?? "").trim();
            if (text) safe.add(text);
        }
        for (const action of Array.isArray(risk?.manual_review_actions) ? risk.manual_review_actions : []) {
            const text = String(action ?? "").trim();
            if (text) manual.add(text);
        }
    }
    return {
        safe_actions: [...safe].sort(),
        manual_review_actions: [...manual].sort(),
    };
}

function formatDoctorStatusBlock(json) {
    const risks = Array.isArray(json?.risks) ? json.risks : [];
    const { highest_severity } = computeDoctorStatusFromRisks(risks);
    return [
        "## Doctor Status",
        "",
        `status: ${json?.status ?? "unknown"}`,
        `risk_count: ${risks.length}`,
        `highest_severity: ${highest_severity}`,
    ].join("\n");
}

function renderDoctorText(report) {
    const json = buildBootstrapDoctorJsonV1(report);
    const lines = ["Bootstrap Doctor", "", formatDoctorStatusBlock(json), ""];
    lines.push("## Dependency Compatibility", "");
    const det = report.dependencyCompatibility.detected;
    const detectedLineParts = [];
    for (const key of ["next", "react", "reactDom", "tailwindcss", "postcss", "autoprefixer"]) {
        const item = det[key];
        if (item?.spec) {
            detectedLineParts.push(`${key}@${item.spec}`);
        }
    }
    lines.push(`Detected: ${detectedLineParts.join(", ") || "-"}`);
    if (det.shadcn) {
        lines.push("Detected: shadcn/ui (components.json)");
    }
    lines.push("");

    lines.push("## Project Shape", "");
    lines.push(`Detected: ${report.projectShape.shape}`);
    if (report.projectShape.shape !== "unknown") {
        const missing = report.projectShape.missingRequiredFiles;
        if (missing.length) {
            lines.push("Missing required files:");
            for (const file of missing) lines.push(`- ${file}`);
        }
    }
    lines.push("");

    lines.push("## Dry Run Plan", "");
    if (report.dryRunPlan?.enabled) {
        lines.push(`fromDoc: ${report.dryRunPlan.fromDoc}`);
        lines.push(`digest: ${report.dryRunPlan.digest}`);
        lines.push(`pauseToken: ${report.dryRunPlan.pauseToken}`);
        if (report.dryRunPlan.matchedRecipeIds.length) {
            lines.push(`matchedRecipes: ${report.dryRunPlan.matchedRecipeIds.join(", ")}`);
        }
        if (report.dryRunPlan.scaffoldHints.length) {
            lines.push("scaffoldHints:");
            for (const hint of report.dryRunPlan.scaffoldHints.slice(0, 3)) {
                const tool = String(hint?.tool ?? "").trim();
                const command = String(hint?.command ?? "").trim();
                const args = Array.isArray(hint?.args) ? hint.args.map((x) => String(x ?? "").trim()).filter(Boolean) : [];
                if (command) {
                    lines.push(`- ${[tool, command, ...args].filter(Boolean).join(" ").trim()}`);
                }
            }
        }
    } else {
        lines.push("No design doc provided. (Pass --from-doc <path> to generate a dry-run bootstrap plan.)");
    }
    lines.push("");

    lines.push("## Risks", "");
    const normalized = json.risks;
    const summary = computeRiskSummary(normalized);
    lines.push(`- error: ${summary.error}, warning: ${summary.warning}, info: ${summary.info}`);
    for (const risk of normalized.slice(0, 20)) {
        lines.push(`- [${risk.severity}] ${risk.code}: ${risk.message}`);
    }
    if (normalized.length > 20) {
        lines.push(`- … (${normalized.length - 20} more)`);
    }
    lines.push("");

    lines.push("## Suggested Actions", "");
    if (report.actions.safe_actions.length) {
        lines.push("safe_actions:");
        for (const action of report.actions.safe_actions) lines.push(`- ${action}`);
    }
    if (report.actions.manual_review_actions.length) {
        lines.push("manual_review_actions:");
        for (const action of report.actions.manual_review_actions) lines.push(`- ${action}`);
    }
    if (!report.actions.safe_actions.length && !report.actions.manual_review_actions.length) {
        lines.push("- (none)");
    }

    return lines.join("\n").trimEnd();
}

function parseGitDirPointer(gitFileText) {
    const raw = String(gitFileText ?? "").trim();
    const match = /^gitdir:\s*(.+)$/i.exec(raw);
    if (!match) return null;
    return String(match[1]).trim();
}

function resolveGitIndexPath(repoRoot) {
    const dotGitPath = path.resolve(repoRoot, ".git");
    try {
        if (!fs.existsSync(dotGitPath)) return null;
        const stat = fs.statSync(dotGitPath);
        if (stat.isDirectory()) {
            const indexPath = path.resolve(dotGitPath, "index");
            return fs.existsSync(indexPath) ? indexPath : null;
        }
        if (stat.isFile()) {
            const text = readTextIfExists(dotGitPath, { maxBytes: 4096 });
            const gitdir = parseGitDirPointer(text);
            if (!gitdir) return null;
            const resolved = path.resolve(repoRoot, gitdir);
            const indexPath = path.resolve(resolved, "index");
            return fs.existsSync(indexPath) ? indexPath : null;
        }
        return null;
    } catch {
        return null;
    }
}

function normalizeGitignoreLines(text) {
    return String(text ?? "")
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
}

function isGitignoreCovering(lines, entry) {
    const raw = String(entry ?? "").trim().replaceAll("\\", "/");
    const variants = new Set([
        raw,
        `/${raw}`,
        `${raw}/`,
        `/${raw}/`,
        `**/${raw}`,
        `**/${raw}/`,
    ]);
    for (const line of lines) {
        const normalized = String(line).trim().replaceAll("\\", "/");
        if (variants.has(normalized)) return true;
    }
    return false;
}

function buildGitIgnoreRisks({ repoRoot }) {
    const gitignorePath = path.resolve(repoRoot, ".gitignore");
    const gitignoreText = readTextIfExists(gitignorePath, { maxBytes: 200_000 });
    const gitignoreLines = normalizeGitignoreLines(gitignoreText ?? "");

    const relevant = [];
    for (const dir of ARTIFACT_DIRS) {
        const existsOnDisk = exists(dir);
        if (existsOnDisk) {
            relevant.push(dir);
        }
    }

    if (relevant.length === 0) {
        return [];
    }

    const missing = relevant.filter((dir) => !isGitignoreCovering(gitignoreLines, dir));
    const risks = [];
    if (missing.length) {
        risks.push(
            buildDoctorRisk({
                id: "bootstrap-doctor-git-missing-ignore",
                code: "RCK_GIT_MISSING_IGNORE",
                category: "git",
                message: "Some build artifact directories exist but are not covered by .gitignore.",
                evidence: { missing, gitignorePresent: Boolean(gitignoreText) },
                safe_actions: missing.map((dir) => `Add ${dir}/ to .gitignore`).slice(0, 12),
            }),
        );
    }

    const indexPath = resolveGitIndexPath(repoRoot);
    if (indexPath) {
        try {
            const buffer = fs.readFileSync(indexPath);
            const slice = buffer.byteLength > MAX_GIT_INDEX_BYTES ? buffer.subarray(0, MAX_GIT_INDEX_BYTES) : buffer;
            const tracked = [];
            for (const dir of relevant) {
                const needle = Buffer.from(`${dir}/`, "utf-8");
                if (slice.includes(needle)) {
                    tracked.push(dir);
                }
            }
            if (tracked.length) {
                risks.push(
                    buildDoctorRisk({
                        id: "bootstrap-doctor-git-build-artifact-tracked",
                        code: "RCK_GIT_BUILD_ARTIFACT_TRACKED",
                        category: "git",
                        message: "Some build artifact paths appear to be tracked by git (heuristic).",
                        evidence: { tracked, gitIndexReadable: true },
                        manual_review_actions: ["Review tracked files and consider removing artifacts from version control."],
                    }),
                );
            }
        } catch {
            return risks;
        }
    }

    return risks;
}

function listFilesBounded(repoRoot, startDir) {
    const results = [];
    const queue = [{ dir: startDir, depth: 0 }];
    while (queue.length && results.length < MAX_REACT_SCAN_FILES) {
        const next = queue.shift();
        const depth = next.depth;
        if (depth > MAX_REACT_SCAN_DEPTH) continue;
        const abs = path.resolve(repoRoot, next.dir);
        let entries = [];
        try {
            entries = fs.readdirSync(abs, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (results.length >= MAX_REACT_SCAN_FILES) break;
            const name = entry.name;
            if (name === "node_modules" || name === ".git" || name === ".next" || name === "dist" || name === "build" || name === "coverage") {
                continue;
            }
            const rel = path.posix.join(next.dir.replaceAll("\\", "/"), name.replaceAll("\\", "/"));
            if (entry.isDirectory()) {
                queue.push({ dir: rel, depth: depth + 1 });
            } else if (entry.isFile()) {
                if (!/\.(jsx|tsx|js|ts)$/i.test(name)) continue;
                results.push(rel);
            }
        }
    }
    return results.sort((a, b) => a.localeCompare(b));
}

function hasUseClientDirective(text) {
    const lines = String(text ?? "").split(/\r?\n/g).slice(0, 40);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("//")) continue;
        if (trimmed.startsWith("/*")) continue;
        if (trimmed === '"use client";' || trimmed === "'use client';" || trimmed === '"use client"' || trimmed === "'use client'") {
            return true;
        }
        return false;
    }
    return false;
}

function detectClientSignals(text) {
    const signals = [];
    const hay = String(text ?? "");
    const hookPatterns = [
        /\buseState\s*\(/,
        /\buseEffect\s*\(/,
        /\buseRef\s*\(/,
        /\buseReducer\s*\(/,
    ];
    const browserPatterns = [
        /\bwindow\./,
        /\bdocument\./,
        /\blocalStorage\b/,
        /\bsessionStorage\b/,
        /\bnavigator\./,
    ];
    if (hookPatterns.some((re) => re.test(hay))) signals.push("react_hooks");
    if (browserPatterns.some((re) => re.test(hay))) signals.push("browser_apis");
    return signals;
}

function buildReactClientRisks({ repoRoot, nextShape, pkg }) {
    const deps = normalizeDeps(pkg);
    const nextSpec = deps.next ?? null;
    if (!nextSpec) return [];
    if (!nextShape || (nextShape.shape !== "app-router" && nextShape.shape !== "hybrid")) return [];

    const dirs = [];
    if (isDirectory("app")) dirs.push("app");
    if (isDirectory("src/app")) dirs.push("src/app");
    if (dirs.length === 0) return [];

    const findings = [];
    for (const dir of dirs) {
        for (const relPath of listFilesBounded(repoRoot, dir)) {
            if (findings.length >= MAX_REACT_RISK_FILES) break;
            const abs = path.resolve(repoRoot, relPath);
            const text = readTextIfExists(abs, { maxBytes: MAX_REACT_FILE_BYTES });
            if (!text) continue;
            const hasDirective = hasUseClientDirective(text);
            const signals = detectClientSignals(text);
            if (signals.length === 0) continue;
            if (hasDirective) continue;
            findings.push({ path: relPath, signals });
        }
        if (findings.length >= MAX_REACT_RISK_FILES) break;
    }

    if (findings.length === 0) return [];

    return [
        buildDoctorRisk({
            id: "bootstrap-doctor-next-client-component-risk",
            code: "RCK_NEXT_CLIENT_COMPONENT_RISK",
            category: "project-shape",
            message: 'Potential client component risk: hooks/browser APIs used without a "use client" directive (heuristic).',
            evidence: { files: findings },
            manual_review_actions: ['Review whether the flagged files should include "use client".'],
        }),
    ];
}

export function bootstrapDoctor({ repoRoot, fromDoc = null } = {}) {
    const root = String(repoRoot ?? "").trim() || process.cwd();
    return withRepoRoot(root, () => {
        const pkg = getPackageJson();
        const dependencyCompatibility = buildDependencyCompatibilityRisks(pkg);

        const nextShape = detectNextShape();
        const projectShapeRisks = buildNextShapeRisks(nextShape, pkg);
        const scriptRisks = buildScriptRisks(pkg);
        const configRisks = buildConfigRisks(pkg);
        const gitRisks = buildGitIgnoreRisks({ repoRoot: root });
        const reactRisks = buildReactClientRisks({ repoRoot: root, nextShape, pkg });

        const projectShape = {
            shape: projectShapeRisks.shape,
            signals: nextShape.signals,
            missingRequiredFiles: [],
        };
        for (const risk of projectShapeRisks.risks) {
            const expected = String(risk?.evidence?.expected ?? "").trim();
            if (risk.code === "RCK_NEXT_MISSING_LAYOUT" && expected) {
                projectShape.missingRequiredFiles.push(expected);
            }
            if (risk.code === "RCK_NEXT_MISSING_NEXT_ENV") {
                projectShape.missingRequiredFiles.push("next-env.d.ts");
            }
        }
        projectShape.missingRequiredFiles = [...new Set(projectShape.missingRequiredFiles)].sort();

        const risks = [
            ...dependencyCompatibility.risks,
            ...projectShapeRisks.risks,
            ...scriptRisks,
            ...configRisks,
            ...gitRisks,
            ...reactRisks,
        ];

        let dryRunPlan = { enabled: false, note: "No design doc provided." };
        if (fromDoc) {
            const planned = planBootstrapRuntime({ repoRoot: root, fromDoc, writeMode: "create-only" });
            dryRunPlan = {
                enabled: true,
                fromDoc: planned.fromDoc,
                digest: planned.digest,
                pauseToken: planned.pauseToken,
                matchedRecipeIds: Array.isArray(planned.matchedRecipeIds) ? planned.matchedRecipeIds.slice(0, 12) : [],
                scaffoldHints: Array.isArray(planned.scaffoldHints) ? planned.scaffoldHints.slice(0, 12) : [],
                planOps: Array.isArray(planned.plan?.ops) ? planned.plan.ops.length : 0,
                note: "Dry-run plan only. No files were written, no installs were performed.",
            };
        }

        const normalizedRisks = normalizeDoctorRisks(risks);
        const actions = collectTieredActions(normalizedRisks);
        const report = {
            ok: true,
            command: "bootstrap",
            action: "doctor",
            repoRoot: root,
            dependencyCompatibility,
            projectShape,
            dryRunPlan,
            risks: normalizedRisks,
            actions,
        };

        return {
            report,
            json: buildBootstrapDoctorJsonV1(report),
            text: renderDoctorText(report),
        };
    });
}
