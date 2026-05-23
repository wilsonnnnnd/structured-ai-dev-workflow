import crypto from "node:crypto";
import fs from "fs";
import path from "path";

const STATE_DIR = ".aidw";
const STATE_FILE = "confirmation-gate.json";
const PROTOCOL = "confirmation-protocol/v1";
const DEFAULT_TTL_MINUTES = 60;

function getStatePath(cwd = process.cwd()) {
    return path.resolve(cwd, STATE_DIR, STATE_FILE);
}

function buildDefaultState() {
    return {
        protocol: PROTOCOL,
        active: null,
        updatedAt: null,
    };
}

function toIso(value) {
    return value instanceof Date ? value.toISOString() : null;
}

function isExpired(active) {
    if (!active?.expiresAt) {
        return false;
    }
    const expiresAtMs = Date.parse(active.expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
        return true;
    }
    return Date.now() > expiresAtMs;
}

function normalizeLoadedState(parsed) {
    const protocol = typeof parsed?.protocol === "string" ? parsed.protocol : PROTOCOL;
    const active = parsed?.active && typeof parsed.active === "object" ? parsed.active : null;
    const updatedAt = typeof parsed?.updatedAt === "string" ? parsed.updatedAt : null;

    if (!active || isExpired(active)) {
        return {
            protocol,
            active: null,
            updatedAt,
        };
    }

    return {
        protocol,
        active: {
            taskId: typeof active.taskId === "string" ? active.taskId : null,
            token: typeof active.token === "string" ? active.token : null,
            expiresAt: typeof active.expiresAt === "string" ? active.expiresAt : null,
            taskConfirmedAt: typeof active.taskConfirmedAt === "string" ? active.taskConfirmedAt : null,
            testsConfirmedAt: typeof active.testsConfirmedAt === "string" ? active.testsConfirmedAt : null,
            taskConfirmed: Boolean(active.taskConfirmed),
            testsConfirmed: Boolean(active.testsConfirmed),
        },
        updatedAt,
    };
}

export function loadGateState(cwd = process.cwd()) {
    const filePath = getStatePath(cwd);

    if (!fs.existsSync(filePath)) {
        return buildDefaultState();
    }

    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);

        return normalizeLoadedState(parsed);
    } catch {
        return buildDefaultState();
    }
}

export function saveGateState(nextState, cwd = process.cwd()) {
    const dirPath = path.resolve(cwd, STATE_DIR);
    const filePath = getStatePath(cwd);
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(nextState, null, 2) + "\n", "utf-8");
    return filePath;
}

export function confirmTask(taskId, options = {}, cwd = process.cwd()) {
    const normalizedTaskId = String(taskId ?? "").trim().toUpperCase();
    if (!/^T-\d{3}$/i.test(normalizedTaskId)) {
        return { error: "Invalid task id. Expected format: T-###", filePath: null, state: null, token: null };
    }

    const ttlMinutesRaw = Number.parseInt(options.ttlMinutes ?? DEFAULT_TTL_MINUTES, 10);
    const ttlMinutes = Number.isFinite(ttlMinutesRaw) && ttlMinutesRaw > 0 ? ttlMinutesRaw : DEFAULT_TTL_MINUTES;
    const token = crypto.randomBytes(16).toString("hex");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000);
    const next = {
        protocol: PROTOCOL,
        active: {
            taskId: normalizedTaskId,
            token,
            expiresAt: toIso(expiresAt),
            taskConfirmedAt: toIso(now),
            testsConfirmedAt: null,
            taskConfirmed: true,
            testsConfirmed: false,
        },
        updatedAt: toIso(now),
    };
    const filePath = saveGateState(next, cwd);
    return { error: null, filePath, state: next, token };
}

export function confirmTests(taskId, cwd = process.cwd()) {
    const normalizedTaskId = String(taskId ?? "").trim().toUpperCase();
    const prev = loadGateState(cwd);
    const active = prev.active;

    if (!active || isExpired(active)) {
        return { error: "Task must be confirmed before confirming tests.", filePath: null, state: null };
    }

    if (!active.taskConfirmed || !active.taskId || active.taskId.toUpperCase() !== normalizedTaskId) {
        return { error: "Task must be confirmed before confirming tests.", filePath: null, state: null };
    }

    const now = new Date();
    const next = {
        protocol: PROTOCOL,
        active: {
            ...active,
            testsConfirmed: true,
            testsConfirmedAt: toIso(now),
        },
        updatedAt: toIso(now),
    };
    const filePath = saveGateState(next, cwd);
    return { error: null, filePath, state: next };
}

export function resetGateState(cwd = process.cwd()) {
    const now = new Date();
    const next = {
        protocol: PROTOCOL,
        active: null,
        updatedAt: toIso(now),
    };
    const filePath = saveGateState(next, cwd);
    return { filePath, state: next };
}

export function validateGate({ taskId, token, requireTestsConfirmed = false }, cwd = process.cwd()) {
    const normalizedTaskId = String(taskId ?? "").trim().toUpperCase();
    const providedToken = String(token ?? "").trim();
    const state = loadGateState(cwd);
    const active = state.active;

    if (!active || isExpired(active)) {
        return { ok: false, error: "Gate is not confirmed for this task." };
    }

    if (!active.taskConfirmed || active.taskId?.toUpperCase() !== normalizedTaskId) {
        return { ok: false, error: "Gate is not confirmed for this task." };
    }

    if (!providedToken || active.token !== providedToken) {
        return { ok: false, error: "Invalid gate token." };
    }

    if (requireTestsConfirmed && !active.testsConfirmed) {
        return { ok: false, error: "Tests are not confirmed. Run: rck gate confirm tests <taskId>" };
    }

    return { ok: true, error: null };
}
