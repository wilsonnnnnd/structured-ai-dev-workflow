import fs from "fs";
import path from "path";
import { CONTEXT_BUDGET } from "../runtime/context-budget.js";
import { stableStringCompare } from "../runtime/stable-sort.js";

const LOOP_DIR = ".aidw";
const LOOP_FILE = "context-loop.jsonl";
const MAX_READ_BYTES = 96_000;
const MAX_READ_BYTES_LIMIT = 256_000;

function getLoopPath(cwd = process.cwd()) {
    return path.resolve(cwd, LOOP_DIR, LOOP_FILE);
}

function ensureLoopDir(cwd = process.cwd()) {
    fs.mkdirSync(path.resolve(cwd, LOOP_DIR), { recursive: true });
}

export function appendLoopEvent(event, cwd = process.cwd()) {
    ensureLoopDir(cwd);
    const filePath = getLoopPath(cwd);
    const payload = {
        at: new Date().toISOString(),
        ...event,
    };
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf-8");
    return filePath;
}

function readTail(filePath, maxBytes) {
    if (!fs.existsSync(filePath)) {
        return "";
    }

    const stat = fs.statSync(filePath);
    const size = stat.size;
    const readBytes = Math.min(size, maxBytes);
    const start = Math.max(0, size - readBytes);
    const fd = fs.openSync(filePath, "r");
    try {
        const buffer = Buffer.alloc(readBytes);
        fs.readSync(fd, buffer, 0, readBytes, start);
        return buffer.toString("utf-8");
    } finally {
        fs.closeSync(fd);
    }
}

export function listRecentLoopEvents(options = {}, cwd = process.cwd()) {
    const requestedLimit = Number.isFinite(options.limit) ? options.limit : 8;
    const limit = Math.max(1, Math.min(CONTEXT_BUDGET.maxLoopEvents, Math.floor(requestedLimit)));
    const taskId = options.taskId ? String(options.taskId).trim().toUpperCase() : null;
    const maxBytesRaw = Number(options.maxBytes);
    const maxBytes = Number.isFinite(maxBytesRaw) && maxBytesRaw > 0
        ? Math.min(maxBytesRaw, MAX_READ_BYTES_LIMIT)
        : MAX_READ_BYTES;
    const filePath = getLoopPath(cwd);
    const tail = readTail(filePath, maxBytes);

    if (!tail.trim()) {
        return [];
    }

    const lines = tail
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

    const events = [];
    for (let i = lines.length - 1; i >= 0 && events.length < limit; i -= 1) {
        try {
            const parsed = JSON.parse(lines[i]);
            if (taskId && String(parsed?.taskId ?? "").trim().toUpperCase() !== taskId) {
                continue;
            }
            events.push(parsed);
        } catch {
            continue;
        }
    }

    return events
        .sort((a, b) => stableStringCompare(String(b?.at ?? ""), String(a?.at ?? "")))
        .slice(0, limit);
}

export function formatLoopEventsMarkdown(events = []) {
    if (!events.length) {
        return "- None";
    }

    return events
        .map((event) => {
            const at = event.at || "-";
            const type = event.type || "event";
            const taskId = event.taskId || "-";
            const summaryParts = [];
            if (event.ok === true) summaryParts.push("ok");
            if (event.ok === false) summaryParts.push("fail");
            if (event.exitCode != null) summaryParts.push(`exit ${event.exitCode}`);
            if (event.command) summaryParts.push(`cmd: ${event.command}`);
            if (event.expiresAt) summaryParts.push(`expires: ${event.expiresAt}`);
            const summary = summaryParts.length ? ` (${summaryParts.join(", ")})` : "";
            return `- ${at} ${type} ${taskId}${summary}`;
        })
        .join("\n");
}
