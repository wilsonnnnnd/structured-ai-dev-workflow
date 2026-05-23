import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { parseTaskRegistry, resolveTaskFilePath } from "../scan/task-registry.js";
import { validateGate } from "./state.js";

const FORBIDDEN_META_CHARS = /[&;|><`]/;
const FORBIDDEN_SUBSHELL = /\$\(|\$\{/;
const FORBIDDEN_PATH_CHARS = /[\\/]/;

function extractSection(content, heading) {
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(
        `(?:^|\\n)##\\s+${escapedHeading}\\s*\\n(?<body>[\\s\\S]*?)(?=\\n##\\s|$)`,
        "i",
    );
    const match = content.match(regex);

    return match?.groups?.body?.trim() ?? "";
}

function normalizeCommand(command) {
    return String(command ?? "").trim().replace(/\s+/g, " ");
}

function resolveTaskFile(taskId, cwd = process.cwd()) {
    const registry = parseTaskRegistry(cwd);
    const task = registry.tasks.find((entry) => entry.id?.toLowerCase() === taskId.toLowerCase()) ?? null;

    if (!task) {
        return { error: `Task not found: ${taskId}`, file: null };
    }

    const resolved = resolveTaskFilePath(task, { repoRoot: cwd, requireExists: true });
    if (!resolved.ok) {
        return { error: resolved.error || "Task file is invalid.", file: null };
    }

    if (!resolved.filePath || !existsSync(resolved.filePath)) {
        return { error: `Task file does not exist: ${task.file}`, file: null };
    }

    return { error: null, file: resolved.filePath };
}

function validateStructuredCommand(command, args) {
    const cmdRaw = String(command ?? "").trim();
    if (!cmdRaw) {
        return { ok: false, error: "Empty test command." };
    }

    const normalizedCmd = cmdRaw.replace(/\.(cmd|exe)$/i, "").toLowerCase();
    const normalizedArgs = Array.isArray(args) ? args.map((value) => String(value ?? "").trim()).filter(Boolean) : [];

    if (FORBIDDEN_PATH_CHARS.test(cmdRaw)) {
        return { ok: false, error: `Unsupported test command for safety: "${cmdRaw}". Use a bare command name.` };
    }

    const allowedPackageManagers = new Set(["npm", "pnpm", "yarn"]);
    if (allowedPackageManagers.has(normalizedCmd)) {
        const signature = normalizedArgs.join(" ");
        if (signature !== "test" && signature !== "run test") {
            return {
                ok: false,
                error: `Unsupported test command for safety: "${normalizeCommand([normalizedCmd, ...normalizedArgs].join(" "))}". Allowed: npm test, npm run test, pnpm test, pnpm run test, yarn test, yarn run test, pytest.`,
            };
        }
        return { ok: true, command: normalizedCmd, args: normalizedArgs };
    }

    if (normalizedCmd === "pytest") {
        if (normalizedArgs.length > 0) {
            return {
                ok: false,
                error: `Unsupported test command for safety: "${normalizeCommand([normalizedCmd, ...normalizedArgs].join(" "))}". Allowed: pytest.`,
            };
        }
        return { ok: true, command: "pytest", args: [] };
    }

    return {
        ok: false,
        error: `Unsupported test command for safety: "${normalizeCommand([cmdRaw, ...normalizedArgs].join(" "))}". Allowed: npm test, npm run test, pnpm test, pnpm run test, yarn test, yarn run test, pytest.`,
    };
}

function parseTestCommand(raw) {
    const commandText = normalizeCommand(raw);
    if (!commandText) {
        return { ok: false, error: "Empty test command." };
    }

    if (FORBIDDEN_META_CHARS.test(commandText) || commandText.includes("&&") || FORBIDDEN_SUBSHELL.test(commandText)) {
        return { ok: false, error: "Unsupported test command for safety: shell metacharacters are not allowed." };
    }

    const tokens = commandText.split(" ").filter(Boolean);
    const command = tokens[0] ?? "";
    const args = tokens.slice(1);

    const validated = validateStructuredCommand(command, args);
    if (!validated.ok) {
        return { ok: false, error: validated.error };
    }

    return {
        ok: true,
        display: normalizeCommand([validated.command, ...validated.args].join(" ")),
        executable: validated.command,
        args: validated.args,
    };
}

function getTaskTestCommand(taskId, cwd = process.cwd()) {
    const { error, file } = resolveTaskFile(taskId, cwd);
    if (error) {
        return { error, command: null };
    }

    const content = readFileSync(file, "utf-8");
    const raw = extractSection(content, "Test Command");

    if (!raw) {
        return { error: `Task ${taskId} is missing a "## Test Command" section.`, command: null };
    }

    const fencedMatch = raw.match(/```(?:bash)?\s*\n([\s\S]*?)\n```/i);
    const firstLine = (fencedMatch?.[1] ?? raw.split("\n")[0] ?? "").trim();
    const parsed = parseTestCommand(firstLine);
    if (!parsed.ok) {
        return { error: parsed.error, command: null };
    }

    return { error: null, command: parsed };
}

async function runAllowedCommand(command, cwd = process.cwd()) {
    return new Promise((resolve) => {
        const isWindows = process.platform === "win32";
        const isPackageManager =
            command.executable === "npm" || command.executable === "pnpm" || command.executable === "yarn";
        const spawnCommand = isWindows && isPackageManager ? (process.env.ComSpec || "cmd.exe") : command.executable;
        const spawnArgs = isWindows && isPackageManager
            ? ["/d", "/s", "/c", command.executable, ...command.args]
            : command.args;

        const child = spawn(spawnCommand, spawnArgs, {
            cwd,
            stdio: "inherit",
            shell: false,
            windowsHide: true,
        });

        child.on("close", (code) => resolve(code ?? 1));
        child.on("error", () => resolve(1));
    });
}

export async function runTaskTestThroughGate({ taskId, token, rootDir = process.cwd() }) {
    const gating = validateGate({ taskId, token, requireTestsConfirmed: true }, rootDir);
    if (!gating.ok) {
        return { ok: false, exitCode: 1, error: gating.error, command: null };
    }

    const { error, command } = getTaskTestCommand(taskId, rootDir);
    if (error) {
        return { ok: false, exitCode: 1, error, command: null };
    }

    const exitCode = await runAllowedCommand(command, rootDir);
    return { ok: exitCode === 0, exitCode, error: null, command: command.display };
}
