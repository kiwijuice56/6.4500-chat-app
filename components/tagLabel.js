/** Visible label: at most `max` chars from `s`, then an ellipsis (U+2026). */
export function truncateTagLabel(s, max = 9) {
    const t = String(s ?? "");
    if (t.length <= max) return t;
    return `${t.slice(0, max)}\u2026`;
}
