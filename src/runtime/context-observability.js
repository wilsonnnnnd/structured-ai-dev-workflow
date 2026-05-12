import {
    CONTEXT_INDEX_ENTRYPOINTS_PATH,
    CONTEXT_INDEX_FILE_GROUPS_PATH,
    CONTEXT_INDEX_FILES_PATH,
    CONTEXT_INDEX_SUMMARY_PATH,
    CONTEXT_INDEX_SYMBOLS_PATH,
    CONTEXT_PROJECT_MD_PATH,
    TASK_REGISTRY_PATH,
} from "../scan/constants.js";
import { exists, readJson, readText } from "../scan/fs-utils.js";
import { parseTaskRegistry } from "../scan/task-registry.js";
import { computeContextHash, detectSemanticDuplication } from "./context-compression.js";
import { rankFilesForContext } from "./context-relevance.js";
import { applyRuntimeBudget } from "./context-budget.js";
import { serializeCompactJson } from "./serialize.js";

function stableString(value) {
    return String(value ?? "").trim();
}

function safeReadText(filePath) {
    if (!exists(filePath)) {
        return "";
    }
    try {
        return readText(filePath);
    } catch {
        return "";
    }
}

function safeReadJson(filePath, fallback = null) {
    try {
        const value = readJson(filePath);
        return value ?? fallback;
    } catch {
        return fallback;
    }
}

function tokenize(text) {
    return [
        ...new Set((stableString(text).toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])),
    ].filter((token) => !["task", "with", "from", "this", "that", "only", "and"].includes(token));
}

function scoreText(text, keywords) {
    const haystack = stableString(text).toLowerCase();
    return keywords.reduce((acc, keyword) => acc + (haystack.includes(keyword) ? 1 : 0), 0);
}

function taskById(registry, taskId) {
    return registry.tasks.find((task) => String(task.id).toLowerCase() === String(taskId).toLowerCase()) ?? null;
}

function getTaskDetail(task) {
    if (!task?.file || !exists(task.file)) {
        return "";
    }
    return safeReadText(task.file);
}

function isFrontendTask(task, detailContent) {
    const haystack = `${stableString(task?.title)}\n${stableString(detailContent)}`.toLowerCase();
    return /(ui|frontend|react|vue|css|style|component|design|layout|theme)/i.test(haystack);
}

function getUiDesignSection(maxChars = 1200) {
    const content = safeReadText(CONTEXT_PROJECT_MD_PATH);
    if (!content) {
        return "";
    }
    const regex = /(?:^|\n)##\s+UI Design Context\s*\n(?<body>[\s\S]*?)(?=\n##\s|$)/i;
    const match = content.match(regex);
    const section = match?.groups?.body?.trim() ?? "";
    if (!section) {
        return "";
    }
    return section.length > maxChars ? `${section.slice(0, maxChars - 12).trimEnd()}\n[truncated]` : section;
}

function buildCandidates(task, detailContent) {
    const files = safeReadJson(CONTEXT_INDEX_FILES_PATH, []);
    const entrypoints = safeReadJson(CONTEXT_INDEX_ENTRYPOINTS_PATH, []);
    const groups = safeReadJson(CONTEXT_INDEX_FILE_GROUPS_PATH, []);
    const keywords = tokenize(`${stableString(task?.id)} ${stableString(task?.title)} ${detailContent}`);
    const explicitPaths = new Set(
        (detailContent.match(/(?:bin|src|test|tests|app|template|site)\/[A-Za-z0-9._/-]+/g) ?? [])
            .map((filePath) => filePath.replace(/[),.;]+$/g, "")),
    );
    const entrypointPaths = new Set((Array.isArray(entrypoints) ? entrypoints : []).map((entry) => entry.path));
    const groupKeyFiles = new Set((Array.isArray(groups) ? groups : []).flatMap((group) => group.keyFiles ?? []));

    const base = (Array.isArray(files) ? files : [])
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
                explicit ? "explicit_path" : null,
                textScore > 0 ? "keyword_match" : null,
                entrypoint ? "entrypoint" : null,
                groupKey ? "group_key" : null,
            ].filter(Boolean);
            return {
                file: file.path,
                baseScore: score,
                reasons,
            };
        })
        .filter(Boolean)
        .sort((a, b) => b.baseScore - a.baseScore || a.file.localeCompare(b.file));

    if (base.length === 0) {
        return [];
    }

    const sourcePath = stableString(task?.file) || base[0].file;
    const ranked = rankFilesForContext(sourcePath, base.map((item) => item.file), { recentFiles: [] });
    const rankedMap = new Map(ranked.map((item) => [item.file, item]));

    return base
        .map((item) => {
            const relevance = rankedMap.get(item.file);
            const score = item.baseScore + Math.round((relevance?.score ?? 0) / 20);
            const reasons = [
                ...item.reasons,
                ...((relevance?.reasons ?? []).map((reason) => `relevance:${reason}`)),
            ];
            return {
                file: item.file,
                score,
                reasons: [...new Set(reasons)],
            };
        })
        .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
}

function collectCanonicalRefs() {
    const refs = [];
    if (exists(".aidw/rules-canonical.md")) {
        refs.push(".aidw/rules-canonical.md#reuse-backward-compatibility");
        refs.push(".aidw/rules-canonical.md#implementation-order-logic-first");
        refs.push(".aidw/rules-canonical.md#context-discipline");
    }
    if (exists(".aidw/workflow.md")) {
        refs.push(".aidw/workflow.md");
    }
    return refs;
}

export function buildContextTrace(taskId, options = {}) {
    const registry = parseTaskRegistry();
    const task = registry.exists ? taskById(registry, taskId) : null;
    if (!task) {
        return {
            selected_context: [],
            excluded_context: [],
            canonical_refs: collectCanonicalRefs(),
            compression: {
                deduplicated_sections: 0,
                saved_chars: 0,
                compressed_chars: 0,
            },
            warnings: [`task_not_found:${taskId}`],
        };
    }

    const detailContent = getTaskDetail(task);
    const candidates = buildCandidates(task, detailContent);
    const maxSelected = Number.isFinite(Number(options.maxSelected)) ? Number(options.maxSelected) : 12;
    const maxExcluded = Number.isFinite(Number(options.maxExcluded)) ? Number(options.maxExcluded) : 12;
    const selected = candidates.slice(0, maxSelected).map((item) => ({
        file: item.file,
        score: Number((Math.min(1, item.score / 20)).toFixed(2)),
        reason: item.reasons,
    }));
    const excluded = candidates
        .slice(maxSelected, maxSelected + maxExcluded)
        .map((item) => ({
            file: item.file,
            reason: item.score <= 1 ? "low_relevance" : "bounded_limit",
        }));

    const canonicalRefs = collectCanonicalRefs();
    const rulesBrief = safeReadText(".aidw/rules.md");
    const rulesCanonical = safeReadText(".aidw/rules-canonical.md");
    const duplicateStats = detectSemanticDuplication([
        ...rulesBrief.split("\n").filter((line) => line.trim().length > 10),
        ...rulesCanonical.split("\n").filter((line) => line.trim().length > 10),
    ]);
    const sourceChars = rulesBrief.length + rulesCanonical.length;
    const deduplicatedSections = duplicateStats.duplicates.length;
    const savedChars = Math.max(0, deduplicatedSections * 120);
    const compressedChars = Math.max(0, sourceChars - savedChars);

    return {
        selected_context: selected,
        excluded_context: excluded,
        canonical_refs: canonicalRefs,
        compression: {
            deduplicated_sections: deduplicatedSections,
            saved_chars: savedChars,
            compressed_chars: compressedChars,
        },
    };
}

export function buildContextBudget() {
    const architecture = safeReadText(CONTEXT_PROJECT_MD_PATH);
    const workflow = safeReadText(".aidw/workflow.md");
    const rules = safeReadText(".aidw/rules-canonical.md");
    const taskRegistry = safeReadText(TASK_REGISTRY_PATH);
    const summary = JSON.stringify(safeReadJson(CONTEXT_INDEX_SUMMARY_PATH, {}) ?? {});
    const files = JSON.stringify(safeReadJson(CONTEXT_INDEX_FILES_PATH, []) ?? []);
    const symbols = JSON.stringify(safeReadJson(CONTEXT_INDEX_SYMBOLS_PATH, []) ?? []);
    const loopRaw = safeReadText(".aidw/context-loop.jsonl");
    const uiSection = getUiDesignSection(1800);

    const buckets = {
        architecture: architecture.length,
        workflow: workflow.length,
        rules: rules.length,
        task: taskRegistry.length,
        workset: files.length + symbols.length + summary.length,
        ui: uiSection.length,
        lessons: safeReadText(".aidw/lessons.md").length,
        runtime: loopRaw.length,
        cache_metadata: 120,
    };

    const totalChars = Object.values(buckets).reduce((acc, value) => acc + value, 0);
    const duplicateStats = detectSemanticDuplication([
        architecture,
        workflow,
        rules,
        taskRegistry,
    ]);
    const compressedChars = Math.max(0, totalChars - duplicateStats.duplicates.length * 100);
    const savedChars = Math.max(0, totalChars - compressedChars);
    const compressionRatio = totalChars > 0 ? Number((compressedChars / totalChars).toFixed(3)) : 1;

    return {
        context_budget: buckets,
        total_chars: totalChars,
        compressed_chars: compressedChars,
        saved_chars: savedChars,
        compression_ratio: compressionRatio,
    };
}

export function detectContextDrift() {
    const findings = [];
    const agents = safeReadText("AGENTS.md");
    const workflow = safeReadText(".aidw/workflow.md");
    const rules = safeReadText(".aidw/rules.md");
    const taskEntry = safeReadText(".aidw/task-entry.md");
    const canonical = safeReadText(".aidw/rules-canonical.md");

    if (agents && !agents.includes(".aidw/rules-canonical.md")) {
        findings.push({
            severity: "high",
            file: "AGENTS.md",
            issue: "missing_canonical_reference",
            recommendation: "add_reference_to_rules_canonical",
        });
    }

    if (workflow && !workflow.toLowerCase().includes("rules-canonical")) {
        findings.push({
            severity: "high",
            file: ".aidw/workflow.md",
            issue: "workflow_not_canonicalized",
            recommendation: "reference_rules_canonical",
        });
    }

    if (taskEntry && !taskEntry.toLowerCase().includes("rules-canonical")) {
        findings.push({
            severity: "medium",
            file: ".aidw/task-entry.md",
            issue: "task_entry_missing_canonical_refs",
            recommendation: "add_canonical_refs",
        });
    }

    const duplicateStats = detectSemanticDuplication([
        ...rules.split("\n").filter((line) => line.trim().length > 10),
        ...canonical.split("\n").filter((line) => line.trim().length > 10),
    ]);

    if (duplicateStats.density > 0.12) {
        findings.push({
            severity: "medium",
            file: ".aidw/rules.md",
            issue: "duplicate_instruction_reintroduced",
            recommendation: "reduce_duplicate_rules_and_reference_canonical",
        });
    }

    return findings
        .sort((a, b) => a.file.localeCompare(b.file) || a.issue.localeCompare(b.issue))
        .slice(0, 8);
}

export function buildRuntimeMetrics() {
    const budget = buildContextBudget();
    const drift = detectContextDrift();
    const trace = buildContextTrace("T-001", { maxSelected: 6, maxExcluded: 6 });
    const cacheableRatio = budget.total_chars > 0
        ? Number(((budget.context_budget.architecture + budget.context_budget.workflow + budget.context_budget.rules) / budget.total_chars).toFixed(3))
        : 0;
    const relevanceEfficiency = trace.selected_context.length > 0
        ? Number((trace.selected_context.reduce((acc, item) => acc + Number(item.score), 0) / trace.selected_context.length).toFixed(3))
        : 0;

    return {
        average_prompt_chars: Math.round((budget.context_budget.task + budget.context_budget.workset + budget.context_budget.rules) * 0.8),
        compression_ratio: budget.compression_ratio,
        duplication_ratio: budget.total_chars > 0 ? Number((trace.compression.saved_chars / budget.total_chars).toFixed(3)) : 0,
        cacheable_ratio: cacheableRatio,
        relevance_efficiency: relevanceEfficiency,
        context_reuse_ratio: Number((cacheableRatio * 0.85).toFixed(3)),
        signal_noise_ratio: Number(Math.max(0.2, 1 - drift.length * 0.08).toFixed(3)),
    };
}

export function buildVolatilityPlan(taskId) {
    const registry = parseTaskRegistry();
    const task = registry.exists ? taskById(registry, taskId) : null;
    const detail = task ? getTaskDetail(task) : "";
    const isFrontend = Boolean(task && isFrontendTask(task, detail));

    return {
        low_volatility: {
            architecture: "reference_only",
            rules: "reference_only",
            workflow: "reference_only",
            design_system: isFrontend ? "reference_only" : "skip",
        },
        high_volatility: {
            task_status: "inject",
            changed_files: "inject",
            recent_failures: "inject",
            runtime_loop: "summarize",
            workset: "inject",
        },
        context_hash: computeContextHash({ taskId, isFrontend }),
    };
}

export function formatCompactJson(payload) {
    return serializeCompactJson(applyRuntimeBudget(payload));
}
