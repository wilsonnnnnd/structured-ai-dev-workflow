export const AUTO_GENERATED_START = "<!-- AUTO-GENERATED START -->";
export const AUTO_GENERATED_END = "<!-- AUTO-GENERATED END -->";
export const LEGACY_AUTO_GENERATED_START = "<!-- AUTO-GENERATED:START -->";
export const LEGACY_AUTO_GENERATED_END = "<!-- AUTO-GENERATED:END -->";

export const CONTEXT_DIR = ".aidw";
export const CONTEXT_VERSION = 1;
export const HUMAN_PROJECT_BRIEF_PATH = "PROJECT.md";
export const CONTEXT_AI_PATH = `${CONTEXT_DIR}/AI.md`;
export const CONTEXT_PROJECT_MD_PATH = `${CONTEXT_DIR}/AI_project.md`;
export const CONTEXT_SYSTEM_OVERVIEW_PATH = `${CONTEXT_DIR}/system-overview.md`;
export const CONTEXT_WORKFLOW_PATH = `${CONTEXT_DIR}/workflow.md`;
export const CONTEXT_SAFETY_PATH = `${CONTEXT_DIR}/safety.md`;
export const CONTEXT_META_PATH = `${CONTEXT_DIR}/meta.json`;
export const CONTEXT_SCAN_LAST_PATH = `${CONTEXT_DIR}/scan/last.json`;
export const CONTEXT_LESSONS_PATH = `${CONTEXT_DIR}/lessons.json`;
export const CONTEXT_LESSONS_PENDING_PATH = `${CONTEXT_DIR}/lessons.pending.json`;
export const CONTEXT_TASKS_DIR = `${CONTEXT_DIR}/context`;
export const CONTEXT_TASKS_PATH = `${CONTEXT_TASKS_DIR}/tasks.json`;
export const RUNTIME_DIR = `${CONTEXT_DIR}/runtime`;
export const RUNTIME_TASK_PATH = `${RUNTIME_DIR}/task.json`;
export const RUNTIME_CONTEXT_PATH = `${RUNTIME_DIR}/context.json`;
export const RUNTIME_EXECUTION_PATH = `${RUNTIME_DIR}/execution.json`;
export const RUNTIME_VERIFICATION_PATH = `${RUNTIME_DIR}/verification.json`;
export const TASK_REGISTRY_PATH = "task/task.md";
export const CONTEXT_INDEX_DIR = `${CONTEXT_DIR}/index`;
export const CONTEXT_INDEX_FILE_GROUPS_PATH = `${CONTEXT_INDEX_DIR}/file-groups.json`;
export const CONTEXT_INDEX_FILES_PATH = `${CONTEXT_INDEX_DIR}/files.json`;
export const CONTEXT_INDEX_FILE_SUMMARIES_PATH = `${CONTEXT_INDEX_DIR}/file-summaries.json`;
export const CONTEXT_INDEX_SUMMARY_PATH = `${CONTEXT_INDEX_DIR}/summary.json`;
export const CONTEXT_INDEX_SYMBOLS_PATH = `${CONTEXT_INDEX_DIR}/symbols.json`;
export const CONTEXT_INDEX_ENTRYPOINTS_PATH = `${CONTEXT_INDEX_DIR}/entrypoints.json`;

export const MAX_INDEX_FILES = 200;
export const MAX_INDEX_SYMBOLS = 500;
export const MAX_FILE_GROUPS = 80;
export const MAX_TASKS = 50;
export const MAX_DESCRIPTION_LENGTH = 120;

export const MANAGED_CONTEXT_FILE_PATHS = new Set([
    CONTEXT_PROJECT_MD_PATH,
    CONTEXT_WORKFLOW_PATH,
    CONTEXT_SAFETY_PATH,
    CONTEXT_META_PATH,
    CONTEXT_SCAN_LAST_PATH,
]);

export const AGENT_FILE_PATHS = new Set([
    "AGENTS.md",
    "skill.md",
    ".claude/skills/repo-context-kit/SKILL.md",
    ".github/copilot-instructions.md",
    ".github/agents/repo-context-kit.agent.md",
    ".trae/rules/project_rules.md",
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

export const PYTHON_PROJECT_FILES = [
    "pyproject.toml",
    "requirements.txt",
    "setup.py",
    "poetry.lock",
    "Pipfile",
];

export const FASTAPI_ENTRYPOINT_PATHS = [
    "app/main.py",
    "main.py",
    "src/main.py",
    "app/api/main.py",
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
