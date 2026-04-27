/**
 * Plain chat messages that are still visible (not soft-deleted), from raw discover objects.
 * Mirrors chat/main.js visibility rules without optimistic or tombstone timeline rows.
 */
export function visibleChatMessagesFromRaw(raw) {
    const statusEvents = raw.filter((o) => o.value.tombstone === true);
    const messages = raw.filter((o) => typeof o.value.content === "string" && !o.value.tombstone);
    const latestByTarget = new Map();
    const legacyDeletedPublished = new Set();

    for (const evt of statusEvents) {
        const target = evt.value.targetUrl;
        if (!target) {
            if (evt.value.deleted !== false) legacyDeletedPublished.add(evt.value.published);
            continue;
        }
        const prev = latestByTarget.get(target);
        const curStamp = evt.value.statusAt ?? evt.value.published ?? 0;
        const prevStamp = prev ? (prev.value.statusAt ?? prev.value.published ?? 0) : -1;
        if (!prev || curStamp > prevStamp || (curStamp === prevStamp && evt.url > prev.url)) {
            latestByTarget.set(target, evt);
        }
    }
    const removedByUrl = new Set();
    for (const [, evt] of latestByTarget.entries()) {
        if (evt.value.deleted !== false) removedByUrl.add(evt.value.targetUrl);
    }

    return messages.filter((m) => {
        if (removedByUrl.has(m.url)) return false;
        if (legacyDeletedPublished.has(m.value.published)) return false;
        return true;
    });
}
