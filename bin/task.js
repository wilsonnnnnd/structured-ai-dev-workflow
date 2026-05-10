#!/usr/bin/env node
import fs from "node:fs";
import path from "path";
import { buildWorksetContext } from "./context.js";
import {
    CONTEXT_PROJECT_MD_PATH,
    CONTEXT_SYSTEM_OVERVIEW_PATH,
    CONTEXT_TASKS_PATH,
    TASK_REGISTRY_PATH,
} from "../src/scan/constants.js";
import { exists, isDirectory, listDirSafe, readText, writeText } from "../src/scan/fs-utils.js";
import { evaluateContextLoop } from "../src/loop/analyze.js";
import { appendLoopEvent } from "../src/loop/store.js";
import { resolveBudgetMode } from "../src/budget/policy.js";
import { buildBudgetDecisionEvent, formatBudgetDecisionMarkdown } from "../src/budget/decision.js";
import { resolveCurrentGitBranch, resolveGitHubRepoFromGitRemote } from "../src/github/git.js";
import { createPullRequest } from "../src/github/pulls.js";
import { getGitHubTokenFromUserConfig } from "../src/github/auth.js";
import { buildTaskMap } from "../src/scan/indexers/project-index.js";
import {
    appendTaskToRegistry,
    ensureTaskRegistry,
    getKnownTaskIds,
    parseTaskRegistry,
} from "../src/scan/task-registry.js";
import { loadDesignDoc } from "../src/docs/doc-loader.js";
import { extractPlanningData } from "../src/docs/doc-extractor.js";
import { serializeJson } from "../src/runtime/serialize.js";
import { getRepoRoot } from "../src/runtime/root-context.js";
import { bootstrapDoctor } from "../src/bootstrap/doctor.js";

const TASK_DIR = "task";
const DOC_TASK_LIMIT = 10;
const PROMPT_LIMITS = {
    default: 20000,
    deep: 28000,
};
const CHECKLIST_LIMITS = {
    default: 14000,
    deep: 20000,
};
const PR_LIMITS = {
    default: 14000,
    deep: 20000,
};

function maybeAppendLearnableTaskEvent(event) {
    if (!isDirectory(".aidw")) {
        return null;
    }

    try {
        return appendLoopEvent(event);
    } catch {
        return null;
    }
}

function renderLoopSignals(taskId, taskTitle) {
    const result = evaluateContextLoop({ taskId, requestedTitle: taskTitle });
    const last = result.mostRecentTest;
    const lastSummary = last
        ? `${Number(last.exitCode) === 0 ? "pass" : "fail"} (exit ${last.exitCode ?? "?"})${last.command ? `: ${last.command}` : ""}`
        : "-";
    const topFail = result.patterns.topFailingCommands?.[0]?.command ?? "-";

    return [
        "## Context Loop Signals",
        "",
        `- block_new_task: ${result.constraints.blockNewTask ? "true" : "false"}`,
        `- unstable: ${result.constraints.unstable ? "true" : "false"}`,
        `- last_test: ${lastSummary}`,
        `- failure_streak: ${result.patterns.failureStreak}`,
        `- top_failing_command: ${topFail}`,
        `- require_rca: ${result.constraints.requireRootCauseAnalysis ? "true" : "false"}`,
    ].join("\n");
}

function toTitleCase(slug) {
    return slug
        .split("-")
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}

function normalizeTitle(title) {
    return title
        .trim()
        .split(/\s+/)
        .map((word) =>
            /^[A-Z0-9]+$/.test(word)
                ? word
                : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
        )
        .join(" ");
}

function slugify(title) {
    const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

    return slug || "new-task";
}

function getNextTaskNumber() {
    const fileNumbers = listDirSafe(TASK_DIR)
        .map((fileName) => fileName.match(/^T-(\d{3})\b/i)?.[1])
        .filter(Boolean)
        .map((value) => Number.parseInt(value, 10));
    const numbers = [...fileNumbers, ...getKnownTaskIds()];
    const next = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;

    return String(next).padStart(3, "0");
}

function detectDefaultTestCommand() {
    const hasPackageJson = exists("package.json");
    const hasPythonConfig =
        exists("pyproject.toml") ||
        exists("requirements.txt") ||
        exists("pytest.ini");

    if (hasPackageJson) {
        return "npm test";
    }

    if (hasPythonConfig) {
        return "pytest";
    }

    return "TODO: add test command";
}

function toBulletList(items, fallback) {
    const cleaned = (items ?? [])
        .map((item) => String(item ?? "").trim())
        .filter(Boolean);
    if (cleaned.length === 0) {
        return `- ${fallback}`;
    }
    return cleaned.map((item) => `- ${item}`).join("\n");
}

function getArgValue(args, name) {
    const index = args.indexOf(name);
    if (index === -1) return null;
    const value = args[index + 1];
    if (!value || String(value).startsWith("--")) return null;
    return String(value);
}

function planDocWarnings(doc, planning) {
    const warnings = [];
    const hits = planning?.analysis?.sectionHits && typeof planning.analysis.sectionHits === "object"
        ? planning.analysis.sectionHits
        : {};
    for (const key of ["goals", "requirements", "scope", "acceptanceCriteria", "constraints"]) {
        const count = Number(hits[key] ?? 0);
        if (count >= 2) {
            warnings.push(`Multiple '${key}' sections detected; extraction uses the first matching section order.`);
        }
    }
    if (!Array.isArray(planning?.acceptanceCriteria) || planning.acceptanceCriteria.length === 0) {
        warnings.push("Missing acceptance criteria section or bullets.");
    }
    if (!Array.isArray(planning?.scope) || planning.scope.length === 0) {
        warnings.push("Missing scope section or bullets.");
    }
    const sizeBytes = Number(doc?.metadata?.sizeBytes ?? 0);
    if (Number.isFinite(sizeBytes) && sizeBytes > 160 * 1024) {
        warnings.push("Design doc is large; consider adding a short summary at the top.");
    }
    if (planning?.analysis?.conflictingRequirements === true) {
        warnings.push("Potential conflicting requirements detected (heuristic).");
    }
    return warnings.sort((a, b) => a.localeCompare(b));
}

function seedDocConstraints(constraints = []) {
    const out = [];
    const items = Array.isArray(constraints) ? constraints : [];
    for (const item of items) {
        const text = String(item ?? "").trim();
        if (!text) continue;
        out.push(`Constraint: ${text}`);
    }
    return out;
}

function buildDocTaskSeeds(doc, planning) {
    const suggested = Array.isArray(planning?.suggestedTasks) ? planning.suggestedTasks : [];
    const goals = Array.isArray(planning?.goals) ? planning.goals : [];
    const requirements = Array.isArray(planning?.requirements) ? planning.requirements : [];
    const acceptanceCriteria = Array.isArray(planning?.acceptanceCriteria) ? planning.acceptanceCriteria : [];
    const constraints = Array.isArray(planning?.constraints) ? planning.constraints : [];
    const scope = Array.isArray(planning?.scope) ? planning.scope : [];
    const titleFallback = String(doc?.metadata?.title ?? "").trim() || "Doc Task";

    const titles = suggested.length > 0 ? suggested : goals.length > 1 ? goals : [titleFallback];
    const boundedTitles = titles.map((t) => String(t ?? "").trim()).filter(Boolean).slice(0, DOC_TASK_LIMIT);
    const out = [];
    for (const title of boundedTitles) {
        const normalizedTitle = normalizeTitle(title.length > 80 ? `${title.slice(0, 77).trimEnd()}...` : title);
        out.push({
            title: normalizedTitle,
            goal: String(goals[0] ?? titleFallback).trim() || normalizedTitle,
            requirementItems: [...requirements, ...seedDocConstraints(constraints)].slice(0, 24),
            acceptanceCriteriaItems: acceptanceCriteria.slice(0, 16),
            scopeItems: scope.slice(0, 16),
        });
    }
    return out;
}

const DEFAULT_HARD_BOUNDARIES = [
    "Do not run commands (including tests) without explicit confirmation.",
    "Do not modify files outside the current task Scope.",
    "Do not edit generated `.aidw/index/*` files manually.",
    "Do not commit, push, or create PRs unless explicitly requested.",
    "Do not access, print, or log secrets or environment values.",
];

const DEFAULT_CONFIRMATION_POINTS = [
    "Confirm scope and planned approach before making any file edits.",
    "Confirm before applying changes that touch multiple files or shared modules.",
    "Confirm before running tests (prefer the confirmation gate when available).",
    "Confirm before committing, pushing, or opening a PR.",
];

function buildTaskTemplate(taskId, title, testCommand, seed = {}) {
    const requirements = toBulletList(seed.requirementItems, " ");
    const risk = toBulletList(seed.riskItems, " ");
    const testStrategy = toBulletList(seed.testStrategyItems, " ");
    const acceptanceCriteria = toBulletList(seed.acceptanceCriteriaItems, " ");
    return `# ${taskId} ${title}

## Goal

Describe the user-facing or developer-facing outcome.

## Background

Explain why this task exists and any product/domain boundaries.

## Scope

Allowed to change:

- 

Do not change:

- 

## Hard Boundaries

${formatList(DEFAULT_HARD_BOUNDARIES)}

## Confirmation Points

${formatList(DEFAULT_CONFIRMATION_POINTS)}

## Requirements

${requirements}

## Risk

${risk}

## Test Strategy

${testStrategy}

## Acceptance Criteria

${acceptanceCriteria}

## Test Command

\`\`\`bash
${testCommand}
\`\`\`

## Definition of Done

- Code implemented.
- Tests added or updated.
- Test command passes.
- Summary includes changed files and verification.
`;
}

function findTaskById(registry, taskId) {
    return registry.tasks.find((task) => task.id.toLowerCase() === taskId.toLowerCase()) ?? null;
}

function normalizeDependencies(dependencies) {
    const raw = String(dependencies ?? "").trim();

    if (!raw || raw === "-") {
        return [];
    }

    return raw
        .split(/[, ]+/)
        .map((dependency) => dependency.trim())
        .filter(Boolean);
}

function formatList(items) {
    if (items.length === 0) {
        return "- None";
    }

    return items.map((item) => `- ${item}`).join("\n");
}

function renderBootstrapDoctorSummary({ maxRisks = 5, maxActions = 6 } = {}) {
    const root = getRepoRoot();
    try {
        const doctor = bootstrapDoctor({ repoRoot: root });
        const payload = doctor?.json && typeof doctor.json === "object" ? doctor.json : null;
        if (!payload) {
            return [
                "## Bootstrap Doctor Summary",
                "",
                "- status: unavailable",
                "- reason: doctor output is missing",
                "- boundaries: writes=false installs=false lockfileChanges=false network=false",
            ].join("\n");
        }

        const shape = String(payload?.projectShape?.shape ?? "unknown");
        const risks = Array.isArray(payload.risks) ? payload.risks : [];
        const safe = Array.isArray(payload?.suggestedActions?.safe_actions) ? payload.suggestedActions.safe_actions : [];
        const manual = Array.isArray(payload?.suggestedActions?.manual_review_actions) ? payload.suggestedActions.manual_review_actions : [];
        const topRisks = risks.slice(0, Math.max(0, Number(maxRisks) || 0));
        const topSafe = safe.slice(0, Math.max(0, Number(maxActions) || 0));
        const topManual = manual.slice(0, Math.max(0, Number(maxActions) || 0));

        const lines = [
            "## Bootstrap Doctor Summary",
            "",
            `- status: ${payload.status}`,
            `- project_shape: ${shape}`,
            "",
        ];
        if (topRisks.length) {
            lines.push("Top risks:");
            for (const risk of topRisks) {
                const sev = String(risk?.severity ?? "").trim();
                const code = String(risk?.code ?? "").trim();
                const msg = String(risk?.message ?? "").trim();
                lines.push(`- [${sev}] ${code}: ${msg}`);
            }
            lines.push("");
        }
        if (topSafe.length) {
            lines.push("safe_actions:");
            for (const action of topSafe) lines.push(`- ${action}`);
            lines.push("");
        }
        if (topManual.length) {
            lines.push("manual_review_actions:");
            for (const action of topManual) lines.push(`- ${action}`);
            lines.push("");
        }
        lines.push("Boundaries:");
        lines.push("- writes: false");
        lines.push("- installs: false");
        lines.push("- lockfileChanges: false");
        lines.push("- network: false");

        const manualRequired = topManual.length > 0 || payload.status === "error";
        lines.push("");
        lines.push("## Doctor Gate Reminder");
        lines.push("");
        lines.push(`- highest_severity: ${payload.status === "error" ? "error" : payload.status === "warning" ? "warning" : "info"}`);
        lines.push(`- unresolved_risks: ${risks.length}`);
        lines.push(`- manual_review_required: ${manualRequired ? "true" : "false"}`);

        return lines.join("\n").trimEnd();
    } catch (error) {
        const message = error?.message ? String(error.message) : String(error);
        return [
            "## Bootstrap Doctor Summary",
            "",
            "- status: unavailable",
            `- reason: ${message}`,
            "- boundaries: writes=false installs=false lockfileChanges=false network=false",
            "",
            "## Doctor Gate Reminder",
            "",
            "- highest_severity: unknown",
            "- unresolved_risks: 0",
            "- manual_review_required: true",
        ].join("\n");
    }
}

function extractSection(content, heading) {
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(
        `(?:^|\\n)##\\s+${escapedHeading}\\s*\\n(?<body>[\\s\\S]*?)(?=\\n##\\s|$)`,
        "i",
    );
    const match = content.match(regex);

    return match?.groups?.body?.trim() ?? "";
}

function getTaskGuardSection(taskDetail, heading, fallbackItems, warnings) {
    const body = extractSection(taskDetail, heading);
    if (body) {
        return body;
    }
    warnings.push(`Task detail missing "${heading}" section; using defaults.`);
    return formatList(fallbackItems);
}

function extractWorksetSection(workset, heading) {
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(
        `(?:^|\\n)##\\s+${escapedHeading}\\s*\\n(?<body>[\\s\\S]*?)(?=\\n##\\s|$)`,
        "i",
    );
    const match = workset.match(regex);

    return match?.groups?.body?.trim() ?? "";
}

function toCheckboxItems(content, fallback) {
    const items = String(content ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.replace(/^[-*]\s+/, "").replace(/^\[[ xX]\]\s+/, ""))
        .filter(Boolean);

    if (items.length === 0) {
        return [`- [ ] ${fallback}`];
    }

    return items.map((item) => `- [ ] ${item}`);
}

function getDependencySummaries(task, registry) {
    return normalizeDependencies(task.dependencies).map((dependencyId) => {
        const dependency = findTaskById(registry, dependencyId);

        if (!dependency) {
            return `${dependencyId}: not found in ${TASK_REGISTRY_PATH}`;
        }

        return `${dependency.id}: ${dependency.title} (${dependency.status || "unknown"})`;
    });
}

function readTaskDetail(task, warnings) {
    if (!task.file) {
        warnings.push(`Task ${task.id} has no detail file listed.`);
        return "";
    }

    if (!exists(task.file)) {
        warnings.push(`Task detail file is missing: ${task.file}.`);
        return "";
    }

    return readText(task.file);
}

function normalizeTaskId(taskId) {
    return String(taskId ?? "").trim().toUpperCase();
}

function isCompletedStatus(status) {
    const normalized = String(status ?? "").trim().toLowerCase();
    return normalized === "done" || normalized === "completed";
}

function resolveTaskFileForCleanup(taskId) {
    const id = normalizeTaskId(taskId);
    const fileNames = listDirSafe(TASK_DIR);
    const matches = fileNames.filter(
        (fileName) => new RegExp(`^${id}-[^/\\\\]+\\.md$`, "i").test(String(fileName ?? "").trim()),
    );
    if (matches.length !== 1) {
        return null;
    }
    return path.posix.join(TASK_DIR, matches[0]);
}

function extractFirstMeaningfulLine(markdown) {
    const lines = String(markdown ?? "")
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !line.startsWith("#"))
        .filter((line) => !line.startsWith("<!--"));
    return lines[0] ?? "-";
}

function appendTaskHistoryEntry(entry) {
    const archivePath = path.posix.join(TASK_DIR, "archive", "task-history.md");
    const current = exists(archivePath) ? readText(archivePath).replace(/\r\n/g, "\n").trimEnd() : "";
    const next = current ? `${current}\n\n${entry.trimEnd()}\n` : `${entry.trimEnd()}\n`;
    writeText(archivePath, next);
    return archivePath;
}

function removeTaskRowFromRegistry(taskId) {
    const id = normalizeTaskId(taskId);
    const content = readText(TASK_REGISTRY_PATH).replace(/\r\n/g, "\n");
    const lines = content.split("\n");
    let removed = 0;
    const nextLines = lines.filter((line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("|")) {
            return true;
        }
        const cells = trimmed
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((cell) => cell.trim());
        if (cells.length < 1) {
            return true;
        }
        const first = String(cells[0] ?? "").trim();
        if (!first || first.toLowerCase() === "id" || /^-+$/.test(first)) {
            return true;
        }
        if (first.toUpperCase() !== id) {
            return true;
        }
        removed += 1;
        return false;
    });

    if (removed !== 1) {
        return { ok: false, removed: 0 };
    }

    const next = `${nextLines.join("\n").trimEnd()}\n`;
    writeText(TASK_REGISTRY_PATH, next);
    return { ok: true, removed };
}

function regenerateTasksJson() {
    const tasks = buildTaskMap();
    writeText(CONTEXT_TASKS_PATH, `${JSON.stringify(tasks, null, 4)}\n`);
    return CONTEXT_TASKS_PATH;
}

function formatOutputSection(title, items) {
    if (!items || items.length === 0) {
        return [];
    }

    return [title, ...items.map((item) => `* ${item}`), ""];
}

function getErrorMessage(error) {
    if (error && typeof error === "object" && "message" in error) {
        return String(error.message);
    }

    return String(error);
}

function refreshTaskContextIfAvailable() {
    if (!isDirectory(".aidw")) {
        return {
            updated: [],
            warnings: [],
        };
    }

    try {
        return {
            updated: [regenerateTasksJson()],
            warnings: [],
        };
    } catch (error) {
        return {
            updated: [],
            warnings: [`Unable to refresh ${CONTEXT_TASKS_PATH}: ${getErrorMessage(error)}`],
        };
    }
}

function renderFileMutationSummary(title, { created = [], updated = [], removed = [], archived = [], warnings = [] }) {
    const output = [
        title,
        "",
        ...formatOutputSection("Created:", created),
        ...formatOutputSection("Updated:", updated),
        ...formatOutputSection("Removed:", removed),
        ...formatOutputSection("Archived:", archived),
        ...formatOutputSection("Warnings:", warnings),
    ].join("\n");

    return output.trimEnd();
}

function planTaskCleanup(task) {
    const resolvedTaskFile = resolveTaskFileForCleanup(task.id);
    const created = [];
    const updated = [TASK_REGISTRY_PATH];
    const removed = [resolvedTaskFile];
    const archived = [path.posix.join(TASK_DIR, "archive", "task-history.md")];

    if (isDirectory(".aidw")) {
        updated.push(CONTEXT_TASKS_PATH);
    }

    return {
        created,
        updated,
        removed,
        archived,
    };
}

function runTaskCleanup(taskId, options = {}) {
    const registry = parseTaskRegistry();
    const task = registry.exists ? findTaskById(registry, taskId) : null;

    if (!registry.exists || !task || !isCompletedStatus(task.status)) {
        console.error("Task is not completed. Cleanup aborted.");
        process.exitCode = 1;
        return { ok: false };
    }

    const resolvedTaskFile = resolveTaskFileForCleanup(task.id);
    if (!resolvedTaskFile || !exists(resolvedTaskFile)) {
        console.error("Task file not found. Cleanup aborted.");
        process.exitCode = 1;
        return { ok: false };
    }

    const dryRunPlan = planTaskCleanup(task);
    if (options.dryRun) {
        console.log(
            renderFileMutationSummary("INFO Dry run: task cleanup would make these changes", dryRunPlan),
        );
        return {
            ok: true,
            dryRun: true,
            ...dryRunPlan,
        };
    }

    const taskDetail = readText(resolvedTaskFile);
    const summary = extractFirstMeaningfulLine(taskDetail);
    const completedAt = new Date().toISOString();
    const archiveEntry = [
        `## ${task.id} ${task.title}`,
        `- Completed at: ${completedAt}`,
        `- Owner: ${task.owner || "-"}`,
        `- Summary: ${summary}`,
    ].join("\n");
    const archivedPath = appendTaskHistoryEntry(archiveEntry);

    fs.unlinkSync(path.resolve(process.cwd(), resolvedTaskFile));

    const registryUpdate = removeTaskRowFromRegistry(task.id);
    if (!registryUpdate.ok) {
        console.error("Task registry update failed. Cleanup aborted.");
        process.exitCode = 1;
        return { ok: false };
    }

    const created = [];
    const updated = [TASK_REGISTRY_PATH];
    const removed = [resolvedTaskFile];
    const archived = [archivedPath];
    const contextRefresh = refreshTaskContextIfAvailable();
    updated.push(...contextRefresh.updated);

    console.log(
        renderFileMutationSummary("OK Task cleanup completed", {
            created,
            updated,
            removed,
            archived,
            warnings: contextRefresh.warnings,
        }),
    );
    return {
        ok: true,
        removed: resolvedTaskFile,
        updated,
        archived: archivedPath,
        warnings: contextRefresh.warnings,
    };
}

function renderTaskOutputManifestText({
    level,
    taskId,
    deep,
    maxChars,
    warnings,
    excludedSources = [],
}) {
    return [
        "## Context Manifest",
        "",
        `- context level: ${level}`,
        `- selected task id: ${taskId ?? "none"}`,
        `- included sources: ${getTaskIncludedSources(deep).join(", ")}`,
        `- excluded sources: ${getTaskExcludedSources(excludedSources).join(", ")}`,
        `- limits used: maxChars=${maxChars}, worksetMode=${deep ? "deep" : "default"}`,
        `- warnings: ${warnings.length ? [...new Set(warnings)].join(" | ") : "none"}`,
    ].join("\n");
}

function getTaskIncludedSources(deep) {
    return [
        TASK_REGISTRY_PATH,
        "selected task detail when available",
        `context workset ${deep ? "--deep" : "default"}`,
    ];
}

function getTaskExcludedSources(excludedSources = []) {
    return [
        "unselected task detail files",
        "full files.json dump",
        "full symbols.json dump",
        "generated index dumps",
        ...excludedSources,
    ];
}

function renderWarningsSummary(warnings, options = {}) {
    const unique = [...new Set(warnings)];
    if (unique.length === 0) {
        return "";
    }
    if (options.verbose) {
        return `## Warnings\n\n${formatList(unique)}`;
    }
    const shown = unique.slice(0, 3);
    const more = unique.length - shown.length;
    const suffix = more > 0 ? `(+${more} more; use --verbose)` : "";
    return `## Warnings\n\n${formatList(shown)}${suffix ? `\n\n- ${suffix}` : ""}`;
}

function renderTaskOutputMeta(
    {
        level,
        taskId,
        deep,
        maxChars,
        warnings,
        excludedSources = [],
    },
    options = {},
) {
    const uniqueWarnings = [...new Set(warnings)];
    const includedSources = getTaskIncludedSources(deep);
    const excludedSourceList = getTaskExcludedSources(excludedSources);
    const lines = [
        "## Context Meta",
        "",
        `- level: ${level}`,
        `- selected task id: ${taskId ?? "none"}`,
        `- included sources: ${includedSources.length}`,
        `- excluded sources: ${excludedSourceList.length}`,
        `- limits: maxChars=${maxChars}, worksetMode=${deep ? "deep" : "default"}`,
        `- warnings: ${uniqueWarnings.length}`,
    ];

    if (options.manifest) {
        lines.push(
            "",
            renderTaskOutputManifestText({
                level,
                taskId,
                deep,
                maxChars,
                warnings: uniqueWarnings,
                excludedSources,
            }),
        );
    }

    return lines.join("\n");
}

function renderTaskOutputFooter(manifestOptions, options = {}) {
    const warningsUnique = [...new Set(manifestOptions.warnings)];
    const budgetEnabled = options.budget === "auto" || options.budget === "full";
    const budgetBlock = budgetEnabled
        ? formatBudgetDecisionMarkdown(options.budgetDecision, {
              warningsCount: warningsUnique.length,
              failureStreak: options.budgetFailureStreak ?? null,
              signalCount: options.budgetSignalCount ?? null,
          })
        : "";
    const warningsBlock = renderWarningsSummary(manifestOptions.warnings, options);
    const metaBlock = renderTaskOutputMeta(manifestOptions, options);
    const footer = [budgetBlock, warningsBlock, metaBlock].filter(Boolean).join("\n\n");

    if (budgetEnabled) {
        const event = buildBudgetDecisionEvent(options.budgetDecision, {
            taskId: manifestOptions.taskId,
            warningsCount: warningsUnique.length,
            failureStreak: options.budgetFailureStreak ?? null,
            signalCount: options.budgetSignalCount ?? null,
            command: manifestOptions.level,
        });
        if (event) {
            appendLoopEvent(event);
        }
    }

    return footer;
}

function renderPromptFooter(options, outputOptions) {
    return renderTaskOutputFooter(
        {
            ...options,
            level: "task prompt",
        },
        outputOptions,
    );
}

function renderChecklistFooter(options, outputOptions) {
    return renderTaskOutputFooter(
        {
            ...options,
            level: "task checklist",
        },
        outputOptions,
    );
}

function renderPrFooter(options, outputOptions) {
    return renderTaskOutputFooter(
        {
            ...options,
            level: "task pr",
            excludedSources: ["git diff", "GitHub data"],
        },
        outputOptions,
    );
}

function renderBoundedPrompt(parts, footer, maxChars) {
    let body = parts.filter(Boolean).join("\n\n").trim();
    let output = `${body}${footer ? `\n\n${footer}` : ""}\n`;

    if (output.length <= maxChars) {
        return output;
    }

    body = `${body.slice(0, Math.max(0, maxChars - String(footer ?? "").length - 80)).trimEnd()}\n[truncated]`;
    output = `${body}${footer ? `\n\n${footer}` : ""}\n`;

    if (output.length <= maxChars) {
        return output;
    }

    return output.slice(0, Math.max(0, maxChars - 14)).trimEnd() + "\n[truncated]\n";
}

function getLikelyTestFiles(workset) {
    return [
        ...new Set(
            (workset.match(/(?:^|\s)((?:test|tests)\/[A-Za-z0-9._/-]+)/gm) ?? [])
                .map((match) => match.trim().replace(/^[-*]\s+/, "").split(/\s+/)[0])
                .map((filePath) => filePath.replace(/[),.;]+$/g, "")),
        ),
    ];
}

function summarizeTaskDetailForPrompt(taskDetail) {
    const content = String(taskDetail ?? "").trim();
    if (!content) {
        return "";
    }

    const headings = [
        "Goal",
        "Background",
        "Scope",
        "Requirements",
        "Risk",
        "Test Strategy",
        "Acceptance Criteria",
        "Test Command",
    ];

    const sections = headings
        .map((heading) => {
            const body = extractSection(content, heading);
            return body ? `### ${heading}\n\n${body}` : null;
        })
        .filter(Boolean);

    if (sections.length === 0) {
        return content.length > 3000 ? `${content.slice(0, 2985).trimEnd()}\n[truncated]` : content;
    }

    const joined = sections.join("\n\n");
    return joined.length > 6000 ? `${joined.slice(0, 5985).trimEnd()}\n[truncated]` : joined;
}

function buildTaskPrDescription(taskId, options = {}) {
    const budget = options.budget || "off";
    const base = {
        deep: Boolean(options.deep),
        fullWorkset: Boolean(options.fullWorkset),
        manifest: Boolean(options.manifest),
        verbose: Boolean(options.verbose),
    };
    let deep = Boolean(options.deep);
    let fullWorkset = Boolean(options.fullWorkset);
    let manifest = Boolean(options.manifest);
    let verbose = Boolean(options.verbose);
    let maxChars = deep ? PR_LIMITS.deep : PR_LIMITS.default;
    const warnings = [];
    const registry = parseTaskRegistry();

    if (budget === "full") {
        if (!options.deepLocked) deep = true;
        if (!options.fullWorksetLocked) fullWorkset = true;
        if (!options.manifestLocked) manifest = true;
        if (!options.verboseLocked) verbose = true;
        maxChars = deep ? PR_LIMITS.deep : PR_LIMITS.default;
    }

    if (!taskId) {
        warnings.push("Missing task id.");
        return renderBoundedPrompt([
            "# Pull Request Description",
            "Warning: missing task id.",
            "Usage: repo-context-kit task pr <taskId> [--deep]",
        ], renderPrFooter({ taskId: null, deep, maxChars, warnings }, { ...options, manifest, verbose, budget }), maxChars);
    }

    if (!registry.exists) {
        warnings.push(`${TASK_REGISTRY_PATH} is missing. Create tasks with repo-context-kit task new or restore the task registry.`);
        return renderBoundedPrompt([
            "# Pull Request Description",
            `Warning: ${TASK_REGISTRY_PATH} is missing.`,
            "A PR description could not be generated because the task registry is required to resolve task IDs.",
        ], renderPrFooter({ taskId, deep, maxChars, warnings }, { ...options, manifest, verbose, budget }), maxChars);
    }

    const task = findTaskById(registry, taskId);

    if (!task) {
        warnings.push(`Task ${taskId} was not found in ${TASK_REGISTRY_PATH}.`);
        return renderBoundedPrompt([
            "# Pull Request Description",
            `Warning: task not found: ${taskId}.`,
            `Check ${TASK_REGISTRY_PATH} for available task IDs.`,
        ], renderPrFooter({ taskId, deep, maxChars, warnings }, { ...options, manifest, verbose, budget }), maxChars);
    }

    const taskDetail = readTaskDetail(task, warnings);
    const goal = extractSection(taskDetail, "Goal") || "Address the selected task using the available registry metadata and workset context.";
    const hardBoundaries = getTaskGuardSection(taskDetail, "Hard Boundaries", DEFAULT_HARD_BOUNDARIES, warnings);
    const confirmationPoints = getTaskGuardSection(taskDetail, "Confirmation Points", DEFAULT_CONFIRMATION_POINTS, warnings);
    const scope = extractSection(taskDetail, "Scope");
    const acceptanceCriteria = extractSection(taskDetail, "Acceptance Criteria");
    const loopResult = budget === "auto" || budget === "full"
        ? evaluateContextLoop({ taskId: task.id, requestedTitle: task.title })
        : null;
    const hasFailedTest = Boolean(loopResult?.mostRecentTest && Number(loopResult.mostRecentTest.exitCode) !== 0);

    let workset = buildWorksetContext(task.id, { deep, digest: !deep && !fullWorkset });
    let riskAreas = extractWorksetSection(workset, "Relevant Risk Areas");
    let relatedFiles = extractWorksetSection(workset, "Related File Candidates");
    const hasRiskAreas = Boolean(riskAreas && !riskAreas.includes("_No indexed risk areas were available._"));
    const staleScan = workset.includes("Run repo-context-kit scan");
    const exceptionBudget = budget === "auto" && Boolean(
        hasFailedTest ||
        loopResult?.constraints?.unstable ||
        loopResult?.constraints?.requireRootCauseAnalysis ||
        hasRiskAreas ||
        staleScan,
    );

    if (exceptionBudget) {
        if (!options.verboseLocked) verbose = true;
        if (!options.fullWorksetLocked) fullWorkset = true;
        if (!options.deepLocked && (hasFailedTest || hasRiskAreas || staleScan)) {
            deep = true;
        }
        maxChars = deep ? PR_LIMITS.deep : PR_LIMITS.default;
        workset = buildWorksetContext(task.id, { deep, digest: !deep && !fullWorkset });
        riskAreas = extractWorksetSection(workset, "Relevant Risk Areas");
        relatedFiles = extractWorksetSection(workset, "Related File Candidates");
    }

    const upgradesApplied = [];
    if (!base.deep && deep) upgradesApplied.push("deep");
    if (!base.fullWorkset && fullWorkset) upgradesApplied.push("full-workset");
    if (!base.manifest && manifest) upgradesApplied.push("manifest");
    if (!base.verbose && verbose) upgradesApplied.push("verbose");
    const reasonCodes = [];
    const evidence = [];
    if (hasFailedTest && loopResult?.mostRecentTest) {
        reasonCodes.push("RECENT_TEST_FAIL");
        const exitCode = Number(loopResult.mostRecentTest.exitCode);
        const command = loopResult.mostRecentTest.command ? String(loopResult.mostRecentTest.command) : "";
        evidence.push(command ? `last_test_exit=${exitCode} command="${command}"` : `last_test_exit=${exitCode}`);
    }
    if (loopResult?.constraints?.unstable) reasonCodes.push("FAILURE_STREAK");
    if (loopResult?.constraints?.requireRootCauseAnalysis) reasonCodes.push("REQUIRE_RCA");
    if (hasRiskAreas) {
        reasonCodes.push("HIGH_RISK_AREAS");
        evidence.push("risk_areas_present=true");
    }
    if (staleScan) {
        reasonCodes.push("STALE_SCAN");
        evidence.push("stale_scan_hint=true");
    }
    const budgetDecision = budget === "off"
        ? null
        : {
              mode: budget,
              decision: budget === "full" ? "FULL" : exceptionBudget ? "EXCEPTION" : "DEFAULT",
              upgradesApplied,
              reasonCodes,
              evidence,
          };
    const budgetFailureStreak = loopResult?.patterns?.failureStreak ?? null;
    const budgetSignalCount = reasonCodes.length;

    if (workset.includes("Run repo-context-kit scan")) {
        warnings.push("Generated indexes may be missing or stale. Run repo-context-kit scan for richer workset context.");
    }

    const scopeItems = scope
        ? toCheckboxItems(scope, "Review proposed task scope.")
        : toCheckboxItems(relatedFiles, "Review related workset candidates before editing.");
    const verificationItems = acceptanceCriteria
        ? toCheckboxItems(acceptanceCriteria, "Verify the task outcome.")
        : [
            "- [ ] Verify the selected task goal is satisfied.",
            "- [ ] Confirm behavior manually where automated coverage is unavailable.",
        ];
    const parts = [
        "# Pull Request Description",
        [
            "## Title Suggestion",
            "",
            `${task.id}: ${task.title}`,
        ].join("\n"),
        [
            "## Summary",
            "",
            "This PR is intended to address the selected task. The description is generated before reading any git diff, so proposed changes are phrased as planned scope rather than completed work.",
            "",
            goal,
        ].join("\n"),
        [
            "## Linked Task",
            "",
            `- task: ${task.id}`,
            `- title: ${task.title}`,
            `- status: ${task.status || "unknown"}`,
            `- priority: ${task.priority || "-"}`,
            `- owner: ${task.owner || "-"}`,
            `- dependencies: ${task.dependencies || "-"}`,
            `- file: ${task.file || "-"}`,
        ].join("\n"),
        [
            "## Hard Boundaries",
            "",
            hardBoundaries,
        ].join("\n"),
        [
            "## Confirmation Points",
            "",
            confirmationPoints,
        ].join("\n"),
        renderBootstrapDoctorSummary({ maxRisks: 5, maxActions: 6 }),
        [
            "## Post-merge Cleanup",
            "",
            "- [ ] Create an archive record for this workflow run (one file per run): `archive/Task_at_date.md`.",
            "- [ ] If this repo uses task files only for internal planning, remove completed `task/T-*.md` files after merge.",
            "- [ ] Ensure `task/task.md` does not reference missing task files (remove rows or keep an empty registry).",
            "- [ ] Refresh generated context after cleanup:",
            "",
            "```bash",
            "npx repo-context-kit scan --auto",
            "```",
        ].join("\n"),
        exceptionBudget ? renderLoopSignals(task.id, task.title) : null,
        [
            "## Scope",
            "",
            ...scopeItems,
        ].join("\n"),
        [
            "## Changes Checklist",
            "",
            "- [ ] Make only the changes needed for this task.",
            "- [ ] Keep changes minimal and aligned with existing project style.",
            "- [ ] Avoid manual edits to generated `.aidw/index/*` files.",
            "- [ ] Update docs or tests only when they are part of the task scope.",
        ].join("\n"),
        [
            "## Verification Checklist",
            "",
            ...verificationItems,
            "- [ ] Run appropriate tests before marking the PR ready.",
            "- [ ] Record actual commands and results after tests are run.",
        ].join("\n"),
        [
            "## Risk Areas",
            "",
            riskAreas || "_No indexed risk areas were available._",
        ].join("\n"),
        [
            "## Rollback / Review Notes",
            "",
            "- Review related entry points and shared modules carefully before merge.",
            "- If the task changes CLI behavior, compare command output before and after the change.",
            "- Rollback should revert only this task's scoped changes.",
        ].join("\n"),
        [
            "## Missing Context Warnings",
            "",
            warnings.length ? formatList([...new Set(warnings)]) : "- None",
        ].join("\n"),
    ];

    return renderBoundedPrompt(
        parts,
        renderPrFooter(
            { taskId: task.id, deep, maxChars, warnings },
            { ...options, deep, fullWorkset, manifest, verbose, budget, budgetDecision, budgetFailureStreak, budgetSignalCount },
        ),
        maxChars,
    );
}

function buildTaskChecklist(taskId, options = {}) {
    const budget = options.budget || "off";
    const base = {
        deep: Boolean(options.deep),
        fullWorkset: Boolean(options.fullWorkset),
        manifest: Boolean(options.manifest),
        verbose: Boolean(options.verbose),
    };
    let deep = Boolean(options.deep);
    let fullWorkset = Boolean(options.fullWorkset);
    let manifest = Boolean(options.manifest);
    let verbose = Boolean(options.verbose);
    let maxChars = deep ? CHECKLIST_LIMITS.deep : CHECKLIST_LIMITS.default;
    const warnings = [];
    const registry = parseTaskRegistry();

    if (budget === "full") {
        if (!options.deepLocked) deep = true;
        if (!options.fullWorksetLocked) fullWorkset = true;
        if (!options.manifestLocked) manifest = true;
        if (!options.verboseLocked) verbose = true;
        maxChars = deep ? CHECKLIST_LIMITS.deep : CHECKLIST_LIMITS.default;
    }

    if (!taskId) {
        warnings.push("Missing task id.");
        return renderBoundedPrompt([
            "# Task Test Checklist",
            "Warning: missing task id.",
            "Usage: repo-context-kit task checklist <taskId> [--deep]",
        ], renderChecklistFooter({ taskId: null, deep, maxChars, warnings }, { ...options, manifest, verbose, budget }), maxChars);
    }

    if (!registry.exists) {
        warnings.push(`${TASK_REGISTRY_PATH} is missing. Create tasks with repo-context-kit task new or restore the task registry.`);
        return renderBoundedPrompt([
            "# Task Test Checklist",
            `Warning: ${TASK_REGISTRY_PATH} is missing.`,
            "A checklist could not be generated because the task registry is required to resolve task IDs.",
        ], renderChecklistFooter({ taskId, deep, maxChars, warnings }, { ...options, manifest, verbose, budget }), maxChars);
    }

    const task = findTaskById(registry, taskId);

    if (!task) {
        warnings.push(`Task ${taskId} was not found in ${TASK_REGISTRY_PATH}.`);
        return renderBoundedPrompt([
            "# Task Test Checklist",
            `Warning: task not found: ${taskId}.`,
            `Check ${TASK_REGISTRY_PATH} for available task IDs.`,
        ], renderChecklistFooter({ taskId, deep, maxChars, warnings }, { ...options, manifest, verbose, budget }), maxChars);
    }

    const taskDetail = readTaskDetail(task, warnings);
    const goal = extractSection(taskDetail, "Goal") || "Review task detail and registry metadata to confirm the intended outcome.";
    const acceptanceCriteria = extractSection(taskDetail, "Acceptance Criteria");
    const loopResult = budget === "auto" || budget === "full"
        ? evaluateContextLoop({ taskId: task.id, requestedTitle: task.title })
        : null;
    const hasFailedTest = Boolean(loopResult?.mostRecentTest && Number(loopResult.mostRecentTest.exitCode) !== 0);

    let workset = buildWorksetContext(task.id, { deep, digest: !deep && !fullWorkset });
    let riskAreas = extractWorksetSection(workset, "Relevant Risk Areas");
    let likelyTestFiles = getLikelyTestFiles(workset);
    const hasRiskAreas = Boolean(riskAreas && !riskAreas.includes("_No indexed risk areas were available._"));
    const staleScan = workset.includes("Run repo-context-kit scan");
    const exceptionBudget = budget === "auto" && Boolean(
        hasFailedTest ||
        loopResult?.constraints?.unstable ||
        loopResult?.constraints?.requireRootCauseAnalysis ||
        hasRiskAreas ||
        staleScan,
    );

    if (exceptionBudget) {
        if (!options.verboseLocked) verbose = true;
        if (!options.fullWorksetLocked) fullWorkset = true;
        if (!options.deepLocked && (hasFailedTest || hasRiskAreas || staleScan)) {
            deep = true;
        }
        maxChars = deep ? CHECKLIST_LIMITS.deep : CHECKLIST_LIMITS.default;
        workset = buildWorksetContext(task.id, { deep, digest: !deep && !fullWorkset });
        riskAreas = extractWorksetSection(workset, "Relevant Risk Areas");
        likelyTestFiles = getLikelyTestFiles(workset);
    }

    const upgradesApplied = [];
    if (!base.deep && deep) upgradesApplied.push("deep");
    if (!base.fullWorkset && fullWorkset) upgradesApplied.push("full-workset");
    if (!base.manifest && manifest) upgradesApplied.push("manifest");
    if (!base.verbose && verbose) upgradesApplied.push("verbose");
    const reasonCodes = [];
    const evidence = [];
    if (hasFailedTest && loopResult?.mostRecentTest) {
        reasonCodes.push("RECENT_TEST_FAIL");
        const exitCode = Number(loopResult.mostRecentTest.exitCode);
        const command = loopResult.mostRecentTest.command ? String(loopResult.mostRecentTest.command) : "";
        evidence.push(command ? `last_test_exit=${exitCode} command="${command}"` : `last_test_exit=${exitCode}`);
    }
    if (loopResult?.constraints?.unstable) reasonCodes.push("FAILURE_STREAK");
    if (loopResult?.constraints?.requireRootCauseAnalysis) reasonCodes.push("REQUIRE_RCA");
    if (hasRiskAreas) {
        reasonCodes.push("HIGH_RISK_AREAS");
        evidence.push("risk_areas_present=true");
    }
    if (staleScan) {
        reasonCodes.push("STALE_SCAN");
        evidence.push("stale_scan_hint=true");
    }
    const budgetDecision = budget === "off"
        ? null
        : {
              mode: budget,
              decision: budget === "full" ? "FULL" : exceptionBudget ? "EXCEPTION" : "DEFAULT",
              upgradesApplied,
              reasonCodes,
              evidence,
          };
    const budgetFailureStreak = loopResult?.patterns?.failureStreak ?? null;
    const budgetSignalCount = reasonCodes.length;

    if (workset.includes("Run repo-context-kit scan")) {
        warnings.push("Generated indexes may be missing or stale. Run repo-context-kit scan for richer workset context.");
    }

    const testChecklist = likelyTestFiles.length > 0
        ? likelyTestFiles.map((filePath) => `- [ ] Review or update likely test file: \`${filePath}\`.`)
        : [
            "- [ ] Identify the nearest relevant test area from the task scope.",
            "- [ ] Add or update focused tests if behavior changes.",
            "- [ ] Run the project test command documented by the task or package when ready.",
        ];
    const parts = [
        "# Task Test Checklist",
        [
            "## Task",
            "",
            `- id: ${task.id}`,
            `- title: ${task.title}`,
            `- status: ${task.status || "unknown"}`,
            `- priority: ${task.priority || "-"}`,
            `- owner: ${task.owner || "-"}`,
            `- dependencies: ${task.dependencies || "-"}`,
        ].join("\n"),
        [
            "## Task Goal Summary",
            "",
            goal,
        ].join("\n"),
        renderBootstrapDoctorSummary({ maxRisks: 5, maxActions: 6 }),
        exceptionBudget ? renderLoopSignals(task.id, task.title) : null,
        [
            "## Acceptance Criteria Checklist",
            "",
            ...toCheckboxItems(acceptanceCriteria, "Confirm acceptance criteria with the task owner because none were found."),
        ].join("\n"),
        [
            "## Implementation Verification Checklist",
            "",
            "- [ ] Confirm the change implements only this task.",
            "- [ ] Confirm generated `.aidw/index/*` files were not edited manually.",
            "- [ ] Confirm unrelated files were not changed.",
            "- [ ] Confirm existing project style and structure were preserved.",
            "- [ ] Confirm edge cases from the task detail were considered.",
        ].join("\n"),
        [
            "## Test Checklist",
            "",
            ...testChecklist,
            "- [ ] Record the exact tests run and their results.",
        ].join("\n"),
        [
            "## Regression Risk Checklist",
            "",
            "- [ ] Review related file candidates from the workset before changing shared behavior.",
            "- [ ] Check relevant entry points for command/API/user-flow impact.",
            riskAreas ? "- [ ] Review the risk areas listed below." : "- [ ] Identify risk areas manually if scan context is unavailable.",
            "",
            riskAreas || "_No indexed risk areas were available._",
        ].join("\n"),
        [
            "## Manual Verification Checklist",
            "",
            "- [ ] Exercise the changed workflow manually if it affects CLI output, generated prompts, or user-facing behavior.",
            "- [ ] Confirm warnings are clear when expected context is missing.",
            "- [ ] Confirm output remains bounded and does not dump full generated indexes.",
        ].join("\n"),
        [
            "## Workset Reference",
            "",
            "Use this bounded workset for related files, symbols, entry points, read order, and warnings.",
            "",
            workset.trim(),
        ].join("\n"),
    ];

    return renderBoundedPrompt(
        parts,
        renderChecklistFooter(
            { taskId: task.id, deep, maxChars, warnings },
            { ...options, deep, fullWorkset, manifest, verbose, budget, budgetDecision, budgetFailureStreak, budgetSignalCount },
        ),
        maxChars,
    );
}

export function buildTaskPrompt(taskRef, options = {}) {
    const budget = options.budget || "off";
    const base = {
        deep: Boolean(options.deep),
        fullWorkset: Boolean(options.fullWorkset),
        fullDetail: Boolean(options.fullDetail),
        compact: Boolean(options.compact),
        manifest: Boolean(options.manifest),
        verbose: Boolean(options.verbose),
    };
    let deep = Boolean(options.deep);
    let fullWorkset = Boolean(options.fullWorkset);
    let fullDetail = Boolean(options.fullDetail);
    let compact = Boolean(options.compact);
    let manifest = Boolean(options.manifest);
    let verbose = Boolean(options.verbose);
    let maxChars = deep ? PROMPT_LIMITS.deep : PROMPT_LIMITS.default;
    const warnings = [];
    const registry = parseTaskRegistry();
    const taskId = typeof taskRef === "string" ? taskRef : null;
    const providedTask = taskRef && typeof taskRef === "object" ? taskRef : null;

    if (budget === "auto" && !options.compactLocked) {
        compact = true;
    }

    if (budget === "full") {
        if (!options.deepLocked) deep = true;
        if (!options.fullWorksetLocked) fullWorkset = true;
        if (!options.fullDetailLocked) fullDetail = true;
        if (!options.compactLocked) compact = false;
        if (!options.manifestLocked) manifest = true;
        if (!options.verboseLocked) verbose = true;
        maxChars = deep ? PROMPT_LIMITS.deep : PROMPT_LIMITS.default;
    }

    if (!taskId && !providedTask) {
        warnings.push("Missing task id.");
        return renderBoundedPrompt([
            "# Task Implementation Prompt",
            "Warning: missing task id.",
            "Usage: repo-context-kit task prompt <taskId> [--deep] [--compact] [--full-detail] [--full-workset] [--manifest] [--verbose] [--budget auto|off|full]",
        ], renderPromptFooter({ taskId: null, deep, maxChars, warnings }, options), maxChars);
    }

    if (!registry.exists && !providedTask) {
        warnings.push(`${TASK_REGISTRY_PATH} is missing. Create tasks with repo-context-kit task new or restore the task registry.`);
        return renderBoundedPrompt([
            "# Task Implementation Prompt",
            `Warning: ${TASK_REGISTRY_PATH} is missing.`,
            "A task prompt could not be generated because the task registry is required to resolve task IDs.",
        ], renderPromptFooter({ taskId, deep, maxChars, warnings }, options), maxChars);
    }

    const task = providedTask || findTaskById(registry, taskId);

    if (!task) {
        warnings.push(`Task ${taskId} was not found in ${TASK_REGISTRY_PATH}.`);
        return renderBoundedPrompt([
            "# Task Implementation Prompt",
            `Warning: task not found: ${taskId}.`,
            `Check ${TASK_REGISTRY_PATH} for available task IDs.`,
        ], renderPromptFooter({ taskId, deep, maxChars, warnings }, options), maxChars);
    }

    const taskDetail = options.taskDetailOverride
        ? String(options.taskDetailOverride)
        : readTaskDetail(task, warnings);
    const hardBoundaries = getTaskGuardSection(taskDetail, "Hard Boundaries", DEFAULT_HARD_BOUNDARIES, warnings);
    const confirmationPoints = getTaskGuardSection(taskDetail, "Confirmation Points", DEFAULT_CONFIRMATION_POINTS, warnings);
    const loopResult = (budget === "auto" || budget === "full") && /^T-\d{3}$/i.test(String(task.id ?? ""))
        ? evaluateContextLoop({ taskId: task.id, requestedTitle: task.title })
        : null;
    const hasFailedTest = Boolean(loopResult?.mostRecentTest && Number(loopResult.mostRecentTest.exitCode) !== 0);
    let workset = buildWorksetContext(providedTask || task.id, { deep, digest: !deep && !fullWorkset, taskDetailOverride: taskDetail });
    const riskAreas = extractWorksetSection(workset, "Relevant Risk Areas");
    const hasRiskAreas = Boolean(riskAreas && !riskAreas.includes("_No indexed risk areas were available._"));
    const staleScan = workset.includes("Run repo-context-kit scan");
    const exceptionBudget = budget === "auto" && Boolean(
        hasFailedTest ||
        loopResult?.constraints?.unstable ||
        loopResult?.constraints?.requireRootCauseAnalysis ||
        hasRiskAreas ||
        staleScan,
    );

    if (exceptionBudget) {
        if (!options.verboseLocked) verbose = true;
        if (!options.fullDetailLocked) fullDetail = true;
        if (!options.fullWorksetLocked) fullWorkset = true;
        if (!options.deepLocked && (hasFailedTest || hasRiskAreas || staleScan)) {
            deep = true;
        }
        maxChars = deep ? PROMPT_LIMITS.deep : PROMPT_LIMITS.default;
        workset = buildWorksetContext(providedTask || task.id, { deep, digest: !deep && !fullWorkset, taskDetailOverride: taskDetail });
    }

    const taskDetailForPrompt = fullDetail ? taskDetail : summarizeTaskDetailForPrompt(taskDetail);
    const dependencySummaries = registry.exists ? getDependencySummaries(task, registry) : [];
    const upgradesApplied = [];
    if (!base.compact && compact) upgradesApplied.push("compact");
    if (!base.deep && deep) upgradesApplied.push("deep");
    if (!base.fullWorkset && fullWorkset) upgradesApplied.push("full-workset");
    if (!base.fullDetail && fullDetail) upgradesApplied.push("full-detail");
    if (!base.manifest && manifest) upgradesApplied.push("manifest");
    if (!base.verbose && verbose) upgradesApplied.push("verbose");
    const reasonCodes = [];
    const evidence = [];
    if (hasFailedTest && loopResult?.mostRecentTest) {
        reasonCodes.push("RECENT_TEST_FAIL");
        const exitCode = Number(loopResult.mostRecentTest.exitCode);
        const command = loopResult.mostRecentTest.command ? String(loopResult.mostRecentTest.command) : "";
        evidence.push(command ? `last_test_exit=${exitCode} command="${command}"` : `last_test_exit=${exitCode}`);
    }
    if (loopResult?.constraints?.unstable) reasonCodes.push("FAILURE_STREAK");
    if (loopResult?.constraints?.requireRootCauseAnalysis) reasonCodes.push("REQUIRE_RCA");
    if (hasRiskAreas) {
        reasonCodes.push("HIGH_RISK_AREAS");
        evidence.push("risk_areas_present=true");
    }
    if (staleScan) {
        reasonCodes.push("STALE_SCAN");
        evidence.push("stale_scan_hint=true");
    }
    const budgetDecision = budget === "off"
        ? null
        : {
              mode: budget,
              decision: budget === "full" ? "FULL" : exceptionBudget ? "EXCEPTION" : "DEFAULT",
              upgradesApplied,
              reasonCodes,
              evidence,
          };
    const effectiveOptions = {
        ...options,
        deep,
        fullWorkset,
        fullDetail,
        compact,
        manifest,
        verbose,
        budget,
        budgetDecision,
        budgetFailureStreak: loopResult?.patterns?.failureStreak ?? null,
        budgetSignalCount: reasonCodes.length,
    };
    const parts = [
        `# AI Work Prompt: ${task.id} ${task.title}`,
        "## Task Implementation Prompt",
        [
            "This prompt gives the AI:",
            "",
            "- the task goal",
            "- allowed scope",
            "- relevant files",
            "- safety boundaries",
            "- verification steps",
            "",
            "Use it with your AI coding tool. The runtime keeps execution bounded; it does not grant autonomous write access.",
        ].join("\n"),
        compact
            ? [
                  "## Rules",
                  "",
                  "- Only implement this task; follow scope and acceptance criteria.",
                  "- Keep changes minimal and preserve backward compatibility.",
                  "- Do not edit generated `.aidw/index/*` files.",
                  "- If context is insufficient, ask for specific inputs.",
                  "- Run the documented test command when ready.",
              ].join("\n")
            : [
                  "## Role",
                  "",
                  "You are an AI coding tool in this repository. Implement only this task, follow scope/AC, and keep changes minimal and safe.",
              ].join("\n"),
        compact
            ? [
                  "## Task",
                  "",
                  `- id: ${task.id}`,
                  `- title: ${task.title}`,
                  `- priority: ${task.priority || "-"}`,
                  `- dependencies: ${task.dependencies || "-"}`,
                  "",
                  "### Dependency Summary",
                  "",
                  formatList(dependencySummaries),
                  "",
                  "### Task Detail",
                  "",
                  taskDetailForPrompt || "_Task detail file is unavailable._",
              ].join("\n")
            : [
                  "## Project Context",
                  "",
                  "Use the bounded workset below for context. Do not edit generated `.aidw/index/*` files manually.",
              ].join("\n"),
        compact
            ? [
                  "## Workset",
                  "",
                  workset.trim(),
              ].join("\n")
            : [
                  "## Task",
                  "",
                  `- id: ${task.id}`,
                  `- title: ${task.title}`,
                  `- status: ${task.status || "unknown"}`,
                  `- priority: ${task.priority || "-"}`,
                  `- owner: ${task.owner || "-"}`,
                  `- dependencies: ${task.dependencies || "-"}`,
                  "",
                  "### Dependency Summary",
                  "",
                  formatList(dependencySummaries),
                  "",
                  "### Task Detail",
                  "",
                  taskDetailForPrompt || "_Task detail file is unavailable. Use registry metadata and ask for more specific context if needed._",
              ].join("\n"),
        renderBootstrapDoctorSummary({ maxRisks: compact ? 3 : 5, maxActions: compact ? 4 : 6 }),
        [
            "## Hard Boundaries",
            "",
            hardBoundaries,
        ].join("\n"),
        [
            "## Confirmation Points",
            "",
            confirmationPoints,
        ].join("\n"),
        compact
            ? null
            : [
                  "## Relevant Workset",
                  "",
                  workset.trim(),
              ].join("\n"),
        compact
            ? null
            : [
                  "## Implementation Rules",
                  "",
                  "- Only implement this task.",
                  "- Keep changes minimal; preserve backward compatibility.",
                  "- Do not edit generated `.aidw/index/*` files manually.",
                  "- If context is insufficient, ask for specific missing inputs.",
              ].join("\n"),
        exceptionBudget ? renderLoopSignals(task.id, task.title) : null,
        [
            "## Required Final Response Format",
            "",
            "- Summary",
            "- Files changed",
            "- Key decisions",
            "- Tests run",
            "- Anything not implemented",
        ].join("\n"),
    ].filter(Boolean);

    if (workset.includes("Run repo-context-kit scan")) {
        warnings.push("Generated indexes may be missing or stale. Run repo-context-kit scan for richer workset context.");
    }

    return renderBoundedPrompt(
        parts,
        renderPromptFooter({ taskId: task.id, deep, maxChars, warnings }, effectiveOptions),
        maxChars,
    );
}

export async function runTask(args = []) {
    const subcommand = args[0];
    const formatTaskTitle = (value) => (value ? value : "");
    const fullWorkset = args.includes("--full-workset");
    const fullDetail = args.includes("--full-detail");
    const compact = args.includes("--compact");
    const manifest = args.includes("--manifest");
    const verbose = args.includes("--verbose");
    const budget = resolveBudgetMode(args);
    const deepLocked = args.includes("--deep");
    const fullWorksetLocked = args.includes("--full-workset");
    const fullDetailLocked = args.includes("--full-detail");
    const compactLocked = args.includes("--compact");
    const manifestLocked = args.includes("--manifest");
    const verboseLocked = args.includes("--verbose");

    if (subcommand === "help" || subcommand === "--help") {
        console.log("Usage:");
        console.log('  repo-context-kit task new "Task title" [--force] [--dry-run]');
        console.log("  repo-context-kit task from-doc <path> [--dry-run] [--json]");
        console.log('  repo-context-kit task plan --goal "..." [--dry-run] [--json]');
        console.log("  repo-context-kit task prompt <taskId> [--deep] [--compact] [--full-detail] [--full-workset]");
        console.log("  repo-context-kit task checklist <taskId> [--deep]");
        console.log("  repo-context-kit task pr <taskId> [--deep] [--cleanup]");
        console.log("");
        console.log("Compatibility:");
        console.log("  task from-doc <path> forwards to task generate --from-doc <path>");
        console.log('  task plan --goal "..." forwards to auto --goal "..."');
        console.log("  task generate, task run, and task cleanup remain available.");
        return {
            created: null,
            output: null,
        };
    }

    if (subcommand === "pr") {
        const taskId = args.slice(1).find((arg) => !arg.startsWith("--"));
        const cleanup = args.includes("--cleanup");
        const create = args.includes("--create");
        const repoIndex = args.indexOf("--repo");
        const headIndex = args.indexOf("--head");
        const baseIndex = args.indexOf("--base");
        const repoArg = repoIndex >= 0 ? args[repoIndex + 1] : null;
        const headArg = headIndex >= 0 ? args[headIndex + 1] : null;
        const baseArg = baseIndex >= 0 ? args[baseIndex + 1] : null;
        const registry = parseTaskRegistry();
        const task = taskId && registry.exists ? findTaskById(registry, taskId) : null;
        const prOk = Boolean(taskId && registry.exists && task);
        if (!prOk) {
            process.exitCode = 1;
        }
        const output = buildTaskPrDescription(taskId, {
            deep: deepLocked,
            fullWorkset,
            manifest,
            verbose,
            budget,
            deepLocked,
            fullWorksetLocked,
            manifestLocked,
            verboseLocked,
        });

        console.log(output.trimEnd());

        if (create && prOk) {
            const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || getGitHubTokenFromUserConfig() || "";
            if (!token) {
                console.error("");
                console.error("Missing GitHub token. Set GITHUB_TOKEN (or GH_TOKEN) or run: repo-context-kit github auth set --stdin");
                process.exitCode = 1;
                return { output };
            }

            let ownerRepo = null;
            if (repoArg && !String(repoArg).startsWith("--")) {
                const match = String(repoArg).trim().match(/^([^/]+)\/([^/]+)$/);
                if (match) {
                    ownerRepo = { owner: match[1], repo: match[2] };
                }
            } else {
                ownerRepo = resolveGitHubRepoFromGitRemote(process.cwd());
            }

            const head =
                headArg && !String(headArg).startsWith("--")
                    ? String(headArg).trim()
                    : resolveCurrentGitBranch(process.cwd());
            const base = baseArg && !String(baseArg).startsWith("--") ? String(baseArg).trim() : "main";

            if (!ownerRepo) {
                console.error("");
                console.error("Unable to determine GitHub repo. Provide --repo <owner/name> or configure git remote origin.");
                process.exitCode = 1;
                return { output };
            }
            if (!head) {
                console.error("");
                console.error("Unable to determine current git branch. Provide --head <branch>.");
                process.exitCode = 1;
                return { output };
            }

            const title = task ? `${task.id}: ${task.title}` : `Task ${taskId}`;
            const created = await createPullRequest({
                token,
                owner: ownerRepo.owner,
                repo: ownerRepo.repo,
                title,
                head,
                base,
                body: output.trimEnd(),
            });

            if (!created.ok) {
                console.error("");
                console.error(`Failed to create PR: ${created.error}`);
                process.exitCode = 1;
                return { output };
            }

            console.log("");
            console.log(`Created PR: ${created.url}`);

            if (cleanup) {
                runTaskCleanup(taskId);
            }
        } else if (cleanup && prOk) {
            runTaskCleanup(taskId);
        }

        return {
            output,
        };
    }

    if (subcommand === "cleanup") {
        const taskId = args.slice(1).find((arg) => !arg.startsWith("--"));
        const dryRun = args.includes("--dry-run");
        if (!taskId) {
            console.error("Task is not completed. Cleanup aborted.");
            maybeAppendLearnableTaskEvent({
                type: "task_failed",
                ok: false,
                command: "task cleanup",
                reason: "missing_task_id",
            });
            process.exitCode = 1;
            return { ok: false };
        }
        return runTaskCleanup(taskId, { dryRun });
    }

    if (subcommand === "checklist") {
        const taskId = args.slice(1).find((arg) => !arg.startsWith("--"));
        const registry = parseTaskRegistry();
        if (!taskId || !registry.exists || !findTaskById(registry, taskId)) {
            process.exitCode = 1;
        }
        const output = buildTaskChecklist(taskId, {
            deep: deepLocked,
            fullWorkset,
            manifest,
            verbose,
            budget,
            deepLocked,
            fullWorksetLocked,
            manifestLocked,
            verboseLocked,
        });

        console.log(output.trimEnd());

        return {
            output,
        };
    }

    if (subcommand === "prompt") {
        const taskId = args.slice(1).find((arg) => !arg.startsWith("--"));
        const registry = parseTaskRegistry();
        if (!taskId || !registry.exists || !findTaskById(registry, taskId)) {
            process.exitCode = 1;
        }
        const output = buildTaskPrompt(taskId, {
            deep: deepLocked,
            fullWorkset,
            fullDetail,
            compact,
            manifest,
            verbose,
            budget,
            deepLocked,
            fullWorksetLocked,
            fullDetailLocked,
            compactLocked,
            manifestLocked,
            verboseLocked,
        });

        console.log(output.trimEnd());

        return {
            output,
        };
    }

    if (subcommand === "from-doc") {
        const [docPath, ...rest] = args.slice(1);
        return runTask(["generate", "--from-doc", docPath, ...rest].filter(Boolean));
    }

    if (subcommand === "generate") {
        const repoRoot = getRepoRoot();
        const fromDoc = getArgValue(args, "--from-doc");
        const dryRun = args.includes("--dry-run");
        const json = args.includes("--json");
        if (fromDoc) {
            let doc = null;
            let planning = null;
            try {
                doc = loadDesignDoc(fromDoc, { repoRoot });
                planning = extractPlanningData(doc);
            } catch (error) {
                const message = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
                process.exitCode = 1;
                if (json) {
                    console.log(serializeJson({ ok: false, error: message, extractedPlanning: null, generatedTasks: [], warnings: [] }));
                    return { ok: false };
                }
                console.error(`ERROR ${message}`);
                return { ok: false };
            }

            const warnings = planDocWarnings(doc, planning);
            const seeds = buildDocTaskSeeds(doc, planning);
            const registry = parseTaskRegistry();
            const existingIds = new Set(registry.tasks.map((t) => String(t.id ?? "").toUpperCase()).filter(Boolean));
            const created = [];
            const updated = [];
            const generatedTasks = [];
            const taskNumberBase = Number.parseInt(getNextTaskNumber(), 10);
            let nextNumber = Number.isFinite(taskNumberBase) ? taskNumberBase : 1;

            if (!exists(TASK_REGISTRY_PATH)) {
                created.push(TASK_REGISTRY_PATH);
            } else {
                updated.push(TASK_REGISTRY_PATH);
            }

            for (const seed of seeds) {
                let taskId = "";
                let filePath = "";
                let attempts = 0;
                while (attempts < 200) {
                    const taskNumber = String(nextNumber).padStart(3, "0");
                    nextNumber += 1;
                    attempts += 1;
                    taskId = `T-${taskNumber}`;
                    if (existingIds.has(taskId)) continue;
                    const slug = slugify(seed.title || "new-task");
                    filePath = path.posix.join(TASK_DIR, `${taskId}-${slug}.md`);
                    if (exists(filePath)) continue;
                    break;
                }
                if (!taskId || !filePath) {
                    warnings.push("Unable to allocate a new task id for one suggested task.");
                    continue;
                }

                const testCommand = detectDefaultTestCommand();
                const taskContent = buildTaskTemplate(taskId, seed.title, testCommand, {
                    requirementItems: seed.requirementItems,
                    acceptanceCriteriaItems: seed.acceptanceCriteriaItems,
                    riskItems: [],
                    testStrategyItems: [],
                });

                generatedTasks.push({
                    id: taskId,
                    title: seed.title,
                    file: filePath,
                    goal: seed.goal,
                });

                created.push(filePath);
                existingIds.add(taskId);

                if (!dryRun) {
                    ensureTaskRegistry();
                    writeText(filePath, taskContent);
                    appendTaskToRegistry({
                        id: taskId,
                        title: seed.title,
                        file: filePath,
                    });
                }
            }

            const refresh = !dryRun ? refreshTaskContextIfAvailable() : { updated: [], warnings: [] };
            for (const filePath of refresh.updated) {
                if (!updated.includes(filePath)) updated.push(filePath);
            }
            warnings.push(...(refresh.warnings ?? []));

            if (dryRun && isDirectory(".aidw")) {
                updated.push(CONTEXT_TASKS_PATH);
            }

            if (dryRun) {
                const summary = renderFileMutationSummary("INFO Dry run: doc-driven task generation would make these changes", {
                    created,
                    updated: [...new Set(updated)].sort((a, b) => a.localeCompare(b)),
                    warnings: warnings.sort((a, b) => a.localeCompare(b)),
                });
                if (json) {
                    console.log(
                        serializeJson({
                            ok: true,
                            extractedPlanning: {
                                path: doc.path,
                                title: doc.metadata?.title ?? null,
                                goals: planning.goals,
                                requirements: planning.requirements,
                                scope: planning.scope,
                                acceptanceCriteria: planning.acceptanceCriteria,
                                constraints: planning.constraints,
                                suggestedTasks: planning.suggestedTasks,
                            },
                            generatedTasks,
                            warnings: warnings.sort((a, b) => a.localeCompare(b)),
                            plannedWrites: { created, updated },
                        }),
                    );
                    return { ok: true, dryRun: true, generatedTasks, extractedPlanning: planning, warnings };
                }
                console.log(summary);
                return { ok: true, dryRun: true, generatedTasks, extractedPlanning: planning, warnings };
            }

            if (json) {
                console.log(
                    serializeJson({
                        ok: true,
                        extractedPlanning: {
                            path: doc.path,
                            title: doc.metadata?.title ?? null,
                            goals: planning.goals,
                            requirements: planning.requirements,
                            scope: planning.scope,
                            acceptanceCriteria: planning.acceptanceCriteria,
                            constraints: planning.constraints,
                            suggestedTasks: planning.suggestedTasks,
                        },
                        generatedTasks,
                        warnings: warnings.sort((a, b) => a.localeCompare(b)),
                    }),
                );
            } else {
                const lines = [
                    "# Doc-Driven Task Generation",
                    "",
                    `- doc: ${doc.path}`,
                    `- tasks: ${generatedTasks.length}`,
                    "",
                    "Next:",
                    "- Review generated task files under task/",
                    "- Then run: repo-context-kit auto --goal \"<goal>\" (or auto --from-doc ...) to create a bounded plan and pause.",
                ];
                console.log(lines.join("\n").trimEnd());
            }
            return { ok: true, generatedTasks, extractedPlanning: planning, warnings };
        }

        const missing = [];
        if (!exists(CONTEXT_SYSTEM_OVERVIEW_PATH)) {
            missing.push(CONTEXT_SYSTEM_OVERVIEW_PATH);
        }
        if (!exists(CONTEXT_PROJECT_MD_PATH)) {
            missing.push(CONTEXT_PROJECT_MD_PATH);
        }

        if (missing.length > 0) {
            console.error("ERROR Task generation scaffold requires project docs.");
            console.error("Missing:");
            for (const filePath of missing) {
                console.error(`- ${filePath}`);
            }
            console.error("");
            console.error("Next:");
            console.error("- Run: repo-context-kit scan");
            maybeAppendLearnableTaskEvent({
                type: "task_failed",
                ok: false,
                command: "task generate",
                reason: "missing_project_docs",
                missing,
            });
            process.exitCode = 1;
            return {
                created: null,
                output: null,
            };
        }

        const output = [
            "# Task Generation Scaffold",
            "",
            "This command does not auto-edit code.",
            "",
            "Inputs (default):",
            `- ${CONTEXT_SYSTEM_OVERVIEW_PATH}`,
            `- ${CONTEXT_PROJECT_MD_PATH}`,
            "- Your application document (PRD/spec/ADR) provided to your AI tool",
            "",
            "Outputs:",
            "- task/T-*.md (one file per task)",
            "- task/task.md (registry updated)",
            "",
            "Suggested next steps:",
            '- Create tasks: repo-context-kit task new \"<task title>\"',
            "- Fill each task with Goal / Scope / Acceptance Criteria / Test Command",
            "- Then run: repo-context-kit task run",
        ].join("\n");

        console.log(output.trimEnd());
        return {
            output,
        };
    }

    if (subcommand === "run") {
        const registry = parseTaskRegistry();
        if (!registry.exists) {
            console.error("ERROR Task run scaffold requires the task registry.");
            console.error("");
            console.error("Next:");
            console.error('- Create a task: repo-context-kit task new "Describe the change"');
            maybeAppendLearnableTaskEvent({
                type: "task_failed",
                ok: false,
                command: "task run",
                reason: "missing_task_registry",
            });
            process.exitCode = 1;
            return {
                created: null,
                output: null,
            };
        }

        const runnable = registry.tasks.filter((task) =>
            ["todo", "in_progress"].includes(task.status || "todo"),
        );

        const lines = [
            "# Task Run Scaffold",
            "",
            "This command does not auto-edit code or run tests.",
            "",
            "Execution plan:",
            "- Generate tasks from docs (if needed): repo-context-kit task generate",
            "- Execute tasks sequentially",
            "- For each task: implement -> run tests -> commit + push",
            "- After all tasks: create one final PR",
            "",
            "Tasks (todo / in_progress):",
            ...(runnable.length === 0
                ? ["- (none)"]
                : runnable.map((task) => `- ${task.id}: ${formatTaskTitle(task.title)}`)),
        ];

        const output = `${lines.join("\n")}\n`;
        console.log(output.trimEnd());
        return {
            output,
        };
    }

    if (subcommand !== "new") {
        console.error("Unknown task command.");
        console.log("Usage:");
        console.log('  repo-context-kit task new "Task title" [--force] [--dry-run]');
        console.log("  repo-context-kit task from-doc <path> [--dry-run] [--json]");
        console.log("  repo-context-kit task generate [--from-doc <path>] [--dry-run] [--json]");
        console.log("  repo-context-kit task run");
        console.log("  repo-context-kit task checklist <taskId> [--deep]");
        console.log("  repo-context-kit task pr <taskId> [--deep] [--cleanup]");
        console.log("  repo-context-kit task cleanup <taskId> [--dry-run]");
        console.log("  repo-context-kit task prompt <taskId> [--deep] [--compact] [--full-detail] [--full-workset]");
        maybeAppendLearnableTaskEvent({
            type: "task_failed",
            ok: false,
            command: `task ${String(subcommand ?? "").trim() || "-"}`,
            reason: "unknown_subcommand",
        });
        process.exitCode = 1;
        return {
            created: null,
            output: null,
        };
    }

    const force = args.includes("--force");
    const dryRun = args.includes("--dry-run");
    const rawTitle = args
        .filter((arg) => arg !== "--force" && arg !== "--dry-run")
        .slice(1)
        .join(" ")
        .trim();
    const slug = slugify(rawTitle || "new-task");
    const taskNumber = getNextTaskNumber();
    const taskId = `T-${taskNumber}`;
    const title = rawTitle ? normalizeTitle(rawTitle) : toTitleCase(slug);
    const filePath = path.posix.join(TASK_DIR, `${taskId}-${slug}.md`);

    const loop = evaluateContextLoop({ requestedTitle: title });
    if (loop.constraints.blockNewTask && !force) {
        console.error("ERROR Task creation blocked by Context Loop constraints");
        console.error(loop.constraints.blockReason || "Task creation is blocked.");
        if (loop.mutations.suggestedFixTaskTitle) {
            console.error("");
            console.error("Suggested next step:");
            console.error(`- Create a fix task: repo-context-kit task new "${loop.mutations.suggestedFixTaskTitle}"`);
        }
        console.error("");
        console.error('Override: repo-context-kit task new "Title" --force');
        maybeAppendLearnableTaskEvent({
            type: "task_failed",
            ok: false,
            command: "task new",
            reason: "blocked_by_loop_constraints",
            evidence: [
                loop.constraints.blockReason || "Task creation is blocked.",
                loop.mutations.suggestedFixTaskTitle
                    ? `suggested_fix_task: ${loop.mutations.suggestedFixTaskTitle}`
                    : null,
            ].filter(Boolean),
        });
        process.exitCode = 1;
        return {
            created: null,
            output: null,
        };
    }

    const created = [filePath];
    const updated = exists(TASK_REGISTRY_PATH) ? [TASK_REGISTRY_PATH] : [];
    if (!exists(TASK_REGISTRY_PATH)) {
        created.push(TASK_REGISTRY_PATH);
    }
    if (isDirectory(".aidw")) {
        updated.push(CONTEXT_TASKS_PATH);
    }

    if (dryRun) {
        console.log(
            renderFileMutationSummary("INFO Dry run: task creation would make these changes", {
                created,
                updated,
            }),
        );
        return {
            created: filePath,
            dryRun: true,
        };
    }

    ensureTaskRegistry();
    writeText(filePath, buildTaskTemplate(taskId, title, detectDefaultTestCommand(), loop.mutations));
    appendTaskToRegistry({
        id: taskId,
        title,
        file: filePath,
    });

    const contextRefresh = refreshTaskContextIfAvailable();
    const finalUpdated = [TASK_REGISTRY_PATH, ...contextRefresh.updated];

    console.log(
        renderFileMutationSummary("OK Task created", {
            created: [filePath],
            updated: finalUpdated,
            warnings: contextRefresh.warnings,
        }),
    );

    return {
        created: filePath,
    };
}
