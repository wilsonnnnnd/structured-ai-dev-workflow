import path from "path";
import { TASK_REGISTRY_PATH } from "./constants.js";
import { exists, listDirSafe, readText } from "./fs-utils.js";
import { parseTaskRegistry } from "./task-registry.js";
import { extractMarkdownListItems } from "../docs/doc-extractor.js";

export const TASK_DIR = "task";

function clampText(value, maxLength = 240) {
    const text = String(value ?? "").trim();
    if (text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, Math.max(0, maxLength - 12)).trimEnd()} [truncated]`;
}

function extractSection(content, heading) {
    const escaped = String(heading).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(?:^|\\n)##\\s+${escaped}\\s*\\n(?<body>[\\s\\S]*?)(?=\\n##\\s|$)`, "i");
    const match = String(content ?? "").match(regex);
    return match?.groups?.body?.trim() ?? "";
}

function toUniqueList(items = [], maxItems = 16, maxChars = 220) {
    const values = extractMarkdownListItems(items, { maxItems: maxItems * 2, maxItemChars: maxChars });
    const out = [];
    const seen = new Set();
    for (const item of values) {
        const text = clampText(item, maxChars);
        const key = text.toLowerCase();
        if (!text || seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push(text);
        if (out.length >= maxItems) {
            break;
        }
    }
    return out;
}

function normalizeCommandBlock(raw) {
    const text = String(raw ?? "").trim();
    if (!text) return null;
    const fenced = text
        .replace(/^```[a-zA-Z0-9_-]*\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
    const command = fenced
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" ; ");
    return command ? clampText(command, 320) : null;
}

function buildTaskFacts(content) {
    const goal = clampText(extractSection(content, "Goal"), 900) || null;
    const scope = toUniqueList(extractSection(content, "Scope"), 16, 220);
    const requirements = toUniqueList(extractSection(content, "Requirements"), 16, 220);
    const acceptanceCriteria = toUniqueList(extractSection(content, "Acceptance Criteria"), 16, 220);
    const definitionOfDone = toUniqueList(extractSection(content, "Definition of Done"), 16, 220);
    const hardBoundaries = toUniqueList(extractSection(content, "Hard Boundaries"), 12, 220);
    const confirmationPoints = toUniqueList(extractSection(content, "Confirmation Points"), 12, 220);
    const testCommand = normalizeCommandBlock(extractSection(content, "Test Command"));

    return {
        goal,
        scope,
        requirements,
        acceptanceCriteria,
        definitionOfDone,
        hardBoundaries,
        confirmationPoints,
        testCommand,
    };
}

function readTextSafe(filePath) {
    if (!exists(filePath)) {
        return "";
    }

    try {
        return readText(filePath);
    } catch {
        return "";
    }
}

export function listTaskFiles() {
    return listDirSafe(TASK_DIR)
        .filter((fileName) => path.extname(fileName).toLowerCase() === ".md")
        .map((fileName) => `${TASK_DIR}/${fileName}`)
        .filter((filePath) => filePath !== TASK_REGISTRY_PATH)
        .filter((filePath) => exists(filePath))
        .sort();
}

function extractTaskId(filePath, content) {
    const basenameMatch = path.basename(filePath).match(/^(T-\d{3})\b/i);

    if (basenameMatch) {
        return basenameMatch[1].toUpperCase();
    }

    const headingMatch = content.match(/^#\s+(T-\d{3})\b/im);

    return headingMatch?.[1]?.toUpperCase() ?? null;
}

function extractTaskTitle(content, id, filePath) {
    const headingMatch = content.match(/^#\s+(.+)$/m);
    const heading = headingMatch?.[1]?.trim();

    if (heading) {
        return id ? heading.replace(new RegExp(`^${id}\\s*`, "i"), "").trim() : heading;
    }

    return path
        .basename(filePath, ".md")
        .replace(/^T-\d{3}-/i, "")
        .replaceAll("-", " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function parseTaskFile(filePath) {
    const content = readTextSafe(filePath);
    const id = extractTaskId(filePath, content);
    const title = extractTaskTitle(content, id, filePath);
    const facts = buildTaskFacts(content);

    return {
        path: filePath,
        id,
        title,
        hasAcceptanceCriteria: /^##\s+Acceptance Criteria\b/im.test(content),
        hasTestCommand: /^##\s+Test Command\b/im.test(content),
        hasDefinitionOfDone: /^##\s+Definition of Done\b/im.test(content),
        facts,
    };
}

export function getTaskFileMetadata() {
    return listTaskFiles().map(parseTaskFile);
}

export function getMergedTaskMetadata() {
    const registry = parseTaskRegistry();
    const fileTasks = getTaskFileMetadata();
    const fileTasksByPath = new Map(fileTasks.map((task) => [task.path, task]));
    const registryFiles = new Set(registry.tasks.map((task) => task.file).filter(Boolean));
    const registryTasks = registry.tasks.map((task) => {
        const fileTask = task.file ? fileTasksByPath.get(task.file) : null;

        return {
            ...task,
            path: task.file,
            hasAcceptanceCriteria: Boolean(fileTask?.hasAcceptanceCriteria),
            hasTestCommand: Boolean(fileTask?.hasTestCommand),
            hasDefinitionOfDone: Boolean(fileTask?.hasDefinitionOfDone),
            facts: fileTask?.facts ?? null,
        };
    });

    if (registry.exists) {
        const unregisteredTasks = fileTasks
            .filter((task) => !registryFiles.has(task.path))
            .map((task) => ({
                ...task,
                status: null,
                priority: null,
                owner: null,
                dependencies: null,
                file: task.path,
                facts: task.facts,
            }));

        return [...registryTasks, ...unregisteredTasks];
    }

    return fileTasks.map((task) => ({
        ...task,
        status: null,
        priority: null,
        owner: null,
        dependencies: null,
        file: task.path,
        facts: task.facts,
    }));
}

export function getTaskConsistencyWarnings() {
    const registry = parseTaskRegistry();
    const fileTasks = getTaskFileMetadata();
    const warnings = [];
    const registryIds = new Set(registry.tasks.map((task) => task.id).filter(Boolean));
    const registryFiles = new Set(registry.tasks.map((task) => task.file).filter(Boolean));

    if (!registry.exists && fileTasks.length > 0) {
        warnings.push(`${TASK_REGISTRY_PATH} is missing but task files exist`);
    }

    for (const task of registry.tasks) {
        if (task.file && !exists(task.file)) {
            warnings.push(`${task.id} is listed in ${TASK_REGISTRY_PATH} but ${task.file} is missing`);
            continue;
        }

        const fileTask = task.file ? parseTaskFile(task.file) : null;

        if (fileTask?.id && task.id && fileTask.id !== task.id) {
            warnings.push(`${task.file} has ID ${fileTask.id} but registry lists ${task.id}`);
        }
    }

    for (const task of fileTasks) {
        if (!registryFiles.has(task.path) && !registryIds.has(task.id)) {
            warnings.push(`${task.path} exists but is not listed in ${TASK_REGISTRY_PATH}`);
        }
    }

    return warnings.sort();
}

export function getTaskHealthSummary(tasks = getMergedTaskMetadata()) {
    return {
        count: tasks.length,
        withAcceptanceCriteria: tasks.filter((task) => task.hasAcceptanceCriteria).length,
        withTestCommand: tasks.filter((task) => task.hasTestCommand).length,
        withDefinitionOfDone: tasks.filter((task) => task.hasDefinitionOfDone).length,
    };
}
