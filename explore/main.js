import { ref, computed }                from "vue";
import { useRouter }                    from "vue-router";
import { useGraffiti, useGraffitiSession } from "@graffiti-garden/wrapper-vue";
import {
    CLASS_CHANNEL,
    threads,
    threadsLoading,
    membersOfThread,
    lastPreviewByChannel,
} from "../store.js";

export default async () => ({
    template: await fetch(new URL("./index.html", import.meta.url)).then((r) => r.text()),
    components: {
        ModalWindow: await (await import("../components/ModalWindow.js")).default(),
        ThreadCardLastPreview: await (await import("../components/ThreadCardLastPreview.js")).default(),
    },
    setup() {
        const graffiti = useGraffiti();
        const session  = useGraffitiSession();
        const router   = useRouter();

        const newTitle     = ref("");
        const newTagsInput = ref("");
        const newSizeLimit = ref(5);
        const filterTagsInput = ref("");
        const filterSizeLimit = ref("");
        const isCreating   = ref(false);
        const isCreateModalOpen = ref(false);

        const threadsNewestFirst = computed(() =>
            [...threads.value].toSorted((a, b) => (b.value.published ?? 0) - (a.value.published ?? 0)),
        );
        const filteredThreads = computed(() => {
            const parsedTags = filterTagsInput.value
                .split(",")
                .map((t) => t.trim().toLowerCase())
                .filter(Boolean);
            const selectedSize = Number(filterSizeLimit.value);

            return threadsNewestFirst.value.filter((obj) => {
                const sizeOk = !filterSizeLimit.value || obj.value.sizeLimit === selectedSize;
                if (!sizeOk) return false;
                if (parsedTags.length === 0) return true;
                const threadTags = (obj.value.tags ?? []).map((t) => String(t).toLowerCase());
                return parsedTags.some((tag) => threadTags.includes(tag));
            });
        });
        const hasFiltersApplied = computed(() =>
            filterTagsInput.value.trim().length > 0 || String(filterSizeLimit.value).length > 0,
        );

        async function createThread() {
            if (isCreating.value) return false;
            isCreating.value = true;
            const tags = newTagsInput.value.split(",").map((t) => t.trim()).filter(Boolean);
            const me   = session.value.actor;
            const now  = Date.now();
            const channel = crypto.randomUUID();
            try {
                await graffiti.post(
                    {
                        value: {
                            activity:  "Create",
                            type:      "Thread",
                            title:     newTitle.value.trim(),
                            tags,
                            sizeLimit: newSizeLimit.value,
                            channel,
                            published: now,
                        },
                        channels: [CLASS_CHANNEL],
                    },
                    session.value,
                );
                // Creator is not represented by a Join in the old model; post Join + allowed
                // so member counts, ACLs, and message recipients include the host.
                await graffiti.post(
                    {
                        value: {
                            activity:  "Join",
                            actor:     me,
                            target:    channel,
                            published: now,
                        },
                        channels: [channel],
                        allowed:  [me],
                    },
                    session.value,
                );
                newTitle.value     = "";
                newTagsInput.value = "";
                return true;
            } finally {
                isCreating.value = false;
            }
        }

        async function submitCreateFromModal() {
            if (!newTitle.value.trim()) return;
            const ok = await createThread();
            if (ok) isCreateModalOpen.value = false;
        }

        async function joinThread(threadObj) {
            const threadChannel = threadObj.value.channel;
            const me = session.value.actor;
            const newAllowed = [...new Set([...membersOfThread(threadObj), me])];
            await graffiti.post(
                {
                    value: {
                        activity:  "Join",
                        actor:     me,
                        target:    threadChannel,
                        published: Date.now(),
                    },
                    channels: [threadChannel],
                    allowed:  newAllowed,
                },
                session.value,
            );
            router.push(`/chat/${encodeURIComponent(threadObj.url)}`);
        }

        function openChat(threadObj) {
            router.push(`/chat/${encodeURIComponent(threadObj.url)}`);
        }

        function threadMetaTitle(obj) {
            const tags = obj.value.tags.length ? obj.value.tags.join(", ") : "No tags";
            return `${membersOfThread(obj).length} / ${obj.value.sizeLimit} joined · ${tags}`;
        }

        return {
            session,
            threadsNewestFirst,
            membersOfThread,
            newTitle,
            newTagsInput,
            newSizeLimit,
            filterTagsInput,
            filterSizeLimit,
            isCreating,
            isCreateModalOpen,
            filteredThreads,
            threadsLoading,
            hasFiltersApplied,
            submitCreateFromModal,
            joinThread,
            openChat,
            lastPreviewByChannel,
            threadMetaTitle,
        };
    },
});
