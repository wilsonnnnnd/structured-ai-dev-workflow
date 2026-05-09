import fs from "node:fs";
import path from "node:path";

const SHC_START = "<!-- SHC:v1 START -->";
const SHC_END = "<!-- SHC:v1 END -->";

const REQUIRED_SECTIONS = [
    "Project Goal",
    "Target Users",
    "Non-goals",
    "Stack Decisions",
    "Runtime Constraints",
    "Directory Conventions",
    "Config Sources",
    "Testing Strategy",
    "Release Constraints",
    "Files Never Touch",
    "Deployment Boundaries",
];

const DEFAULT_LIMITS = {
    maxLinesPerSection: 12,
    maxCharsPerSection: 1200,
};

function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function getProjectMdPath(repoRoot) {
    const root = String(repoRoot ?? "").trim() || process.cwd();
    return path.resolve(root, ".aidw/project.md");
}

function normalizeLines(text) {
    return String(text ?? "").replace(/\r\n/g, "\n").split("\n");
}

function sliceBetweenMarkers(content, startMarker, endMarker) {
    const startIndex = content.indexOf(startMarker);
    const endIndex = content.indexOf(endMarker);
    if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) return null;
    return content.slice(startIndex + startMarker.length, endIndex).trim();
}

function isMeaningfulLine(line) {
    const trimmed = String(line ?? "").trim();
    if (!trimmed) return false;
    if (trimmed === "- TODO" || trimmed === "TODO") return false;
    if (trimmed === "- _" || trimmed === "_") return false;
    return true;
}

function extractSectionBodies(blockText) {
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

function computeSectionStats(sectionLines, limits) {
    const rawLines = Array.isArray(sectionLines) ? sectionLines : [];
    const meaningful = rawLines.filter((line) => isMeaningfulLine(line));
    const lineCount = meaningful.length;
    const chars = meaningful.join("\n").length;
    return {
        lineCount,
        charCount: chars,
        overLines: lineCount > limits.maxLinesPerSection,
        overChars: chars > limits.maxCharsPerSection,
        empty: lineCount === 0,
    };
}

export function readShcV1Status({ repoRoot, limits } = {}) {
    const appliedLimits = {
        ...DEFAULT_LIMITS,
        ...(isPlainObject(limits) ? limits : {}),
    };
    const filePath = getProjectMdPath(repoRoot);
    if (!fs.existsSync(filePath)) {
        return {
            present: false,
            complete: false,
            bounded: true,
            missingSections: REQUIRED_SECTIONS.slice(),
            incompleteSections: [],
            overLimitSections: [],
            limits: appliedLimits,
        };
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    const block = sliceBetweenMarkers(raw, SHC_START, SHC_END);
    if (!block) {
        return {
            present: false,
            complete: false,
            bounded: true,
            missingSections: REQUIRED_SECTIONS.slice(),
            incompleteSections: [],
            overLimitSections: [],
            limits: appliedLimits,
        };
    }

    const sectionBodies = extractSectionBodies(block);
    const missingSections = [];
    const incompleteSections = [];
    const overLimitSections = [];

    for (const sectionName of REQUIRED_SECTIONS) {
        if (!sectionBodies.has(sectionName)) {
            missingSections.push(sectionName);
            continue;
        }
        const stats = computeSectionStats(sectionBodies.get(sectionName), appliedLimits);
        if (stats.empty) {
            incompleteSections.push(sectionName);
        }
        if (stats.overLines || stats.overChars) {
            overLimitSections.push({
                section: sectionName,
                lineCount: stats.lineCount,
                charCount: stats.charCount,
                maxLinesPerSection: appliedLimits.maxLinesPerSection,
                maxCharsPerSection: appliedLimits.maxCharsPerSection,
            });
        }
    }

    const complete = missingSections.length === 0 && incompleteSections.length === 0;
    const bounded = overLimitSections.length === 0;

    return {
        present: true,
        complete,
        bounded,
        missingSections,
        incompleteSections,
        overLimitSections,
        limits: appliedLimits,
    };
}

export function getShcV1Markers() {
    return { start: SHC_START, end: SHC_END };
}

export function getShcV1RequiredSections() {
    return REQUIRED_SECTIONS.slice();
}

