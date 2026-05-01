import { ref, computed, watchEffect } from "vue";
import {
    useGraffitiSession,
    useGraffitiDiscover,
    useGraffitiActorToHandle,
} from "@graffiti-garden/wrapper-vue";
import { visibleChatMessagesFromRaw } from "./visibleChatMessages.js";

/** Non-empty channel list when there are no threads yet. */
const DISCOVER_THREAD_LINES_IDLE = "__store_thread_lines_idle__";

/** Tombstone rows on the class channel that hide a thread Create by `targetUrl`. */
const threadDeleteStatusSchema = {
    properties: {
        value: {
            required: ["tombstone", "targetUrl", "published"],
            properties: {
                tombstone: { type: "boolean" },
                targetUrl: { type: "string" },
                deleted: { type: "boolean" },
                statusAt: { type: "number" },
                published: { type: "number" },
            },
        },
    },
};

const threadLineSchema = {
    properties: {
        value: {
            required: ["published"],
            properties: {
                published:   { type: "number" },
                content:     { type: "string" },
                tombstone:     { type: "boolean" },
                targetUrl:     { type: "string" },
                deleted:       { type: "boolean" },
                statusAt:      { type: "number" },
                clientNonce:   { type: "string" },
            },
        },
    },
};

export const CLASS_CHANNEL = "new-design-ftw-26";

// Module-level singletons shared across all route components
export const threads             = ref([]);
export const allMembershipEvents = ref([]);
export const threadsLoading      = ref(true);
export const threadLineObjects   = ref([]);

export const membersByChannel = computed(() => {
    const latest = {};
    for (const obj of allMembershipEvents.value) {
        const { actor, activity, published, target } = obj.value;
        if (!latest[target]) latest[target] = {};
        const pub = published ?? 0;
        const prevPub = latest[target][actor]?.published ?? 0;
        if (!latest[target][actor] || pub > prevPub) {
            latest[target][actor] = { activity, published: pub };
        }
    }
    const result = {};
    for (const [channel, actors] of Object.entries(latest)) {
        result[channel] = Object.entries(actors)
            .filter(([, ev]) => ev.activity === "Join")
            .map(([actor]) => actor);
    }
    return result;
});

export function membersOf(threadChannel) {
    return membersByChannel.value[threadChannel] ?? [];
}

/** All participants: Join/Leave membership plus the thread's creator (Create author never had a Join in older data). */
export function membersOfThread(thread) {
    if (!thread?.value?.channel) return [];
    const ch = thread.value.channel;
    const fromEvents = membersByChannel.value[ch] ?? [];
    const creator = thread.actor;
    return [...new Set([creator, ...fromEvents].filter(Boolean))];
}

/** Latest visible message per thread channel (for list previews). */
export const lastPreviewByChannel = computed(() => {
    const raw = threadLineObjects.value;
    const visible = visibleChatMessagesFromRaw(raw);
    const chans = new Set(threads.value.map((t) => t.value.channel));
    const best = {};
    for (const m of visible) {
        const ch = m.channels?.find((c) => chans.has(c));
        if (!ch) continue;
        const pub = m.value.published ?? 0;
        const cur = best[ch];
        if (!cur || pub > cur.pub || (pub === cur.pub && m.url > cur.url)) {
            best[ch] = { pub, url: m.url, actor: m.actor, content: m.value.content };
        }
    }
    const out = {};
    for (const [ch, v] of Object.entries(best)) {
        out[ch] = { actor: v.actor, content: v.content };
    }
    return out;
});

// Called once from the root component setup to start the shared discovers
export function useSharedStore() {
    const session = useGraffitiSession();

    const sessionActorId = computed(() => session.value?.actor ?? "");
    const { handle: sessionActorHandle } = useGraffitiActorToHandle(sessionActorId);
    const sessionActorDisplay = computed(() => {
        const id = sessionActorId.value;
        if (!id) return "";
        const h = sessionActorHandle.value;
        if (h === undefined) return "…";
        if (h === null) return id;
        return String(h);
    });

    const { objects: threadObjects, isFirstPoll: threadsIsFirstPoll } = useGraffitiDiscover(
        () => [CLASS_CHANNEL],
        {
            properties: {
                value: {
                    required: ["activity", "type", "title", "tags", "sizeLimit", "channel"],
                    properties: {
                        activity:  { type: "string", enum: ["Create"] },
                        type:      { type: "string", enum: ["Thread"] },
                        title:     { type: "string" },
                        tags:      { type: "array", items: { type: "string" } },
                        sizeLimit: { type: "number" },
                        channel:   { type: "string" },
                        published: { type: "number" },
                    },
                },
            },
        },
    );

    const { objects: threadDeleteStatusObjects, isFirstPoll: threadDeletesIsFirstPoll } = useGraffitiDiscover(
        () => [CLASS_CHANNEL],
        threadDeleteStatusSchema,
        session,
        true,
    );

    const { objects: membershipObjects, isFirstPoll: membershipIsFirstPoll } = useGraffitiDiscover(
        () => threadObjects.value.map((t) => t.value.channel),
        {
            properties: {
                value: {
                    required: ["activity", "actor", "target"],
                    properties: {
                        activity:  { type: "string", enum: ["Join", "Leave"] },
                        actor:     { type: "string" },
                        target:    { type: "string" },
                        published: { type: "number" },
                    },
                },
            },
        },
        session,
        true,
    );

    const threadLineChannelGetter = () => {
        const chans = threadObjects.value.map((t) => t.value.channel);
        return chans.length ? chans : [DISCOVER_THREAD_LINES_IDLE];
    };

    const { objects: threadLineDiscoverObjects } = useGraffitiDiscover(
        threadLineChannelGetter,
        threadLineSchema,
        session,
        true,
    );

    // Keep the module-level refs in sync (threads omit soft-deleted thread Creates)
    watchEffect(() => {
        const raw = threadDeleteStatusObjects.value;
        const latestByTarget = new Map();
        for (const o of raw) {
            const v = o.value;
            if (!v?.tombstone || !v.targetUrl) continue;
            const target = v.targetUrl;
            const prev = latestByTarget.get(target);
            const curStamp = v.statusAt ?? v.published ?? 0;
            const prevStamp = prev ? (prev.value.statusAt ?? prev.value.published ?? 0) : -1;
            if (!prev || curStamp > prevStamp || (curStamp === prevStamp && o.url > prev.url)) {
                latestByTarget.set(target, o);
            }
        }
        const removedUrls = new Set();
        for (const evt of latestByTarget.values()) {
            if (evt.value.deleted !== false) removedUrls.add(evt.value.targetUrl);
        }
        threads.value = threadObjects.value.filter((t) => !removedUrls.has(t.url));
    });
    watchEffect(() => { allMembershipEvents.value = membershipObjects.value; });
    /** Hide thread lists until creates, delete-tombstones, and (if any) membership first polls have settled. */
    watchEffect(() => {
        const needMembership = threadObjects.value.length > 0;
        const membershipReady = !needMembership || !membershipIsFirstPoll.value;
        threadsLoading.value =
            threadsIsFirstPoll.value ||
            threadDeletesIsFirstPoll.value ||
            !membershipReady;
    });
    watchEffect(() => { threadLineObjects.value   = threadLineDiscoverObjects.value; });

    return { session, sessionActorId, sessionActorDisplay };
}
