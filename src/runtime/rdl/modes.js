import fs from "node:fs";
import path from "node:path";

export const RUNTIME_MODES = ["SAFE", "STANDARD", "REVIEW", "EXPERIMENTAL"];

const MODE_CONFIG = {
    SAFE: {
        id: "SAFE",
        writePolicy: "restricted",
        mcpWriteDefault: false,
        applyAllowed: true,
        snapshotFrequency: "before_after",
        explainDepth: "deep",
        riskTolerance: { minFreshnessScoreToWrite: 85 },
        worksetLimits: { digestMaxFiles: 16, deepMaxFiles: 24 },
        commandPolicy: { allowCommands: false, allowTests: true },
    },
    STANDARD: {
        id: "STANDARD",
        writePolicy: "scoped",
        mcpWriteDefault: true,
        applyAllowed: true,
        snapshotFrequency: "task",
        explainDepth: "standard",
        riskTolerance: { minFreshnessScoreToWrite: 65 },
        worksetLimits: { digestMaxFiles: 16, deepMaxFiles: 28 },
        commandPolicy: { allowCommands: false, allowTests: true },
    },
    REVIEW: {
        id: "REVIEW",
        writePolicy: "read_only",
        mcpWriteDefault: false,
        applyAllowed: false,
        snapshotFrequency: "none",
        explainDepth: "deep",
        riskTolerance: { minFreshnessScoreToWrite: 100 },
        worksetLimits: { digestMaxFiles: 16, deepMaxFiles: 16 },
        commandPolicy: { allowCommands: false, allowTests: false },
    },
    EXPERIMENTAL: {
        id: "EXPERIMENTAL",
        writePolicy: "scoped",
        mcpWriteDefault: true,
        applyAllowed: true,
        snapshotFrequency: "before_after",
        explainDepth: "deep",
        riskTolerance: { minFreshnessScoreToWrite: 50 },
        worksetLimits: { digestMaxFiles: 24, deepMaxFiles: 36 },
        commandPolicy: { allowCommands: false, allowTests: true },
    },
};

function normalizeMode(value) {
    const raw = String(value ?? "").trim().toUpperCase();
    return RUNTIME_MODES.includes(raw) ? raw : "STANDARD";
}

function getModeFilePath(repoRoot) {
    const root = String(repoRoot ?? "").trim() || process.cwd();
    return path.resolve(root, ".aidw/runtime/mode.json");
}

function readModeFile(repoRoot) {
    const filePath = getModeFilePath(repoRoot);
    if (!fs.existsSync(filePath)) return null;
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        const mode = normalizeMode(parsed?.mode);
        return mode;
    } catch {
        return null;
    }
}

export function resolveRuntimeMode({ repoRoot, requestedMode } = {}) {
    if (requestedMode != null) {
        return normalizeMode(requestedMode);
    }
    if (process.env.RCK_MODE) {
        return normalizeMode(process.env.RCK_MODE);
    }
    const fileMode = readModeFile(repoRoot);
    if (fileMode) {
        return fileMode;
    }
    return "STANDARD";
}

export function getRuntimeModeConfig(mode) {
    const id = normalizeMode(mode);
    return MODE_CONFIG[id];
}

