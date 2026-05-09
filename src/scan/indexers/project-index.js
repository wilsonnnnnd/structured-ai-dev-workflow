import fs from "fs";
import path from "path";
import { getRepoRoot } from "../../runtime/root-context.js";
import {
    CONTEXT_AI_PATH,
    CONTEXT_INDEX_DIR,
    CONTEXT_INDEX_ENTRYPOINTS_PATH,
    CONTEXT_INDEX_FILE_GROUPS_PATH,
    CONTEXT_INDEX_FILES_PATH,
    CONTEXT_INDEX_FILE_SUMMARIES_PATH,
    CONTEXT_INDEX_SUMMARY_PATH,
    CONTEXT_INDEX_SYMBOLS_PATH,
    CONTEXT_TASKS_DIR,
    CONTEXT_TASKS_PATH,
    MAX_DESCRIPTION_LENGTH,
    MAX_FILE_GROUPS,
    MAX_INDEX_FILES,
    MAX_INDEX_SYMBOLS,
    MAX_TASKS,
} from "../constants.js";
import {
    ensureDir,
    exists,
    readJson,
    readText,
    resolveFromProject,
    statSafe,
    writeText,
} from "../fs-utils.js";
import { getFastApiEntrypointCandidates } from "../python-utils.js";
import { getMergedTaskMetadata } from "../task-files.js";
import { getLockfileFingerprints, getPackageJsonDigest } from "../package-utils.js";

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py"]);
const SKIPPED_DIRS = new Set([
    ".git",
    ".aidw",
    "node_modules",
    ".changeset",
    ".next",
    "dist",
    "build",
    "coverage",
]);

const AI_INSTRUCTIONS = `# AI Navigation

- Read \`.aidw/project.md\` first.
- Use \`.aidw/index/files.json\` to locate important files.
- Use \`.aidw/index/symbols.json\` to locate functions/classes/components.
- Use \`.aidw/index/entrypoints.json\` to find where execution starts.
- Use \`.aidw/context/tasks.json\` to find task-to-file mappings.
- Preserve structured CLI output.
- Do not reintroduce ai/ support.
- Do not modify unrelated behavior.
`;

function trimDescription(description) {
    if (description.length <= MAX_DESCRIPTION_LENGTH) {
        return description;
    }

    return description.slice(0, MAX_DESCRIPTION_LENGTH - 1).trimEnd() + ".";
}

function toProjectPath(fullPath) {
    return path.relative(getRepoRoot(), fullPath).replaceAll(path.sep, "/");
}

function listFiles(dir = getRepoRoot(), results = []) {
    let entries;

    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return results;
    }

    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRS.has(entry.name)) {
                listFiles(path.join(dir, entry.name), results);
            }
            continue;
        }

        if (entry.isFile()) {
            results.push(toProjectPath(path.join(dir, entry.name)));
        }
    }

    return results;
}

function isConfigFile(filePath) {
    const basename = path.basename(filePath);

    return (
        basename === "package.json" ||
        basename.startsWith("tsconfig") ||
        basename.startsWith("vite.config") ||
        basename.startsWith("next.config") ||
        basename.startsWith("eslint.config") ||
        basename.startsWith("tailwind.config") ||
        basename.startsWith("jest.config") ||
        basename.startsWith("vitest.config") ||
        basename.startsWith("rollup.config") ||
        basename.startsWith("webpack.config") ||
        basename === "pyproject.toml" ||
        basename === "requirements.txt" ||
        basename === "setup.py" ||
        basename === "Pipfile" ||
        basename === "poetry.lock" ||
        basename === ".env.example" ||
        basename === "config.py" ||
        basename === "settings.py" ||
        basename === ".eslintrc" ||
        basename === ".prettierrc"
    );
}

function classifyFile(filePath) {
    if (filePath.startsWith("bin/")) {
        return "entry";
    }

    if (isConfigFile(filePath)) {
        return "config";
    }

    if (filePath.startsWith("src/")) {
        return "source";
    }

    if (filePath.startsWith("app/") && filePath.endsWith(".py")) {
        return "source";
    }

    if (filePath.startsWith("test/") || filePath.startsWith("tests/")) {
        return "test";
    }

    return "other";
}

function typeRank(type) {
    return {
        entry: 0,
        config: 1,
        source: 2,
        test: 3,
        other: 4,
    }[type] ?? 4;
}

function filePriority(filePath) {
    const type = classifyFile(filePath);

    if (type === "entry") {
        return 0;
    }
    if (type === "config") {
        return 1;
    }
    if (filePath === "src/scan/index.js" || filePath === "src/scan/context.js") {
        return 2;
    }
    if (filePath.startsWith("src/")) {
        return 3;
    }
    if (
        filePath.startsWith("api/") ||
        filePath.startsWith("app/") ||
        filePath.startsWith("routes/") ||
        filePath.startsWith("services/") ||
        filePath.startsWith("components/") ||
        filePath.startsWith("src/api/") ||
        filePath.startsWith("src/routes/") ||
        filePath.startsWith("src/services/") ||
        filePath.startsWith("src/components/")
    ) {
        return 4;
    }
    if (type === "test") {
        return 5;
    }

    return 6;
}

function describeFile(filePath, type) {
    if (filePath === "bin/cli.js") {
        return "CLI entry point that parses commands and flags.";
    }

    if (filePath === "bin/init.js") {
        return "Initializes the repo-context-kit project context.";
    }

    if (filePath === "bin/scan.js") {
        return "CLI wrapper for the project scan command.";
    }

    if (filePath === "package.json") {
        return "Package metadata, scripts, and CLI binary configuration.";
    }

    if (filePath === "requirements.txt" || filePath === "pyproject.toml") {
        return "Python project dependencies and packaging configuration.";
    }

    if (filePath.endsWith("main.py") && filePath.includes("app")) {
        return "Likely FastAPI application entrypoint.";
    }

    if (filePath.includes("/routers/") || filePath.includes("/api/")) {
        return "API route and endpoint handling code.";
    }

    if (filePath.includes("/services/")) {
        return "Backend service-layer and business logic code.";
    }

    if (filePath.includes("/schemas/")) {
        return "Request, response, and validation schema definitions.";
    }

    if (filePath.includes("/db/") || filePath.includes("/database/")) {
        return "Database connection and persistence helper code.";
    }

    if (filePath.endsWith("context.js")) {
        return "Validates .aidw project context files.";
    }

    if (filePath.includes("/indexers/")) {
        return "Generates structured AI retrieval indexes.";
    }

    if (filePath.includes("/detectors/")) {
        return "Detects project signals used by scan output.";
    }

    if (filePath.includes("/writers/")) {
        return "Writes generated project context files.";
    }

    if (type === "test") {
        return "Automated test coverage for CLI behavior.";
    }

    if (type === "source") {
        return "Source module used by project scanning.";
    }

    if (type === "config") {
        return "Project configuration file.";
    }

    return "Project file relevant to repository structure.";
}

function getUpdatedAt(filePath) {
    const stat = statSafe(filePath);

    return (stat?.mtime ?? new Date(0)).toISOString();
}

function getLatestUpdatedAt(filePaths) {
    const latest = filePaths.reduce((latestTime, filePath) => {
        const mtime = statSafe(filePath)?.mtime?.getTime() ?? 0;

        return Math.max(latestTime, mtime);
    }, 0);

    return new Date(latest).toISOString();
}

function fileConfidence(type) {
    return {
        entry: 0.9,
        config: 0.85,
        source: 0.8,
        test: 0.75,
        other: 0.55,
    }[type] ?? 0.5;
}

function isImportantFile(filePath) {
    const type = classifyFile(filePath);
    const extension = path.extname(filePath);

    return (
        type !== "other" ||
        filePath === "README.md" ||
        filePath === "AGENTS.md" ||
        SOURCE_EXTENSIONS.has(extension)
    );
}

export function buildFileIndex() {
    return listFiles()
        .filter(isImportantFile)
        .map((filePath) => {
            const type = classifyFile(filePath);

            return {
                path: filePath,
                type,
                description: trimDescription(describeFile(filePath, type)),
                updatedAt: getUpdatedAt(filePath),
                confidence: fileConfidence(type),
                source: "heuristic",
            };
        })
        .sort(
            (a, b) =>
                filePriority(a.path) - filePriority(b.path) ||
                typeRank(a.type) - typeRank(b.type) ||
                a.path.localeCompare(b.path),
        )
        .slice(0, MAX_INDEX_FILES);
}

function isComponentName(name) {
    return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

function describeSymbol(symbol) {
    if (symbol.name === "validateContext") {
        return "Validates .aidw structure and meta.json version.";
    }

    if (symbol.name.startsWith("run")) {
        return "Runs a CLI command workflow.";
    }

    if (symbol.name.startsWith("detect")) {
        return "Detects project structure or package signals.";
    }

    if (symbol.name.startsWith("build")) {
        return "Builds structured scan data.";
    }

    if (symbol.name.startsWith("update")) {
        return "Updates generated project context files.";
    }

    if (symbol.type === "class") {
        return "Defines a reusable class.";
    }

    if (symbol.type === "component") {
        return "Defines a React component.";
    }

    return "Provides project scanning behavior.";
}

function addSymbol(symbols, filePath, fileUpdatedAt, match, type, exported) {
    const name = match?.groups?.name;

    if (!name || symbols.some((symbol) => symbol.name === name && symbol.file === filePath)) {
        return;
    }

    const resolvedType = type === "function" && isComponentName(name) ? "component" : type;

    symbols.push({
        name,
        type: resolvedType,
        file: filePath,
        description: trimDescription(describeSymbol({ name, type: resolvedType })),
        exported,
        updatedAt: fileUpdatedAt,
        confidence: exported ? 0.8 : 0.65,
        source: "regex",
    });
}

function extractSymbolsFromFile(filePath) {
    const fullPath = resolveFromProject(filePath);
    let content;

    try {
        content = fs.readFileSync(fullPath, "utf-8");
    } catch {
        return [];
    }

    const symbols = [];
    const updatedAt = getUpdatedAt(filePath);
    const patterns = [
        {
            regex: /^(?<exported>export\s+)?(?:async\s+)?function\s+(?<name>[A-Za-z_$][\w$]*)\s*\(/gm,
            type: "function",
        },
        {
            regex: /^(?<exported>export\s+)?class\s+(?<name>[A-Za-z_$][\w$]*)\b/gm,
            type: "class",
        },
        {
            regex: /^(?<exported>export\s+)?const\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/gm,
            type: "function",
        },
        {
            regex: /^(?<exported>export\s+)?const\s+(?<name>[A-Z][A-Za-z0-9]*)\s*=\s*(?:React\.)?(?:memo|forwardRef)\b/gm,
            type: "component",
        },
    ];

    for (const pattern of patterns) {
        for (const match of content.matchAll(pattern.regex)) {
            addSymbol(
                symbols,
                filePath,
                updatedAt,
                match,
                pattern.type,
                Boolean(match.groups?.exported),
            );
        }
    }

    return symbols;
}

export function buildSymbolIndex() {
    return listFiles()
        .filter((filePath) => {
            const extension = path.extname(filePath);

            return (
                SOURCE_EXTENSIONS.has(extension) &&
                (filePath.startsWith("src/") || filePath.startsWith("bin/"))
            );
        })
        .sort()
        .flatMap(extractSymbolsFromFile)
        .sort((a, b) => {
            if (a.exported !== b.exported) {
                return a.exported ? -1 : 1;
            }

            return `${a.file}:${a.name}`.localeCompare(`${b.file}:${b.name}`);
        })
        .slice(0, MAX_INDEX_SYMBOLS);
}

function readFileContentSafe(filePath, maxBytes = 120_000) {
    const fullPath = resolveFromProject(filePath);
    let content = "";
    try {
        content = fs.readFileSync(fullPath, "utf-8");
    } catch {
        return "";
    }

    if (content.length > maxBytes) {
        return content.slice(0, maxBytes);
    }

    return content;
}

function extractImports(content) {
    const imports = new Set();
    const patterns = [
        /import\s+[^;]*?\s+from\s+["'](?<name>[^"']+)["']/g,
        /import\s+["'](?<name>[^"']+)["']/g,
        /require\(\s*["'](?<name>[^"']+)["']\s*\)/g,
    ];

    for (const regex of patterns) {
        for (const match of content.matchAll(regex)) {
            const name = match?.groups?.name;
            if (name) {
                imports.add(name);
            }
            if (imports.size >= 30) {
                return [...imports];
            }
        }
    }

    return [...imports];
}

function detectCalls(content) {
    const calls = [];
    const detectors = [
        ["child_process.spawn", /\bspawn\s*\(/],
        ["child_process.exec", /\bexec\s*\(/],
        ["child_process.execFile", /\bexecFile\s*\(/],
        ["fs.writeFileSync", /\bwriteFileSync\s*\(/],
        ["fs.writeFile", /\bwriteFile\s*\(/],
        ["fs.rmSync", /\brmSync\s*\(/],
        ["fs.rmdirSync", /\brmdirSync\s*\(/],
        ["fs.unlinkSync", /\bunlinkSync\s*\(/],
        ["fetch", /\bfetch\s*\(/],
        ["http.request", /\bhttp\.(?:request|get)\s*\(/],
        ["https.request", /\bhttps\.(?:request|get)\s*\(/],
        ["process.env", /\bprocess\.env\b/],
    ];

    for (const [label, regex] of detectors) {
        if (regex.test(content)) {
            calls.push(label);
        }
        if (calls.length >= 20) {
            break;
        }
    }

    return calls;
}

function deriveRisks(calls) {
    const risks = new Set();

    for (const call of calls) {
        if (call.startsWith("child_process.")) {
            risks.add("exec");
        }
        if (call.startsWith("fs.")) {
            if (/writeFile|rmSync|rmdirSync|unlinkSync/i.test(call)) {
                risks.add("fs-write");
            }
        }
        if (call === "fetch" || call.startsWith("http.") || call.startsWith("https.")) {
            risks.add("network");
        }
        if (call === "process.env") {
            risks.add("secrets-env");
        }
    }

    return [...risks];
}

function symbolsForFile(symbols, filePath) {
    return symbols.filter((symbol) => symbol.file === filePath);
}

function buildFileSummaries(files = [], symbols = []) {
    return files.map((file) => {
        const content =
            SOURCE_EXTENSIONS.has(path.extname(file.path)) && (file.path.startsWith("src/") || file.path.startsWith("bin/"))
                ? readFileContentSafe(file.path)
                : "";
        const imports = content ? extractImports(content) : [];
        const calls = content ? detectCalls(content) : [];
        const risks = deriveRisks(calls);

        const fileSymbols = symbolsForFile(symbols, file.path);
        const exportedSymbols = fileSymbols
            .filter((symbol) => symbol.exported)
            .slice(0, 20)
            .map((symbol) => ({ name: symbol.name, type: symbol.type }));
        const keySymbols = fileSymbols
            .slice(0, 30)
            .map((symbol) => ({ name: symbol.name, type: symbol.type, exported: Boolean(symbol.exported) }));

        return {
            path: file.path,
            roleSummary: file.description,
            exports: exportedSymbols,
            keySymbols,
            imports,
            calls,
            risks,
            updatedAt: file.updatedAt,
        };
    });
}

function groupPathForFile(filePath) {
    const parts = filePath.split("/");

    if (parts.length === 1) {
        return ".";
    }

    if (parts[0] === "src" && parts.length >= 3) {
        return parts.slice(0, 2).join("/");
    }

    if (parts[0] === "app" && parts.length >= 3) {
        return parts.slice(0, 2).join("/");
    }

    if (["api", "routes", "services", "components", "test", "tests", "bin"].includes(parts[0])) {
        return parts[0];
    }

    return parts[0];
}

function summarizeGroup(groupPath) {
    if (groupPath === "bin") {
        return "CLI entrypoints and command wrappers.";
    }
    if (groupPath === "src/scan") {
        return "Project scanning, context validation, and index generation logic.";
    }
    if (groupPath.startsWith("src/")) {
        return "Source modules for application behavior.";
    }
    if (groupPath === "app") {
        return "Python backend application package.";
    }
    if (groupPath === "app/routers" || groupPath === "app/api") {
        return "FastAPI route modules and endpoint handlers.";
    }
    if (groupPath === "app/services") {
        return "Reusable backend services and business logic.";
    }
    if (groupPath === "app/schemas") {
        return "Request, response, and validation schemas.";
    }
    if (groupPath === "app/models") {
        return "Backend model and persistence definitions.";
    }
    if (groupPath === "app/db") {
        return "Database connection and persistence helpers.";
    }
    if (groupPath === "app/core") {
        return "Backend configuration and core utilities.";
    }
    if (groupPath === "app/ai") {
        return "AI/LLM integration and prompt-related backend code.";
    }
    if (groupPath === "test" || groupPath === "tests") {
        return "Automated tests and regression coverage.";
    }
    if (groupPath.includes("components")) {
        return "Reusable UI components.";
    }
    if (groupPath.includes("api") || groupPath.includes("routes")) {
        return "API and route handling code.";
    }
    if (groupPath.includes("services")) {
        return "Service-layer and business logic modules.";
    }
    if (groupPath === ".") {
        return "Repository root files and package metadata.";
    }

    return "Project files grouped by directory.";
}

function groupPriority(groupPath) {
    if (groupPath === "bin") {
        return 0;
    }
    if (groupPath === ".") {
        return 1;
    }
    if (groupPath === "src" || groupPath.startsWith("src/")) {
        return 2;
    }
    if (
        groupPath.includes("api") ||
        groupPath.startsWith("app/") ||
        groupPath.includes("routes") ||
        groupPath.includes("services") ||
        groupPath.includes("components")
    ) {
        return 3;
    }
    if (groupPath === "test" || groupPath === "tests") {
        return 4;
    }

    return 5;
}

export function buildFileGroupIndex(allFiles = listFiles()) {
    const groups = new Map();

    for (const filePath of allFiles.filter(isImportantFile)) {
        const groupPath = groupPathForFile(filePath);
        const group = groups.get(groupPath) ?? {
            path: groupPath,
            files: [],
        };

        group.files.push(filePath);
        groups.set(groupPath, group);
    }

    return [...groups.values()]
        .map((group) => {
            const keyFiles = group.files
                .sort((a, b) => filePriority(a) - filePriority(b) || a.localeCompare(b))
                .slice(0, 3);

            return {
                path: group.path,
                fileCount: group.files.length,
                summary: trimDescription(summarizeGroup(group.path)),
                keyFiles,
            };
        })
        .filter((group) => group.keyFiles.every((filePath) => exists(filePath)))
        .sort(
            (a, b) =>
                groupPriority(a.path) - groupPriority(b.path) ||
                b.fileCount - a.fileCount ||
                a.path.localeCompare(b.path),
        )
        .slice(0, MAX_FILE_GROUPS);
}

function readPackageJson() {
    return readJson("package.json") ?? {};
}

function normalizeBinEntries(bin) {
    if (!bin) {
        return [];
    }

    if (typeof bin === "string") {
        return [["package", bin]];
    }

    if (typeof bin === "object" && !Array.isArray(bin)) {
        return Object.entries(bin);
    }

    return [];
}

export function buildEntrypointIndex() {
    const packageJson = readPackageJson();
    const byPath = new Map();

    for (const [command, filePath] of normalizeBinEntries(packageJson.bin)) {
        const normalizedPath = String(filePath).replaceAll("\\", "/");

        if (!exists(normalizedPath)) {
            continue;
        }

        byPath.set(normalizedPath, {
            name: "CLI entry",
            path: normalizedPath,
            command,
            description: trimDescription("Parses CLI commands and dispatches init/scan."),
            confidence: 0.9,
            source: "package.json",
        });
    }

    for (const filePath of listFiles().filter((candidate) => candidate.startsWith("bin/"))) {
        if (!SOURCE_EXTENSIONS.has(path.extname(filePath)) || !exists(filePath)) {
            continue;
        }

        if (!byPath.has(filePath)) {
            byPath.set(filePath, {
                name: "CLI entry",
                path: filePath,
                command: path.basename(filePath, path.extname(filePath)),
                description: trimDescription("Likely CLI entry point under bin/."),
                confidence: 0.7,
                source: "heuristic",
            });
        }
    }

    for (const filePath of getFastApiEntrypointCandidates()) {
        if (!byPath.has(filePath)) {
            byPath.set(filePath, {
                name: "FastAPI app",
                path: filePath,
                command: null,
                description: trimDescription("FastAPI application entrypoint."),
                confidence: 0.85,
                source: "heuristic",
            });
        }
    }

    return [...byPath.values()].sort((a, b) => b.confidence - a.confidence || a.path.localeCompare(b.path));
}

function existingFiles(filePaths) {
    return filePaths.filter((filePath) => exists(filePath));
}

export function buildTaskMap() {
    const taskCandidates = [
        {
            task: "change init behavior",
            files: ["bin/init.js", "bin/cli.js", "test/cli.test.js"],
            notes: "Keep structured CLI output and update tests.",
            confidence: 0.8,
            source: "heuristic",
        },
        {
            task: "change scan behavior",
            files: ["src/scan/index.js", "bin/scan.js", "test/cli.test.js"],
            notes: "Preserve scan output format and exit-code behavior.",
            confidence: 0.8,
            source: "heuristic",
        },
        {
            task: "change context validation",
            files: ["src/scan/context.js", "src/scan/constants.js", "test/cli.test.js"],
            notes: "Keep .aidw completeness checks focused on required files.",
            confidence: 0.75,
            source: "heuristic",
        },
        {
            task: "change project index generation",
            files: ["src/scan/indexers/project-index.js", "src/scan/index.js", "test/cli.test.js"],
            notes: "Keep indexes bounded, dependency-free, and based on current filesystem state.",
            confidence: 0.8,
            source: "heuristic",
        },
        {
            task: "update project documentation",
            files: ["README.md", "AGENTS.md", "skill.md"],
            notes: "Keep user-facing paths aligned with .aidw/.",
            confidence: 0.65,
            source: "heuristic",
        },
    ];

    const heuristicTasks = taskCandidates
        .map((candidate) => ({
            ...candidate,
            files: existingFiles(candidate.files),
            notes: trimDescription(candidate.notes),
        }))
        .filter((candidate) => candidate.files.length > 0);
    const fileTasks = getMergedTaskMetadata().map((task) => ({
        task: task.title,
        files: task.file ? [task.file] : [],
        notes: trimDescription("Implementation task file with scoped requirements and acceptance criteria."),
        confidence: 0.9,
        source: "task-file",
        ...task,
    }));

    return [...fileTasks, ...heuristicTasks].slice(0, MAX_TASKS);
}

function writeIfChanged(relativePath, nextContent) {
    const currentContent = exists(relativePath) ? readText(relativePath) : null;

    if (currentContent === nextContent) {
        return false;
    }

    writeText(relativePath, nextContent);
    return true;
}

function writeJsonIfChanged(relativePath, data) {
    return writeIfChanged(relativePath, `${JSON.stringify(data, null, 4)}\n`);
}

export function updateProjectIndex() {
    ensureDir(CONTEXT_INDEX_DIR);
    ensureDir(CONTEXT_TASKS_DIR);

    const allFiles = listFiles().sort();
    const allImportantFiles = allFiles.filter(isImportantFile);
    const files = buildFileIndex();
    const symbols = buildSymbolIndex();
    const fileSummaries = buildFileSummaries(files, symbols);
    const fileGroups = buildFileGroupIndex(allFiles);
    const entrypoints = buildEntrypointIndex();
    const tasks = buildTaskMap();
    const summary = {
        generatedAt: getLatestUpdatedAt(allFiles),
        totalFilesScanned: allFiles.length,
        indexedFiles: files.length,
        indexedSymbols: symbols.length,
        fileGroups: fileGroups.length,
        packageJsonDigest: getPackageJsonDigest(),
        lockfileFingerprints: getLockfileFingerprints(),
        truncated:
            allImportantFiles.length > MAX_INDEX_FILES ||
            symbols.length >= MAX_INDEX_SYMBOLS ||
            fileGroups.length >= MAX_FILE_GROUPS ||
            tasks.length >= MAX_TASKS,
    };

    return {
        aiChanged: writeIfChanged(CONTEXT_AI_PATH, AI_INSTRUCTIONS),
        filesChanged: writeJsonIfChanged(CONTEXT_INDEX_FILES_PATH, files),
        symbolsChanged: writeJsonIfChanged(CONTEXT_INDEX_SYMBOLS_PATH, symbols),
        fileSummariesChanged: writeJsonIfChanged(CONTEXT_INDEX_FILE_SUMMARIES_PATH, fileSummaries),
        fileGroupsChanged: writeJsonIfChanged(CONTEXT_INDEX_FILE_GROUPS_PATH, fileGroups),
        entrypointsChanged: writeJsonIfChanged(
            CONTEXT_INDEX_ENTRYPOINTS_PATH,
            entrypoints,
        ),
        summaryChanged: writeJsonIfChanged(CONTEXT_INDEX_SUMMARY_PATH, summary),
        tasksChanged: writeJsonIfChanged(CONTEXT_TASKS_PATH, tasks),
    };
}
