#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
    CONTEXT_DIR,
    MANAGED_CONTEXT_FILE_PATHS,
} from "../src/scan/constants.js";

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
                if (options.force && MANAGED_CONTEXT_FILE_PATHS.has(relativePath)) {
                    results.updated.push(relativePath);

                    if (!options.dryRun) {
                        fs.copyFileSync(srcPath, destPath);
                    }

                    continue;
                }

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
        console.log("* none");
        return;
    }

    for (const item of items) {
        console.log(`* ${item}`);
    }
}

function printNext(options = {}) {
    if (options.leadingBlank !== false) {
        console.log("");
    }

    console.log("Next:");
    console.log("* Run ai-dev-workflow scan");
}

function printSimpleCompletedInit() {
    console.log("\u2714 Init completed");
    console.log(`Created: ${CONTEXT_DIR}/`);
    console.log("(ai-dev-workflow project context)");
    printNext({ leadingBlank: false });
}

function printForceCompletedInit() {
    console.log("\u2714 Init completed");
    console.log(`Updated: ${CONTEXT_DIR}/`);
    console.log("(ai-dev-workflow project context)");
    printNext();
}

export async function runInit(options = {}) {
    const initOptions = {
        dryRun: Boolean(options.dryRun),
        force: Boolean(options.force),
        targetDir: options.targetDir || process.cwd(),
    };
    const results = {
        created: [],
        updated: [],
        skipped: [],
    };

    copyDir(templateDir, initOptions.targetDir, initOptions, results);

    if (initOptions.dryRun) {
        console.log("\u2714 Init completed");
        console.log("");
        printList("Would create", results.created);
        console.log("");
        printList("Would update", results.updated);
        console.log("");
        printList("Would skip", results.skipped);
        printNext();
        return results;
    }

    if (initOptions.force) {
        printForceCompletedInit();
    } else if (results.skipped.length === 0) {
        printSimpleCompletedInit();
    } else {
        console.log("\u2714 Init completed");
        console.log("");
        printList("Created", results.created);
        console.log("");
        printList("Skipped", results.skipped);
        printNext();
    }

    return results;
}
