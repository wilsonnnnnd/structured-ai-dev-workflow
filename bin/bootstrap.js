#!/usr/bin/env node
import fs from "node:fs";
import { planBootstrapRuntime } from "../src/bootstrap/plan.js";
import { applyBootstrapPlan } from "../src/bootstrap/apply.js";
import { inspectBootstrapPlan } from "../src/bootstrap/inspect.js";
import { explainBootstrapPlan } from "../src/bootstrap/explain.js";
import { diffBootstrapPlan } from "../src/bootstrap/diff.js";
import { bootstrapDoctor } from "../src/bootstrap/doctor.js";
import { serializeJson } from "../src/runtime/serialize.js";
import { getArgValue, getFlag, pickCommand, stripFlag } from "./_cli-utils.js";

function usage() {
    console.log(`Usage:
  repo-context-kit bootstrap plan --from-doc <path> [--write-mode create-only|overwrite-managed] [--json] [--explain]
  repo-context-kit bootstrap doctor [--from-doc <path>] [--json] [--check] [--strict] [--max-risks N]
  repo-context-kit bootstrap inspect --from-plan <path|-> [--json]
  repo-context-kit bootstrap explain --from-plan <path|-> [--json]
  repo-context-kit bootstrap diff --from-plan <path|-> [--against disk|snapshot:<id>] [--json]
  repo-context-kit bootstrap apply --from-plan <path|-> --confirm <token> --enable-write [--json]

Docs:
  docs/doctor.md
`);
}

function writePlanFile(plan, planPath) {
    const filePath = String(planPath ?? "").trim();
    if (!filePath) return null;
    fs.writeFileSync(filePath, serializeJson(plan).trimEnd() + "\n", "utf-8");
    return filePath;
}

function parseMaxRisks(args) {
    const direct = getArgValue(args, "--max-risks");
    if (direct) {
        const n = Number(direct);
        if (Number.isFinite(n) && n >= 0) return Math.floor(n);
    }
    const inline = (Array.isArray(args) ? args : []).find((x) => String(x ?? "").startsWith("--max-risks="));
    if (inline) {
        const raw = String(inline).slice("--max-risks=".length);
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0) return Math.floor(n);
    }
    return null;
}

function computeHighestSeverity(risks) {
    const list = Array.isArray(risks) ? risks : [];
    if (list.some((r) => r && r.severity === "error")) return "error";
    if (list.some((r) => r && r.severity === "warning")) return "warning";
    return "info";
}

export async function runBootstrap(args = []) {
    const json = getFlag(args, "--json");
    const filteredArgs = stripFlag(args, "--json");
    const subcommand = pickCommand(filteredArgs, "help");
    if (subcommand === "help" || getFlag(args, "--help")) {
        usage();
        return { output: null };
    }

    if (subcommand === "plan") {
        const fromDoc = getArgValue(filteredArgs, "--from-doc");
        if (!fromDoc) {
            usage();
            process.exitCode = 1;
            return { output: null };
        }
        const writeMode = getArgValue(filteredArgs, "--write-mode") ?? "create-only";
        const explain = getFlag(filteredArgs, "--explain");
        const outPath = getArgValue(filteredArgs, "--out");
        const result = planBootstrapRuntime({ repoRoot: process.cwd(), fromDoc, writeMode });
        if (outPath) {
            writePlanFile({ ...result, plan: result.plan, contract: result.contract }, outPath);
        }
        if (json) {
            const payload = {
                ok: true,
                command: "bootstrap",
                action: "plan",
                repoRoot: result.repoRoot,
                fromDoc: result.fromDoc,
                writeMode: result.plan.writeMode,
                digest: result.digest,
                pauseToken: result.pauseToken,
                scaffoldMeta: result.scaffoldMeta,
                matchedRecipeIds: result.matchedRecipeIds,
                scaffoldHints: result.scaffoldHints,
                plan: result.plan,
                contract: result.contract,
                risks: result.risks,
                nextActions: result.nextActions,
                explain: explain ? result.explain : undefined,
            };
            console.log(serializeJson(payload));
            return { output: null, result: payload };
        }
        const lines = [
            "OK Bootstrap plan generated",
            "",
            `- fromDoc: ${result.fromDoc}`,
            `- writeMode: ${result.plan.writeMode}`,
            `- digest: ${result.digest}`,
            `- pauseToken: ${result.pauseToken}`,
            "",
            "Next:",
            `* Apply with: repo-context-kit bootstrap apply --from-plan <plan.json> --confirm ${result.pauseToken} --enable-write`,
            "* Then: repo-context-kit scan",
        ];
        if (Array.isArray(result.scaffoldHints) && result.scaffoldHints.length) {
            lines.push("");
            lines.push("Scaffold Hints:");
            for (const hint of result.scaffoldHints.slice(0, 3)) {
                const tool = String(hint?.tool ?? "").trim();
                const command = String(hint?.command ?? "").trim();
                const args = Array.isArray(hint?.args) ? hint.args.map((x) => String(x ?? "").trim()).filter(Boolean) : [];
                if (command) {
                    lines.push(`* ${[tool, command, ...args].filter(Boolean).join(" ").trim()}`);
                }
            }
        }
        if (explain) {
            lines.push("");
            lines.push("Explain:");
            lines.push(`* extractedSections: ${(result.explain?.extractedSections ?? []).join(", ") || "-"}`);
            if (Array.isArray(result.scaffoldMeta?.detectedKeywords) && result.scaffoldMeta.detectedKeywords.length) {
                lines.push(`* detectedKeywords: ${result.scaffoldMeta.detectedKeywords.join(", ")}`);
            }
            if (Array.isArray(result.matchedRecipeIds) && result.matchedRecipeIds.length) {
                lines.push(`* matchedRecipes: ${result.matchedRecipeIds.join(", ")}`);
            }
        }
        console.log(lines.join("\n").trimEnd());
        return { output: lines.join("\n") };
    }

    if (subcommand === "doctor") {
        const fromDoc = getArgValue(filteredArgs, "--from-doc");
        const check = getFlag(filteredArgs, "--check");
        const strict = getFlag(filteredArgs, "--strict");
        const maxRisks = parseMaxRisks(filteredArgs);
        const doctor = bootstrapDoctor({ repoRoot: process.cwd(), fromDoc });
        const risks = doctor?.json?.risks;
        const riskCount = Array.isArray(risks) ? risks.length : 0;
        const highestSeverity = computeHighestSeverity(risks);
        const maxExceeded = maxRisks != null && riskCount > maxRisks;
        const status = String(doctor?.json?.status ?? "ok");
        const passed = !maxExceeded && (strict ? status === "ok" : status !== "error");

        if (check) {
            process.exitCode = passed ? 0 : 1;
        }

        if (json) {
            const payload = {
                ...doctor.json,
                ...(check
                    ? {
                          check: {
                              passed,
                              strict: Boolean(strict),
                              maxRisks,
                              riskCount,
                              highestSeverity,
                          },
                      }
                    : {}),
            };
            console.log(serializeJson(payload));
            return { output: null, result: payload };
        }
        console.log(doctor.text.trimEnd());
        return { output: doctor.text };
    }

    if (subcommand === "inspect") {
        const fromPlan = getArgValue(filteredArgs, "--from-plan") ?? getArgValue(filteredArgs, "--plan");
        if (!fromPlan) {
            usage();
            process.exitCode = 1;
            return { output: null };
        }
        const inspected = inspectBootstrapPlan({ planSource: fromPlan });
        if (json) {
            console.log(inspected.output);
            return { output: null };
        }
        const lines = [
            "Bootstrap Plan Inspect",
            "",
            `- version: ${inspected.bootstrapVersion}`,
            `- writeMode: ${inspected.writeMode}`,
            `- digest: ${inspected.digest ?? "-"}`,
            `- pauseToken: ${inspected.pauseToken ?? "-"}`,
            "",
            `- ops: ${inspected.counts.ops} (mkdir=${inspected.counts.mkdir} writeFile=${inspected.counts.writeFile} copyTemplate=${inspected.counts.copyTemplate} snapshot=${inspected.counts.snapshot})`,
        ];
        console.log(lines.join("\n").trimEnd());
        return { output: lines.join("\n") };
    }

    if (subcommand === "explain") {
        const fromPlan = getArgValue(filteredArgs, "--from-plan") ?? getArgValue(filteredArgs, "--plan");
        if (!fromPlan) {
            usage();
            process.exitCode = 1;
            return { output: null };
        }
        const explained = explainBootstrapPlan({ planSource: fromPlan });
        if (json) {
            console.log(serializeJson(explained.explain));
            return { output: null };
        }
        console.log(explained.output.trimEnd());
        return { output: explained.output };
    }

    if (subcommand === "diff") {
        const fromPlan = getArgValue(filteredArgs, "--from-plan") ?? getArgValue(filteredArgs, "--plan");
        const against = getArgValue(filteredArgs, "--against") ?? "disk";
        if (!fromPlan) {
            usage();
            process.exitCode = 1;
            return { output: null };
        }
        const diff = diffBootstrapPlan({ repoRoot: process.cwd(), planSource: fromPlan, against });
        if (json) {
            console.log(diff.json);
            return { output: null };
        }
        console.log(diff.text.trimEnd());
        return { output: diff.text };
    }

    if (subcommand === "apply") {
        const fromPlan = getArgValue(filteredArgs, "--from-plan") ?? getArgValue(filteredArgs, "--plan");
        const confirm = getArgValue(filteredArgs, "--confirm");
        const enableWrite = getFlag(filteredArgs, "--enable-write");
        if (!fromPlan || !confirm) {
            usage();
            process.exitCode = 1;
            return { output: null };
        }
        try {
            const applied = applyBootstrapPlan({ repoRoot: process.cwd(), planSource: fromPlan, enableWrite, confirm });
            if (json) {
                console.log(
                    serializeJson({
                        ok: true,
                        command: "bootstrap",
                        action: "apply",
                        repoRoot: applied.repoRoot,
                        snapshotId: applied.snapshotId,
                        summary: applied.summary,
                        applyReport: applied.applyReport,
                        contract: applied.contract,
                    }),
                );
                return { output: null };
            }
            const lines = [
                "OK Bootstrap apply completed",
                "",
                `- snapshotId: ${applied.snapshotId}`,
                "",
                "Next:",
                "* Run repo-context-kit scan",
            ];
            console.log(lines.join("\n").trimEnd());
            return { output: lines.join("\n") };
        } catch (error) {
            const message = error?.message ? String(error.message) : String(error);
            console.error(`ERROR ${message}`);
            process.exitCode = 1;
            return { output: null };
        }
    }

    console.error("Unknown bootstrap command.");
    usage();
    process.exitCode = 1;
    return { output: null };
}
