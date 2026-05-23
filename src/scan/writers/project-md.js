import {
    AUTO_GENERATED_END,
    AUTO_GENERATED_START,
    CONTEXT_DIR,
    CONTEXT_PROJECT_MD_PATH,
    HUMAN_PROJECT_BRIEF_PATH,
    LEGACY_AUTO_GENERATED_END,
    LEGACY_AUTO_GENERATED_START,
} from "../constants.js";
import {
    ensureDir,
    exists,
    readText,
    writeText,
} from "../fs-utils.js";

const MAX_HUMAN_BRIEF_CHARS = 16_000;

function readHumanProjectBrief() {
    if (!exists(HUMAN_PROJECT_BRIEF_PATH)) {
        return "_PROJECT.md is missing. Create it with `rck init` or add it manually._";
    }
    const content = readText(HUMAN_PROJECT_BRIEF_PATH).trim();
    if (!content) {
        return "_PROJECT.md is empty._";
    }
    if (content.length <= MAX_HUMAN_BRIEF_CHARS) {
        return content;
    }
    return `${content.slice(0, MAX_HUMAN_BRIEF_CHARS).trimEnd()}\n\n_Trimmed: PROJECT.md exceeds ${MAX_HUMAN_BRIEF_CHARS} characters._`;
}

function createProjectMdContent(newContent) {
    return `# AI Project Context

${AUTO_GENERATED_START}
${newContent}
${AUTO_GENERATED_END}

## Human Project Brief

Source: \`${HUMAN_PROJECT_BRIEF_PATH}\`

${readHumanProjectBrief()}
`;
}

function findMarkers(content) {
    const markerSets = [
        {
            start: AUTO_GENERATED_START,
            end: AUTO_GENERATED_END,
        },
        {
            start: LEGACY_AUTO_GENERATED_START,
            end: LEGACY_AUTO_GENERATED_END,
        },
    ];

    for (const markers of markerSets) {
        const startIndex = content.indexOf(markers.start);
        const endIndex = content.indexOf(markers.end);

        if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
            return {
                ...markers,
                startIndex,
                endIndex,
            };
        }
    }

    return null;
}

function normalizeSection(content) {
    return content.replace(/\r\n/g, "\n").replace(/^\n/, "").replace(/\n$/, "");
}

function buildUpdatedContent(existing, markers, newContent) {
    const before = existing.slice(0, markers.startIndex);
    const after = existing.slice(markers.endIndex + markers.end.length);

    return `${before}${AUTO_GENERATED_START}
${newContent}
${AUTO_GENERATED_END}${after}`;
}

export function getProjectMdUpdate(newContent) {
    const nextContent = createProjectMdContent(newContent);
    if (!exists(CONTEXT_PROJECT_MD_PATH)) {
        return {
            changed: true,
            currentSection: null,
            nextSection: newContent,
            content: nextContent,
        };
    }

    const existing = readText(CONTEXT_PROJECT_MD_PATH);
    const markers = findMarkers(existing);

    if (!markers) {
        return {
            changed: true,
            currentSection: null,
            nextSection: newContent,
            content: null,
            skipped: true,
            reason: `AUTO-GENERATED markers not found in ${CONTEXT_PROJECT_MD_PATH}.`,
        };
    }

    const currentSection = existing.slice(
        markers.startIndex + markers.start.length,
        markers.endIndex,
    );
    const changed =
        normalizeSection(currentSection) !== normalizeSection(newContent) ||
        normalizeSection(existing) !== normalizeSection(nextContent);

    return {
        changed,
        currentSection,
        nextSection: newContent,
        content: changed ? nextContent : existing,
    };
}

export function updateProjectMd(newContent) {
    const update = getProjectMdUpdate(newContent);

    if (!update.changed) {
        return update;
    }

    if (update.skipped) {
        return update;
    }

    ensureDir(CONTEXT_DIR);
    writeText(CONTEXT_PROJECT_MD_PATH, update.content);

    return update;
}
