export const AUTO_GENERATED_START = "<!-- AUTO-GENERATED START -->";
export const AUTO_GENERATED_END = "<!-- AUTO-GENERATED END -->";
export const LEGACY_AUTO_GENERATED_START = "<!-- AUTO-GENERATED:START -->";
export const LEGACY_AUTO_GENERATED_END = "<!-- AUTO-GENERATED:END -->";

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
