import {
    CONTEXT_INDEX_ENTRYPOINTS_PATH,
    CONTEXT_INDEX_FILE_GROUPS_PATH,
    CONTEXT_INDEX_FILES_PATH,
    CONTEXT_INDEX_SUMMARY_PATH,
    CONTEXT_TASKS_PATH,
    RUNTIME_CONTEXT_PATH,
    RUNTIME_DIR,
    RUNTIME_EXECUTION_PATH,
    RUNTIME_TASK_PATH,
    RUNTIME_VERIFICATION_PATH,
    TASK_REGISTRY_PATH,
} from "../scan/constants.js";
import { ensureDir, exists, readJson, writeText } from "../scan/fs-utils.js";
import { getMergedTaskMetadata, getTaskHealthSummary } from "../scan/task-files.js";
import { parseTaskRegistry } from "../scan/task-registry.js";
import { serializeJson } from "./serialize.js";
import { stableStringCompare } from "./stable-sort.js";

export const RUNTIME_JSON_SCHEMA_VERSION = "runtime/v1";

export const RUNTIME_JSON_PATHS = [
    RUNTIME_TASK_PATH,
    RUNTIME_CONTEXT_PATH,
    RUNTIME_EXECUTION_PATH,
    RUNTIME_VERIFICATION_PATH,
];

function clampText(value, max = 240) {
    const text = String(value ?? "").trim();
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(0, max - 12)).trimEnd()} [truncated]`;
}

function sortById(items) {
    return [...items].sort((a, b) => stableStringCompare(a.id, b.id));
}

function normalizeDependencies(value) {
    return String(value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .sort(stableStringCompare);
}

function generatedAtFromSummary() {
    const summary = readJson(CONTEXT_INDEX_SUMMARY_PATH);
    const generatedAt = String(summary?.generatedAt ?? "").trim();
    return generatedAt || "unknown";
}

function buildEnvelope(kind, payload, source) {
    return {
        schemaVersion: RUNTIME_JSON_SCHEMA_VERSION,
        generatedAt: generatedAtFromSummary(),
        source,
        kind,
        payload,
    };
}

export function normalizeRuntimeTasks(tasks = getMergedTaskMetadata()) {
    return sortById(tasks)
        .slice(0, 50)
        .map((task) => ({
            id: clampText(task.id, 32),
            title: clampText(task.title, 180),
            status: clampText(task.status || "todo", 32),
            priority: clampText(task.priority || "medium", 32),
            owner: clampText(task.owner || "-", 80),
            dependencies: normalizeDependencies(task.dependencies),
            file: task.file || task.path || null,
            hasAcceptanceCriteria: Boolean(task.hasAcceptanceCriteria),
            hasDefinitionOfDone: Boolean(task.hasDefinitionOfDone),
            hasTestCommand: Boolean(task.hasTestCommand),
        }));
}

export function buildRuntimeTaskJson(tasks = getMergedTaskMetadata()) {
    return buildEnvelope(
        "task",
        {
            registryPath: TASK_REGISTRY_PATH,
            tasks: normalizeRuntimeTasks(tasks),
        },
        {
            generatedBy: "repo-context-kit scan",
            inputs: [TASK_REGISTRY_PATH, "task/*.md", CONTEXT_TASKS_PATH],
        },
    );
}

export function buildRuntimeContextJson(scanData = {}) {
    const summary = readJson(CONTEXT_INDEX_SUMMARY_PATH) || {};
    const files = readJson(CONTEXT_INDEX_FILES_PATH) || [];
    const entrypoints = readJson(CONTEXT_INDEX_ENTRYPOINTS_PATH) || [];
    const fileGroups = readJson(CONTEXT_INDEX_FILE_GROUPS_PATH) || [];

    return buildEnvelope(
        "context",
        {
            projectType: String(scanData.projectType ?? "").trim() || null,
            techStack: Array.isArray(scanData.techStack) ? scanData.techStack.slice(0, 20).map((x) => String(x)) : [],
            riskAreas: Array.isArray(scanData.risks) ? scanData.risks.slice(0, 30).map((x) => clampText(x, 240)) : [],
            index: {
                indexedFiles: Number(summary.indexedFiles ?? 0),
                indexedSymbols: Number(summary.indexedSymbols ?? 0),
                fileGroups: Number(summary.fileGroups ?? 0),
                truncated: Boolean(summary.truncated),
            },
            entrypoints: Array.isArray(entrypoints)
                ? entrypoints.slice(0, 40).map((entry) => ({
                      name: clampText(entry.name ?? entry.label, 120),
                      path: entry.path ? clampText(entry.path, 240) : null,
                  }))
                : [],
            topFiles: Array.isArray(files)
                ? files.slice(0, 80).map((file) => ({
                      path: clampText(file.path, 240),
                      type: clampText(file.type, 80),
                      description: clampText(file.description, 180),
                  }))
                : [],
            fileGroups: Array.isArray(fileGroups)
                ? fileGroups.slice(0, 40).map((group) => ({
                      label: clampText(group.label ?? group.path, 160),
                      description: clampText(group.description, 180),
                  }))
                : [],
        },
        {
            generatedBy: "repo-context-kit scan",
            inputs: [
                CONTEXT_INDEX_SUMMARY_PATH,
                CONTEXT_INDEX_FILES_PATH,
                CONTEXT_INDEX_ENTRYPOINTS_PATH,
                CONTEXT_INDEX_FILE_GROUPS_PATH,
            ],
        },
    );
}

export function buildRuntimeExecutionJson() {
    return buildEnvelope(
        "execution",
        {
            confirmationProtocol: "confirmation-protocol/v1",
            commandPolicy: {
                arbitraryShell: false,
                testExecution: "confirmation-gate-allowlist",
                externalSideEffects: "explicit-opt-in",
            },
            mcpCapabilityTiers: ["read-only", "workflow-write", "test-exec", "external-side-effect"],
        },
        {
            generatedBy: "repo-context-kit scan",
            inputs: [".aidw/confirmation-protocol.md", ".aidw/safety.md"],
        },
    );
}

export function buildRuntimeVerificationJson(tasks = getMergedTaskMetadata(), warnings = []) {
    const health = getTaskHealthSummary(tasks);
    return buildEnvelope(
        "verification",
        {
            taskHealth: health,
            warnings: Array.isArray(warnings) ? warnings.slice(0, 30).map((x) => clampText(x, 240)) : [],
            requiredChecks: ["scan --check", "check"],
        },
        {
            generatedBy: "repo-context-kit scan",
            inputs: [TASK_REGISTRY_PATH, "task/*.md", ".aidw/rules-canonical.md"],
        },
    );
}

function writeJsonIfChanged(relativePath, payload) {
    const next = serializeJson(payload);
    const current = exists(relativePath) ? readJson(relativePath) : null;
    if (current && serializeJson(current) === next) {
        return false;
    }
    writeText(relativePath, next);
    return true;
}

export function buildRuntimeJsonSet(scanData = {}, warnings = []) {
    const tasks = getMergedTaskMetadata();
    return {
        [RUNTIME_TASK_PATH]: buildRuntimeTaskJson(tasks),
        [RUNTIME_CONTEXT_PATH]: buildRuntimeContextJson(scanData),
        [RUNTIME_EXECUTION_PATH]: buildRuntimeExecutionJson(),
        [RUNTIME_VERIFICATION_PATH]: buildRuntimeVerificationJson(tasks, warnings),
    };
}

export function updateRuntimeJson(scanData = {}, warnings = []) {
    ensureDir(RUNTIME_DIR);
    const set = buildRuntimeJsonSet(scanData, warnings);
    const changed = {};
    for (const filePath of RUNTIME_JSON_PATHS) {
        changed[filePath] = writeJsonIfChanged(filePath, set[filePath]);
    }
    return changed;
}

export function updateRuntimeTaskJson() {
    ensureDir(RUNTIME_DIR);
    return writeJsonIfChanged(RUNTIME_TASK_PATH, buildRuntimeTaskJson());
}

export function getRuntimeJsonUpdate(scanData = {}, warnings = []) {
    const set = buildRuntimeJsonSet(scanData, warnings);
    const changed = {};
    for (const filePath of RUNTIME_JSON_PATHS) {
        const current = readJson(filePath);
        changed[filePath] = !current || serializeJson(current) !== serializeJson(set[filePath]);
    }
    return changed;
}

export function readRuntimeTaskRegistry() {
    const runtime = readJson(RUNTIME_TASK_PATH);
    const tasks = Array.isArray(runtime?.payload?.tasks) ? runtime.payload.tasks : null;
    if (runtime?.schemaVersion !== RUNTIME_JSON_SCHEMA_VERSION || !tasks) {
        return { exists: false, tasks: [] };
    }
    return {
        exists: true,
        source: RUNTIME_TASK_PATH,
        tasks: tasks.map((task) => ({
            ...task,
            dependencies: Array.isArray(task.dependencies) ? task.dependencies.join(", ") : task.dependencies,
        })),
    };
}

export function getPreferredTaskRegistry() {
    const runtime = readRuntimeTaskRegistry();
    if (runtime.exists) {
        return runtime;
    }
    return parseTaskRegistry();
}
