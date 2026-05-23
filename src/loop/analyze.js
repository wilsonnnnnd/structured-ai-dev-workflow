import { listRecentLoopEvents } from "./store.js";
import { stableStringCompare } from "../runtime/stable-sort.js";

function normalizeTaskId(taskId) {
    const value = String(taskId ?? "").trim().toUpperCase();
    return value || null;
}

function normalizeTitle(title) {
    return String(title ?? "").trim();
}

function isFixTitle(title) {
    const text = normalizeTitle(title).toLowerCase();
    return Boolean(
        text.includes("fix") ||
        text.includes("hotfix") ||
        text.includes("bug") ||
        text.includes("修复") ||
        text.includes("修正") ||
        text.includes("回归") ||
        text.includes("故障"),
    );
}

function isNonZeroExit(event) {
    const exitCode = Number(event?.exitCode);
    return Number.isFinite(exitCode) && exitCode !== 0;
}

function getRecentTests(events) {
    return events.filter((event) => event?.type === "test");
}

function getFailureStreak(testEvents) {
    let streak = 0;
    let lastFailed = null;

    for (const event of testEvents) {
        if (!isNonZeroExit(event)) {
            break;
        }
        streak += 1;
        if (!lastFailed) {
            lastFailed = event;
        }
    }

    return {
        streak,
        lastFailed,
    };
}

function countFailuresByCommand(testEvents, max = 5) {
    const counts = new Map();
    for (const event of testEvents) {
        const command = String(event?.command ?? "").trim();
        if (!command) {
            continue;
        }
        const entry = counts.get(command) ?? { command, fail: 0, pass: 0, lastAt: null };
        if (isNonZeroExit(event)) {
            entry.fail += 1;
        } else {
            entry.pass += 1;
        }
        if (!entry.lastAt) {
            entry.lastAt = event.at ?? null;
        }
        counts.set(command, entry);
    }

    return [...counts.values()]
        .sort((a, b) => b.fail - a.fail || b.pass - a.pass || stableStringCompare(String(b.lastAt ?? ""), String(a.lastAt ?? "")))
        .slice(0, max);
}

export function evaluateContextLoop(options = {}) {
    const requestedTitle = normalizeTitle(options.requestedTitle);
    const taskId = normalizeTaskId(options.taskId);
    let limit = 120;
    let maxBytes = 240_000;
    const desiredTestEvents = 20;
    const maxLimit = 1200;
    const maxBytesLimit = 1_000_000;
    let recentEvents = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
        recentEvents = listRecentLoopEvents({ limit, taskId, maxBytes });
        const testEvents = getRecentTests(recentEvents);
        if (testEvents.length >= desiredTestEvents) {
            break;
        }
        if (recentEvents.length < limit) {
            break;
        }
        if (limit < maxLimit) {
            limit = Math.min(maxLimit, limit * 2);
            continue;
        }
        if (maxBytes < maxBytesLimit) {
            maxBytes = Math.min(maxBytesLimit, maxBytes * 2);
            continue;
        }
        break;
    }
    const testEvents = getRecentTests(recentEvents);
    const mostRecentTest = testEvents[0] ?? null;
    const failuresByCommand = countFailuresByCommand(testEvents, 5);
    const failureStreak = getFailureStreak(testEvents);

    const patterns = {
        recentTestCount: testEvents.length,
        failureStreak: failureStreak.streak,
        topFailingCommands: failuresByCommand.filter((entry) => entry.fail > 0),
    };

    const unstable = failureStreak.streak >= 2;
    const lastFailed = Boolean(mostRecentTest && isNonZeroExit(mostRecentTest));
    const isFix = isFixTitle(requestedTitle);
    const repeatedCommandFailures = patterns.topFailingCommands.find((entry) => entry.fail >= 2) ?? null;

    const constraints = {
        blockNewTask: false,
        blockReason: null,
        unstable,
        requireRootCauseAnalysis: Boolean(repeatedCommandFailures),
        rootCauseCommand: repeatedCommandFailures?.command ?? null,
    };

    if (lastFailed && !isFix) {
        constraints.blockNewTask = true;
        constraints.blockReason = "Most recent test run failed. Create a fix task first or override explicitly.";
    }

    const mutations = {
        riskItems: [],
        testStrategyItems: [],
        requirementItems: [],
        acceptanceCriteriaItems: [],
        suggestedFixTaskTitle: null,
    };

    if (lastFailed) {
        const command = mostRecentTest?.command ? ` (${mostRecentTest.command})` : "";
        mutations.riskItems.push(`Recent test failure${command}.`);
        mutations.acceptanceCriteriaItems.push("Test command passes.");
        mutations.suggestedFixTaskTitle = "Fix failing tests";
    }

    if (unstable) {
        mutations.riskItems.push("Tests have failed multiple times recently; treat this task as unstable until resolved.");
        mutations.acceptanceCriteriaItems.push("Tests pass twice in a row.");
    }

    if (constraints.requireRootCauseAnalysis && constraints.rootCauseCommand) {
        mutations.requirementItems.push(`Provide root cause analysis for repeated failing command: ${constraints.rootCauseCommand}.`);
    }

    if (patterns.topFailingCommands.length > 0) {
        const top = patterns.topFailingCommands[0];
        mutations.testStrategyItems.push(`Prioritize running and stabilizing: ${top.command}.`);
    }

    return {
        patterns,
        constraints,
        mutations,
        recentEvents,
        mostRecentTest,
    };
}
