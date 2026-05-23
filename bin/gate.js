#!/usr/bin/env node
import path from "path";
import {
    loadGateState,
    confirmTask,
    confirmTests,
    resetGateState,
} from "../src/gate/state.js";
import { runTaskTestThroughGate } from "../src/gate/run-test.js";
import { appendLoopEvent } from "../src/loop/store.js";
import { formatAuditProtocolOutput, formatCompactOutput } from "../src/runtime/output-presentation.js";
import { emitJson, getArgValue, getFlag, pickCommand, stripFlag } from "./_cli-utils.js";

function printGateStatus(state, options = {}) {
    const active = state.active;
    const hasActive = Boolean(active?.taskConfirmed);
    const fileEdits = hasActive ? "approved" : "blocked";
    const testCommand = active?.testsConfirmed ? "approved" : "blocked";
    if (options.audit) {
        console.log(formatAuditProtocolOutput({
            state: "GATE_STATUS",
            mode: "READ",
            gating: {
                allowFileEdits: hasActive,
                allowCommands: Boolean(active?.testsConfirmed),
            },
            next: "NONE",
            output: [
                `task: ${active?.taskId ?? "none"}`,
                `scope approved: ${hasActive ? "yes" : "no"}`,
                `tests approved: ${active?.testsConfirmed ? "yes" : "no"}`,
                `expires: ${active?.expiresAt ?? "-"}`,
                `file edits: ${fileEdits}`,
                `test command: ${testCommand}`,
            ].join("\n"),
        }).trimEnd());
        return;
    }
    console.log(formatCompactOutput({
        state: "GATE",
        goal: "Runtime approval status",
        scope: [
            `task: ${active?.taskId ?? "none"}`,
            `file edits: ${fileEdits}`,
            `test command: ${testCommand}`,
        ],
        tests: active?.testsConfirmed ? "Approved" : "Blocked",
        need: hasActive ? "Continue / Confirm tests / Run gated test" : "Confirm task",
    }).trimEnd());
}

function usage() {
    console.log(`Usage:
  rck gate status
  rck gate reset
  rck gate confirm task <taskId> [--ttl-minutes <n>] [--json]
  rck gate confirm tests <taskId> [--json]
  rck gate run-test <taskId> --token <token> [--json]

Options:
  --audit    Show full protocol metadata for gate status
`);
}

export async function runGate(args = []) {
    const json = getFlag(args, "--json");
    const audit = getFlag(args, "--audit") || getFlag(args, "--protocol");
    const filteredArgs = stripFlag(stripFlag(stripFlag(args, "--json"), "--audit"), "--protocol");
    const subcommand = pickCommand(filteredArgs, null);

    if (!subcommand || subcommand === "help" || subcommand === "--help") {
        usage();
        return;
    }

    if (subcommand === "status") {
        const state = loadGateState();
        if (json) {
            emitJson({ ok: true, state });
            return;
        }
        printGateStatus(state, { audit });
        return;
    }

    if (subcommand === "reset") {
        const { filePath, state } = resetGateState();
        appendLoopEvent({ type: "gate_reset" });
        if (json) {
            emitJson({ ok: true, file: path.relative(process.cwd(), filePath).replaceAll("\\", "/"), state });
            return;
        }
        console.log(`OK Gate reset: ${path.relative(process.cwd(), filePath).replaceAll("\\", "/")}`);
        printGateStatus(state, { audit });
        return;
    }

    if (subcommand === "confirm") {
        const target = filteredArgs[1];
        const taskId = filteredArgs[2];
        const ttlMinutes = getArgValue(filteredArgs, "--ttl-minutes");

        if (target === "task") {
            const result = confirmTask(taskId, { ttlMinutes });
            if (result.error) {
                if (json) {
                    emitJson({ ok: false, error: result.error });
                } else {
                    console.error(result.error);
                }
                process.exitCode = 1;
                return;
            }
            appendLoopEvent({
                type: "gate_confirm_task",
                taskId: result.state?.active?.taskId ?? null,
                expiresAt: result.state?.active?.expiresAt ?? null,
            });
            appendLoopEvent({
                type: "execution_evidence",
                tool: "gate.confirm.task",
                mode: "CLI",
                taskId: result.state?.active?.taskId ?? null,
                ok: true,
                summaryOfChange: "Confirmation gate: task confirmed",
                filesModified: [".aidw/confirmation-gate.json"],
                keyReasoning: "Human confirmed task scope and enabled file edits per confirmation protocol.",
                verification: "task_confirmed",
                risks: [],
                nextActions: [`rck gate confirm tests ${result.state?.active?.taskId ?? "<taskId>"}`],
            });
            if (json) {
                emitJson({
                    ok: true,
                    token: result.token,
                    file: path.relative(process.cwd(), result.filePath).replaceAll("\\", "/"),
                    state: result.state,
                });
                return;
            }
            console.log("Approval Recorded");
            console.log("");
            console.log(`Task approved: ${result.state?.active?.taskId ?? taskId}`);
            console.log(`Token: ${result.token}`);
            console.log("");
            console.log("Next:");
            console.log(`- Prepare AI prompt: rck task prompt ${result.state?.active?.taskId ?? taskId}`);
            console.log(`- Approve tests when ready: rck gate confirm tests ${result.state?.active?.taskId ?? taskId}`);
            return;
        }

        if (target === "tests") {
            const result = confirmTests(taskId);
            if (result.error) {
                if (json) {
                    emitJson({ ok: false, error: result.error });
                } else {
                    console.error(result.error);
                }
                process.exitCode = 1;
                return;
            }
            appendLoopEvent({
                type: "gate_confirm_tests",
                taskId: result.state?.active?.taskId ?? null,
                expiresAt: result.state?.active?.expiresAt ?? null,
            });
            appendLoopEvent({
                type: "execution_evidence",
                tool: "gate.confirm.tests",
                mode: "CLI",
                taskId: result.state?.active?.taskId ?? null,
                ok: true,
                summaryOfChange: "Confirmation gate: tests confirmed",
                filesModified: [".aidw/confirmation-gate.json"],
                keyReasoning: "Human confirmed test execution per confirmation protocol.",
                verification: "tests_confirmed",
                risks: [],
                nextActions: [`rck gate run-test ${result.state?.active?.taskId ?? "<taskId>"} --token <token>`],
            });
            if (json) {
                emitJson({
                    ok: true,
                    token: result.state?.active?.token ?? null,
                    file: path.relative(process.cwd(), result.filePath).replaceAll("\\", "/"),
                    state: result.state,
                });
                return;
            }
            console.log("Test Approval Recorded");
            console.log("");
            console.log(`Task: ${result.state?.active?.taskId ?? taskId}`);
            console.log("");
            console.log("Next:");
            console.log(`- Run tests: rck gate run-test ${result.state?.active?.taskId ?? taskId} --token <token>`);
            return;
        }

        console.error("Unknown confirm target.");
        usage();
        process.exitCode = 1;
        return;
    }

    if (subcommand === "run-test") {
        const taskId = filteredArgs[1];
        if (!taskId) {
            console.error("Missing task id.");
            usage();
            process.exitCode = 1;
            return;
        }

        const token = getArgValue(filteredArgs, "--token");
        if (!token) {
            const error = "Missing gate token. Usage: rck gate run-test <taskId> --token <token>";
            if (json) {
                emitJson({ ok: false, error });
            } else {
                console.error(error);
            }
            process.exitCode = 1;
            return;
        }

        const result = await runTaskTestThroughGate({ taskId, token });
        appendLoopEvent({
            type: "test",
            taskId: String(taskId ?? "").trim().toUpperCase(),
            ok: result.ok,
            exitCode: result.exitCode,
            command: result.command,
        });
        appendLoopEvent({
            type: "execution_evidence",
            tool: "gate.run-test",
            mode: "CLI",
            taskId: String(taskId ?? "").trim().toUpperCase(),
            ok: result.ok,
            summaryOfChange: "Task test executed via confirmation gate",
            filesModified: [],
            keyReasoning: "Tests were executed only after explicit task+tests confirmation.",
            verification: result.command ? `command=${result.command} exit=${result.exitCode}` : `exit=${result.exitCode}`,
            risks: result.ok ? [] : ["recent-test-failure"],
            nextActions: result.ok ? [] : ["Fix failing tests before proceeding."],
        });
        if (json) {
            emitJson({
                ok: result.ok,
                exitCode: result.exitCode,
                command: result.command,
                error: result.error,
            });
        }
        process.exitCode = result.exitCode;
        return;
    }

    console.error("Unknown gate command.");
    usage();
    process.exitCode = 1;
}
