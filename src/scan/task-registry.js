import fs from "node:fs";
import path from "node:path";
import { TASK_REGISTRY_PATH } from "./constants.js";
import { exists, readText, writeText } from "./fs-utils.js";

const STATUS_ORDER = ["todo", "in_progress", "done", "blocked", "cancelled"];

function normalizeContent(content) {
    return content.replace(/\r\n/g, "\n").trimEnd();
}

function normalizeRegistryFileCell(fileCell) {
    const linkMatch = fileCell.match(/\[[^\]]+\]\(([^)]+)\)/);
    const rawPath = String(linkMatch?.[1] ?? fileCell ?? "").trim();

    if (!rawPath || rawPath === "-") {
        return { file: null, fileRaw: null, fileError: null };
    }

    const normalized = rawPath.replace(/^\.\//, "").replaceAll("\\", "/");
    const withPrefix = normalized.startsWith("task/") ? normalized : `task/${normalized}`;
    const rawSegments = withPrefix.split("/").filter(Boolean);
    if (rawSegments.includes("..")) {
        return {
            file: null,
            fileRaw: rawPath,
            fileError: "Task file path must not contain '..' path traversal segments.",
        };
    }
    const normalizedPosix = path.posix.normalize(withPrefix);

    if (path.isAbsolute(normalized) || path.posix.isAbsolute(normalizedPosix)) {
        return {
            file: null,
            fileRaw: rawPath,
            fileError: "Task file path must be a relative path under task/ (absolute paths are not allowed).",
        };
    }

    if (!normalizedPosix.startsWith("task/")) {
        return {
            file: null,
            fileRaw: rawPath,
            fileError: "Task file path must be located under task/ (path traversal is not allowed).",
        };
    }

    if (normalizedPosix.includes("\0")) {
        return {
            file: null,
            fileRaw: rawPath,
            fileError: "Task file path is invalid.",
        };
    }

    const repoRoot = process.cwd();
    let repoRootReal = "";
    try {
        repoRootReal = fs.realpathSync(repoRoot);
    } catch {
        repoRootReal = path.resolve(repoRoot);
    }

    const absolute = path.resolve(repoRoot, normalizedPosix);
    if (fs.existsSync(absolute)) {
        try {
            const targetReal = fs.realpathSync(absolute);
            const taskRootReal = path.resolve(repoRootReal, "task");
            const normalizedRoot = process.platform === "win32" ? repoRootReal.toLowerCase() : repoRootReal;
            const normalizedTarget = process.platform === "win32" ? targetReal.toLowerCase() : targetReal;
            const normalizedTaskRoot = process.platform === "win32" ? taskRootReal.toLowerCase() : taskRootReal;

            if (
                normalizedTarget !== normalizedRoot &&
                !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)
            ) {
                return {
                    file: null,
                    fileRaw: rawPath,
                    fileError: "Task file resolves outside repoRoot (symlink escape is not allowed).",
                };
            }

            if (
                normalizedTarget !== normalizedTaskRoot &&
                !normalizedTarget.startsWith(`${normalizedTaskRoot}${path.sep}`)
            ) {
                return {
                    file: null,
                    fileRaw: rawPath,
                    fileError: "Task file must resolve under task/ (symlink escape is not allowed).",
                };
            }
        } catch {
            return {
                file: null,
                fileRaw: rawPath,
                fileError: "Task file could not be resolved safely (realpath failed).",
            };
        }
    }

    return { file: normalizedPosix, fileRaw: rawPath, fileError: null };
}

function formatTaskRow(task) {
    const fileName = task.file?.replace(/^task\//, "") ?? "";
    const fileLabel = task.id || fileName.replace(/\.md$/i, "");
    const fileLink = fileName ? `[${fileLabel}](./${fileName})` : "-";

    return `| ${task.id} | ${task.title} | ${task.status || "todo"} | ${task.priority || "medium"} | ${task.owner || "-"} | ${task.dependencies || "-"} | ${fileLink} |`;
}

export function createTaskRegistryContent(tasks = []) {
    const lines = [
        "# Task Registry",
        "",
        "<!-- AUTO-GENERATED: repo-context-kit. Some sections may be updated automatically. -->",
        "",
        "## Status Legend",
        "",
        "- todo: Not started",
        "- in_progress: Currently being worked on",
        "- blocked: Waiting on dependency or decision",
        "- done: Completed and verified",
        "- cancelled: No longer planned",
        "",
        "## Tasks",
        "",
        "| ID | Title | Status | Priority | Owner | Dependencies | File |",
        "|----|------|--------|----------|-------|--------------|------|",
        ...tasks.map(formatTaskRow),
    ];

    return `${lines.join("\n")}\n`;
}

export function ensureTaskRegistry() {
    if (exists(TASK_REGISTRY_PATH)) {
        return false;
    }

    writeText(TASK_REGISTRY_PATH, createTaskRegistryContent());
    return true;
}

export function parseTaskRegistry(cwd = process.cwd()) {
    if (!exists(TASK_REGISTRY_PATH, cwd)) {
        return {
            exists: false,
            tasks: [],
        };
    }

    const lines = readText(TASK_REGISTRY_PATH, cwd).replace(/\r\n/g, "\n").split("\n");
    const tasks = [];
    let inTasks = false;

    for (const line of lines) {
        if (/^##\s+Tasks\s*$/i.test(line.trim())) {
            inTasks = true;
            continue;
        }

        if (inTasks && /^##\s+/.test(line.trim())) {
            break;
        }

        if (!inTasks || !line.trim().startsWith("|")) {
            continue;
        }

        const cells = line
            .trim()
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((cell) => cell.trim());

        if (
            cells.length < 7 ||
            cells[0].toLowerCase() === "id" ||
            cells.every((cell) => /^-+$/.test(cell))
        ) {
            continue;
        }

        if (/^example$/i.test(cells[0])) {
            continue;
        }

        const fileResult = normalizeRegistryFileCell(cells[6]);
        tasks.push({
            id: cells[0],
            title: cells[1],
            status: cells[2],
            priority: cells[3],
            owner: cells[4],
            dependencies: cells[5],
            file: fileResult.file,
            fileRaw: fileResult.fileRaw,
            fileError: fileResult.fileError,
        });
    }

    return {
        exists: true,
        tasks,
    };
}

export function appendTaskToRegistry(task) {
    ensureTaskRegistry();

    const registry = parseTaskRegistry();

    if (registry.tasks.some((entry) => entry.id === task.id)) {
        return false;
    }

    const nextTasks = [
        ...registry.tasks,
        {
            status: "todo",
            priority: "medium",
            owner: "-",
            dependencies: "-",
            ...task,
        },
    ];
    const nextContent = createTaskRegistryContent(nextTasks);

    if (normalizeContent(readText(TASK_REGISTRY_PATH)) === normalizeContent(nextContent)) {
        return false;
    }

    writeText(TASK_REGISTRY_PATH, nextContent);
    return true;
}

export function getRegistryStatusBreakdown(tasks = parseTaskRegistry().tasks) {
    const counts = Object.fromEntries(STATUS_ORDER.map((status) => [status, 0]));

    for (const task of tasks) {
        if (Object.hasOwn(counts, task.status)) {
            counts[task.status] += 1;
        }
    }

    return counts;
}

export function getKnownTaskIds() {
    return parseTaskRegistry().tasks
        .map((task) => task.id?.match(/^T-(\d{3})$/i)?.[1])
        .filter(Boolean)
        .map((value) => Number.parseInt(value, 10));
}

export function resolveTaskFilePath(task, { repoRoot = process.cwd(), requireExists = false } = {}) {
    if (!task || typeof task !== "object") {
        return { ok: false, error: "Invalid task reference.", filePath: null };
    }

    if (task.fileError) {
        return { ok: false, error: String(task.fileError), filePath: null };
    }

    const relative = typeof task.file === "string" ? task.file.trim() : "";
    if (!relative) {
        return { ok: false, error: `Task ${task.id ?? "-"} has no detail file listed.`, filePath: null };
    }

    const repoRootText = String(repoRoot ?? "").trim();
    if (!repoRootText) {
        return { ok: false, error: "repoRoot is required.", filePath: null };
    }

    const absolute = path.resolve(repoRootText, relative);
    if (requireExists && !fs.existsSync(absolute)) {
        return { ok: false, error: `Task detail file is missing: ${relative}.`, filePath: null };
    }

    if (!fs.existsSync(absolute)) {
        return { ok: true, error: null, filePath: absolute };
    }

    let repoRootReal = "";
    let targetReal = "";
    try {
        repoRootReal = fs.realpathSync(repoRootText);
    } catch {
        repoRootReal = path.resolve(repoRootText);
    }

    try {
        targetReal = fs.realpathSync(absolute);
    } catch {
        return { ok: false, error: "Task file could not be resolved safely (realpath failed).", filePath: null };
    }

    const taskRootReal = path.resolve(repoRootReal, "task");
    const normalizedRoot = process.platform === "win32" ? repoRootReal.toLowerCase() : repoRootReal;
    const normalizedTarget = process.platform === "win32" ? targetReal.toLowerCase() : targetReal;
    const normalizedTaskRoot = process.platform === "win32" ? taskRootReal.toLowerCase() : taskRootReal;

    if (
        normalizedTarget !== normalizedRoot &&
        !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)
    ) {
        return { ok: false, error: "Task file resolves outside repoRoot (symlink escape is not allowed).", filePath: null };
    }

    if (
        normalizedTarget !== normalizedTaskRoot &&
        !normalizedTarget.startsWith(`${normalizedTaskRoot}${path.sep}`)
    ) {
        return { ok: false, error: "Task file must resolve under task/ (symlink escape is not allowed).", filePath: null };
    }

    return { ok: true, error: null, filePath: targetReal };
}
