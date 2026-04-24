import {
    AUTO_GENERATED_END,
    AUTO_GENERATED_START,
    CONTEXT_DIR,
    CONTEXT_PROJECT_MD_PATH,
    LEGACY_AUTO_GENERATED_END,
    LEGACY_AUTO_GENERATED_START,
} from "../constants.js";
import {
    ensureDir,
    exists,
    readText,
    writeText,
} from "../fs-utils.js";

function createProjectMdContent(newContent) {
    return `# Project Context

${AUTO_GENERATED_START}
${newContent}
${AUTO_GENERATED_END}

## Manual Notes

- Reuse existing modules, components, and utilities before creating new structures or duplicate logic.
- Keep changes localized and avoid broad edits to shared or global surfaces unless they are clearly required.
- Preserve backward compatibility for shared code paths, public APIs, and common workflows where possible.
- Treat config, environment behavior, routing, and schema changes as higher-risk areas that need extra caution.
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
    if (!exists(CONTEXT_PROJECT_MD_PATH)) {
        return {
            changed: true,
            currentSection: null,
            nextSection: newContent,
            content: createProjectMdContent(newContent),
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
        normalizeSection(currentSection) !== normalizeSection(newContent);

    return {
        changed,
        currentSection,
        nextSection: newContent,
        content: changed ? buildUpdatedContent(existing, markers, newContent) : existing,
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
