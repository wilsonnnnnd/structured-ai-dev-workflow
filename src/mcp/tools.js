import fs from "node:fs";
import path from "node:path";
import { spawnCli, isValidToken } from "./spawn-cli.js";
import { validateGate, loadGateState, confirmTask as confirmTaskGate, confirmTests as confirmTestsGate } from "../gate/state.js";
import { runTaskTestThroughGate } from "../gate/run-test.js";
import { validateRuntimeContract } from "../runtime/runtime-schema.js";
import { applyRuntimeBudget, CONTEXT_BUDGET } from "../runtime/context-budget.js";
import { serializeCompactJson } from "../runtime/serialize.js";
import { buildRuntimeMetrics } from "../runtime/context-observability.js";
import { computeScanCheckState } from "../scan/index.js";

function asTextResult(text) {
    return {
        content: [
            {
                type: "text",
                text: typeof text === "string" ? text : String(text ?? ""),
            },
        ],
    };
}

function asJsonResult(payload) {
    return asTextResult(serializeCompactJson(applyRuntimeBudget(payload)));
}

export const MCP_CAPABILITY_TIERS = Object.freeze({
    READ_ONLY: "read-only",
    WORKFLOW_WRITE: "workflow-write",
    TEST_EXEC: "test-exec",
    EXTERNAL_SIDE_EFFECT: "external-side-effect",
});

const MCP_CAPABILITY_TIER_VALUES = new Set(Object.values(MCP_CAPABILITY_TIERS));

function normalizeCapabilityTier(value) {
    const tier = String(value ?? "").trim();
    return MCP_CAPABILITY_TIER_VALUES.has(tier) ? tier : MCP_CAPABILITY_TIERS.READ_ONLY;
}

function tool(name, description, inputSchema, handler, capabilityTier = MCP_CAPABILITY_TIERS.READ_ONLY) {
    return {
        name,
        description,
        capabilityTier: normalizeCapabilityTier(capabilityTier),
        inputSchema,
        handler,
    };
}

function normalizeArgs(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}

function pickBoolean(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
}

function pickEnum(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}

function normalizeRuntimeMode(value) {
    const raw = String(value ?? "").trim().toUpperCase();
    return ["SAFE", "STANDARD", "REVIEW", "EXPERIMENTAL"].includes(raw) ? raw : null;
}

function requireEvidence(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        const error = new Error("evidence is required (object)");
        error.code = "MISSING_EVIDENCE";
        throw error;
    }
    if (JSON.stringify(value).length > 12_000) {
        const error = new Error("evidence is too large");
        error.code = "EVIDENCE_TOO_LARGE";
        throw error;
    }
    return value;
}

function requireHumanConfirmation(value, action) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        const error = new Error("humanConfirmation is required (object)");
        error.code = "MISSING_HUMAN_CONFIRMATION";
        throw error;
    }
    if (value.confirmed !== true) {
        const error = new Error("humanConfirmation.confirmed must be true");
        error.code = "HUMAN_CONFIRMATION_NOT_CONFIRMED";
        throw error;
    }
    const source = String(value.source ?? "").trim();
    const summary = String(value.summary ?? "").trim();
    if (!source || !summary) {
        const error = new Error("humanConfirmation.source and humanConfirmation.summary are required");
        error.code = "HUMAN_CONFIRMATION_INCOMPLETE";
        throw error;
    }
    const normalizedAction = String(value.action ?? action ?? "").trim();
    if (normalizedAction !== action) {
        const error = new Error(`humanConfirmation.action must be ${action}`);
        error.code = "HUMAN_CONFIRMATION_ACTION_MISMATCH";
        throw error;
    }
    if (JSON.stringify(value).length > 4_000) {
        const error = new Error("humanConfirmation is too large");
        error.code = "HUMAN_CONFIRMATION_TOO_LARGE";
        throw error;
    }
    return value;
}

function requireWriteGate({ rootDir, taskId, token, requireTestsConfirmed }) {
    if (!isNonEmptyString(taskId)) {
        const error = new Error("taskId is required");
        error.code = "MISSING_TASK_ID";
        throw error;
    }
    if (!isValidToken(token)) {
        const error = new Error("token must be a 32-character hex string");
        error.code = "INVALID_TOKEN";
        throw error;
    }
    const result = validateGate({ taskId, token, requireTestsConfirmed }, rootDir);
    if (!result.ok) {
        const error = new Error(result.error || "Gate is not confirmed for this task.");
        error.code = "GATE_NOT_CONFIRMED";
        throw error;
    }
}

async function runGovernedCli({ rootDir, runCli, input, cliArgs, requireTestsConfirmed = false }) {
    const mode = normalizeRuntimeMode(input.runtimeMode ?? input.mode);
    if (!mode) {
        const error = new Error("runtimeMode is required");
        error.code = "MISSING_MODE";
        throw error;
    }
    if (mode === "REVIEW") {
        const error = new Error("Write is not allowed in REVIEW mode.");
        error.code = "MODE_READ_ONLY";
        throw error;
    }
    requireEvidence(input.evidence);
    requireWriteGate({
        rootDir,
        taskId: input.taskId,
        token: input.token,
        requireTestsConfirmed,
    });
    const result = await runCli({ rootDir, args: cliArgs });
    return asJsonResult({
        schemaVersion: "runtime/v1",
        interface: "mcp",
        execution: {
            command: cliArgs[0] ?? "unknown",
            args: cliArgs.slice(1),
            exitCode: Number(result?.code ?? 1),
            ok: Number(result?.code ?? 1) === 0,
            stdoutBytes: Buffer.byteLength(String(result?.stdout ?? ""), "utf8"),
            stderrBytes: Buffer.byteLength(String(result?.stderr ?? ""), "utf8"),
        },
    });
}

export function buildMcpCapabilityPolicy({ enableWrite, enableTests, enableExternalSideEffects } = {}) {
    const allowed = new Set([MCP_CAPABILITY_TIERS.READ_ONLY]);
    if (enableWrite) {
        allowed.add(MCP_CAPABILITY_TIERS.WORKFLOW_WRITE);
    }
    if (enableWrite && enableTests) {
        allowed.add(MCP_CAPABILITY_TIERS.TEST_EXEC);
    }
    if (enableWrite && enableExternalSideEffects) {
        allowed.add(MCP_CAPABILITY_TIERS.EXTERNAL_SIDE_EFFECT);
    }
    return {
        allowedTiers: [...allowed],
        allows(tier) {
            return allowed.has(normalizeCapabilityTier(tier));
        },
    };
}

function assertCapabilityAllowed(toolDef, allowedCapabilityTiers) {
    const tier = normalizeCapabilityTier(toolDef?.capabilityTier);
    if (allowedCapabilityTiers.has(tier)) {
        return;
    }
    const error = new Error(`MCP capability tier is not enabled for this server: ${tier}`);
    error.code = "MCP_CAPABILITY_NOT_ENABLED";
    throw error;
}

function loadJsonIndex(rootDir, relativePath, fallback) {
    const indexPath = path.resolve(rootDir, relativePath);
    if (!fs.existsSync(indexPath)) {
        return fallback;
    }
    return JSON.parse(fs.readFileSync(indexPath, "utf-8"));
}

function loadJsonFile(rootDir, relativePath, fallback = null) {
    const filePath = path.resolve(rootDir, relativePath);
    if (!fs.existsSync(filePath)) {
        return fallback;
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
        return fallback;
    }
}

function loadRuntimeV1(rootDir) {
    return {
        task: loadJsonFile(rootDir, ".aidw/runtime/task.json", null),
        context: loadJsonFile(rootDir, ".aidw/runtime/context.json", null),
        execution: loadJsonFile(rootDir, ".aidw/runtime/execution.json", null),
        verification: loadJsonFile(rootDir, ".aidw/runtime/verification.json", null),
    };
}

function loadPackageMeta(rootDir) {
    const pkg = loadJsonFile(rootDir, "package.json", {});
    return {
        name: String(pkg?.name ?? "").trim() || "-",
        version: String(pkg?.version ?? "").trim() || "-",
        description: String(pkg?.description ?? "").trim() || "",
    };
}

function getRuntimeTasks(runtimeTask) {
    const tasks = runtimeTask?.payload?.tasks;
    return Array.isArray(tasks) ? tasks : [];
}

function pickNextTask(tasks) {
    if (!Array.isArray(tasks) || tasks.length === 0) return null;
    const inProgress = tasks.find((task) => String(task?.status ?? "").toLowerCase() === "in_progress");
    if (inProgress) return inProgress;
    const todo = tasks.find((task) => String(task?.status ?? "").toLowerCase() === "todo");
    return todo ?? null;
}

function findTask(tasks, taskId) {
    const id = String(taskId ?? "").trim().toUpperCase();
    if (!id) return null;
    return tasks.find((task) => String(task?.id ?? "").trim().toUpperCase() === id) ?? null;
}

function getTaskFacts(task) {
    const facts = task?.facts && typeof task.facts === "object" ? task.facts : {};
    return {
        goal: typeof facts.goal === "string" && facts.goal.trim() ? facts.goal : null,
        scope: limitArray(facts.scope, CONTEXT_BUDGET.maxContextSections),
        requirements: limitArray(facts.requirements, CONTEXT_BUDGET.maxTaskNotes),
        acceptanceCriteria: limitArray(facts.acceptanceCriteria, CONTEXT_BUDGET.maxChecklistItems),
        definitionOfDone: limitArray(facts.definitionOfDone, CONTEXT_BUDGET.maxChecklistItems),
        hardBoundaries: limitArray(facts.hardBoundaries, CONTEXT_BUDGET.maxContextSections),
        confirmationPoints: limitArray(facts.confirmationPoints, CONTEXT_BUDGET.maxContextSections),
        testCommand: typeof facts.testCommand === "string" && facts.testCommand.trim() ? facts.testCommand : null,
    };
}

function limitArray(values, max) {
    const list = Array.isArray(values) ? values : [];
    return list.slice(0, max);
}

function normalizeRepoRelativePath(value) {
    const raw = String(value ?? "").trim().replaceAll("\\", "/");
    if (!raw) {
        throw new Error("path is required");
    }
    if (raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
        throw new Error("path must be repo-relative");
    }
    const parts = raw.split("/");
    if (parts.some((part) => part === ".." || part === "." || part === "")) {
        throw new Error("path must not contain traversal segments");
    }
    return parts.join("/");
}

function normalizeQuery(value) {
    const query = String(value ?? "").trim().toLowerCase();
    if (!query) {
        throw new Error("query is required");
    }
    return query;
}

function boundedLimit(value, fallback = 10, max = 50) {
    const limit = Number(value);
    if (!Number.isFinite(limit)) {
        return fallback;
    }
    return Math.min(max, Math.max(1, Math.floor(limit)));
}

export function buildMcpTools({ rootDir, enableWrite, enableTests, enableExternalSideEffects = false, runCli = spawnCli }) {
    const tools = [];
    const capabilityPolicy = buildMcpCapabilityPolicy({ enableWrite, enableTests, enableExternalSideEffects });
    const allowedCapabilityTiers = new Set(capabilityPolicy.allowedTiers);

    tools.push(
        tool(
            "rck.repo.summary",
            "Read repository runtime summary (MCP-first, runtime/v1 JSON-backed).",
            { type: "object", additionalProperties: false, properties: {} },
            async () => {
                const runtime = loadRuntimeV1(rootDir);
                const pkg = loadPackageMeta(rootDir);
                const tasks = getRuntimeTasks(runtime.task);
                const payload = {
                    schemaVersion: "runtime/v1",
                    interface: "mcp",
                    repository: pkg,
                    runtime: {
                        taskFile: ".aidw/runtime/task.json",
                        contextFile: ".aidw/runtime/context.json",
                        executionFile: ".aidw/runtime/execution.json",
                        verificationFile: ".aidw/runtime/verification.json",
                    },
                    summary: {
                        taskCount: tasks.length,
                        projectType: runtime.context?.payload?.projectType ?? null,
                        indexedFiles: runtime.context?.payload?.index?.indexedFiles ?? null,
                        indexedSymbols: runtime.context?.payload?.index?.indexedSymbols ?? null,
                    },
                };
                return asJsonResult(payload);
            },
        ),
        tool(
            "rck.context.brief",
            "Read compact bounded repository context from runtime/v1 JSON.",
            { type: "object", additionalProperties: false, properties: {} },
            async () => {
                const runtime = loadRuntimeV1(rootDir);
                const payload = {
                    schemaVersion: "runtime/v1",
                    interface: "mcp",
                    context: {
                        projectType: runtime.context?.payload?.projectType ?? null,
                        techStack: limitArray(runtime.context?.payload?.techStack, 12),
                        riskAreas: limitArray(runtime.context?.payload?.riskAreas, 12),
                        index: runtime.context?.payload?.index ?? {},
                    },
                    verification: {
                        requiredChecks: limitArray(runtime.verification?.payload?.requiredChecks, 8),
                    },
                };
                return asJsonResult(payload);
            },
        ),
        tool(
            "rck.context.nextTask",
            "Read next active task from runtime/v1 JSON.",
            { type: "object", additionalProperties: false, properties: {} },
            async () => {
                const runtime = loadRuntimeV1(rootDir);
                const tasks = getRuntimeTasks(runtime.task);
                const nextTask = pickNextTask(tasks);
                const counts = tasks.reduce(
                    (acc, task) => {
                        const status = String(task?.status ?? "").toLowerCase();
                        if (status === "todo") acc.todo += 1;
                        else if (status === "in_progress") acc.in_progress += 1;
                        else if (status === "done") acc.done += 1;
                        else acc.other += 1;
                        return acc;
                    },
                    { todo: 0, in_progress: 0, done: 0, other: 0 },
                );
                return asJsonResult({
                    schemaVersion: "runtime/v1",
                    interface: "mcp",
                    nextTask,
                    taskCounts: counts,
                });
            },
        ),
        tool(
            "rck.context.workset",
            "Read bounded task workset context from runtime/v1 JSON.",
            {
                type: "object",
                additionalProperties: false,
                required: ["taskId"],
                properties: {
                    taskId: { type: "string" },
                    deep: { type: "boolean" },
                    detail: { type: "string", enum: ["compact", "digest", "full"] },
                },
            },
            async (args) => {
                const input = normalizeArgs(args);
                if (!isNonEmptyString(input.taskId)) {
                    throw new Error("taskId is required");
                }
                const detail = pickEnum(input.detail, ["compact", "digest", "full"], "compact");
                const deep = pickBoolean(input.deep, false);
                const runtime = loadRuntimeV1(rootDir);
                const tasks = getRuntimeTasks(runtime.task);
                const task = findTask(tasks, input.taskId);
                if (!task) {
                    throw new Error(`taskId not found in runtime state: ${input.taskId}`);
                }
                const baseLimit = detail === "full" ? 20 : detail === "compact" ? 10 : 6;
                const fileLimit = deep ? Math.min(baseLimit + 8, 28) : baseLimit;
                const files = limitArray(runtime.context?.payload?.topFiles, fileLimit).map((file) => ({
                    path: file?.path ?? null,
                    type: file?.type ?? null,
                    description: file?.description ?? null,
                }));
                return asJsonResult({
                    schemaVersion: "runtime/v1",
                    interface: "mcp",
                    task,
                    workset: {
                        detail,
                        deep,
                        files,
                        entrypoints: limitArray(runtime.context?.payload?.entrypoints, deep ? 20 : 12),
                        riskAreas: limitArray(runtime.context?.payload?.riskAreas, deep ? 16 : 10),
                    },
                });
            },
        ),
        tool(
            "rck.task.prompt",
            "Read structured prompt framing for one task (runtime-first).",
            {
                type: "object",
                additionalProperties: false,
                required: ["taskId"],
                properties: { taskId: { type: "string" }, deep: { type: "boolean" } },
            },
            async (args) => {
                const input = normalizeArgs(args);
                if (!isNonEmptyString(input.taskId)) throw new Error("taskId is required");
                const runtime = loadRuntimeV1(rootDir);
                const task = findTask(getRuntimeTasks(runtime.task), input.taskId);
                if (!task) throw new Error(`taskId not found in runtime state: ${input.taskId}`);
                const facts = getTaskFacts(task);
                return asJsonResult({
                    schemaVersion: "runtime/v1",
                    interface: "mcp",
                    kind: "task-prompt",
                    task: {
                        id: task.id,
                        title: task.title,
                        goal: facts.goal,
                        scope: facts.scope,
                        requirements: facts.requirements,
                        acceptanceCriteria: facts.acceptanceCriteria,
                        hardBoundaries: facts.hardBoundaries,
                        confirmationPoints: facts.confirmationPoints,
                        testCommand: facts.testCommand,
                    },
                    context: {
                        riskAreas: limitArray(runtime.context?.payload?.riskAreas, 10),
                        entrypoints: limitArray(runtime.context?.payload?.entrypoints, 12),
                    },
                });
            },
        ),
        tool(
            "rck.task.checklist",
            "Read structured verification checklist framing for one task.",
            {
                type: "object",
                additionalProperties: false,
                required: ["taskId"],
                properties: { taskId: { type: "string" }, deep: { type: "boolean" } },
            },
            async (args) => {
                const input = normalizeArgs(args);
                if (!isNonEmptyString(input.taskId)) throw new Error("taskId is required");
                const runtime = loadRuntimeV1(rootDir);
                const task = findTask(getRuntimeTasks(runtime.task), input.taskId);
                if (!task) throw new Error(`taskId not found in runtime state: ${input.taskId}`);
                const facts = getTaskFacts(task);
                return asJsonResult({
                    schemaVersion: "runtime/v1",
                    interface: "mcp",
                    kind: "task-checklist",
                    task: { id: task.id, title: task.title },
                    checklist: {
                        acceptanceCriteria: facts.acceptanceCriteria,
                        definitionOfDone: facts.definitionOfDone,
                        requiredChecks: limitArray(runtime.verification?.payload?.requiredChecks, 8),
                    },
                });
            },
        ),
        tool(
            "rck.task.pr",
            "Read structured PR framing for one task.",
            {
                type: "object",
                additionalProperties: false,
                required: ["taskId"],
                properties: { taskId: { type: "string" }, deep: { type: "boolean" } },
            },
            async (args) => {
                const input = normalizeArgs(args);
                if (!isNonEmptyString(input.taskId)) throw new Error("taskId is required");
                const runtime = loadRuntimeV1(rootDir);
                const task = findTask(getRuntimeTasks(runtime.task), input.taskId);
                if (!task) throw new Error(`taskId not found in runtime state: ${input.taskId}`);
                const facts = getTaskFacts(task);
                return asJsonResult({
                    schemaVersion: "runtime/v1",
                    interface: "mcp",
                    kind: "task-pr-framing",
                    pr: {
                        title: `${task.id} ${task.title}`,
                        summary: facts.goal,
                        scope: facts.scope,
                        verification: {
                            requiredChecks: limitArray(runtime.verification?.payload?.requiredChecks, 8),
                            warnings: limitArray(runtime.verification?.payload?.warnings, 8),
                        },
                    },
                });
            },
        ),
        tool(
            "rck.gate.status",
            "Read current confirmation gate state.",
            { type: "object", additionalProperties: false, properties: {} },
            async () => {
                const state = loadGateState(rootDir);
                return asJsonResult({
                    schemaVersion: "runtime/v1",
                    interface: "mcp",
                    gate: state,
                });
            },
        ),
        tool(
            "rck.scan.check",
            "Check whether runtime JSON and indexes are current.",
            { type: "object", additionalProperties: false, properties: {} },
            async () => {
                const state = computeScanCheckState();
                return asJsonResult({
                    schemaVersion: "runtime/v1",
                    interface: "mcp",
                    scanCheck: {
                        changed: Boolean(state.update?.changed),
                        skipped: Boolean(state.update?.skipped),
                        projectChanged: Boolean(state.update?.projectChanged),
                        systemOverviewChanged: Boolean(state.update?.systemOverviewChanged),
                        taskMapChanged: Boolean(state.update?.taskMapChanged),
                        taskRegistryChanged: Boolean(state.update?.taskRegistryChanged),
                        runtimeChanged: state.update?.runtimeChanged ?? null,
                    },
                });
            },
        ),
        tool(
            "rck.metrics",
            "Read compact runtime metrics JSON.",
            { type: "object", additionalProperties: false, properties: {} },
            async () => {
                return asJsonResult(buildRuntimeMetrics());
            },
        ),
        tool(
            "rck.runtime.validate",
            "Validate a runtime contract object.",
            {
                type: "object",
                additionalProperties: false,
                required: ["contract"],
                properties: { contract: { type: "object" } },
            },
            async (args) => {
                const input = normalizeArgs(args);
                return asJsonResult(validateRuntimeContract(input.contract));
            },
        ),
        tool(
            "rck.file.summary",
            "Read one bounded file summary from the generated index.",
            {
                type: "object",
                additionalProperties: false,
                required: ["path"],
                properties: { path: { type: "string" } },
            },
            async (args) => {
                const input = normalizeArgs(args);
                const filePath = normalizeRepoRelativePath(input.path);
                const summaries = loadJsonIndex(rootDir, ".aidw/index/file-summaries.json", []);
                const found = Array.isArray(summaries) ? summaries.find((item) => item.path === filePath) : null;
                return asJsonResult(found ?? { path: filePath, found: false });
            },
        ),
        tool(
            "rck.file.search",
            "Search generated file index entries.",
            {
                type: "object",
                additionalProperties: false,
                required: ["query"],
                properties: { query: { type: "string" }, limit: { type: "number" } },
            },
            async (args) => {
                const input = normalizeArgs(args);
                const query = normalizeQuery(input.query);
                const limit = boundedLimit(input.limit);
                const files = loadJsonIndex(rootDir, ".aidw/index/files.json", []);
                const matches = Array.isArray(files)
                    ? files
                          .filter((item) => `${item.path ?? ""} ${item.description ?? ""} ${item.type ?? ""}`.toLowerCase().includes(query))
                          .slice(0, limit)
                    : [];
                return asJsonResult({ query, matches });
            },
        ),
        tool(
            "rck.symbol.lookup",
            "Search generated symbol index entries.",
            {
                type: "object",
                additionalProperties: false,
                required: ["query"],
                properties: { query: { type: "string" }, limit: { type: "number" } },
            },
            async (args) => {
                const input = normalizeArgs(args);
                const query = normalizeQuery(input.query);
                const limit = boundedLimit(input.limit);
                const symbols = loadJsonIndex(rootDir, ".aidw/index/symbols.json", []);
                const matches = Array.isArray(symbols)
                    ? symbols
                          .filter((item) => `${item.name ?? ""} ${item.file ?? ""} ${item.description ?? ""}`.toLowerCase().includes(query))
                          .slice(0, limit)
                    : [];
                return asJsonResult({ query, matches });
            },
        ),
    );

    if (enableWrite) {
        tools.push(
            tool(
                "rck.init",
                "Initialize repository runtime files through the gated MCP write surface.",
                {
                    type: "object",
                    additionalProperties: false,
                    required: ["runtimeMode", "taskId", "token", "evidence"],
                    properties: {
                        dryRun: { type: "boolean" },
                        force: { type: "boolean" },
                        updateAgentFiles: { type: "boolean" },
                        runtimeMode: { type: "string", enum: ["SAFE", "STANDARD", "EXPERIMENTAL"] },
                        taskId: { type: "string" },
                        token: { type: "string" },
                        evidence: { type: "object", additionalProperties: true },
                    },
                },
                async (args) => {
                    const input = normalizeArgs(args);
                    const cliArgs = ["init"];
                    if (pickBoolean(input.dryRun, false)) cliArgs.push("--dry-run");
                    if (pickBoolean(input.force, false)) cliArgs.push("--force");
                    if (pickBoolean(input.updateAgentFiles, false)) cliArgs.push("--update-agent-files");
                    return runGovernedCli({ rootDir, runCli, input, cliArgs });
                },
                MCP_CAPABILITY_TIERS.WORKFLOW_WRITE,
            ),
            tool(
                "rck.scan",
                "Update runtime JSON and generated indexes through the gated MCP write surface.",
                {
                    type: "object",
                    additionalProperties: false,
                    required: ["runtimeMode", "taskId", "token", "evidence"],
                    properties: {
                        mode: { type: "string", enum: ["normal", "auto"] },
                        runtimeMode: { type: "string", enum: ["SAFE", "STANDARD", "EXPERIMENTAL"] },
                        taskId: { type: "string" },
                        token: { type: "string" },
                        evidence: { type: "object", additionalProperties: true },
                    },
                },
                async (args) => {
                    const input = normalizeArgs(args);
                    const cliArgs = ["scan"];
                    if (pickEnum(input.mode, ["normal", "auto"], "normal") === "auto") cliArgs.push("--auto");
                    return runGovernedCli({ rootDir, runCli, input, cliArgs });
                },
                MCP_CAPABILITY_TIERS.WORKFLOW_WRITE,
            ),
            tool(
                "rck.gate.confirmTask",
                "Confirm one task and generate a time-limited gate token after explicit human confirmation.",
                {
                    type: "object",
                    additionalProperties: false,
                    required: ["taskId", "humanConfirmation"],
                    properties: {
                        taskId: { type: "string" },
                        humanConfirmation: {
                            type: "object",
                            additionalProperties: true,
                            required: ["confirmed", "source", "summary", "action"],
                            properties: {
                                confirmed: { type: "boolean" },
                                source: { type: "string" },
                                summary: { type: "string" },
                                action: { type: "string", enum: ["confirm-task"] },
                            },
                        },
                    },
                },
                async (args) => {
                    const input = normalizeArgs(args);
                    if (!isNonEmptyString(input.taskId)) throw new Error("taskId is required");
                    requireHumanConfirmation(input.humanConfirmation, "confirm-task");
                    const result = confirmTaskGate(input.taskId, {}, rootDir);
                    if (result?.error) {
                        throw new Error(result.error);
                    }
                    return asJsonResult({
                        schemaVersion: "runtime/v1",
                        interface: "mcp",
                        gate: {
                            taskId: result?.state?.active?.taskId ?? null,
                            token: result?.token ?? null,
                            expiresAt: result?.state?.active?.expiresAt ?? null,
                            taskConfirmed: Boolean(result?.state?.active?.taskConfirmed),
                            testsConfirmed: Boolean(result?.state?.active?.testsConfirmed),
                        },
                    });
                },
                MCP_CAPABILITY_TIERS.WORKFLOW_WRITE,
            ),
            tool(
                "rck.gate.confirmTests",
                "Confirm test execution for one task after explicit human confirmation.",
                {
                    type: "object",
                    additionalProperties: false,
                    required: ["taskId", "humanConfirmation"],
                    properties: {
                        taskId: { type: "string" },
                        humanConfirmation: {
                            type: "object",
                            additionalProperties: true,
                            required: ["confirmed", "source", "summary", "action"],
                            properties: {
                                confirmed: { type: "boolean" },
                                source: { type: "string" },
                                summary: { type: "string" },
                                action: { type: "string", enum: ["confirm-tests"] },
                            },
                        },
                    },
                },
                async (args) => {
                    const input = normalizeArgs(args);
                    if (!isNonEmptyString(input.taskId)) throw new Error("taskId is required");
                    requireHumanConfirmation(input.humanConfirmation, "confirm-tests");
                    const result = confirmTestsGate(input.taskId, rootDir);
                    if (result?.error) {
                        throw new Error(result.error);
                    }
                    return asJsonResult({
                        schemaVersion: "runtime/v1",
                        interface: "mcp",
                        gate: {
                            taskId: result?.state?.active?.taskId ?? null,
                            expiresAt: result?.state?.active?.expiresAt ?? null,
                            taskConfirmed: Boolean(result?.state?.active?.taskConfirmed),
                            testsConfirmed: Boolean(result?.state?.active?.testsConfirmed),
                        },
                    });
                },
                MCP_CAPABILITY_TIERS.WORKFLOW_WRITE,
            ),
        );
    }

    if (enableWrite && enableTests) {
        tools.push(
            tool(
                "rck.gate.runTest",
                "Run the selected task's test command through the confirmation gate.",
                {
                    type: "object",
                    additionalProperties: false,
                    required: ["taskId", "token", "runtimeMode", "evidence"],
                    properties: {
                        taskId: { type: "string" },
                        token: { type: "string" },
                        runtimeMode: { type: "string", enum: ["SAFE", "STANDARD", "EXPERIMENTAL"] },
                        evidence: { type: "object", additionalProperties: true },
                    },
                },
                async (args) => {
                    const input = normalizeArgs(args);
                    if (!isNonEmptyString(input.taskId)) throw new Error("taskId is required");
                    if (!isValidToken(input.token)) throw new Error("token must be a 32-character hex string");
                    const mode = normalizeRuntimeMode(input.runtimeMode ?? input.mode);
                    if (!mode) {
                        const error = new Error("runtimeMode is required");
                        error.code = "MISSING_MODE";
                        throw error;
                    }
                    if (mode === "REVIEW") {
                        const error = new Error("Write is not allowed in REVIEW mode.");
                        error.code = "MODE_READ_ONLY";
                        throw error;
                    }
                    requireEvidence(input.evidence);
                    const result = await runTaskTestThroughGate({ taskId: input.taskId, token: input.token, rootDir });
                    return asJsonResult({
                        schemaVersion: "runtime/v1",
                        interface: "mcp",
                        test: {
                            taskId: input.taskId,
                            ok: Boolean(result?.ok),
                            exitCode: Number(result?.exitCode ?? 1),
                            command: result?.command ?? null,
                        },
                    });
                },
                MCP_CAPABILITY_TIERS.TEST_EXEC,
            ),
        );
    }

    const toolByName = new Map(tools.map((item) => [item.name, item]));

    return {
        listTools() {
            return tools.map(({ name, description, capabilityTier, inputSchema }) => ({
                name,
                description,
                capabilityTier,
                inputSchema,
            }));
        },
        async callTool(name, args) {
            const found = toolByName.get(name);
            if (!found) {
                const error = new Error(`Unknown tool: ${name}`);
                error.code = "UNKNOWN_TOOL";
                throw error;
            }
            assertCapabilityAllowed(found, allowedCapabilityTiers);
            return await found.handler(args);
        },
    };
}
