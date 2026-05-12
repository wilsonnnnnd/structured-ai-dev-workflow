import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main as runCliMain } from "../bin/cli.js";
import { runInit } from "../bin/init.js";
import { runScan } from "../bin/scan.js";
import { createMcpServer } from "../src/mcp/server.js";
import { MCP_CAPABILITY_TIERS, buildMcpCapabilityPolicy } from "../src/mcp/tools.js";

const originalCwd = process.cwd();

function rmTempDirTolerant(tempDir) {
    try {
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    } catch (error) {
        if (process.platform !== "win32" || !["ENOENT", "EPERM", "EBUSY", "ENOTEMPTY"].includes(error?.code)) {
            throw error;
        }
    }
}

async function withTempProject(callback) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-context-kit-"));
    try {
        process.chdir(tempDir);
        return await callback(tempDir);
    } finally {
        process.chdir(originalCwd);
        rmTempDirTolerant(tempDir);
    }
}

function writeFile(relativePath, content = "") {
    const fullPath = path.resolve(process.cwd(), relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf-8");
}

async function withCapturedConsole(callback) {
    const log = console.log;
    const error = console.error;
    const output = [];
    try {
        console.log = (...args) => output.push(args.join(" "));
        console.error = (...args) => output.push(args.join(" "));
        const result = await callback();
        return { output, result };
    } finally {
        console.log = log;
        console.error = error;
    }
}

async function withMutedConsole(callback) {
    const { result } = await withCapturedConsole(callback);
    return result;
}

function minimalRegistry() {
    return `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Core Runtime | todo | high | ai | - | [T-001](./T-001-core-runtime.md) |
`;
}

function minimalTask() {
    return `# T-001 Core Runtime

## Goal

Keep the runtime surface compact.

## Scope

- bin/cli.js
- src/mcp/tools.js

## Acceptance Criteria

- Removed commands fail as unknown.
- Runtime JSON remains available.

## Test Command

\`\`\`bash
npm test
\`\`\`
`;
}

async function withMcpServer(options, callback) {
    const args = options.args || [];
    const getFlag = (name) => args.includes(name);
    const getArgValue = (name) => {
        const index = args.indexOf(name);
        const value = index >= 0 ? args[index + 1] : null;
        return value && !value.startsWith("--") ? value : null;
    };
    const server = createMcpServer({
        rootDir: getArgValue("--root") || process.cwd(),
        enableWrite: getFlag("--enable-write"),
        enableTests: getFlag("--enable-tests"),
        enableExternalSideEffects: getFlag("--enable-external-side-effects"),
        runCli: async ({ rootDir, args: cliArgs }) => {
            const previousCwd = process.cwd();
            const previousExitCode = process.exitCode;
            try {
                process.chdir(rootDir);
                process.exitCode = 0;
                const { output } = await withCapturedConsole(() => runCliMain(cliArgs));
                return {
                    code: process.exitCode || 0,
                    stdout: output.length ? `${output.join("\n")}\n` : "",
                    stderr: "",
                };
            } finally {
                process.chdir(previousCwd);
                process.exitCode = previousExitCode;
            }
        },
        version: JSON.parse(fs.readFileSync(path.resolve(originalCwd, "package.json"), "utf-8")).version,
    });
    let nextId = 1;

    async function request(method, params) {
        return await server.handle({ jsonrpc: "2.0", id: nextId++, method, params });
    }

    return await callback({ request });
}

test("default help exposes only the slim agent runtime surface", async () => {
    const { output } = await withCapturedConsole(() => runCliMain(["--help"]));
    const text = output.join("\n");

    assert.match(text, /\binit\b/);
    assert.match(text, /scan \[--check\]/);
    assert.match(text, /context next-task/);
    assert.match(text, /task prompt <taskId>/);
    assert.match(text, /gate status\|confirm\|run-test/);
    assert.match(text, /repo-context-kit-mcp/);
    assert.doesNotMatch(text, /\b(auto|bootstrap|hygiene|ui)\b|github auth|runtime snapshot|task new|context for\b|context next\b(?!-task)/);
});

test("removed public commands fail clearly as unknown", async () => {
    for (const args of [
        ["auto"],
        ["ui"],
        ["status"],
        ["bootstrap", "doctor"],
        ["hygiene", "scan"],
        ["github", "auth", "status"],
        ["runtime", "snapshot", "list"],
        ["execute", "status"],
        ["loop", "report"],
        ["learn", "ingest"],
        ["budget", "show"],
        ["decision", "explain"],
    ]) {
        process.exitCode = 0;
        const { output } = await withCapturedConsole(() => runCliMain(args));
        assert.equal(process.exitCode, 1, args.join(" "));
        assert.match(output.join("\n"), /Unknown command:/);
    }
    process.exitCode = 0;
});

test("removed aliases and task helpers fail as unknown", async () => {
    await withTempProject(async () => {
        await withMutedConsole(() => runInit());

        for (const args of [
            ["context", "next"],
            ["context", "for", "T-001"],
            ["context", "doctor"],
            ["context", "trace", "T-001"],
            ["context", "budget"],
            ["task", "new", "Example"],
            ["task", "from-doc", "docs/spec.md"],
            ["task", "generate"],
            ["task", "cleanup", "T-001"],
            ["task", "run"],
        ]) {
            process.exitCode = 0;
            const { output } = await withCapturedConsole(() => runCliMain(args));
            assert.equal(process.exitCode, 1, args.join(" "));
            assert.match(output.join("\n"), /Unknown/);
        }
        process.exitCode = 0;
    });
});

test("scan writes runtime/v1 JSON and core context/task commands remain usable", async () => {
    await withTempProject(async () => {
        await withMutedConsole(() => runInit());
        writeFile("package.json", JSON.stringify({ name: "slim-core", version: "0.0.0", type: "module" }, null, 4) + "\n");
        writeFile("src/index.js", "export const answer = 42;\n");
        writeFile("task/task.md", minimalRegistry());
        writeFile("task/T-001-core-runtime.md", minimalTask());

        await withMutedConsole(() => runScan());

        for (const runtimeFile of ["task.json", "context.json", "execution.json", "verification.json"]) {
            const payload = JSON.parse(fs.readFileSync(path.resolve(".aidw/runtime", runtimeFile), "utf-8"));
            assert.equal(payload.schemaVersion, "runtime/v1");
            assert.equal(typeof payload.generatedAt, "string");
            assert.ok(typeof payload.source === "string" || (payload.source && typeof payload.source === "object"));
        }

        for (const args of [
            ["context", "brief"],
            ["context", "next-task"],
            ["context", "workset", "T-001"],
            ["task", "prompt", "T-001"],
            ["task", "checklist", "T-001"],
            ["task", "pr", "T-001"],
            ["metrics"],
        ]) {
            process.exitCode = 0;
            const { output } = await withCapturedConsole(() => runCliMain(args));
            assert.equal(process.exitCode, 0, args.join(" "));
            assert.ok(output.join("\n").trim().length > 0, args.join(" "));
        }
    });
});

test("scan --plan is no longer a public CLI mode", async () => {
    await withTempProject(async () => {
        await withMutedConsole(() => runInit());
        process.exitCode = 0;
        const { output } = await withCapturedConsole(() => runCliMain(["scan", "--plan"]));
        assert.equal(process.exitCode, 1);
        assert.match(output.join("\n"), /Unknown scan option: --plan/);
        process.exitCode = 0;
    });
});

test("MCP exposes only core runtime/index/context/task/gate tools", async () => {
    await withTempProject(async (tempDir) => {
        await withMutedConsole(() => runInit());
        writeFile("package.json", JSON.stringify({ name: "mcp-slim", version: "0.0.0", type: "module" }, null, 4) + "\n");
        writeFile("src/widget.js", "export function widget() { return true; }\n");
        writeFile("task/task.md", minimalRegistry());
        writeFile("task/T-001-core-runtime.md", minimalTask());
        await withMutedConsole(() => runScan());

        await withMcpServer({ args: ["--root", tempDir] }, async ({ request }) => {
            await request("initialize", {});
            const list = await request("tools/list", {});
            const names = list.result.tools.map((item) => item.name).sort();

            assert.deepEqual(
                names,
                [
                    "rck.context.brief",
                    "rck.context.nextTask",
                    "rck.context.workset",
                    "rck.file.search",
                    "rck.file.summary",
                    "rck.metrics",
                    "rck.runtime.validate",
                    "rck.scan.check",
                    "rck.symbol.lookup",
                    "rck.task.checklist",
                    "rck.task.pr",
                    "rck.task.prompt",
                ].sort(),
            );
            assert.equal(list.result.tools.every((item) => item.capabilityTier === "read-only"), true);

            const brief = await request("tools/call", { name: "rck.context.brief", arguments: {} });
            assert.equal(Boolean(brief.error), false);
            assert.match(brief.result.content[0].text, /mcp-slim/);

            const search = await request("tools/call", { name: "rck.file.search", arguments: { query: "widget" } });
            assert.match(search.result.content[0].text, /src\/widget\.js/);

            const removed = await request("tools/call", { name: "rck.auto.start", arguments: {} });
            assert.equal(removed.error.code, -32603);
            assert.match(removed.error.message, /Unknown tool: rck\.auto\.start/);
        });
    });
});

test("MCP write/test tiers keep the confirmation-gated core only", async () => {
    await withTempProject(async (tempDir) => {
        await withMutedConsole(() => runInit());
        writeFile("package.json", JSON.stringify({ name: "mcp-gates", version: "0.0.0", type: "module" }, null, 4) + "\n");
        writeFile("task/task.md", minimalRegistry());
        writeFile("task/T-001-core-runtime.md", minimalTask());
        await withMutedConsole(() => runScan());

        await withMcpServer({ args: ["--root", tempDir, "--enable-write", "--enable-tests"] }, async ({ request }) => {
            await request("initialize", {});
            const list = await request("tools/list", {});
            const names = list.result.tools.map((item) => item.name);
            const tiers = new Map(list.result.tools.map((item) => [item.name, item.capabilityTier]));

            assert.ok(names.includes("rck.init"));
            assert.ok(names.includes("rck.scan"));
            assert.ok(names.includes("rck.gate.confirmTask"));
            assert.ok(names.includes("rck.gate.confirmTests"));
            assert.ok(names.includes("rck.gate.runTest"));
            assert.ok(!names.includes("rck.task.new"));
            assert.ok(!names.includes("rck.hygiene.apply"));
            assert.equal(tiers.get("rck.scan"), MCP_CAPABILITY_TIERS.WORKFLOW_WRITE);
            assert.equal(tiers.get("rck.gate.runTest"), MCP_CAPABILITY_TIERS.TEST_EXEC);
        });
    });
});

test("MCP capability policy requires explicit opt-in by tier", () => {
    assert.equal(buildMcpCapabilityPolicy().allows("workflow-write"), false);
    assert.equal(buildMcpCapabilityPolicy({ enableWrite: true }).allows("workflow-write"), true);
    assert.equal(buildMcpCapabilityPolicy({ enableWrite: true }).allows("test-exec"), false);
    assert.equal(buildMcpCapabilityPolicy({ enableWrite: true, enableTests: true }).allows("test-exec"), true);
});

test("README and package manifest reflect the hard slim surface", () => {
    const readme = fs.readFileSync(path.resolve(originalCwd, "README.md"), "utf-8");
    assert.match(readme, /Compact deterministic repository runtime for AI coding agents/);
    assert.match(readme, /repo-context-kit context brief/);
    assert.match(readme, /repo-context-kit-mcp --root <repo>/);
    assert.doesNotMatch(readme, /auto|bootstrap|hygiene|Local UI|task new|github auth|runtime snapshot/);

    const pkg = JSON.parse(fs.readFileSync(path.resolve(originalCwd, "package.json"), "utf-8"));
    assert.equal(pkg.bin["repo-context-kit"], "bin/cli.js");
    assert.equal(pkg.bin["repo-context-kit-mcp"], "bin/mcp.js");
    assert.ok(!pkg.files.includes("site"));
});
