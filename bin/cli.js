#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runContext } from "./context.js";
import { runGate } from "./gate.js";
import { runInit } from "./init.js";
import { runScan } from "./scan.js";
import { runTask } from "./task.js";
import { runCheck } from "./check.js";
import { runMetrics } from "./metrics.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_COMMAND_SURFACE = [
    { command: "init", description: "Initialize repository runtime files" },
    { command: "scan [--check]", description: "Write or check runtime/v1 JSON and bounded indexes" },
    { command: "check [--strict]", description: "Evaluate deterministic governance/preflight signals" },
    { command: "context brief", description: "Read compact bounded context" },
    { command: "context next-task", description: "Select next runtime task" },
    { command: "context workset <taskId>", description: "Read bounded task workset" },
    { command: "task prompt <taskId>", description: "Render agent prompt view" },
    { command: "task checklist <taskId>", description: "Render verification view" },
    { command: "task pr <taskId>", description: "Render delivery notes view" },
    { command: "gate status|confirm|run-test", description: "Use confirmation-gated runtime actions" },
    { command: "metrics", description: "Print compact runtime metrics JSON" },
];

const DEFAULT_WORKFLOW = [
    "rck init",
    "rck scan",
    "rck check",
    "rck task prompt <taskId>",
    "human implementation",
    "rck task checklist <taskId>",
    "rck task pr <taskId>",
    "rck scan --check",
    "rck check --strict",
];

function formatDefaultCommandSurface() {
    return DEFAULT_COMMAND_SURFACE.map((item) => `  ${item.command.padEnd(32)} ${item.description}`).join("\n");
}

function formatDefaultWorkflow() {
    return DEFAULT_WORKFLOW.map((item, index) => `  ${index + 1}. ${item}`).join("\n");
}

function printHelp() {
    console.log(`Usage:
  rck <command> [options]

Agent runtime:
${formatDefaultCommandSurface()}

Default workflow:
${formatDefaultWorkflow()}

Preflight:
  Local/CI: rck scan --check && rck check --strict
  scan --check verifies generated context freshness.
  check --strict evaluates governance signals without writing files.

Primary interface: rck-mcp
Runtime JSON: .aidw/runtime/*.json

Global options:
  --help                    Show this help message
  --version                 Show package version

MCP:
  rck-mcp [--root <path>] [--enable-write] [--enable-tests] [--enable-external-side-effects]

Runtime:
  JSON is source of truth.
  Markdown is readable view only.`);
}

function printInitHelp() {
    console.log(`Usage:
  rck init [--dry-run] [--force] [--update-agent-files]

Options:
  --dry-run                  Show intended changes without writing files
  --force                    Refresh managed runtime/context files
  --update-agent-files       With --force, refresh managed agent adapter files`);
}

function printScanHelp() {
    console.log(`Usage:
  rck scan [--check]
  rck scan --auto

Options:
  --check                    Verify generated context and runtime JSON freshness
  --auto                     Managed refresh mode for gated/MCP flows; not the default human workflow`);
}

function getVersion() {
    const packagePath = path.resolve(__dirname, "../package.json");
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
    return pkg.version;
}

function normalizeResolvedPath(filePath) {
    return process.platform === "win32" ? filePath.toLowerCase() : filePath;
}

function resolveRealPath(filePath) {
    try {
        return fs.realpathSync.native(filePath);
    } catch {
        return path.resolve(filePath);
    }
}

function isDirectRun(importMetaUrl) {
    if (!process.argv[1]) {
        return false;
    }

    const modulePath = resolveRealPath(fileURLToPath(importMetaUrl));
    const invokedPath = resolveRealPath(process.argv[1]);
    return normalizeResolvedPath(modulePath) === normalizeResolvedPath(invokedPath);
}

export async function main(args = process.argv.slice(2)) {
    const explicitCommand = args.find((arg) => !arg.startsWith("--"));
    const command = explicitCommand ?? "init";

    if (args.includes("--help") && !explicitCommand) {
        printHelp();
        return;
    }

    if (args.includes("--version")) {
        console.log(getVersion());
        return;
    }

    if (command === "init") {
        const commandIndex = args.indexOf(command);
        const initArgs = args.slice(commandIndex + 1);
        if (initArgs.includes("--help") || (initArgs.length === 1 && initArgs[0] === "help")) {
            printInitHelp();
            return;
        }
        await runInit({
            dryRun: initArgs.includes("--dry-run"),
            force: initArgs.includes("--force"),
            updateAgentFiles: initArgs.includes("--update-agent-files"),
        });
        return;
    }

    if (command === "scan") {
        const commandIndex = args.indexOf(command);
        const scanArgs = args.slice(commandIndex + 1);
        if (scanArgs.includes("--help") || (scanArgs.length === 1 && scanArgs[0] === "help")) {
            printScanHelp();
            return;
        }
        if (scanArgs.includes("--plan")) {
            console.error("Unknown scan option: --plan");
            process.exitCode = 1;
            return;
        }
        const scanModes = [
            scanArgs.includes("--check") ? "check" : null,
            scanArgs.includes("--auto") ? "auto" : null,
        ].filter(Boolean);

        if (scanModes.length > 1) {
            console.error("Only one scan mode can be used at a time.");
            process.exit(1);
        }

        await runScan({ mode: scanModes[0] || "normal" });
        return;
    }

    if (command === "task") {
        const commandIndex = args.indexOf(command);
        const taskArgs = args.slice(commandIndex + 1);
        await runTask(taskArgs);
        return;
    }

    if (command === "context") {
        const commandIndex = args.indexOf(command);
        const contextArgs = args.slice(commandIndex + 1);
        await runContext(contextArgs);
        return;
    }

    if (command === "check") {
        const commandIndex = args.indexOf(command);
        await runCheck(args.slice(commandIndex + 1));
        return;
    }

    if (command === "gate") {
        const commandIndex = args.indexOf(command);
        await runGate(args.slice(commandIndex + 1));
        return;
    }

    if (command === "metrics") {
        const commandIndex = args.indexOf(command);
        await runMetrics(args.slice(commandIndex + 1));
        return;
    }

    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exitCode = 1;
}

if (isDirectRun(import.meta.url)) {
    main().catch((error) => {
        console.error("Unexpected error:", error);
        process.exit(1);
    });
}
