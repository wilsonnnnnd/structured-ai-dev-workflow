#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import path from "node:path";

export function main() {
    console.error("repo-context-kit-mcp has moved to rck-mcp.");
    console.error("Use: rck-mcp [--root <path>] [--enable-write] [--enable-tests] [--enable-external-side-effects]");
    process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main();
}
