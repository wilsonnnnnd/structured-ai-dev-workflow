#!/usr/bin/env node
import { buildRuntimeMetrics, formatCompactJson } from "../src/runtime/context-observability.js";

export async function runMetrics(args = []) {
    const help = args.includes("--help") || args.includes("help");
    if (help) {
        console.log("Usage:");
        console.log("  rck metrics");
        return {
            output: null,
        };
    }

    const payload = buildRuntimeMetrics();
    const output = formatCompactJson(payload);
    console.log(output);
    return {
        output,
    };
}
