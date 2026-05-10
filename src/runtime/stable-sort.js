function normalizeText(value) {
    return String(value ?? "").replaceAll("\\", "/");
}

function foldCase(value) {
    return normalizeText(value).toLowerCase();
}

export function stableStringCompare(a, b) {
    const Af = foldCase(a);
    const Bf = foldCase(b);
    if (Af < Bf) return -1;
    if (Af > Bf) return 1;
    const A = normalizeText(a);
    const B = normalizeText(b);
    if (A < B) return -1;
    if (A > B) return 1;
    return 0;
}

export function stablePathCompare(a, b) {
    const Af = foldCase(a);
    const Bf = foldCase(b);
    if (Af < Bf) return -1;
    if (Af > Bf) return 1;
    const A = normalizeText(a);
    const B = normalizeText(b);
    if (A < B) return -1;
    if (A > B) return 1;
    return 0;
}
