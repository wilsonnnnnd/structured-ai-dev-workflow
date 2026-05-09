import fs from "node:fs";
import path from "node:path";
import { runTask } from "../../bin/task.js";
import { buildWorksetContext } from "../../bin/context.js";
import { runScan, computeContextFreshness, computeScanCheckState } from "../scan/index.js";
import { loadTask as createExecutorPause } from "../executor/runner.js";
import { createVirtualTask } from "../task/virtual-task.js";
import { withRepoRoot } from "../runtime/root-context.js";
import { buildRuntimeContract } from "../runtime/runtime-contract.js";
import { appendRuntimeSession } from "../runtime/sessions.js";
import { listRecentLoopEvents } from "../loop/store.js";
import { readLessonsFile } from "../lessons/store.js";
import { writeRuntimeSnapshot } from "../runtime/snapshot.js";
import { getRuntimeModeConfig, resolveRuntimeMode } from "../runtime/rdl/modes.js";
import { readShcV1Status } from "../runtime/rdl/shc.js";
import { loadDesignDoc } from "../docs/doc-loader.js";
import { extractPlanningData, buildPlanningSource } from "../docs/doc-extractor.js";

async function withCapturedConsole(callback) {
    const log = console.log;
    const error = console.error;
    const output = [];
    const previousExitCode = process.exitCode;
    process.exitCode = 0;

    try {
        console.log = (...args) => output.push(args.join(" "));
        console.error = (...args) => output.push(args.join(" "));
        const result = await callback();
        return {
            output,
            result,
            exitCode: Number(process.exitCode ?? 0),
        };
    } finally {
        console.log = log;
        console.error = error;
        process.exitCode = previousExitCode;
    }
}

function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}

function slugify(title) {
    const slug = String(title ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return slug || "new-task";
}

function normalizeTitle(title) {
    return String(title ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((word) =>
            /^[A-Z0-9]+$/.test(word)
                ? word
                : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
        )
        .join(" ");
}

function extractTaskIdFromPath(filePath) {
    const match = String(filePath ?? "").match(/\b(T-\d{3})\b/i);
    return match ? match[1].toUpperCase() : null;
}

function extractMarkdownSection(content, heading) {
    const escapedHeading = String(heading ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(
        `(?:^|\\n)##\\s+${escapedHeading}\\s*\\n(?<body>[\\s\\S]*?)(?=\\n##\\s|$)`,
        "i",
    );
    const match = String(content ?? "").match(regex);
    return match?.groups?.body?.trim() ?? "";
}

function extractFilePathsFromSection(section, max = 12) {
    const paths = [];
    const lines = String(section ?? "").split("\n");
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("- ")) continue;
        const candidate = trimmed.slice(2).trim();
        const match = candidate.match(/^(?<path>(?:bin|src|test|tests|app|template|site)\/[A-Za-z0-9._/-]+)/);
        if (match?.groups?.path) {
            paths.push(match.groups.path);
        }
        if (paths.length >= max) break;
    }
    return [...new Set(paths)];
}

function computeInitStatus(rootDir) {
    const agentsPath = path.resolve(rootDir, "AGENTS.md");
    const aidwDir = path.resolve(rootDir, ".aidw");
    const taskRegistry = path.resolve(rootDir, "task/task.md");

    const missing = [];
    if (!fs.existsSync(agentsPath)) missing.push("AGENTS.md");
    if (!fs.existsSync(aidwDir) || !fs.statSync(aidwDir).isDirectory()) missing.push(".aidw/");
    if (!fs.existsSync(taskRegistry)) missing.push("task/task.md");

    return {
        ok: missing.length === 0,
        missing,
    };
}

async function computeScanStatus(rootDir) {
    return withRepoRoot(rootDir, async () => {
        const required = [
            path.resolve(rootDir, ".aidw/project.md"),
            path.resolve(rootDir, ".aidw/system-overview.md"),
            path.resolve(rootDir, ".aidw/index/summary.json"),
        ];
        if (required.some((filePath) => !fs.existsSync(filePath))) {
            return { status: "missing", plan: [] };
        }
        const { update } = computeScanCheckState();
        const status = update?.changed ? "stale" : "fresh";
        const plan = [];

        if (status === "stale") {
            const planned = await withCapturedConsole(() => runScan({ mode: "plan" }));
            const willUpdate = planned?.result?.willUpdate;
            if (Array.isArray(willUpdate)) {
                plan.push(...willUpdate);
            }
        }

        return {
            status,
            plan: [...new Set(plan)].filter(Boolean).sort(),
        };
    });
}

function readLessons(rootDir) {
    return withRepoRoot(rootDir, () => {
        const result = readLessonsFile();
        return Array.isArray(result?.value?.lessons) ? result.value.lessons : [];
    });
}

function readLoopEvents(rootDir) {
    return listRecentLoopEvents({ limit: 80, maxBytes: 1_000_000 }, rootDir);
}

function parseListSection(section) {
    const items = [];
    const lines = String(section ?? "").split("\n");
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("- ")) continue;
        const value = trimmed.slice(2).trim();
        if (!value || value === "-" || value === "_") continue;
        items.push(value);
    }
    return items;
}

function parseTaskDetailMarkdown(markdown) {
    const acceptanceCriteria = parseListSection(extractMarkdownSection(markdown, "Acceptance Criteria"));
    const requirements = parseListSection(extractMarkdownSection(markdown, "Requirements"));
    const testSection = extractMarkdownSection(markdown, "Test Command");
    const fence = testSection.match(/```(?:bash)?\s*\n([\s\S]*?)\n```/i);
    const testCommand = fence ? String(fence[1]).trim() : "";
    return { acceptanceCriteria, requirements, testCommand };
}

export async function orchestrateAuto({
    rootDir = process.cwd(),
    goal,
    fromDocPath,
    deep = false,
    dryRun = false,
    allowWrite = false,
} = {}) {
    const trimmedDocPath = String(fromDocPath ?? "").trim();
    const trimmedGoal = String(goal ?? "").trim();
    const docMode = Boolean(trimmedDocPath);
    if (!docMode && !trimmedGoal) {
        return {
            ok: false,
            error: "Missing --goal.",
            nextActions: ['repo-context-kit auto --goal "<your goal>"'],
        };
    }

    const init = computeInitStatus(rootDir);
    if (!init.ok) {
        return {
            ok: false,
            error: `Project is not initialized. Missing: ${init.missing.join(", ")}`,
            nextActions: ["repo-context-kit init", "repo-context-kit scan"],
        };
    }

    const scan = await computeScanStatus(rootDir);
    const lessons = readLessons(rootDir);
    const loop = readLoopEvents(rootDir);
    const runtimeMode = resolveRuntimeMode({ repoRoot: rootDir });
    const runtimeModeConfig = getRuntimeModeConfig(runtimeMode);

    let planning = null;
    let planningSource = undefined;
    let selectedTaskSeed = null;
    let title = null;
    if (docMode) {
        try {
            const doc = loadDesignDoc(trimmedDocPath, { repoRoot: rootDir });
            planning = extractPlanningData(doc);
            planningSource = buildPlanningSource(doc, planning);
            const suggested = Array.isArray(planning.suggestedTasks) ? planning.suggestedTasks : [];
            const goals = Array.isArray(planning.goals) ? planning.goals : [];
            const primaryGoal = String(goals[0] ?? "").trim();
            const selectedTitle = suggested.length > 0 ? String(suggested[0]).trim() : (primaryGoal || String(doc.metadata?.title ?? "").trim());
            selectedTaskSeed = {
                title: normalizeTitle(selectedTitle.length > 80 ? `${selectedTitle.slice(0, 77).trimEnd()}...` : selectedTitle),
                goal: primaryGoal || trimmedGoal || selectedTitle,
                seed: {
                    requirements: Array.isArray(planning.requirements) ? planning.requirements : [],
                    acceptanceCriteria: Array.isArray(planning.acceptanceCriteria) ? planning.acceptanceCriteria : [],
                    scope: Array.isArray(planning.scope) ? planning.scope : [],
                    constraints: Array.isArray(planning.constraints) ? planning.constraints : [],
                },
                planningPath: String(doc.path ?? "").trim() || "-",
                sizeBytes: Number(doc.metadata?.sizeBytes ?? 0),
                conflicts: Boolean(planning?.analysis?.conflictingRequirements === true),
            };
            title = selectedTaskSeed.title;
        } catch (error) {
            return {
                ok: false,
                error: error && typeof error === "object" && "message" in error ? String(error.message) : String(error),
                nextActions: ["Confirm the doc path is inside the repo and under the size limit.", "Use: repo-context-kit auto --goal \"<goal>\""],
            };
        }
    } else {
        title = normalizeTitle(trimmedGoal.length > 80 ? `${trimmedGoal.slice(0, 77).trimEnd()}...` : trimmedGoal);
    }

    if (dryRun || !allowWrite) {
        const virtual = createVirtualTask({
            goal: docMode ? selectedTaskSeed.goal : trimmedGoal,
            deep: Boolean(deep),
            repoRoot: rootDir,
            title: docMode ? selectedTaskSeed.title : null,
            seed: docMode ? selectedTaskSeed.seed : null,
        });
        const nextActions = scan.status === "fresh"
            ? [docMode ? `repo-context-kit auto --from-doc "${trimmedDocPath}" --json` : `repo-context-kit auto --goal "${trimmedGoal}" --json`]
            : ["repo-context-kit scan", docMode ? `repo-context-kit auto --from-doc "${trimmedDocPath}" --json` : `repo-context-kit auto --goal "${trimmedGoal}" --json`];
        const runtime = {
            writeEnabled: false,
            mode: runtimeMode,
            modeConfig: runtimeModeConfig,
            ...(docMode
                ? {
                    planning: {
                        sourceType: "design-doc",
                        path: selectedTaskSeed.planningPath,
                        sizeBytes: selectedTaskSeed.sizeBytes,
                        goalsCount: Array.isArray(planning?.goals) ? planning.goals.length : 0,
                        requirementsCount: Array.isArray(planning?.requirements) ? planning.requirements.length : 0,
                        scopeCount: Array.isArray(planning?.scope) ? planning.scope.length : 0,
                        acceptanceCriteriaCount: Array.isArray(planning?.acceptanceCriteria) ? planning.acceptanceCriteria.length : 0,
                        conflictingRequirements: selectedTaskSeed.conflicts,
                    },
                }
                : {}),
        };
        const shc = readShcV1Status({ repoRoot: rootDir });
        const freshness = withRepoRoot(rootDir, () => computeContextFreshness({ worksetFiles: virtual.relatedFiles }));

        const contract = buildRuntimeContract({
            repoRoot: rootDir,
            task: virtual.task,
            scan,
            ...(planningSource !== undefined ? { planningSource } : {}),
            workset: {
                mode: deep ? "deep" : "digest",
                files: virtual.relatedFiles,
                summary: extractMarkdownSection(virtual.workset, "File Summary References"),
                text: virtual.workset,
            },
            prompt: virtual.prompt,
            lessons,
            loop,
            runtime: { ...runtime, shc, freshness },
            rdl: { mode: runtimeMode, shc, freshness },
            nextActions,
            executionState: { sessionId: null, pauseId: null, phase: "planning", status: "planned" },
        });
        return {
            ok: true,
            contract,
            dryRun: true,
            planning: docMode ? planning : null,
            selectedTask: docMode ? { title: selectedTaskSeed.title, goal: selectedTaskSeed.goal } : null,
        };
    }

    let createdFile = null;
    let createdTaskId = null;
    if (docMode) {
        const generated = await withRepoRoot(rootDir, () =>
            withCapturedConsole(() => runTask(["generate", "--from-doc", trimmedDocPath])),
        );
        const tasks = Array.isArray(generated?.result?.generatedTasks) ? generated.result.generatedTasks : [];
        const first = tasks[0] ?? null;
        createdFile = first?.file ?? null;
        createdTaskId = first?.id ? String(first.id).toUpperCase() : null;
        if (!createdFile || !createdTaskId) {
            return {
                ok: false,
                error: "Failed to generate tasks from design doc.",
                nextActions: [`repo-context-kit task generate --from-doc "${trimmedDocPath}" --dry-run --json`],
            };
        }
    } else {
        const createdTask = await withRepoRoot(rootDir, () => withCapturedConsole(() => runTask(["new", title])));
        createdFile = createdTask?.result?.created ?? null;
        createdTaskId = extractTaskIdFromPath(createdFile);
        if (!createdFile || !createdTaskId) {
            return {
                ok: false,
                error: "Failed to create task.",
                nextActions: ['repo-context-kit task new "<title>"'],
            };
        }
    }

    const worksetText = withRepoRoot(rootDir, () =>
        buildWorksetContext(createdTaskId, { deep: Boolean(deep), digest: !deep, manifest: true }),
    );
    const summarySection = extractMarkdownSection(worksetText, "File Summary References");
    const filesFromSummaries = extractFilePathsFromSection(summarySection, deep ? 10 : 6);
    const candidatesSection = extractMarkdownSection(worksetText, "Related File Candidates");
    const filesFromCandidates = extractFilePathsFromSection(candidatesSection, deep ? 12 : 8);
    const worksetFiles = [...new Set([...filesFromSummaries, ...filesFromCandidates])].slice(0, 12);

    const promptArgs = ["prompt", createdTaskId, "--compact"];
    if (deep) {
        promptArgs.push("--deep");
    }
    const promptResult = await withRepoRoot(rootDir, () => withCapturedConsole(() => runTask(promptArgs)));
    const prompt = String(promptResult?.result?.output ?? "").trimEnd();

    const pause = createExecutorPause(createdTaskId, rootDir);
    if (!pause.ok) {
        return {
            ok: false,
            error: pause.error || "Failed to create executor pause.",
            nextActions: [`repo-context-kit execute run ${createdTaskId}`],
        };
    }

    const pauseId = pause?.state?.pauseId ?? null;
    const sessionId = appendRuntimeSession({
        mode: docMode ? "auto.from-doc" : "auto.start",
        goal: docMode ? String(selectedTaskSeed.goal ?? "").trim() : trimmedGoal,
        taskId: createdTaskId,
        worksetMode: deep ? "deep" : "digest",
        pauseId,
        status: "started",
    }, rootDir);

    let createdTaskDetail = "";
    try {
        createdTaskDetail = fs.readFileSync(path.resolve(rootDir, createdFile), "utf-8");
    } catch {
        createdTaskDetail = "";
    }
    const parsedDetail = parseTaskDetailMarkdown(createdTaskDetail);
    const shc = readShcV1Status({ repoRoot: rootDir });
    const freshness = withRepoRoot(rootDir, () => computeContextFreshness({ worksetFiles }));

    const contract = buildRuntimeContract({
        repoRoot: rootDir,
        task: {
            id: createdTaskId,
            title,
            goal: docMode ? String(selectedTaskSeed.goal ?? "").trim() : trimmedGoal,
            requirements: parsedDetail.requirements,
            acceptanceCriteria: parsedDetail.acceptanceCriteria,
            testCommand: parsedDetail.testCommand,
        },
        scan,
        ...(planningSource !== undefined ? { planningSource } : {}),
        workset: {
            mode: deep ? "deep" : "digest",
            files: worksetFiles,
            summary: summarySection ? summarySection : "",
            text: worksetText,
        },
        prompt,
        lessons,
        loop,
        runtime: {
            writeEnabled: true,
            mode: runtimeMode,
            modeConfig: runtimeModeConfig,
            shc,
            freshness,
            ...(docMode
                ? {
                    planning: {
                        sourceType: "design-doc",
                        path: selectedTaskSeed.planningPath,
                        sizeBytes: selectedTaskSeed.sizeBytes,
                        goalsCount: Array.isArray(planning?.goals) ? planning.goals.length : 0,
                        requirementsCount: Array.isArray(planning?.requirements) ? planning.requirements.length : 0,
                        scopeCount: Array.isArray(planning?.scope) ? planning.scope.length : 0,
                        acceptanceCriteriaCount: Array.isArray(planning?.acceptanceCriteria) ? planning.acceptanceCriteria.length : 0,
                        conflictingRequirements: selectedTaskSeed.conflicts,
                    },
                }
                : {}),
        },
        rdl: { mode: runtimeMode, shc, freshness },
        nextActions: pauseId ? [`repo-context-kit execute confirm ${pauseId}`] : [],
        executionState: { sessionId, pauseId, phase: pause?.state?.phase ?? null, status: "started" },
    });

    let snapshotId = null;
    try {
        snapshotId = writeRuntimeSnapshot(contract, { repoRoot: rootDir, mode: docMode ? "auto.from-doc" : "auto.start" });
    } catch {
        snapshotId = null;
    }

    return {
        ok: true,
        contract,
        dryRun: false,
        createdTaskFile: createdFile,
        snapshotId,
        planning: docMode ? planning : null,
        selectedTask: docMode ? { title: selectedTaskSeed.title, goal: selectedTaskSeed.goal } : null,
    };
}
