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

function printGateStatus(state) {
    const active = state.active;
    const hasActive = Boolean(active?.taskConfirmed);
    console.log([
        "# Confirmation Gate",
        "",
        `- protocol: ${state.protocol}`,
        `- taskId: ${active?.taskId ?? "-"}`,
        `- expiresAt: ${active?.expiresAt ?? "-"}`,
        `- taskConfirmed: ${hasActive ? "true" : "false"}`,
        `- testsConfirmed: ${active?.testsConfirmed ? "true" : "false"}`,
        `- updatedAt: ${state.updatedAt ?? "-"}`,
        "",
        "## Effective Gating",
        "",
        `- allow_file_edits: ${hasActive ? "true" : "false"}`,
        `- allow_commands: ${active?.testsConfirmed ? "true" : "false"}`,
    ].join("\n"));
}

function usage() {
    console.log(`Usage:
  repo-context-kit gate status
  repo-context-kit gate reset
  repo-context-kit gate confirm task <taskId> [--ttl-minutes <n>] [--json]
  repo-context-kit gate confirm tests <taskId> [--json]
  repo-context-kit gate run-test <taskId> --token <token> [--json]
`);
}

function emitJson(body) {
    console.log(JSON.stringify(body));
}

function getFlagValue(args, flag) {
    const index = args.indexOf(flag);
    if (index === -1) {
        return null;
    }
    return args[index + 1] ?? null;
}

export async function runGate(args = []) {
    const json = args.includes("--json");
    const filteredArgs = args.filter((arg) => arg !== "--json");
    const subcommand = filteredArgs[0];

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
        printGateStatus(state);
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
        printGateStatus(state);
        return;
    }

    if (subcommand === "confirm") {
        const target = filteredArgs[1];
        const taskId = filteredArgs[2];
        const ttlMinutes = getFlagValue(filteredArgs, "--ttl-minutes");

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
                nextActions: [`repo-context-kit gate confirm tests ${result.state?.active?.taskId ?? "<taskId>"}`],
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
            console.log(`OK Task confirmed: ${path.relative(process.cwd(), result.filePath).replaceAll("\\", "/")}`);
            console.log(`Token: ${result.token}`);
            printGateStatus(result.state);
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
                nextActions: [`repo-context-kit gate run-test ${result.state?.active?.taskId ?? "<taskId>"} --token <token>`],
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
            console.log(`OK Tests confirmed: ${path.relative(process.cwd(), result.filePath).replaceAll("\\", "/")}`);
            printGateStatus(result.state);
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

        const token = getFlagValue(filteredArgs, "--token");
        if (!token) {
            const error = "Missing gate token. Usage: repo-context-kit gate run-test <taskId> --token <token>";
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
