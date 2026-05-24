#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStdioJsonRpcTransport } from "../src/mcp/stdio.js";
import { createMcpServer } from "../src/mcp/server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

function getFlag(args, name) {
    return args.includes(name);
}

function getArgValue(args, name) {
    const index = args.indexOf(name);
    if (index === -1) {
        return null;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
        return null;
    }
    return value;
}

export async function main(args = process.argv.slice(2)) {
    const rootDir = getArgValue(args, "--root") || process.cwd();
    const enableWrite = getFlag(args, "--enable-write");
    const enableTests = getFlag(args, "--enable-tests");
    const enableExternalSideEffects = getFlag(args, "--enable-external-side-effects");

    const transport = createStdioJsonRpcTransport();
    const server = createMcpServer({
        rootDir,
        enableWrite,
        enableTests,
        enableExternalSideEffects,
        version: getVersion(),
    });

    transport.start(async (message) => {
        const response = await server.handle(message);
        if (response) {
            transport.send(response);
        }
    });
}

if (isDirectRun(import.meta.url)) {
    main().catch((error) => {
        console.error("Unexpected error:", error);
        process.exit(1);
    });
}
