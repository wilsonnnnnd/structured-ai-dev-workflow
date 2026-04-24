#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const templateDir = path.resolve(__dirname, "../template");

function formatRelative(filePath, baseDir) {
    return path.relative(baseDir, filePath).replaceAll(path.sep, "/");
}

function copyDir(src, dest, options, results) {
    if (!options.dryRun && !fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }

    for (const item of fs.readdirSync(src)) {
        const srcPath = path.join(src, item);
        const destPath = path.join(dest, item);
        const stat = fs.statSync(srcPath);

        if (stat.isDirectory()) {
            copyDir(srcPath, destPath, options, results);
        } else {
            const relativePath = formatRelative(destPath, options.targetDir);

            if (fs.existsSync(destPath)) {
                results.skipped.push(relativePath);
            } else {
                results.created.push(relativePath);

                if (options.dryRun) {
                    continue;
                }

                const parentDir = path.dirname(destPath);
                if (!fs.existsSync(parentDir)) {
                    fs.mkdirSync(parentDir, { recursive: true });
                }

                fs.copyFileSync(srcPath, destPath);
            }
        }
    }
}

function printList(title, items) {
    console.log(`${title}:`);

    if (items.length === 0) {
        console.log("- none");
        return;
    }

    for (const item of items) {
        console.log(`- ${item}`);
    }
}

export async function runInit(options = {}) {
    const initOptions = {
        dryRun: Boolean(options.dryRun),
        targetDir: options.targetDir || process.cwd(),
    };
    const results = {
        created: [],
        skipped: [],
    };

    console.log("Initializing AI Dev Workflow...");
    copyDir(templateDir, initOptions.targetDir, initOptions, results);

    if (initOptions.dryRun) {
        printList("Would create", results.created);
        printList("Would skip", results.skipped);
        console.log("Run 'ai-dev-workflow scan' to update project context.");
        return results;
    }

    printList("Created", results.created);
    printList("Skipped", results.skipped);
    console.log("Done.");
    console.log("Run 'ai-dev-workflow scan' to update project context.");

    return results;
}
