import { getRuntimeModeConfig } from "./rdl/modes.js";

function uniqueStrings(values) {
    return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b),
    );
}

function clampString(value, maxChars) {
    const text = String(value ?? "");
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function normalizeSeverity(value) {
    const raw = String(value ?? "").trim().toLowerCase();
    if (raw === "blocker" || raw === "warning" || raw === "info") return raw;
    return "info";
}

function normalizeSource(value) {
    const raw = String(value ?? "").trim().toLowerCase();
    if (raw === "task" || raw === "scan" || raw === "loop" || raw === "lessons" || raw === "workset" || raw === "runtime") {
        return raw;
    }
    return "runtime";
}

function normalizeCategory(value) {
    const raw = String(value ?? "").trim().toLowerCase();
    if (raw === "testing" || raw === "context" || raw === "safety" || raw === "scope" || raw === "stability") {
        return raw;
    }
    return "stability";
}

function normalizeEvidence(evidence) {
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
        return {};
    }
    const keys = Object.keys(evidence).map((k) => String(k)).sort((a, b) => a.localeCompare(b));
    const next = {};
    for (const key of keys.slice(0, 16)) {
        const value = evidence[key];
        if (typeof value === "string") {
            next[key] = clampString(value, 240);
            continue;
        }
        if (typeof value === "number" || typeof value === "boolean" || value == null) {
            next[key] = value;
            continue;
        }
        if (Array.isArray(value)) {
            next[key] = uniqueStrings(value).slice(0, 16);
            continue;
        }
        if (typeof value === "object") {
            const innerKeys = Object.keys(value).map((k) => String(k)).sort((a, b) => a.localeCompare(b));
            const inner = {};
            for (const innerKey of innerKeys.slice(0, 16)) {
                const innerValue = value[innerKey];
                if (typeof innerValue === "string") inner[innerKey] = clampString(innerValue, 240);
                else if (typeof innerValue === "number" || typeof innerValue === "boolean" || innerValue == null) inner[innerKey] = innerValue;
            }
            next[key] = inner;
        }
    }
    return next;
}

function normalizeRisk(raw) {
    const id = String(raw?.id ?? "").trim();
    if (!id) return null;
    const severity = normalizeSeverity(raw?.severity);
    const source = normalizeSource(raw?.source);
    const category = normalizeCategory(raw?.category);
    const message = clampString(String(raw?.message ?? "").trim() || id, 280);
    const evidence = normalizeEvidence(raw?.evidence);
    const suggestedAction = clampString(String(raw?.suggestedAction ?? "").trim(), 280);
    return {
        id,
        severity,
        source,
        category,
        message,
        evidence,
        suggestedAction,
    };
}

function severityWeight(severity) {
    if (severity === "blocker") return 3;
    if (severity === "warning") return 2;
    return 1;
}

function sortRisks(risks) {
    return risks.slice().sort((a, b) => {
        const sev = severityWeight(b.severity) - severityWeight(a.severity);
        if (sev !== 0) return sev;
        const id = a.id.localeCompare(b.id);
        if (id !== 0) return id;
        const source = a.source.localeCompare(b.source);
        if (source !== 0) return source;
        const category = a.category.localeCompare(b.category);
        if (category !== 0) return category;
        return a.message.localeCompare(b.message);
    });
}

function pushRisk(risks, risk) {
    const normalized = normalizeRisk(risk);
    if (!normalized) return;
    if (risks.some((existing) => existing.id === normalized.id)) return;
    risks.push(normalized);
}

function normalizeLoopEvents(loop) {
    if (Array.isArray(loop)) return loop;
    return [];
}

function parseIso(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    const time = Date.parse(raw);
    return Number.isFinite(time) ? time : null;
}

function computeGateResetWindow(events) {
    const atTimes = events.map((e) => parseIso(e?.at)).filter((x) => x != null);
    const latest = atTimes.length ? Math.max(...atTimes) : null;
    return latest;
}

function computeHighRiskHits(files, summaryText) {
    const keywords = [
        "auth",
        "permission",
        "security",
        "crypto",
        "payment",
        "billing",
        "migrate",
        "migration",
        "delete",
        "prod",
        "production",
        "deploy",
        "config",
    ];
    const hits = [];
    const hay = `${uniqueStrings(files).join(" ")} ${String(summaryText ?? "")}`.toLowerCase();
    for (const keyword of keywords) {
        if (hay.includes(keyword)) {
            hits.push(keyword);
        }
    }
    return uniqueStrings(hits);
}

export function collectRuntimeRisks({
    repoRoot,
    task,
    workset,
    scan,
    lessons,
    loop,
    executionState,
    runtime,
} = {}) {
    const risks = [];
    const root = String(repoRoot ?? "").trim();
    const scanStatus = String(scan?.status ?? "").trim().toLowerCase();
    const taskObj = task && typeof task === "object" ? task : null;
    const worksetObj = workset && typeof workset === "object" ? workset : null;
    const runtimeObj = runtime && typeof runtime === "object" ? runtime : null;
    const runtimeMode = String(runtimeObj?.mode ?? "").trim().toUpperCase() || "STANDARD";
    const modeConfig = runtimeObj?.modeConfig && typeof runtimeObj.modeConfig === "object"
        ? runtimeObj.modeConfig
        : getRuntimeModeConfig(runtimeMode);
    const shc = runtimeObj?.shc && typeof runtimeObj.shc === "object" ? runtimeObj.shc : null;
    const freshness = runtimeObj?.freshness && typeof runtimeObj.freshness === "object" ? runtimeObj.freshness : null;

    if (scanStatus === "missing") {
        pushRisk(risks, {
            id: "missing-scan",
            severity: "blocker",
            source: "scan",
            category: "context",
            message: "Generated context is missing.",
            evidence: { repoRoot: root || "-" },
            suggestedAction: "Run repo-context-kit scan (or scan --auto) to generate required .aidw context files.",
        });
    } else if (scanStatus === "stale") {
        pushRisk(risks, {
            id: "stale-scan",
            severity: "warning",
            source: "scan",
            category: "context",
            message: "Generated context may be stale.",
            evidence: { repoRoot: root || "-" },
            suggestedAction: "Run repo-context-kit scan to refresh .aidw context before making changes.",
        });
    }

    if (!shc || shc.present !== true) {
        pushRisk(risks, {
            id: "runtime-shc-missing",
            severity: "warning",
            source: "runtime",
            category: "context",
            message: "Stable Human Context (SHC) is missing from .aidw/project.md.",
            evidence: { path: ".aidw/project.md", shc: "missing" },
            suggestedAction: "Fill the SHC (v1) section in .aidw/project.md Manual Notes to stabilize long-term context.",
        });
    } else if (shc.complete !== true || shc.bounded !== true) {
        pushRisk(risks, {
            id: "runtime-shc-incomplete",
            severity: "warning",
            source: "runtime",
            category: "context",
            message: "Stable Human Context (SHC) is incomplete or exceeds bounds.",
            evidence: {
                missingSections: Array.isArray(shc.missingSections) ? shc.missingSections : [],
                incompleteSections: Array.isArray(shc.incompleteSections) ? shc.incompleteSections : [],
                overLimitSections: Array.isArray(shc.overLimitSections) ? shc.overLimitSections : [],
                limits: shc.limits ?? null,
            },
            suggestedAction: "Complete missing SHC sections and keep each section concise to reduce context drift.",
        });
    }

    if (freshness) {
        const score = Number.isFinite(freshness.score) ? Number(freshness.score) : null;
        const signals = Array.isArray(freshness.signals) ? freshness.signals : [];
        const signalIds = uniqueStrings(signals.map((s) => s?.id));
        const deductions = signals
            .map((s) => {
                const id = String(s?.id ?? "").trim();
                const penalty = Number.isFinite(Number(s?.penalty)) ? Number(s.penalty) : null;
                if (!id) return null;
                return penalty != null ? `${id} (-${penalty})` : id;
            })
            .filter(Boolean);
        const suggestedActions = Array.isArray(freshness.suggestedActions) ? freshness.suggestedActions : [];
        const minFreshness = Number.isFinite(modeConfig?.riskTolerance?.minFreshnessScoreToWrite)
            ? Number(modeConfig.riskTolerance.minFreshnessScoreToWrite)
            : 65;
        const stale = score != null ? score < 80 : Boolean(freshness.scanStale);
        const severity = runtimeMode === "SAFE" && score != null && score < minFreshness ? "blocker" : "warning";

        if (stale) {
            pushRisk(risks, {
                id: "runtime-context-stale",
                severity,
                source: "runtime",
                category: "context",
                message: "Runtime context freshness is low; context drift risk is elevated.",
                evidence: { score, deductions: deductions.slice(0, 10), signals: signalIds.slice(0, 10), minFreshness },
                suggestedAction: suggestedActions[0] || "Run repo-context-kit scan to refresh .aidw context before writing changes.",
            });
        }
        if (signalIds.includes("symbols_drifted")) {
            pushRisk(risks, {
                id: "runtime-symbol-drift",
                severity: "warning",
                source: "runtime",
                category: "context",
                message: "Symbols may have drifted since the last scan.",
                evidence: { score, signals: signalIds.slice(0, 10) },
                suggestedAction: "Run repo-context-kit scan to refresh symbols before relying on them for planning.",
            });
        }
        if (signalIds.includes("entrypoints_changed")) {
            pushRisk(risks, {
                id: "runtime-entrypoint-drift",
                severity: "warning",
                source: "runtime",
                category: "context",
                message: "Entrypoints may have changed since the last scan.",
                evidence: { score, signals: signalIds.slice(0, 10) },
                suggestedAction: "Re-run repo-context-kit scan to re-detect entrypoints.",
            });
        }
        if (signalIds.includes("tasks_stale")) {
            pushRisk(risks, {
                id: "runtime-task-stale",
                severity: "warning",
                source: "runtime",
                category: "context",
                message: "Tasks and task mappings may be stale.",
                evidence: { score, signals: signalIds.slice(0, 10) },
                suggestedAction: "Update tasks and re-run repo-context-kit scan to keep task mappings consistent.",
            });
        }
        if (signalIds.includes("snapshots_missing")) {
            pushRisk(risks, {
                id: "runtime-snapshot-missing",
                severity: "warning",
                source: "runtime",
                category: "stability",
                message: "No runtime snapshots were detected for audit and replay.",
                evidence: { score, signals: signalIds.slice(0, 10) },
                suggestedAction: "Create a runtime snapshot after key milestones to improve auditability and replay.",
            });
        }
    }

    const planning = runtime && typeof runtime === "object" ? runtime.planning : null;
    if (planning && typeof planning === "object" && planning.sourceType === "design-doc") {
        const docPath = String(planning.path ?? "").trim() || "-";
        const sizeBytes = Number(planning.sizeBytes ?? 0);
        const goalsCount = Number(planning.goalsCount ?? 0);
        const requirementsCount = Number(planning.requirementsCount ?? 0);
        const scopeCount = Number(planning.scopeCount ?? 0);
        const acceptanceCount = Number(planning.acceptanceCriteriaCount ?? 0);
        const hasConflicts = Boolean(planning.conflictingRequirements === true);

        if (goalsCount === 0) {
            pushRisk(risks, {
                id: "ambiguous-goal",
                severity: "warning",
                source: "runtime",
                category: "scope",
                message: "Design doc does not declare a clear goal section.",
                evidence: { path: docPath, goalsCount },
                suggestedAction: "Add a Goal section (or a clear first heading) with 1-3 concrete outcomes before planning tasks.",
            });
        }
        if (scopeCount === 0) {
            pushRisk(risks, {
                id: "missing-scope",
                severity: "warning",
                source: "runtime",
                category: "scope",
                message: "Design doc does not declare scope/boundaries.",
                evidence: { path: docPath, scopeCount },
                suggestedAction: "Add a Scope section describing what is in and out of scope to keep execution bounded.",
            });
        }
        if (acceptanceCount === 0) {
            pushRisk(risks, {
                id: "missing-acceptance-criteria",
                severity: "warning",
                source: "runtime",
                category: "scope",
                message: "Design doc does not include acceptance criteria.",
                evidence: { path: docPath, acceptanceCriteriaCount: acceptanceCount },
                suggestedAction: "Add 2-6 acceptance criteria so tasks are verifiable and reviewable.",
            });
        }
        if (hasConflicts) {
            pushRisk(risks, {
                id: "conflicting-requirements",
                severity: "warning",
                source: "runtime",
                category: "stability",
                message: "Design doc requirements appear to contain contradictions.",
                evidence: { path: docPath, requirementsCount },
                suggestedAction: "Resolve contradictory requirements before task generation to avoid unsafe or oscillating execution.",
            });
        }
        if (Number.isFinite(sizeBytes) && sizeBytes > 160 * 1024) {
            pushRisk(risks, {
                id: "oversized-design-doc",
                severity: "warning",
                source: "runtime",
                category: "context",
                message: "Design doc is large; extraction and planning may miss details.",
                evidence: { path: docPath, sizeBytes },
                suggestedAction: "Split the doc into smaller sections or add a concise Goal/Scope/Acceptance Criteria summary at the top.",
            });
        }
    }

    if (taskObj) {
        const testCommand = String(taskObj.testCommand ?? "").trim();
        if (!testCommand || testCommand.toLowerCase() === "todo: add test command") {
            pushRisk(risks, {
                id: "missing-test-command",
                severity: "warning",
                source: "task",
                category: "testing",
                message: "Task is missing a concrete test command.",
                evidence: { taskId: String(taskObj.id ?? "").trim() || "-" },
                suggestedAction: "Add a runnable test command under the task's Test Command section (e.g., npm test).",
            });
        }

        const acceptanceCriteria = Array.isArray(taskObj.acceptanceCriteria)
            ? taskObj.acceptanceCriteria.map((x) => String(x ?? "").trim()).filter(Boolean)
            : [];
        if (acceptanceCriteria.length === 0) {
            pushRisk(risks, {
                id: "missing-acceptance-criteria",
                severity: "warning",
                source: "task",
                category: "scope",
                message: "Task is missing acceptance criteria.",
                evidence: { taskId: String(taskObj.id ?? "").trim() || "-" },
                suggestedAction: "Add 2-6 clear acceptance criteria to make the task verifiable.",
            });
        }

        const requirements = Array.isArray(taskObj.requirements)
            ? taskObj.requirements.map((x) => String(x ?? "").trim()).filter(Boolean)
            : [];
        const goal = String(taskObj.goal ?? "").trim();
        const itemCount = requirements.length + acceptanceCriteria.length;
        const oversized = itemCount > 24 || goal.length > 240;
        if (oversized) {
            pushRisk(risks, {
                id: "oversized-task",
                severity: "info",
                source: "task",
                category: "scope",
                message: "Task may be oversized and hard to execute safely in one pass.",
                evidence: { requirementCount: requirements.length, acceptanceCriteriaCount: acceptanceCriteria.length, goalChars: goal.length },
                suggestedAction: "Split into smaller tasks or tighten Scope to reduce risk and improve reviewability.",
            });
        }
    }

    if (worksetObj) {
        const files = Array.isArray(worksetObj.files) ? uniqueStrings(worksetObj.files) : [];
        const mode = String(worksetObj.mode ?? "").trim().toLowerCase();
        const threshold = mode === "deep" ? 28 : 16;
        if (files.length > threshold) {
            pushRisk(risks, {
                id: "oversized-workset",
                severity: "warning",
                source: "workset",
                category: "context",
                message: "Workset includes many files; review burden and context errors are more likely.",
                evidence: { worksetMode: mode || "-", fileCount: files.length, threshold },
                suggestedAction: "Reduce scope or switch to a smaller workset (digest/compact) before implementation.",
            });
        }

        const hits = computeHighRiskHits(files, worksetObj.summary);
        if (hits.length > 0) {
            pushRisk(risks, {
                id: "high-risk-file-present",
                severity: "warning",
                source: "workset",
                category: "safety",
                message: "Workset appears to touch high-risk areas.",
                evidence: { hits, sampleFiles: files.slice(0, 8) },
                suggestedAction: "Confirm scope and add extra review/tests before changing high-risk areas.",
            });
        }
    }

    const lessonsList = Array.isArray(lessons)
        ? lessons
        : Array.isArray(lessons?.lessons)
            ? lessons.lessons
            : [];
    if (lessonsList.length > 0) {
        const active = lessonsList.filter((l) => l && typeof l === "object" && l.active !== false);
        const bySeverity = { blocker: [], warning: [], degrade: [], info: [] };
        for (const lesson of active) {
            const sev = String(lesson.severity ?? "").trim().toLowerCase();
            if (sev === "blocker" || sev === "warning" || sev === "degrade" || sev === "info") {
                const id = String(lesson.id ?? "").trim();
                if (id) {
                    bySeverity[sev].push(id);
                }
            }
        }
        if (bySeverity.blocker.length > 0) {
            pushRisk(risks, {
                id: "lessons-blocker",
                severity: "blocker",
                source: "lessons",
                category: "stability",
                message: "Blocking lessons are active for this repository.",
                evidence: { blockerLessonIds: uniqueStrings(bySeverity.blocker).slice(0, 8) },
                suggestedAction: "Run repo-context-kit check --explain and address blockers before proceeding.",
            });
        }
        if (bySeverity.warning.length > 0 || bySeverity.degrade.length > 0) {
            pushRisk(risks, {
                id: "lessons-warning",
                severity: "warning",
                source: "lessons",
                category: "stability",
                message: "Warning/degrade lessons are active for this repository.",
                evidence: {
                    warningLessonIds: uniqueStrings(bySeverity.warning).slice(0, 6),
                    degradeLessonIds: uniqueStrings(bySeverity.degrade).slice(0, 6),
                },
                suggestedAction: "Review repo-context-kit check --explain and consider tightening scope or adding tests.",
            });
        }
    }

    const events = normalizeLoopEvents(loop);
    if (events.some((e) => e?.type === "test" && Number(e?.exitCode) !== 0)) {
        const failing = events.find((e) => e?.type === "test" && Number(e?.exitCode) !== 0);
        pushRisk(risks, {
            id: "recent-test-failure",
            severity: "warning",
            source: "loop",
            category: "testing",
            message: "Recent test execution failed in the context loop.",
            evidence: {
                taskId: failing?.taskId ?? null,
                exitCode: failing?.exitCode ?? null,
                command: failing?.command ?? null,
            },
            suggestedAction: "Fix the failing tests (or perform RCA) before expanding scope.",
        });
    }

    const latestAt = computeGateResetWindow(events);
    if (latestAt != null) {
        const windowMinutes = 15;
        const windowMs = windowMinutes * 60_000;
        const resetsInWindow = events.filter((e) => {
            if (e?.type !== "gate_reset") return false;
            const at = parseIso(e?.at);
            return at != null && latestAt - at <= windowMs && latestAt - at >= 0;
        }).length;
        if (resetsInWindow >= 3) {
            pushRisk(risks, {
                id: "repeated-gate-reset",
                severity: "info",
                source: "loop",
                category: "stability",
                message: "Multiple gate resets occurred recently.",
                evidence: { windowMinutes, count: resetsInWindow },
                suggestedAction: "Pause and confirm the workflow gates; avoid repeatedly resetting without addressing the underlying issue.",
            });
        }
    }

    const writeEnabled = Boolean(
        executionState?.mcpWriteEnabled === true ||
            runtime?.writeEnabled === true,
    );
    if (writeEnabled) {
        pushRisk(risks, {
            id: "runtime-write-enabled",
            severity: "info",
            source: "runtime",
            category: "safety",
            message: "Runtime is configured with write capability enabled.",
            evidence: { writeEnabled: true },
            suggestedAction: "Treat outputs as plans; require explicit human confirmation before applying any writes.",
        });
    }

    return sortRisks(risks);
}

export function normalizeRuntimeRisks(risks = []) {
    const next = [];
    const items = Array.isArray(risks) ? risks : [];
    for (const item of items) {
        pushRisk(next, item);
    }
    return sortRisks(next);
}
