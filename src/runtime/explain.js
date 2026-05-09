import { normalizeRuntimeContract } from "./normalize.js";
import { validateRuntimeContract } from "./runtime-schema.js";
import { applySnapshotRetentionPolicy } from "./retention.js";

function formatList(items) {
    if (!items || items.length === 0) return "- None";
    return items.map((item) => `- ${item}`).join("\n");
}

function computeRiskSeveritySummary(risks) {
    const counts = { blocker: 0, warning: 0, info: 0 };
    if (!Array.isArray(risks)) return counts;
    for (const risk of risks) {
        const severity = String(risk?.severity ?? "").trim().toLowerCase();
        if (severity === "blocker") counts.blocker += 1;
        else if (severity === "warning") counts.warning += 1;
        else if (severity === "info") counts.info += 1;
    }
    return counts;
}

function renderHealthSummary({ scanStatus, riskSummary, validation }) {
    const flags = [];
    if (scanStatus === "missing") flags.push("context_missing");
    else if (scanStatus === "stale") flags.push("context_stale");
    if (riskSummary.blocker > 0) flags.push("blockers_present");
    if (!validation.valid) flags.push("invalid_contract");
    return flags.length ? flags.join(", ") : "ok";
}

export function explainRuntimeContract(contract) {
    const normalized = normalizeRuntimeContract(contract);
    const validation = validateRuntimeContract(normalized);
    const riskCount = Array.isArray(normalized.risks) ? normalized.risks.length : 0;
    const riskSummary = computeRiskSeveritySummary(normalized.risks);
    const worksetSize = Array.isArray(normalized.workset?.files) ? normalized.workset.files.length : 0;
    const scanStatus = normalized.scan?.status ?? "-";
    const sessionStatus = normalized.executionState?.status ?? "-";
    const pauseId = normalized.executionState?.pauseId ?? "-";
    const sessionId = normalized.executionState?.sessionId ?? "-";
    const rdl = normalized.rdl && typeof normalized.rdl === "object" ? normalized.rdl : null;
    const runtimeMode = rdl?.mode ? String(rdl.mode).trim() : "-";
    const freshnessScore = Number.isFinite(Number(rdl?.freshness?.score)) ? Number(rdl.freshness.score) : null;
    const warnings = Array.isArray(validation.warnings) ? validation.warnings : [];
    const errors = Array.isArray(validation.errors) ? validation.errors : [];
    const retention = applySnapshotRetentionPolicy({ repoRoot: normalized.repoRoot || process.cwd() });
    const health = renderHealthSummary({ scanStatus, riskSummary, validation });
    const deepExplain = runtimeMode === "SAFE" || runtimeMode === "REVIEW" || runtimeMode === "EXPERIMENTAL";

    return [
        "# Runtime Contract",
        "",
        `- runtimeVersion: ${normalized.runtimeVersion}`,
        `- mode: ${runtimeMode || "-"}`,
        normalized.task?.id ? `- taskId: ${normalized.task.id}` : "- taskId: -",
        normalized.task?.title ? `- taskTitle: ${normalized.task.title}` : "- taskTitle: -",
        `- scan: ${scanStatus}`,
        freshnessScore != null ? `- context_freshness: ${freshnessScore}%` : null,
        `- workset_files: ${worksetSize}`,
        `- risk_count: ${riskCount}`,
        `- risk_severity: blocker=${riskSummary.blocker}, warning=${riskSummary.warning}, info=${riskSummary.info}`,
        `- health: ${health}`,
        `- sessionId: ${sessionId}`,
        `- pauseId: ${pauseId}`,
        `- status: ${sessionStatus}`,
        "",
        deepExplain && rdl?.freshness
            ? [
                "## Context Freshness",
                "",
                `- score: ${freshnessScore != null ? `${freshnessScore}%` : "-"}`,
                "",
                "### Signals",
                "",
                Array.isArray(rdl.freshness.signals) && rdl.freshness.signals.length
                    ? formatList(
                        rdl.freshness.signals.map((s) => {
                            const id = String(s?.id ?? "").trim() || "-";
                            const penalty = Number.isFinite(Number(s?.penalty)) ? ` (-${Number(s.penalty)})` : "";
                            return `${id}${penalty}`;
                        }),
                    )
                    : "- None",
                "",
                "### Suggested Actions",
                "",
                Array.isArray(rdl.freshness.suggestedActions) && rdl.freshness.suggestedActions.length
                    ? formatList(rdl.freshness.suggestedActions)
                    : "- None",
                "",
            ].join("\n")
            : null,
        deepExplain && rdl?.shc
            ? [
                "## Stable Human Context (SHC)",
                "",
                `- present: ${rdl.shc.present === true ? "true" : "false"}`,
                `- complete: ${rdl.shc.complete === true ? "true" : "false"}`,
                `- bounded: ${rdl.shc.bounded === true ? "true" : "false"}`,
                Array.isArray(rdl.shc.missingSections) && rdl.shc.missingSections.length
                    ? `- missing_sections:\n${formatList(rdl.shc.missingSections)}`
                    : "- missing_sections: none",
                Array.isArray(rdl.shc.incompleteSections) && rdl.shc.incompleteSections.length
                    ? `- incomplete_sections:\n${formatList(rdl.shc.incompleteSections)}`
                    : "- incomplete_sections: none",
                Array.isArray(rdl.shc.overLimitSections) && rdl.shc.overLimitSections.length
                    ? `- over_limit_sections:\n${formatList(rdl.shc.overLimitSections.map((s) => `${s.section} (lines=${s.lineCount}, chars=${s.charCount})`))}`
                    : "- over_limit_sections: none",
                "",
            ].join("\n")
            : null,
        "## Compatibility Notes",
        "",
        warnings.length ? formatList(warnings) : "- None",
        "",
        "## Retention",
        "",
        retention?.exists === false
            ? "- snapshots: none"
            : `- snapshots_count: ${retention?.count ?? "unknown"}`,
        retention?.oldestTimestamp ? `- oldest: ${retention.oldestTimestamp}` : null,
        retention?.warnings?.length ? `- warnings:\n${formatList(retention.warnings)}` : "- warnings: none",
        "",
        "## Validation",
        "",
        `- valid: ${validation.valid ? "true" : "false"}`,
        errors.length ? `- errors:\n${formatList(errors)}` : "- errors: none",
    ].filter(Boolean).join("\n").trimEnd() + "\n";
}
