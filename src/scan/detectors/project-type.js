import {
    BACKEND_DEPENDENCIES,
    NEXT_CONFIG_PATHS,
    PROJECT_TYPES,
    STRONG_BACKEND_FILES,
    STRONG_BACKEND_PATHS,
    WEAK_BACKEND_PATHS,
    WEB_PATHS,
} from "../constants.js";
import { anyExists, exists } from "../fs-utils.js";
import { getPackageJson } from "../package-utils.js";

function hasBackendDependency() {
    const pkg = getPackageJson();
    const deps = {
        ...(pkg?.dependencies || {}),
        ...(pkg?.devDependencies || {}),
    };

    return Object.keys(deps).some((name) =>
        BACKEND_DEPENDENCIES.some(
            (dependency) =>
                name === dependency ||
                (dependency === "@nestjs" && name.startsWith("@nestjs/")),
        ),
    );
}

function detectBackendSignals() {
    return {
        strong:
            anyExists(STRONG_BACKEND_PATHS) ||
            anyExists(STRONG_BACKEND_FILES) ||
            hasBackendDependency(),
        weak: anyExists(WEAK_BACKEND_PATHS),
    };
}

export function detectProjectType() {
    const hasWeb = anyExists(WEB_PATHS) || anyExists(NEXT_CONFIG_PATHS);
    const backendSignals = detectBackendSignals();
    const hasBackend = backendSignals.strong;
    const hasCli = exists("bin") && exists("package.json");
    const hasTemplate = exists("template");

    if (hasWeb && hasBackend) {
        return PROJECT_TYPES.FULLSTACK_APP;
    }

    if (hasCli && !hasWeb && !hasBackend) {
        return PROJECT_TYPES.CLI_TOOL;
    }

    if (hasWeb) {
        return PROJECT_TYPES.WEB_APP;
    }

    if (hasBackend) {
        return PROJECT_TYPES.BACKEND_APP;
    }

    if (hasCli) {
        return PROJECT_TYPES.CLI_TOOL;
    }

    if (hasTemplate) {
        return PROJECT_TYPES.TEMPLATE_REPO;
    }

    return PROJECT_TYPES.GENERIC;
}
