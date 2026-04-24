import { CONTEXT_DIR, PROJECT_TYPES } from "../constants.js";
import { exists, findFirstExisting, listDirSafe } from "../fs-utils.js";

export function detectSharedUi() {
    const uiDir = findFirstExisting(["components/ui", "src/components/ui"]);

    if (!uiDir) {
        return { uiDir: null, components: [] };
    }

    const files = listDirSafe(uiDir);
    const componentNames = [];
    const commonMatches = [
        "button",
        "card",
        "dialog",
        "modal",
        "input",
        "form",
        "select",
        "tabs",
        "table",
        "sheet",
        "drawer",
        "dropdown",
        "popover",
        "tooltip",
        "badge",
        "alert",
    ];

    for (const file of files) {
        const lower = file.toLowerCase();

        for (const name of commonMatches) {
            if (lower.includes(name)) {
                componentNames.push(name.charAt(0).toUpperCase() + name.slice(1));
            }
        }
    }

    return {
        uiDir,
        components: [...new Set(componentNames)].sort(),
    };
}

export function detectUtilityDirs() {
    const dirs = [
        "lib",
        "src/lib",
        "services",
        "src/services",
        "config",
        "src/config",
        "server",
        "src/server",
        "api",
        "src/api",
        "prisma",
    ];

    return dirs.filter((dir) => exists(dir));
}

function buildCliReusableSystem() {
    return {
        sections: [
            {
                title: "Core Modules",
                items: [
                    "CLI commands implemented in bin/*.js",
                    "template-driven workflow under template/",
                    "controller logic defined in skill.md",
                    "skill executors under .claude/skills/",
                    `workflow evaluation assets under ${CONTEXT_DIR}/tests/`,
                ],
            },
        ],
    };
}

function buildBackendReusableSystem(utilityDirs) {
    return {
        sections: [
            {
                title: "Core Modules",
                items: [
                    "HTTP server entrypoints under server/ or src/server/",
                    "route and API handlers under api/, src/api/, or server routes",
                    "business logic and services under services/ or src/services/",
                    "database schema and persistence layers under prisma/",
                    "shared utilities and configuration under lib/, config/, or src/config/",
                ],
            },
            {
                title: "Shared Utilities",
                items:
                    utilityDirs.length > 0
                        ? utilityDirs.map((dir) => `${dir}/`)
                        : ["No common utility directories detected"],
            },
        ],
    };
}

export function detectReusableSystem(projectType, sharedUi, utilityDirs) {
    if (projectType === PROJECT_TYPES.CLI_TOOL) {
        return buildCliReusableSystem();
    }

    if (
        projectType === PROJECT_TYPES.BACKEND_APP ||
        projectType === PROJECT_TYPES.FULLSTACK_APP
    ) {
        const sections = buildBackendReusableSystem(utilityDirs).sections;

        if (projectType === PROJECT_TYPES.FULLSTACK_APP) {
            const sharedComponentItems = [];

            if (sharedUi.uiDir) {
                sharedComponentItems.push(`Shared UI directory: \`${sharedUi.uiDir}\``);
                if (sharedUi.components.length > 0) {
                    sharedComponentItems.push(...sharedUi.components);
                } else {
                    sharedComponentItems.push(
                        "Shared UI directory exists, but common component names were not confidently detected",
                    );
                }
            } else {
                sharedComponentItems.push("No shared UI directory detected");
            }

            sections.unshift({
                title: "Shared Components",
                items: sharedComponentItems,
            });
        }

        return { sections };
    }

    const sharedComponentItems = [];

    if (sharedUi.uiDir) {
        sharedComponentItems.push(`Shared UI directory: \`${sharedUi.uiDir}\``);
        if (sharedUi.components.length > 0) {
            sharedComponentItems.push(...sharedUi.components);
        } else {
            sharedComponentItems.push(
                "Shared UI directory exists, but common component names were not confidently detected",
            );
        }
    } else {
        sharedComponentItems.push("No shared UI directory detected");
    }

    return {
        sections: [
            {
                title: "Shared Components",
                items: sharedComponentItems,
            },
            {
                title: "Shared Utilities",
                items:
                    utilityDirs.length > 0
                        ? utilityDirs.map((dir) => `${dir}/`)
                        : ["No common utility directories detected"],
            },
        ],
    };
}
