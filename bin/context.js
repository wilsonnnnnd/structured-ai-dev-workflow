#!/usr/bin/env node
import fs from "node:fs";
import path from "path";
import { stablePathCompare } from "../src/runtime/stable-sort.js";
import { extractMarkdownListItems } from "../src/docs/doc-extractor.js";
import {
    CONTEXT_INDEX_ENTRYPOINTS_PATH,
    CONTEXT_INDEX_FILES_PATH,
    CONTEXT_INDEX_FILE_GROUPS_PATH,
    CONTEXT_INDEX_FILE_SUMMARIES_PATH,
    CONTEXT_INDEX_SUMMARY_PATH,
    CONTEXT_INDEX_SYMBOLS_PATH,
    CONTEXT_PROJECT_MD_PATH,
    RUNTIME_CONTEXT_PATH,
    RUNTIME_TASK_PATH,
    RUNTIME_VERIFICATION_PATH,
    TASK_REGISTRY_PATH,
} from "../src/scan/constants.js";
import { exists, listDirSafe, readJson, readText } from "../src/scan/fs-utils.js";
import { listTaskFiles } from "../src/scan/task-files.js";
import { getRegistryStatusBreakdown, parseTaskRegistry, resolveTaskFilePath } from "../src/scan/task-registry.js";
import { getPreferredTaskRegistry } from "../src/runtime/json-core.js";
import { formatLoopEventsMarkdown, listRecentLoopEvents } from "../src/loop/store.js";
import { evaluateContextLoop } from "../src/loop/analyze.js";
import { resolveBudgetMode } from "../src/budget/policy.js";
import { formatBudgetDecisionMarkdown } from "../src/budget/decision.js";
import { getCachedBriefDigest, writeBriefDigestCache } from "../src/loop/context-cache.js";
import { generateContextBrief, formatContextBriefCompact } from "../src/runtime/context-brief.js";
import { computeContextHash, scoreContextCacheability } from "../src/runtime/context-compression.js";
import { rankFilesForContext } from "../src/runtime/context-relevance.js";
import { applyRuntimeBudget, CONTEXT_BUDGET } from "../src/runtime/context-budget.js";
import {
    buildContextBudget,
    buildContextTrace,
    buildVolatilityPlan,
    detectContextDrift,
    formatCompactJson,
} from "../src/runtime/context-observability.js";
import { serializeCompactJson } from "../src/runtime/serialize.js";

const LIMITS = CONTEXT_BUDGET.context;

function serializeRuntimeJson(payload, options = {}) {
    return serializeCompactJson(applyRuntimeBudget(payload, options));
}

function readTextSafe(filePath) {
    if (!exists(filePath)) {
        return "";
    }

    try {
        return readText(filePath);
    } catch {
        return "";
    }
}

function normalizeStatus(status) {
    return String(status ?? "").trim().toLowerCase();
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

function extractSection(content, heading) {
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(
        `(?:^|\\n)##\\s+${escapedHeading}\\s*\\n(?<body>[\\s\\S]*?)(?=\\n##\\s|$)`,
        "i",
    );
    const match = content.match(regex);

    return match?.groups?.body?.trim() ?? "";
}

function extractFirstAvailableSection(content, headings) {
    for (const heading of headings) {
        const section = extractSection(content, heading);

        if (section) {
            return {
                heading,
                section,
            };
        }
    }

    return null;
}

function truncateText(text, maxLength) {
    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, maxLength - 15).trimEnd()}\n[truncated]`;
}

function renderCappedBulletList(text, { maxItems = 12, maxItemChars = 240, maxChars = null } = {}) {
    const limit = Number.isFinite(Number(maxItems)) ? Math.max(1, Number(maxItems)) : 12;
    const items = extractMarkdownListItems(text, { maxItems: limit + 1, maxItemChars });
    if (items.length === 0) return "";
    const truncated = items.length > limit;
    let out = items.slice(0, limit).map((item) => `- ${item}`).join("\n").trimEnd();
    if (truncated) {
        out = `${out}\n\n_[truncated: showing first ${limit} items]_`;
    }
    if (maxChars === null || typeof maxChars === "undefined") return out;
    return truncateText(out, maxChars);
}

function truncateInline(text, maxLength) {
    const value = String(text ?? "");
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function readFileSummariesIndex() {
    const summaries = readJson(CONTEXT_INDEX_FILE_SUMMARIES_PATH);
    return Array.isArray(summaries) ? summaries : null;
}

function formatFileSummaryReferences(relatedFiles, limits, warnings) {
    const summaries = readFileSummariesIndex();
    if (!summaries) {
        return null;
    }

    const summaryByPath = new Map(summaries.map((summary) => [summary.path, summary]));
    const picked = relatedFiles
        .map((file) => summaryByPath.get(file.path))
        .filter(Boolean)
        .slice(0, limits.maxFileSummaryFiles);

    if (picked.length === 0) {
        warnings.push(`${CONTEXT_INDEX_FILE_SUMMARIES_PATH} is present but no summaries matched related files.`);
        return null;
    }

    const lines = picked.map((summary) => {
        const exportsPart = Array.isArray(summary.exports) && summary.exports.length > 0
            ? `exports: ${summary.exports.slice(0, 8).map((item) => item.name).filter(Boolean).join(", ")}`
            : null;
        const callsPart = Array.isArray(summary.calls) && summary.calls.length > 0
            ? `calls: ${summary.calls.slice(0, 5).join(", ")}`
            : null;
        const risksPart = Array.isArray(summary.risks) && summary.risks.length > 0
            ? `risks: ${summary.risks.slice(0, 5).join(", ")}`
            : null;
        const parts = [summary.path, "—", summary.roleSummary, exportsPart, callsPart, risksPart]
            .filter(Boolean)
            .join(" ");
        return truncateInline(parts, 420);
    });

    const body = formatList(lines);
    return truncateText(body, limits.maxFileSummaryChars);
}

function formatScanSummaryLines(summary) {
    if (!summary || typeof summary !== "object") {
        return "- None";
    }

    const lines = [
        summary.generatedAt ? `- generatedAt: ${summary.generatedAt}` : "- generatedAt: -",
        Number.isFinite(Number(summary.indexedFiles)) ? `- indexedFiles: ${summary.indexedFiles}` : "- indexedFiles: -",
        Number.isFinite(Number(summary.indexedSymbols)) ? `- indexedSymbols: ${summary.indexedSymbols}` : "- indexedSymbols: -",
        Number.isFinite(Number(summary.fileGroups)) ? `- fileGroups: ${summary.fileGroups}` : "- fileGroups: -",
        typeof summary.truncated !== "undefined" ? `- truncated: ${String(summary.truncated)}` : "- truncated: -",
    ];

    return lines.join("\n");
}

function readPackageMetadata() {
    const pkg = readJson("package.json");

    if (!pkg) {
        return [];
    }

    const lines = [
        pkg.name ? `name: ${pkg.name}` : null,
        pkg.version ? `version: ${pkg.version}` : null,
        pkg.description ? `description: ${pkg.description}` : null,
        pkg.type ? `module type: ${pkg.type}` : null,
        pkg.license ? `license: ${pkg.license}` : null,
    ].filter(Boolean);

    if (pkg.bin) {
        const bins = typeof pkg.bin === "string"
            ? [`package -> ${pkg.bin}`]
            : Object.entries(pkg.bin).map(([name, file]) => `${name} -> ${file}`);
        lines.push(`bin: ${bins.join(", ")}`);
    }

    return lines;
}

function readProjectContext() {
    const content = readTextSafe(CONTEXT_PROJECT_MD_PATH);
    const purpose = extractFirstAvailableSection(content, [
        "Project Role",
        "Overview",
        "Project Context",
        "Manual Notes",
    ]);
    const rules = [
        extractSection(content, "AI Working Rules"),
        extractSection(content, "Editing Boundaries"),
    ].filter(Boolean);
    const riskAreas = extractSection(content, "High-Risk Areas") || extractSection(content, "Risk Areas");

    return {
        exists: Boolean(content),
        purpose,
        rules,
        riskAreas,
    };
}

function getTaskRegistrySummary(registry = parseTaskRegistry()) {
    if (!registry.exists) {
        return "Task registry missing.";
    }

    const counts = getRegistryStatusBreakdown(registry.tasks);

    return [
        `total: ${registry.tasks.length}`,
        `todo: ${counts.todo}`,
        `in_progress: ${counts.in_progress}`,
        `blocked: ${counts.blocked}`,
        `done: ${counts.done}`,
        `cancelled: ${counts.cancelled}`,
    ].join(", ");
}

function findTaskFileMismatchWarnings(registry) {
    const warnings = [];

    if (!registry.exists && listTaskFiles().length > 0) {
        warnings.push(`${TASK_REGISTRY_PATH} is missing but task files exist.`);
    }

    return warnings;
}

function taskById(registry, taskId) {
    return registry.tasks.find((task) => task.id.toLowerCase() === taskId.toLowerCase()) ?? null;
}

function selectNextTask(registry) {
    const doneIds = new Set(
        registry.tasks
            .filter((task) => normalizeStatus(task.status) === "done")
            .map((task) => task.id),
    );
    const inProgress = registry.tasks.find(
        (task) => normalizeStatus(task.status) === "in_progress",
    );

    if (inProgress) {
        return inProgress;
    }

    return registry.tasks.find((task) => {
        if (normalizeStatus(task.status) !== "todo") {
            return false;
        }

        return normalizeDependencies(task.dependencies).every((dependency) =>
            doneIds.has(dependency),
        );
    }) ?? null;
}

function summarizeTaskDetail(content, options = {}) {
    const maxChars = Number.isFinite(Number(options.maxChars)) ? Number(options.maxChars) : 3000;
    const headings = ["Goal", "Scope", "Acceptance Criteria"];
    const sections = headings
        .map((heading) => ({
            heading,
            body: extractSection(content, heading),
        }))
        .filter((section) => section.body);

    if (sections.length === 0) {
        return truncateText(content.trim(), maxChars);
    }

    const joined = sections
        .map((section) => `## ${section.heading}\n\n${section.body}`)
        .join("\n\n");

    return truncateText(joined, maxChars);
}

function summarizeDependency(task) {
    return `${task.id}: ${task.title} (${task.status || "unknown"})`;
}

function getDependencySummaries(task, registry, maxDependencySummaries, warnings) {
    const dependencies = normalizeDependencies(task?.dependencies);
    const summaries = [];

    for (const dependencyId of dependencies.slice(0, maxDependencySummaries)) {
        const dependency = taskById(registry, dependencyId);

        if (!dependency) {
            warnings.push(`Dependency ${dependencyId} is listed but not found in ${TASK_REGISTRY_PATH}.`);
            continue;
        }

        summaries.push(summarizeDependency(dependency));
    }

    if (dependencies.length > maxDependencySummaries) {
        warnings.push(`Dependency summaries limited to ${maxDependencySummaries}.`);
    }

    return summaries;
}

function tokenize(text) {
    return [
        ...new Set(
            String(text ?? "")
                .toLowerCase()
                .match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [],
        ),
    ].filter((token) => !["task", "with", "from", "that", "this", "only"].includes(token));
}

function scoreText(text, keywords) {
    const haystack = String(text ?? "").toLowerCase();

    return keywords.reduce((score, keyword) => score + (haystack.includes(keyword) ? 1 : 0), 0);
}

function selectRelatedFiles(task, detailContent, limits, warnings) {
    const files = readJson(CONTEXT_INDEX_FILES_PATH);
    const entrypoints = readJson(CONTEXT_INDEX_ENTRYPOINTS_PATH);
    const fileGroups = readJson(CONTEXT_INDEX_FILE_GROUPS_PATH);

    if (!files) {
        warnings.push(`${CONTEXT_INDEX_FILES_PATH} is missing. Run repo-context-kit scan.`);
        return [];
    }
    if (!entrypoints) {
        warnings.push(`${CONTEXT_INDEX_ENTRYPOINTS_PATH} is missing. Run repo-context-kit scan.`);
    }
    if (!fileGroups) {
        warnings.push(`${CONTEXT_INDEX_FILE_GROUPS_PATH} is missing. Run repo-context-kit scan.`);
    }

    const keywords = tokenize(`${task.id} ${task.title} ${detailContent}`);
    const explicitPaths = new Set(
        (detailContent.match(/(?:bin|src|test|tests|app|template|site)\/[A-Za-z0-9._/-]+/g) ?? [])
            .map((filePath) => filePath.replace(/[),.;]+$/g, "")),
    );
    const entrypointPaths = new Set((Array.isArray(entrypoints) ? entrypoints : []).map((entry) => entry.path));
    const groupKeyFiles = new Set(
        (Array.isArray(fileGroups) ? fileGroups : [])
            .flatMap((group) => group.keyFiles ?? []),
    );

    const baseCandidates = files
        .map((file) => {
            const textScore = scoreText(`${file.path} ${file.description} ${file.type}`, keywords);
            const explicit = explicitPaths.has(file.path);
            const entrypoint = entrypointPaths.has(file.path);
            const groupKey = groupKeyFiles.has(file.path);
            const score = textScore + (explicit ? 5 : 0) + (entrypoint ? 2 : 0) + (groupKey ? 1 : 0);

            if (score <= 0) {
                return null;
            }

            const reasons = [
                explicit ? "mentioned in task detail" : null,
                textScore > 0 ? `matched task keywords (${textScore})` : null,
                entrypoint ? "known entry point" : null,
                groupKey ? "key file in indexed file group" : null,
            ].filter(Boolean);

            return {
                path: file.path,
                description: file.description,
                confidence: Math.min(0.95, Number(file.confidence ?? 0.5) + score * 0.03),
                reason: reasons.join("; "),
                score,
            };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score || b.confidence - a.confidence || stablePathCompare(a.path, b.path));

    if (baseCandidates.length === 0) {
        return [];
    }

    const sourcePath = task.file || [...explicitPaths][0] || baseCandidates[0].path;
    const ranked = rankFilesForContext(sourcePath, baseCandidates.map((candidate) => candidate.path), {
        recentFiles: [],
    });
    const relevanceMap = new Map(ranked.map((item) => [item.file, item]));

    return baseCandidates
        .map((candidate) => {
            const relevance = relevanceMap.get(candidate.path);
            const relevanceScore = relevance?.score ?? 0;
            const reasons = [];
            if (candidate.reason) reasons.push(candidate.reason);
            if (relevance?.reasons?.length) reasons.push(`relevance: ${relevance.reasons.join(",")}`);

            return {
                ...candidate,
                score: candidate.score + Math.round(relevanceScore / 20),
                reason: reasons.join("; "),
            };
        })
        .sort((a, b) => b.score - a.score || b.confidence - a.confidence || stablePathCompare(a.path, b.path))
        .slice(0, limits.maxRelatedFiles);
}

function selectRelatedSymbols(task, detailContent, relatedFiles, limits, warnings) {
    const symbols = readJson(CONTEXT_INDEX_SYMBOLS_PATH);

    if (!symbols) {
        warnings.push(`${CONTEXT_INDEX_SYMBOLS_PATH} is missing. Run repo-context-kit scan.`);
        return [];
    }

    const keywords = tokenize(`${task.id} ${task.title} ${detailContent}`);
    const relatedFilePaths = new Set(relatedFiles.map((file) => file.path));

    return symbols
        .map((symbol) => {
            const fileMatch = relatedFilePaths.has(symbol.file);
            const textScore = scoreText(`${symbol.name} ${symbol.file} ${symbol.description}`, keywords);
            const score = textScore + (fileMatch ? 2 : 0);

            if (score <= 0) {
                return null;
            }

            return {
                name: symbol.name,
                type: symbol.type,
                file: symbol.file,
                confidence: Math.min(0.95, Number(symbol.confidence ?? 0.5) + score * 0.03),
                reason: [
                    fileMatch ? "defined in selected related file" : null,
                    textScore > 0 ? `matched task keywords (${textScore})` : null,
                ].filter(Boolean).join("; "),
                score,
            };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score || b.confidence - a.confidence || stablePathCompare(a.file, b.file))
        .slice(0, limits.maxRelatedSymbols);
}

function renderManifest(manifest) {
    const warnings = [...new Set(manifest.warnings)];

    return [
        "## Context Manifest",
        "",
        `- context level: ${manifest.level}`,
        `- selected task id: ${manifest.taskId ?? "none"}`,
        `- included sources: ${manifest.includedSources.length ? manifest.includedSources.join(", ") : "none"}`,
        `- excluded sources: ${manifest.excludedSources.length ? manifest.excludedSources.join(", ") : "none"}`,
        `- limits used: ${manifest.limits}`,
        `- warnings: ${warnings.length ? warnings.join(" | ") : "none"}`,
    ].join("\n");
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
    const suffix = more > 0 ? ` (+${more} more; use --verbose)` : "";
    return `## Warnings\n\n${formatList(shown)}${suffix ? `\n\n- ${suffix}` : ""}`;
}

function renderMeta(manifest, options = {}) {
    const warnings = [...new Set(manifest.warnings)];
    const stableMetaSeed = {
        level: manifest.level,
        taskId: manifest.taskId ?? null,
        includedSources: [...manifest.includedSources].sort(stablePathCompare),
        excludedSources: [...manifest.excludedSources].sort(stablePathCompare),
        limits: manifest.limits,
    };
    const stableMetaText = JSON.stringify(stableMetaSeed);
    const cacheability = scoreContextCacheability(stableMetaText, true);
    const volatility = cacheability >= 80 ? "low" : cacheability >= 50 ? "medium" : "high";
    const lines = [
        "## Context Meta",
        "",
        `- level: ${manifest.level}`,
        `- selected task id: ${manifest.taskId ?? "none"}`,
        `- included sources: ${manifest.includedSources.length}`,
        `- excluded sources: ${manifest.excludedSources.length}`,
        `- limits: ${manifest.limits}`,
        `- warnings: ${warnings.length}`,
        `- context_hash: ${computeContextHash(stableMetaSeed)}`,
        `- cacheable: ${cacheability >= 60 ? "true" : "false"}`,
        `- volatility: ${volatility}`,
    ];
    if (options.manifest) {
        lines.push("", renderManifest(manifest));
    }
    return lines.join("\n");
}

function renderBounded(bodyParts, manifest, maxChars, options = {}) {
    let body = bodyParts.filter(Boolean).join("\n\n").trim();
    const budgetEnabled = options.budget === "auto" || options.budget === "full";
    const uniqueWarnings = [...new Set(manifest.warnings)];
    const budgetBlock = budgetEnabled
        ? formatBudgetDecisionMarkdown(options.budgetDecision, {
              warningsCount: uniqueWarnings.length,
              failureStreak: options.budgetFailureStreak ?? null,
              signalCount: options.budgetSignalCount ?? null,
          })
        : "";
    const warningsBlock = renderWarningsSummary(manifest.warnings, options);
    const metaText = renderMeta(manifest, options);
    const footerParts = [budgetBlock, warningsBlock, metaText].filter(Boolean).join("\n\n");
    let output = `${body}${footerParts ? `\n\n${footerParts}` : ""}\n`;

    if (output.length <= maxChars) {
        return output;
    }

    manifest.warnings.push(`Output exceeded ${maxChars} characters and was truncated.`);
    const nextUniqueWarnings = [...new Set(manifest.warnings)];
    const nextBudgetBlock = budgetEnabled
        ? formatBudgetDecisionMarkdown(options.budgetDecision, {
              warningsCount: nextUniqueWarnings.length,
              failureStreak: options.budgetFailureStreak ?? null,
              signalCount: options.budgetSignalCount ?? null,
          })
        : "";
    const nextWarningsBlock = renderWarningsSummary(manifest.warnings, options);
    const nextMetaText = renderMeta(manifest, options);
    const nextFooter = [nextBudgetBlock, nextWarningsBlock, nextMetaText].filter(Boolean).join("\n\n");
    const bodyLimit = Math.max(0, maxChars - nextFooter.length - 20);
    body = truncateText(body, bodyLimit);
    output = `${body}${nextFooter ? `\n\n${nextFooter}` : ""}\n`;

    if (output.length <= maxChars) {
        return output;
    }

    return output.slice(0, Math.max(0, maxChars - 14)).trimEnd() + "\n[truncated]\n";
}

function formatLoopDigest(options = {}) {
    const result = evaluateContextLoop({ taskId: options.taskId ?? null });
    const lastTest = result.mostRecentTest;
    const lastTestSummary = lastTest
        ? `${lastTest.ok ? "pass" : "fail"} (exit ${lastTest.exitCode ?? "?"})${lastTest.command ? `: ${lastTest.command}` : ""}`
        : "-";

    const topFail = result.patterns.topFailingCommands?.[0]?.command ?? "-";

    return [
        `- decision: ${result.constraints.blockNewTask ? "BLOCK_NEW_TASK" : "ALLOW_NEW_TASK"}`,
        `- unstable: ${result.constraints.unstable ? "true" : "false"}`,
        `- last_test: ${lastTestSummary}`,
        `- failure_streak: ${result.patterns.failureStreak}`,
        `- top_failing_command: ${topFail}`,
        `- require_rca: ${result.constraints.requireRootCauseAnalysis ? "true" : "false"}`,
    ].join("\n");
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

function loadRuntimeSnapshot() {
    return {
        context: readJson(RUNTIME_CONTEXT_PATH) || null,
        task: readJson(RUNTIME_TASK_PATH) || null,
        verification: readJson(RUNTIME_VERIFICATION_PATH) || null,
    };
}

function toContextBriefJson() {
    const runtime = loadRuntimeSnapshot();
    const pkg = readJson("package.json") || {};
    return {
        schemaVersion: "runtime/v1",
        interface: "cli",
        kind: "context-brief",
        repository: {
            name: clampString(pkg.name || "-", 80),
            version: clampString(pkg.version || "-", 40),
        },
        context: {
            projectType: runtime.context?.payload?.projectType ?? null,
            techStack: capList(runtime.context?.payload?.techStack, 12, (item) => clampString(item, 120)),
            riskAreas: capList(runtime.context?.payload?.riskAreas, 12, (item) => clampString(item, 180)),
            index: runtime.context?.payload?.index || {
                indexedFiles: 0,
                indexedSymbols: 0,
                fileGroups: 0,
                truncated: false,
            },
        },
        verification: {
            requiredChecks: capList(runtime.verification?.payload?.requiredChecks, 8, (item) => clampString(item, 120)),
        },
    };
}

function pickNextRuntimeTask(tasks) {
    const list = Array.isArray(tasks) ? tasks : [];
    const inProgress = list.find((task) => normalizeStatus(task?.status) === "in_progress");
    if (inProgress) {
        return inProgress;
    }
    return list.find((task) => normalizeStatus(task?.status) === "todo") || null;
}

function toNextTaskJson() {
    const runtime = loadRuntimeSnapshot();
    const tasks = Array.isArray(runtime.task?.payload?.tasks) ? runtime.task.payload.tasks : [];
    const nextTask = pickNextRuntimeTask(tasks);
    const counts = tasks.reduce(
        (acc, task) => {
            const status = normalizeStatus(task?.status);
            if (status === "todo") acc.todo += 1;
            else if (status === "in_progress") acc.in_progress += 1;
            else if (status === "done") acc.done += 1;
            else acc.other += 1;
            return acc;
        },
        { todo: 0, in_progress: 0, done: 0, other: 0 },
    );

    return {
        schemaVersion: "runtime/v1",
        interface: "cli",
        kind: "context-next-task",
        nextTask: nextTask
            ? {
                  id: clampString(nextTask.id, 32),
                  title: clampString(nextTask.title, 180),
                  status: clampString(nextTask.status, 32),
                  priority: clampString(nextTask.priority, 32),
                  owner: clampString(nextTask.owner, 80),
                  dependencies: capList(nextTask.dependencies, 16, (item) => clampString(item, 32)),
                  file: nextTask.file || null,
              }
            : null,
        taskCounts: counts,
    };
}

function toWorksetJson(taskId, options = {}) {
    const runtime = loadRuntimeSnapshot();
    const tasks = Array.isArray(runtime.task?.payload?.tasks) ? runtime.task.payload.tasks : [];
    const selectedTask = taskById({ tasks }, taskId);
    const detail = options.detail || "compact";
    const deep = Boolean(options.deep);
    const baseLimit = detail === "full" ? 20 : detail === "digest" ? 6 : 10;
    const fileLimit = deep ? Math.min(baseLimit + 8, 28) : baseLimit;
    const entrypointLimit = deep ? 20 : 12;
    const riskLimit = deep ? 16 : 10;

    return {
        schemaVersion: "runtime/v1",
        interface: "cli",
        kind: "context-workset",
        task: selectedTask
            ? {
                  id: clampString(selectedTask.id, 32),
                  title: clampString(selectedTask.title, 180),
                  status: clampString(selectedTask.status, 32),
                  priority: clampString(selectedTask.priority, 32),
                  owner: clampString(selectedTask.owner, 80),
                  dependencies: capList(selectedTask.dependencies, 16, (item) => clampString(item, 32)),
                  file: selectedTask.file || null,
              }
            : null,
        workset: {
            detail,
            deep,
            files: capList(runtime.context?.payload?.topFiles, fileLimit, (file) => ({
                path: clampString(file?.path, 240),
                type: clampString(file?.type, 80),
                description: clampString(file?.description, 180),
            })),
            entrypoints: capList(runtime.context?.payload?.entrypoints, entrypointLimit, (entry) => ({
                name: clampString(entry?.name, 120),
                path: clampString(entry?.path, 240),
            })),
            riskAreas: capList(runtime.context?.payload?.riskAreas, riskLimit, (item) => clampString(item, 180)),
            requiredChecks: capList(runtime.verification?.payload?.requiredChecks, 8, (item) => clampString(item, 120)),
        },
    };
}

function buildBrief(options = {}) {
    const warnings = [];
    const registry = getPreferredTaskRegistry();
    const project = readProjectContext();
    const summary = readJson(CONTEXT_INDEX_SUMMARY_PATH);
    const metadata = readPackageMetadata();
    const includedSources = [];
    const digest = Boolean(options.digest);
    const summaryJson = Boolean(options.summaryJson);
    const rawLoop = Boolean(options.rawLoop);
    const loopEvents = listRecentLoopEvents({ limit: digest ? 3 : 6 });

    warnings.push(...findTaskFileMismatchWarnings(registry));

    if (!summary) {
        warnings.push(`${CONTEXT_INDEX_SUMMARY_PATH} is missing. Run repo-context-kit scan.`);
    }

    const parts = ["# Project Context Brief"];

    if (metadata.length > 0) {
        includedSources.push("package.json");
        parts.push(`## Package Metadata\n\n${formatList(metadata)}`);
    }

    if (digest) {
        const packageName = metadata
            .find((item) => item.toLowerCase().startsWith("name:"))
            ?.split(":")
            ?.slice(1)
            ?.join(":")
            ?.trim() || "-";
        const briefModel = generateContextBrief({
            name: packageName,
            type: "cli-tool",
            language: "JavaScript",
            framework: null,
            runtime: "Node.js",
            hasUI: false,
            entryPoints: [],
            uiDirs: [],
            utilityDirs: ["src", "bin"],
            testDirs: ["test"],
            riskCount: Array.isArray(project.riskAreas) ? project.riskAreas.length : 0,
            riskLevel: Array.isArray(project.riskAreas) && project.riskAreas.length > 3 ? "high" : "low",
            keyFiles: ["AGENTS.md", "PROJECT.md", ".aidw/AI_project.md"],
        });
        parts.push(`## Compact Context\n\n${formatContextBriefCompact(briefModel)}`);
    }

    if (project.exists) {
        includedSources.push(CONTEXT_PROJECT_MD_PATH);
        if (project.purpose) {
            parts.push(`## Project Purpose\n\n${truncateText(project.purpose.section, 1800)}`);
        }
        if (project.rules.length > 0) {
            parts.push(`## Project Boundaries / AI Working Rules\n\n${truncateText(project.rules.join("\n\n"), 2600)}`);
        }
    }

    if (summary) {
        includedSources.push(CONTEXT_INDEX_SUMMARY_PATH);
        const minimal = {
            generatedAt: summary.generatedAt,
            indexedFiles: summary.indexedFiles,
            indexedSymbols: summary.indexedSymbols,
            fileGroups: summary.fileGroups,
            truncated: summary.truncated,
        };
        const heading = digest ? "## Scan Summary (Digest)" : "## Scan Summary";
        if (summaryJson) {
            const payload = digest ? minimal : summary;
            parts.push(`${heading}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``);
        } else {
            parts.push(`${heading}\n\n${formatScanSummaryLines(minimal)}`);
        }
    }

    if (registry.exists) {
        includedSources.push(TASK_REGISTRY_PATH);
        parts.push(`## Task Registry Summary\n\n${getTaskRegistrySummary(registry)}`);
    }

    // Add canonical rules reference (PART 2B: Compression Integration)
    const canonicalRulesRef = `## Context Guidelines

See **.aidw/rules-canonical.md** for canonical rules:
- Reuse first (before writing new code)
- Logic first (architecture → data/state → UI)
- Keep scope tight (only related changes)
- Do not break (safety gates, tests always pass)`;
    parts.push(canonicalRulesRef);

    if (digest) {
        parts.push(`## Context Loop Digest\n\n${formatLoopDigest({ taskId: null })}`);
        if (rawLoop) {
            parts.push(`## Recent Context Loop (Raw)\n\n${formatLoopEventsMarkdown(loopEvents)}`);
        }
    } else {
        parts.push(`## Recent Context Loop\n\n${formatLoopEventsMarkdown(loopEvents)}`);
    }

    return renderBounded(parts, {
        level: "brief",
        taskId: null,
        includedSources,
        excludedSources: [
            CONTEXT_INDEX_FILES_PATH,
            CONTEXT_INDEX_SYMBOLS_PATH,
            "task/*.md task detail files",
            "full generated indexes",
        ],
        limits: `maxChars=${LIMITS.brief.maxChars}`,
        warnings,
    }, LIMITS.brief.maxChars, options);
}

function buildTaskContext(task, registry, level, limits, warnings, options = {}) {
    const includedSources = registry?.exists ? [TASK_REGISTRY_PATH] : [];
    const parts = [`# ${level === "next-task" ? `Next Work: ${task.id} ${task.title}` : "Task Context"}`];
    const digest = Boolean(options.digest);
    const rawLoop = Boolean(options.rawLoop);
    const loopEvents = listRecentLoopEvents({ limit: digest ? 3 : 6, taskId: task.id });

    parts.push([
        "## Registry Metadata",
        "",
        `- id: ${task.id}`,
        `- title: ${task.title}`,
        `- status: ${task.status || "unknown"}`,
        `- priority: ${task.priority || "-"}`,
        `- owner: ${task.owner || "-"}`,
        `- dependencies: ${task.dependencies || "-"}`,
        `- file: ${task.file || "-"}`,
    ].join("\n"));

    let detailContent = "";
    const detailOverride = options.taskDetailOverride ? String(options.taskDetailOverride) : "";
    if (detailOverride.trim()) {
        detailContent = detailOverride;
        parts.push(`## Selected Task Detail\n\n${summarizeTaskDetail(detailContent, { maxChars: digest ? 1600 : 3000 })}`);
    } else if (task.fileError) {
        warnings.push(`Selected task ${task.id} has an invalid detail file: ${task.fileError}`);
    } else if (task.file) {
        const resolved = resolveTaskFilePath(task, { requireExists: true });
        if (!resolved.ok) {
            const message = String(resolved.error ?? "").trim();
            if (message.toLowerCase().includes("is missing")) {
                warnings.push(`Selected task detail file is missing: ${task.file}.`);
            } else {
                warnings.push(`Selected task ${task.id} has an invalid detail file: ${message || "unknown error"}`);
            }
        } else {
            includedSources.push(task.file);
            detailContent = fs.readFileSync(resolved.filePath, "utf-8");
            parts.push(`## Selected Task Detail\n\n${summarizeTaskDetail(detailContent, { maxChars: digest ? 1600 : 3000 })}`);
        }
    } else {
        warnings.push(`Selected task ${task.id} has no detail file listed.`);
    }

    const dependencySummaries = getDependencySummaries(
        task,
        registry,
        limits.maxDependencySummaries,
        warnings,
    );
    parts.push(`## Dependency Summaries\n\n${formatList(dependencySummaries)}`);
    if (digest) {
        parts.push(`## Context Loop Digest\n\n${formatLoopDigest({ taskId: task.id })}`);
        if (rawLoop) {
            parts.push(`## Recent Context Loop (Raw)\n\n${formatLoopEventsMarkdown(loopEvents)}`);
        }
    } else {
        parts.push(`## Recent Context Loop\n\n${formatLoopEventsMarkdown(loopEvents)}`);
    }

    return {
        parts,
        includedSources,
        detailContent,
    };
}

function buildNextTask(options = {}) {
    const warnings = [];
    const registry = getPreferredTaskRegistry();
    warnings.push(...findTaskFileMismatchWarnings(registry));
    let digest = Boolean(options.digest);

    if (!registry.exists) {
        return renderBounded(["# Next Work", "No task registry is available.", "Provide task/task.md or run repository initialization before requesting task context."], {
            level: "next-task",
            taskId: null,
            includedSources: [],
            excludedSources: ["task/*.md task detail files", "generated indexes"],
            limits: `maxChars=${LIMITS["next-task"].maxChars}, maxDependencySummaries=${LIMITS["next-task"].maxDependencySummaries}`,
            warnings,
        }, LIMITS["next-task"].maxChars);
    }

    const task = selectNextTask(registry);
    if (!task) {
        return renderBounded([
            "# Next Work",
            "No ready task found.",
            "",
            "You can:",
            "- Provide task/task.md or task/T-*.md files.",
            "- Run repo-context-kit scan after task files exist.",
        ], {
            level: "next-task",
            taskId: null,
            includedSources: [TASK_REGISTRY_PATH],
            excludedSources: ["task/*.md task detail files", "generated indexes"],
            limits: `maxChars=${LIMITS["next-task"].maxChars}, maxDependencySummaries=${LIMITS["next-task"].maxDependencySummaries}`,
            warnings,
        }, LIMITS["next-task"].maxChars);
    }

    const loopResult = options.budget === "auto" || options.budget === "full"
        ? evaluateContextLoop({ taskId: task.id })
        : null;
    const hasFailedTest = Boolean(loopResult?.mostRecentTest && Number(loopResult.mostRecentTest.exitCode) !== 0);
    const exceptionBudget = Boolean(hasFailedTest || loopResult?.constraints?.unstable || loopResult?.constraints?.requireRootCauseAnalysis);

    if (options.budget === "full" && !options.digestLocked) {
        digest = false;
    } else if (options.budget === "auto" && exceptionBudget && !options.digestLocked) {
        digest = false;
    }

    const rawLoop = Boolean(options.rawLoop) || (exceptionBudget && options.budget === "auto") || options.budget === "full";
    const verbose = Boolean(options.verbose) || (exceptionBudget && options.budget === "auto") || options.budget === "full";
    const upgradesApplied = [];
    if (Boolean(options.digest) && digest === false) upgradesApplied.push("digest-off");
    if (!options.verbose && verbose) upgradesApplied.push("verbose");
    if (!options.rawLoop && rawLoop) upgradesApplied.push("raw-loop");

    const reasonCodes = [];
    const evidence = [];
    if (loopResult?.mostRecentTest) {
        const exitCode = Number(loopResult.mostRecentTest.exitCode);
        const command = loopResult.mostRecentTest.command ? String(loopResult.mostRecentTest.command) : "";
        if (Number.isFinite(exitCode) && exitCode !== 0) reasonCodes.push("RECENT_TEST_FAIL");
        if (command) evidence.push(`last_test_exit=${exitCode} command="${command}"`);
        else evidence.push(`last_test_exit=${exitCode}`);
    }
    if (loopResult?.constraints?.unstable) reasonCodes.push("FAILURE_STREAK");
    if (loopResult?.constraints?.requireRootCauseAnalysis) reasonCodes.push("REQUIRE_RCA");

    const effectiveOptions = {
        ...options,
        digest,
        verbose,
        rawLoop,
        budgetFailureStreak: loopResult?.patterns?.failureStreak ?? null,
        budgetSignalCount: reasonCodes.length,
        budgetDecision: {
            mode: options.budget,
            decision: options.budget === "full" ? "FULL" : exceptionBudget ? "EXCEPTION" : "DEFAULT",
            upgradesApplied,
            reasonCodes,
            evidence,
        },
    };

    const taskContext = buildTaskContext(task, registry, "next-task", LIMITS["next-task"], warnings, effectiveOptions);
    taskContext.parts.splice(1, 0, [
        "Ready for AI context preparation.",
        "",
        "Next:",
        `- Generate AI prompt: repo-context-kit task prompt ${task.id}`,
        `- View focused context: repo-context-kit context workset ${task.id}`,
    ].join("\n"));

    return renderBounded(taskContext.parts, {
        level: "next-task",
        taskId: task.id,
        includedSources: taskContext.includedSources,
        excludedSources: [
            "unselected task detail files",
            CONTEXT_INDEX_FILES_PATH,
            CONTEXT_INDEX_SYMBOLS_PATH,
            "full generated indexes",
        ],
        limits: `maxChars=${LIMITS["next-task"].maxChars}, maxDependencySummaries=${LIMITS["next-task"].maxDependencySummaries}`,
        warnings,
    }, LIMITS["next-task"].maxChars, effectiveOptions);
}

function selectDigestSymbols(symbols = [], maxTotal = 8) {
    const picked = [];
    const seenFiles = new Set();
    for (const symbol of symbols) {
        if (!symbol?.file) {
            continue;
        }
        if (seenFiles.has(symbol.file)) {
            continue;
        }
        seenFiles.add(symbol.file);
        picked.push(symbol);
        if (picked.length >= maxTotal) {
            break;
        }
    }
    return picked;
}

function buildWorksetDigest(taskRef, warnings = [], options = {}) {
    const registry = getPreferredTaskRegistry();
    warnings.push(...findTaskFileMismatchWarnings(registry));
    const taskId = typeof taskRef === "string" ? taskRef : null;
    const providedTask = taskRef && typeof taskRef === "object" ? taskRef : null;

    if (!taskId && !providedTask) {
        warnings.push("Missing task id.");
        return renderBounded(["# Workset Context", "Usage: repo-context-kit context workset <taskId> [--digest] [--deep]"], {
            level: "workset --digest",
            taskId: null,
            includedSources: [],
            excludedSources: ["task detail files", "generated indexes"],
            limits: `maxChars=${LIMITS["workset-digest"].maxChars}, maxRelatedFiles=${LIMITS["workset-digest"].maxRelatedFiles}, maxRelatedSymbols=${LIMITS["workset-digest"].maxRelatedSymbols}, maxDependencySummaries=${LIMITS["workset-digest"].maxDependencySummaries}`,
            warnings,
        }, LIMITS["workset-digest"].maxChars);
    }

    if (!registry.exists && !providedTask) {
        return renderBounded(["# Workset Context", "No task registry is available."], {
            level: "workset --digest",
            taskId,
            includedSources: [],
            excludedSources: ["task detail files", "generated indexes"],
            limits: `maxChars=${LIMITS["workset-digest"].maxChars}, maxRelatedFiles=${LIMITS["workset-digest"].maxRelatedFiles}, maxRelatedSymbols=${LIMITS["workset-digest"].maxRelatedSymbols}, maxDependencySummaries=${LIMITS["workset-digest"].maxDependencySummaries}`,
            warnings,
        }, LIMITS["workset-digest"].maxChars);
    }

    const task = providedTask || taskById(registry, taskId);
    if (!task) {
        warnings.push(`Task ${taskId} was not found in ${TASK_REGISTRY_PATH}.`);
        return renderBounded(["# Workset Context", `Task not found: ${taskId}`], {
            level: "workset --digest",
            taskId,
            includedSources: [TASK_REGISTRY_PATH],
            excludedSources: ["task detail files", "generated indexes"],
            limits: `maxChars=${LIMITS["workset-digest"].maxChars}, maxRelatedFiles=${LIMITS["workset-digest"].maxRelatedFiles}, maxRelatedSymbols=${LIMITS["workset-digest"].maxRelatedSymbols}, maxDependencySummaries=${LIMITS["workset-digest"].maxDependencySummaries}`,
            warnings,
        }, LIMITS["workset-digest"].maxChars);
    }

    const limits = LIMITS["workset-digest"];
    const taskContext = buildTaskContext(task, registry, "workset", limits, warnings, options);
    const relatedFiles = selectRelatedFiles(task, taskContext.detailContent, limits, warnings);
    const relatedSymbolsRaw = selectRelatedSymbols(task, taskContext.detailContent, relatedFiles, limits, warnings);
    const relatedSymbols = selectDigestSymbols(relatedSymbolsRaw, limits.maxRelatedSymbols);
    const entrypoints = readJson(CONTEXT_INDEX_ENTRYPOINTS_PATH);
    const project = readProjectContext();
    const includedSources = [...taskContext.includedSources];

    if (project.exists) {
        includedSources.push(CONTEXT_PROJECT_MD_PATH);
    }
    if (!readJson(CONTEXT_INDEX_SUMMARY_PATH)) {
        warnings.push(`${CONTEXT_INDEX_SUMMARY_PATH} is missing. Run repo-context-kit scan.`);
    }
    if (readJson(CONTEXT_INDEX_FILES_PATH)) {
        includedSources.push(CONTEXT_INDEX_FILES_PATH);
    }
    if (readJson(CONTEXT_INDEX_SYMBOLS_PATH)) {
        includedSources.push(CONTEXT_INDEX_SYMBOLS_PATH);
    }
    if (readJson(CONTEXT_INDEX_FILE_SUMMARIES_PATH)) {
        includedSources.push(CONTEXT_INDEX_FILE_SUMMARIES_PATH);
    }
    if (entrypoints) {
        includedSources.push(CONTEXT_INDEX_ENTRYPOINTS_PATH);
    }

    const parts = [
        "# Workset Context (Digest)",
        ...taskContext.parts,
        `## Related File Candidates\n\n${formatList(relatedFiles.map((file) => `${file.path} (confidence ${file.confidence.toFixed(2)}): ${file.reason}`))}`,
    ];

    const summaryReferences = formatFileSummaryReferences(relatedFiles, limits, warnings);
    if (summaryReferences) {
        parts.push(`## File Summary References\n\n${summaryReferences}`);
    }

    if (Array.isArray(entrypoints)) {
        parts.push(`## Relevant Entry Points\n\n${formatList(entrypoints.slice(0, 3).map((entry) => `${entry.path} (${entry.name}, confidence ${Number(entry.confidence ?? 0).toFixed(2)})`))}`);
    }

    if (project.riskAreas) {
        parts.push(`## Relevant Risk Areas\n\n${renderCappedBulletList(project.riskAreas, { maxItems: 12, maxChars: 700 })}`);
    }

    parts.push(`## Related Symbols\n\n${formatList(relatedSymbols.map((symbol) => `${symbol.name} (${symbol.type}) in ${symbol.file} (confidence ${symbol.confidence.toFixed(2)}): ${symbol.reason}`))}`);
    parts.push(`## Suggested Read Order\n\n${formatList([
        task.file || null,
        ...normalizeDependencies(task.dependencies).map((dependencyId) => taskById(registry, dependencyId)?.file).filter(Boolean),
        ...relatedFiles.map((file) => file.path),
    ].filter(Boolean).slice(0, limits.maxRelatedFiles + 1))}`);

    return renderBounded(parts, {
        level: "workset --digest",
        taskId: task.id,
        includedSources: [...new Set(includedSources)],
        excludedSources: ["unselected task detail files", "full files.json dump", "full symbols.json dump", "full file-summaries.json dump"],
        limits: `maxChars=${limits.maxChars}, maxRelatedFiles=${limits.maxRelatedFiles}, maxRelatedSymbols=${limits.maxRelatedSymbols}, maxDependencySummaries=${limits.maxDependencySummaries}`,
        warnings,
    }, limits.maxChars, options);
}

function buildWorkset(taskRef, options = {}) {
    const taskId = typeof taskRef === "string" ? taskRef : null;
    const providedTask = taskRef && typeof taskRef === "object" ? taskRef : null;
    let deep = Boolean(options.deep);
    let digest = Boolean(options.digest) || options.mode === "digest";

    const loopResult = (options.budget === "auto" || options.budget === "full") && taskId
        ? evaluateContextLoop({ taskId })
        : null;
    const hasFailedTest = Boolean(loopResult?.mostRecentTest && Number(loopResult.mostRecentTest.exitCode) !== 0);
    const exceptionBudget = Boolean(hasFailedTest || loopResult?.constraints?.unstable || loopResult?.constraints?.requireRootCauseAnalysis);
    const projectRiskAreas = Boolean(readProjectContext()?.riskAreas);
    const hasRiskAreasSignal = Boolean(projectRiskAreas);

    if (options.budget === "full") {
        if (!options.deepLocked) {
            deep = true;
        }
        if (!options.digestLocked) {
            digest = false;
        }
    } else if (options.budget === "auto" && exceptionBudget) {
        if (!options.deepLocked) {
            deep = true;
        }
        if (!options.digestLocked) {
            digest = false;
        }
    }

    if (options.budget === "auto" && digest && !options.digestLocked && hasRiskAreasSignal) {
        digest = false;
    }

    const rawLoop = Boolean(options.rawLoop) || (exceptionBudget && options.budget === "auto") || options.budget === "full";
    const verbose = Boolean(options.verbose) || (exceptionBudget && options.budget === "auto") || options.budget === "full";
    const upgradesApplied = [];
    if (!options.deep && deep) upgradesApplied.push("deep");
    if (Boolean(options.digest) && digest === false) upgradesApplied.push("digest-off");
    if (!options.verbose && verbose) upgradesApplied.push("verbose");
    if (!options.rawLoop && rawLoop) upgradesApplied.push("raw-loop");

    const reasonCodes = [];
    const evidence = [];
    if (loopResult?.mostRecentTest) {
        const exitCode = Number(loopResult.mostRecentTest.exitCode);
        const command = loopResult.mostRecentTest.command ? String(loopResult.mostRecentTest.command) : "";
        if (Number.isFinite(exitCode) && exitCode !== 0) reasonCodes.push("RECENT_TEST_FAIL");
        if (command) evidence.push(`last_test_exit=${exitCode} command="${command}"`);
        else evidence.push(`last_test_exit=${exitCode}`);
    }
    if (loopResult?.constraints?.unstable) reasonCodes.push("FAILURE_STREAK");
    if (loopResult?.constraints?.requireRootCauseAnalysis) reasonCodes.push("REQUIRE_RCA");
    if (options.budget === "auto" && hasRiskAreasSignal) reasonCodes.push("HIGH_RISK_AREAS");

    const effectiveOptions = {
        ...options,
        deep,
        digest,
        verbose,
        rawLoop,
        budgetFailureStreak: loopResult?.patterns?.failureStreak ?? null,
        budgetSignalCount: reasonCodes.length,
        budgetDecision: {
            mode: options.budget,
            decision: options.budget === "full" ? "FULL" : (exceptionBudget || hasRiskAreasSignal) ? "EXCEPTION" : "DEFAULT",
            upgradesApplied,
            reasonCodes,
            evidence,
        },
    };

    if (digest && !deep) {
        const warnings = [];
        return buildWorksetDigest(providedTask || taskId, warnings, effectiveOptions);
    }

    const level = deep ? "workset --deep" : "workset";
    const limits = deep ? LIMITS["workset-deep"] : LIMITS.workset;
    const warnings = [];
    const registry = getPreferredTaskRegistry();
    warnings.push(...findTaskFileMismatchWarnings(registry));

    if (!taskId && !providedTask) {
        warnings.push("Missing task id.");
        return renderBounded(["# Workset Context", "Usage: repo-context-kit context workset <taskId>"], {
            level,
            taskId: null,
            includedSources: [],
            excludedSources: ["task detail files", "generated indexes"],
            limits: `maxChars=${limits.maxChars}, maxRelatedFiles=${limits.maxRelatedFiles}, maxRelatedSymbols=${limits.maxRelatedSymbols}, maxDependencySummaries=${limits.maxDependencySummaries}`,
            warnings,
        }, limits.maxChars);
    }

    if (!registry.exists && !providedTask) {
        return renderBounded(["# Workset Context", "No task registry is available."], {
            level,
            taskId,
            includedSources: [],
            excludedSources: ["task detail files", "generated indexes"],
            limits: `maxChars=${limits.maxChars}, maxRelatedFiles=${limits.maxRelatedFiles}, maxRelatedSymbols=${limits.maxRelatedSymbols}, maxDependencySummaries=${limits.maxDependencySummaries}`,
            warnings,
        }, limits.maxChars);
    }

    const task = providedTask || taskById(registry, taskId);
    if (!task) {
        warnings.push(`Task ${taskId} was not found in ${TASK_REGISTRY_PATH}.`);
        return renderBounded(["# Workset Context", `Task not found: ${taskId}`], {
            level,
            taskId,
            includedSources: [TASK_REGISTRY_PATH],
            excludedSources: ["task detail files", "generated indexes"],
            limits: `maxChars=${limits.maxChars}, maxRelatedFiles=${limits.maxRelatedFiles}, maxRelatedSymbols=${limits.maxRelatedSymbols}, maxDependencySummaries=${limits.maxDependencySummaries}`,
            warnings,
        }, limits.maxChars);
    }

    const brief = buildBrief({ ...effectiveOptions, digest: true }).replace(/^## Context Meta[\s\S]*$/m, "").trim();
    const taskContext = buildTaskContext(task, registry, "workset", limits, warnings, effectiveOptions);
    const relatedFiles = selectRelatedFiles(task, taskContext.detailContent, limits, warnings);
    const relatedSymbols = selectRelatedSymbols(task, taskContext.detailContent, relatedFiles, limits, warnings);
    const entrypoints = readJson(CONTEXT_INDEX_ENTRYPOINTS_PATH);
    const project = readProjectContext();
    const includedSources = [...taskContext.includedSources];

    if (project.exists) {
        includedSources.push(CONTEXT_PROJECT_MD_PATH);
    }
    if (readJson(CONTEXT_INDEX_SUMMARY_PATH)) {
        includedSources.push(CONTEXT_INDEX_SUMMARY_PATH);
    } else {
        warnings.push(`${CONTEXT_INDEX_SUMMARY_PATH} is missing. Run repo-context-kit scan.`);
    }
    if (readJson(CONTEXT_INDEX_FILES_PATH)) {
        includedSources.push(CONTEXT_INDEX_FILES_PATH);
    }
    if (readJson(CONTEXT_INDEX_SYMBOLS_PATH)) {
        includedSources.push(CONTEXT_INDEX_SYMBOLS_PATH);
    }
    if (readJson(CONTEXT_INDEX_FILE_SUMMARIES_PATH)) {
        includedSources.push(CONTEXT_INDEX_FILE_SUMMARIES_PATH);
    }

    if (entrypoints) {
        includedSources.push(CONTEXT_INDEX_ENTRYPOINTS_PATH);
    }

    const parts = [
        brief,
        ...taskContext.parts,
        `## Related File Candidates\n\n${formatList(relatedFiles.map((file) => `${file.path} (confidence ${file.confidence.toFixed(2)}): ${file.reason}. ${file.description}`))}`,
    ];

    const summaryReferences = formatFileSummaryReferences(relatedFiles, limits, warnings);
    if (summaryReferences) {
        parts.push(`## File Summary References\n\n${summaryReferences}`);
    }

    if (Array.isArray(entrypoints)) {
        parts.push(`## Relevant Entry Points\n\n${formatList(entrypoints.slice(0, 5).map((entry) => `${entry.path} (${entry.name}, confidence ${Number(entry.confidence ?? 0).toFixed(2)})`))}`);
    }

    if (project.riskAreas) {
        parts.push(`## Relevant Risk Areas\n\n${renderCappedBulletList(project.riskAreas, { maxItems: 12, maxChars: 1800 })}`);
    }

    parts.push(`## Related Symbols\n\n${formatList(relatedSymbols.map((symbol) => `${symbol.name} (${symbol.type}) in ${symbol.file} (confidence ${symbol.confidence.toFixed(2)}): ${symbol.reason}`))}`);
    parts.push(`## Suggested Read Order\n\n${formatList([
        task.file || null,
        ...normalizeDependencies(task.dependencies).map((dependencyId) => taskById(registry, dependencyId)?.file).filter(Boolean),
        ...relatedFiles.map((file) => file.path),
    ].filter(Boolean).slice(0, limits.maxRelatedFiles + 1))}`);

    return renderBounded(parts, {
        level,
        taskId: task.id,
        includedSources: [...new Set(includedSources)],
        excludedSources: ["unselected task detail files", "full files.json dump", "full symbols.json dump", "full file-summaries.json dump"],
        limits: `maxChars=${limits.maxChars}, maxRelatedFiles=${limits.maxRelatedFiles}, maxRelatedSymbols=${limits.maxRelatedSymbols}, maxDependencySummaries=${limits.maxDependencySummaries}`,
        warnings,
    }, limits.maxChars, effectiveOptions);
}

export function buildWorksetContext(taskId, options = {}) {
    return buildWorkset(taskId, options);
}

export async function runContext(args = []) {
    const subcommand = args.find((arg) => !arg.startsWith("--"));
    const deep = args.includes("--deep");
    const compact = args.includes("--compact");
    const digestFlag = args.includes("--digest");
    const full = args.includes("--full");
    const digest = compact || digestFlag || !full;
    const manifest = args.includes("--manifest");
    const verbose = args.includes("--verbose");
    const rawLoop = args.includes("--raw-loop");
    const summaryJson = args.includes("--summary-json");
    const budget = resolveBudgetMode(args);
    const noCache = args.includes("--no-cache");
    let output;

    if (subcommand === "help" || args.includes("--help")) {
        console.log("Usage:");
        console.log("  repo-context-kit context brief");
        console.log("  repo-context-kit context next-task");
        console.log("  repo-context-kit context workset <taskId> [--compact|--digest] [--deep]");
        console.log("");
        console.log("Options:");
        console.log("  --compact    Prefer bounded digest output (same as default)");
        console.log("  --full       Disable digest output");
        console.log("  --manifest   Include full context manifest footer");
        console.log("  --verbose    Print all warnings instead of summarizing");
        return {
            output: null,
        };
    }

    if (subcommand === "brief") {
        output = serializeRuntimeJson(toContextBriefJson());
    } else if (subcommand === "next-task") {
        output = serializeRuntimeJson(toNextTaskJson());
    } else if (subcommand === "workset") {
        const worksetIndex = args.indexOf(subcommand);
        const taskId = args.slice(worksetIndex + 1).find((arg) => !arg.startsWith("--"));
        if (!taskId) {
            process.exitCode = 1;
        } else {
            const registry = getPreferredTaskRegistry();
            if (!registry.exists || !taskById(registry, taskId)) {
                process.exitCode = 1;
            }
        }
        const detail = full ? "full" : digest ? "digest" : "compact";
        output = serializeRuntimeJson(toWorksetJson(taskId, { deep, detail }));
    } else {
        console.error("Unknown context command.");
        console.log("Usage:");
        console.log("  repo-context-kit context brief");
        console.log("  repo-context-kit context next-task");
        console.log("  repo-context-kit context workset <taskId> [--compact|--digest] [--deep]");
        console.log("Options:");
        console.log("  --compact    Prefer bounded digest output (same as default)");
        console.log("  --full       Disable digest output");
        console.log("  --manifest   Include full context manifest footer");
        console.log("  --verbose    Print all warnings instead of summarizing");
        console.log("  --summary-json  Print scan summary as JSON (brief only)");
        console.log("  --no-cache   Disable brief digest cache");
        process.exitCode = 1;
        return {
            output: null,
        };
    }

    console.log(output.trimEnd());

    return {
        output,
    };
}
