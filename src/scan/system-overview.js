import {
    CONTEXT_DIR,
    CONTEXT_INDEX_ENTRYPOINTS_PATH,
    CONTEXT_INDEX_FILE_GROUPS_PATH,
    CONTEXT_INDEX_FILES_PATH,
    CONTEXT_INDEX_FILE_SUMMARIES_PATH,
    CONTEXT_INDEX_SUMMARY_PATH,
    CONTEXT_INDEX_SYMBOLS_PATH,
    CONTEXT_LESSONS_PATH,
    CONTEXT_PROJECT_MD_PATH,
    CONTEXT_SAFETY_PATH,
    CONTEXT_SYSTEM_OVERVIEW_PATH,
    CONTEXT_TASKS_PATH,
    CONTEXT_WORKFLOW_PATH,
    HUMAN_PROJECT_BRIEF_PATH,
} from "./constants.js";
import { ensureDir, exists, readText, writeText } from "./fs-utils.js";
import {
    getMergedTaskMetadata,
    getTaskHealthSummary,
    listTaskFiles,
} from "./task-files.js";
import {
    getRegistryStatusBreakdown,
    parseTaskRegistry,
} from "./task-registry.js";

const CONTEXT_SOURCES = [
    [HUMAN_PROJECT_BRIEF_PATH, "Human-owned project brief and requirements"],
    [CONTEXT_PROJECT_MD_PATH, "Generated AI project context compiled from scan data and PROJECT.md"],
    [CONTEXT_INDEX_SUMMARY_PATH, "Scan metadata and index counts"],
    [CONTEXT_INDEX_ENTRYPOINTS_PATH, "Detected CLI, app, and execution entry points"],
    [CONTEXT_INDEX_FILE_GROUPS_PATH, "Directory-level groups and key files"],
    [CONTEXT_INDEX_FILES_PATH, "Important files with AI-readable descriptions"],
    [CONTEXT_INDEX_FILE_SUMMARIES_PATH, "Per-file summaries including exports, imports, and detected calls"],
    [CONTEXT_INDEX_SYMBOLS_PATH, "Detected functions, classes, components, and exports"],
];

const RULE_SOURCES = [
    ["AGENTS.md", "Main AI workflow entry point"],
    [HUMAN_PROJECT_BRIEF_PATH, "Human-owned project purpose, stack, and requirements"],
    [".aidw/rules.md", "Repository engineering rules and constraints"],
    [".aidw/confirmation-protocol.md", "Click-to-confirm execution protocol and compact presentation rules"],
    [CONTEXT_WORKFLOW_PATH, "Standard AI-assisted development workflow"],
    [CONTEXT_SAFETY_PATH, "Protected areas and AI change safety rules"],
    [CONTEXT_LESSONS_PATH, "Learned hard-blocking rules derived from recent failures"],
    [".github/copilot-instructions.md", "GitHub Copilot repository instructions"],
    [".trae/rules/project_rules.md", "Trae repository rules adapter"],
    ["skill.md", "Claude-style skill workflow adapter"],
];

const GENERATED_INDEXES = [
    [CONTEXT_INDEX_SUMMARY_PATH, "Scan metadata and index counts"],
    [CONTEXT_INDEX_ENTRYPOINTS_PATH, "Detected execution entry points"],
    [CONTEXT_INDEX_FILE_GROUPS_PATH, "Directory groups and key files"],
    [CONTEXT_INDEX_FILES_PATH, "Important file map"],
    [CONTEXT_INDEX_FILE_SUMMARIES_PATH, "File summaries and symbol hints"],
    [CONTEXT_INDEX_SYMBOLS_PATH, "Detected source symbols"],
];

const AI_TOOL_ADAPTERS = [
    ["AGENTS.md", "Main AI entry point"],
    [".github/copilot-instructions.md", "GitHub Copilot"],
    [".trae/rules/project_rules.md", "Trae"],
];

function statusFor(filePath) {
    return exists(filePath) ? "present" : "missing";
}

function formatRecord(filePath, purpose) {
    return `- \`${filePath}\` - status: ${statusFor(filePath)} - ${purpose}`;
}

function appendRecords(lines, records) {
    lines.push(...records.map(([filePath, purpose]) => formatRecord(filePath, purpose)));
}

function appendTaskSources(lines) {
    const taskFiles = listTaskFiles();
    const taskStatus = taskFiles.length > 0 ? "present" : "missing";

    lines.push(
        formatRecord(".aidw/task-entry.md", "Reusable task request template"),
        `- \`task/*.md\` - status: ${taskStatus} - Markdown task files (${taskFiles.length} detected)`,
    );

    for (const filePath of taskFiles.slice(0, 10)) {
        lines.push(`  - \`${filePath}\``);
    }

    lines.push(
        formatRecord(CONTEXT_TASKS_PATH, "Generated task-to-file mapping index"),
    );
}

function appendTaskHealth(lines) {
    const mergedTasks = getMergedTaskMetadata();
    const health = getTaskHealthSummary(mergedTasks);

    lines.push(
        `- Task count: ${health.count}`,
        `- Tasks with acceptance criteria: ${health.withAcceptanceCriteria}`,
        `- Tasks with test command: ${health.withTestCommand}`,
        `- Tasks with definition of done: ${health.withDefinitionOfDone}`,
    );
}

function appendTaskRegistry(lines) {
    const registry = parseTaskRegistry();
    const breakdown = getRegistryStatusBreakdown(registry.tasks);
    const health = getTaskHealthSummary(getMergedTaskMetadata());
    const total = registry.tasks.length;

    lines.push(
        `- Registry file: task/task.md (${registry.exists ? "present" : "missing"})`,
        `- Total tasks: ${total}`,
        "- Status breakdown:",
        `  - todo: ${breakdown.todo}`,
        `  - in_progress: ${breakdown.in_progress}`,
        `  - done: ${breakdown.done}`,
        `  - blocked: ${breakdown.blocked}`,
        `  - cancelled: ${breakdown.cancelled}`,
        "",
        "- Task health:",
        `  - tasks with acceptance criteria: ${health.withAcceptanceCriteria} / ${health.count}`,
        `  - tasks with test command: ${health.withTestCommand} / ${health.count}`,
        `  - tasks with definition of done: ${health.withDefinitionOfDone} / ${health.count}`,
    );
}

function normalizeContent(content) {
    const normalized = content.replace(/\r\n/g, "\n").replace(/\n$/, "");
    return normalized
        .replace(
            /(- `\.aidw\/confirmation-gate\.json` - status: )(present|missing)/g,
            "$1runtime",
        )
        .replace(
            /(- `\.aidw\/context-loop\.jsonl` - status: )(present|missing)/g,
            "$1runtime",
        )
        .replace(
            /(- `\.aidw\/context-cache\.md` - status: )(present|missing)/g,
            "$1runtime",
        );
}

export function generateSystemOverviewContent() {
    const lines = [
        "# AI System Overview",
        "",
        "<!-- AUTO-GENERATED: repo-context-kit. Do not edit manually. -->",
        "",
        "## Purpose",
        "",
        "This file summarizes the AI-readable context system for this repository.",
        "",
        "## Context Sources",
        "",
    ];

    appendRecords(lines, CONTEXT_SOURCES);

    lines.push("", "## Rule Sources", "");
    appendRecords(lines, RULE_SOURCES);

    lines.push("", "## Task Sources", "");
    appendTaskSources(lines);

    lines.push("", "## Task Registry", "");
    appendTaskRegistry(lines);

    lines.push("", "## Task Health", "");
    appendTaskHealth(lines);

    lines.push("", "## Generated Indexes", "");
    appendRecords(lines, GENERATED_INDEXES);

    lines.push("", "## AI Tool Adapters", "");
    appendRecords(lines, AI_TOOL_ADAPTERS);

    lines.push(
        "",
        "## Execution Loop (Optional)",
        "",
        formatRecord(".aidw/confirmation-gate.json", "Local gate state for task/test confirmations (runtime file)"),
        formatRecord(".aidw/context-loop.jsonl", "Append-only context loop log for recent confirmations and test runs (runtime file)"),
        formatRecord(".aidw/context-cache.md", "Cached token-efficient brief context output (runtime file)"),
        formatRecord("repo-context-kit metrics", "Print compact runtime metrics JSON"),
        formatRecord("repo-context-kit check", "Run checks derived from lessons (blocker rules fail by default)"),
    );

    lines.push(
        "",
        "## Recommended AI Workflow",
        "",
        "1. Read AGENTS.md first.",
        "2. Read PROJECT.md for human project intent.",
        "3. Read .aidw/AI_project.md for generated AI context.",
        "4. Read .aidw/rules.md for repository rules.",
        "5. Read .aidw/system-overview.md to understand available context sources.",
        "6. Read the current task file before making changes.",
        "7. Use .aidw/index/* files to locate relevant code.",
        "8. Preserve project structure and update tests.",
    );

    return `${lines.join("\n")}\n`;
}

export function getSystemOverviewUpdate(content = generateSystemOverviewContent()) {
    if (!exists(CONTEXT_SYSTEM_OVERVIEW_PATH)) {
        return {
            changed: true,
            content,
        };
    }

    const existing = readText(CONTEXT_SYSTEM_OVERVIEW_PATH);

    return {
        changed: normalizeContent(existing) !== normalizeContent(content),
        content,
    };
}

export function updateSystemOverview(content = generateSystemOverviewContent()) {
    const update = getSystemOverviewUpdate(content);

    if (!update.changed) {
        return update;
    }

    ensureDir(CONTEXT_DIR);
    writeText(CONTEXT_SYSTEM_OVERVIEW_PATH, update.content);

    return update;
}
