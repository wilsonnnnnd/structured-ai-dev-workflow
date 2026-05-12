import { stablePathCompare, stableStringCompare } from "./stable-sort.js";

function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function toPositiveInteger(value, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) {
        return fallback;
    }
    return Math.floor(number);
}

function truncateStringByBytes(text, maxBytes) {
    const value = String(text ?? "");
    const limit = Math.max(0, toPositiveInteger(maxBytes, 0));
    if (limit === 0 || Buffer.byteLength(value, "utf8") <= limit) {
        return value;
    }

    let end = value.length;
    while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > limit) {
        end -= 1;
    }

    return value.slice(0, Math.max(0, end)).trimEnd();
}

export const CONTEXT_BUDGET = Object.freeze({
    maxWorksetFiles: 12,
    maxSummaries: 3,
    maxSymbols: 30,
    maxChecklistItems: 16,
    maxTaskNotes: 8,
    maxRisks: 10,
    maxLoopEvents: 20,
    maxStringLength: 240,
    maxPayloadBytes: 16_384,
    maxApproxTokenUnits: 4_200,
    maxContextSections: 8,
    maxArraysPerResponse: 12,
    maxObjectKeysPerSection: 24,
    maxNestedDepth: 6,
    context: Object.freeze({
        brief: Object.freeze({ maxChars: 8000 }),
        "next-task": Object.freeze({ maxChars: 12000, maxDependencySummaries: 3 }),
        workset: Object.freeze({
            maxChars: 16000,
            maxRelatedFiles: 12,
            maxRelatedSymbols: 30,
            maxDependencySummaries: 3,
            maxFileSummaryFiles: 6,
            maxFileSummaryChars: 2400,
        }),
        "workset-deep": Object.freeze({
            maxChars: 24000,
            maxRelatedFiles: 24,
            maxRelatedSymbols: 60,
            maxDependencySummaries: 3,
            maxFileSummaryFiles: 10,
            maxFileSummaryChars: 3600,
        }),
        "workset-digest": Object.freeze({
            maxChars: 7000,
            maxRelatedFiles: 6,
            maxRelatedSymbols: 8,
            maxDependencySummaries: 3,
            maxFileSummaryFiles: 4,
            maxFileSummaryChars: 1200,
        }),
    }),
    task: Object.freeze({
        prompt: Object.freeze({ default: 20000, deep: 28000 }),
        checklist: Object.freeze({ default: 14000, deep: 20000 }),
        pr: Object.freeze({ default: 14000, deep: 20000 }),
    }),
});

function normalizeArray(value, maxItems) {
    return Array.isArray(value) ? value.slice(0, maxItems) : [];
}

function parsePathParts(path) {
    if (!path) return [];
    return String(path)
        .split("/")
        .map((part) => part.trim())
        .filter(Boolean);
}

function isIntegerLike(part) {
    return /^\d+$/.test(String(part));
}

function getByPath(root, pathParts) {
    let current = root;
    for (const part of pathParts) {
        if (current == null) return undefined;
        if (Array.isArray(current)) {
            if (!isIntegerLike(part)) return undefined;
            const index = Number(part);
            current = current[index];
            continue;
        }
        if (!isPlainObject(current)) return undefined;
        current = current[part];
    }
    return current;
}

function setByPath(root, pathParts, nextValue) {
    if (!pathParts.length) {
        return false;
    }
    let current = root;
    for (let i = 0; i < pathParts.length - 1; i += 1) {
        const part = pathParts[i];
        if (Array.isArray(current)) {
            if (!isIntegerLike(part)) return false;
            const index = Number(part);
            current = current[index];
            continue;
        }
        if (!isPlainObject(current)) {
            return false;
        }
        current = current[part];
    }

    const leaf = pathParts[pathParts.length - 1];
    if (Array.isArray(current)) {
        if (!isIntegerLike(leaf)) return false;
        current[Number(leaf)] = nextValue;
        return true;
    }
    if (!isPlainObject(current)) return false;
    current[leaf] = nextValue;
    return true;
}

function makeSchemaPlaceholder(value) {
    if (Array.isArray(value)) return [];
    if (isPlainObject(value)) return null;
    if (typeof value === "string") return "";
    if (typeof value === "number") return 0;
    if (typeof value === "boolean") return false;
    return null;
}

function buildMinimalShape(value, depth = 0) {
    if (depth > 24) {
        return null;
    }
    if (value == null) return null;
    if (typeof value === "string") return "";
    if (typeof value === "number") return 0;
    if (typeof value === "boolean") return false;
    if (Array.isArray(value)) return [];
    if (isPlainObject(value)) {
        const out = {};
        for (const key of Object.keys(value).sort(stableStringCompare)) {
            out[key] = buildMinimalShape(value[key], depth + 1);
        }
        return out;
    }
    return null;
}

function preserveEnvelopeFields(minimal, original) {
    if (!isPlainObject(minimal) || !isPlainObject(original)) {
        return minimal;
    }

    for (const key of ["schemaVersion", "interface", "kind"]) {
        if (typeof original[key] === "string" && original[key].trim()) {
            minimal[key] = truncateStringByBytes(original[key], 120);
        }
    }

    return minimal;
}

export function estimateTokenUnits(value) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const normalized = String(text ?? "");
    const bytes = Buffer.byteLength(normalized, "utf8");
    const punctuation = normalized.match(/[{}\[\]:,]/g)?.length ?? 0;
    const words = normalized.match(/[A-Za-z0-9_]+/g)?.length ?? 0;
    const base = Math.ceil(bytes / 3.2);
    const overhead = Math.ceil(punctuation * 0.18) + Math.ceil(words * 0.06);
    return base + overhead;
}

function budgetValue(value, options, pathParts = [], depth = 0) {
    const maxStringLength = toPositiveInteger(options.maxStringLength, CONTEXT_BUDGET.maxStringLength);
    const maxArrayItems = toPositiveInteger(options.maxArrayItems, CONTEXT_BUDGET.maxArraysPerResponse);
    const maxNestedDepth = toPositiveInteger(options.maxNestedDepth, CONTEXT_BUDGET.maxNestedDepth);

    if (value === undefined) {
        throw new Error(`budget: undefined at ${pathParts.join(".") || "(root)"}`);
    }
    if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
        throw new Error(`budget: unsupported type ${typeof value} at ${pathParts.join(".") || "(root)"}`);
    }
    if (value == null) {
        return null;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new Error(`budget: non-finite number at ${pathParts.join(".") || "(root)"}`);
        }
        return value;
    }
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "string") {
        return truncateStringByBytes(value, maxStringLength);
    }
    if (depth >= maxNestedDepth) {
        return Array.isArray(value) ? [] : null;
    }
    if (Array.isArray(value)) {
        return value.slice(0, maxArrayItems).map((item, index) => budgetValue(item, options, [...pathParts, String(index)], depth + 1));
    }
    if (isPlainObject(value)) {
        const keys = Object.keys(value).sort(stableStringCompare);
        const out = {};
        for (const key of keys) {
            const next = value[key];
            if (next === undefined) continue;
            out[key] = budgetValue(next, options, [...pathParts, key], depth + 1);
        }
        return out;
    }
    throw new Error(`budget: unsupported object type at ${pathParts.join(".") || "(root)"}`);
}

function collectBudgetNodes(value, pathParts = [], nodes = [], parent = null, key = null) {
    if (value == null || typeof value === "number" || typeof value === "boolean") {
        return nodes;
    }
    if (typeof value === "string") {
        nodes.push({ type: "string", parent, key, path: pathParts.join("/"), size: Buffer.byteLength(value, "utf8") });
        return nodes;
    }
    if (Array.isArray(value)) {
        nodes.push({ type: "array", parent, key, path: pathParts.join("/"), size: value.length });
        value.forEach((item, index) => collectBudgetNodes(item, [...pathParts, String(index)], nodes, value, index));
        return nodes;
    }
    if (isPlainObject(value)) {
        for (const objectKey of Object.keys(value).sort(stableStringCompare)) {
            collectBudgetNodes(value[objectKey], [...pathParts, objectKey], nodes, value, objectKey);
        }
        return nodes;
    }
    return nodes;
}

function reduceBudgetNode(node) {
    if (!node || !node.parent) {
        return false;
    }
    if (node.type === "array") {
        const current = node.parent[node.key];
        if (!Array.isArray(current) || current.length <= 0) {
            return false;
        }
        current.pop();
        return true;
    }
    if (node.type === "string") {
        const current = String(node.parent[node.key] ?? "");
        if (current.length <= 16) {
            return false;
        }
        const next = truncateStringByBytes(current, Math.max(16, Math.floor(Buffer.byteLength(current, "utf8") * 0.8)));
        if (next === current) {
            return false;
        }
        node.parent[node.key] = next;
        return true;
    }
    return false;
}

export function limitArray(values, maxItems = CONTEXT_BUDGET.maxArraysPerResponse) {
    return normalizeArray(values, toPositiveInteger(maxItems, CONTEXT_BUDGET.maxArraysPerResponse));
}

export function limitString(value, maxBytes = CONTEXT_BUDGET.maxStringLength) {
    return truncateStringByBytes(value, maxBytes);
}

export function applyRuntimeBudget(payload, options = {}) {
    const merged = {
        maxPayloadBytes: CONTEXT_BUDGET.maxPayloadBytes,
        maxApproxTokenUnits: CONTEXT_BUDGET.maxApproxTokenUnits,
        maxStringLength: CONTEXT_BUDGET.maxStringLength,
        maxArrayItems: CONTEXT_BUDGET.maxArraysPerResponse,
        maxObjectKeysPerSection: CONTEXT_BUDGET.maxObjectKeysPerSection,
        maxNestedDepth: CONTEXT_BUDGET.maxNestedDepth,
        ...options,
    };
    return budgetJsonPayload(payload, merged);
}

export function budgetJsonPayload(payload, options = {}) {
    const normalized = budgetValue(payload, options);
    const maxPayloadBytes = toPositiveInteger(options.maxPayloadBytes, CONTEXT_BUDGET.maxPayloadBytes);
    const maxApproxTokenUnits = toPositiveInteger(options.maxApproxTokenUnits, CONTEXT_BUDGET.maxApproxTokenUnits);
    const optionalPaths = Array.isArray(options.optionalPaths)
        ? options.optionalPaths.map(parsePathParts).filter((parts) => parts.length > 0)
        : [];
    let text = JSON.stringify(normalized);
    let tokenUnits = estimateTokenUnits(text);
    if (Buffer.byteLength(text, "utf8") <= maxPayloadBytes && tokenUnits <= maxApproxTokenUnits) {
        return normalized;
    }

    const budgeted = normalized;

    if (optionalPaths.length > 0) {
        const sortedOptionalPaths = [...new Set(optionalPaths.map((parts) => parts.join("/")))]
            .map(parsePathParts)
            .sort((a, b) => stablePathCompare(a.join("/"), b.join("/")));

        for (const pathParts of sortedOptionalPaths) {
            const current = getByPath(budgeted, pathParts);
            if (current === undefined) continue;
            const next = makeSchemaPlaceholder(current);
            if (!setByPath(budgeted, pathParts, next)) continue;
            text = JSON.stringify(budgeted);
            tokenUnits = estimateTokenUnits(text);
            if (Buffer.byteLength(text, "utf8") <= maxPayloadBytes && tokenUnits <= maxApproxTokenUnits) {
                return budgeted;
            }
        }
    }

    for (let iteration = 0; iteration < 256; iteration += 1) {
        const nodes = collectBudgetNodes(budgeted);
        nodes.sort((a, b) => b.size - a.size || (a.type === b.type ? stablePathCompare(a.path, b.path) : a.type === "array" ? -1 : 1));
        let changed = false;
        for (const node of nodes) {
            if (reduceBudgetNode(node)) {
                changed = true;
                break;
            }
        }
        if (!changed) {
            break;
        }
        text = JSON.stringify(budgeted);
        tokenUnits = estimateTokenUnits(text);
        if (Buffer.byteLength(text, "utf8") <= maxPayloadBytes && tokenUnits <= maxApproxTokenUnits) {
            return budgeted;
        }
    }

    const minimal = preserveEnvelopeFields(buildMinimalShape(normalized), normalized);
    if (isPlainObject(minimal)) {
        minimal._truncation = {
            reduced: true,
            reason: "budget_limit",
        };
    }
    return minimal;
}
