import { ref, computed, watchEffect }        from "vue";
import {
    useGraffitiSession,
    useGraffitiDiscover,
    useGraffitiActorToHandle,
} from "@graffiti-garden/wrapper-vue";

export const CLASS_CHANNEL = "designftw-26";

// Module-level singletons shared across all route components
export const threads             = ref([]);
export const allMembershipEvents = ref([]);
export const threadsLoading      = ref(true);

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

    const { objects: membershipObjects } = useGraffitiDiscover(
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
    );

    // Keep the module-level refs in sync
    watchEffect(() => { threads.value             = threadObjects.value; });
    watchEffect(() => { allMembershipEvents.value = membershipObjects.value; });
    watchEffect(() => { threadsLoading.value      = threadsIsFirstPoll.value; });

    return { session, sessionActorId, sessionActorDisplay };
}
