export const AUTO_GENERATED_START = "<!-- AUTO-GENERATED START -->";
export const AUTO_GENERATED_END = "<!-- AUTO-GENERATED END -->";
export const LEGACY_AUTO_GENERATED_START = "<!-- AUTO-GENERATED:START -->";
export const LEGACY_AUTO_GENERATED_END = "<!-- AUTO-GENERATED:END -->";

export const CONTEXT_DIR = ".aidw";
export const CONTEXT_PROJECT_MD_PATH = `${CONTEXT_DIR}/project.md`;
export const CONTEXT_META_PATH = `${CONTEXT_DIR}/meta.json`;
export const CONTEXT_SCAN_LAST_PATH = `${CONTEXT_DIR}/scan/last.json`;

export const MANAGED_CONTEXT_FILE_PATHS = new Set([
    CONTEXT_PROJECT_MD_PATH,
    CONTEXT_META_PATH,
    CONTEXT_SCAN_LAST_PATH,
]);

export const PROJECT_TYPES = {
    CLI_TOOL: "cli-tool",
    WEB_APP: "web-app",
    BACKEND_APP: "backend-app",
    FULLSTACK_APP: "fullstack-app",
    TEMPLATE_REPO: "template-repo",
    GENERIC: "generic",
};

export const IMPORTANT_SCRIPT_NAMES = new Set([
    "dev",
    "build",
    "test",
    "lint",
    "scan",
    "start",
    "prepare",
]);

export const WEB_PATHS = ["app", "src/app", "pages", "src/pages"];

export const STRONG_BACKEND_PATHS = [
    "server",
    "src/server",
    "api",
    "src/api",
];

export const STRONG_BACKEND_FILES = [
    "prisma/schema.prisma",
];

export const BACKEND_DEPENDENCIES = [
    "express",
    "fastify",
    "@nestjs",
];

export const WEAK_BACKEND_PATHS = [
    "services",
    "src/services",
    "config",
    "src/config",
    "controllers",
    "src/controllers",
    "repositories",
    "src/repositories",
];

export const NEXT_CONFIG_PATHS = [
    "next.config.js",
    "next.config.mjs",
    "next.config.ts",
];
