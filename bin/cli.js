#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
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
  repo-context-kit <command> [options]

Agent runtime:
${formatDefaultCommandSurface()}

Primary interface: repo-context-kit-mcp
Runtime JSON: .aidw/runtime/*.json

Global options:
  --help                    Show this help message
  --version                 Show package version

MCP:
  repo-context-kit-mcp [--root <path>] [--enable-write] [--enable-tests] [--enable-external-side-effects]

Runtime:
  JSON is source of truth.
  Markdown is readable view only.`);
}

function getVersion() {
    const packagePath = path.resolve(__dirname, "../package.json");
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
    return pkg.version;
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
    console.log("  repo-context-kit init");
    console.log("  repo-context-kit scan [--check]");
    console.log("  repo-context-kit context brief");
    console.log("  repo-context-kit context next-task");
    console.log("  repo-context-kit context workset <taskId> [--deep]");
    console.log("  repo-context-kit gate status");
    console.log("  repo-context-kit gate confirm task <taskId>");
    console.log("  repo-context-kit gate confirm tests <taskId>");
    console.log("  repo-context-kit gate run-test <taskId> --token <token>");
    console.log("  repo-context-kit check --explain");
    console.log("  repo-context-kit check --strict");
    console.log("  repo-context-kit check --warn-only");
    console.log("  repo-context-kit task checklist <taskId> [--deep]");
    console.log("  repo-context-kit task pr <taskId> [--deep]");
    console.log("  repo-context-kit task prompt <taskId> [--deep]");
    console.log("  repo-context-kit metrics");
    console.log("  repo-context-kit --help");
    process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch((error) => {
        console.error("Unexpected error:", error);
        process.exit(1);
    });
}
