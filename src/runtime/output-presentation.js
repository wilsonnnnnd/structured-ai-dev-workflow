function cleanText(value) {
    return String(value ?? "").trim();
}

function cleanList(values) {
    return (Array.isArray(values) ? values : [])
        .map((value) => cleanText(value))
        .filter(Boolean);
}

const HUMAN_LABELS = Object.freeze({
    en: {
        goal: "Goal",
        scope: "Scope",
        checks: "Checks",
        changed: "Changed",
        tests: "Tests",
        risk: "Risk",
        note: "Note",
        need: "Need",
        files: "Files",
        commands: "Commands",
        reason: "Reason",
        needConfirmation: "Need confirmation",
    },
    zh: {
        goal: "目标 Goal",
        scope: "范围 Scope",
        checks: "检查 Checks",
        changed: "变更 Changed",
        tests: "测试 Tests",
        risk: "风险 Risk",
        note: "备注 Note",
        need: "下一步 Need",
        files: "文件 Files",
        commands: "命令 Commands",
        reason: "原因 Reason",
        needConfirmation: "需要确认 Need confirmation",
    },
});

function normalizeHumanLanguage(value) {
    const raw = cleanText(value).toLowerCase();
    if (["zh", "zh-cn", "zh-tw", "chinese", "cn"].includes(raw)) return "zh";
    if (["en", "en-us", "en-gb", "english"].includes(raw)) return "en";
    return null;
}

export function detectHumanLanguage(value) {
    const text = cleanText(value);
    const explicit = normalizeHumanLanguage(text);
    if (explicit) return explicit;

    const cjkMatches = text.match(/[\u3400-\u9fff]/gu) ?? [];
    if (cjkMatches.length === 0) return "en";

    const latinWordMatches = text.match(/[A-Za-z][A-Za-z0-9_-]*/g) ?? [];
    return cjkMatches.length >= latinWordMatches.length ? "zh" : "en";
}

function pickHumanLanguage(options = {}) {
    return normalizeHumanLanguage(options.humanLanguage ?? options.language) ??
        detectHumanLanguage(options.userText ?? options.contextText ?? "");
}

function getLabels(options = {}) {
    return HUMAN_LABELS[pickHumanLanguage(options)] ?? HUMAN_LABELS.en;
}

function renderList(title, values) {
    const list = cleanList(values);
    if (list.length === 0) return [];
    return ["", `${title}:`, "", ...list.map((item) => `* ${item}`)];
}

export function formatCompactOutput({
    state,
    goal,
    scope,
    checks,
    changed,
    tests,
    risk,
    need,
    note,
    humanLanguage,
    language,
    userText,
    contextText,
} = {}) {
    const labels = getLabels({ humanLanguage, language, userText, contextText });
    const lines = [];
    const stateText = cleanText(state);
    if (stateText) lines.push(`State: ${stateText}`);

    const goalText = cleanText(goal);
    if (goalText) lines.push("", `${labels.goal}:`, goalText);

    lines.push(...renderList(labels.scope, scope));
    lines.push(...renderList(labels.checks, checks));
    lines.push(...renderList(labels.changed, changed));

    const testsText = cleanText(tests);
    if (testsText) lines.push("", `${labels.tests}:`, testsText);

    const riskText = cleanText(risk);
    if (riskText) lines.push("", `${labels.risk}:`, riskText);

    const noteText = cleanText(note);
    if (noteText) lines.push("", `${labels.note}:`, noteText);

    const needText = cleanText(need);
    if (needText) lines.push("", `${labels.need}:`, needText);

    return `${lines.join("\n").trim()}\n`;
}

export function formatSmartProtocolOutput({
    title,
    files,
    commands,
    reason,
    risk,
    need,
    humanLanguage,
    language,
    userText,
    contextText,
} = {}) {
    const labels = getLabels({ humanLanguage, language, userText, contextText });
    const lines = [cleanText(title) || labels.needConfirmation];
    lines.push(...renderList(labels.files, files));

    const reasonText = cleanText(reason);
    if (reasonText) lines.push("", `${labels.reason}:`, reasonText);

    lines.push(...renderList(labels.commands, commands));

    const riskText = cleanText(risk);
    if (riskText) lines.push("", `${labels.risk}:`, riskText);

    const needText = cleanText(need);
    if (needText) lines.push("", `${labels.need}:`, needText);

    return `${lines.join("\n").trim()}\n`;
}

export function formatAuditProtocolOutput({
    protocol = "confirmation-protocol/v1",
    state,
    mode,
    gating = {},
    next,
    output,
    confirm = "None",
} = {}) {
    const allowFileEdits = Boolean(gating.allowFileEdits ?? gating.allow_file_edits);
    const allowCommands = Boolean(gating.allowCommands ?? gating.allow_commands);
    return [
        "## State",
        `- protocol: ${cleanText(protocol) || "confirmation-protocol/v1"}`,
        `- state: ${cleanText(state) || "-"}`,
        `- mode: ${cleanText(mode) || "-"}`,
        "- gating:",
        `  - allow_file_edits: ${allowFileEdits ? "true" : "false"}`,
        `  - allow_commands: ${allowCommands ? "true" : "false"}`,
        `- next: ${cleanText(next) || "-"}`,
        "",
        "## Output",
        cleanText(output) || "- None",
        "",
        "## Confirm",
        cleanText(confirm) || "None",
        "",
    ].join("\n");
}

function getReportLabels(options = {}) {
    const language = pickHumanLanguage(options);
    if (language === "zh") {
        return {
            done: "\u5b8c\u6210 Done",
            changed: "\u53d8\u66f4 Changed",
            example: "\u793a\u4f8b Example",
            tests: "\u6d4b\u8bd5 Tests",
            risk: "\u98ce\u9669 Risk",
            remaining: "\u5269\u4f59 Remaining",
        };
    }
    return {
        done: "Done",
        changed: "Changed",
        example: "Example",
        tests: "Tests",
        risk: "Risk",
        remaining: "Remaining",
    };
}

export function formatCompactReport({
    done,
    changed,
    example,
    tests,
    risk,
    remaining,
    humanLanguage,
    language,
    userText,
    contextText,
} = {}) {
    const languageOptions = { humanLanguage, language, userText, contextText };
    const labels = getReportLabels(languageOptions);
    const lines = [];
    lines.push(...renderList(labels.done, done));
    lines.push(...renderList(labels.changed, changed));

    const exampleText = cleanText(example);
    if (exampleText) lines.push("", `${labels.example}:`, "", exampleText);

    lines.push(...renderList(labels.tests, tests));

    const riskText = cleanText(risk);
    if (riskText) lines.push("", `${labels.risk}:`, riskText);

    const remainingText = cleanText(remaining);
    if (remainingText) lines.push("", `${labels.remaining}:`, remainingText);

    return `${lines.join("\n").trim()}\n`;
}
