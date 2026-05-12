import fs from "node:fs";
import path from "node:path";
import { detectEntryPoints } from "./detectors/entry-points.js";
import { buildOverview } from "./detectors/overview.js";
import { detectProjectType } from "./detectors/project-type.js";
import {
    detectReusableSystem,
    detectSharedUi,
    detectUtilityDirs,
} from "./detectors/reusable-system.js";
import { detectRiskAreas } from "./detectors/risk-areas.js";
import { detectUISystem } from "./detectors/ui-system.js";
import {
    CONTEXT_AI_PATH,
    CONTEXT_DIR,
    CONTEXT_INDEX_ENTRYPOINTS_PATH,
    CONTEXT_INDEX_FILE_GROUPS_PATH,
    CONTEXT_INDEX_FILES_PATH,
    CONTEXT_INDEX_FILE_SUMMARIES_PATH,
    CONTEXT_INDEX_SUMMARY_PATH,
    CONTEXT_INDEX_SYMBOLS_PATH,
    CONTEXT_PROJECT_MD_PATH,
    CONTEXT_SYSTEM_OVERVIEW_PATH,
    CONTEXT_TASKS_PATH,
    RUNTIME_CONTEXT_PATH,
    RUNTIME_EXECUTION_PATH,
    RUNTIME_TASK_PATH,
    RUNTIME_VERIFICATION_PATH,
} from "./constants.js";
import { getContextStatus } from "./context.js";
import {
    getClosestStructurePath,
    detectStructure,
    getStructureDescription,
} from "./detectors/structure.js";
import { exists, isDirectory, readJson, statSafe } from "./fs-utils.js";
import { appendLoopEvent } from "../loop/store.js";
import { getRepoRoot } from "../runtime/root-context.js";
import { stablePathCompare, stableStringCompare } from "../runtime/stable-sort.js";
import { readPdglV1Status } from "../runtime/rdl/pdgl.js";
import {
    detectPackageMetadata,
    detectTechStack,
    getLockfileFingerprints,
    getPackageJsonDigest,
    getPackageJson,
} from "./package-utils.js";
import { buildTaskMap, updateProjectIndex } from "./indexers/project-index.js";
import {
    generateSystemOverviewContent,
    getSystemOverviewUpdate,
    updateSystemOverview,
} from "./system-overview.js";
import { getTaskConsistencyWarnings } from "./task-files.js";
import { getProjectMdUpdate, updateProjectMd } from "./writers/project-md.js";
import {
    getRuntimeJsonUpdate,
    updateRuntimeJson,
} from "../runtime/json-core.js";

function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function formatDescriptiveList(items) {
    return items.map((item) =>
        item.description ? `- ${item.label} -> ${item.description}` : `- ${item.label}`,
    );
}

function extractReferencedDirectories(lines) {
    const referencedDirs = new Set();
    const pathMatches = lines.flatMap(
        (line) => line.match(/(?:\.[A-Za-z0-9_-]+|[A-Za-z0-9_-]+)(?:\/[A-Za-z0-9_.-]+)+\/?/g) || [],
    );

    for (const match of pathMatches) {
        const normalized = match.replace(/`/g, "").replace(/\/+$/, "");
        const mappedStructurePath = getClosestStructurePath(normalized);

        if (mappedStructurePath && exists(mappedStructurePath)) {
            referencedDirs.add(mappedStructurePath);
            continue;
        }

        if (isDirectory(normalized)) {
            referencedDirs.add(normalized);
            continue;
        }

        const lastSlashIndex = normalized.lastIndexOf("/");
        if (lastSlashIndex === -1) {
            continue;
        }

        const parentDir = normalized.slice(0, lastSlashIndex);
        const mappedParentPath = getClosestStructurePath(parentDir);

        if (mappedParentPath && exists(mappedParentPath)) {
            referencedDirs.add(mappedParentPath);
            continue;
        }

        if (parentDir && isDirectory(parentDir)) {
            referencedDirs.add(parentDir);
        }
    }

    return [...referencedDirs];
}

function mergeStructureWithReferences(structure, reusableSystem, risks) {
    const structureByLabel = new Map(structure.map((item) => [item.label, item]));
    const referencedDirs = extractReferencedDirectories([
        ...reusableSystem.sections.flatMap((section) => section.items),
        ...risks,
    ]);

    for (const dir of referencedDirs) {
        const label = `${dir}/`;

        if (structureByLabel.has(label)) {
            continue;
        }

        structureByLabel.set(label, {
            label,
            description:
                getStructureDescription(dir) ||
                "referenced project directory with shared implementation significance",
        });
    }

    return [...structureByLabel.values()];
}

function buildProjectScanData() {
    const projectType = detectProjectType();
    const techStack = detectTechStack(projectType);
    const packageMetadata = detectPackageMetadata();
    const packageJson = getPackageJson();
    const uiSystem = detectUISystem(packageJson);
    const sharedUi = detectSharedUi();
    const utilityDirs = detectUtilityDirs();
    const reusableSystem = detectReusableSystem(
        projectType,
        sharedUi,
        utilityDirs,
    );
    const structure = detectStructure(projectType);
    const risks = detectRiskAreas(projectType, structure, sharedUi);
    const mergedStructure = mergeStructureWithReferences(
        structure,
        reusableSystem,
        risks,
    );
    const entryPoints = detectEntryPoints(projectType);
    const overview = buildOverview(projectType, techStack);

    return {
        projectType,
        techStack,
        packageMetadata,
        uiSystem,
        reusableSystem,
        risks,
        mergedStructure,
        entryPoints,
        overview,
    };
}

export function generateProjectMdContent(scanData = buildProjectScanData()) {
    const {
        projectType,
        techStack,
        packageMetadata,
        uiSystem,
        reusableSystem,
        risks,
        mergedStructure,
        entryPoints,
        overview,
    } = scanData;

    const lines = [
        "This section is automatically generated by `repo-context-kit scan`.",
        "Do not edit manually.",
        "",
        "## Project Type",
        `- ${projectType}`,
        "",
        "## Overview",
        ...overview,
        "",
        "## Tech Stack",
    ];

    if (techStack.length === 0) {
        lines.push("- Not clearly detected");
    } else {
        lines.push(...techStack.map((item) => `- ${item}`));
    }

    lines.push("", "## Package Metadata");
    if (!packageMetadata) {
        lines.push("- package.json not found");
    } else {
        if (packageMetadata.name) {
            lines.push(`- name: ${packageMetadata.name}`);
        }
        if (packageMetadata.version) {
            lines.push(`- version: ${packageMetadata.version}`);
        }
        if (packageMetadata.type) {
            lines.push(`- module type: ${packageMetadata.type}`);
        }
        if (packageMetadata.license) {
            lines.push(`- license: ${packageMetadata.license}`);
        }
        if (packageMetadata.packageManager) {
            lines.push(`- package manager: ${packageMetadata.packageManager}`);
        }

        if (packageMetadata.bin.length > 0) {
            lines.push("- bin:");
            for (const binEntry of packageMetadata.bin) {
                lines.push(`  - ${binEntry.name} -> ${binEntry.path}`);
            }
        }

        if (packageMetadata.scripts.length > 0) {
            lines.push("- scripts:");
            for (const script of packageMetadata.scripts) {
                lines.push(`  - ${script.name}: ${script.command}`);
            }
        }
    }

    // Add UI Design Context section if detected
    if (uiSystem && uiSystem.detected) {
        lines.push("", "## UI Design Context");
        
        if (uiSystem.framework) {
            lines.push(`- Framework: ${uiSystem.framework}`);
        }
        
        if (uiSystem.styleSystems && uiSystem.styleSystems.length > 0) {
            lines.push(`- Styling: ${uiSystem.styleSystems.join(", ")}`);
        }
        
        if (uiSystem.componentLibraries && uiSystem.componentLibraries.length > 0) {
            lines.push(`- Component Libraries: ${uiSystem.componentLibraries.join(", ")}`);
            lines.push("  - Prefer reusing existing components before writing new UI");
        }
        
        if (uiSystem.commonComponents && uiSystem.commonComponents.length > 0) {
            lines.push(`- Common Components: ${uiSystem.commonComponents.join(", ")}`);
        }
        
        if (uiSystem.themeTokens && uiSystem.themeTokens.length > 0) {
            lines.push(`- Design Tokens: ${uiSystem.themeTokens.join(", ")}`);
            lines.push("  - Reuse existing tokens for consistency (colors, spacing, sizing, shadows)");
        }
        
        if (uiSystem.uiDirectories && uiSystem.uiDirectories.length > 0) {
            lines.push(`- UI Locations: ${uiSystem.uiDirectories.join(", ")}`);
        }
        
        lines.push("- Best Practice: Always inspect and reuse project UI system before writing new styles");
    }

    lines.push(
        "",
        "## AI Development Notes",
        "- This is an npm CLI tool",
        "- Entry point: bin/cli.js",
        "- Template files are copied into user projects during init",
        "- template/ paths are runtime template sources; do not rewrite them as generated output paths",
        `- .claude/skills and ${CONTEXT_DIR}/tests are generated in user projects when present in the template`,
        "- Do not modify generated files unless explicitly required",
        "- Preserve package manager (npm/yarn/pnpm)",
        "- Follow existing file structure when adding new features",
    );

    lines.push("", "## Structure Overview");
    if (mergedStructure.length === 0) {
        lines.push("- No standard project structure detected");
    } else {
        lines.push(...formatDescriptiveList(mergedStructure));
    }

    lines.push("", "## Entry Points");
    if (entryPoints.length === 0) {
        lines.push("- No common entry files detected");
    } else {
        lines.push(...formatDescriptiveList(entryPoints));
    }

    lines.push("", "## Reusable System");
    for (const section of reusableSystem.sections) {
        lines.push(`### ${section.title}`);
        lines.push(...section.items.map((item) => `- ${item}`));
        lines.push("");
    }

    if (lines[lines.length - 1] === "") {
        lines.pop();
    }

    lines.push("", "## Risk Areas");
    if (risks.length === 0) {
        lines.push("- No obvious shared-risk areas detected");
    } else {
        lines.push(...risks.map((risk) => `- ${risk}`));
    }

    lines.push(
        "",
        "## Project Notes",
        "- Reuse existing structures before creating new ones",
        "- Treat shared modules cautiously and preserve backward compatibility",
        "- Keep changes minimal and localized unless the task explicitly requires broader refactoring",
    );

    return lines.join("\n");
}

function getUpdatedIndexFiles(indexUpdate) {
    const updatedFiles = [];

    if (indexUpdate.aiChanged) {
        updatedFiles.push(CONTEXT_AI_PATH);
    }
    if (indexUpdate.filesChanged) {
        updatedFiles.push(CONTEXT_INDEX_FILES_PATH);
    }
    if (indexUpdate.symbolsChanged) {
        updatedFiles.push(CONTEXT_INDEX_SYMBOLS_PATH);
    }
    if (indexUpdate.fileSummariesChanged) {
        updatedFiles.push(CONTEXT_INDEX_FILE_SUMMARIES_PATH);
    }
    if (indexUpdate.fileGroupsChanged) {
        updatedFiles.push(CONTEXT_INDEX_FILE_GROUPS_PATH);
    }
    if (indexUpdate.entrypointsChanged) {
        updatedFiles.push(CONTEXT_INDEX_ENTRYPOINTS_PATH);
    }
    if (indexUpdate.summaryChanged) {
        updatedFiles.push(CONTEXT_INDEX_SUMMARY_PATH);
    }
    if (indexUpdate.tasksChanged) {
        updatedFiles.push(CONTEXT_TASKS_PATH);
    }
    for (const filePath of [
        RUNTIME_TASK_PATH,
        RUNTIME_CONTEXT_PATH,
        RUNTIME_EXECUTION_PATH,
        RUNTIME_VERIFICATION_PATH,
    ]) {
        if (indexUpdate.runtimeChanged?.[filePath]) {
            updatedFiles.push(filePath);
        }
    }

    return updatedFiles;
}

function createScanResult(update, scanData, updatedFiles = [], warnings = []) {
    return {
        changed: update.changed,
        updatedFiles,
        warnings,
        project: {
            type: scanData.projectType,
            entryPoints: scanData.entryPoints.map((entryPoint) => entryPoint.label),
        },
    };
}

function printChanges(updatedFiles) {
    console.log("Changes:");

    if (updatedFiles.length === 0) {
        console.log("* No changes");
        return;
    }

    for (const filePath of updatedFiles) {
        console.log(`* Updated ${filePath}`);
    }
}

function printDefaultScanResult(result) {
    console.log("Repository Map Updated");
    console.log("OK Project scan completed");
    console.log("");
    console.log("repo-context-kit refreshed the project map AI tools use before planning work.");
    console.log("");
    printChanges(result.updatedFiles);
    console.log("");
    console.log("Summary:");
    console.log(`* Project type: ${result.project.type}`);
    console.log(
        `* Entry points: ${
            result.project.entryPoints.length > 0
                ? result.project.entryPoints.join(", ")
                : "None detected"
        }`,
    );
    console.log("");
    console.log("Next:");
    console.log("* Provide task/task.md and task/T-*.md files");
    console.log("* Or prepare AI context: repo-context-kit context next-task");
    printWarnings(result.warnings);
}

function printAutoScanResult(result) {
    console.log("Repository Map Updated");
    console.log("OK Project scan completed");
    console.log("");
    console.log("Mode: automatic refresh");
    console.log("Mode:");
    console.log("* auto");
    console.log("");
    printChanges(result.updatedFiles);
    console.log("");
    console.log("Next:");
    console.log("* Continue with the current task or ask for focused context.");
    printWarnings(result.warnings);
}

function printWarnings(warnings = []) {
    if (warnings.length === 0) {
        return;
    }

    console.log("");
    console.log("Warnings:");
    for (const warning of warnings) {
        console.log(`* ${warning}`);
    }
}

const PLAN_OUTPUTS = [
    CONTEXT_PROJECT_MD_PATH,
    CONTEXT_SYSTEM_OVERVIEW_PATH,
    CONTEXT_AI_PATH,
    CONTEXT_INDEX_FILES_PATH,
    CONTEXT_INDEX_SYMBOLS_PATH,
    CONTEXT_INDEX_FILE_SUMMARIES_PATH,
    CONTEXT_INDEX_FILE_GROUPS_PATH,
    CONTEXT_INDEX_ENTRYPOINTS_PATH,
    CONTEXT_INDEX_SUMMARY_PATH,
    CONTEXT_TASKS_PATH,
    RUNTIME_TASK_PATH,
    RUNTIME_CONTEXT_PATH,
    RUNTIME_EXECUTION_PATH,
    RUNTIME_VERIFICATION_PATH,
];

const PLAN_SKIPPED_DIRS = new Set([
    ".git",
    ".aidw",
    "node_modules",
    ".changeset",
    ".next",
    "dist",
    "build",
    "coverage",
]);

function listProjectFiles(dir = getRepoRoot(), results = []) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return results;
    }

    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (!PLAN_SKIPPED_DIRS.has(entry.name)) {
                listProjectFiles(path.join(dir, entry.name), results);
            }
            continue;
        }

        if (entry.isFile()) {
            results.push(
                path
                    .relative(getRepoRoot(), path.join(dir, entry.name))
                    .replaceAll(path.sep, "/"),
            );
        }
    }

    return results;
}

function getLatestProjectMtimeMs() {
    const files = listProjectFiles();
    let latest = 0;
    for (const filePath of files) {
        const stat = statSafe(filePath);
        if (stat && stat.mtimeMs > latest) {
            latest = stat.mtimeMs;
        }
    }
    return latest || null;
}

function hasTaskMetadataNewerThan(baselineMs) {
    const registryStat = statSafe("task/task.md");
    if (registryStat && registryStat.mtimeMs > baselineMs) {
        return true;
    }

    try {
        const dirStat = statSafe("task");
        if (!dirStat || !dirStat.isDirectory()) {
            return false;
        }
    } catch {
        return false;
    }

    const entries = fs.readdirSync(path.resolve(getRepoRoot(), "task"), { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
            continue;
        }
        if (entry.name.toLowerCase() === "task.md") {
            continue;
        }
        const stat = statSafe(`task/${entry.name}`);
        if (stat && stat.mtimeMs > baselineMs) {
            return true;
        }
    }

    return false;
}

function detectFileListDiff() {
    const current = new Set(listProjectFiles());
    const previous = new Set(
        (readJson(CONTEXT_INDEX_FILES_PATH) ?? [])
            .map((entry) => String(entry?.path ?? "").trim())
            .filter(Boolean),
    );
    const added = [];
    const removed = [];
    for (const filePath of current) {
        if (!previous.has(filePath)) {
            added.push(filePath);
        }
    }
    for (const filePath of previous) {
        if (!current.has(filePath)) {
            removed.push(filePath);
        }
    }
    return {
        added,
        removed,
        changed: added.length > 0 || removed.length > 0,
    };
}

function normalizeRelPath(value) {
    const text = String(value ?? "").trim();
    if (!text) return null;
    return text.replaceAll("\\", "/");
}

function computeWorksetMissingFiles(worksetFiles, { limit = 200 } = {}) {
    const root = getRepoRoot();
    const files = Array.isArray(worksetFiles) ? worksetFiles : [];
    const missing = [];
    for (const filePathRaw of files.slice(0, limit)) {
        const filePath = normalizeRelPath(filePathRaw);
        if (!filePath) continue;
        const fullPath = path.resolve(root, filePath);
        if (!fs.existsSync(fullPath)) {
            missing.push(filePath);
        }
    }
    return missing.sort(stablePathCompare);
}

function computeEntrypointDrift({ baselineMs }) {
    if (!exists(CONTEXT_INDEX_ENTRYPOINTS_PATH) || baselineMs == null) {
        return { changed: false, changedEntrypoints: [] };
    }
    const entrypoints = readJson(CONTEXT_INDEX_ENTRYPOINTS_PATH);
    const list = Array.isArray(entrypoints) ? entrypoints : [];
    const changed = [];
    for (const item of list.slice(0, 80)) {
        const rel = normalizeRelPath(item?.path ?? item?.file ?? "");
        if (!rel) continue;
        const stat = statSafe(rel);
        if (stat && stat.mtimeMs > baselineMs) {
            changed.push(rel);
        }
    }
    return { changed: changed.length > 0, changedEntrypoints: changed.slice(0, 16) };
}

function computeSymbolsDrift({ baselineMs, fileDiff }) {
    if (baselineMs == null) {
        return { drifted: true, modifiedCodeFiles: [], scanned: 0, truncated: false };
    }
    const codeExts = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".cs"]);
    const files = listProjectFiles();
    const limit = 5000;
    let scanned = 0;
    let truncated = false;
    const modified = [];
    for (const rel of files) {
        scanned += 1;
        if (scanned > limit) {
            truncated = true;
            break;
        }
        const ext = path.extname(rel).toLowerCase();
        if (!codeExts.has(ext)) continue;
        const stat = statSafe(rel);
        if (stat && stat.mtimeMs > baselineMs) {
            modified.push(rel);
            if (modified.length >= 24) break;
        }
    }
    const drifted = Boolean(fileDiff?.changed) || modified.length > 0 || truncated;
    return { drifted, modifiedCodeFiles: modified.slice(0, 16), scanned, truncated };
}

function computeFileGroupsDrift(fileDiff) {
    const added = Array.isArray(fileDiff?.added) ? fileDiff.added : [];
    const removed = Array.isArray(fileDiff?.removed) ? fileDiff.removed : [];
    const topDirs = new Set();
    for (const filePath of [...added, ...removed].slice(0, 400)) {
        const rel = normalizeRelPath(filePath);
        if (!rel) continue;
        const top = rel.split("/")[0] || "";
        if (top) topDirs.add(top);
    }
    const dirs = [...topDirs].sort(stablePathCompare);
    return { drifted: Boolean(fileDiff?.changed) && dirs.length > 0, topDirs: dirs.slice(0, 16) };
}

function pickActiveLockfileFingerprint(fingerprints) {
    const fp = isPlainObject(fingerprints) ? fingerprints : {};
    return fp.packageLock ?? fp.pnpmLock ?? fp.yarnLock ?? null;
}

function fingerprintKeyForBaseline(baseline) {
    const p = String(baseline?.path ?? "").trim();
    if (p === "package-lock.json") return "packageLock";
    if (p === "pnpm-lock.yaml") return "pnpmLock";
    if (p === "yarn.lock") return "yarnLock";
    return null;
}

function computeLockfileChanged({ baselineMs, baselineSummary }) {
    const current = pickActiveLockfileFingerprint(getLockfileFingerprints());
    const baselineFp = pickActiveLockfileFingerprint(baselineSummary?.lockfileFingerprints);
    if (!current && !baselineFp) {
        return { changed: false, baseline: null, current: null };
    }
    if (current && baselineFp) {
        const changed =
            String(current.sha256 ?? "") !== String(baselineFp.sha256 ?? "") ||
            Number(current.bytes ?? 0) !== Number(baselineFp.bytes ?? 0) ||
            Boolean(current.truncated) !== Boolean(baselineFp.truncated) ||
            String(current.path ?? "") !== String(baselineFp.path ?? "");
        return { changed, baseline: baselineFp, current };
    }
    const filePath = current?.path ?? baselineFp?.path ?? null;
    const stat = filePath ? statSafe(filePath) : null;
    const changed = baselineMs != null && stat && stat.mtimeMs > baselineMs;
    return { changed, baseline: baselineFp, current };
}

export function computeContextFreshness(options = {}) {
    const worksetFiles = Array.isArray(options.worksetFiles) ? options.worksetFiles : [];
    const baseline = statSafe(CONTEXT_INDEX_SUMMARY_PATH);
    const baselineMs = baseline ? baseline.mtimeMs : null;
    const baselineSummary = readJson(CONTEXT_INDEX_SUMMARY_PATH);
    const baselinePackageDigest =
        typeof baselineSummary?.packageJsonDigest === "string"
            ? baselineSummary.packageJsonDigest
            : null;
    const currentPackageDigest = getPackageJsonDigest();
    const packageStat = statSafe("package.json");
    const packageJsonChanged =
        baselinePackageDigest != null && currentPackageDigest != null
            ? currentPackageDigest !== baselinePackageDigest
            : baselineMs != null && packageStat && packageStat.mtimeMs > baselineMs;

    const lockfile = computeLockfileChanged({ baselineMs, baselineSummary });

    const taskWarnings = getTaskConsistencyWarnings();
    const taskChanged = baselineMs != null && hasTaskMetadataNewerThan(baselineMs);
    const fileDiff = exists(CONTEXT_INDEX_FILES_PATH) ? detectFileListDiff() : { changed: true, added: [], removed: [] };
    const latestProjectMs = getLatestProjectMtimeMs();
    const scanStale =
        baselineMs == null ||
        (latestProjectMs != null && latestProjectMs > baselineMs) ||
        fileDiff.changed ||
        PLAN_OUTPUTS.some((filePath) => !exists(filePath));

    const entrypoints = computeEntrypointDrift({ baselineMs });
    const symbols = computeSymbolsDrift({ baselineMs, fileDiff });
    const fileGroups = computeFileGroupsDrift(fileDiff);
    const missingWorksetFiles = computeWorksetMissingFiles(worksetFiles);
    const snapshotsPath = path.resolve(getRepoRoot(), ".aidw/runtime/snapshots/snapshots.jsonl");
    const snapshotsStat = fs.existsSync(snapshotsPath) ? fs.statSync(snapshotsPath) : null;
    const snapshotsMissing = !snapshotsStat || !snapshotsStat.isFile() || snapshotsStat.size === 0;

    const scaffoldPlanOutdated = fs.existsSync(scaffoldPlanPath) ? (() => {
        try {
            const parsed = JSON.parse(fs.readFileSync(scaffoldPlanPath, "utf-8"));
            return !isPlainObject(parsed);
        } catch {
            return true;
        }
    })() : false;

    const signals = [
        {
            id: "package_json_changed",
            triggered: packageJsonChanged,
            penalty: 20,
            evidence: { baselineMs, baselineDigest: baselinePackageDigest, currentDigest: currentPackageDigest },
            suggestedAction: "Run repo-context-kit scan to refresh indexes after dependency changes.",
        },
        {
            id: "lockfile_changed",
            triggered: Boolean(lockfile.changed),
            penalty: 15,
            evidence: {
                baseline: lockfile.baseline ? { path: lockfile.baseline.path, sha256: lockfile.baseline.sha256, bytes: lockfile.baseline.bytes } : null,
                current: lockfile.current ? { path: lockfile.current.path, sha256: lockfile.current.sha256, bytes: lockfile.current.bytes } : null,
            },
            suggestedAction: "Run repo-context-kit scan to refresh context after lockfile updates.",
        },
        {
            id: "entrypoints_changed",
            triggered: Boolean(entrypoints.changed),
            penalty: 20,
            evidence: { changedEntrypoints: entrypoints.changedEntrypoints },
            suggestedAction: "Re-run repo-context-kit scan to re-detect entrypoints and update system overview.",
        },
        {
            id: "symbols_drifted",
            triggered: Boolean(symbols.drifted),
            penalty: 15,
            evidence: { modifiedCodeFiles: symbols.modifiedCodeFiles, scanned: symbols.scanned, truncated: symbols.truncated },
            suggestedAction: "Re-run repo-context-kit scan to refresh symbols and file summaries.",
        },
        {
            id: "file_groups_drifted",
            triggered: Boolean(fileGroups.drifted),
            penalty: 10,
            evidence: { topDirs: fileGroups.topDirs, added: (fileDiff.added || []).slice(0, 8), removed: (fileDiff.removed || []).slice(0, 8) },
            suggestedAction: "Re-run repo-context-kit scan to refresh file groups after structure changes.",
        },
        {
            id: "missing_workset_files",
            triggered: missingWorksetFiles.length > 0,
            penalty: 15,
            evidence: { missing: missingWorksetFiles.slice(0, 16), count: missingWorksetFiles.length },
            suggestedAction: "Refresh the workset selection (or update file paths) before planning changes.",
        },
        {
            id: "tasks_stale",
            triggered: Boolean(taskChanged) || taskWarnings.length > 0,
            penalty: 10,
            evidence: { taskChanged, warnings: taskWarnings.slice(0, 6) },
            suggestedAction: "Update tasks and re-run repo-context-kit scan so task mappings stay consistent.",
        },
        {
            id: "snapshots_missing",
            triggered: Boolean(snapshotsMissing),
            penalty: 10,
            evidence: { path: ".aidw/runtime/snapshots/snapshots.jsonl", exists: Boolean(snapshotsStat), bytes: snapshotsStat?.size ?? 0 },
            suggestedAction: "Generate a runtime snapshot after key workflow milestones (or run an auto plan) for auditability.",
        },
        {
            id: "scaffold_plan_outdated",
            triggered: Boolean(scaffoldPlanOutdated),
            penalty: 10,
            evidence: { path: null },
            suggestedAction: "Re-generate the scaffold plan and re-verify confirmation tokens before apply.",
        },
    ];

    let score = 100;
    for (const signal of signals) {
        if (signal.triggered) {
            score -= Number(signal.penalty ?? 0);
        }
    }
    score = Math.max(0, Math.min(100, score));

    const triggered = signals.filter((s) => s.triggered).sort((a, b) => stableStringCompare(a.id, b.id));
    const suggestedActions = [...new Set(triggered.map((s) => s.suggestedAction).filter(Boolean))].sort(stableStringCompare);

    return {
        score,
        scanStale: Boolean(scanStale),
        signals: triggered.map((s) => ({
            id: s.id,
            penalty: s.penalty,
            evidence: isPlainObject(s.evidence) ? s.evidence : {},
            suggestedAction: s.suggestedAction,
        })),
        suggestedActions,
    };
}

function printScanPlan({ willUpdate = [], reasons = [] }) {
    console.log("Repository Map Needs Refresh");
    console.log("Scan Plan");
    console.log("");
    console.log("No files were written.");
    console.log("");
    console.log("Would update:");
    console.log("Will update:");
    if (willUpdate.length === 0) {
        console.log("- (none)");
    } else {
        for (const filePath of willUpdate) {
            console.log(`- ${filePath}`);
        }
    }
    console.log("");
    console.log("Why:");
    console.log("Reasons:");
    if (reasons.length === 0) {
        console.log("- (none)");
    } else {
        for (const reason of reasons) {
            console.log(`- ${reason}`);
        }
    }
    console.log("");
    console.log("Next:");
    console.log("- Run: repo-context-kit scan");
}

function combineCheckUpdates(projectUpdate, systemOverviewUpdate, warnings) {
    const taskMapChanged =
        JSON.stringify(readJson(CONTEXT_TASKS_PATH) ?? null) !==
        JSON.stringify(buildTaskMap());
    const runtimeChanged = getRuntimeJsonUpdate(buildProjectScanData(), warnings);

    return {
        changed:
            projectUpdate.changed ||
            systemOverviewUpdate.changed ||
            taskMapChanged ||
            Object.values(runtimeChanged).some(Boolean) ||
            warnings.length > 0,
        skipped: projectUpdate.skipped,
        projectChanged: projectUpdate.changed,
        systemOverviewChanged: systemOverviewUpdate.changed,
        taskMapChanged,
        runtimeChanged,
        taskRegistryChanged: warnings.length > 0,
    };
}

export function computeScanCheckState() {
    const scanData = buildProjectScanData();
    const content = generateProjectMdContent(scanData);
    const taskWarnings = getTaskConsistencyWarnings();
    const projectUpdate = getProjectMdUpdate(content);
    const systemOverviewUpdate = getSystemOverviewUpdate();
    const update = combineCheckUpdates(projectUpdate, systemOverviewUpdate, taskWarnings);

    return {
        scanData,
        taskWarnings,
        update,
    };
}

function maybeAppendLearnableScanEvent(event) {
    if (!isDirectory(CONTEXT_DIR)) {
        return null;
    }

    try {
        return appendLoopEvent(event);
    } catch {
        return null;
    }
}

function printCheckResult(update) {
    if (update.skipped) {
        console.log("ERROR Project context cannot be checked");
        console.log("");
        console.log("Reason:");
        console.log(`* AUTO-GENERATED markers not found in ${CONTEXT_PROJECT_MD_PATH}`);
        console.log("");
        console.log("Next:");
        console.log("* Run 'repo-context-kit scan' to regenerate.");
        return;
    }

    if (!update.changed) {
        console.log("OK Project context is up to date");
        console.log("");
        console.log("Checked:");
        console.log(`* ${CONTEXT_PROJECT_MD_PATH} AUTO-GENERATED section`);
        console.log(`* ${CONTEXT_SYSTEM_OVERVIEW_PATH}`);
        return;
    }

    console.log("ERROR Project context is outdated");
    console.log("");
    console.log("Changes:");
    if (update.projectChanged) {
        console.log(`* ${CONTEXT_PROJECT_MD_PATH} generated section is out of date`);
    }
    if (update.systemOverviewChanged) {
        console.log(`* ${CONTEXT_SYSTEM_OVERVIEW_PATH} is missing or out of date`);
    }
    if (update.taskMapChanged) {
        console.log(`* ${CONTEXT_TASKS_PATH} is missing or out of date`);
    }
    if (update.runtimeChanged && Object.values(update.runtimeChanged).some(Boolean)) {
        console.log(`* ${RUNTIME_TASK_PATH} and runtime JSON views are missing or out of date`);
    }
    if (update.taskRegistryChanged) {
        console.log("* task registry and task files are inconsistent");
    }
    console.log("");
    console.log("Next:");
    console.log("* Run 'repo-context-kit scan' to update.");
}

function printSkippedUpdateResult() {
    console.log("ERROR Project scan cannot update project context");
    console.log("");
    console.log("Reason:");
    console.log(`* AUTO-GENERATED markers not found in ${CONTEXT_PROJECT_MD_PATH}`);
    console.log("");
    console.log("Next:");
    console.log(`* Add AUTO-GENERATED markers or regenerate ${CONTEXT_PROJECT_MD_PATH}.`);
}

function printContextStatusError(status) {
    if (status.reason === "not-initialized") {
        console.log("ERROR Project not initialized");
        console.log(`Missing: ${CONTEXT_DIR}/`);
        console.log("Run: repo-context-kit init");
        return;
    }

    console.log("ERROR Project context is incomplete");
    console.log("Run: repo-context-kit scan --auto");
}

function updateProjectIndexSafe() {
    try {
        return updateProjectIndex();
    } catch (error) {
        console.warn(`Warning: Project index generation failed: ${error.message}`);
        return {
            aiChanged: false,
            filesChanged: false,
            symbolsChanged: false,
            fileGroupsChanged: false,
            entrypointsChanged: false,
            summaryChanged: false,
            tasksChanged: false,
        };
    }
}

export async function runScan(options = {}) {
    const mode = options.mode || "normal";
    const contextStatus = getContextStatus();

    if (mode === "plan") {
        const scanData = buildProjectScanData();
        const content = generateProjectMdContent(scanData);
        const taskWarnings = getTaskConsistencyWarnings();
        const baseline = statSafe(CONTEXT_INDEX_SUMMARY_PATH);
        const baselineMs = baseline ? baseline.mtimeMs : null;
        const baselineSummary = readJson(CONTEXT_INDEX_SUMMARY_PATH);
        const baselinePackageDigest =
            typeof baselineSummary?.packageJsonDigest === "string"
                ? baselineSummary.packageJsonDigest
                : null;
        const latestProjectMs = getLatestProjectMtimeMs();
        const currentPackageDigest = getPackageJsonDigest();
        const packageStat = statSafe("package.json");
        const packageChanged =
            baselinePackageDigest != null && currentPackageDigest != null
                ? currentPackageDigest !== baselinePackageDigest
                : baselineMs != null && packageStat && packageStat.mtimeMs > baselineMs;
        const taskChanged = baselineMs != null && hasTaskMetadataNewerThan(baselineMs);
        const fileDiff = exists(CONTEXT_INDEX_FILES_PATH) ? detectFileListDiff() : { changed: true, added: [], removed: [] };
        const scanStale =
            baselineMs == null ||
            (latestProjectMs != null && latestProjectMs > baselineMs) ||
            fileDiff.changed ||
            PLAN_OUTPUTS.some((filePath) => !exists(filePath));

        const projectUpdate = getProjectMdUpdate(content);
        const systemOverviewUpdate = getSystemOverviewUpdate();
        const taskMapChanged =
            JSON.stringify(readJson(CONTEXT_TASKS_PATH) ?? null) !==
            JSON.stringify(buildTaskMap());

        const willUpdateSet = new Set();
        const reasons = [];

        if (!contextStatus.ok) {
            reasons.push(
                contextStatus.reason === "not-initialized"
                    ? "project is not initialized"
                    : "project context is incomplete",
            );
            for (const filePath of PLAN_OUTPUTS) {
                willUpdateSet.add(filePath);
            }
        } else {
            if (projectUpdate.skipped) {
                reasons.push(`AUTO-GENERATED markers missing in ${CONTEXT_PROJECT_MD_PATH}`);
            }
            if (projectUpdate.changed || !exists(CONTEXT_PROJECT_MD_PATH)) {
                willUpdateSet.add(CONTEXT_PROJECT_MD_PATH);
            }
            if (systemOverviewUpdate.changed || !exists(CONTEXT_SYSTEM_OVERVIEW_PATH)) {
                willUpdateSet.add(CONTEXT_SYSTEM_OVERVIEW_PATH);
            }
            if (scanStale) {
                reasons.push("previous scan is stale");
                for (const filePath of [
                    CONTEXT_AI_PATH,
                    CONTEXT_INDEX_FILES_PATH,
                    CONTEXT_INDEX_SYMBOLS_PATH,
                    CONTEXT_INDEX_FILE_SUMMARIES_PATH,
                    CONTEXT_INDEX_FILE_GROUPS_PATH,
                    CONTEXT_INDEX_ENTRYPOINTS_PATH,
                    CONTEXT_INDEX_SUMMARY_PATH,
                ]) {
                    willUpdateSet.add(filePath);
                }
            }
            if (packageChanged) {
                reasons.push("package.json changed");
            }
            if (taskChanged) {
                reasons.push("task metadata changed");
            }
            if (fileDiff.changed) {
                reasons.push("new or removed source files detected");
            }
            if (taskMapChanged || scanStale) {
                willUpdateSet.add(CONTEXT_TASKS_PATH);
            }
            if (taskWarnings.length > 0) {
                reasons.push("task registry and task files are inconsistent");
            }
        }

        printScanPlan({
            willUpdate: [...willUpdateSet].filter(Boolean).sort(),
            reasons: [...new Set(reasons)].filter(Boolean),
        });

        return {
            planned: true,
            willUpdate: [...willUpdateSet],
            reasons,
            warnings: taskWarnings,
        };
    }

    if (!contextStatus.ok) {
        printContextStatusError(contextStatus);
        maybeAppendLearnableScanEvent({
            type: "scan_failed",
            ok: false,
            reason: contextStatus.reason,
        });
        process.exitCode = 1;
        return {
            changed: false,
            updatedFiles: [],
            incomplete: contextStatus.reason === "incomplete",
            initialized: contextStatus.reason !== "not-initialized",
        };
    }

    if (mode === "check") {
        const { scanData, taskWarnings, update } = computeScanCheckState();
        const result = createScanResult(update, scanData, [], taskWarnings);

        printCheckResult(update);
        printWarnings(taskWarnings);
        const design = readPdglV1Status({ repoRoot: getRepoRoot() });
        if (design.present !== true) {
            console.log("");
            console.log("Design warnings:");
            console.log(`* runtime-design-incomplete`);
            console.log("* Fill PDGL (v1) in PROJECT.md to stabilize intent/constraints.");
        } else if (Array.isArray(design.missingChecks) && design.missingChecks.length > 0) {
            console.log("");
            console.log("Design warnings:");
            for (const id of design.missingChecks.slice(0, 12)) {
                console.log(`* ${id}`);
            }
            if (Array.isArray(design.suggestedImprovements) && design.suggestedImprovements.length > 0) {
                console.log("");
                console.log("Suggested improvements:");
                for (const item of design.suggestedImprovements.slice(0, 8)) {
                    console.log(`* ${item}`);
                }
            }
        }

        if (update.changed) {
            maybeAppendLearnableScanEvent({
                type: "scan_check_failed",
                ok: false,
                projectChanged: update.projectChanged,
                systemOverviewChanged: update.systemOverviewChanged,
                taskMapChanged: update.taskMapChanged,
                taskRegistryChanged: update.taskRegistryChanged,
                skipped: update.skipped,
                warnings: taskWarnings,
            });
            process.exitCode = 1;
        } else {
            maybeAppendLearnableScanEvent({
                type: "scan_check_passed",
                ok: true,
            });
        }

        return result;
    }

    const scanData = buildProjectScanData();
    const content = generateProjectMdContent(scanData);
    const taskWarnings = getTaskConsistencyWarnings();
    const indexUpdate = updateProjectIndexSafe();
    indexUpdate.runtimeChanged = updateRuntimeJson(scanData, taskWarnings);
    const systemOverviewUpdate = updateSystemOverview(
        generateSystemOverviewContent(),
    );
    const update = updateProjectMd(content);
    const updatedFiles = [
        ...(update.changed && !update.skipped ? [CONTEXT_PROJECT_MD_PATH] : []),
        ...getUpdatedIndexFiles(indexUpdate),
        ...(systemOverviewUpdate.changed ? [CONTEXT_SYSTEM_OVERVIEW_PATH] : []),
    ];
    const result = createScanResult(
        {
            ...update,
            changed:
                update.changed ||
                systemOverviewUpdate.changed ||
                Object.values(indexUpdate.runtimeChanged || {}).some(Boolean),
        },
        scanData,
        updatedFiles,
        taskWarnings,
    );
    result.index = indexUpdate;
    result.systemOverview = systemOverviewUpdate;

    if (!result.changed) {
        if (mode === "auto") {
            printAutoScanResult(result);
            return result;
        }

        printDefaultScanResult(result);
        return result;
    }

    if (update.skipped) {
        printSkippedUpdateResult();
        maybeAppendLearnableScanEvent({
            type: "scan_failed",
            ok: false,
            reason: "missing_auto_generated_markers",
        });
        process.exitCode = 1;
        return result;
    }

    if (mode === "auto") {
        printAutoScanResult(result);
        return result;
    }

    printDefaultScanResult(result);

    return result;
}
