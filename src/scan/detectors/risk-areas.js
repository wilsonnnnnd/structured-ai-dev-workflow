import { CONTEXT_DIR, PROJECT_TYPES } from "../constants.js";
import { exists } from "../fs-utils.js";

function hasFrontendStructure(structure) {
    return structure.some((item) =>
        ["app/", "src/app/", "pages/", "src/pages/"].includes(item.label),
    );
}

function hasBackendStructure(structure) {
    return structure.some((item) =>
        [
            "server/",
            "src/server/",
            "api/",
            "src/api/",
            "services/",
            "src/services/",
            "prisma/",
            "config/",
            "src/config/",
        ].includes(item.label),
    );
}

export function detectRiskAreas(projectType, structure, sharedUi) {
    if (projectType === PROJECT_TYPES.CLI_TOOL) {
        return [
            "CLI entrypoints in bin/ can break command execution if moved or renamed",
            "package.json bin/files/version changes affect installation and publish behavior",
            "template/ changes affect every generated target project",
            `skill.md and ${CONTEXT_DIR}/rules.md changes affect controller behavior and workflow boundaries`,
            `${CONTEXT_DIR}/tests/ changes can invalidate regression expectations and evaluation consistency`,
        ];
    }

    const risks = [];

    if (sharedUi.uiDir) {
        risks.push(
            "shared UI components affect many pages and should remain backward compatible",
        );
    }

    if (hasFrontendStructure(structure)) {
        risks.push(
            "routing and page entry points affect navigation and screen-level behavior",
        );
    }

    if (
        exists("app/layout.tsx") ||
        exists("src/app/layout.tsx") ||
        exists("app/layout.jsx") ||
        exists("src/app/layout.jsx")
    ) {
        risks.push("shared layout wrappers can impact many routes at once");
    }

    if (
        exists("styles") ||
        exists("src/styles") ||
        exists("app/globals.css") ||
        exists("src/app/globals.css")
    ) {
        risks.push(
            "global styles and spacing tokens can create broad visual regressions",
        );
    }

    if (
        exists("middleware.ts") ||
        exists("middleware.js") ||
        exists("src/middleware.ts") ||
        exists("src/middleware.js")
    ) {
        risks.push(
            "middleware and auth boundaries can affect access control and routing",
        );
    }

    if (hasBackendStructure(structure)) {
        risks.push("API routing changes can break request handling and integrations");
        risks.push(
            "service and business-logic changes can alter behavior across multiple endpoints",
        );
        risks.push(
            "shared config and environment changes can affect multiple runtime paths",
        );
    }

    if (exists("prisma/schema.prisma")) {
        risks.push(
            "database schema and migration changes can affect persistence and deployment safety",
        );
    }

    return [...new Set(risks)];
}
