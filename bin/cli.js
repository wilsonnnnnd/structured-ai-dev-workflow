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
    { command: "context brief", description: "Read compact bounded context" },
    { command: "context next-task", description: "Select next runtime task" },
    { command: "context workset <taskId>", description: "Read bounded task workset" },
    { command: "task prompt <taskId>", description: "Render agent prompt view" },
    { command: "task checklist <taskId>", description: "Render verification view" },
    { command: "task pr <taskId>", description: "Render delivery notes view" },
    { command: "gate status|confirm|run-test", description: "Use confirmation-gated runtime actions" },
    { command: "check", description: "Run deterministic runtime preflight checks" },
    { command: "metrics", description: "Print compact runtime metrics JSON" },
];

function formatDefaultCommandSurface() {
    return DEFAULT_COMMAND_SURFACE.map((item) => `  ${item.command.padEnd(24)} ${item.description}`).join("\n");
}

function printHelp() {
    console.log(`Usage:
  rck <command> [options]

Agent runtime:
${formatDefaultCommandSurface()}

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
    const command = args.find((arg) => !arg.startsWith("--")) ?? "init";

    if (args.includes("--help") && command === "task") {
        await runTask(["help"]);
        return;
    }

    if (args.includes("--help") && command === "context") {
        await runContext(["help"]);
        return;
    }

    if (args.includes("--help")) {
        printHelp();
        return;
    }

    if (args.includes("--version")) {
        console.log(getVersion());
        return;
    }

    if (command === "init") {
        await runInit({
            dryRun: args.includes("--dry-run"),
            force: args.includes("--force"),
            updateAgentFiles: args.includes("--update-agent-files"),
        });
        return;
    }

    if (command === "scan") {
        if (args.includes("--plan")) {
            console.error("Unknown scan option: --plan");
            process.exitCode = 1;
            return;
        }
        const scanModes = [
            args.includes("--check") ? "check" : null,
            args.includes("--auto") ? "auto" : null,
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
    console.log("Usage:");
    console.log("  rck init");
    console.log("  rck scan [--check]");
    console.log("  rck context brief");
    console.log("  rck context next-task");
    console.log("  rck context workset <taskId> [--deep]");
    console.log("  rck gate status");
    console.log("  rck gate confirm task <taskId>");
    console.log("  rck gate confirm tests <taskId>");
    console.log("  rck gate run-test <taskId> --token <token>");
    console.log("  rck check --explain");
    console.log("  rck check --strict");
    console.log("  rck check --warn-only");
    console.log("  rck task checklist <taskId> [--deep]");
    console.log("  rck task pr <taskId> [--deep]");
    console.log("  rck task prompt <taskId> [--deep]");
    console.log("  rck metrics");
    console.log("  rck --help");
    process.exitCode = 1;
}

if (isDirectRun(import.meta.url)) {
    main().catch((error) => {
        console.error("Unexpected error:", error);
        process.exit(1);
    });
}
