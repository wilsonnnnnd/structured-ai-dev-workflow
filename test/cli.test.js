import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runInit } from "../bin/init.js";
import { runScan } from "../bin/scan.js";
import { PROJECT_TYPES } from "../src/scan/constants.js";
import { detectProjectType } from "../src/scan/detectors/project-type.js";

const originalCwd = process.cwd();

function writeFile(relativePath, content = "") {
    const fullPath = path.resolve(process.cwd(), relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf-8");
}

async function withTempProject(callback) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-dev-workflow-"));

    try {
        process.chdir(tempDir);
        return await callback(tempDir);
    } finally {
        process.chdir(originalCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

async function withMutedConsole(callback) {
    const log = console.log;

    try {
        console.log = () => {};
        return await callback();
    } finally {
        console.log = log;
    }
}

async function withCapturedConsole(callback) {
    const log = console.log;
    const output = [];

    try {
        console.log = (...args) => {
            output.push(args.join(" "));
        };
        const result = await callback();

        return {
            output,
            result,
        };
    } finally {
        console.log = log;
    }
}

test("CLI behavior", async (t) => {
    await t.test("detects Next.js projects", async () => {
        await withTempProject(() => {
            writeFile("package.json", JSON.stringify({ name: "next-app" }));
            writeFile("next.config.mjs", "export default {};\n");

            assert.equal(detectProjectType(), PROJECT_TYPES.WEB_APP);
        });
    });

    await t.test("detects Node CLI projects", async () => {
        await withTempProject(() => {
            writeFile(
                "package.json",
                JSON.stringify({
                    name: "cli-app",
                    bin: {
                        "cli-app": "bin/cli.js",
                    },
                }),
            );
            writeFile("bin/cli.js", "#!/usr/bin/env node\n");

            assert.equal(detectProjectType(), PROJECT_TYPES.CLI_TOOL);
        });
    });

    await t.test("does not classify weak backend signals alone as backend", async () => {
        await withTempProject(() => {
            writeFile("package.json", JSON.stringify({ name: "weak-signals" }));
            fs.mkdirSync("services", { recursive: true });
            fs.mkdirSync("config", { recursive: true });

            assert.equal(detectProjectType(), PROJECT_TYPES.GENERIC);
        });
    });

    await t.test("init does not overwrite existing files", async () => {
        await withTempProject(async () => {
            writeFile("AGENTS.md", "custom instructions\n");

            const results = await withMutedConsole(() => runInit());

            assert.equal(
                fs.readFileSync("AGENTS.md", "utf-8"),
                "custom instructions\n",
            );
            assert.ok(results.skipped.includes("AGENTS.md"));
            assert.ok(results.created.includes(".aidw/project.md"));
        });
    });

    await t.test("init without force skips existing context files", async () => {
        await withTempProject(async () => {
            writeFile(".aidw/project.md", "custom project context\n");

            const results = await withMutedConsole(() => runInit());

            assert.equal(
                fs.readFileSync(".aidw/project.md", "utf-8"),
                "custom project context\n",
            );
            assert.ok(results.skipped.includes(".aidw/project.md"));
        });
    });

    await t.test("init creates hidden context directory and prints project context", async () => {
        await withTempProject(async () => {
            const { output, result } = await withCapturedConsole(() => runInit());

            assert.ok(fs.existsSync(".aidw"));
            assert.ok(fs.existsSync(".aidw/project.md"));
            assert.equal(fs.existsSync("ai"), false);
            assert.ok(result.created.includes(".aidw/project.md"));
            assert.equal(
                output.join("\n"),
                "\u2714 Init completed\nCreated: .aidw/\n(ai-dev-workflow project context)\nNext:\n* Run ai-dev-workflow scan",
            );
        });
    });

    await t.test("init force overwrites managed context files", async () => {
        await withTempProject(async () => {
            writeFile(".aidw/project.md", "custom project context\n");
            writeFile(".aidw/meta.json", "{\"custom\":true}\n");
            writeFile(".aidw/scan/last.json", "{\"custom\":true}\n");

            const { output, result } = await withCapturedConsole(() =>
                runInit({ force: true }),
            );

            assert.notEqual(
                fs.readFileSync(".aidw/project.md", "utf-8"),
                "custom project context\n",
            );
            assert.deepEqual(
                JSON.parse(fs.readFileSync(".aidw/meta.json", "utf-8")),
                {
                    schemaVersion: 1,
                    tool: "ai-dev-workflow",
                },
            );
            assert.deepEqual(
                JSON.parse(fs.readFileSync(".aidw/scan/last.json", "utf-8")),
                {
                    status: "not-run",
                },
            );
            assert.ok(result.updated.includes(".aidw/project.md"));
            assert.ok(result.updated.includes(".aidw/meta.json"));
            assert.ok(result.updated.includes(".aidw/scan/last.json"));
            assert.equal(
                output.join("\n"),
                "\u2714 Init completed\nUpdated: .aidw/\n(ai-dev-workflow project context)\n\nNext:\n* Run ai-dev-workflow scan",
            );
        });
    });

    await t.test("init force preserves unknown context files", async () => {
        await withTempProject(async () => {
            writeFile(".aidw/custom-note.md", "keep me\n");

            await withMutedConsole(() => runInit({ force: true }));

            assert.equal(
                fs.readFileSync(".aidw/custom-note.md", "utf-8"),
                "keep me\n",
            );
        });
    });

    await t.test("scan updates generated section and preserves manual content", async () => {
        await withTempProject(async () => {
            writeFile(
                ".aidw/project.md",
                `# Project Context

<!-- AUTO-GENERATED:START -->
old generated content
<!-- AUTO-GENERATED:END -->

## Manual Notes

- keep this note
`,
            );
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));
            writeFile("bin/cli.js", "#!/usr/bin/env node\n");

            const result = await withMutedConsole(() => runScan());
            const updated = fs.readFileSync(".aidw/project.md", "utf-8");

            assert.equal(result.changed, true);
            assert.deepEqual(result.updatedFiles, [".aidw/project.md"]);
            assert.equal(result.project.type, PROJECT_TYPES.CLI_TOOL);
            assert.deepEqual(result.project.entryPoints, ["bin/cli.js"]);
            assert.match(updated, /## AI Development Notes/);
            assert.doesNotMatch(updated, /old generated content/);
            assert.match(updated, /- keep this note/);
        });
    });

    await t.test("scan check reports stale content without writing", async () => {
        await withTempProject(async () => {
            process.exitCode = 0;
            writeFile(
                ".aidw/project.md",
                `# Project Context

<!-- AUTO-GENERATED START -->
old generated content
<!-- AUTO-GENERATED END -->

## Manual Notes

- keep this note
`,
            );
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));
            writeFile("bin/cli.js", "#!/usr/bin/env node\n");

            const before = fs.readFileSync(".aidw/project.md", "utf-8");
            const result = await withMutedConsole(() => runScan({ mode: "check" }));
            const after = fs.readFileSync(".aidw/project.md", "utf-8");

            assert.equal(after, before);
            assert.equal(result.changed, true);
            assert.deepEqual(result.updatedFiles, []);
            assert.equal(process.exitCode, 1);
            process.exitCode = 0;
        });
    });

    await t.test("scan check reports missing markers", async () => {
        await withTempProject(async () => {
            process.exitCode = 0;
            writeFile(".aidw/project.md", "# Project Context\n\nmanual only\n");
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));
            writeFile("bin/cli.js", "#!/usr/bin/env node\n");

            const { output, result } = await withCapturedConsole(() =>
                runScan({ mode: "check" }),
            );

            assert.equal(result.changed, true);
            assert.equal(process.exitCode, 1);
            assert.match(output.join("\n"), /Project context cannot be checked/);
            assert.match(
                output.join("\n"),
                /Reason:\n\* AUTO-GENERATED markers not found in \.aidw\/project\.md/,
            );
            process.exitCode = 0;
        });
    });

    await t.test("scan auto updates changed generated content", async () => {
        await withTempProject(async () => {
            writeFile(
                ".aidw/project.md",
                `# Project Context

<!-- AUTO-GENERATED START -->
old generated content
<!-- AUTO-GENERATED END -->

## Manual Notes

- keep this note
`,
            );
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));
            writeFile("bin/cli.js", "#!/usr/bin/env node\n");

            const update = await withMutedConsole(() => runScan({ mode: "auto" }));
            const updated = fs.readFileSync(".aidw/project.md", "utf-8");

            assert.equal(update.changed, true);
            assert.match(updated, /## AI Development Notes/);
            assert.match(updated, /- keep this note/);
        });
    });

    await t.test("default scan prints structured output", async () => {
        await withTempProject(async () => {
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));
            writeFile("bin/cli.js", "#!/usr/bin/env node\n");

            const { output, result } = await withCapturedConsole(() => runScan());

            assert.equal(result.changed, true);
            assert.deepEqual(result.updatedFiles, [".aidw/project.md"]);
            assert.match(output.join("\n"), /Project scan completed/);
            assert.match(output.join("\n"), /Changes:\n\* Updated \.aidw\/project\.md/);
            assert.match(output.join("\n"), /Summary:\n\* Project type: cli-tool/);
            assert.match(output.join("\n"), /\* Entry points: bin\/cli\.js/);
        });
    });

    await t.test("scan check returns up to date after scan", async () => {
        await withTempProject(async () => {
            process.exitCode = 0;
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));
            writeFile("bin/cli.js", "#!/usr/bin/env node\n");

            await withMutedConsole(() => runScan());
            await withMutedConsole(() => runScan());
            const { output, result } = await withCapturedConsole(() =>
                runScan({ mode: "check" }),
            );

            assert.equal(result.changed, false);
            assert.equal(process.exitCode, 0);
            assert.match(output.join("\n"), /Project context is up to date/);
            assert.match(
                output.join("\n"),
                /Checked:\n\* \.aidw\/project\.md AUTO-GENERATED section/,
            );
        });
    });

    await t.test("scan auto prints no changes when up to date", async () => {
        await withTempProject(async () => {
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));
            writeFile("bin/cli.js", "#!/usr/bin/env node\n");

            await withMutedConsole(() => runScan());
            await withMutedConsole(() => runScan());
            const { output, result } = await withCapturedConsole(() =>
                runScan({ mode: "auto" }),
            );

            assert.equal(result.changed, false);
            assert.deepEqual(result.updatedFiles, []);
            assert.match(output.join("\n"), /Project scan completed/);
            assert.match(output.join("\n"), /Changes:\n\* No changes/);
            assert.match(output.join("\n"), /Mode:\n\* auto/);
        });
    });

    await t.test("default scan prints no changes when up to date", async () => {
        await withTempProject(async () => {
            writeFile("package.json", JSON.stringify({ name: "scan-target" }));
            writeFile("bin/cli.js", "#!/usr/bin/env node\n");

            await withMutedConsole(() => runScan());
            await withMutedConsole(() => runScan());
            const { output, result } = await withCapturedConsole(() => runScan());

            assert.equal(result.changed, false);
            assert.deepEqual(result.updatedFiles, []);
            assert.match(output.join("\n"), /Project scan completed/);
            assert.match(output.join("\n"), /Changes:\n\* No changes/);
        });
    });
});
