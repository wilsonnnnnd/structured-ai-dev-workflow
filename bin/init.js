#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
    AGENT_FILE_PATHS,
    CONTEXT_DIR,
    CONTEXT_INDEX_DIR,
    CONTEXT_TASKS_DIR,
    HUMAN_PROJECT_BRIEF_PATH,
    MANAGED_CONTEXT_FILE_PATHS,
} from "../src/scan/constants.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const templateDir = path.resolve(__dirname, "../template");
const INIT_OUTPUT_ITEM_LIMIT = 6;

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
                const canUpdateManaged = MANAGED_CONTEXT_FILE_PATHS.has(relativePath);
                const canUpdateAgent = options.updateAgentFiles && AGENT_FILE_PATHS.has(relativePath);

                if (options.force && (canUpdateManaged || canUpdateAgent)) {
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

function getItemLabel(item) {
    return typeof item === "string" ? item : item.label;
}

function getItemNotes(item) {
    return typeof item === "string" ? [] : item.notes;
}

function getSummaryItems(items, options = {}) {
    const ordered = [...items];

    if (options.prioritizeAgentFiles) {
        ordered.sort((left, right) => {
            const leftPriority = AGENT_FILE_PATHS.has(getItemLabel(left)) ? 0 : 1;
            const rightPriority = AGENT_FILE_PATHS.has(getItemLabel(right)) ? 0 : 1;
            return leftPriority - rightPriority;
        });
    }

    return ordered.slice(0, INIT_OUTPUT_ITEM_LIMIT);
}

function printList(title, items, options = {}) {
    if (items.length === 0) {
        return;
    }

    console.log(`${title}: ${items.length}`);

    for (const item of getSummaryItems(items, options)) {
        console.log(`* ${getItemLabel(item)}`);

        for (const note of getItemNotes(item)) {
            console.log(`  ${note}`);
        }
    }

    if (items.length > INIT_OUTPUT_ITEM_LIMIT) {
        console.log(`* ... ${items.length - INIT_OUTPUT_ITEM_LIMIT} more`);
    }
}

function printNext(options = {}) {
    if (options.leadingBlank !== false) {
        console.log("");
    }

    console.log("Next:");
    console.log("* Run rck scan");
}

function getDisplayCreatedItems(results) {
    if (results.createdContextDir) {
        const visible = [
            {
                label: `${CONTEXT_DIR}/`,
                notes: ["(repo-context-kit project context)"],
            },
        ];
        if (results.created.includes(HUMAN_PROJECT_BRIEF_PATH)) {
            visible.unshift(HUMAN_PROJECT_BRIEF_PATH);
        }
        return visible;
    }

    return results.created;
}

function printInitResult(results) {
    console.log("OK Init completed");

    const sections = [
        ["Created", getDisplayCreatedItems(results)],
        ["Updated", results.updated],
        ["Skipped", results.skipped],
    ].filter(([, items]) => items.length > 0);

    sections.forEach(([title, items], index) => {
        if (index > 0) {
            console.log("");
        }

        printList(title, items, { prioritizeAgentFiles: title === "Updated" });
    });

    printNext();
}

export async function runInit(options = {}) {
    const initOptions = {
        dryRun: Boolean(options.dryRun),
        force: Boolean(options.force),
        updateAgentFiles: Boolean(options.updateAgentFiles),
        targetDir: options.targetDir || process.cwd(),
    };
    const contextDirPath = path.resolve(initOptions.targetDir, CONTEXT_DIR);
    const results = {
        created: [],
        createdContextDir: !fs.existsSync(contextDirPath),
        updated: [],
        skipped: [],
    };

    copyDir(templateDir, initOptions.targetDir, initOptions, results);

    if (!initOptions.dryRun) {
        fs.mkdirSync(path.resolve(initOptions.targetDir, CONTEXT_INDEX_DIR), {
            recursive: true,
        });
        fs.mkdirSync(path.resolve(initOptions.targetDir, CONTEXT_TASKS_DIR), {
            recursive: true,
        });
    }

    if (initOptions.dryRun) {
        console.log("OK Init completed");
        console.log("");
        printList("Would create", getDisplayCreatedItems(results));
        console.log("");
        printList("Would update", results.updated, { prioritizeAgentFiles: true });
        console.log("");
        printList("Would skip", results.skipped);
        printNext();
        return results;
    }

    printInitResult(results);

    return results;
}
