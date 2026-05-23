import fs from "node:fs";
import path from "node:path";

const PDGL_START = "<!-- PDGL:v1 START -->";
const PDGL_END = "<!-- PDGL:v1 END -->";

const REQUIRED_SECTIONS = [
    "Project Identity",
    "Product / Runtime Intent",
    "Stack Decisions",
    "Runtime Constraints",
    "Development Workflow",
    "Architecture Notes",
    "Bootstrap Guidance",
    "AI Collaboration Rules",
];

const CHECKS = [
    { id: "runtime-missing-nongoals", label: "Non-goals", section: "Project Identity", keyword: "Non-goals" },
    { id: "runtime-missing-test-strategy", label: "Testing strategy", section: "Development Workflow", keyword: "Testing strategy" },
    { id: "runtime-missing-runtime-constraints", label: "Runtime constraints", section: "Runtime Constraints", keyword: null },
    { id: "runtime-missing-deployment-boundaries", label: "Deployment boundaries", section: "Runtime Constraints", keyword: "Deployment boundaries" },
    { id: "runtime-missing-stack-decisions", label: "Stack decisions", section: "Stack Decisions", keyword: null },
    { id: "runtime-missing-dangerous-ops", label: "Dangerous operations", section: "Runtime Constraints", keyword: "Dangerous operations" },
    { id: "runtime-missing-files-never-touch", label: "Files never touch", section: "Runtime Constraints", keyword: "Files never touch" },
    { id: "runtime-missing-bootstrap-guidance", label: "Bootstrap guidance", section: "Bootstrap Guidance", keyword: null },
];

function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function getProjectMdPath(repoRoot) {
    const root = String(repoRoot ?? "").trim() || process.cwd();
    return path.resolve(root, "PROJECT.md");
}

function sliceBetweenMarkers(content, startMarker, endMarker) {
    const startIndex = content.indexOf(startMarker);
    const endIndex = content.indexOf(endMarker);
    if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) return null;
    return content.slice(startIndex + startMarker.length, endIndex).trim();
}

function normalizeLines(text) {
    return String(text ?? "").replace(/\r\n/g, "\n").split("\n");
}

function isMeaningfulLine(line) {
    const trimmed = String(line ?? "").trim();
    if (!trimmed) return false;
    if (trimmed.includes("TODO")) return false;
    if (trimmed === "-" || trimmed === "_") return false;
    if (/^\-\s*_?$/.test(trimmed)) return false;
    return true;
}

function parseSections(blockText) {
    const lines = normalizeLines(blockText);
    const sections = new Map();
    let current = null;
    let buffer = [];

    function flush() {
        if (!current) return;
        sections.set(current, buffer.slice());
        buffer = [];
    }

    for (const line of lines) {
        const match = line.match(/^###\s+(.*)\s*$/);
        if (match) {
            flush();
            current = String(match[1] ?? "").trim();
            continue;
        }
        if (!current) continue;
        buffer.push(line);
    }
    flush();
    return sections;
}

function computeSectionQuality(lines, { maxMeaningfulLines = 18, maxChars = 2000 } = {}) {
    const meaningful = Array.isArray(lines) ? lines.filter(isMeaningfulLine) : [];
    const lineCount = meaningful.length;
    const charCount = meaningful.join("\n").length;
    const empty = lineCount === 0;
    const weak = lineCount > 0 && (lineCount < 2 || charCount < 40);
    const overLimit = lineCount > maxMeaningfulLines || charCount > maxChars;
    return { empty, weak, overLimit, lineCount, charCount, maxMeaningfulLines, maxChars };
}

function hasKeywordLine(lines, keyword) {
    if (!keyword) return null;
    const key = String(keyword).trim().toLowerCase();
    if (!key) return null;
    const hay = (Array.isArray(lines) ? lines : []).join("\n").toLowerCase();
    return hay.includes(key);
}

export function readPdglV1Status({ repoRoot, limits } = {}) {
    const filePath = getProjectMdPath(repoRoot);
    const appliedLimits = isPlainObject(limits) ? limits : {};
    if (!fs.existsSync(filePath)) {
        return {
            present: false,
            score: 0,
            missingSections: REQUIRED_SECTIONS.slice(),
            weakSections: [],
            overLimitSections: [],
            missingChecks: CHECKS.map((c) => c.id),
            suggestedImprovements: ["Run rck init to create PROJECT.md, then fill PDGL (v1)."],
            limits: appliedLimits,
        };
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    const block = sliceBetweenMarkers(raw, PDGL_START, PDGL_END);
    if (!block) {
        return {
            present: false,
            score: 0,
            missingSections: REQUIRED_SECTIONS.slice(),
            weakSections: [],
            overLimitSections: [],
            missingChecks: CHECKS.map((c) => c.id),
            suggestedImprovements: ["Add a PDGL:v1 block to PROJECT.md and fill key project design details."],
            limits: appliedLimits,
        };
    }

    const sections = parseSections(block);
    const missingSections = [];
    const weakSections = [];
    const overLimitSections = [];
    for (const name of REQUIRED_SECTIONS) {
        if (!sections.has(name)) {
            missingSections.push(name);
            continue;
        }
        const quality = computeSectionQuality(sections.get(name), appliedLimits);
        if (quality.empty) {
            weakSections.push(name);
        } else if (quality.weak) {
            weakSections.push(name);
        }
        if (quality.overLimit) {
            overLimitSections.push({ section: name, lineCount: quality.lineCount, charCount: quality.charCount });
        }
    }

    const missingChecks = [];
    for (const check of CHECKS) {
        const lines = sections.get(check.section) || [];
        const keywordOk = check.keyword ? hasKeywordLine(lines, check.keyword) : null;
        const quality = computeSectionQuality(lines, appliedLimits);
        const sectionOk = !quality.empty;
        if (check.keyword) {
            if (keywordOk !== true) {
                missingChecks.push(check.id);
            }
        } else {
            if (!sectionOk) {
                missingChecks.push(check.id);
            }
        }
    }

    let score = 100;
    score -= missingSections.length * 12;
    score -= weakSections.length * 6;
    score -= missingChecks.length * 8;
    if (overLimitSections.length > 0) score -= 5;
    score = Math.max(0, Math.min(100, score));

    const suggested = [];
    for (const id of missingChecks) {
        const found = CHECKS.find((c) => c.id === id);
        if (!found) continue;
        suggested.push(`Fill "${found.label}" under "${found.section}".`);
    }
    if (missingSections.length) {
        suggested.push("Add the missing PDGL sections so the runtime can stay stable over time.");
    }
    if (weakSections.length) {
        suggested.push("Strengthen weak PDGL sections with 2-6 concise bullets each.");
    }
    if (overLimitSections.length) {
        suggested.push("Keep PDGL sections concise to reduce context drift and review load.");
    }

    return {
        present: true,
        score,
        missingSections,
        weakSections,
        overLimitSections,
        missingChecks,
        suggestedImprovements: [...new Set(suggested)].slice(0, 12),
        limits: appliedLimits,
    };
}

export function getPdglV1Markers() {
    return { start: PDGL_START, end: PDGL_END };
}
