import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main as runCliMain } from "../bin/cli.js";
import { runContext } from "../bin/context.js";
import { runGate } from "../bin/gate.js";
import { runInit } from "../bin/init.js";
import { runScan } from "../bin/scan.js";
import { runTask } from "../bin/task.js";
import { runGithub } from "../bin/github.js";
import { startUiServer } from "../bin/ui.js";
import { PROJECT_TYPES } from "../src/scan/constants.js";
import { detectProjectType } from "../src/scan/detectors/project-type.js";
import { parseTaskRegistry } from "../src/scan/task-registry.js";
import { computeContextFreshness } from "../src/scan/index.js";
import { collectRuntimeRisks } from "../src/runtime/risks.js";
import { normalizeRuntimeContract } from "../src/runtime/normalize.js";
import { validateRuntimeContract } from "../src/runtime/runtime-schema.js";
import { serializeRuntimeContract } from "../src/runtime/serialize.js";
import { writeRuntimeSnapshot, readRuntimeSnapshot } from "../src/runtime/snapshot.js";
import { loadDesignDoc } from "../src/docs/doc-loader.js";
import { extractPlanningData } from "../src/docs/doc-extractor.js";
import { getRuntimeModeConfig } from "../src/runtime/rdl/modes.js";

const originalCwd = process.cwd();

function writeFile(relativePath, content = "") {
    const fullPath = path.resolve(process.cwd(), relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf-8");
}

function writeContextProject(content) {
    writeFile(".aidw/project.md", content);
    writeFile(".aidw/meta.json", JSON.stringify({ version: 1 }, null, 4) + "\n");
    writeFile(
        ".aidw/scan/last.json",
        JSON.stringify({ status: "not-run" }, null, 4) + "\n",
    );
}

async function assertIncompleteScan(options = {}) {
    process.exitCode = 0;

    const { output, result } = await withCapturedConsole(() => runScan(options));

    assert.equal(process.exitCode, 1);
    assert.equal(result.incomplete, true);
    assert.equal(
        output.join("\n"),
        "ERROR Project context is incomplete\nRun: repo-context-kit scan --auto",
    );

    process.exitCode = 0;
}

async function withTempProject(callback) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-context-kit-"));

    try {
        process.chdir(tempDir);
        return await callback(tempDir);
    } finally {
        process.chdir(originalCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

async function withTempConfigDir(callback) {
    const previous = process.env.REPO_CONTEXT_KIT_CONFIG_DIR;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-context-kit-config-"));
    process.env.REPO_CONTEXT_KIT_CONFIG_DIR = tempDir;
    try {
        return await callback(tempDir);
    } finally {
        if (previous === undefined) {
            delete process.env.REPO_CONTEXT_KIT_CONFIG_DIR;
        } else {
            process.env.REPO_CONTEXT_KIT_CONFIG_DIR = previous;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

async function withMutedConsole(callback) {
    const log = console.log;

    try {
        console.log = () => {};
        return await callback();
    } finally {
        console.log = log;
    }
}

async function withCapturedConsole(callback) {
    const log = console.log;
    const error = console.error;
    const output = [];

    try {
        console.log = (...args) => {
            output.push(args.join(" "));
        };
        console.error = (...args) => {
            output.push(args.join(" "));
        };
        const result = await callback();

        return {
            output,
            result,
        };
    } finally {
        console.log = log;
        console.error = error;
    }
}

function encodeJsonRpc(message) {
    const payload = Buffer.from(JSON.stringify(message), "utf-8");
    const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf-8");
    return Buffer.concat([header, payload]);
}

function createJsonRpcReader() {
    let buffer = Buffer.alloc(0);

    function feed(chunk) {
        buffer = Buffer.concat([buffer, chunk]);
        const messages = [];

        while (true) {
            const headerEnd = buffer.indexOf("\r\n\r\n");
            if (headerEnd === -1) {
                break;
            }

            const headerText = buffer.slice(0, headerEnd).toString("utf-8");
            const match = headerText.match(/Content-Length:\s*(\d+)/i);
            const length = match ? Number.parseInt(match[1], 10) : null;
            if (!Number.isFinite(length) || length < 0) {
                buffer = buffer.slice(headerEnd + 4);
                continue;
            }

            const start = headerEnd + 4;
            const end = start + length;
            if (buffer.length < end) {
                break;
            }

            const payload = buffer.slice(start, end).toString("utf-8");
            buffer = buffer.slice(end);
            messages.push(JSON.parse(payload));
        }

        return messages;
    }

    return { feed };
}

async function withMcpServer(options, callback) {
    const reader = createJsonRpcReader();
    const serverPath = path.resolve(originalCwd, "bin/mcp.js");

    const pending = new Map();
    let nextId = 1;

    const { spawn } = await import("node:child_process");
    const proc = spawn(process.execPath, [serverPath, ...(options.args || [])], {
        cwd: originalCwd,
        stdio: ["pipe", "pipe", "pipe"],
    });

    try {
        proc.stdout.on("data", (chunk) => {
            for (const message of reader.feed(chunk)) {
                if (message && (typeof message.id === "number" || typeof message.id === "string")) {
                    const resolver = pending.get(message.id);
                    if (resolver) {
                        pending.delete(message.id);
                        resolver(message);
                    }
                }
            }
        });

        async function request(method, params) {
            const id = nextId++;
            const message = { jsonrpc: "2.0", id, method, params };
            const responsePromise = new Promise((resolve) => {
                pending.set(id, resolve);
            });
            proc.stdin.write(encodeJsonRpc(message));
            return await responsePromise;
        }

        return await callback({ request });
    } finally {
        proc.stdin.end();
        proc.kill();
        await new Promise((resolve) => {
            const timeout = setTimeout(resolve, 250);
            proc.once("exit", () => {
                clearTimeout(timeout);
                resolve();
            });
        });
    }
}

async function withUiServer(callback) {
    const log = console.log;
    console.log = () => {};

    const { server, url } = await startUiServer({
        port: 0,
        openBrowser: false,
    });

    try {
        return await callback(url);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        console.log = log;
    }
}

test("mcp server exposes read-only tools by default", async () => {
    await withTempProject(async (tempDir) => {
        writeFile(
            "package.json",
            JSON.stringify(
                { name: "mcp-test-project", version: "0.0.0", type: "module" },
                null,
                4,
            ) + "\n",
        );
        writeFile("AGENTS.md", "# Agents\n");
        writeFile(
            "task/task.md",
            `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
`,
        );
        writeFile(".aidw/project.md", "# Project Context\n\n<!-- AUTO-GENERATED START -->\n<!-- AUTO-GENERATED END -->\n");
        writeFile(".aidw/system-overview.md", "# System Overview\n");
        writeFile(".aidw/index/summary.json", JSON.stringify({ generatedAt: "2026-01-01T00:00:00.000Z" }, null, 4) + "\n");
        writeFile(
            ".aidw/index/files.json",
            JSON.stringify(
                [
                    { path: "src/widget.js", type: "source", description: "Widget utilities", confidence: 0.8 },
                ],
                null,
                4,
            ) + "\n",
        );
        writeFile(".aidw/index/symbols.json", "[]\n");
        writeFile(".aidw/index/entrypoints.json", "[]\n");
        writeFile(".aidw/index/file-groups.json", "[]\n");
        writeFile(
            ".aidw/index/file-summaries.json",
            JSON.stringify(
                [
                    {
                        path: "src/widget.js",
                        roleSummary: "Widget utilities",
                        exports: [{ name: "makeWidget", type: "function" }],
                        keySymbols: [{ name: "makeWidget", type: "function", exported: true }],
                        imports: [],
                        calls: [],
                        risks: [],
                        updatedAt: "2026-01-01T00:00:00.000Z",
                    },
                ],
                null,
                4,
            ) + "\n",
        );

        await withMcpServer({ args: ["--root", tempDir] }, async ({ request }) => {
            const init = await request("initialize", {});
            assert.equal(init.result.serverInfo.name, "repo-context-kit");

            const list = await request("tools/list", {});
            const names = list.result.tools.map((t) => t.name);
            assert.ok(names.includes("rck.context.brief"));
            assert.ok(names.includes("rck.auto.plan"));
            assert.ok(names.includes("rck.runtime.plan"));
            assert.ok(names.includes("rck.runtime.inspect"));
            assert.ok(names.includes("rck.runtime.risks"));
            assert.ok(names.includes("rck.runtime.validate"));
            assert.ok(names.includes("rck.runtime.snapshot.list"));
            assert.ok(names.includes("rck.runtime.snapshot.read"));
            assert.ok(names.includes("rck.runtime.snapshot.diff"));
            assert.ok(names.includes("rck.runtime.explain"));
            assert.ok(names.includes("rck.file.summary"));
            assert.ok(names.includes("rck.file.search"));
            assert.ok(names.includes("rck.symbol.lookup"));
            assert.ok(!names.includes("rck.init"));

            const brief = await request("tools/call", {
                name: "rck.context.brief",
                arguments: {},
            });
            assert.equal(Array.isArray(brief.result.content), true);
            assert.equal(brief.result.content[0].type, "text");
            assert.ok(brief.result.content[0].text.includes("mcp-test-project"));

            const search = await request("tools/call", {
                name: "rck.file.search",
                arguments: { query: "widget", limit: 5 },
            });
            assert.equal(Boolean(search.error), false);
            assert.equal(Array.isArray(search.result.content), true);
            assert.match(search.result.content[0].text, /src\/widget\.js/);

            const runtimePlan = await request("tools/call", {
                name: "rck.runtime.plan",
                arguments: { goal: "Explain widget behavior", deep: false },
            });
            assert.equal(Boolean(runtimePlan.error), false);
            const planPayload = JSON.parse(runtimePlan.result.content[0].text);
            assert.equal(planPayload.task.id, "VIRTUAL");
            assert.match(String(planPayload.workset.text), /## File Summary References/);
            assert.equal(Array.isArray(planPayload.risks), true);
            assert.equal(planPayload.risks.some((r) => r && r.id === "runtime-write-enabled"), false);

            const riskOnly = await request("tools/call", {
                name: "rck.runtime.risks",
                arguments: { goal: "Explain widget behavior", deep: false },
            });
            assert.equal(Boolean(riskOnly.error), false);
            const riskPayload = JSON.parse(riskOnly.result.content[0].text);
            assert.equal(Array.isArray(riskPayload.risks), true);
            assert.match(String(riskPayload.summary), /## Runtime Risks/);

            const validated = await request("tools/call", {
                name: "rck.runtime.validate",
                arguments: { contract: planPayload },
            });
            assert.equal(Boolean(validated.error), false);
            const validatePayload = JSON.parse(validated.result.content[0].text);
            assert.equal(validatePayload.valid, true);

            const snapshotsPath = path.resolve(tempDir, ".aidw/runtime/snapshots/snapshots.jsonl");
            fs.mkdirSync(path.dirname(snapshotsPath), { recursive: true });
            const snapshotA = {
                snapshotId: "SN-aaaaaaaaaaaaaaaa",
                runtimeVersion: planPayload.runtimeVersion,
                timestamp: "2026-01-01T00:00:00.000Z",
                mode: "test",
                goal: "Explain widget behavior",
                taskId: planPayload.task.id,
                status: "planned",
                riskCount: Array.isArray(planPayload.risks) ? planPayload.risks.length : 0,
                blockerCount: 0,
                warningCount: 0,
                contract: planPayload,
            };
            const snapshotB = {
                ...snapshotA,
                snapshotId: "SN-bbbbbbbbbbbbbbbb",
                timestamp: "2026-01-01T00:01:00.000Z",
                contract: {
                    ...planPayload,
                    scan: { ...planPayload.scan, status: "stale" },
                    nextActions: ["repo-context-kit scan"],
                },
            };
            fs.appendFileSync(snapshotsPath, `${JSON.stringify(snapshotA)}\n${JSON.stringify(snapshotB)}\n`, "utf-8");

            const listSnaps = await request("tools/call", {
                name: "rck.runtime.snapshot.list",
                arguments: { limit: 10 },
            });
            assert.equal(Boolean(listSnaps.error), false);
            const listPayload = JSON.parse(listSnaps.result.content[0].text);
            assert.equal(Array.isArray(listPayload.snapshots), true);
            assert.equal(listPayload.snapshots[0].snapshotId, "SN-bbbbbbbbbbbbbbbb");

            const readSnap = await request("tools/call", {
                name: "rck.runtime.snapshot.read",
                arguments: { snapshotId: "SN-aaaaaaaaaaaaaaaa" },
            });
            assert.equal(Boolean(readSnap.error), false);
            const readPayload = JSON.parse(readSnap.result.content[0].text);
            assert.equal(readPayload.snapshotId, "SN-aaaaaaaaaaaaaaaa");
            assert.equal(Boolean(readPayload.contract.prompt && String(readPayload.contract.prompt).includes("Task Implementation Prompt")), true);

            const diffSnap = await request("tools/call", {
                name: "rck.runtime.snapshot.diff",
                arguments: { from: "SN-aaaaaaaaaaaaaaaa", to: "SN-bbbbbbbbbbbbbbbb" },
            });
            assert.equal(Boolean(diffSnap.error), false);
            const diffPayload = JSON.parse(diffSnap.result.content[0].text);
            assert.equal(diffPayload.ok, true);
            assert.equal(diffPayload.changes.scanStatus.to, "stale");

            const explainSnap = await request("tools/call", {
                name: "rck.runtime.explain",
                arguments: { snapshotId: "SN-aaaaaaaaaaaaaaaa" },
            });
            assert.equal(Boolean(explainSnap.error), false);
            assert.match(explainSnap.result.content[0].text, /Runtime Snapshot Explain/);
        });
    });
});

test("mcp server requires enable flags for write/test tools and validates token shape", async () => {
    await withTempProject(async (tempDir) => {
        await withMutedConsole(() => runInit());
        writeFile(
            "package.json",
            JSON.stringify({ name: "mcp-write-project", version: "0.0.0", type: "module" }, null, 4) + "\n",
        );
        writeFile("bin/cli.js", "#!/usr/bin/env node\nexport function main() {}\n");
        writeFile("src/app.js", "export const value = 1;\n");
        await withMutedConsole(() => runScan());

        await withMcpServer(
            { args: ["--root", tempDir, "--enable-write", "--enable-tests"] },
            async ({ request }) => {
                await request("initialize", {});

                const list = await request("tools/list", {});
                const names = list.result.tools.map((t) => t.name);
                assert.ok(names.includes("rck.init"));
                assert.ok(names.includes("rck.gate.runTest"));
                assert.ok(names.includes("rck.auto.start"));
                assert.ok(names.includes("rck.runtime.snapshot.list"));
                assert.ok(names.includes("rck.runtime.snapshot.read"));
                assert.ok(names.includes("rck.runtime.snapshot.diff"));
                assert.ok(names.includes("rck.runtime.explain"));

                const runtimePlan = await request("tools/call", {
                    name: "rck.runtime.plan",
                    arguments: { goal: "Plan with write enabled", deep: false },
                });
                assert.equal(Boolean(runtimePlan.error), false);
                const runtimePayload = JSON.parse(runtimePlan.result.content[0].text);
                assert.equal(Array.isArray(runtimePayload.risks), true);
                assert.equal(runtimePayload.risks.some((r) => r && r.id === "runtime-write-enabled"), true);

                const confirmed = await request("tools/call", {
                    name: "rck.gate.confirmTask",
                    arguments: { taskId: "T-000" },
                });
                assert.equal(Boolean(confirmed.error), false);
                const confirmedPayload = JSON.parse(confirmed.result.content[0].text);
                assert.equal(Boolean(confirmedPayload.token), true);

                const runTest = await request("tools/call", {
                    name: "rck.gate.runTest",
                    arguments: { taskId: "T-001", token: "not-a-token", runtimeMode: "STANDARD", evidence: { summaryOfChange: "run tests" } },
                });
                assert.equal(Boolean(runTest.error), true);
                assert.equal(runTest.error.code, -32603);
                assert.ok(String(runTest.error.message).includes("token"));

                const started = await request("tools/call", {
                    name: "rck.auto.start",
                    arguments: {
                        goal: "Start session",
                        deep: false,
                        runtimeMode: "STANDARD",
                        taskId: "T-000",
                        token: confirmedPayload.token,
                        evidence: { summaryOfChange: "start auto session" },
                    },
                });
                assert.equal(Boolean(started.error), false);
                const startPayload = JSON.parse(started.result.content[0].text);
                assert.match(startPayload.executionState.sessionId, /^S-[a-f0-9]{16}$/);

                const inspected = await request("tools/call", {
                    name: "rck.runtime.inspect",
                    arguments: { sessionId: startPayload.executionState.sessionId },
                });
                assert.equal(Boolean(inspected.error), false);
                const inspectPayload = JSON.parse(inspected.result.content[0].text);
                assert.equal(inspectPayload.match.sessionId, startPayload.executionState.sessionId);
                assert.equal(Boolean(inspectPayload.match.prompt), false);
            },
        );
    });
});

test("scan preserves SHC block outside AUTO-GENERATED section", async () => {
    await withTempProject(async () => {
        writeFile(
            "package.json",
            JSON.stringify({ name: "shc-preserve", version: "0.0.0", type: "module" }, null, 4) + "\n",
        );
        writeFile(
            "task/task.md",
            `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
`,
        );
        writeFile(".aidw/meta.json", JSON.stringify({ version: 1 }, null, 4) + "\n");
        writeFile(".aidw/scan/last.json", JSON.stringify({ status: "not-run" }, null, 4) + "\n");
        writeFile(
            ".aidw/project.md",
            `# Project Context

<!-- AUTO-GENERATED START -->
Old content
<!-- AUTO-GENERATED END -->

## Manual Notes

## Stable Human Context (SHC) (v1)

<!-- SHC:v1 START -->
### Project Goal
- KEEP_ME
<!-- SHC:v1 END -->
`,
        );

        await withMutedConsole(() => runScan());
        const updated = fs.readFileSync(path.resolve(process.cwd(), ".aidw/project.md"), "utf-8");
        assert.ok(updated.includes("KEEP_ME"));
        assert.ok(updated.includes("<!-- SHC:v1 START -->"));
        assert.ok(updated.includes("<!-- AUTO-GENERATED START -->"));
    });
});

test("context freshness score is deterministic for the same repo state", async () => {
    await withTempProject(async () => {
        writeFile(
            "package.json",
            JSON.stringify({ name: "freshness-det", version: "0.0.0", type: "module" }, null, 4) + "\n",
        );
        writeFile(
            "task/task.md",
            `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
`,
        );
        writeFile(".aidw/index/summary.json", JSON.stringify({ generatedAt: "2026-01-01T00:00:00.000Z" }, null, 4) + "\n");
        const a = computeContextFreshness({ worksetFiles: ["src/missing.js"] });
        const b = computeContextFreshness({ worksetFiles: ["src/missing.js"] });
        assert.deepEqual(a, b);
    });
});

test("freshness signals map into runtime risks", async () => {
    const risks = collectRuntimeRisks({
        repoRoot: process.cwd(),
        scan: { status: "fresh", plan: [] },
        workset: { mode: "digest", files: [], summary: "", text: "" },
        task: null,
        runtime: {
            mode: "STANDARD",
            modeConfig: getRuntimeModeConfig("STANDARD"),
            shc: { present: true, complete: true, bounded: true, missingSections: [], incompleteSections: [], overLimitSections: [], limits: {} },
            freshness: {
                score: 60,
                signals: [
                    { id: "symbols_drifted", penalty: 15 },
                    { id: "entrypoints_changed", penalty: 20 },
                    { id: "tasks_stale", penalty: 10 },
                    { id: "snapshots_missing", penalty: 10 },
                ],
                suggestedActions: ["Run repo-context-kit scan"],
            },
        },
    });
    const ids = risks.map((r) => r.id);
    assert.ok(ids.includes("runtime-context-stale"));
    assert.ok(ids.includes("runtime-symbol-drift"));
    assert.ok(ids.includes("runtime-entrypoint-drift"));
    assert.ok(ids.includes("runtime-task-stale"));
    assert.ok(ids.includes("runtime-snapshot-missing"));
});

test("mcp governed write rejects missing runtimeMode/token/evidence", async () => {
    await withTempProject(async (tempDir) => {
        await withMutedConsole(() => runInit());
        writeFile(
            "package.json",
            JSON.stringify({ name: "mcp-governance", version: "0.0.0", type: "module" }, null, 4) + "\n",
        );
        await withMutedConsole(() => runScan());
        await withMcpServer({ args: ["--root", tempDir, "--enable-write"] }, async ({ request }) => {
            await request("initialize", {});
            const call = await request("tools/call", {
                name: "rck.scan",
                arguments: { mode: "normal" },
            });
            assert.equal(Boolean(call.error), true);
            assert.ok(String(call.error.message).includes("runtimeMode"));
        });
    });
});

test("REVIEW mode rejects MCP write tools", async () => {
    await withTempProject(async (tempDir) => {
        await withMutedConsole(() => runInit());
        writeFile(
            "package.json",
            JSON.stringify({ name: "mcp-review", version: "0.0.0", type: "module" }, null, 4) + "\n",
        );
        await withMutedConsole(() => runScan());
        await withMcpServer({ args: ["--root", tempDir, "--enable-write"] }, async ({ request }) => {
            await request("initialize", {});
            const confirmed = await request("tools/call", {
                name: "rck.gate.confirmTask",
                arguments: { taskId: "T-000" },
            });
            const token = JSON.parse(confirmed.result.content[0].text).token;
            const call = await request("tools/call", {
                name: "rck.scan",
                arguments: {
                    runtimeMode: "REVIEW",
                    taskId: "T-000",
                    token,
                    evidence: { summaryOfChange: "attempt scan" },
                    mode: "normal",
                },
            });
            assert.equal(Boolean(call.error), true);
            assert.ok(String(call.error.message).includes("REVIEW"));
        });
    });
});

test("SAFE mode blocks MCP writes when freshness is below threshold", async () => {
    await withTempProject(async (tempDir) => {
        await withMutedConsole(() => runInit());
        writeFile(
            "package.json",
            JSON.stringify({ name: "mcp-safe", version: "0.0.0", type: "module" }, null, 4) + "\n",
        );
        await withMutedConsole(() => runScan());
        writeFile(
            "package.json",
            JSON.stringify({ name: "mcp-safe", version: "0.0.1", type: "module" }, null, 4) + "\n",
        );
        await withMcpServer({ args: ["--root", tempDir, "--enable-write"] }, async ({ request }) => {
            await request("initialize", {});
            const confirmed = await request("tools/call", {
                name: "rck.gate.confirmTask",
                arguments: { taskId: "T-000" },
            });
            const token = JSON.parse(confirmed.result.content[0].text).token;
            const call = await request("tools/call", {
                name: "rck.scan",
                arguments: {
                    runtimeMode: "SAFE",
                    taskId: "T-000",
                    token,
                    evidence: { summaryOfChange: "attempt scan in SAFE" },
                    mode: "normal",
                },
            });
            assert.equal(Boolean(call.error), true);
            assert.ok(String(call.error.message).includes("SAFE mode blocks writes"));
        });
    });
});

test("gate confirm tests appends execution evidence", async () => {
    await withTempProject(async () => {
        await withMutedConsole(() => runInit());
        writeFile(
            "package.json",
            JSON.stringify({ name: "gate-ee", version: "0.0.0", type: "module" }, null, 4) + "\n",
        );
        await withMutedConsole(() => runScan());
        await withMutedConsole(() => runGate(["confirm", "task", "T-001", "--json"]));
        await withMutedConsole(() => runGate(["confirm", "tests", "T-001"]));
        const loopPath = path.resolve(process.cwd(), ".aidw/context-loop.jsonl");
        const raw = fs.readFileSync(loopPath, "utf-8");
        assert.ok(raw.includes("\"type\":\"execution_evidence\""));
        assert.ok(raw.includes("\"tool\":\"gate.confirm.tests\""));
    });
});

test("mcp runtime.plan stays isolated across concurrent servers with different roots", async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "repo-context-kit-mcp-A-"));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "repo-context-kit-mcp-B-"));
    function writeInto(root, relativePath, content = "") {
        const fullPath = path.resolve(root, relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, "utf-8");
    }
    try {
        for (const [root, filePath] of [[dirA, "src/alpha.js"], [dirB, "src/bravo.js"]]) {
            writeInto(root, "package.json", JSON.stringify({ name: path.basename(root), version: "0.0.0", type: "module" }, null, 4) + "\n");
            writeInto(root, "AGENTS.md", "# Agents\n");
            writeInto(root, "task/task.md", "# Task Registry\n\n## Tasks\n\n| ID | Title | Status | Priority | Owner | Dependencies | File |\n|----|------|--------|----------|-------|--------------|------|\n");
            writeInto(root, ".aidw/project.md", "# Project Context\n\n<!-- AUTO-GENERATED START -->\n<!-- AUTO-GENERATED END -->\n");
            writeInto(root, ".aidw/system-overview.md", "# System Overview\n");
            writeInto(root, ".aidw/index/summary.json", JSON.stringify({ generatedAt: "2026-01-01T00:00:00.000Z" }, null, 4) + "\n");
            writeInto(root, ".aidw/index/symbols.json", "[]\n");
            writeInto(root, ".aidw/index/entrypoints.json", "[]\n");
            writeInto(root, ".aidw/index/file-groups.json", "[]\n");
            writeInto(root, ".aidw/index/files.json", JSON.stringify([{ path: filePath, type: "source", description: `File ${filePath}`, confidence: 0.8 }], null, 4) + "\n");
            writeInto(root, ".aidw/index/file-summaries.json", JSON.stringify([{ path: filePath, roleSummary: `Role ${filePath}`, exports: [], keySymbols: [], imports: [], calls: [], risks: [], updatedAt: "2026-01-01T00:00:00.000Z" }], null, 4) + "\n");
            writeInto(root, filePath, "export const value = 1;\n");
        }

        await Promise.all([
            withMcpServer({ args: ["--root", dirA] }, async ({ request }) => {
                await request("initialize", {});
                const runtimePlan = await request("tools/call", {
                    name: "rck.runtime.plan",
                    arguments: { goal: "alpha", deep: false },
                });
                const payload = JSON.parse(runtimePlan.result.content[0].text);
                assert.match(payload.workset.text, /src\/alpha\.js/);
                assert.doesNotMatch(payload.workset.text, /src\/bravo\.js/);
            }),
            withMcpServer({ args: ["--root", dirB] }, async ({ request }) => {
                await request("initialize", {});
                const runtimePlan = await request("tools/call", {
                    name: "rck.runtime.plan",
                    arguments: { goal: "bravo", deep: false },
                });
                const payload = JSON.parse(runtimePlan.result.content[0].text);
                assert.match(payload.workset.text, /src\/bravo\.js/);
                assert.doesNotMatch(payload.workset.text, /src\/alpha\.js/);
            }),
        ]);
    } finally {
        fs.rmSync(dirA, { recursive: true, force: true });
        fs.rmSync(dirB, { recursive: true, force: true });
    }
});

test("runtime risk aggregator detects signals with deterministic ordering and schema", () => {
    const now = "2026-01-01T00:10:00.000Z";
    const loop = [
        { at: now, type: "gate_reset" },
        { at: "2026-01-01T00:05:00.000Z", type: "gate_reset" },
        { at: "2026-01-01T00:01:00.000Z", type: "gate_reset" },
    ];
    const lessons = [
        { id: "L-001", severity: "warning", active: true },
    ];
    const risks = collectRuntimeRisks({
        repoRoot: "/repo",
        task: { id: "T-001", title: "Example", testCommand: "npm test", acceptanceCriteria: ["AC"], requirements: [] },
        workset: { mode: "digest", files: [], summary: "", text: "" },
        scan: { status: "missing", plan: [] },
        lessons,
        loop,
        runtime: { writeEnabled: true },
    });

    assert.equal(Array.isArray(risks), true);
    assert.deepEqual(Object.keys(risks[0]), [
        "id",
        "severity",
        "source",
        "category",
        "message",
        "evidence",
        "suggestedAction",
    ]);
    assert.equal(risks[0].severity, "blocker");
    assert.equal(risks.some((r) => r.id === "missing-scan"), true);
    assert.equal(risks.some((r) => r.id === "lessons-warning"), true);
    assert.equal(risks.some((r) => r.id === "repeated-gate-reset"), true);
    assert.equal(risks.some((r) => r.id === "runtime-write-enabled"), true);
});

test("runtime protocol hardening normalizes, validates, serializes, and snapshots deterministically", async () => {
    const normalized = normalizeRuntimeContract({
        runtimeVersion: "1",
        repoRoot: "/repo",
        task: null,
        scan: { status: "fresh", plan: [] },
        workset: { mode: "digest", files: [], summary: "", text: "" },
        prompt: "ok",
        risks: null,
        nextActions: [],
        executionState: null,
        command: "auto",
    });
    assert.equal(Array.isArray(normalized.risks), true);
    assert.equal(normalized.risks.length, 0);
    assert.equal(normalized.command, "auto");

    const validation = validateRuntimeContract(normalized);
    assert.equal(validation.valid, true);
    assert.equal(Array.isArray(validation.warnings), true);
    assert.equal(validation.warnings.some((w) => String(w).includes("deprecated: command")), true);

    const invalid = validateRuntimeContract({
        runtimeVersion: "1",
        repoRoot: "/repo",
        task: null,
        scan: { status: "fresh", plan: [] },
        workset: { mode: "digest", files: [], summary: "", text: "" },
        prompt: undefined,
        risks: [],
        nextActions: [],
        executionState: null,
    });
    assert.equal(invalid.valid, false);
    assert.ok(invalid.errors.some((e) => String(e).includes("undefined")));

    const serializedA = serializeRuntimeContract(normalized);
    const serializedB = serializeRuntimeContract(normalized);
    assert.equal(serializedA, serializedB);
    assert.match(serializedA, /^\{\n\s+"runtimeVersion":\s+"1"/);
    assert.match(serializedA, /\n$/);

    await withTempProject(async (tempDir) => {
        const contract = normalizeRuntimeContract({
            ...normalized,
            repoRoot: tempDir,
            prompt: "x".repeat(20_000),
        });
        const first = writeRuntimeSnapshot(contract, { repoRoot: tempDir, mode: "test" });
        const second = writeRuntimeSnapshot(contract, { repoRoot: tempDir, mode: "test" });
        assert.match(first, /^SN-[a-f0-9]{16}$/);
        assert.match(second, /^SN-[a-f0-9]{16}$/);

        const snapshotsPath = path.resolve(tempDir, ".aidw/runtime/snapshots/snapshots.jsonl");
        assert.ok(fs.existsSync(snapshotsPath));
        const lines = fs.readFileSync(snapshotsPath, "utf-8").trim().split("\n").filter(Boolean);
        assert.ok(lines.length >= 2);

        const readBack = readRuntimeSnapshot(first, { repoRoot: tempDir });
        assert.equal(readBack.snapshotId, first);
        assert.equal(readBack.runtimeVersion, "1");
        assert.ok(String(readBack.contract.prompt).length <= 6000);
    });
});

test("runtime snapshot CLI supports list/read/explain/diff and keeps outputs bounded", async () => {
    await withTempProject(async () => {
        await withMutedConsole(() => runInit());
        writeFile(
            "package.json",
            JSON.stringify({ name: "snapshot-cli-target", version: "1.0.0", type: "module" }, null, 4) + "\n",
        );
        writeFile("bin/cli.js", "#!/usr/bin/env node\nexport function main() {}\n");
        writeFile("src/app.js", "export const value = 1;\n");
        await withMutedConsole(() => runScan());

        process.exitCode = 0;
        const planned = await withCapturedConsole(() =>
            runCliMain(["auto", "--goal", "Snapshot UX", "--dry-run", "--json"]),
        );
        const contract = JSON.parse(planned.output.join("\n"));

        const firstId = writeRuntimeSnapshot(contract, { repoRoot: process.cwd(), mode: "auto.plan" });
        const secondId = writeRuntimeSnapshot(
            {
                ...contract,
                scan: { ...contract.scan, status: "stale" },
                nextActions: ["repo-context-kit scan"],
            },
            { repoRoot: process.cwd(), mode: "auto.plan" },
        );

        process.exitCode = 0;
        const list1 = await withCapturedConsole(() => runCliMain(["runtime", "snapshot", "list"]));
        const listText = list1.output.join("\n");
        assert.match(listText, /Runtime Snapshots/);
        assert.match(listText, new RegExp(secondId));
        assert.doesNotMatch(listText, /Task Implementation Prompt/);

        process.exitCode = 0;
        const read = await withCapturedConsole(() =>
            runCliMain(["runtime", "snapshot", "read", firstId, "--json"]),
        );
        const readPayload = JSON.parse(read.output.join("\n"));
        assert.equal(readPayload.snapshotId, firstId);
        assert.ok(String(readPayload.contract.prompt).length <= 6000);
        assert.ok(String(readPayload.contract.workset.text).length <= 24000);

        process.exitCode = 0;
        const explain = await withCapturedConsole(() =>
            runCliMain(["runtime", "snapshot", "explain", firstId]),
        );
        const explainText = explain.output.join("\n");
        assert.match(explainText, /Runtime Snapshot Explain/);
        assert.match(explainText, /# Runtime Contract/);

        process.exitCode = 0;
        const diff = await withCapturedConsole(() =>
            runCliMain(["runtime", "snapshot", "diff", firstId, secondId, "--json"]),
        );
        const diffPayload = JSON.parse(diff.output.join("\n"));
        assert.equal(diffPayload.ok, true);
        assert.equal(diffPayload.changes.scanStatus.to, "stale");

        process.exitCode = 0;
        const retention = await withCapturedConsole(() =>
            runCliMain(["runtime", "snapshot", "retention", "--json"]),
        );
        const retentionPayload = JSON.parse(retention.output.join("\n"));
        assert.equal(retentionPayload.ok, true);
        assert.equal(Array.isArray(retentionPayload.warnings), true);
    });
    process.exitCode = 0;
});

async function withMockGitHubServer(onRequest, callback) {
    const server = http.createServer(onRequest);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        return await callback({ baseUrl });
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

async function readNdjson(response) {
    const text = await response.text();

    return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}

test("CLI behavior", async (t) => {
    await t.test("detects Next.js projects", async () => {
        await withTempProject(() => {
            writeFile("package.json", JSON.stringify({ name: "next-app" }));
            writeFile("next.config.mjs", "export default {};\n");

            assert.equal(detectProjectType(), PROJECT_TYPES.WEB_APP);
        });
    });

    await t.test("detects Node CLI projects", async () => {
        await withTempProject(() => {
            writeFile(
                "package.json",
                JSON.stringify({
                    name: "cli-app",
                    bin: {
                        "cli-app": "bin/cli.js",
                    },
                }),
            );
            writeFile("bin/cli.js", "#!/usr/bin/env node\n");

            assert.equal(detectProjectType(), PROJECT_TYPES.CLI_TOOL);
        });
    });

    await t.test("does not classify weak backend signals alone as backend", async () => {
        await withTempProject(() => {
            writeFile("package.json", JSON.stringify({ name: "weak-signals" }));
            fs.mkdirSync("services", { recursive: true });
            fs.mkdirSync("config", { recursive: true });

            assert.equal(detectProjectType(), PROJECT_TYPES.GENERIC);
        });
    });

    await t.test("detects Python projects from requirements.txt", async () => {
        await withTempProject(() => {
            writeFile("requirements.txt", "pytest==8.0.0\n");

            assert.equal(detectProjectType(), PROJECT_TYPES.BACKEND_APP);
        });
    });

    await t.test("detects FastAPI projects from dependency or source signals", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile("requirements.txt", "fastapi==0.110.0\nuvicorn==0.27.0\n");
            writeFile("app/main.py", "from fastapi import FastAPI\n\napp = FastAPI()\n");

            const result = await withMutedConsole(() => runScan());
            const projectContext = fs.readFileSync(".aidw/project.md", "utf-8");

            assert.equal(result.project.type, PROJECT_TYPES.BACKEND_APP);
            assert.deepEqual(result.project.entryPoints, ["app/main.py"]);
            assert.match(projectContext, /Python FastAPI backend web project/);
            assert.match(projectContext, /- FastAPI/);
        });

        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile("requirements.txt", "pytest==8.0.0\n");
            writeFile("src/main.py", "from fastapi import FastAPI\n\napp = FastAPI()\n");

            const result = await withMutedConsole(() => runScan());

            assert.equal(result.project.type, PROJECT_TYPES.BACKEND_APP);
            assert.deepEqual(result.project.entryPoints, ["src/main.py"]);
        });
    });

    await t.test("scan detects FastAPI entrypoints, reusable areas, and risk areas", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile("requirements.txt", "fastapi==0.110.0\nuvicorn==0.27.0\n");
            writeFile("app/main.py", "from fastapi import FastAPI\n\napp = FastAPI()\n");
            writeFile("app/routers/users.py", "from fastapi import APIRouter\n");
            writeFile("app/services/user_service.py", "def list_users():\n    return []\n");
            writeFile("app/schemas/user.py", "class UserSchema:\n    pass\n");
            writeFile("app/db/session.py", "DATABASE_URL = 'sqlite:///app.db'\n");
            writeFile("app/auth/jwt.py", "JWT_ALGORITHM = 'HS256'\n");
            writeFile("app/ai/prompts.py", "SYSTEM_PROMPT = 'help'\n");
            writeFile("app/core/settings.py", "API_KEY = ''\n");
            writeFile("tests/test_main.py", "def test_main():\n    assert True\n");

            await withMutedConsole(() => runScan());

            const projectContext = fs.readFileSync(".aidw/project.md", "utf-8");
            const entrypointIndex = JSON.parse(
                fs.readFileSync(".aidw/index/entrypoints.json", "utf-8"),
            );
            const fileGroups = JSON.parse(
                fs.readFileSync(".aidw/index/file-groups.json", "utf-8"),
            );

            assert.ok(
                entrypointIndex.some(
                    (entrypoint) =>
                        entrypoint.path === "app/main.py" &&
                        entrypoint.name === "FastAPI app" &&
                        entrypoint.source === "heuristic",
                ),
            );
            assert.match(projectContext, /app\/routers\/ contains FastAPI route modules/);
            assert.match(projectContext, /app\/services\/ contains reusable business logic/);
            assert.match(projectContext, /app\/schemas\/ contains request, response/);
            assert.match(projectContext, /tests\/ contains Python automated tests/);
            assert.match(projectContext, /auth, JWT, and OAuth code/);
            assert.match(projectContext, /database, migration, and Alembic changes/);
            assert.match(projectContext, /AI\/LLM prompts and client code/);
            assert.match(projectContext, /environment, config, and settings files/);
            assert.ok(fileGroups.some((group) => group.path === "app/routers"));
            assert.ok(fileGroups.some((group) => group.path === "app/services"));
            assert.ok(fileGroups.some((group) => group.path === "app/schemas"));
            assert.ok(fileGroups.some((group) => group.path === "tests"));
        });
    });

    await t.test("init does not overwrite existing files", async () => {
        await withTempProject(async () => {
            writeFile("AGENTS.md", "custom instructions\n");

            const results = await withMutedConsole(() => runInit());

            assert.equal(
                fs.readFileSync("AGENTS.md", "utf-8"),
                "custom instructions\n",
            );
            assert.ok(results.skipped.includes("AGENTS.md"));
            assert.ok(results.created.includes(".aidw/project.md"));
        });
    });

    await t.test("init without force skips existing context files", async () => {
        await withTempProject(async () => {
            writeFile(".aidw/project.md", "custom project context\n");

            const results = await withMutedConsole(() => runInit());

            assert.equal(
                fs.readFileSync(".aidw/project.md", "utf-8"),
                "custom project context\n",
            );
            assert.ok(results.skipped.includes(".aidw/project.md"));
        });
    });

    await t.test("init creates hidden context directory and prints project context", async () => {
        await withTempProject(async () => {
            const { output, result } = await withCapturedConsole(() => runInit());

            assert.ok(fs.existsSync(".aidw"));
            assert.ok(fs.existsSync(".aidw/project.md"));
            assert.ok(fs.existsSync(".aidw/workflow.md"));
            assert.ok(fs.existsSync(".aidw/safety.md"));
            assert.ok(fs.existsSync(".aidw/lessons.json"));
            assert.ok(fs.existsSync("task/task.md"));
            assert.ok(fs.existsSync(".trae/rules/project_rules.md"));
            assert.ok(fs.existsSync(".trae/skills/doc-to-tasks/SKILL.md"));
            assert.equal(fs.existsSync("ai"), false);
            assert.ok(result.created.includes(".aidw/project.md"));
            assert.equal(
                output.join("\n"),
                "OK Init completed\nCreated:\n* .aidw/\n  (repo-context-kit project context)\n\nNext:\n* Run repo-context-kit scan",
            );
        });
    });

    await t.test("init force overwrites managed context files", async () => {
        await withTempProject(async () => {
            writeFile(".aidw/project.md", "custom project context\n");
            writeFile(".aidw/meta.json", "{\"custom\":true}\n");
            writeFile(".aidw/scan/last.json", "{\"custom\":true}\n");

            const { output, result } = await withCapturedConsole(() =>
                runInit({ force: true }),
            );

            assert.notEqual(
                fs.readFileSync(".aidw/project.md", "utf-8"),
                "custom project context\n",
            );
            assert.deepEqual(
                JSON.parse(fs.readFileSync(".aidw/meta.json", "utf-8")),
                {
                    version: 1,
                },
            );
            assert.deepEqual(
                JSON.parse(fs.readFileSync(".aidw/scan/last.json", "utf-8")),
                {
                    status: "not-run",
                },
            );
            assert.ok(result.updated.includes(".aidw/project.md"));
            assert.ok(result.updated.includes(".aidw/meta.json"));
            assert.ok(result.updated.includes(".aidw/scan/last.json"));
            assert.match(output.join("\n"), /Updated:/);
            assert.match(output.join("\n"), /\* \.aidw\/project\.md/);
            assert.match(output.join("\n"), /\* \.aidw\/meta\.json/);
            assert.match(output.join("\n"), /\* \.aidw\/scan\/last\.json/);
        });
    });

    await t.test("init force preserves unknown context files", async () => {
        await withTempProject(async () => {
            writeFile(".aidw/custom-note.md", "keep me\n");

            await withMutedConsole(() => runInit({ force: true }));

            assert.equal(
                fs.readFileSync(".aidw/custom-note.md", "utf-8"),
                "keep me\n",
            );
        });
    });

    await t.test("scan reports not initialized when context directory is missing", async () => {
        await withTempProject(async () => {
            process.exitCode = 0;

            const { output, result } = await withCapturedConsole(() => runScan());

            assert.equal(process.exitCode, 1);
            assert.equal(result.initialized, false);
            assert.equal(
                output.join("\n"),
                "ERROR Project not initialized\nMissing: .aidw/\nRun: repo-context-kit init",
            );

            process.exitCode = 0;
        });
    });

    await t.test("empty context directory is incomplete", async () => {
        await withTempProject(async () => {
            fs.mkdirSync(".aidw", { recursive: true });

            await assertIncompleteScan();
        });
    });

    await t.test("deleted project context file is incomplete", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            fs.unlinkSync(".aidw/project.md");

            await assertIncompleteScan();
        });
    });

    await t.test("invalid meta json is incomplete", async () => {
        await withTempProject(async () => {
            writeContextProject("# Project Context\n");
            writeFile(".aidw/meta.json", "{not-json}\n");

            await assertIncompleteScan({ mode: "check" });
        });
    });

    await t.test("missing meta version is incomplete", async () => {
        await withTempProject(async () => {
            writeContextProject("# Project Context\n");
            writeFile(".aidw/meta.json", "{}\n");

            await assertIncompleteScan({ mode: "auto" });
        });
    });

    await t.test("missing scan last file is incomplete", async () => {
        await withTempProject(async () => {
            writeContextProject("# Project Context\n");
            fs.unlinkSync(".aidw/scan/last.json");

            await assertIncompleteScan();
        });
    });

    await t.test("incomplete context is reported for every scan mode", async () => {
        for (const mode of ["normal", "check", "auto"]) {
            await withTempProject(async () => {
                fs.mkdirSync(".aidw", { recursive: true });

                await assertIncompleteScan({ mode });
            });
        }
    });

    await t.test("scan updates generated section and preserves manual content", async () => {
        await withTempProject(async () => {
            writeContextProject(
                `# Project Context

<!-- AUTO-GENERATED:START -->
old generated content
<!-- AUTO-GENERATED:END -->

## Manual Notes

- keep this note
`,
            );
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));
            writeFile("bin/cli.js", "#!/usr/bin/env node\n");

            const result = await withMutedConsole(() => runScan());
            const updated = fs.readFileSync(".aidw/project.md", "utf-8");

            assert.equal(result.changed, true);
            assert.ok(result.updatedFiles.includes(".aidw/project.md"));
            assert.equal(result.project.type, PROJECT_TYPES.CLI_TOOL);
            assert.deepEqual(result.project.entryPoints, ["bin/cli.js"]);
            assert.match(updated, /## AI Development Notes/);
            assert.doesNotMatch(updated, /old generated content/);
            assert.match(updated, /- keep this note/);
        });
    });

    await t.test("scan check reports stale content without writing", async () => {
        await withTempProject(async () => {
            process.exitCode = 0;
            writeContextProject(
                `# Project Context

<!-- AUTO-GENERATED START -->
old generated content
<!-- AUTO-GENERATED END -->

## Manual Notes

- keep this note
`,
            );
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));
            writeFile("bin/cli.js", "#!/usr/bin/env node\n");

            const before = fs.readFileSync(".aidw/project.md", "utf-8");
            const result = await withMutedConsole(() => runScan({ mode: "check" }));
            const after = fs.readFileSync(".aidw/project.md", "utf-8");

            assert.equal(after, before);
            assert.equal(result.changed, true);
            assert.deepEqual(result.updatedFiles, []);
            assert.equal(process.exitCode, 1);
            assert.ok(fs.existsSync(".aidw/context-loop.jsonl"));
            assert.match(
                fs.readFileSync(".aidw/context-loop.jsonl", "utf-8"),
                /"type":"scan_check_failed"/,
            );
            process.exitCode = 0;
        });
    });

    await t.test("scan check reports missing markers", async () => {
        await withTempProject(async () => {
            process.exitCode = 0;
            writeContextProject("# Project Context\n\nmanual only\n");
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));
            writeFile("bin/cli.js", "#!/usr/bin/env node\n");

            const { output, result } = await withCapturedConsole(() =>
                runScan({ mode: "check" }),
            );

            assert.equal(result.changed, true);
            assert.equal(process.exitCode, 1);
            assert.match(output.join("\n"), /Project context cannot be checked/);
            assert.match(
                output.join("\n"),
                /Reason:\n\* AUTO-GENERATED markers not found in \.aidw\/project\.md/,
            );
            assert.ok(fs.existsSync(".aidw/context-loop.jsonl"));
            assert.match(
                fs.readFileSync(".aidw/context-loop.jsonl", "utf-8"),
                /"type":"scan_check_failed"/,
            );
            process.exitCode = 0;
        });
    });

    await t.test("scan auto updates changed generated content", async () => {
        await withTempProject(async () => {
            writeContextProject(
                `# Project Context

<!-- AUTO-GENERATED START -->
old generated content
<!-- AUTO-GENERATED END -->

## Manual Notes

- keep this note
`,
            );
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));
            writeFile("bin/cli.js", "#!/usr/bin/env node\n");

            const update = await withMutedConsole(() => runScan({ mode: "auto" }));
            const updated = fs.readFileSync(".aidw/project.md", "utf-8");

            assert.equal(update.changed, true);
            assert.match(updated, /## AI Development Notes/);
            assert.match(updated, /- keep this note/);
        });
    });

    await t.test("default scan prints structured output", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));
            writeFile("bin/cli.js", "#!/usr/bin/env node\n");

            const { output, result } = await withCapturedConsole(() => runScan());

            assert.equal(result.changed, true);
            assert.ok(result.updatedFiles.includes(".aidw/project.md"));
            assert.match(output.join("\n"), /Project scan completed/);
            assert.match(output.join("\n"), /Changes:\n\* Updated \.aidw\/project\.md/);
            assert.match(output.join("\n"), /Summary:\n\* Project type: cli-tool/);
            assert.match(output.join("\n"), /\* Entry points: bin\/cli\.js/);
        });
    });

    await t.test("scan --plan previews planned updates without writing files", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile("package.json", JSON.stringify({ name: "scan-target", version: "1.0.0" }));
            writeFile("bin/cli.js", "#!/usr/bin/env node\n");

            await withMutedConsole(() => runScan());
            const beforeProjectMd = fs.statSync(".aidw/project.md").mtimeMs;

            writeFile("package.json", JSON.stringify({ name: "scan-target", version: "2.0.0" }));

            process.exitCode = 0;
            const { output } = await withCapturedConsole(() => runCliMain(["scan", "--plan"]));
            assert.equal(process.exitCode ?? 0, 0);

            const afterProjectMd = fs.statSync(".aidw/project.md").mtimeMs;
            assert.equal(afterProjectMd, beforeProjectMd);

            const text = output.join("\n");
            assert.match(text, /Scan Plan/);
            assert.match(text, /Will update:/);
            assert.match(text, /\.aidw\/project\.md/);
            assert.match(text, /\.aidw\/index\/summary\.json/);
            assert.match(text, /\.aidw\/index\/file-summaries\.json/);
            assert.match(text, /\.aidw\/context\/tasks\.json/);
            assert.match(text, /Reasons:/);
            assert.match(text, /package\.json changed/);
            assert.match(text, /No files were written\./);
        });
    });

    await t.test("bootstrap plan/apply scaffolds runtime files with confirmation gating", async () => {
        await withTempProject(async (tempDir) => {
            writeFile(
                "docs/product.md",
                [
                    "# Example Project",
                    "",
                    "## Goals",
                    "- Build a new project scaffold",
                    "",
                    "## Requirements",
                    "- Use React and Next.js",
                    "",
                    "## Scope",
                    "- Bootstrap runtime scaffold only",
                    "",
                    "## Acceptance Criteria",
                    "- repo-context-kit bootstrap plan produces a bounded plan",
                    "- repo-context-kit bootstrap apply requires explicit confirmation",
                    "",
                ].join("\n"),
            );

            process.exitCode = 0;
            const plannedA = await withCapturedConsole(() =>
                runCliMain(["bootstrap", "plan", "--from-doc", "docs/product.md", "--json"]),
            );
            assert.equal(process.exitCode ?? 0, 0);
            const payloadA = JSON.parse(plannedA.output.join("\n"));
            assert.equal(payloadA.ok, true);
            assert.match(payloadA.digest, /^[a-f0-9]{64}$/);
            assert.match(payloadA.pauseToken, /^[a-f0-9]{32}$/);
            assert.equal(payloadA.plan.writeMode, "create-only");
            assert.equal(Array.isArray(payloadA.plan.ops), true);
            assert.ok(payloadA.plan.ops.some((op) => op && op.path === "README.md" && op.op === "writeFile"));
            assert.ok(payloadA.plan.ops.some((op) => op && op.path === ".aidw/meta.json" && op.op === "copyTemplate"));
            assert.ok(payloadA.plan.ops.some((op) => op && op.op === "snapshot"));
            assert.equal(Array.isArray(payloadA.scaffoldHints), true);
            assert.ok(payloadA.scaffoldHints.some((h) => h && String(h.command).includes("create-next-app")));
            assert.ok(payloadA.plan.ops.every((op) => op && op.op !== "scaffoldHint"));
            assert.equal(Boolean(payloadA.scaffoldMeta && typeof payloadA.scaffoldMeta === "object"), true);
            assert.ok(Array.isArray(payloadA.scaffoldMeta.detectedKeywords));
            assert.ok(payloadA.scaffoldMeta.detectedKeywords.includes("next.js"));
            assert.ok(payloadA.scaffoldMeta.detectedKeywords.includes("react"));
            assert.ok(Array.isArray(payloadA.matchedRecipeIds));
            assert.ok(payloadA.matchedRecipeIds.includes("next-app"));

            const plannedB = await withCapturedConsole(() =>
                runCliMain(["bootstrap", "plan", "--from-doc", "docs/product.md", "--json"]),
            );
            const payloadB = JSON.parse(plannedB.output.join("\n"));
            assert.equal(payloadB.digest, payloadA.digest);
            assert.equal(payloadB.pauseToken, payloadA.pauseToken);

            writeFile("bootstrap-plan.json", JSON.stringify(payloadA, null, 4) + "\n");

            process.exitCode = 0;
            await withCapturedConsole(() =>
                runCliMain([
                    "bootstrap",
                    "apply",
                    "--from-plan",
                    "bootstrap-plan.json",
                    "--confirm",
                    payloadA.pauseToken,
                ]),
            );
            assert.equal(process.exitCode ?? 0, 1);
            assert.equal(fs.existsSync(path.resolve(tempDir, ".aidw")), false);

            process.exitCode = 0;
            const applied = await withCapturedConsole(() =>
                runCliMain([
                    "bootstrap",
                    "apply",
                    "--from-plan",
                    "bootstrap-plan.json",
                    "--confirm",
                    payloadA.pauseToken,
                    "--enable-write",
                    "--json",
                ]),
            );
            assert.equal(process.exitCode ?? 0, 0);
            const applyPayload = JSON.parse(applied.output.join("\n"));
            assert.equal(applyPayload.ok, true);
            assert.match(applyPayload.snapshotId, /^SN-[a-f0-9]{16}$/);
            assert.equal(fs.existsSync(path.resolve(tempDir, ".aidw/meta.json")), true);
            assert.equal(fs.existsSync(path.resolve(tempDir, "README.md")), true);
            assert.equal(fs.existsSync(path.resolve(tempDir, "package.json")), false);
            const snapshot = readRuntimeSnapshot(applyPayload.snapshotId, { repoRoot: tempDir });
            assert.equal(Boolean(snapshot), true);

            const malicious = {
                ...payloadA,
                plan: {
                    ...payloadA.plan,
                    ops: [
                        { ...payloadA.plan.ops[0], path: "../evil" },
                        ...payloadA.plan.ops.slice(1),
                    ],
                },
            };
            writeFile("bootstrap-plan-malicious.json", JSON.stringify(malicious, null, 4) + "\n");
            process.exitCode = 0;
            const rejected = await withCapturedConsole(() =>
                runCliMain([
                    "bootstrap",
                    "apply",
                    "--from-plan",
                    "bootstrap-plan-malicious.json",
                    "--confirm",
                    payloadA.pauseToken,
                    "--enable-write",
                ]),
            );
            assert.equal(process.exitCode ?? 0, 1);
            assert.ok(rejected.output.join("\n").includes("path"));

            const injected = {
                ...payloadA,
                plan: {
                    ...payloadA.plan,
                    ops: [
                        { ...payloadA.plan.ops[0], command: "npx create-next-app@latest" },
                        ...payloadA.plan.ops.slice(1),
                    ],
                },
            };
            writeFile("bootstrap-plan-injected.json", JSON.stringify(injected, null, 4) + "\n");
            process.exitCode = 0;
            const rejectedInjected = await withCapturedConsole(() =>
                runCliMain([
                    "bootstrap",
                    "apply",
                    "--from-plan",
                    "bootstrap-plan-injected.json",
                    "--confirm",
                    payloadA.pauseToken,
                    "--enable-write",
                ]),
            );
            assert.equal(process.exitCode ?? 0, 1);
            assert.ok(rejectedInjected.output.join("\n").includes("bootstrap-command-injection"));
        });
    });

    await t.test("bootstrap scaffold recipes cover vite/react and python/fastapi and unknown stack", async () => {
        await withTempProject(async () => {
            writeFile(
                "docs/vite.md",
                [
                    "# Vite React App",
                    "",
                    "## Goals",
                    "- Build a web app",
                    "",
                    "## Requirements",
                    "- Use Vite and React",
                    "",
                ].join("\n"),
            );
            const vitePlan = await withCapturedConsole(() =>
                runCliMain(["bootstrap", "plan", "--from-doc", "docs/vite.md", "--json"]),
            );
            const vitePayload = JSON.parse(vitePlan.output.join("\n"));
            assert.ok(vitePayload.matchedRecipeIds.includes("vite-react"));
            assert.ok(vitePayload.scaffoldHints.some((h) => h && String(h.command).includes("create-vite")));

            writeFile(
                "docs/fastapi.md",
                [
                    "# FastAPI Service",
                    "",
                    "## Goals",
                    "- Build an API",
                    "",
                    "## Requirements",
                    "- Use Python and FastAPI",
                    "",
                ].join("\n"),
            );
            const fastapiPlan = await withCapturedConsole(() =>
                runCliMain(["bootstrap", "plan", "--from-doc", "docs/fastapi.md", "--json"]),
            );
            const fastapiPayload = JSON.parse(fastapiPlan.output.join("\n"));
            assert.ok(fastapiPayload.matchedRecipeIds.includes("python-fastapi"));
            assert.ok(fastapiPayload.scaffoldHints.some((h) => h && String(h.tool) === "uv"));

            writeFile(
                "docs/unknown.md",
                [
                    "# Unknown Stack",
                    "",
                    "## Goals",
                    "- Build something",
                    "",
                    "## Requirements",
                    "- Use Elixir Phoenix",
                    "",
                ].join("\n"),
            );
            const unknownPlan = await withCapturedConsole(() =>
                runCliMain(["bootstrap", "plan", "--from-doc", "docs/unknown.md", "--json"]),
            );
            const unknownPayload = JSON.parse(unknownPlan.output.join("\n"));
            assert.equal(Array.isArray(unknownPayload.scaffoldHints), true);
            assert.equal(unknownPayload.scaffoldHints.length, 0);
            assert.equal(Array.isArray(unknownPayload.risks), true);
            assert.ok(unknownPayload.risks.some((r) => r && r.id === "bootstrap-unknown-stack"));
        });
    });

    await t.test("bootstrap explain and diff are read-only and report drift", async () => {
        await withTempProject(async (tempDir) => {
            writeFile(
                "docs/product.md",
                [
                    "# Example Project",
                    "",
                    "## Goals",
                    "- Build a new project scaffold",
                    "",
                    "## Requirements",
                    "- Use React and Next.js",
                    "",
                ].join("\n"),
            );
            const planned = await withCapturedConsole(() =>
                runCliMain(["bootstrap", "plan", "--from-doc", "docs/product.md", "--json"]),
            );
            const payload = JSON.parse(planned.output.join("\n"));
            writeFile("bootstrap-plan.json", JSON.stringify(payload, null, 4) + "\n");

            const explained = await withCapturedConsole(() =>
                runCliMain(["bootstrap", "explain", "--from-plan", "bootstrap-plan.json"]),
            );
            const explainText = explained.output.join("\n");
            assert.match(explainText, /Detected keywords:/);
            assert.match(explainText, /Matched recipes:/);
            assert.match(explainText, /Hints:/);
            assert.match(explainText, /safety: reviewOnly/);

            const before = fs.existsSync(path.resolve(tempDir, ".aidw"));
            const diffA = await withCapturedConsole(() =>
                runCliMain(["bootstrap", "diff", "--from-plan", "bootstrap-plan.json", "--against", "disk"]),
            );
            const diffText = diffA.output.join("\n");
            assert.match(diffText, /Bootstrap Plan Diff/);
            assert.match(diffText, /safeToApply: true/);
            const after = fs.existsSync(path.resolve(tempDir, ".aidw"));
            assert.equal(after, before);

            writeFile(".aidw/meta.json", "{}\n");
            const diffB = await withCapturedConsole(() =>
                runCliMain(["bootstrap", "diff", "--from-plan", "bootstrap-plan.json", "--against", "disk", "--json"]),
            );
            const diffPayload = JSON.parse(diffB.output.join("\n"));
            assert.equal(diffPayload.ok, true);
            assert.equal(diffPayload.against, "disk");
            assert.equal(Array.isArray(diffPayload.items), true);
            assert.equal(Array.isArray(diffPayload.risks), true);
            assert.equal(diffPayload.safeToApply, false);
            assert.ok(diffPayload.risks.some((r) => r && r.id === "bootstrap-precondition-failed"));
        });
    });

    await t.test("scan creates project index files", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile(
                "package.json",
                JSON.stringify({
                    name: "scan-target",
                    bin: {
                        "scan-target": "bin/cli.js",
                    },
                }),
            );
            writeFile("bin/cli.js", "#!/usr/bin/env node\nexport function main() {}\n");
            writeFile(
                "src/scan/context.js",
                "export function validateContext() { return { ok: true }; }\n",
            );

            const result = await withMutedConsole(() => runScan());
            const fileIndex = JSON.parse(
                fs.readFileSync(".aidw/index/files.json", "utf-8"),
            );
            const symbolIndex = JSON.parse(
                fs.readFileSync(".aidw/index/symbols.json", "utf-8"),
            );
            const entrypointIndex = JSON.parse(
                fs.readFileSync(".aidw/index/entrypoints.json", "utf-8"),
            );
            const fileGroups = JSON.parse(
                fs.readFileSync(".aidw/index/file-groups.json", "utf-8"),
            );
            const summary = JSON.parse(
                fs.readFileSync(".aidw/index/summary.json", "utf-8"),
            );
            const taskMap = JSON.parse(
                fs.readFileSync(".aidw/context/tasks.json", "utf-8"),
            );

            assert.equal(result.changed, true);
            assert.ok(fs.existsSync(".aidw/AI.md"));
            assert.ok(fs.existsSync(".aidw/index/files.json"));
            assert.ok(fs.existsSync(".aidw/index/symbols.json"));
            assert.ok(fs.existsSync(".aidw/index/file-summaries.json"));
            assert.ok(fs.existsSync(".aidw/index/file-groups.json"));
            assert.ok(fs.existsSync(".aidw/index/summary.json"));
            assert.ok(fs.existsSync(".aidw/index/entrypoints.json"));
            assert.ok(fs.existsSync(".aidw/context/tasks.json"));
            const fileSummaries = JSON.parse(
                fs.readFileSync(".aidw/index/file-summaries.json", "utf-8"),
            );
            assert.equal(Array.isArray(fileSummaries), true);
            assert.ok(
                fileIndex.some(
                    (entry) =>
                        entry.path === "bin/cli.js" &&
                        typeof entry.confidence === "number" &&
                        entry.source === "heuristic",
                ),
            );
            assert.ok(
                symbolIndex.some(
                    (symbol) =>
                        symbol.name === "validateContext" &&
                        symbol.file === "src/scan/context.js" &&
                        symbol.exported === true &&
                        typeof symbol.confidence === "number" &&
                        symbol.source === "regex",
                ),
            );
            assert.ok(
                fileSummaries.some(
                    (entry) =>
                        entry.path === "bin/cli.js" &&
                        Array.isArray(entry.exports) &&
                        entry.exports.some((exported) => exported.name === "main"),
                ),
            );
            assert.ok(
                entrypointIndex.some(
                    (entrypoint) =>
                        entrypoint.path === "bin/cli.js" &&
                        entrypoint.command === "scan-target" &&
                        entrypoint.source === "package.json",
                ),
            );
            assert.ok(
                taskMap.every((task) =>
                    task.files.every((filePath) => fs.existsSync(filePath)),
                ),
            );
            assert.ok(
                fileGroups.some(
                    (group) =>
                        group.path === "src/scan" &&
                        group.keyFiles.every((filePath) => fs.existsSync(filePath)),
                ),
            );
            assert.equal(typeof summary.generatedAt, "string");
            assert.equal(summary.totalFilesScanned >= summary.indexedFiles, true);
            assert.equal(summary.indexedFiles, fileIndex.length);
            assert.equal(summary.indexedSymbols, symbolIndex.length);
            assert.equal(summary.fileGroups, fileGroups.length);
            assert.doesNotMatch(JSON.stringify(fileIndex), /ai\//);
            assert.doesNotMatch(JSON.stringify(symbolIndex), /ai\//);
        });
    });

    await t.test("auto errors with clear next steps when project is not initialized", async () => {
        await withTempProject(async () => {
            process.exitCode = 0;
            const { output } = await withCapturedConsole(() =>
                runCliMain(["auto", "--goal", "Do the thing"]),
            );
            assert.equal(process.exitCode, 1);
            const text = output.join("\n");
            assert.match(text, /Project is not initialized/);
            assert.match(text, /repo-context-kit init/);
        });
        process.exitCode = 0;
    });

    await t.test("auto --dry-run prints a plan and does not write files", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile("package.json", JSON.stringify({ name: "auto-target", version: "1.0.0" }) + "\n");
            writeFile("bin/cli.js", "#!/usr/bin/env node\n");

            const beforeRegistry = fs.readFileSync("task/task.md", "utf-8");
            const taskDirBefore = fs.existsSync("task") ? fs.readdirSync("task").slice().sort() : [];
            const executorStateExistsBefore = fs.existsSync(".aidw/executor-state.json");

            process.exitCode = 0;
            const { output } = await withCapturedConsole(() =>
                runCliMain(["auto", "--goal", "Add an auto flow", "--dry-run"]),
            );
            assert.equal(process.exitCode ?? 0, 0);

            const afterRegistry = fs.readFileSync("task/task.md", "utf-8");
            const taskDirAfter = fs.existsSync("task") ? fs.readdirSync("task").slice().sort() : [];
            const executorStateExistsAfter = fs.existsSync(".aidw/executor-state.json");

            assert.equal(afterRegistry, beforeRegistry);
            assert.deepEqual(taskDirAfter, taskDirBefore);
            assert.equal(executorStateExistsAfter, executorStateExistsBefore);

            const text = output.join("\n");
            assert.match(text, /AI Auto Workflow/);
            assert.match(text, /No files were written/);
        });
        process.exitCode = 0;
    });

    await t.test("auto --dry-run --json returns virtual runtime contract with workset and prompt without writing files", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile(
                "package.json",
                JSON.stringify({ name: "auto-target", version: "1.0.0", type: "module" }, null, 4) + "\n",
            );
            writeFile("bin/cli.js", "#!/usr/bin/env node\nexport function main() {}\n");
            writeFile("src/app.js", "export const value = 1;\n");
            await withMutedConsole(() => runScan());

            const beforeRegistry = fs.readFileSync("task/task.md", "utf-8");
            const taskDirBefore = fs.existsSync("task") ? fs.readdirSync("task").slice().sort() : [];
            const executorStateExistsBefore = fs.existsSync(".aidw/executor-state.json");
            const sessionsExistsBefore = fs.existsSync(".aidw/runtime/sessions.jsonl");

            process.exitCode = 0;
            const { output } = await withCapturedConsole(() =>
                runCliMain(["auto", "--goal", "Plan only", "--dry-run", "--json"]),
            );
            assert.equal(process.exitCode ?? 0, 0);
            const raw = output.join("\n");
            assert.match(raw, /^\{\s*\n\s+"runtimeVersion":\s+"1",\s*\n\s+"repoRoot":/);

            const afterRegistry = fs.readFileSync("task/task.md", "utf-8");
            const taskDirAfter = fs.existsSync("task") ? fs.readdirSync("task").slice().sort() : [];
            const executorStateExistsAfter = fs.existsSync(".aidw/executor-state.json");
            const sessionsExistsAfter = fs.existsSync(".aidw/runtime/sessions.jsonl");
            assert.equal(afterRegistry, beforeRegistry);
            assert.deepEqual(taskDirAfter, taskDirBefore);
            assert.equal(executorStateExistsAfter, executorStateExistsBefore);
            assert.equal(sessionsExistsAfter, sessionsExistsBefore);

            const payload = JSON.parse(raw);
            assert.equal(payload.runtimeVersion, "1");
            assert.equal(payload.task.id, "VIRTUAL");
            assert.ok(String(payload.prompt).includes("Task Implementation Prompt"));
            assert.match(String(payload.workset.text), /## File Summary References/);
            assert.equal(payload.executionState.pauseId, null);
            assert.equal(Array.isArray(payload.risks), true);
            assert.equal(payload.risks.some((r) => r && r.id === "missing-acceptance-criteria"), true);
        });
        process.exitCode = 0;
    });

    await t.test("auto --json creates a task, executor pause, and session metadata without modifying source code", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile(
                "package.json",
                JSON.stringify(
                    {
                        name: "auto-target",
                        version: "1.0.0",
                        bin: { "auto-target": "bin/cli.js" },
                        type: "module",
                    },
                    null,
                    4,
                ) + "\n",
            );
            writeFile("bin/cli.js", "#!/usr/bin/env node\nexport function main() {}\n");
            writeFile("src/app.js", "export const value = 1;\n");
            const beforeApp = fs.readFileSync("src/app.js", "utf-8");

            await withMutedConsole(() => runScan());

            process.exitCode = 0;
            const { output } = await withCapturedConsole(() =>
                runCliMain(["auto", "--goal", "Add auto orchestrator", "--json"]),
            );
            assert.equal(process.exitCode ?? 0, 0);

            const payload = JSON.parse(output.join("\n"));
            assert.equal(payload.runtimeVersion, "1");
            assert.match(payload.task.id, /^T-\d{3}$/);
            assert.match(payload.executionState.pauseId, /^P-[a-f0-9]{16}$/);
            assert.equal(Array.isArray(payload.nextActions), true);
            assert.ok(payload.nextActions.some((cmd) => String(cmd).includes("execute confirm")));
            assert.equal(payload.workset.mode === "digest", true);
            assert.ok(fs.existsSync(".aidw/runtime/sessions.jsonl"));
            assert.match(payload.executionState.sessionId, /^S-[a-f0-9]{16}$/);
            assert.equal(Array.isArray(payload.risks), true);
            assert.equal(payload.risks.some((r) => r && r.id === "missing-acceptance-criteria"), true);

            assert.ok(fs.existsSync(`task/${payload.task.id}-add-auto-orchestrator.md`));
            const taskContent = fs.readFileSync(`task/${payload.task.id}-add-auto-orchestrator.md`, "utf-8");
            assert.match(taskContent, /## Goal/);
            assert.match(taskContent, /## Background/);
            assert.match(taskContent, /## Scope/);
            assert.match(taskContent, /## Requirements/);
            assert.match(taskContent, /## Acceptance Criteria/);
            assert.match(taskContent, /## Test Command/);
            assert.match(taskContent, /## Definition of Done/);
            assert.ok(fs.existsSync(".aidw/executor-state.json"));

            const afterApp = fs.readFileSync("src/app.js", "utf-8");
            assert.equal(afterApp, beforeApp);

            if (fs.existsSync(".aidw/context-loop.jsonl")) {
                const loopText = fs.readFileSync(".aidw/context-loop.jsonl", "utf-8");
                assert.doesNotMatch(loopText, /"type":"test"/);
            }
        });
        process.exitCode = 0;
    });

    await t.test("sessions.jsonl is append-only across multiple auto runs", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile(
                "package.json",
                JSON.stringify({ name: "auto-target", version: "1.0.0", type: "module" }, null, 4) + "\n",
            );
            writeFile("bin/cli.js", "#!/usr/bin/env node\nexport function main() {}\n");
            writeFile("src/app.js", "export const value = 1;\n");
            await withMutedConsole(() => runScan());

            process.exitCode = 0;
            const first = await withCapturedConsole(() =>
                runCliMain(["auto", "--goal", "First session", "--json"]),
            );
            const firstPayload = JSON.parse(first.output.join("\n"));
            const sessionsPath = ".aidw/runtime/sessions.jsonl";
            assert.ok(fs.existsSync(sessionsPath));
            const linesAfterFirst = fs.readFileSync(sessionsPath, "utf-8").trim().split("\n").filter(Boolean);
            assert.ok(linesAfterFirst.some((line) => line.includes(firstPayload.executionState.sessionId)));

            process.exitCode = 0;
            const second = await withCapturedConsole(() =>
                runCliMain(["auto", "--goal", "Second session", "--json"]),
            );
            const secondPayload = JSON.parse(second.output.join("\n"));
            const linesAfterSecond = fs.readFileSync(sessionsPath, "utf-8").trim().split("\n").filter(Boolean);
            assert.ok(linesAfterSecond.length >= linesAfterFirst.length + 1);
            assert.ok(linesAfterSecond.some((line) => line.includes(firstPayload.executionState.sessionId)));
            assert.ok(linesAfterSecond.some((line) => line.includes(secondPayload.executionState.sessionId)));
        });
        process.exitCode = 0;
    });

    await t.test("init AGENTS references workflow, safety, overview, and current task", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());

            const agents = fs.readFileSync("AGENTS.md", "utf-8");

            assert.match(agents, /\.aidw\/workflow\.md/);
            assert.match(agents, /\.aidw\/safety\.md/);
            assert.match(agents, /\.aidw\/system-overview\.md/);
            assert.match(agents, /current task file/);
        });
    });

    await t.test("task new creates first task file with npm test command", async () => {
        await withTempProject(async () => {
            writeFile("package.json", JSON.stringify({ name: "task-target" }));

            const { output, result } = await withCapturedConsole(() =>
                runTask(["new", "Add receipt evidence API"]),
            );
            const taskContent = fs.readFileSync(result.created, "utf-8");

            assert.equal(result.created, "task/T-001-add-receipt-evidence-api.md");
            assert.match(output.join("\n"), /Task created/);
            assert.ok(fs.existsSync("task/task.md"));
            assert.match(taskContent, /# T-001 Add Receipt Evidence API/);
            assert.match(taskContent, /## Acceptance Criteria/);
            assert.match(taskContent, /## Test Command/);
            assert.match(taskContent, /npm test/);
            assert.match(taskContent, /## Hard Boundaries/);
            assert.match(taskContent, /## Confirmation Points/);
            assert.match(taskContent, /## Definition of Done/);
            assert.match(
                fs.readFileSync("task/task.md", "utf-8"),
                /\| T-001 \| Add Receipt Evidence API \| todo \| medium \| - \| - \| \[T-001\]\(\.\/T-001-add-receipt-evidence-api\.md\) \|/,
            );
            assert.equal(fs.existsSync(".aidw"), false);
        });
    });

    await t.test("task new refreshes tasks.json when .aidw exists", async () => {
        await withTempProject(async () => {
            writeContextProject("# Project Context\n");
            writeFile("package.json", JSON.stringify({ name: "task-target" }));

            const { output, result } = await withCapturedConsole(() =>
                runTask(["new", "Add receipt evidence API"]),
            );

            assert.equal(result.created, "task/T-001-add-receipt-evidence-api.md");
            assert.ok(fs.existsSync(".aidw/context/tasks.json"));

            const tasks = JSON.parse(fs.readFileSync(".aidw/context/tasks.json", "utf-8"));
            assert.equal(Array.isArray(tasks), true);
            assert.equal(
                tasks.some((task) => task && typeof task === "object" && task.id === "T-001"),
                true,
            );
            assert.match(output.join("\n"), /\.aidw\/context\/tasks\.json/);
        });
    });

    await t.test("task new --dry-run does not write files and lists planned changes", async () => {
        await withTempProject(async () => {
            writeContextProject("# Project Context\n");
            writeFile("package.json", JSON.stringify({ name: "task-target" }));

            const { output } = await withCapturedConsole(() =>
                runTask(["new", "Add receipt evidence API", "--dry-run"]),
            );
            const text = output.join("\n");

            assert.match(text, /Dry run: task creation would make these changes/);
            assert.match(text, /task\/T-001-add-receipt-evidence-api\.md/);
            assert.match(text, /task\/task\.md/);
            assert.match(text, /\.aidw\/context\/tasks\.json/);
            assert.equal(fs.existsSync("task/T-001-add-receipt-evidence-api.md"), false);
            assert.equal(fs.existsSync("task/task.md"), false);
        });
    });

    await t.test("task new increments numbering and uses default title", async () => {
        await withTempProject(async () => {
            const first = await withMutedConsole(() => runTask(["new"]));
            const second = await withMutedConsole(() => runTask(["new", "Second task"]));

            assert.equal(first.created, "task/T-001-new-task.md");
            assert.equal(second.created, "task/T-002-second-task.md");
            assert.ok(fs.existsSync(first.created));
            assert.ok(fs.existsSync(second.created));
            assert.match(
                fs.readFileSync("task/task.md", "utf-8"),
                /\| T-002 \| Second Task \| todo \| medium \| - \| - \| \[T-002\]\(\.\/T-002-second-task\.md\) \|/,
            );
        });
    });

    await t.test("task new increments from existing registry entries", async () => {
        await withTempProject(async () => {
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-009 | Existing | todo | medium | - | - | [T-009](./T-009-existing.md) |
`,
            );

            const result = await withMutedConsole(() =>
                runTask(["new", "Next task"]),
            );

            assert.equal(result.created, "task/T-010-next-task.md");
        });
    });

    await t.test("task registry parser extracts table fields", async () => {
        await withTempProject(() => {
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Add receipt API | in_progress | high | Wilson | T-000 | [T-001](./T-001-add-receipt-api.md) |
`,
            );

            const registry = parseTaskRegistry();

            assert.equal(registry.exists, true);
            assert.deepEqual(registry.tasks, [
                {
                    id: "T-001",
                    title: "Add receipt API",
                    status: "in_progress",
                    priority: "high",
                    owner: "Wilson",
                    dependencies: "T-000",
                    file: "task/T-001-add-receipt-api.md",
                },
            ]);
        });
    });

    await t.test("task new defaults to pytest for Python-only project", async () => {
        await withTempProject(async () => {
            writeFile("requirements.txt", "pytest==8.0.0\n");

            const result = await withMutedConsole(() =>
                runTask(["new", "Add Python thing"]),
            );
            const taskContent = fs.readFileSync(result.created, "utf-8");

            assert.match(taskContent, /```bash\npytest\n```/);
        });
    });

    await t.test("CLI help includes task new command", async () => {
        const { output } = await withCapturedConsole(() => runCliMain(["--help"]));

        const text = output.join("\n");

        assert.match(text, /Usage:\s*\n\s*repo-context-kit <command> \[options\]/);
        assert.match(text, /Getting Started:/);
        assert.match(text, /init\s+Copy workflow template/i);
        assert.match(text, /scan\s+Update .*indexes/i);
        assert.match(text, /auto --goal "<goal>"/);

        assert.match(text, /Core Runtime:/);
        assert.match(text, /runtime snapshot\s+Browse snapshots/i);
        assert.match(text, /task\s+Create tasks/i);
        assert.match(text, /context\s+Print bounded task context/i);
        assert.match(text, /execute\s+Pause\/confirm flow/i);
        assert.match(text, /gate\s+Confirmation gate/i);

        assert.match(text, /Advanced Runtime:/);
        assert.match(text, /learn\s+Derive lessons/i);
        assert.match(text, /check\s+Enforce lessons-derived constraints/i);
        assert.match(text, /decision\s+Explain recent runtime decisions/i);
        assert.match(text, /budget\s+Show budget policy/i);
        assert.match(text, /loop\s+Report loop signals/i);
        assert.match(text, /github\s+GitHub helpers/i);
        assert.match(text, /ui\s+Local web console/i);

        assert.match(text, /--dry-run/);
        assert.match(text, /--plan/);
        assert.match(text, /--check/);
        assert.match(text, /REPO_CONTEXT_KIT_BUDGET/);
    });

    await t.test("doc loader enforces bounded read and repoRoot safety", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile("docs/prd.md", "# PRD\n\n## Goal\n\nShip the thing.\n");
            const doc = loadDesignDoc("docs/prd.md", { repoRoot: process.cwd() });
            assert.equal(doc.path, "docs/prd.md");
            assert.match(doc.metadata.title, /PRD/i);
        });
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile("docs/big.txt", "a".repeat(210 * 1024));
            assert.throws(() => loadDesignDoc("docs/big.txt", { repoRoot: process.cwd() }));
        });
    });

    await t.test("doc extractor is deterministic and detects conflicts (heuristic)", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile(
                "docs/spec.md",
                `# Spec\n\n## Goal\n- Add API\n\n## Requirements\n- Enable feature X\n- Do not enable feature X\n\n## Acceptance Criteria\n- Works\n`,
            );
            const doc = loadDesignDoc("docs/spec.md", { repoRoot: process.cwd() });
            const planningA = extractPlanningData(doc);
            const planningB = extractPlanningData(doc);
            assert.deepEqual(planningA, planningB);
            assert.equal(planningA.analysis.conflictingRequirements, true);
        });
    });

    await t.test("task generate --from-doc supports dry-run json without writing tasks", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile(
                "docs/prd.md",
                `# PRD\n\n## Goal\n- Add auth\n\n## Requirements\n- Add login\n- Add logout\n\n## Scope\n- src/auth/\n\n## Acceptance Criteria\n- Login works\n- Logout works\n`,
            );
            process.exitCode = 0;
            const { output } = await withCapturedConsole(() =>
                runCliMain(["task", "generate", "--from-doc", "docs/prd.md", "--dry-run", "--json"]),
            );
            const payload = JSON.parse(output.join("\n"));
            assert.equal(payload.ok, true);
            assert.equal(Array.isArray(payload.generatedTasks), true);
            assert.ok(payload.generatedTasks.length > 0);
            assert.equal(fs.existsSync("task/T-001-add-auth.md"), false);
        });
    });

    await t.test("auto --from-doc dry-run json produces runtime contract with planningSource and does not write snapshots", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            await withMutedConsole(() => runScan());
            writeFile(
                "docs/prd.md",
                `# PRD\n\n## Goal\n- Add auth\n\n## Requirements\n- Add login\n\n## Acceptance Criteria\n- Login works\n`,
            );
            process.exitCode = 0;
            const { output } = await withCapturedConsole(() =>
                runCliMain(["auto", "--from-doc", "docs/prd.md", "--dry-run", "--json"]),
            );
            const payload = JSON.parse(output.join("\n"));
            assert.equal(payload.ok, true);
            assert.equal(payload.fromDoc, "docs/prd.md");
            assert.ok(payload.runtimeContract);
            assert.ok(payload.runtimeContract.planningSource);
            assert.equal(payload.runtimeContract.planningSource.type, "design-doc");
            assert.match(payload.runtimeContract.planningSource.path, /docs\/prd\.md/);
            assert.equal(fs.existsSync(".aidw/runtime/snapshots/snapshots.jsonl"), false);
        });
    });

    await t.test("task cleanup succeeds for completed task and removes task artifacts deterministically", async () => {
        await withTempProject(async () => {
            writeContextProject("# Project Context\n");
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Done Task | done | medium | Wilson | - | [T-001](./T-001-done-task.md) |
`,
            );
            writeFile(
                "task/T-001-done-task.md",
                `# T-001 Done Task

This task is complete.
`,
            );

            process.exitCode = 0;
            const { output } = await withCapturedConsole(() =>
                runCliMain(["task", "cleanup", "T-001"]),
            );
            assert.equal(process.exitCode ?? 0, 0);
            const text = output.join("\n");
            assert.match(text, /OK Task cleanup completed/);
            assert.match(text, /Removed:\s*\n\* task\/T-001-done-task\.md/);
            assert.match(text, /Archived:\s*\n\* task\/archive\/task-history\.md/);
            assert.equal(fs.existsSync("task/T-001-done-task.md"), false);

            const registry = fs.readFileSync("task/task.md", "utf-8");
            assert.doesNotMatch(registry, /\| T-001 \|/);

            const history = fs.readFileSync("task/archive/task-history.md", "utf-8");
            assert.match(history, /## T-001 Done Task/);
            assert.match(history, /- Owner: Wilson/);
            assert.match(history, /- Summary: This task is complete\./);

            const tasksJson = JSON.parse(fs.readFileSync(".aidw/context/tasks.json", "utf-8"));
            assert.ok(Array.isArray(tasksJson));
            assert.equal(tasksJson.some((entry) => entry?.id === "T-001"), false);

            process.exitCode = 0;
        });
    });

    await t.test("task cleanup does not create .aidw when context directory is absent", async () => {
        await withTempProject(async () => {
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Done Task | done | medium | Wilson | - | [T-001](./T-001-done-task.md) |
`,
            );
            writeFile(
                "task/T-001-done-task.md",
                `# T-001 Done Task

This task is complete.
`,
            );

            process.exitCode = 0;
            const { output } = await withCapturedConsole(() =>
                runCliMain(["task", "cleanup", "T-001"]),
            );
            assert.equal(process.exitCode ?? 0, 0);
            const text = output.join("\n");
            assert.match(text, /OK Task cleanup completed/);
            assert.equal(fs.existsSync(".aidw"), false);
            assert.doesNotMatch(text, /\.aidw\/context\/tasks\.json/);
            process.exitCode = 0;
        });
    });

    await t.test("task cleanup --dry-run does not write files and lists planned changes", async () => {
        await withTempProject(async () => {
            writeContextProject("# Project Context\n");
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Done Task | done | medium | Wilson | - | [T-001](./T-001-done-task.md) |
`,
            );
            writeFile(
                "task/T-001-done-task.md",
                `# T-001 Done Task

This task is complete.
`,
            );

            process.exitCode = 0;
            const { output } = await withCapturedConsole(() =>
                runCliMain(["task", "cleanup", "T-001", "--dry-run"]),
            );
            const text = output.join("\n");
            assert.equal(process.exitCode ?? 0, 0);
            assert.match(text, /Dry run: task cleanup would make these changes/);
            assert.match(text, /Removed:\s*\n\* task\/T-001-done-task\.md/);
            assert.match(text, /Archived:\s*\n\* task\/archive\/task-history\.md/);
            assert.match(text, /\.aidw\/context\/tasks\.json/);
            assert.equal(fs.existsSync("task/T-001-done-task.md"), true);
            assert.equal(fs.existsSync("task/archive/task-history.md"), false);
            assert.match(fs.readFileSync("task/task.md", "utf-8"), /\| T-001 \|/);
            process.exitCode = 0;
        });
    });

    await t.test("task cleanup is blocked when task is not done", async () => {
        await withTempProject(async () => {
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Todo Task | todo | medium | - | - | [T-001](./T-001-todo-task.md) |
`,
            );
            writeFile("task/T-001-todo-task.md", "# T-001 Todo Task\n\nNot done.\n");

            process.exitCode = 0;
            const { output } = await withCapturedConsole(() =>
                runCliMain(["task", "cleanup", "T-001"]),
            );
            assert.equal(process.exitCode, 1);
            assert.equal(output.join("\n"), "Task is not completed. Cleanup aborted.");
            assert.equal(fs.existsSync("task/T-001-todo-task.md"), true);
            assert.equal(fs.existsSync("task/archive/task-history.md"), false);
            process.exitCode = 0;
        });
    });

    await t.test("task cleanup fails when task is missing from registry", async () => {
        await withTempProject(async () => {
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-002 | Other Task | done | medium | - | - | [T-002](./T-002-other.md) |
`,
            );
            writeFile("task/T-002-other.md", "# T-002 Other\n");

            process.exitCode = 0;
            const { output } = await withCapturedConsole(() =>
                runCliMain(["task", "cleanup", "T-001"]),
            );
            assert.equal(process.exitCode, 1);
            assert.equal(output.join("\n"), "Task is not completed. Cleanup aborted.");
            assert.equal(fs.existsSync("task/archive/task-history.md"), false);
            process.exitCode = 0;
        });
    });

    await t.test("task cleanup fails when task file is missing", async () => {
        await withTempProject(async () => {
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Done Task | done | medium | - | - | [T-001](./T-001-done-task.md) |
`,
            );

            process.exitCode = 0;
            const { output } = await withCapturedConsole(() =>
                runCliMain(["task", "cleanup", "T-001"]),
            );
            assert.equal(process.exitCode, 1);
            assert.equal(output.join("\n"), "Task file not found. Cleanup aborted.");
            assert.equal(fs.existsSync("task/archive/task-history.md"), false);
            process.exitCode = 0;
        });
    });

    await t.test("task pr --cleanup runs cleanup after PR generation succeeds", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Done Task | done | medium | - | - | [T-001](./T-001-done-task.md) |
`,
            );
            writeFile(
                "task/T-001-done-task.md",
                `# T-001 Done Task

Cleanup after PR.
`,
            );
            writeFile(".aidw/index/files.json", "[]\n");
            writeFile(".aidw/index/symbols.json", "[]\n");

            process.exitCode = 0;
            const { output } = await withCapturedConsole(() =>
                runCliMain(["task", "pr", "T-001", "--cleanup"]),
            );
            assert.equal(process.exitCode ?? 0, 0);
            const text = output.join("\n");
            assert.match(text, /# Pull Request Description/);
            assert.match(text, /OK Task cleanup completed/);
            assert.equal(fs.existsSync("task/T-001-done-task.md"), false);
            assert.equal(fs.existsSync("task/archive/task-history.md"), true);
            process.exitCode = 0;
        });
    });

    await t.test("task pr --cleanup does not cleanup when PR generation fails", async () => {
        await withTempProject(async () => {
            writeFile(".aidw/index/files.json", "[]\n");
            writeFile(".aidw/index/symbols.json", "[]\n");

            process.exitCode = 0;
            const { output } = await withCapturedConsole(() =>
                runCliMain(["task", "pr", "T-999", "--cleanup"]),
            );
            assert.equal(process.exitCode, 1);
            const text = output.join("\n");
            assert.match(text, /# Pull Request Description/);
            assert.doesNotMatch(text, /Task cleanup completed/);
            assert.equal(fs.existsSync("task/archive/task-history.md"), false);
            process.exitCode = 0;
        });
    });

    await t.test("execute run creates scope pause and writes loop events", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            await withMutedConsole(() => runTask(["new", "Executor task"]));

            process.exitCode = 0;
            await withCapturedConsole(() => runCliMain(["execute", "run", "T-001"]));
            assert.equal(process.exitCode ?? 0, 0);

            const state = JSON.parse(fs.readFileSync(".aidw/executor-state.json", "utf-8"));
            assert.equal(state.activeTaskId, "T-001");
            assert.equal(state.phase, "waiting_for_scope_confirmation");
            assert.equal(state.pauseType, "confirm_scope");
            assert.match(state.pauseId, /^P-[a-f0-9]{16}$/i);

            const loopText = fs.readFileSync(".aidw/context-loop.jsonl", "utf-8");
            assert.match(loopText, /"type":"executor_task_loaded"/);
            assert.match(loopText, /"type":"executor_pause_created"/);

            process.exitCode = 0;
        });
    });

    await t.test("execute confirm advances through phases into testing", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            await withMutedConsole(() => runTask(["new", "Executor confirm flow"]));

            process.exitCode = 0;
            await withCapturedConsole(() => runCliMain(["execute", "run", "T-001"]));
            let state = JSON.parse(fs.readFileSync(".aidw/executor-state.json", "utf-8"));
            const pauseScope = state.pauseId;

            await withCapturedConsole(() => runCliMain(["execute", "confirm", pauseScope]));
            state = JSON.parse(fs.readFileSync(".aidw/executor-state.json", "utf-8"));
            assert.equal(state.phase, "waiting_for_apply_confirmation");
            assert.equal(state.pauseType, "confirm_apply");
            const pauseApply = state.pauseId;

            await withCapturedConsole(() => runCliMain(["execute", "confirm", pauseApply]));
            state = JSON.parse(fs.readFileSync(".aidw/executor-state.json", "utf-8"));
            assert.equal(state.phase, "waiting_for_test_confirmation");
            assert.equal(state.pauseType, "confirm_test");
            const pauseTest = state.pauseId;

            await withCapturedConsole(() => runCliMain(["execute", "confirm", pauseTest]));
            state = JSON.parse(fs.readFileSync(".aidw/executor-state.json", "utf-8"));
            assert.equal(state.phase, "testing");
            assert.equal(state.pauseId, null);
            assert.equal(state.pauseType, null);

            process.exitCode = 0;
        });
    });

    await t.test("execute confirm rejects invalid pauseId", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            await withMutedConsole(() => runTask(["new", "Executor invalid pause"]));

            await withCapturedConsole(() => runCliMain(["execute", "run", "T-001"]));
            process.exitCode = 0;
            const { output } = await withCapturedConsole(() =>
                runCliMain(["execute", "confirm", "P-not-a-real-pause"]),
            );
            assert.equal(process.exitCode, 1);
            assert.match(output.join("\n"), /Invalid pauseId/i);
            process.exitCode = 0;
        });
    });

    await t.test("execute sync updates executor state from latest test event", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            await withMutedConsole(() => runTask(["new", "Executor sync flow"]));

            await withCapturedConsole(() => runCliMain(["execute", "run", "T-001"]));
            let state = JSON.parse(fs.readFileSync(".aidw/executor-state.json", "utf-8"));
            await withCapturedConsole(() => runCliMain(["execute", "confirm", state.pauseId]));
            state = JSON.parse(fs.readFileSync(".aidw/executor-state.json", "utf-8"));
            await withCapturedConsole(() => runCliMain(["execute", "confirm", state.pauseId]));
            state = JSON.parse(fs.readFileSync(".aidw/executor-state.json", "utf-8"));
            await withCapturedConsole(() => runCliMain(["execute", "confirm", state.pauseId]));

            process.exitCode = 0;
            const pending = await withCapturedConsole(() => runCliMain(["execute", "sync"]));
            assert.equal(process.exitCode ?? 0, 0);
            assert.match(pending.output.join("\n"), /no test result found/i);

            fs.appendFileSync(
                ".aidw/context-loop.jsonl",
                `${JSON.stringify({
                    at: "2026-01-01T00:00:00.000Z",
                    type: "test",
                    taskId: "T-001",
                    ok: true,
                    exitCode: 0,
                    command: "npm test",
                })}\n`,
                "utf-8",
            );

            const completed = await withCapturedConsole(() => runCliMain(["execute", "sync"]));
            assert.equal(process.exitCode ?? 0, 0);
            assert.match(completed.output.join("\n"), /marked task as completed/i);

            const finalState = JSON.parse(fs.readFileSync(".aidw/executor-state.json", "utf-8"));
            assert.equal(finalState.phase, "completed");
            assert.ok(Array.isArray(finalState.completedTasks));
            assert.ok(finalState.completedTasks.includes("T-001"));

            process.exitCode = 0;
        });
    });

    await t.test("execute next selects the first todo task in the registry", async () => {
        await withTempProject(async () => {
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Done Task | done | medium | - | - | [T-001](./T-001-done.md) |
| T-002 | Todo Task | todo | medium | - | - | [T-002](./T-002-todo.md) |
`,
            );
            writeFile("task/T-001-done.md", "# T-001 Done Task\n");
            writeFile("task/T-002-todo.md", "# T-002 Todo Task\n");

            process.exitCode = 0;
            await withCapturedConsole(() => runCliMain(["execute", "next"]));
            assert.equal(process.exitCode ?? 0, 0);

            const state = JSON.parse(fs.readFileSync(".aidw/executor-state.json", "utf-8"));
            assert.equal(state.activeTaskId, "T-002");
            assert.equal(state.phase, "waiting_for_scope_confirmation");

            process.exitCode = 0;
        });
    });

    await t.test("execute reset clears executor state", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            await withMutedConsole(() => runTask(["new", "Executor reset flow"]));

            await withCapturedConsole(() => runCliMain(["execute", "run", "T-001"]));
            process.exitCode = 0;
            await withCapturedConsole(() => runCliMain(["execute", "reset"]));
            assert.equal(process.exitCode ?? 0, 0);

            const state = JSON.parse(fs.readFileSync(".aidw/executor-state.json", "utf-8"));
            assert.equal(state.phase, "idle");
            assert.equal(state.activeTaskId, null);

            const loopText = fs.readFileSync(".aidw/context-loop.jsonl", "utf-8");
            assert.match(loopText, /"type":"executor_reset"/);

            process.exitCode = 0;
        });
    });

    await t.test("task generate prints scaffold output", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            await withMutedConsole(() => runScan({ mode: "auto" }));

            const { output } = await withCapturedConsole(() =>
                runCliMain(["task", "generate"]),
            );
            const text = output.join("\n");

            assert.match(text, /Task Generation Scaffold/);
            assert.match(text, /\.aidw\/system-overview\.md/);
            assert.match(text, /\.aidw\/project\.md/);
        });
    });

    await t.test("task run prints scaffold output", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            await withMutedConsole(() => runScan({ mode: "auto" }));
            await withMutedConsole(() => runTask(["new", "Example Task"]));

            const { output } = await withCapturedConsole(() =>
                runCliMain(["task", "run"]),
            );
            const text = output.join("\n");

            assert.match(text, /Task Run Scaffold/);
            assert.match(text, /Example Task/);
        });
    });

    await t.test("budget show prints effective mode and does not crash", async () => {
        process.exitCode = 0;
        const { output } = await withCapturedConsole(() => runCliMain(["budget", "show"]));
        const text = output.join("\n");

        assert.equal(process.exitCode ?? 0, 0);
        assert.match(text, /# Budget Policy/);
        assert.match(text, /- resolved: (off|auto|full)/);
        process.exitCode = 0;
    });

    await t.test("decision explain prints latest decision without writing files", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile("package.json", JSON.stringify({ name: "decision-target" }));

            await withMutedConsole(() => runContext(["brief", "--budget", "auto"]));
            const before = fs.statSync(".aidw/context-loop.jsonl").mtimeMs;

            process.exitCode = 0;
            const { output } = await withCapturedConsole(() => runCliMain(["decision", "explain"]));
            const text = output.join("\n");

            assert.equal(process.exitCode ?? 0, 0);
            assert.match(text, /Decision Explain/);
            assert.match(text, /Decision:/);
            assert.match(text, /mode:/);
            assert.match(text, /Why:/);
            assert.match(text, /Evidence:/);
            assert.match(text, /Runtime Risks/);
            assert.match(text, /How to override:/);
            assert.match(text, /No files were written\./);

            const after = fs.statSync(".aidw/context-loop.jsonl").mtimeMs;
            assert.equal(after, before);
            process.exitCode = 0;
        });
    });

    await t.test("learn ingest --dry-run previews lessons without writing files", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile("package.json", JSON.stringify({ name: "lesson-target" }));
            writeFile("bin/cli.js", "#!/usr/bin/env node\n");

            const now = new Date().toISOString();
            writeFile(
                ".aidw/context-loop.jsonl",
                `${JSON.stringify({
                    at: now,
                    type: "test",
                    ok: false,
                    exitCode: 1,
                    command: "npm test",
                    taskId: "T-001",
                })}\n`,
            );

            const beforeLessons = fs.statSync(".aidw/lessons.json").mtimeMs;
            process.exitCode = 0;
            const { output } = await withCapturedConsole(() =>
                runCliMain(["learn", "ingest", "--dry-run"]),
            );
            assert.equal(process.exitCode ?? 0, 0);
            assert.equal(fs.existsSync(".aidw/lessons.pending.json"), false);

            const afterLessons = fs.statSync(".aidw/lessons.json").mtimeMs;
            assert.equal(afterLessons, beforeLessons);

            const text = output.join("\n");
            assert.match(text, /Learn Ingest Plan/);
            assert.match(text, /No files were written\./);
            process.exitCode = 0;
        });
    });

    await t.test("learn ingest writes pending lessons and learn approve applies them", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile("package.json", JSON.stringify({ name: "lesson-target" }));
            writeFile("bin/cli.js", "#!/usr/bin/env node\n");

            const now = new Date().toISOString();
            writeFile(
                ".aidw/context-loop.jsonl",
                `${JSON.stringify({
                    at: now,
                    type: "test",
                    ok: false,
                    exitCode: 1,
                    command: "npm test",
                    taskId: "T-001",
                })}\n${JSON.stringify({
                    at: now,
                    type: "scan_check_failed",
                    ok: false,
                    projectChanged: true,
                    systemOverviewChanged: false,
                    taskMapChanged: false,
                    taskRegistryChanged: true,
                    skipped: false,
                    warnings: ["task registry mismatch detected"],
                })}\n`,
            );

            process.exitCode = 0;
            const { output } = await withCapturedConsole(() => runCliMain(["learn", "ingest"]));
            assert.equal(process.exitCode ?? 0, 0);
            assert.match(output.join("\n"), /Learn Ingest/);
            assert.ok(fs.existsSync(".aidw/lessons.pending.json"));

            process.exitCode = 0;
            const { output: approveOutput } = await withCapturedConsole(() =>
                runCliMain(["learn", "approve"]),
            );
            assert.equal(process.exitCode ?? 0, 0);
            assert.match(approveOutput.join("\n"), /Learn Approve/);
            assert.equal(fs.existsSync(".aidw/lessons.pending.json"), false);

            const lessons = JSON.parse(fs.readFileSync(".aidw/lessons.json", "utf-8"));
            assert.equal(lessons.version, 2);
            assert.ok(Array.isArray(lessons.lessons));
            const types = lessons.lessons.map((lesson) => lesson.type);
            assert.ok(types.includes("tests_failed"));
            assert.ok(types.includes("scan_stale"));
            assert.ok(types.includes("task_registry_mismatch"));
        });
    });

    await t.test("check blocks on matched blocker lessons and emits explain output", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());

            writeFile(
                ".aidw/lessons.json",
                `${JSON.stringify(
                    {
                        version: 2,
                        schema: {},
                        lessons: [
                            {
                                id: "L-tests_must_pass",
                                type: "tests_failed",
                                severity: "blocker",
                                scope: "repo",
                                pattern: "Recent tests failed (exit code != 0).",
                                fix: "Run: npm test",
                                active: true,
                                source: { eventId: "evt_test", from: "test" },
                            },
                            {
                                id: "L-noop-warning",
                                type: "scan_stale",
                                severity: "warning",
                                scope: "repo",
                                pattern: "Scan is stale.",
                                fix: "Run: repo-context-kit scan",
                                active: false,
                                source: { eventId: "evt_scan", from: "scan" },
                            },
                        ],
                    },
                    null,
                    4,
                )}\n`,
            );

            writeFile(
                ".aidw/context-loop.jsonl",
                `${JSON.stringify({
                    at: new Date().toISOString(),
                    type: "test",
                    ok: false,
                    exitCode: 1,
                    command: "npm test",
                })}\n`,
            );

            const before = fs.statSync(".aidw/context-loop.jsonl").mtimeMs;
            process.exitCode = 0;
            const { output } = await withCapturedConsole(() =>
                runCliMain(["check", "--explain"]),
            );
            const text = output.join("\n");

            assert.equal(process.exitCode ?? 0, 1);
            assert.match(text, /Check Explain/);
            assert.match(text, /Matches:/);
            assert.match(text, /Check Failed/);
            assert.match(text, /Why:/);
            assert.match(text, /Evidence:/);
            assert.match(text, /How to fix:/);

            const after = fs.statSync(".aidw/context-loop.jsonl").mtimeMs;
            assert.ok(after >= before);
            assert.match(
                fs.readFileSync(".aidw/context-loop.jsonl", "utf-8"),
                /"type":"check_failed"/,
            );
            process.exitCode = 0;
        });
    });

    await t.test("check passes when lessons are satisfied", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile("package.json", JSON.stringify({ name: "scan-target", version: "1.0.0" }));
            writeFile("bin/cli.js", "#!/usr/bin/env node\n");
            await withMutedConsole(() => runScan({ mode: "auto" }));

            writeFile(
                ".aidw/lessons.json",
                `${JSON.stringify(
                    {
                        version: 2,
                        schema: {},
                        lessons: [
                            {
                                id: "L-tests_must_pass",
                                type: "tests_failed",
                                severity: "blocker",
                                scope: "repo",
                                pattern: "Recent tests failed (exit code != 0).",
                                fix: "Run: npm test",
                                active: true,
                                source: { eventId: "evt_test", from: "test" },
                            },
                            {
                                id: "L-scan_must_be_up_to_date",
                                type: "scan_stale",
                                severity: "blocker",
                                scope: "repo",
                                pattern: "Scan check indicates generated context is stale.",
                                fix: "Run: repo-context-kit scan",
                                active: true,
                                source: { eventId: "evt_scan", from: "scan" },
                            },
                        ],
                    },
                    null,
                    4,
                )}\n`,
            );

            writeFile(
                ".aidw/context-loop.jsonl",
                `${JSON.stringify({
                    at: new Date().toISOString(),
                    type: "test",
                    ok: true,
                    exitCode: 0,
                    command: "npm test",
                })}\n`,
            );

            process.exitCode = 0;
            const { output } = await withCapturedConsole(() => runCliMain(["check"]));
            assert.equal(process.exitCode ?? 0, 0);
            assert.match(output.join("\n"), /Checks passed\./);
            assert.match(
                fs.readFileSync(".aidw/context-loop.jsonl", "utf-8"),
                /"type":"check_passed"/,
            );
            process.exitCode = 0;
        });
    });

    await t.test("check supports warn-only and strict modes", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());

            writeFile(
                ".aidw/lessons.json",
                `${JSON.stringify(
                    {
                        version: 2,
                        schema: {},
                        lessons: [
                            {
                                id: "L-warning-only",
                                type: "tests_failed",
                                severity: "warning",
                                scope: "repo",
                                pattern: "Recent tests failed (exit code != 0).",
                                fix: "Run: npm test",
                                active: true,
                                source: { eventId: "evt_test", from: "test" },
                            },
                        ],
                    },
                    null,
                    4,
                )}\n`,
            );

            writeFile(
                ".aidw/context-loop.jsonl",
                `${JSON.stringify({
                    at: new Date().toISOString(),
                    type: "test",
                    ok: false,
                    exitCode: 1,
                    command: "npm test",
                })}\n`,
            );

            process.exitCode = 0;
            const { output: warnOutput } = await withCapturedConsole(() =>
                runCliMain(["check"]),
            );
            assert.equal(process.exitCode ?? 0, 0);
            assert.match(warnOutput.join("\n"), /Check Warnings/);

            process.exitCode = 0;
            const { output: strictOutput } = await withCapturedConsole(() =>
                runCliMain(["check", "--strict"]),
            );
            assert.equal(process.exitCode ?? 0, 1);
            assert.match(strictOutput.join("\n"), /Check Failed/);

            process.exitCode = 0;
            const { output: warnOnlyOutput } = await withCapturedConsole(() =>
                runCliMain(["check", "--warn-only"]),
            );
            assert.equal(process.exitCode ?? 0, 0);
            assert.match(warnOnlyOutput.join("\n"), /Why:/);
            assert.match(warnOnlyOutput.join("\n"), /How to fix:/);
            process.exitCode = 0;
        });
    });

    await t.test("check supports last_N_events window and threshold matching", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());

            writeFile(
                ".aidw/lessons.json",
                `${JSON.stringify(
                    {
                        version: 2,
                        schema: {},
                        lessons: [
                            {
                                id: "L-tests_failed_frequency",
                                type: "tests_failed",
                                severity: "warning",
                                scope: "repo",
                                pattern: "Recent tests failed (exit code != 0).",
                                fix: "Run: npm test",
                                active: true,
                                window: "last_5_events",
                                threshold: 3,
                                confidence: 0.9,
                                source: { eventId: "evt_test", from: "test" },
                            },
                        ],
                    },
                    null,
                    4,
                )}\n`,
            );

            writeFile(
                ".aidw/context-loop.jsonl",
                `${JSON.stringify({
                    at: new Date().toISOString(),
                    type: "test",
                    ok: true,
                    exitCode: 0,
                    command: "npm test",
                })}\n${JSON.stringify({
                    at: new Date().toISOString(),
                    type: "test",
                    ok: false,
                    exitCode: 1,
                    command: "npm test",
                })}\n${JSON.stringify({
                    at: new Date().toISOString(),
                    type: "test",
                    ok: true,
                    exitCode: 0,
                    command: "npm test",
                })}\n${JSON.stringify({
                    at: new Date().toISOString(),
                    type: "test",
                    ok: false,
                    exitCode: 1,
                    command: "npm test",
                })}\n${JSON.stringify({
                    at: new Date().toISOString(),
                    type: "test",
                    ok: true,
                    exitCode: 0,
                    command: "npm test",
                })}\n`,
            );

            process.exitCode = 0;
            const { output: belowThreshold } = await withCapturedConsole(() =>
                runCliMain(["check"]),
            );
            assert.equal(process.exitCode ?? 0, 0);
            assert.match(belowThreshold.join("\n"), /Checks passed\./);

            writeFile(
                ".aidw/context-loop.jsonl",
                `${JSON.stringify({
                    at: new Date().toISOString(),
                    type: "test",
                    ok: false,
                    exitCode: 1,
                    command: "npm test",
                })}\n${JSON.stringify({
                    at: new Date().toISOString(),
                    type: "test",
                    ok: false,
                    exitCode: 1,
                    command: "npm test",
                })}\n${JSON.stringify({
                    at: new Date().toISOString(),
                    type: "test",
                    ok: true,
                    exitCode: 0,
                    command: "npm test",
                })}\n${JSON.stringify({
                    at: new Date().toISOString(),
                    type: "test",
                    ok: false,
                    exitCode: 1,
                    command: "npm test",
                })}\n${JSON.stringify({
                    at: new Date().toISOString(),
                    type: "test",
                    ok: true,
                    exitCode: 0,
                    command: "npm test",
                })}\n`,
            );

            process.exitCode = 0;
            const { output: atThreshold } = await withCapturedConsole(() =>
                runCliMain(["check", "--explain"]),
            );
            const atThresholdText = atThreshold.join("\n");
            assert.equal(process.exitCode ?? 0, 0);
            assert.match(atThresholdText, /Check Warnings/);
            assert.match(atThresholdText, /window: last_5_events/);
            assert.match(atThresholdText, /threshold: 3/);
            assert.match(atThresholdText, /observed: 3/);

            process.exitCode = 0;
        });
    });

    await t.test("check supports derived lessons and effects output", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());

            writeFile(
                ".aidw/lessons.json",
                `${JSON.stringify(
                    {
                        version: 2,
                        schema: {},
                        lessons: [
                            {
                                id: "L-tests_failed_frequency",
                                type: "tests_failed",
                                severity: "warning",
                                scope: "repo",
                                pattern: "Recent tests failed (exit code != 0).",
                                fix: "Run: npm test",
                                active: true,
                                window: "last_5_events",
                                threshold: 1,
                                source: { eventId: "evt_test", from: "test" },
                            },
                            {
                                id: "L-scan_stale_frequency",
                                type: "scan_stale",
                                severity: "warning",
                                scope: "repo",
                                pattern: "Scan check indicates generated context is stale.",
                                fix: "Run: repo-context-kit scan",
                                active: true,
                                window: "last_5_events",
                                threshold: 1,
                                source: { eventId: "evt_scan", from: "scan" },
                            },
                            {
                                id: "L-system_unstable",
                                type: "derived",
                                conditions: ["tests_failed", "scan_stale"],
                                action: "blocker",
                                pattern: "System is unstable.",
                                fix: "Stabilize tests and refresh scan context.",
                                active: true,
                                source: { eventId: "evt_derived", from: "learn" },
                            },
                            {
                                id: "E-high_risk_context_upgrade",
                                type: "effect",
                                trigger: ["tests_failed"],
                                effect: { context_mode: "FULL" },
                                active: true,
                                source: { eventId: "evt_effect", from: "learn" },
                            },
                        ],
                    },
                    null,
                    4,
                )}\n`,
            );

            writeFile(
                ".aidw/context-loop.jsonl",
                `${JSON.stringify({
                    at: new Date().toISOString(),
                    type: "scan_check_failed",
                    ok: false,
                    projectChanged: true,
                    skipped: false,
                    warnings: ["task registry mismatch detected"],
                })}\n${JSON.stringify({
                    at: new Date().toISOString(),
                    type: "test",
                    ok: false,
                    exitCode: 1,
                    command: "npm test",
                })}\n`,
            );

            process.exitCode = 0;
            const { output } = await withCapturedConsole(() => runCliMain(["check", "--explain"]));
            const text = output.join("\n");

            assert.equal(process.exitCode ?? 0, 1);
            assert.match(text, /L-system_unstable \(derived\)/);
            assert.match(text, /Check Failed/);
            assert.match(text, /Effect applied:/);
            assert.match(text, /- context_mode: FULL/);
            assert.match(text, /"context_mode": "FULL"/);

            process.exitCode = 0;
        });
    });

    await t.test("check supports degrade and info levels without failing by default", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());

            writeFile(
                ".aidw/lessons.json",
                `${JSON.stringify(
                    {
                        version: 2,
                        schema: {},
                        lessons: [
                            {
                                id: "L-tests_failed_degrade",
                                type: "tests_failed",
                                severity: "degrade",
                                scope: "repo",
                                pattern: "Recent tests failed (exit code != 0).",
                                fix: "Run: npm test",
                                active: true,
                                source: { eventId: "evt_test", from: "test" },
                            },
                            {
                                id: "L-tests_failed_info",
                                type: "tests_failed",
                                severity: "info",
                                scope: "repo",
                                pattern: "Recent tests failed (exit code != 0).",
                                fix: "Run: npm test",
                                active: false,
                                source: { eventId: "evt_test", from: "test" },
                            },
                        ],
                    },
                    null,
                    4,
                )}\n`,
            );

            writeFile(
                ".aidw/context-loop.jsonl",
                `${JSON.stringify({
                    at: new Date().toISOString(),
                    type: "test",
                    ok: false,
                    exitCode: 1,
                    command: "npm test",
                })}\n`,
            );

            process.exitCode = 0;
            const { output } = await withCapturedConsole(() => runCliMain(["check"]));
            const text = output.join("\n");

            assert.equal(process.exitCode ?? 0, 0);
            assert.match(text, /Check Warnings/);
            assert.match(text, /\[degrade\]/);

            process.exitCode = 0;
        });
    });

    await t.test("loop run is a safe alias and does not execute commands", async () => {
        process.exitCode = 0;
        const { output } = await withCapturedConsole(() => runCliMain(["loop", "run"]));
        const text = output.join("\n");

        assert.equal(process.exitCode ?? 0, 0);
        assert.match(text, /# Context Loop Run/);
        assert.match(text, /status: noop/);
        assert.match(text, /# Context Loop Report/);
        process.exitCode = 0;
    });

    await t.test("gate blocks confirming tests before task", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            process.exitCode = 0;

            const { output } = await withCapturedConsole(() => runGate(["confirm", "tests", "T-001"]));

            assert.equal(process.exitCode, 1);
            assert.match(output.join("\n"), /Task must be confirmed before confirming tests/i);
            process.exitCode = 0;
        });
    });

    await t.test("gate confirm task outputs json token", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            process.exitCode = 0;

            const { output } = await withCapturedConsole(() =>
                runGate(["confirm", "task", "T-001", "--json"]),
            );

            assert.equal(process.exitCode, 0);
            const parsed = JSON.parse(output.join("\n"));
            assert.equal(parsed.ok, true);
            assert.match(parsed.token, /^[a-f0-9]{32}$/i);
            assert.equal(parsed.state.active.taskId, "T-001");
            process.exitCode = 0;
        });
    });

    await t.test("gate run-test requires token", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            process.exitCode = 0;

            const { output } = await withCapturedConsole(() =>
                runGate(["run-test", "T-001"]),
            );

            assert.equal(process.exitCode, 1);
            assert.match(output.join("\n"), /Missing gate token/i);
            process.exitCode = 0;
        });
    });

    await t.test("README highlights the primary workflow and moves other commands to advanced/internal", async () => {
        const readme = fs.readFileSync(path.resolve(originalCwd, "README.md"), "utf-8");

        assert.match(readme, /Bounded AI Development Runtime for AI Coding Tools/);
        assert.match(
            readme,
            /repo-context-kit helps AI coding tools work inside controlled, inspectable, replayable development workflows\./,
        );
        assert.match(readme, /## Quick Start/);
        assert.match(readme, /npx repo-context-kit init/);
        assert.match(readme, /npx repo-context-kit scan/);
        assert.match(readme, /npx repo-context-kit auto --goal "Add auth"/);
        assert.match(readme, /## Why/);
        assert.match(readme, /Context explosion/);
        assert.match(readme, /Bounded context selection/);
        assert.match(readme, /## Workflow/);
        assert.match(readme, /goal → task → workset → runtime contract → risks → snapshots → explainability/);
        assert.match(readme, /## Safety Boundaries/);
        assert.match(readme, /does NOT auto-edit source code/);
        assert.match(readme, /## Runtime Architecture/);
        assert.match(readme, /\[docs\/runtime-architecture\.md\]/);
        assert.match(readme, /## MCP Runtime Interface/);
    });

    await t.test("ui server serves static site and lists managed files", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile("task/T-001-ui-task.md", "# T-001 UI Task\n");

            await withUiServer(async (url) => {
                const page = await fetch(`${url}/`);
                assert.equal(page.status, 200);
                assert.match(await page.text(), /repo-context-kit Console/);

                const files = await fetch(`${url}/api/files`);
                assert.equal(files.status, 200);
                assert.deepEqual(await files.json(), {
                    project: ".aidw/project.md",
                    managed: [
                        "AGENTS.md",
                        ".aidw/project.md",
                        ".aidw/rules.md",
                        ".aidw/task-entry.md",
                        ".aidw/confirmation-protocol.md",
                        ".aidw/context-budget-policy.md",
                        ".aidw/workflow.md",
                        ".aidw/safety.md",
                        ".aidw/system-overview.md",
                        ".aidw/confirmation-gate.json",
                        ".aidw/context-loop.jsonl",
                        ".aidw/context-cache.md",
                        "examples/task-example.md",
                        "task/task.md",
                    ],
                    example: "examples/task-example.md",
                    tasks: ["task/T-001-ui-task.md"],
                    registry: "task/task.md",
                });
            });
        });
    });

    await t.test("ui frontend keeps developer console structure", async () => {
        const siteHtml = fs.readFileSync(
            path.resolve(originalCwd, "site/index.html"),
            "utf-8",
        );

        assert.match(siteHtml, /class="app-shell"/);
        assert.match(siteHtml, /class="sidebar"/);
        assert.match(siteHtml, /data-view="commands">Commands/);
        assert.match(siteHtml, /data-view="files">Files/);
        assert.match(siteHtml, /data-view="tasks">Tasks/);
        assert.match(siteHtml, /Task example/);
        assert.match(siteHtml, /id="view-task-example"/);
        assert.doesNotMatch(siteHtml, /data-view="logs"/);
        assert.match(siteHtml, /id="commands-panel"[\s\S]*id="log-output"/);
        assert.doesNotMatch(siteHtml, /id="logs-panel"/);
    });

    await t.test("ui file API only reads whitelisted managed markdown files", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile("package.json", JSON.stringify({ name: "private-project" }));

            await withUiServer(async (url) => {
                const allowed = await fetch(
                    `${url}/api/file?path=${encodeURIComponent(".aidw/project.md")}`,
                );
                assert.equal(allowed.status, 200);
                assert.match((await allowed.json()).content, /# Project Context/);

                const example = await fetch(
                    `${url}/api/file?path=${encodeURIComponent("examples/task-example.md")}`,
                );
                assert.equal(example.status, 200);
                assert.match((await example.json()).content, /# Task Example/);

                const agents = await fetch(
                    `${url}/api/file?path=${encodeURIComponent("AGENTS.md")}`,
                );
                assert.equal(agents.status, 200);
                assert.match((await agents.json()).content, /single workflow entry point/i);

                const traversal = await fetch(
                    `${url}/api/file?path=${encodeURIComponent("../package.json")}`,
                );
                assert.equal(traversal.status, 403);

                const unlisted = await fetch(
                    `${url}/api/file?path=${encodeURIComponent("package.json")}`,
                );
                assert.equal(unlisted.status, 403);
            });
        });
    });

    await t.test("ui run API validates actions and streams whitelisted command logs", async () => {
        await withTempProject(async () => {
            await withUiServer(async (url) => {
                const rejected = await fetch(`${url}/api/run`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ action: "npm-test" }),
                });
                assert.equal(rejected.status, 400);

                const titleRejected = await fetch(`${url}/api/run`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        action: "task-new",
                        payload: { title: "Bad\nTitle" },
                    }),
                });
                assert.equal(titleRejected.status, 400);

                const init = await fetch(`${url}/api/run`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ action: "init" }),
                });
                assert.equal(init.status, 200);

                const events = await readNdjson(init);
                assert.equal(events[0].type, "start");
                assert.equal(events[0].command, "repo-context-kit init");
                assert.equal(events.at(-1).type, "exit");
                assert.equal(events.at(-1).ok, true);
                assert.ok(fs.existsSync(".aidw/project.md"));
            });
        });
    });

    await t.test("scan creates AI system overview with sources and indexes", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));
            writeFile("bin/cli.js", "#!/usr/bin/env node\n");
            writeFile("task/01-feature.md", "# Feature task\n");
            writeFile("task/02-fix.md", "# Fix task\n");

            const { output, result } = await withCapturedConsole(() => runScan());
            const overview = fs.readFileSync(".aidw/system-overview.md", "utf-8");

            assert.ok(fs.existsSync(".aidw/system-overview.md"));
            assert.ok(result.updatedFiles.includes(".aidw/system-overview.md"));
            assert.match(
                output.join("\n"),
                /\* Updated \.aidw\/system-overview\.md/,
            );
            assert.match(overview, /# AI System Overview/);
            assert.match(overview, /## Context Sources/);
            assert.match(overview, /`\.aidw\/project\.md` - status: present/);
            assert.match(overview, /`\.aidw\/index\/summary\.json` - status: present/);
            assert.match(overview, /## Rule Sources/);
            assert.match(overview, /`AGENTS\.md` - status: present/);
            assert.match(overview, /`\.aidw\/rules\.md` - status: present/);
            assert.match(overview, /`\.aidw\/workflow\.md` - status: present/);
            assert.match(overview, /`\.aidw\/safety\.md` - status: present/);
            assert.match(overview, /## Task Health/);
            assert.match(overview, /Task count: 2/);
            assert.match(overview, /Tasks with acceptance criteria: 0/);
            assert.match(overview, /## Task Registry/);
            assert.match(overview, /Registry file: task\/task\.md \(present\)/);
            assert.match(overview, /Total tasks: 0/);
            assert.match(overview, /todo: 0/);
            assert.match(overview, /tasks with acceptance criteria: 0 \/ 2/);
            assert.match(overview, /## Generated Indexes/);
            assert.match(overview, /`\.aidw\/index\/entrypoints\.json` - status: present/);
            assert.match(overview, /## AI Tool Adapters/);
            assert.match(overview, /`\.github\/copilot-instructions\.md` - status: present/);
            assert.match(overview, /`\.trae\/rules\/project_rules\.md` - status: present/);
            assert.match(overview, /Markdown task files \(2 detected\)/);
            assert.match(overview, /`task\/01-feature\.md`/);
            assert.match(overview, /`task\/02-fix\.md`/);
        });
    });

    await t.test("scan writes task file metadata into task index", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));
            writeFile(
                "task/T-001-add-receipt-evidence-api.md",
                `# T-001 Add Receipt Evidence API

## Acceptance Criteria

- Works

## Test Command

\`\`\`bash
npm test
\`\`\`

## Definition of Done

- Done
`,
            );

            await withMutedConsole(() => runScan());

            const taskMap = JSON.parse(
                fs.readFileSync(".aidw/context/tasks.json", "utf-8"),
            );
            const task = taskMap.find(
                (entry) => entry.path === "task/T-001-add-receipt-evidence-api.md",
            );

            assert.equal(task.id, "T-001");
            assert.equal(task.title, "Add Receipt Evidence API");
            assert.deepEqual(task.files, ["task/T-001-add-receipt-evidence-api.md"]);
            assert.equal(task.hasAcceptanceCriteria, true);
            assert.equal(task.hasTestCommand, true);
            assert.equal(task.hasDefinitionOfDone, true);
            assert.equal(task.source, "task-file");
        });
    });

    await t.test("scan merges task registry fields with task file metadata", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Add Receipt API | in_progress | high | Wilson | T-000 | [T-001](./T-001-add-receipt-api.md) |
`,
            );
            writeFile(
                "task/T-001-add-receipt-api.md",
                `# T-001 Add Receipt API

## Acceptance Criteria

- Works

## Test Command

\`\`\`bash
npm test
\`\`\`

## Definition of Done

- Done
`,
            );

            await withMutedConsole(() => runScan());

            const taskMap = JSON.parse(
                fs.readFileSync(".aidw/context/tasks.json", "utf-8"),
            );
            const task = taskMap.find((entry) => entry.id === "T-001");

            assert.equal(task.title, "Add Receipt API");
            assert.equal(task.status, "in_progress");
            assert.equal(task.priority, "high");
            assert.equal(task.owner, "Wilson");
            assert.equal(task.dependencies, "T-000");
            assert.equal(task.file, "task/T-001-add-receipt-api.md");
            assert.equal(task.hasAcceptanceCriteria, true);
            assert.equal(task.hasTestCommand, true);
            assert.equal(task.hasDefinitionOfDone, true);
        });
    });

    await t.test("system overview marks optional files as missing", async () => {
        await withTempProject(async () => {
            writeContextProject(`# Project Context

<!-- AUTO-GENERATED START -->
seed
<!-- AUTO-GENERATED END -->
`);
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));

            await withMutedConsole(() => runScan());

            const overview = fs.readFileSync(".aidw/system-overview.md", "utf-8");

            assert.match(overview, /`AGENTS\.md` - status: missing/);
            assert.match(overview, /`\.aidw\/workflow\.md` - status: missing/);
            assert.match(overview, /`\.aidw\/safety\.md` - status: missing/);
            assert.match(overview, /`\.github\/copilot-instructions\.md` - status: missing/);
            assert.match(overview, /`\.trae\/rules\/project_rules\.md` - status: missing/);
            assert.match(overview, /`skill\.md` - status: missing/);
            assert.match(overview, /`\.aidw\/task-entry\.md` - status: missing/);
            assert.match(overview, /`task\/\*\.md` - status: missing/);
        });
    });

    await t.test("system overview lists up to ten task markdown files", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));

            for (let index = 1; index <= 11; index += 1) {
                writeFile(
                    `task/${String(index).padStart(2, "0")}-task.md`,
                    `# Task ${index}\n`,
                );
            }

            await withMutedConsole(() => runScan());

            const overview = fs.readFileSync(".aidw/system-overview.md", "utf-8");

            assert.match(overview, /Markdown task files \(11 detected\)/);
            assert.match(overview, /`task\/01-task\.md`/);
            assert.match(overview, /`task\/10-task\.md`/);
            assert.doesNotMatch(overview, /`task\/11-task\.md`/);
        });
    });

    await t.test("scan check fails when system overview is missing or outdated", async () => {
        await withTempProject(async () => {
            process.exitCode = 0;
            await withMutedConsole(() => runInit());
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));

            await withMutedConsole(() => runScan());
            fs.unlinkSync(".aidw/system-overview.md");

            const missing = await withCapturedConsole(() =>
                runScan({ mode: "check" }),
            );

            assert.equal(process.exitCode, 1);
            assert.equal(missing.result.changed, true);
            assert.match(
                missing.output.join("\n"),
                /\.aidw\/system-overview\.md is missing or out of date/,
            );

            process.exitCode = 0;
            await withMutedConsole(() => runScan());
            writeFile(".aidw/system-overview.md", "stale\n");

            const stale = await withCapturedConsole(() =>
                runScan({ mode: "check" }),
            );

            assert.equal(process.exitCode, 1);
            assert.equal(stale.result.changed, true);
            assert.match(
                stale.output.join("\n"),
                /\.aidw\/system-overview\.md is missing or out of date/,
            );
            process.exitCode = 0;
        });
    });

    await t.test("scan check fails when task metadata is stale", async () => {
        await withTempProject(async () => {
            process.exitCode = 0;
            await withMutedConsole(() => runInit());
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));

            await withMutedConsole(() => runScan());
            writeFile(
                "task/T-001-new-task.md",
                `# T-001 New Task

## Acceptance Criteria

- Works

## Test Command

\`\`\`bash
npm test
\`\`\`

## Definition of Done

- Done
`,
            );

            const { output, result } = await withCapturedConsole(() =>
                runScan({ mode: "check" }),
            );

            assert.equal(process.exitCode, 1);
            assert.equal(result.changed, true);
            assert.match(
                output.join("\n"),
                /\.aidw\/context\/tasks\.json is missing or out of date/,
            );
            process.exitCode = 0;
        });
    });

    await t.test("scan warns on task registry mismatch", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));
            writeFile(
                "task/T-001-unregistered.md",
                `# T-001 Unregistered

## Acceptance Criteria

- Works
`,
            );

            const { output, result } = await withCapturedConsole(() => runScan());

            assert.equal(process.exitCode ?? 0, 0);
            assert.ok(
                result.warnings.some((warning) =>
                    warning.includes("task/T-001-unregistered.md exists but is not listed"),
                ),
            );
            assert.match(output.join("\n"), /Warnings:/);
            assert.match(output.join("\n"), /task\/T-001-unregistered\.md exists but is not listed/);
        });
    });

    await t.test("scan check fails on task registry mismatch", async () => {
        await withTempProject(async () => {
            process.exitCode = 0;
            await withMutedConsole(() => runInit());
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));
            writeFile(
                "task/T-001-unregistered.md",
                `# T-001 Unregistered

## Acceptance Criteria

- Works
`,
            );

            const { output, result } = await withCapturedConsole(() =>
                runScan({ mode: "check" }),
            );

            assert.equal(process.exitCode, 1);
            assert.equal(result.changed, true);
            assert.match(output.join("\n"), /task registry and task files are inconsistent/);
            assert.match(output.join("\n"), /task\/T-001-unregistered\.md exists but is not listed/);
            process.exitCode = 0;
        });
    });

    await t.test("scan check fails when task registry is missing but task files exist", async () => {
        await withTempProject(async () => {
            process.exitCode = 0;
            writeContextProject(`# Project Context

<!-- AUTO-GENERATED START -->
seed
<!-- AUTO-GENERATED END -->
`);
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));
            writeFile(
                "task/T-001-missing-registry.md",
                `# T-001 Missing Registry

## Acceptance Criteria

- Works
`,
            );

            const { output, result } = await withCapturedConsole(() =>
                runScan({ mode: "check" }),
            );

            assert.equal(process.exitCode, 1);
            assert.equal(result.changed, true);
            assert.match(output.join("\n"), /task\/task\.md is missing but task files exist/);
            process.exitCode = 0;
        });
    });

    await t.test("scan does not rewrite unchanged index files", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));
            writeFile("bin/cli.js", "#!/usr/bin/env node\nexport function main() {}\n");

            await withMutedConsole(() => runScan());
            const filesBefore = fs.readFileSync(".aidw/index/files.json", "utf-8");
            const symbolsBefore = fs.readFileSync(".aidw/index/symbols.json", "utf-8");
            const entrypointsBefore = fs.readFileSync(
                ".aidw/index/entrypoints.json",
                "utf-8",
            );
            const fileGroupsBefore = fs.readFileSync(
                ".aidw/index/file-groups.json",
                "utf-8",
            );
            const summaryBefore = fs.readFileSync(".aidw/index/summary.json", "utf-8");
            const systemOverviewBefore = fs.readFileSync(
                ".aidw/system-overview.md",
                "utf-8",
            );
            const tasksBefore = fs.readFileSync(".aidw/context/tasks.json", "utf-8");

            await withMutedConsole(() => runScan());

            assert.equal(
                fs.readFileSync(".aidw/index/files.json", "utf-8"),
                filesBefore,
            );
            assert.equal(
                fs.readFileSync(".aidw/index/symbols.json", "utf-8"),
                symbolsBefore,
            );
            assert.equal(
                fs.readFileSync(".aidw/index/entrypoints.json", "utf-8"),
                entrypointsBefore,
            );
            assert.equal(
                fs.readFileSync(".aidw/index/file-groups.json", "utf-8"),
                fileGroupsBefore,
            );
            assert.equal(
                fs.readFileSync(".aidw/index/summary.json", "utf-8"),
                summaryBefore,
            );
            assert.equal(
                fs.readFileSync(".aidw/system-overview.md", "utf-8"),
                systemOverviewBefore,
            );
            assert.equal(fs.readFileSync(".aidw/context/tasks.json", "utf-8"), tasksBefore);
        });
    });

    await t.test("scan removes stale index records for deleted source files", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile(
                "package.json",
                JSON.stringify({
                    name: "scan-target",
                    bin: {
                        "scan-target": "bin/cli.js",
                    },
                }),
            );
            writeFile("bin/cli.js", "#!/usr/bin/env node\nexport function main() {}\n");
            writeFile(
                "src/scan/context.js",
                "export function validateContext() { return { ok: true }; }\n",
            );

            await withMutedConsole(() => runScan());
            fs.unlinkSync("src/scan/context.js");
            await withMutedConsole(() => runScan());

            const fileIndex = JSON.parse(
                fs.readFileSync(".aidw/index/files.json", "utf-8"),
            );
            const symbolIndex = JSON.parse(
                fs.readFileSync(".aidw/index/symbols.json", "utf-8"),
            );
            const taskMap = JSON.parse(
                fs.readFileSync(".aidw/context/tasks.json", "utf-8"),
            );
            const fileGroups = JSON.parse(
                fs.readFileSync(".aidw/index/file-groups.json", "utf-8"),
            );

            assert.equal(
                fileIndex.some((entry) => entry.path === "src/scan/context.js"),
                false,
            );
            assert.equal(
                symbolIndex.some((symbol) => symbol.file === "src/scan/context.js"),
                false,
            );
            assert.equal(
                taskMap.some((task) => task.files.includes("src/scan/context.js")),
                false,
            );
            assert.equal(
                fileGroups.some((group) =>
                    group.keyFiles.includes("src/scan/context.js"),
                ),
                false,
            );
            assert.equal(process.exitCode ?? 0, 0);
        });
    });

    await t.test("scan removes stale entrypoints for deleted files", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile(
                "package.json",
                JSON.stringify({
                    name: "scan-target",
                    bin: {
                        "scan-target": "bin/cli.js",
                    },
                }),
            );
            writeFile("bin/cli.js", "#!/usr/bin/env node\nexport function main() {}\n");

            await withMutedConsole(() => runScan());
            fs.unlinkSync("bin/cli.js");
            await withMutedConsole(() => runScan());

            const entrypointIndex = JSON.parse(
                fs.readFileSync(".aidw/index/entrypoints.json", "utf-8"),
            );

            assert.equal(
                entrypointIndex.some((entrypoint) => entrypoint.path === "bin/cli.js"),
                false,
            );
        });
    });

    await t.test("index size limits are enforced", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));
            writeFile("node_modules/ignored-package/index.js", "export function ignored() {}\n");
            writeFile("dist/ignored.js", "export function ignoredDist() {}\n");
            writeFile("coverage/ignored.js", "export function ignoredCoverage() {}\n");

            for (let index = 0; index < 240; index += 1) {
                writeFile(
                    `src/generated/file-${index}.js`,
                    `export function generatedSymbol${index}() { return ${index}; }\n`,
                );
            }
            for (let index = 0; index < 560; index += 1) {
                writeFile(
                    `bin/tool-${index}.js`,
                    `export function toolSymbol${index}() { return ${index}; }\n`,
                );
            }

            await withMutedConsole(() => runScan());

            const fileIndex = JSON.parse(
                fs.readFileSync(".aidw/index/files.json", "utf-8"),
            );
            const symbolIndex = JSON.parse(
                fs.readFileSync(".aidw/index/symbols.json", "utf-8"),
            );
            const taskMap = JSON.parse(
                fs.readFileSync(".aidw/context/tasks.json", "utf-8"),
            );
            const fileGroups = JSON.parse(
                fs.readFileSync(".aidw/index/file-groups.json", "utf-8"),
            );
            const summary = JSON.parse(
                fs.readFileSync(".aidw/index/summary.json", "utf-8"),
            );

            assert.ok(fileIndex.length <= 200);
            assert.ok(symbolIndex.length <= 500);
            assert.ok(fileGroups.length <= 80);
            assert.ok(taskMap.length <= 50);
            assert.equal(summary.indexedFiles, fileIndex.length);
            assert.equal(summary.indexedSymbols, symbolIndex.length);
            assert.equal(summary.fileGroups, fileGroups.length);
            assert.equal(summary.truncated, true);
            assert.ok(summary.totalFilesScanned > summary.indexedFiles);
            assert.ok(
                [...fileIndex, ...symbolIndex, ...taskMap].every((record) => {
                    const description = record.description ?? record.notes ?? "";

                    return description.length <= 120;
                }),
            );
            assert.equal(
                fileIndex.some((entry) => entry.path.startsWith("node_modules/")),
                false,
            );
            assert.equal(
                fileIndex.some((entry) => entry.path.startsWith("dist/")),
                false,
            );
            assert.equal(
                fileIndex.some((entry) => entry.path.startsWith("coverage/")),
                false,
            );
            assert.equal(
                fileIndex.some((entry) => entry.path.startsWith(".aidw/")),
                false,
            );
            assert.ok(
                fileGroups.every((group) =>
                    group.keyFiles.every((filePath) => fs.existsSync(filePath)),
                ),
            );
        });
    });

    await t.test("scan check returns up to date after scan", async () => {
        await withTempProject(async () => {
            process.exitCode = 0;
            await withMutedConsole(() => runInit());
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));
            writeFile("bin/cli.js", "#!/usr/bin/env node\n");

            await withMutedConsole(() => runScan());
            await withMutedConsole(() => runScan());
            const { output, result } = await withCapturedConsole(() =>
                runScan({ mode: "check" }),
            );

            assert.equal(result.changed, false);
            assert.equal(process.exitCode, 0);
            assert.match(output.join("\n"), /Project context is up to date/);
            assert.match(
                output.join("\n"),
                /Checked:\n\* \.aidw\/project\.md AUTO-GENERATED section/,
            );
        });
    });

    await t.test("scan auto prints no changes when up to date", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));
            writeFile("bin/cli.js", "#!/usr/bin/env node\n");

            await withMutedConsole(() => runScan());
            await withMutedConsole(() => runScan());
            const { output, result } = await withCapturedConsole(() =>
                runScan({ mode: "auto" }),
            );

            assert.equal(result.changed, false);
            assert.deepEqual(result.updatedFiles, []);
            assert.match(output.join("\n"), /Project scan completed/);
            assert.match(output.join("\n"), /Changes:\n\* No changes/);
            assert.match(output.join("\n"), /Mode:\n\* auto/);
        });
    });

    await t.test("default scan prints no changes when up to date", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));
            writeFile("bin/cli.js", "#!/usr/bin/env node\n");

            await withMutedConsole(() => runScan());
            await withMutedConsole(() => runScan());
            const { output, result } = await withCapturedConsole(() => runScan());

            assert.equal(result.changed, false);
            assert.deepEqual(result.updatedFiles, []);
            assert.match(output.join("\n"), /Project scan completed/);
            assert.match(output.join("\n"), /Changes:\n\* No changes/);
        });
    });

    await t.test("context brief does not dump large indexes", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));
            writeFile(
                ".aidw/index/summary.json",
                JSON.stringify({ indexedFiles: 1, indexedSymbols: 1 }, null, 4),
            );
            writeFile(
                ".aidw/index/files.json",
                JSON.stringify([{ path: "src/secret.js", description: "SHOULD_NOT_DUMP" }]),
            );
            writeFile(
                ".aidw/index/symbols.json",
                JSON.stringify([{ name: "ShouldNotDump", file: "src/secret.js" }]),
            );

            const { output } = await withCapturedConsole(() => runContext(["brief"]));
            const text = output.join("\n");

            assert.match(text, /Project Context Brief/);
            assert.match(text, /Context Meta/);
            assert.doesNotMatch(text, /SHOULD_NOT_DUMP/);
            assert.doesNotMatch(text, /ShouldNotDump/);
        });
    });

    await t.test("context workset --compact keeps bounded output and prints context meta", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Compact Workset | todo | medium | - | - | [T-001](./T-001-compact-workset.md) |
`,
            );
            writeFile("task/T-001-compact-workset.md", "# T-001 Compact Workset\n\n## Goal\n\nStay compact.\n");
            writeFile(".aidw/index/files.json", "[]\n");
            writeFile(".aidw/index/symbols.json", "[]\n");

            const { output } = await withCapturedConsole(() =>
                runContext(["workset", "T-001", "--compact"]),
            );
            const text = output.join("\n");

            assert.match(text, /# Workset Context \(Digest\)/);
            assert.match(text, /## Context Meta/);
            assert.match(text, /included sources:/);
        });
    });

    await t.test("context brief --budget auto upgrades on recent test failure", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));
            const loopLines = [
                JSON.stringify({
                    at: "2026-01-01T00:00:00.000Z",
                    type: "test",
                    taskId: "T-001",
                    ok: false,
                    exitCode: 1,
                    command: "npm test",
                }),
                ...Array.from({ length: 150 }, (_, index) =>
                    JSON.stringify({
                        at: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
                        type: "budget_decision",
                        mode: "auto",
                        decision: "DEFAULT",
                        confidence: 0.2,
                        confidenceLevel: "LOW",
                        reasonCodes: [],
                        evidence: [],
                    }),
                ),
            ];
            writeFile(".aidw/context-loop.jsonl", `${loopLines.join("\n")}\n`);

            const { output } = await withCapturedConsole(() =>
                runContext(["brief", "--budget", "auto"]),
            );
            const text = output.join("\n");

            assert.match(text, /## Budget Decision/);
            assert.match(text, /decision: EXCEPTION/);
            assert.match(text, /confidence: (HIGH|MEDIUM|LOW) \(\d\.\d\d\)/);
            assert.match(text, /Context Loop Digest/);
            assert.match(text, /Recent Context Loop \(Raw\)/);

            const loopText = fs.readFileSync(".aidw/context-loop.jsonl", "utf-8");
            const loopEvents = loopText
                .trim()
                .split("\n")
                .filter(Boolean)
                .map((line) => JSON.parse(line));
            assert.ok(
                loopEvents.some(
                    (event) => event?.type === "budget_decision" && event?.command === "brief",
                ),
            );
        });
    });

    await t.test("context next-task selects in-progress before todo and reads only selected detail file", async () => {
        await withTempProject(async () => {
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Todo Task | todo | medium | - | - | [T-001](./T-001-todo.md) |
| T-002 | Active Task | in_progress | high | - | - | [T-002](./T-002-active.md) |
`,
            );
            writeFile("task/T-001-todo.md", "# T-001 Todo Task\n\nUNSELECTED_DETAIL\n");
            writeFile(
                "task/T-002-active.md",
                `# T-002 Active Task

## Goal

SELECTED_DETAIL
`,
            );

            const { output } = await withCapturedConsole(() => runContext(["next-task"]));
            const text = output.join("\n");

            assert.match(text, /selected task id: T-002/);
            assert.match(text, /SELECTED_DETAIL/);
            assert.doesNotMatch(text, /UNSELECTED_DETAIL/);
        });
    });

    await t.test("context next-task skips done and blocked tasks", async () => {
        await withTempProject(async () => {
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Done Task | done | medium | - | - | [T-001](./T-001-done.md) |
| T-002 | Blocked Task | blocked | medium | - | - | [T-002](./T-002-blocked.md) |
| T-003 | Todo Task | todo | medium | - | - | [T-003](./T-003-todo.md) |
`,
            );
            writeFile("task/T-001-done.md", "# T-001 Done Task\n\nDONE_DETAIL\n");
            writeFile("task/T-002-blocked.md", "# T-002 Blocked Task\n\nBLOCKED_DETAIL\n");
            writeFile("task/T-003-todo.md", "# T-003 Todo Task\n\nTODO_DETAIL\n");

            const { output } = await withCapturedConsole(() => runContext(["next-task"]));
            const text = output.join("\n");

            assert.match(text, /selected task id: T-003/);
            assert.match(text, /TODO_DETAIL/);
            assert.doesNotMatch(text, /DONE_DETAIL/);
            assert.doesNotMatch(text, /BLOCKED_DETAIL/);
        });
    });

    await t.test("context next-task respects dependencies", async () => {
        await withTempProject(async () => {
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Dependency | todo | medium | - | - | [T-001](./T-001-dependency.md) |
| T-002 | Waiting Task | todo | medium | - | T-001 | [T-002](./T-002-waiting.md) |
| T-003 | Ready Task | todo | medium | - | - | [T-003](./T-003-ready.md) |
`,
            );
            writeFile("task/T-001-dependency.md", "# T-001 Dependency\n");
            writeFile("task/T-002-waiting.md", "# T-002 Waiting Task\n\nWAITING_DETAIL\n");
            writeFile("task/T-003-ready.md", "# T-003 Ready Task\n\nREADY_DETAIL\n");

            const { output } = await withCapturedConsole(() => runContext(["next-task"]));
            const text = output.join("\n");

            assert.match(text, /selected task id: T-001/);
            assert.doesNotMatch(text, /WAITING_DETAIL/);
        });
    });

    await t.test("context workset outputs bounded related files with reasons and confidence", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Add context command | todo | medium | - | - | [T-001](./T-001-context-command.md) |
`,
            );
            writeFile(
                "task/T-001-context-command.md",
                `# T-001 Add context command

## Goal

Add context command behavior in bin/cli.js and bin/context.js.

## Acceptance Criteria

- Tests cover context output.
`,
            );
            writeFile(
                ".aidw/index/files.json",
                JSON.stringify(
                    [
                        { path: "bin/cli.js", type: "entry", description: "CLI command parser", confidence: 0.9 },
                        { path: "bin/context.js", type: "entry", description: "Context command output", confidence: 0.8 },
                        { path: "src/unrelated.js", type: "source", description: "Unrelated module", confidence: 0.7 },
                    ],
                    null,
                    4,
                ),
            );
            writeFile(
                ".aidw/index/symbols.json",
                JSON.stringify(
                    [
                        { name: "runContext", type: "function", file: "bin/context.js", description: "Runs context command", confidence: 0.8 },
                        { name: "unrelated", type: "function", file: "src/unrelated.js", description: "Other code", confidence: 0.8 },
                    ],
                    null,
                    4,
                ),
            );
            writeFile(
                ".aidw/index/entrypoints.json",
                JSON.stringify([{ name: "CLI entry", path: "bin/cli.js", confidence: 0.9 }], null, 4),
            );
            writeFile(
                ".aidw/index/file-groups.json",
                JSON.stringify([{ path: "bin", keyFiles: ["bin/cli.js", "bin/context.js"] }], null, 4),
            );
            writeFile(".aidw/index/summary.json", JSON.stringify({ indexedFiles: 3 }, null, 4));

            const { output } = await withCapturedConsole(() =>
                runContext(["workset", "T-001"]),
            );
            const text = output.join("\n");

            assert.match(text, /Related File Candidates/);
            assert.match(text, /bin\/cli\.js \(confidence/);
            assert.match(text, /reason|matched task keywords|mentioned in task detail/);
            assert.match(text, /runContext \(function\) in bin\/context\.js \(confidence/);
            assert.ok(text.length <= 16000);
        });
    });

    await t.test("context workset invalid task exits 1", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Only Task | todo | medium | - | - | [T-001](./T-001-only.md) |
`,
            );
            writeFile("task/T-001-only.md", "# T-001 Only Task\n");

            process.exitCode = 0;
            const { output } = await withCapturedConsole(() => runContext(["workset", "T-999"]));
            assert.equal(process.exitCode, 1);
            assert.match(output.join("\n"), /Task not found/i);
            process.exitCode = 0;
        });
    });

    await t.test("context warns for missing index files and missing task registry", async () => {
        await withTempProject(async () => {
            writeFile("task/T-001-orphan.md", "# T-001 Orphan\n");

            const brief = await withCapturedConsole(() => runContext(["brief"]));
            const workset = await withCapturedConsole(() =>
                runContext(["workset", "T-001"]),
            );
            const text = [brief.output.join("\n"), workset.output.join("\n")].join("\n");

            assert.match(text, /\.aidw\/index\/summary\.json is missing/);
            assert.match(text, /task\/task\.md is missing but task files exist/);
            assert.match(text, /No task registry is available/);
        });
    });

    await t.test("context next-task warns when selected task detail file is missing", async () => {
        await withTempProject(async () => {
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Missing Detail | in_progress | medium | - | - | [T-001](./T-001-missing.md) |
`,
            );

            const { output } = await withCapturedConsole(() => runContext(["next-task"]));
            const text = output.join("\n");

            assert.match(text, /selected task id: T-001/);
            assert.match(text, /Selected task detail file is missing: task\/T-001-missing\.md/);
        });
    });

    await t.test("context workset --deep increases limits but remains bounded", async () => {
        await withTempProject(async () => {
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Context file task | todo | medium | - | - | [T-001](./T-001-context-file.md) |
`,
            );
            writeFile("task/T-001-context-file.md", "# T-001 Context File Task\n\n## Goal\n\nUpdate context files.\n");
            writeFile(
                ".aidw/index/files.json",
                JSON.stringify(
                    Array.from({ length: 30 }, (_, index) => ({
                        path: `src/context/file-${index}.js`,
                        type: "source",
                        description: "Context file candidate",
                        confidence: 0.7,
                    })),
                    null,
                    4,
                ),
            );
            writeFile(".aidw/index/symbols.json", "[]\n");

            const normal = await withCapturedConsole(() =>
                runContext(["workset", "T-001"]),
            );
            const deep = await withCapturedConsole(() =>
                runContext(["workset", "T-001", "--deep"]),
            );
            const normalText = normal.output.join("\n");
            const deepText = deep.output.join("\n");

            assert.match(normalText, /level: workset --digest/);
            assert.match(normalText, /maxRelatedFiles=6/);
            assert.match(deepText, /level: workset --deep/);
            assert.match(deepText, /maxRelatedFiles=24/);
            assert.ok(deepText.length <= 24000);
        });
    });

    await t.test("context workset includes capped file summary references when index is present", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Summary task | todo | medium | - | - | [T-001](./T-001-summary-task.md) |
`,
            );
            writeFile(
                "task/T-001-summary-task.md",
                `# T-001 Summary task

## Goal

Verify file summary references are included and capped.

## Scope

Allowed:
- src/a.js
- src/b.js
- src/c.js
- src/d.js
- src/e.js
`,
            );

            writeFile(
                ".aidw/index/files.json",
                JSON.stringify(
                    ["src/a.js", "src/b.js", "src/c.js", "src/d.js", "src/e.js"].map((filePath) => ({
                        path: filePath,
                        type: "source",
                        description: "Candidate file",
                        confidence: 0.7,
                    })),
                    null,
                    4,
                ) + "\n",
            );
            writeFile(".aidw/index/symbols.json", "[]\n");
            writeFile(".aidw/index/entrypoints.json", "[]\n");
            writeFile(".aidw/index/file-groups.json", "[]\n");
            writeFile(".aidw/index/summary.json", JSON.stringify({ generatedAt: "2026-01-01T00:00:00.000Z" }, null, 4) + "\n");
            writeFile(
                ".aidw/index/file-summaries.json",
                JSON.stringify(
                    [
                        ...["src/a.js", "src/b.js", "src/c.js", "src/d.js", "src/e.js"].map((filePath) => ({
                            path: filePath,
                            roleSummary: "A very long summary ".repeat(40),
                            exports: [{ name: "runThing", type: "function" }],
                            keySymbols: [{ name: "runThing", type: "function", exported: true }],
                            imports: ["fs"],
                            calls: ["fs.writeFileSync", "child_process.spawn"],
                            risks: ["fs-write", "exec"],
                            updatedAt: "2026-01-01T00:00:00.000Z",
                        })),
                        {
                            path: "src/unused.js",
                            roleSummary: "Should not appear",
                            exports: [{ name: "unused", type: "function" }],
                            keySymbols: [],
                            imports: [],
                            calls: [],
                            risks: [],
                            updatedAt: "2026-01-01T00:00:00.000Z",
                        },
                    ],
                    null,
                    4,
                ) + "\n",
            );

            const { output } = await withCapturedConsole(() =>
                runContext(["workset", "T-001", "--digest"]),
            );
            const text = output.join("\n");

            const sectionMatch = text.match(
                /## File Summary References\s*\n\n(?<body>[\s\S]*?)(?=\n##\s+|$)/,
            );
            assert.ok(sectionMatch?.groups?.body);
            const section = sectionMatch.groups.body;

            assert.match(section, /src\/a\.js/);
            assert.match(section, /src\/b\.js/);
            assert.doesNotMatch(section, /src\/e\.js/);
            assert.doesNotMatch(section, /src\/unused\.js/);
            assert.match(section, /\[truncated\]/);
            const itemCount = (section.match(/^- src\//gm) ?? []).length;
            assert.ok(itemCount <= 4);
        });
    });

    await t.test("task prompt outputs implementation prompt with task metadata and detail", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Add prompt command | todo | high | dev | - | [T-001](./T-001-prompt-command.md) |
`,
            );
            writeFile(
                "task/T-001-prompt-command.md",
                `# T-001 Add Prompt Command

## Goal

Generate AI-ready prompts.

## Acceptance Criteria

- Prompt includes task metadata.
`,
            );
            writeFile(".aidw/index/files.json", "[]\n");
            writeFile(".aidw/index/symbols.json", "[]\n");

            const { output } = await withCapturedConsole(() =>
                runTask(["prompt", "T-001"]),
            );
            const text = output.join("\n");

            assert.match(text, /# Task Implementation Prompt/);
            assert.match(text, /## Role/);
            assert.match(text, /## Task/);
            assert.match(text, /- id: T-001/);
            assert.match(text, /- title: Add prompt command/);
            assert.match(text, /- priority: high/);
            assert.match(text, /- owner: dev/);
            assert.match(text, /Generate AI-ready prompts/);
            assert.match(text, /## Hard Boundaries/);
            assert.match(text, /## Confirmation Points/);
            assert.match(text, /## Required Final Response Format/);
            assert.match(text, /included sources: 3/);
            assert.match(text, /excluded sources:/);
        });
    });

    await t.test("task prompt includes default hard boundaries and warnings when missing in task detail", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Missing boundaries | todo | medium | - | - | [T-001](./T-001-missing-boundaries.md) |
`,
            );
            writeFile(
                "task/T-001-missing-boundaries.md",
                `# T-001 Missing boundaries

## Goal

Ensure prompt still includes guardrails.
`,
            );
            writeFile(".aidw/index/files.json", "[]\n");
            writeFile(".aidw/index/symbols.json", "[]\n");

            const { output } = await withCapturedConsole(() =>
                runTask(["prompt", "T-001"]),
            );
            const text = output.join("\n");

            assert.match(text, /## Hard Boundaries/);
            assert.match(text, /Do not run commands/);
            assert.match(text, /## Confirmation Points/);
            assert.match(text, /Confirm scope and planned approach/);
            assert.match(text, /## Warnings/);
            assert.match(text, /Task detail missing "Hard Boundaries" section; using defaults\./);
            assert.match(text, /Task detail missing "Confirmation Points" section; using defaults\./);
        });
    });

    await t.test("task prompt --budget auto defaults to compact and upgrades on failing tests", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Budget task | todo | high | dev | - | [T-001](./T-001-budget.md) |
`,
            );
            writeFile(
                "task/T-001-budget.md",
                `# T-001 Budget task

## Goal

Confirm budget policy upgrades.
`,
            );
            writeFile(".aidw/index/files.json", "[]\n");
            writeFile(".aidw/index/symbols.json", "[]\n");
            writeFile(
                ".aidw/context-loop.jsonl",
                `${JSON.stringify({
                    at: "2026-01-01T00:00:00.000Z",
                    type: "test",
                    taskId: "T-001",
                    ok: false,
                    exitCode: 1,
                    command: "npm test",
                })}\n`,
            );

            const { output } = await withCapturedConsole(() =>
                runTask(["prompt", "T-001", "--budget", "auto"]),
            );
            const text = output.join("\n");

            assert.match(text, /## Rules/);
            assert.match(text, /## Context Loop Signals/);
            assert.match(text, /## Budget Decision/);
            assert.match(text, /decision: EXCEPTION/);
            assert.match(text, /confidence: (HIGH|MEDIUM|LOW) \(\d\.\d\d\)/);

            const loopText = fs.readFileSync(".aidw/context-loop.jsonl", "utf-8");
            assert.match(loopText, /"type":"budget_decision"/);
            assert.match(loopText, /"confidence":\d(?:\.\d+)?/);
        });
    });

    await t.test("task prompt includes workset-related files with reasons and confidence", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Add context command | todo | medium | - | - | [T-001](./T-001-context-command.md) |
`,
            );
            writeFile(
                "task/T-001-context-command.md",
                `# T-001 Add context command

## Goal

Add context command behavior in bin/cli.js and bin/context.js.
`,
            );
            writeFile(
                ".aidw/index/files.json",
                JSON.stringify(
                    [
                        { path: "bin/cli.js", type: "entry", description: "CLI command parser", confidence: 0.9 },
                        { path: "bin/context.js", type: "entry", description: "Context command output", confidence: 0.8 },
                    ],
                    null,
                    4,
                ),
            );
            writeFile(
                ".aidw/index/symbols.json",
                JSON.stringify(
                    [{ name: "runContext", type: "function", file: "bin/context.js", description: "Runs context command", confidence: 0.8 }],
                    null,
                    4,
                ),
            );
            writeFile(
                ".aidw/index/entrypoints.json",
                JSON.stringify([{ name: "CLI entry", path: "bin/cli.js", confidence: 0.9 }], null, 4),
            );
            writeFile(
                ".aidw/index/file-groups.json",
                JSON.stringify([{ path: "bin", keyFiles: ["bin/cli.js", "bin/context.js"] }], null, 4),
            );
            writeFile(".aidw/index/summary.json", JSON.stringify({ indexedFiles: 2 }, null, 4));

            const { output } = await withCapturedConsole(() =>
                runTask(["prompt", "T-001"]),
            );
            const text = output.join("\n");

            assert.match(text, /## Relevant Workset/);
            assert.match(text, /bin\/cli\.js \(confidence/);
            assert.match(text, /matched task keywords|mentioned in task detail/);
            assert.match(text, /runContext \(function\) in bin\/context\.js \(confidence/);
        });
    });

    await t.test("task prompt does not dump entire indexes and stays bounded", async () => {
        await withTempProject(async () => {
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Prompt task | todo | medium | - | - | [T-001](./T-001-prompt.md) |
`,
            );
            writeFile("task/T-001-prompt.md", "# T-001 Prompt Task\n\n## Goal\n\nCreate prompt output.\n");
            writeFile(
                ".aidw/index/files.json",
                JSON.stringify(
                    [
                        { path: "src/prompt.js", type: "source", description: "Prompt output", confidence: 0.8 },
                        { path: "src/secret.js", type: "source", description: "SHOULD_NOT_DUMP", confidence: 0.8 },
                    ],
                    null,
                    4,
                ),
            );
            writeFile(
                ".aidw/index/symbols.json",
                JSON.stringify(
                    [
                        { name: "buildPrompt", type: "function", file: "src/prompt.js", description: "Prompt output", confidence: 0.8 },
                        { name: "ShouldNotDump", type: "function", file: "src/secret.js", description: "Secret", confidence: 0.8 },
                    ],
                    null,
                    4,
                ),
            );

            const { output } = await withCapturedConsole(() =>
                runTask(["prompt", "T-001"]),
            );
            const text = output.join("\n");

            assert.ok(text.length <= 20000);
            assert.doesNotMatch(text, /SHOULD_NOT_DUMP/);
            assert.doesNotMatch(text, /ShouldNotDump/);
        });
    });

    await t.test("task prompt --deep increases limits but remains bounded", async () => {
        await withTempProject(async () => {
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Context file task | todo | medium | - | - | [T-001](./T-001-context-file.md) |
`,
            );
            writeFile("task/T-001-context-file.md", "# T-001 Context File Task\n\n## Goal\n\nUpdate context files.\n");
            writeFile(
                ".aidw/index/files.json",
                JSON.stringify(
                    Array.from({ length: 30 }, (_, index) => ({
                        path: `src/context/file-${index}.js`,
                        type: "source",
                        description: "Context file candidate",
                        confidence: 0.7,
                    })),
                    null,
                    4,
                ),
            );
            writeFile(".aidw/index/symbols.json", "[]\n");

            const normal = await withCapturedConsole(() =>
                runTask(["prompt", "T-001"]),
            );
            const deep = await withCapturedConsole(() =>
                runTask(["prompt", "T-001", "--deep"]),
            );
            const normalText = normal.output.join("\n");
            const deepText = deep.output.join("\n");

            assert.match(normalText, /maxChars=20000/);
            assert.match(deepText, /maxChars=28000/);
            assert.match(deepText, /maxRelatedFiles=24/);
            assert.ok(deepText.length <= 28000);
        });
    });

    await t.test("task prompt missing task registry prints helpful warning", async () => {
        await withTempProject(async () => {
            const { output } = await withCapturedConsole(() =>
                runTask(["prompt", "T-001"]),
            );
            const text = output.join("\n");

            assert.match(text, /task\/task\.md is missing/);
            assert.match(text, /task registry is required to resolve task IDs/);
        });
    });

    await t.test("task prompt missing task ID prints helpful warning", async () => {
        await withTempProject(async () => {
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Existing Task | todo | medium | - | - | [T-001](./T-001-existing.md) |
`,
            );

            const { output } = await withCapturedConsole(() =>
                runTask(["prompt", "T-999"]),
            );
            const text = output.join("\n");

            assert.match(text, /task not found: T-999/);
            assert.match(text, /Check task\/task\.md for available task IDs/);
        });
    });

    await t.test("task prompt invalid task exits 1", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Existing Task | todo | medium | - | - | [T-001](./T-001-existing.md) |
`,
            );
            writeFile("task/T-001-existing.md", "# T-001 Existing Task\n");
            writeFile(".aidw/index/files.json", "[]\n");
            writeFile(".aidw/index/symbols.json", "[]\n");

            process.exitCode = 0;
            await withCapturedConsole(() => runTask(["prompt", "T-999"]));
            assert.equal(process.exitCode, 1);
            process.exitCode = 0;
        });
    });

    await t.test("task prompt missing indexes still produces usable prompt with warning", async () => {
        await withTempProject(async () => {
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Missing Indexes | todo | medium | - | - | [T-001](./T-001-missing-indexes.md) |
`,
            );
            writeFile("task/T-001-missing-indexes.md", "# T-001 Missing Indexes\n\n## Goal\n\nStill generate a prompt.\n");

            const { output } = await withCapturedConsole(() =>
                runTask(["prompt", "T-001"]),
            );
            const text = output.join("\n");

            assert.match(text, /# Task Implementation Prompt/);
            assert.match(text, /Still generate a prompt/);
            assert.match(text, /Run repo-context-kit scan/);
        });
    });

    await t.test("task checklist outputs markdown checkboxes with metadata and acceptance criteria", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Add checklist command | todo | high | dev | - | [T-001](./T-001-checklist-command.md) |
`,
            );
            writeFile(
                "task/T-001-checklist-command.md",
                `# T-001 Add Checklist Command

## Goal

Generate bounded verification checklists.

## Acceptance Criteria

- Checklist includes metadata.
- Checklist includes checkboxes.
`,
            );
            writeFile(".aidw/index/files.json", "[]\n");
            writeFile(".aidw/index/symbols.json", "[]\n");

            const { output } = await withCapturedConsole(() =>
                runTask(["checklist", "T-001"]),
            );
            const text = output.join("\n");

            assert.match(text, /# Task Test Checklist/);
            assert.match(text, /- id: T-001/);
            assert.match(text, /- title: Add checklist command/);
            assert.match(text, /- priority: high/);
            assert.match(text, /- owner: dev/);
            assert.match(text, /Generate bounded verification checklists/);
            assert.match(text, /- \[ \] Checklist includes metadata\./);
            assert.match(text, /- \[ \] Checklist includes checkboxes\./);
            assert.match(text, /included sources: 3/);
            assert.match(text, /excluded sources:/);
        });
    });

    await t.test("task checklist includes workset risk areas and likely test files", async () => {
        await withTempProject(async () => {
            writeFile(
                ".aidw/project.md",
                `# Project Context

## Project Role

Test project.

## High-Risk Areas

- CLI command dispatch
`,
            );
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Add cli checklist | todo | medium | - | - | [T-001](./T-001-cli-checklist.md) |
`,
            );
            writeFile("task/T-001-cli-checklist.md", "# T-001 Add cli checklist\n\n## Goal\n\nUpdate bin/cli.js and test/cli.test.js.\n");
            writeFile(
                ".aidw/index/files.json",
                JSON.stringify(
                    [
                        { path: "bin/cli.js", type: "entry", description: "CLI command parser", confidence: 0.9 },
                        { path: "test/cli.test.js", type: "test", description: "CLI tests", confidence: 0.8 },
                    ],
                    null,
                    4,
                ),
            );
            writeFile(".aidw/index/symbols.json", "[]\n");
            writeFile(
                ".aidw/index/entrypoints.json",
                JSON.stringify([{ name: "CLI entry", path: "bin/cli.js", confidence: 0.9 }], null, 4),
            );
            writeFile(
                ".aidw/index/file-groups.json",
                JSON.stringify([{ path: "test", keyFiles: ["test/cli.test.js"] }], null, 4),
            );
            writeFile(".aidw/index/summary.json", JSON.stringify({ indexedFiles: 2 }, null, 4));

            const { output } = await withCapturedConsole(() =>
                runTask(["checklist", "T-001"]),
            );
            const text = output.join("\n");

            assert.match(text, /CLI command dispatch/);
            assert.match(text, /Review or update likely test file: `test\/cli\.test\.js`/);
        });
    });

    await t.test("task checklist does not dump entire indexes and stays bounded", async () => {
        await withTempProject(async () => {
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Checklist task | todo | medium | - | - | [T-001](./T-001-checklist.md) |
`,
            );
            writeFile("task/T-001-checklist.md", "# T-001 Checklist Task\n\n## Goal\n\nCreate checklist output.\n");
            writeFile(
                ".aidw/index/files.json",
                JSON.stringify(
                    [
                        { path: "src/checklist.js", type: "source", description: "Checklist output", confidence: 0.8 },
                        { path: "src/secret.js", type: "source", description: "SHOULD_NOT_DUMP", confidence: 0.8 },
                    ],
                    null,
                    4,
                ),
            );
            writeFile(
                ".aidw/index/symbols.json",
                JSON.stringify(
                    [
                        { name: "buildChecklist", type: "function", file: "src/checklist.js", description: "Checklist output", confidence: 0.8 },
                        { name: "ShouldNotDump", type: "function", file: "src/secret.js", description: "Secret", confidence: 0.8 },
                    ],
                    null,
                    4,
                ),
            );

            const { output } = await withCapturedConsole(() =>
                runTask(["checklist", "T-001"]),
            );
            const text = output.join("\n");

            assert.ok(text.length <= 14000);
            assert.doesNotMatch(text, /SHOULD_NOT_DUMP/);
            assert.doesNotMatch(text, /ShouldNotDump/);
        });
    });

    await t.test("task checklist --deep increases limits but remains bounded", async () => {
        await withTempProject(async () => {
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Context checklist task | todo | medium | - | - | [T-001](./T-001-context-checklist.md) |
`,
            );
            writeFile("task/T-001-context-checklist.md", "# T-001 Context Checklist Task\n\n## Goal\n\nUpdate context checklist files.\n");
            writeFile(
                ".aidw/index/files.json",
                JSON.stringify(
                    Array.from({ length: 30 }, (_, index) => ({
                        path: `src/context/file-${index}.js`,
                        type: "source",
                        description: "Context checklist file candidate",
                        confidence: 0.7,
                    })),
                    null,
                    4,
                ),
            );
            writeFile(".aidw/index/symbols.json", "[]\n");

            const normal = await withCapturedConsole(() =>
                runTask(["checklist", "T-001"]),
            );
            const deep = await withCapturedConsole(() =>
                runTask(["checklist", "T-001", "--deep"]),
            );
            const normalText = normal.output.join("\n");
            const deepText = deep.output.join("\n");

            assert.match(normalText, /maxChars=14000/);
            assert.match(deepText, /maxChars=20000/);
            assert.match(deepText, /maxRelatedFiles=24/);
            assert.ok(deepText.length <= 20000);
        });
    });

    await t.test("task checklist missing task registry prints helpful warning", async () => {
        await withTempProject(async () => {
            const { output } = await withCapturedConsole(() =>
                runTask(["checklist", "T-001"]),
            );
            const text = output.join("\n");

            assert.match(text, /task\/task\.md is missing/);
            assert.match(text, /task registry is required to resolve task IDs/);
        });
    });

    await t.test("task checklist missing task ID prints helpful warning", async () => {
        await withTempProject(async () => {
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Existing Task | todo | medium | - | - | [T-001](./T-001-existing.md) |
`,
            );

            const { output } = await withCapturedConsole(() =>
                runTask(["checklist", "T-999"]),
            );
            const text = output.join("\n");

            assert.match(text, /task not found: T-999/);
            assert.match(text, /Check task\/task\.md for available task IDs/);
        });
    });

    await t.test("task checklist missing indexes still produces usable checklist with warning", async () => {
        await withTempProject(async () => {
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Missing Indexes | todo | medium | - | - | [T-001](./T-001-missing-indexes.md) |
`,
            );
            writeFile("task/T-001-missing-indexes.md", "# T-001 Missing Indexes\n\n## Goal\n\nStill generate a checklist.\n");

            const { output } = await withCapturedConsole(() =>
                runTask(["checklist", "T-001"]),
            );
            const text = output.join("\n");

            assert.match(text, /# Task Test Checklist/);
            assert.match(text, /Still generate a checklist/);
            assert.match(text, /Run repo-context-kit scan/);
            assert.match(text, /- \[ \] Identify the nearest relevant test area/);
        });
    });

    await t.test("task pr outputs markdown PR description with title, task metadata, and linked task", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Add PR command | todo | high | dev | - | [T-001](./T-001-pr-command.md) |
`,
            );
            writeFile(
                "task/T-001-pr-command.md",
                `# T-001 Add PR Command

## Goal

Generate bounded PR description text.

## Acceptance Criteria

- PR text includes task metadata.
`,
            );
            writeFile(".aidw/index/files.json", "[]\n");
            writeFile(".aidw/index/symbols.json", "[]\n");

            const { output } = await withCapturedConsole(() =>
                runTask(["pr", "T-001"]),
            );
            const text = output.join("\n");

            assert.match(text, /# Pull Request Description/);
            assert.match(text, /## Title Suggestion/);
            assert.match(text, /T-001: Add PR command/);
            assert.match(text, /## Linked Task/);
            assert.match(text, /- task: T-001/);
            assert.match(text, /- priority: high/);
            assert.match(text, /- owner: dev/);
            assert.match(text, /Generate bounded PR description text/);
            assert.match(text, /## Hard Boundaries/);
            assert.match(text, /## Confirmation Points/);
            assert.match(text, /## Post-merge Cleanup/);
            assert.match(text, /archive\/Task_at_date\.md/);
            assert.match(text, /included sources: 3/);
            assert.match(text, /excluded sources:/);
        });
    });

    await t.test("task pr --create creates a GitHub PR using token and git metadata", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Add PR command | todo | high | dev | - | [T-001](./T-001-pr-command.md) |
`,
            );
            writeFile(
                "task/T-001-pr-command.md",
                `# T-001 Add PR Command

## Goal

Generate bounded PR description text.
`,
            );
            writeFile(".aidw/index/files.json", "[]\n");
            writeFile(".aidw/index/symbols.json", "[]\n");
            writeFile(".git/HEAD", "ref: refs/heads/feature/test\n");
            writeFile(
                ".git/config",
                `[remote "origin"]
\turl = https://github.com/acme/myrepo.git
`,
            );

            const requests = [];
            await withMockGitHubServer(async (req, res) => {
                const chunks = [];
                req.on("data", (chunk) => chunks.push(chunk));
                req.on("end", () => {
                    const body = Buffer.concat(chunks).toString("utf-8");
                    requests.push({
                        method: req.method,
                        url: req.url,
                        headers: req.headers,
                        body,
                    });
                    res.statusCode = 201;
                    res.setHeader("content-type", "application/json");
                    res.end(
                        JSON.stringify({
                            html_url: "https://github.com/acme/myrepo/pull/123",
                            number: 123,
                        }),
                    );
                });
            }, async ({ baseUrl }) => {
                const prevToken = process.env.GITHUB_TOKEN;
                const prevBase = process.env.REPO_CONTEXT_KIT_GITHUB_API_BASE_URL;
                try {
                    process.env.GITHUB_TOKEN = "test-token-123";
                    process.env.REPO_CONTEXT_KIT_GITHUB_API_BASE_URL = baseUrl;
                    process.exitCode = 0;

                    const { output } = await withCapturedConsole(() =>
                        runTask(["pr", "T-001", "--create"]),
                    );
                    const text = output.join("\n");
                    assert.equal(process.exitCode, 0);
                    assert.match(text, /Created PR: https:\/\/github\.com\/acme\/myrepo\/pull\/123/);
                    assert.ok(!text.includes("test-token-123"));

                    assert.equal(requests.length, 1);
                    assert.equal(requests[0].method, "POST");
                    assert.equal(requests[0].url, "/repos/acme/myrepo/pulls");
                    assert.match(String(requests[0].headers.authorization), /^Bearer test-token-123$/);

                    const posted = JSON.parse(requests[0].body);
                    assert.equal(posted.title, "T-001: Add PR command");
                    assert.equal(posted.base, "main");
                    assert.equal(posted.head, "feature/test");
                    assert.match(posted.body, /# Pull Request Description/);
                } finally {
                    process.env.GITHUB_TOKEN = prevToken;
                    process.env.REPO_CONTEXT_KIT_GITHUB_API_BASE_URL = prevBase;
                    process.exitCode = 0;
                }
            });
        });
    });

    await t.test("task pr --create fails without token and does not call the API", async () => {
        await withTempProject(async () => {
            await withTempConfigDir(async () => {
                await withMutedConsole(() => runInit());
                writeFile(
                    "task/task.md",
                    `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Add PR command | todo | high | dev | - | [T-001](./T-001-pr-command.md) |
`,
                );
                writeFile("task/T-001-pr-command.md", "# T-001 Add PR Command\n");
                writeFile(".aidw/index/files.json", "[]\n");
                writeFile(".aidw/index/symbols.json", "[]\n");
                writeFile(".git/HEAD", "ref: refs/heads/feature/test\n");
                writeFile(
                    ".git/config",
                    `[remote "origin"]
\turl = https://github.com/acme/myrepo.git
`,
                );

                const requests = [];
                await withMockGitHubServer(async (req, res) => {
                    requests.push({ method: req.method, url: req.url });
                    res.statusCode = 500;
                    res.end("should not be called");
                }, async ({ baseUrl }) => {
                    const prevToken = process.env.GITHUB_TOKEN;
                    const prevGh = process.env.GH_TOKEN;
                    const prevBase = process.env.REPO_CONTEXT_KIT_GITHUB_API_BASE_URL;
                    try {
                        delete process.env.GITHUB_TOKEN;
                        delete process.env.GH_TOKEN;
                        process.env.REPO_CONTEXT_KIT_GITHUB_API_BASE_URL = baseUrl;
                        process.exitCode = 0;

                        const { output } = await withCapturedConsole(() =>
                            runTask(["pr", "T-001", "--create"]),
                        );
                        const text = output.join("\n");
                        assert.equal(process.exitCode, 1);
                        assert.match(text, /Missing GitHub token/i);
                        assert.equal(requests.length, 0);
                    } finally {
                        if (prevToken === undefined) delete process.env.GITHUB_TOKEN;
                        else process.env.GITHUB_TOKEN = prevToken;
                        if (prevGh === undefined) delete process.env.GH_TOKEN;
                        else process.env.GH_TOKEN = prevGh;
                        process.env.REPO_CONTEXT_KIT_GITHUB_API_BASE_URL = prevBase;
                        process.exitCode = 0;
                    }
                });
            });
        });
    });

    await t.test("github auth set/status/unset stores token in user config without printing it", async () => {
        await withTempProject(async () => {
            await withTempConfigDir(async () => {
                const prevToken = process.env.GITHUB_TOKEN;
                const prevGh = process.env.GH_TOKEN;
                try {
                    delete process.env.GITHUB_TOKEN;
                    delete process.env.GH_TOKEN;
                    process.exitCode = 0;

                    const status1 = await withCapturedConsole(() => runGithub(["auth", "status"]));
                    assert.match(status1.output.join("\n"), /- configured: false/);
                    assert.match(status1.output.join("\n"), /- source: none/);
                    assert.match(status1.output.join("\n"), /Get a GitHub token:/);
                    assert.match(status1.output.join("\n"), /https:\/\/github\.com\/settings\/tokens/);

                    const set = await withCapturedConsole(() => runGithub(["auth", "set", "--token", "test-token-123"]));
                    assert.equal(process.exitCode, 0);
                    assert.match(set.output.join("\n"), /GitHub token saved/);
                    assert.ok(!set.output.join("\n").includes("test-token-123"));

                    const status2 = await withCapturedConsole(() => runGithub(["auth", "status"]));
                    assert.match(status2.output.join("\n"), /- configured: true/);
                    assert.match(status2.output.join("\n"), /- source: user-config/);

                    const unset = await withCapturedConsole(() => runGithub(["auth", "unset"]));
                    assert.equal(process.exitCode, 0);
                    assert.match(unset.output.join("\n"), /token removed/i);

                    const status3 = await withCapturedConsole(() => runGithub(["auth", "status"]));
                    assert.match(status3.output.join("\n"), /- configured: false/);
                    assert.match(status3.output.join("\n"), /- source: none/);
                } finally {
                    if (prevToken === undefined) delete process.env.GITHUB_TOKEN;
                    else process.env.GITHUB_TOKEN = prevToken;
                    if (prevGh === undefined) delete process.env.GH_TOKEN;
                    else process.env.GH_TOKEN = prevGh;
                    process.exitCode = 0;
                }
            });
        });
    });

    await t.test("task pr --create falls back to user-config token when env is missing", async () => {
        await withTempProject(async () => {
            await withTempConfigDir(async () => {
                await withMutedConsole(() => runInit());
                writeFile(
                    "task/task.md",
                    `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Add PR command | todo | high | dev | - | [T-001](./T-001-pr-command.md) |
`,
                );
                writeFile("task/T-001-pr-command.md", "# T-001 Add PR Command\n");
                writeFile(".aidw/index/files.json", "[]\n");
                writeFile(".aidw/index/symbols.json", "[]\n");
                writeFile(".git/HEAD", "ref: refs/heads/feature/test\n");
                writeFile(
                    ".git/config",
                    `[remote "origin"]
\turl = https://github.com/acme/myrepo.git
`,
                );

                const requests = [];
                await withMockGitHubServer(async (req, res) => {
                    const chunks = [];
                    req.on("data", (chunk) => chunks.push(chunk));
                    req.on("end", () => {
                        requests.push({ headers: req.headers });
                        res.statusCode = 201;
                        res.setHeader("content-type", "application/json");
                        res.end(JSON.stringify({ html_url: "https://github.com/acme/myrepo/pull/2", number: 2 }));
                    });
                }, async ({ baseUrl }) => {
                    const prevToken = process.env.GITHUB_TOKEN;
                    const prevGh = process.env.GH_TOKEN;
                    const prevBase = process.env.REPO_CONTEXT_KIT_GITHUB_API_BASE_URL;
                    try {
                        delete process.env.GITHUB_TOKEN;
                        delete process.env.GH_TOKEN;
                        process.env.REPO_CONTEXT_KIT_GITHUB_API_BASE_URL = baseUrl;
                        process.exitCode = 0;

                        await withMutedConsole(() => runGithub(["auth", "set", "--token", "test-token-123"]));
                        const { output } = await withCapturedConsole(() => runTask(["pr", "T-001", "--create"]));
                        const text = output.join("\n");
                        assert.equal(process.exitCode, 0);
                        assert.match(text, /Created PR: https:\/\/github\.com\/acme\/myrepo\/pull\/2/);

                        assert.equal(requests.length, 1);
                        assert.match(String(requests[0].headers.authorization), /^Bearer test-token-123$/);
                    } finally {
                        if (prevToken === undefined) delete process.env.GITHUB_TOKEN;
                        else process.env.GITHUB_TOKEN = prevToken;
                        if (prevGh === undefined) delete process.env.GH_TOKEN;
                        else process.env.GH_TOKEN = prevGh;
                        process.env.REPO_CONTEXT_KIT_GITHUB_API_BASE_URL = prevBase;
                        process.exitCode = 0;
                    }
                });
            });
        });
    });

    await t.test("task pr --create supports explicit --repo and --head without .git metadata", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Add PR command | todo | high | dev | - | [T-001](./T-001-pr-command.md) |
`,
            );
            writeFile("task/T-001-pr-command.md", "# T-001 Add PR Command\n");
            writeFile(".aidw/index/files.json", "[]\n");
            writeFile(".aidw/index/symbols.json", "[]\n");

            const requests = [];
            await withMockGitHubServer(async (req, res) => {
                const chunks = [];
                req.on("data", (chunk) => chunks.push(chunk));
                req.on("end", () => {
                    requests.push({ url: req.url, body: Buffer.concat(chunks).toString("utf-8") });
                    res.statusCode = 201;
                    res.setHeader("content-type", "application/json");
                    res.end(JSON.stringify({ html_url: "https://github.com/acme/myrepo/pull/1", number: 1 }));
                });
            }, async ({ baseUrl }) => {
                const prevToken = process.env.GITHUB_TOKEN;
                const prevBase = process.env.REPO_CONTEXT_KIT_GITHUB_API_BASE_URL;
                try {
                    process.env.GITHUB_TOKEN = "test-token-123";
                    process.env.REPO_CONTEXT_KIT_GITHUB_API_BASE_URL = baseUrl;
                    process.exitCode = 0;

                    await withCapturedConsole(() =>
                        runTask(["pr", "T-001", "--create", "--repo", "acme/myrepo", "--head", "feature/test"]),
                    );
                    assert.equal(process.exitCode, 0);
                    assert.equal(requests.length, 1);
                    assert.equal(requests[0].url, "/repos/acme/myrepo/pulls");
                    const posted = JSON.parse(requests[0].body);
                    assert.equal(posted.head, "feature/test");
                } finally {
                    process.env.GITHUB_TOKEN = prevToken;
                    process.env.REPO_CONTEXT_KIT_GITHUB_API_BASE_URL = prevBase;
                    process.exitCode = 0;
                }
            });
        });
    });

    await t.test("task pr includes default hard boundaries and warnings when missing in task detail", async () => {
        await withTempProject(async () => {
            await withMutedConsole(() => runInit());
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | PR missing boundaries | todo | medium | - | - | [T-001](./T-001-pr-missing-boundaries.md) |
`,
            );
            writeFile(
                "task/T-001-pr-missing-boundaries.md",
                `# T-001 PR missing boundaries

## Goal

Ensure PR description includes guardrails.
`,
            );
            writeFile(".aidw/index/files.json", "[]\n");
            writeFile(".aidw/index/symbols.json", "[]\n");

            const { output } = await withCapturedConsole(() =>
                runTask(["pr", "T-001"]),
            );
            const text = output.join("\n");

            assert.match(text, /## Hard Boundaries/);
            assert.match(text, /Do not run commands/);
            assert.match(text, /## Confirmation Points/);
            assert.match(text, /Confirm scope and planned approach/);
            assert.match(text, /## Warnings/);
            assert.match(text, /Task detail missing "Hard Boundaries" section; using defaults\./);
            assert.match(text, /Task detail missing "Confirmation Points" section; using defaults\./);
        });
    });

    await t.test("task pr includes risk areas when available", async () => {
        await withTempProject(async () => {
            writeFile(
                ".aidw/project.md",
                `# Project Context

## Project Role

Test project.

## High-Risk Areas

- CLI command dispatch
`,
            );
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Add cli pr text | todo | medium | - | - | [T-001](./T-001-cli-pr.md) |
`,
            );
            writeFile("task/T-001-cli-pr.md", "# T-001 Add cli pr text\n\n## Goal\n\nUpdate bin/cli.js.\n");
            writeFile(
                ".aidw/index/files.json",
                JSON.stringify([{ path: "bin/cli.js", type: "entry", description: "CLI command parser", confidence: 0.9 }], null, 4),
            );
            writeFile(".aidw/index/symbols.json", "[]\n");
            writeFile(
                ".aidw/index/entrypoints.json",
                JSON.stringify([{ name: "CLI entry", path: "bin/cli.js", confidence: 0.9 }], null, 4),
            );
            writeFile(".aidw/index/file-groups.json", "[]\n");
            writeFile(".aidw/index/summary.json", JSON.stringify({ indexedFiles: 1 }, null, 4));

            const { output } = await withCapturedConsole(() =>
                runTask(["pr", "T-001"]),
            );
            const text = output.join("\n");

            assert.match(text, /## Risk Areas/);
            assert.match(text, /CLI command dispatch/);
        });
    });

    await t.test("task pr does not claim completion or invent test results", async () => {
        await withTempProject(async () => {
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Planned PR | todo | medium | - | - | [T-001](./T-001-planned-pr.md) |
`,
            );
            writeFile("task/T-001-planned-pr.md", "# T-001 Planned PR\n\n## Goal\n\nDescribe planned changes.\n");

            const { output } = await withCapturedConsole(() =>
                runTask(["pr", "T-001"]),
            );
            const text = output.join("\n");

            assert.match(text, /planned scope|planned/i);
            assert.match(text, /does not inspect git diffs|before reading any git diff/);
            assert.doesNotMatch(text, /tests passed/i);
            assert.doesNotMatch(text, /all tests pass/i);
            assert.doesNotMatch(text, /implemented successfully/i);
        });
    });

    await t.test("task pr does not dump entire indexes and stays bounded", async () => {
        await withTempProject(async () => {
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | PR task | todo | medium | - | - | [T-001-pr.md](./T-001-pr.md) |
`,
            );
            writeFile("task/T-001-pr.md", "# T-001 PR Task\n\n## Goal\n\nCreate PR output.\n");
            writeFile(
                ".aidw/index/files.json",
                JSON.stringify(
                    [
                        { path: "src/pr.js", type: "source", description: "PR output", confidence: 0.8 },
                        { path: "src/secret.js", type: "source", description: "SHOULD_NOT_DUMP", confidence: 0.8 },
                    ],
                    null,
                    4,
                ),
            );
            writeFile(
                ".aidw/index/symbols.json",
                JSON.stringify([{ name: "ShouldNotDump", type: "function", file: "src/secret.js", description: "Secret", confidence: 0.8 }], null, 4),
            );

            const { output } = await withCapturedConsole(() =>
                runTask(["pr", "T-001"]),
            );
            const text = output.join("\n");

            assert.ok(text.length <= 14000);
            assert.doesNotMatch(text, /SHOULD_NOT_DUMP/);
            assert.doesNotMatch(text, /ShouldNotDump/);
        });
    });

    await t.test("task pr --deep increases limits but remains bounded", async () => {
        await withTempProject(async () => {
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Context PR task | todo | medium | - | - | [T-001](./T-001-context-pr.md) |
`,
            );
            writeFile("task/T-001-context-pr.md", "# T-001 Context PR Task\n\n## Goal\n\nUpdate context PR files.\n");
            writeFile(
                ".aidw/index/files.json",
                JSON.stringify(
                    Array.from({ length: 30 }, (_, index) => ({
                        path: `src/context/file-${index}.js`,
                        type: "source",
                        description: "Context PR file candidate",
                        confidence: 0.7,
                    })),
                    null,
                    4,
                ),
            );
            writeFile(".aidw/index/symbols.json", "[]\n");

            const normal = await withCapturedConsole(() =>
                runTask(["pr", "T-001"]),
            );
            const deep = await withCapturedConsole(() =>
                runTask(["pr", "T-001", "--deep"]),
            );
            const normalText = normal.output.join("\n");
            const deepText = deep.output.join("\n");

            assert.match(normalText, /maxChars=14000/);
            assert.match(deepText, /maxChars=20000/);
            assert.ok(deepText.length <= 20000);
        });
    });

    await t.test("task pr missing task registry prints helpful warning", async () => {
        await withTempProject(async () => {
            const { output } = await withCapturedConsole(() =>
                runTask(["pr", "T-001"]),
            );
            const text = output.join("\n");

            assert.match(text, /task\/task\.md is missing/);
            assert.match(text, /task registry is required to resolve task IDs/);
        });
    });

    await t.test("task pr missing task ID prints helpful warning", async () => {
        await withTempProject(async () => {
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Existing Task | todo | medium | - | - | [T-001](./T-001-existing.md) |
`,
            );

            const { output } = await withCapturedConsole(() =>
                runTask(["pr", "T-999"]),
            );
            const text = output.join("\n");

            assert.match(text, /task not found: T-999/);
            assert.match(text, /Check task\/task\.md for available task IDs/);
        });
    });

    await t.test("task pr missing indexes still produces usable PR text with warning", async () => {
        await withTempProject(async () => {
            writeFile(
                "task/task.md",
                `# Task Registry

## Tasks

| ID | Title | Status | Priority | Owner | Dependencies | File |
|----|------|--------|----------|-------|--------------|------|
| T-001 | Missing Indexes | todo | medium | - | - | [T-001](./T-001-missing-indexes.md) |
`,
            );
            writeFile("task/T-001-missing-indexes.md", "# T-001 Missing Indexes\n\n## Goal\n\nStill generate PR text.\n");

            const { output } = await withCapturedConsole(() =>
                runTask(["pr", "T-001"]),
            );
            const text = output.join("\n");

            assert.match(text, /# Pull Request Description/);
            assert.match(text, /Still generate PR text/);
            assert.match(text, /Run repo-context-kit scan/);
        });
    });

    await t.test("fresh user flow works through CLI parser from a temporary project path", async () => {
        await withTempProject(async () => {
            process.exitCode = 0;

            const init = await withCapturedConsole(() => runCliMain(["init"]));
            const scan = await withCapturedConsole(() => runCliMain(["scan"]));
            const check = await withCapturedConsole(() =>
                runCliMain(["scan", "--check"]),
            );
            const combinedOutput = [
                init.output.join("\n"),
                scan.output.join("\n"),
                check.output.join("\n"),
            ].join("\n");

            assert.equal(process.exitCode, 0);
            assert.ok(fs.existsSync(".aidw"));
            assert.ok(fs.existsSync(".aidw/project.md"));
            assert.ok(fs.existsSync(".trae/rules/project_rules.md"));
            assert.ok(fs.existsSync(".trae/skills/doc-to-tasks/SKILL.md"));
            assert.match(combinedOutput, /\.aidw\//);
            assert.doesNotMatch(combinedOutput, /ai\//);
        });
    });

    await t.test("npm package includes site assets", async () => {
        const result = spawnSync("npm", ["pack", "--dry-run"], {
            cwd: originalCwd,
            encoding: "utf-8",
            shell: process.platform === "win32",
        });

        assert.equal(result.status, 0);
        const text = `${result.stdout}\n${result.stderr}`;
        assert.match(text, /site[\\/]+index\.html/);
        assert.match(text, /site[\\/]+task-example\.md/);
    });
});
