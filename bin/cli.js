#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runInit } from "./init.js";
import { runScan } from "./scan.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function printHelp() {
    console.log(`Usage:
  ai-dev-workflow [command] [options]

Commands:
  init        Copy workflow template into the current repository
  scan        Update ai/project.md project context

Init options:
  --dry-run   Show what init would create or skip without writing files

Scan options:
  --check     Check whether scan output is up to date without writing files
  --auto      Update project context without prompts or extra guidance

Global options:
  --help      Show this help message
  --version   Show package version`);
}

function getVersion() {
    const packagePath = path.resolve(__dirname, "../package.json");
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf-8"));

    return pkg.version;
}

async function main() {
    const args = process.argv.slice(2);
    const command = args.find((arg) => !arg.startsWith("--")) ?? "init";

    if (args.includes("--help")) {
        printHelp();
        return;
    }

    if (args.includes("--version")) {
        console.log(getVersion());
        return;
    }

    if (command === "init") {
        await runInit({ dryRun: args.includes("--dry-run") });
        return;
    }

    if (command === "scan") {
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

    console.error(`Unknown command: ${command}`);
    console.log("Usage:");
    console.log("  ai-dev-workflow init");
    console.log("  ai-dev-workflow scan");
    process.exit(1);
}

main().catch((error) => {
    console.error("Unexpected error:", error);
    process.exit(1);
});
