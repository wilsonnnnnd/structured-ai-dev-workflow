#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import path from "node:path";

export function main() {
    console.error("repo-context-kit has moved to rck.");
    console.error("Use: rck <command> [options]");
    process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main();
}
