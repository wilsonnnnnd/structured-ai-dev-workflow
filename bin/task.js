#!/usr/bin/env node
import fs from "node:fs";
import path from "path";
import { buildWorksetContext } from "./context.js";
import {
    CONTEXT_PROJECT_MD_PATH,
    CONTEXT_SYSTEM_OVERVIEW_PATH,
    CONTEXT_TASKS_PATH,
    HUMAN_PROJECT_BRIEF_PATH,
    RUNTIME_CONTEXT_PATH,
    RUNTIME_TASK_PATH,
    RUNTIME_VERIFICATION_PATH,
    TASK_REGISTRY_PATH,
} from "../src/scan/constants.js";
import { exists, isDirectory, listDirSafe, readJson, readText, writeText } from "../src/scan/fs-utils.js";
import { evaluateContextLoop } from "../src/loop/analyze.js";
import { appendLoopEvent } from "../src/loop/store.js";
import { formatBudgetDecisionMarkdown } from "../src/budget/decision.js";
import { buildTaskMap } from "../src/scan/indexers/project-index.js";
import { getPreferredTaskRegistry, updateRuntimeTaskJson } from "../src/runtime/json-core.js";
import {
    appendTaskToRegistry,
    ensureTaskRegistry,
    getKnownTaskIds,
    parseTaskRegistry,
    resolveTaskFilePath,
} from "../src/scan/task-registry.js";
import { extractMarkdownListItems } from "../src/docs/doc-extractor.js";
import { serializeCompactJson } from "../src/runtime/serialize.js";
import { getRepoRoot } from "../src/runtime/root-context.js";
import { stableStringCompare } from "../src/runtime/stable-sort.js";
import { computeContextHash, scoreContextCacheability } from "../src/runtime/context-compression.js";
import { buildVolatilityPlan } from "../src/runtime/context-observability.js";
import { applyRuntimeBudget, CONTEXT_BUDGET } from "../src/runtime/context-budget.js";

const TASK_DIR = "task";
const DOC_TASK_LIMIT = 10;
const PROMPT_LIMITS = CONTEXT_BUDGET.task.prompt;
const CHECKLIST_LIMITS = CONTEXT_BUDGET.task.checklist;
const PR_LIMITS = CONTEXT_BUDGET.task.pr;

function serializeRuntimeJson(payload, options = {}) {
    return serializeCompactJson(applyRuntimeBudget(payload, options));
}

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
    return warnings.sort(stableStringCompare);
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

function renderCappedBulletList(text, { maxItems = 12, maxItemChars = 240 } = {}) {
    const raw = String(text ?? "").trimEnd();
    const limit = Number.isFinite(Number(maxItems)) ? Math.max(1, Number(maxItems)) : 12;
    const items = extractMarkdownListItems(raw, { maxItems: limit + 1, maxItemChars });
    if (items.length === 0) return "";
    const truncated = items.length > limit || /\[truncated(?::|\])/i.test(raw);
    const out = items.slice(0, limit).map((item) => `- ${item}`).join("\n").trimEnd();
    if (!truncated) return out;
    return `${out}\n\n_[truncated: showing first ${limit} items]_`;
}

function renderBootstrapDoctorSummary({ maxRisks = 5, maxActions = 6 } = {}) {
    return "";
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

function isFrontendTask(task, taskDetail = "") {
    const haystack = `${task?.title ?? ""}\n${taskDetail}`.toLowerCase();
    return /(ui|frontend|react|vue|css|style|component|design|layout|theme)/i.test(haystack);
}

function getBoundedUiDesignContext(maxChars = 1200) {
    const aiProject = readText(CONTEXT_PROJECT_MD_PATH);
    if (!aiProject) {
        return "";
    }
    const section = extractSection(aiProject, "UI Design Context");
    if (!section) {
        return "";
    }
    return section.length > maxChars ? `${section.slice(0, maxChars - 12).trimEnd()}\n[truncated]` : section;
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
    const resolved = resolveTaskFilePath(task, { requireExists: true });
    if (!resolved.ok) {
        warnings.push(resolved.error || `Task ${task.id} detail file is invalid.`);
        return "";
    }

    try {
        return fs.readFileSync(resolved.filePath, "utf-8");
    } catch {
        warnings.push(`Task detail file is missing: ${task.file}.`);
        return "";
    }
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
    updateRuntimeTaskJson();
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
        updated.push(RUNTIME_TASK_PATH);
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
    const stableMetaSeed = {
        level,
        taskId: taskId ?? null,
        deep: Boolean(deep),
        maxChars,
        includedSources: [...includedSources].sort(stableStringCompare),
        excludedSources: [...excludedSourceList].sort(stableStringCompare),
    };
    const cacheability = scoreContextCacheability(JSON.stringify(stableMetaSeed), true);
    const volatility = cacheability >= 80 ? "low" : cacheability >= 50 ? "medium" : "high";
    const lines = [
        "## Context Meta",
        "",
        `- level: ${level}`,
        `- selected task id: ${taskId ?? "none"}`,
        `- included sources: ${includedSources.length}`,
        `- excluded sources: ${excludedSourceList.length}`,
        `- limits: maxChars=${maxChars}, worksetMode=${deep ? "deep" : "default"}`,
        `- warnings: ${uniqueWarnings.length}`,
        `- context_hash: ${computeContextHash(stableMetaSeed)}`,
        `- cacheable: ${cacheability >= 60 ? "true" : "false"}`,
        `- volatility: ${volatility}`,
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

function clampString(value, maxLength = 240) {
    const text = String(value ?? "").trim();
    if (text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, Math.max(0, maxLength - 12)).trimEnd()} [truncated]`;
}

function capList(values, maxItems, mapper = (item) => item) {
    const list = Array.isArray(values) ? values : [];
    return list.slice(0, maxItems).map(mapper);
}

function parseSectionListBounded(content, heading, maxItems = 16, maxItemChars = 220) {
    return extractMarkdownListItems(extractSection(content, heading), { maxItems, maxItemChars });
}

function normalizeSectionCommand(text) {
    const raw = String(text ?? "").trim();
    if (!raw) return "";
    const stripped = raw
        .replace(/^```[a-zA-Z0-9_-]*\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
    const oneLine = stripped.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(" ; ");
    return clampString(oneLine, 320);
}

function loadRuntimeSnapshot() {
    return {
        task: readJson(RUNTIME_TASK_PATH) || null,
        context: readJson(RUNTIME_CONTEXT_PATH) || null,
        verification: readJson(RUNTIME_VERIFICATION_PATH) || null,
    };
}

function findRuntimeTask(taskId) {
    const runtime = loadRuntimeSnapshot();
    const tasks = Array.isArray(runtime.task?.payload?.tasks) ? runtime.task.payload.tasks : [];
    const selected = tasks.find((task) => String(task?.id ?? "").trim().toUpperCase() === String(taskId ?? "").trim().toUpperCase()) || null;
    return { runtime, selected };
}

function buildTaskWorkset(runtime, options = {}) {
    const deep = Boolean(options.deep);
    const detail = options.detail || (deep ? "full" : "compact");
    const baseLimit = detail === "full" ? 20 : detail === "digest" ? 6 : 10;
    const fileLimit = deep ? Math.min(baseLimit + 8, 28) : baseLimit;
    return {
        detail,
        deep,
        files: capList(runtime.context?.payload?.topFiles, fileLimit, (file) => ({
            path: clampString(file?.path, 240),
            type: clampString(file?.type, 80),
            description: clampString(file?.description, 180),
        })),
        entrypoints: capList(runtime.context?.payload?.entrypoints, deep ? 20 : 12, (entry) => ({
            name: clampString(entry?.name, 120),
            path: clampString(entry?.path, 240),
        })),
        riskAreas: capList(runtime.context?.payload?.riskAreas, deep ? 16 : 10, (item) => clampString(item, 180)),
    };
}

function toPromptJson(taskId, options = {}) {
    const normalizedId = normalizeTaskId(taskId);
    const { runtime, selected } = findRuntimeTask(normalizedId);
    if (!selected) {
        return {
            schemaVersion: "runtime/v1",
            interface: "cli",
            kind: "task-prompt",
            error: `task not found: ${normalizedId}`,
        };
    }
    const warnings = [];
    const facts = selected?.facts && typeof selected.facts === "object" ? selected.facts : {};
    return {
        schemaVersion: "runtime/v1",
        interface: "cli",
        kind: "task-prompt",
        task: {
            id: clampString(selected.id, 32),
            title: clampString(selected.title, 180),
            status: clampString(selected.status, 32),
            priority: clampString(selected.priority, 32),
            owner: clampString(selected.owner, 80),
            dependencies: capList(selected.dependencies, 16, (item) => clampString(item, 32)),
            file: selected.file || null,
            goal: clampString(facts.goal, 900) || null,
            scope: capList(facts.scope, 16, (item) => clampString(item, 220)),
            requirements: capList(facts.requirements, 16, (item) => clampString(item, 220)),
            acceptanceCriteria: capList(facts.acceptanceCriteria, 16, (item) => clampString(item, 220)),
            testCommand: normalizeSectionCommand(facts.testCommand) || null,
            hardBoundaries: capList(facts.hardBoundaries, 12, (item) => clampString(item, 220)),
            confirmationPoints: capList(facts.confirmationPoints, 12, (item) => clampString(item, 220)),
        },
        workset: buildTaskWorkset(runtime, { deep: options.deep, detail: options.deep ? "full" : "compact" }),
        verification: {
            requiredChecks: capList(runtime.verification?.payload?.requiredChecks, 8, (item) => clampString(item, 120)),
        },
        warnings: capList(warnings, 6, (item) => clampString(item, 180)),
    };
}

function toChecklistJson(taskId, options = {}) {
    const normalizedId = normalizeTaskId(taskId);
    const { runtime, selected } = findRuntimeTask(normalizedId);
    if (!selected) {
        return {
            schemaVersion: "runtime/v1",
            interface: "cli",
            kind: "task-checklist",
            error: `task not found: ${normalizedId}`,
        };
    }
    const warnings = [];
    const facts = selected?.facts && typeof selected.facts === "object" ? selected.facts : {};
    return {
        schemaVersion: "runtime/v1",
        interface: "cli",
        kind: "task-checklist",
        task: {
            id: clampString(selected.id, 32),
            title: clampString(selected.title, 180),
        },
        checklist: {
            acceptanceCriteria: capList(facts.acceptanceCriteria, 16, (item) => clampString(item, 220)),
            definitionOfDone: capList(facts.definitionOfDone, 16, (item) => clampString(item, 220)),
            requiredChecks: capList(runtime.verification?.payload?.requiredChecks, 8, (item) => clampString(item, 120)),
            suggestedReadFiles: capList(runtime.context?.payload?.topFiles, options.deep ? 12 : 8, (file) => clampString(file?.path, 240)),
        },
        warnings: capList(warnings, 6, (item) => clampString(item, 180)),
    };
}

function toPrJson(taskId, options = {}) {
    const normalizedId = normalizeTaskId(taskId);
    const { runtime, selected } = findRuntimeTask(normalizedId);
    if (!selected) {
        return {
            schemaVersion: "runtime/v1",
            interface: "cli",
            kind: "task-pr-framing",
            error: `task not found: ${normalizedId}`,
        };
    }
    const warnings = [];
    const facts = selected?.facts && typeof selected.facts === "object" ? selected.facts : {};
    return {
        schemaVersion: "runtime/v1",
        interface: "cli",
        kind: "task-pr-framing",
        pr: {
            title: `${clampString(selected.id, 32)} ${clampString(selected.title, 180)}`,
            summary: clampString(facts.goal, 900) || null,
            scope: capList(facts.scope, 16, (item) => clampString(item, 220)),
            verification: {
                acceptanceCriteria: capList(facts.acceptanceCriteria, 16, (item) => clampString(item, 220)),
                requiredChecks: capList(runtime.verification?.payload?.requiredChecks, 8, (item) => clampString(item, 120)),
                warnings: capList(runtime.verification?.payload?.warnings, 8, (item) => clampString(item, 180)),
            },
        },
        workset: buildTaskWorkset(runtime, { deep: options.deep, detail: options.deep ? "full" : "compact" }),
        warnings: capList(warnings, 6, (item) => clampString(item, 180)),
    };
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
    const registry = getPreferredTaskRegistry();
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
            "Usage: rck task prompt <taskId> [--deep] [--compact] [--full-detail] [--full-workset] [--manifest] [--verbose] [--budget auto|off|full]",
        ], renderPromptFooter({ taskId: null, deep, maxChars, warnings }, options), maxChars);
    }

    if (!registry.exists && !providedTask) {
        warnings.push(`${TASK_REGISTRY_PATH} is missing. Restore the task registry and run rck scan.`);
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
    const volatilityPlan = buildVolatilityPlan(task.id);
    const hardBoundaries = getTaskGuardSection(taskDetail, "Hard Boundaries", DEFAULT_HARD_BOUNDARIES, warnings);
    const confirmationPoints = getTaskGuardSection(taskDetail, "Confirmation Points", DEFAULT_CONFIRMATION_POINTS, warnings);
    const loopResult = (budget === "auto" || budget === "full") && /^T-\d{3}$/i.test(String(task.id ?? ""))
        ? evaluateContextLoop({ taskId: task.id, requestedTitle: task.title })
        : null;
    const hasFailedTest = Boolean(loopResult?.mostRecentTest && Number(loopResult.mostRecentTest.exitCode) !== 0);
    let workset = buildWorksetContext(providedTask || task.id, { deep, digest: !deep && !fullWorkset, taskDetailOverride: taskDetail });
    const riskAreas = extractWorksetSection(workset, "Relevant Risk Areas");
    const hasRiskAreas = Boolean(riskAreas && !riskAreas.includes("_No indexed risk areas were available._"));
    const staleScan = workset.includes("Run rck scan");
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
    const frontendTask = isFrontendTask(task, taskDetail);
    const uiDesignContext = frontendTask ? getBoundedUiDesignContext(compact ? 700 : 1200) : "";
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
                  volatilityPlan.high_volatility.workset === "inject"
                      ? workset.trim()
                      : summarizeTaskDetailForPrompt(workset),
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
        [
            "## Canonical Context References",
            "",
            "- Rules: See `.aidw/rules-canonical.md`",
            "- Workflow: See `.aidw/workflow.md`",
            "- Safety: See `.aidw/safety.md`",
        ].join("\n"),
        [
            "## Volatility Injection Plan",
            "",
            `- architecture: ${volatilityPlan.low_volatility.architecture}`,
            `- rules: ${volatilityPlan.low_volatility.rules}`,
            `- workflow: ${volatilityPlan.low_volatility.workflow}`,
            `- task_status: ${volatilityPlan.high_volatility.task_status}`,
            `- changed_files: ${volatilityPlan.high_volatility.changed_files}`,
            `- runtime_loop: ${volatilityPlan.high_volatility.runtime_loop}`,
            `- workset: ${volatilityPlan.high_volatility.workset}`,
        ].join("\n"),
        frontendTask && uiDesignContext
            ? [
                  "## UI Design Context (Frontend Only)",
                  "",
                  "Apply Logic-First order: logic -> data/state -> UI.",
                  "",
                  uiDesignContext,
              ].join("\n")
            : null,
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
                  volatilityPlan.high_volatility.workset === "inject"
                      ? workset.trim()
                      : summarizeTaskDetailForPrompt(workset),
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

    if (workset.includes("Run rck scan")) {
        warnings.push("Generated indexes may be missing or stale. Run rck scan for richer workset context.");
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
    const deepLocked = args.includes("--deep");

    if (subcommand === "help" || subcommand === "--help") {
        console.log("Usage:");
        console.log("  rck task prompt <taskId> [--deep]");
        console.log("  rck task checklist <taskId> [--deep]");
        console.log("  rck task pr <taskId> [--deep]");
        return {
            created: null,
            output: null,
        };
    }

    if (!["prompt", "checklist", "pr"].includes(String(subcommand ?? ""))) {
        console.error("Unknown task command.");
        console.log("Usage:");
        console.log("  rck task prompt <taskId> [--deep]");
        console.log("  rck task checklist <taskId> [--deep]");
        console.log("  rck task pr <taskId> [--deep]");
        process.exitCode = 1;
        return {
            created: null,
            output: null,
        };
    }

    if (subcommand === "pr") {
        const taskId = args.slice(1).find((arg) => !arg.startsWith("--"));
        const removedFlags = ["--cleanup", "--create", "--confirm-create-pr", "--repo", "--head", "--base"];
        const removedFlag = removedFlags.find((flag) => args.includes(flag));
        if (removedFlag) {
            console.error(`Unknown task pr option: ${removedFlag}`);
            process.exitCode = 1;
            return { output: null };
        }
        const registry = getPreferredTaskRegistry();
        const task = taskId && registry.exists ? findTaskById(registry, taskId) : null;
        const prOk = Boolean(taskId && registry.exists && task);
        if (!prOk) {
            process.exitCode = 1;
        }
        const output = serializeRuntimeJson(toPrJson(taskId, { deep: deepLocked }));

        console.log(output.trimEnd());

        return {
            output,
        };
    }

    if (subcommand === "checklist") {
        const taskId = args.slice(1).find((arg) => !arg.startsWith("--"));
        const registry = getPreferredTaskRegistry();
        if (!taskId || !registry.exists || !findTaskById(registry, taskId)) {
            process.exitCode = 1;
        }
        const output = serializeRuntimeJson(toChecklistJson(taskId, { deep: deepLocked }));

        console.log(output.trimEnd());

        return {
            output,
        };
    }

    if (subcommand === "prompt") {
        const taskId = args.slice(1).find((arg) => !arg.startsWith("--"));
        const registry = getPreferredTaskRegistry();
        if (!taskId || !registry.exists || !findTaskById(registry, taskId)) {
            process.exitCode = 1;
        }
        const output = serializeRuntimeJson(toPromptJson(taskId, { deep: deepLocked }));

        console.log(output.trimEnd());

        return {
            output,
        };
    }

    return {
        created: null,
        output: null,
    };
}
