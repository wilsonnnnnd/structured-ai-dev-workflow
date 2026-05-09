import { createHash } from "node:crypto";
import fs from "node:fs";
import { IMPORTANT_SCRIPT_NAMES } from "./constants.js";
import { exists, readJson, readText } from "./fs-utils.js";
import {
    hasFastApiSignal,
    hasPythonProjectFile,
} from "./python-utils.js";

export function getPackageJson() {
    return readJson("package.json");
}

export function getPackageJsonDigest() {
    if (!exists("package.json")) {
        return null;
    }

    try {
        const text = readText("package.json");
        return createHash("sha256").update(text).digest("hex");
    } catch {
        return null;
    }
}

function readFileFingerprint(relativePath, maxBytes) {
    if (!exists(relativePath)) {
        return null;
    }
    try {
        const buffer = fs.readFileSync(relativePath);
        const bytes = buffer.byteLength;
        const truncated = Number.isFinite(maxBytes) && maxBytes > 0 && bytes > maxBytes;
        const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;
        const sha256 = createHash("sha256").update(slice).digest("hex");
        return {
            path: relativePath,
            sha256,
            bytes,
            truncated,
            maxBytes: truncated ? maxBytes : null,
        };
    } catch {
        return null;
    }
}

export function getLockfileFingerprints({ maxBytes = 2_000_000 } = {}) {
    return {
        packageLock: readFileFingerprint("package-lock.json", maxBytes),
        pnpmLock: readFileFingerprint("pnpm-lock.yaml", maxBytes),
        yarnLock: readFileFingerprint("yarn.lock", maxBytes),
    };
}

export function detectPackageMetadata() {
    const pkg = getPackageJson();

    if (!pkg) {
        return null;
    }

    const metadata = {
        name: pkg.name || null,
        version: pkg.version || null,
        type: pkg.type || null,
        license: pkg.license || null,
        packageManager: pkg.packageManager || null,
        bin: [],
        scripts: [],
    };

    if (typeof pkg.bin === "string") {
        metadata.bin.push({
            name: pkg.name || "default",
            path: pkg.bin,
        });
    } else if (pkg.bin && typeof pkg.bin === "object") {
        for (const [name, binPath] of Object.entries(pkg.bin)) {
            metadata.bin.push({ name, path: binPath });
        }
    }

    if (pkg.scripts && typeof pkg.scripts === "object") {
        for (const [name, command] of Object.entries(pkg.scripts)) {
            if (IMPORTANT_SCRIPT_NAMES.has(name)) {
                metadata.scripts.push({ name, command });
            }
        }

        if (metadata.scripts.length < 3) {
            const extraScripts = Object.entries(pkg.scripts).slice(0, 6);

            for (const [name, command] of extraScripts) {
                if (!metadata.scripts.find((script) => script.name === name)) {
                    metadata.scripts.push({ name, command });
                }
            }
        }
    }

    return metadata;
}

export function detectTechStack(projectType) {
    const pkg = getPackageJson();
    const deps = {
        ...(pkg?.dependencies || {}),
        ...(pkg?.devDependencies || {}),
    };

    const stack = [];

    if (pkg) {
        stack.push("npm package");
    }

    if (hasPythonProjectFile()) {
        stack.push("Python");
    }

    if (hasFastApiSignal()) {
        stack.push("FastAPI");
    }

    if (projectType === "cli-tool" || (exists("bin") && pkg?.bin)) {
        stack.push("Node.js CLI");
    }

    if (pkg?.type === "module") {
        stack.push("ESM");
    } else if (pkg?.type === "commonjs") {
        stack.push("CommonJS");
    }

    if (exists("tsconfig.json")) {
        stack.push("TypeScript");
    } else if (pkg) {
        stack.push("JavaScript");
    }

    if (
        exists("next.config.js") ||
        exists("next.config.mjs") ||
        exists("next.config.ts") ||
        exists("app") ||
        exists("src/app")
    ) {
        stack.push("Next.js");
    } else if (deps.react) {
        stack.push("React");
    }

    if (
        exists("tailwind.config.js") ||
        exists("tailwind.config.cjs") ||
        exists("tailwind.config.mjs") ||
        exists("tailwind.config.ts") ||
        deps.tailwindcss
    ) {
        stack.push("Tailwind CSS");
    }

    if (deps["styled-components"]) {
        stack.push("styled-components");
    }

    if (deps["@reduxjs/toolkit"] || deps.redux) {
        stack.push("Redux");
    }

    if (deps.zustand) {
        stack.push("Zustand");
    }

    if (deps.prisma || exists("prisma/schema.prisma")) {
        stack.push("Prisma");
    }

    if (deps.express) {
        stack.push("Express");
    }

    if (deps.fastify) {
        stack.push("Fastify");
    }

    if (deps["next-auth"] || deps["@auth/core"]) {
        stack.push("NextAuth/Auth.js");
    }

    if (deps.vitest) {
        stack.push("Vitest");
    }

    if (deps.jest) {
        stack.push("Jest");
    }

    if (
        deps.eslint ||
        exists(".eslintrc") ||
        exists(".eslintrc.js") ||
        exists(".eslintrc.json") ||
        exists("eslint.config.js")
    ) {
        stack.push("ESLint");
    }

    if (
        deps.prettier ||
        exists(".prettierrc") ||
        exists(".prettierrc.json") ||
        exists(".prettierrc.js")
    ) {
        stack.push("Prettier");
    }

    return [...new Set(stack)];
}
