import { CONTEXT_DIR, PROJECT_TYPES } from "../constants.js";
import { exists } from "../fs-utils.js";

export const STRUCTURE_MAP = [
    { path: "bin", description: "CLI entrypoints and command handlers" },
    {
        path: "template",
        description: "files copied into target projects during init",
    },
    {
        path: CONTEXT_DIR,
        description: "workflow docs, rules, prompts, and evaluation assets",
    },
    {
        path: ".claude",
        description: "Claude-compatible skill modules and executor logic",
    },
    { path: "app", description: "app-router pages and layouts" },
    {
        path: "src/app",
        description: "app-router pages and layouts under src",
    },
    { path: "pages", description: "pages-router entry files" },
    {
        path: "src/pages",
        description: "pages-router entry files under src",
    },
    { path: "components", description: "shared and feature UI components" },
    {
        path: "components/ui",
        description: "shared UI primitives and reusable building blocks",
    },
    {
        path: "src/components",
        description: "shared and feature UI components under src",
    },
    {
        path: "src/components/ui",
        description: "shared UI primitives under src",
    },
    {
        path: "lib",
        description: "shared utilities, helpers, and support logic",
    },
    {
        path: "src/lib",
        description: "shared utilities and helpers under src",
    },
    {
        path: "services",
        description: "business logic and service-layer modules",
    },
    {
        path: "src/services",
        description: "business logic and service-layer modules under src",
    },
    {
        path: "server",
        description: "HTTP server entrypoints and backend runtime code",
    },
    {
        path: "src/server",
        description: "HTTP server entrypoints and backend runtime code under src",
    },
    {
        path: "api",
        description: "route handlers and API endpoint modules",
    },
    {
        path: "src/api",
        description: "route handlers and API endpoint modules under src",
    },
    {
        path: "styles",
        description: "global styles, tokens, and theme definitions",
    },
    {
        path: "src/styles",
        description: "global styles and theme definitions under src",
    },
    {
        path: "config",
        description: "shared configuration and environment constants",
    },
    {
        path: "src/config",
        description: "shared configuration and environment constants under src",
    },
    {
        path: "prisma",
        description: "database schema, migrations, and generated client boundary",
    },
];

const CLI_STRUCTURE_PATHS = new Set([
    "bin",
    "template",
    CONTEXT_DIR,
    ".claude",
    "config",
    "lib",
    "src/lib",
]);

export function detectStructure(projectType) {
    const found = STRUCTURE_MAP.filter((item) => exists(item.path));
    const filtered =
        projectType === PROJECT_TYPES.CLI_TOOL
            ? found.filter((item) => CLI_STRUCTURE_PATHS.has(item.path))
            : found;

    return filtered.map((item) => ({
        label: `${item.path}/`,
        description: item.description,
    }));
}

export function getStructureDescription(path) {
    return STRUCTURE_MAP.find((item) => item.path === path)?.description ?? null;
}

export function getClosestStructurePath(referencePath) {
    const normalizedReference = referencePath.replace(/\/+$/, "");

    const matches = STRUCTURE_MAP.filter(
        (item) =>
            normalizedReference === item.path ||
            normalizedReference.startsWith(`${item.path}/`),
    ).sort((a, b) => b.path.length - a.path.length);

    return matches[0]?.path ?? null;
}
