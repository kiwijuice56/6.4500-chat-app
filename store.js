import { ref, computed, watchEffect }        from "vue";
import { useGraffitiSession, useGraffitiDiscover } from "@graffiti-garden/wrapper-vue";

export const CLASS_CHANNEL = "designftw-26";

// Module-level singletons shared across all route components
export const threads             = ref([]);
export const allMembershipEvents = ref([]);

export const membersByChannel = computed(() => {
    const latest = {};
    for (const obj of allMembershipEvents.value) {
        const { actor, activity, published, target } = obj.value;
        if (!latest[target]) latest[target] = {};
        if (!latest[target][actor] || published > latest[target][actor].published) {
            latest[target][actor] = { activity, published };
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

// Called once from the root component setup to start the shared discovers
export function useSharedStore() {
    const session = useGraffitiSession();

    const { objects: threadObjects } = useGraffitiDiscover(
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
                        activity: { type: "string", enum: ["Join", "Leave"] },
                        actor:    { type: "string" },
                        target:   { type: "string" },
                    },
                },
            },
        },
        session,
    );

    // Keep the module-level refs in sync
    watchEffect(() => { threads.value             = threadObjects.value; });
    watchEffect(() => { allMembershipEvents.value = membershipObjects.value; });

    return { session };
}
