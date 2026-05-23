#!/usr/bin/env node
import { pathToFileURL } from "url";
import path from "path";
import { isDirectory } from "../src/scan/fs-utils.js";
import { readLessonsFile } from "../src/lessons/store.js";
import { listRecentLoopEvents, appendLoopEvent } from "../src/loop/store.js";
import { computeScanCheckState } from "../src/scan/index.js";
import { getTaskConsistencyWarnings } from "../src/scan/task-files.js";

function usage() {
    console.log(`Usage:
  rck check [--explain] [--strict | --warn-only]
`);
}

function maybeAppendLearnableEvent(event) {
    if (!isDirectory(".aidw")) {
        return null;
    }
    try {
        return appendLoopEvent(event);
    } catch {
        return null;
    }
}

function formatList(lines) {
    if (!lines || lines.length === 0) {
        return "- (none)";
    }
    return lines.map((line) => `- ${line}`).join("\n");
}

const VALID_LEVELS = new Set(["blocker", "warning", "degrade", "info"]);

function normalizeLevel(raw, fallback = "blocker") {
    const value = String(raw ?? "").trim();
    if (VALID_LEVELS.has(value)) {
        return value;
    }
    return fallback;
}

function parseLastNEventsWindow(raw) {
    const value = String(raw ?? "").trim();
    const match = /^last_(\d+)_events$/i.exec(value);
    if (!match) {
        return null;
    }
    const count = Number(match[1]);
    if (!Number.isFinite(count) || count <= 0) {
        return null;
    }
    return Math.floor(count);
}

function parsePositiveInt(raw) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
        return null;
    }
    return Math.floor(value);
}

function pickMostRecentTestFailure(events) {
    for (const event of events) {
        if (event?.type === "test" && Number(event.exitCode) !== 0) {
            return event;
        }
    }
    return null;
}

function evaluateLesson(lesson) {
    if (String(lesson.type ?? "").trim() === "derived") {
        return { matched: false, evidence: [], why: null, howToFix: [], derived: true };
    }
    if (String(lesson.type ?? "").trim() === "effect") {
        return { matched: false, evidence: [], why: null, howToFix: [], effect: true };
    }
    if (lesson.active === false) {
        return { matched: false, evidence: [], why: null, howToFix: [] };
    }

    const type = String(lesson.type ?? "").trim();
    const severity = normalizeLevel(lesson.severity, "blocker");
    const fixLines =
        typeof lesson.fix === "string"
            ? lesson.fix
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean)
            : [];

    if (type === "tests_failed" || type === "tests_must_pass") {
        const windowSize = parseLastNEventsWindow(lesson.window);
        const threshold = parsePositiveInt(lesson.threshold);
        const events = listRecentLoopEvents({
            limit: windowSize ?? 80,
            maxBytes: 1_000_000,
        });
        const failures = events.filter(
            (event) => event?.type === "test" && Number(event.exitCode) !== 0,
        ).length;
        if (windowSize && threshold) {
            if (failures < threshold) {
                return { matched: false, evidence: [], why: null, howToFix: [] };
            }
        } else if (failures === 0) {
            return { matched: false, evidence: [], why: null, howToFix: [] };
        }
        const failure = pickMostRecentTestFailure(events);
        const evidence = [
            windowSize ? `window: last_${windowSize}_events` : null,
            threshold ? `threshold: ${threshold}` : null,
            windowSize && threshold ? `observed: ${failures}` : null,
            failure ? `last_test_exit: ${failure.exitCode ?? "-"}` : null,
            failure?.command ? `last_test_command: ${failure.command}` : null,
            failure?.taskId ? `task_id: ${failure.taskId}` : null,
            lesson.confidence != null ? `confidence: ${lesson.confidence}` : null,
        ].filter(Boolean);
        return {
            matched: true,
            severity,
            why: typeof lesson.pattern === "string" ? lesson.pattern : "Recent tests failed.",
            evidence,
            howToFix: fixLines.length > 0 ? fixLines : ["Run tests and fix failures."],
        };
    }

    if (type === "scan_stale" || type === "scan_must_be_up_to_date") {
        const windowSize = parseLastNEventsWindow(lesson.window);
        const threshold = parsePositiveInt(lesson.threshold);
        if (windowSize && threshold) {
            const events = listRecentLoopEvents({ limit: windowSize, maxBytes: 1_000_000 });
            const failures = events.filter((event) => event?.type === "scan_check_failed").length;
            if (failures < threshold) {
                return { matched: false, evidence: [], why: null, howToFix: [] };
            }
            return {
                matched: true,
                severity,
                why:
                    typeof lesson.pattern === "string"
                        ? lesson.pattern
                        : "Scan check indicates generated context is stale.",
                evidence: [
                    `window: last_${windowSize}_events`,
                    `threshold: ${threshold}`,
                    `observed: ${failures}`,
                    lesson.confidence != null ? `confidence: ${lesson.confidence}` : null,
                ].filter(Boolean),
                howToFix: fixLines.length > 0 ? fixLines : ["Run: rck scan"],
            };
        }

        const { update } = computeScanCheckState();
        if (!update.changed) {
            return { matched: false, evidence: [], why: null, howToFix: [] };
        }
        const evidence = [
            update.projectChanged ? ".aidw/AI_project.md is out of date" : null,
            update.systemOverviewChanged ? ".aidw/system-overview.md is out of date" : null,
            update.taskMapChanged ? ".aidw/context/tasks.json is out of date" : null,
            update.taskRegistryChanged ? "task registry mismatch detected" : null,
            lesson.confidence != null ? `confidence: ${lesson.confidence}` : null,
        ].filter(Boolean);
        return {
            matched: true,
            severity,
            why:
                typeof lesson.pattern === "string"
                    ? lesson.pattern
                    : "Scan output is out of date.",
            evidence,
            howToFix: fixLines.length > 0 ? fixLines : ["Run: rck scan"],
        };
    }

    if (type === "task_registry_mismatch" || type === "task_registry_consistent") {
        const windowSize = parseLastNEventsWindow(lesson.window);
        const threshold = parsePositiveInt(lesson.threshold);
        if (windowSize && threshold) {
            const events = listRecentLoopEvents({ limit: windowSize, maxBytes: 1_000_000 });
            const failures = events.filter(
                (event) =>
                    event?.type === "scan_check_failed" && event?.taskRegistryChanged === true,
            ).length;
            if (failures < threshold) {
                return { matched: false, evidence: [], why: null, howToFix: [] };
            }
            return {
                matched: true,
                severity,
                why:
                    typeof lesson.pattern === "string"
                        ? lesson.pattern
                        : "Task registry and task files are inconsistent.",
                evidence: [
                    `window: last_${windowSize}_events`,
                    `threshold: ${threshold}`,
                    `observed: ${failures}`,
                    lesson.confidence != null ? `confidence: ${lesson.confidence}` : null,
                ].filter(Boolean),
                howToFix: fixLines.length > 0
                    ? fixLines
                    : ["Fix task/task.md and task/T-*.md to match, then run: rck scan"],
            };
        }

        const warnings = getTaskConsistencyWarnings();
        if (warnings.length === 0) {
            return { matched: false, evidence: [], why: null, howToFix: [] };
        }
        return {
            matched: true,
            severity,
            why:
                typeof lesson.pattern === "string"
                    ? lesson.pattern
                    : "Task registry and task files are inconsistent.",
            evidence: warnings,
            howToFix: fixLines.length > 0
                ? fixLines
                : ["Fix task/task.md and task/T-*.md to match, then run: rck scan"],
        };
    }

    if (type === "generated_context_risk" || type === "generated_context_protected") {
        const windowSize = parseLastNEventsWindow(lesson.window);
        const threshold = parsePositiveInt(lesson.threshold);
        if (windowSize && threshold) {
            const events = listRecentLoopEvents({ limit: windowSize, maxBytes: 1_000_000 });
            const failures = events.filter(
                (event) =>
                    event?.type === "scan_failed" &&
                    event?.reason === "missing_auto_generated_markers",
            ).length;
            if (failures < threshold) {
                return { matched: false, evidence: [], why: null, howToFix: [] };
            }
            return {
                matched: true,
                severity,
                why:
                    typeof lesson.pattern === "string"
                        ? lesson.pattern
                        : "Generated context files are missing required AUTO-GENERATED markers.",
                evidence: [
                    `window: last_${windowSize}_events`,
                    `threshold: ${threshold}`,
                    `observed: ${failures}`,
                    lesson.confidence != null ? `confidence: ${lesson.confidence}` : null,
                ].filter(Boolean),
                howToFix: fixLines.length > 0
                    ? fixLines
                    : ["Restore AUTO-GENERATED markers, then run: rck scan"],
            };
        }

        const { update } = computeScanCheckState();
        if (!update.skipped) {
            return { matched: false, evidence: [], why: null, howToFix: [] };
        }
        return {
            matched: true,
            severity,
            why:
                typeof lesson.pattern === "string"
                    ? lesson.pattern
                    : "Generated context files are missing required AUTO-GENERATED markers.",
            evidence: [
                "AUTO-GENERATED markers missing from .aidw/AI_project.md",
            ],
            howToFix: fixLines.length > 0
                ? fixLines
                : ["Restore AUTO-GENERATED markers, then run: rck scan"],
        };
    }

    return {
        matched: false,
        evidence: [],
        why: null,
        howToFix: [],
        unknown: true,
    };
}

function renderExplain({ lessons, results, matched, effects = {} }) {
    const lines = [];
    lines.push("Check Explain", "");
    lines.push(`- lessons_loaded: ${lessons.length}`);
    lines.push(`- lessons_active: ${lessons.filter((l) => l.active !== false).length}`);
    lines.push(`- lessons_matched: ${matched.length}`, "");

    lines.push("Matches:");
    if (matched.length === 0) {
        lines.push("- (none)");
    } else {
        const blockers = matched.filter((item) => item.result.severity === "blocker");
        const warnings = matched.filter((item) => item.result.severity === "warning");
        const degrades = matched.filter((item) => item.result.severity === "degrade");
        const infos = matched.filter((item) => item.result.severity === "info");

        if (blockers.length > 0) {
            lines.push("- blockers:");
            for (const match of blockers) {
                lines.push(`  - ${match.lesson.id} (${match.lesson.type})`);
            }
        }
        if (warnings.length > 0) {
            lines.push("- warnings:");
            for (const match of warnings) {
                lines.push(`  - ${match.lesson.id} (${match.lesson.type})`);
            }
        }
        if (degrades.length > 0) {
            lines.push("- degrades:");
            for (const match of degrades) {
                lines.push(`  - ${match.lesson.id} (${match.lesson.type})`);
            }
        }
        if (infos.length > 0) {
            lines.push("- infos:");
            for (const match of infos) {
                lines.push(`  - ${match.lesson.id} (${match.lesson.type})`);
            }
        }
    }

    lines.push("");
    lines.push("Evaluations:");
    for (const item of results) {
        lines.push(`- ${item.lesson.id}: ${item.result.matched ? "FAIL" : "PASS"}`);
    }

    lines.push("");
    lines.push("Effects:");
    lines.push(JSON.stringify({ effects }, null, 4));
    lines.push("");
    lines.push("Effect applied:");
    const effectKeys = Object.keys(effects ?? {});
    if (effectKeys.length === 0) {
        lines.push("- (none)");
    } else {
        for (const key of effectKeys) {
            lines.push(`- ${key}: ${effects[key]}`);
        }
    }

    if (matched.length > 0) {
        lines.push("", "Matched Evidence:");
        for (const item of matched) {
            lines.push(`- ${item.lesson.id}:`);
            const evidence = Array.isArray(item.result.evidence) ? item.result.evidence : [];
            if (evidence.length === 0) {
                lines.push("  - (none)");
                continue;
            }
            for (const entry of evidence.slice(0, 10)) {
                lines.push(`  - ${String(entry)}`);
            }
        }
    }

    return `${lines.join("\n")}\n`;
}

function renderOutcome({ matched, title }) {
    const why = matched
        .map((item) => {
            const level = normalizeLevel(item.result.severity ?? item.lesson.severity, "blocker");
            const reason = item.result.why;
            if (!reason) {
                return null;
            }
            return `[${level}] ${reason}`;
        })
        .filter(Boolean);
    const evidence = matched.flatMap((item) => item.result.evidence ?? []);
    const fixes = matched.flatMap((item) => item.result.howToFix ?? []);

    return [
        title,
        "",
        "Why:",
        formatList([...new Set(why)]),
        "",
        "Evidence:",
        formatList([...new Set(evidence.map(String))]),
        "",
        "How to fix:",
        formatList([...new Set(fixes.map(String))]),
        "",
    ].join("\n");
}

export async function runCheck(args = []) {
    if (args.includes("--help") || args.includes("help")) {
        usage();
        return { ok: true };
    }

    const explain = args.includes("--explain");
    const strict = args.includes("--strict");
    const warnOnly = args.includes("--warn-only");

    if (strict && warnOnly) {
        console.error("ERROR Only one check mode can be used at a time.");
        process.exitCode = 1;
        return { ok: false };
    }

    if (!isDirectory(".aidw")) {
        console.error("ERROR Project is not initialized.");
        console.error("Next:");
        console.error("- Run: rck init");
        process.exitCode = 1;
        return { ok: false };
    }

    const lessonsRead = readLessonsFile();
    if (!lessonsRead.ok && lessonsRead.reason === "missing_or_invalid") {
        console.error("ERROR Missing or invalid .aidw/lessons.json");
        console.error("Next:");
        console.error("- Restore .aidw/lessons.json or re-run: rck init");
        process.exitCode = 1;
        return { ok: false };
    }

    const file = lessonsRead.value;
    const lessons = file.lessons ?? [];
    const baseLessons = lessons.filter(
        (lesson) => String(lesson.type ?? "").trim() !== "derived" && String(lesson.type ?? "").trim() !== "effect",
    );
    const derivedLessons = lessons.filter((lesson) => String(lesson.type ?? "").trim() === "derived");
    const effectLessons = lessons.filter((lesson) => String(lesson.type ?? "").trim() === "effect");

    const baseResults = baseLessons.map((lesson) => ({ lesson, result: evaluateLesson(lesson) }));
    const baseMatchedActive = baseResults.filter(
        (item) => item.lesson.active !== false && item.result.matched,
    );

    function isConditionSatisfied(condition) {
        const key = String(condition ?? "").trim();
        if (!key) {
            return false;
        }
        return baseMatchedActive.some(
            (item) => item.lesson.id === key || item.lesson.type === key,
        );
    }

    const derivedResults = derivedLessons.map((lesson) => {
        if (lesson.active === false) {
            return { lesson, result: { matched: false, evidence: [], why: null, howToFix: [] } };
        }
        const conditions = Array.isArray(lesson.conditions) ? lesson.conditions : [];
        const missing = conditions.filter((condition) => !isConditionSatisfied(condition));
        if (conditions.length === 0 || missing.length > 0) {
            return { lesson, result: { matched: false, evidence: [], why: null, howToFix: [] } };
        }
        const level = normalizeLevel(lesson.action ?? lesson.severity, "warning");
        const fixLines =
            typeof lesson.fix === "string"
                ? lesson.fix
                      .split("\n")
                      .map((line) => line.trim())
                      .filter(Boolean)
                : [];
        return {
            lesson,
            result: {
                matched: true,
                severity: level,
                why:
                    typeof lesson.pattern === "string" && lesson.pattern.trim()
                        ? lesson.pattern.trim()
                        : `Derived lesson matched: ${lesson.id}`,
                evidence: conditions.map((condition) => `condition: ${condition}`),
                howToFix: fixLines,
            },
        };
    });

    const effects = {};
    for (const lesson of effectLessons) {
        if (lesson.active === false) {
            continue;
        }
        const triggers = Array.isArray(lesson.trigger) ? lesson.trigger : [];
        const shouldApply = triggers.some((trigger) => isConditionSatisfied(trigger));
        if (!shouldApply) {
            continue;
        }
        const effect =
            lesson.effect && typeof lesson.effect === "object" && !Array.isArray(lesson.effect)
                ? lesson.effect
                : {};
        for (const [key, value] of Object.entries(effect)) {
            effects[key] = value;
        }
    }

    const results = baseResults.concat(derivedResults);
    const matchedActive = results.filter((item) => item.lesson.active !== false && item.result.matched);
    const blockers = matchedActive.filter(
        (item) => normalizeLevel(item.result.severity ?? item.lesson.severity, "blocker") === "blocker",
    );
    const warnings = matchedActive.filter(
        (item) => normalizeLevel(item.result.severity ?? item.lesson.severity, "blocker") === "warning",
    );
    const degrades = matchedActive.filter(
        (item) => normalizeLevel(item.result.severity ?? item.lesson.severity, "blocker") === "degrade",
    );

    if (explain) {
        console.log(
            renderExplain({
                lessons,
                results,
                matched: matchedActive,
                effects,
            }).trimEnd(),
        );
    }

    const strictMatches = strict ? blockers.concat(warnings, degrades) : blockers;
    const shouldFail = !warnOnly && strictMatches.length > 0;

    if (matchedActive.length > 0) {
        const title = shouldFail ? "Check Failed" : "Check Warnings";
        const output = renderOutcome({ matched: matchedActive, title });
        console.log(output.trimEnd());

        const eventBase = {
            matchedLessonIds: matchedActive.map((item) => item.lesson.id),
            matchedLessonTypes: matchedActive.map((item) => item.lesson.type),
            matchedLessonSeverities: matchedActive.map((item) =>
                normalizeLevel(item.result.severity ?? item.lesson.severity, "blocker"),
            ),
            evidence: matchedActive.flatMap((item) => item.result.evidence ?? []),
            effects,
        };

        if (shouldFail) {
            maybeAppendLearnableEvent({
                type: "check_failed",
                ok: false,
                ...eventBase,
            });
            process.exitCode = 1;
            return { ok: false, matched: matchedActive.map((item) => item.lesson.id) };
        }

        maybeAppendLearnableEvent({
            type: "check_warned",
            ok: true,
            ...eventBase,
        });
        process.exitCode = 0;
        return { ok: true, warned: matchedActive.map((item) => item.lesson.id) };
    }

    console.log("Checks passed.");
    maybeAppendLearnableEvent({
        type: "check_passed",
        ok: true,
    });
    process.exitCode = 0;
    return { ok: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    runCheck(process.argv.slice(2)).catch((error) => {
        console.error("Unexpected error:", error);
        process.exitCode = 1;
    });
}
