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
        ThreadListToolbar: await (await import("../components/ThreadListToolbar.js")).default(),
    },
    setup() {
        const graffiti = useGraffiti();
        const session  = useGraffitiSession();
        const router   = useRouter();

        const newTitle     = ref("");
        const newTagsInput = ref("");
        const newSizeLimit = ref(5);
        const filterNameInput = ref("");
        const filterTagsInput = ref("");
        const filterSizeLimit = ref("");
        const isCreating   = ref(false);
        const isCreateModalOpen = ref(false);

        const myThreads = computed(() => {
            const me = session.value?.actor;
            if (!me) return [];
            return threads.value.filter((t) => membersOfThread(t).includes(me));
        });

        const myThreadsNewestFirst = computed(() =>
            [...myThreads.value].toSorted((a, b) => (b.value.published ?? 0) - (a.value.published ?? 0)),
        );

        const filteredMyThreads = computed(() => {
            const parsedTags = filterTagsInput.value
                .split(",")
                .map((t) => t.trim().toLowerCase())
                .filter(Boolean);
            const selectedSize = Number(filterSizeLimit.value);
            const nameQ = filterNameInput.value.trim().toLowerCase();

            return myThreadsNewestFirst.value.filter((obj) => {
                if (nameQ && !String(obj.value.title ?? "").toLowerCase().includes(nameQ)) return false;
                const sizeOk = !filterSizeLimit.value || obj.value.sizeLimit === selectedSize;
                if (!sizeOk) return false;
                if (parsedTags.length === 0) return true;
                const threadTags = (obj.value.tags ?? []).map((t) => String(t).toLowerCase());
                return parsedTags.some((tag) => threadTags.includes(tag));
            });
        });

        const hasFiltersApplied = computed(() =>
            filterNameInput.value.trim().length > 0 ||
                filterTagsInput.value.trim().length > 0 ||
                String(filterSizeLimit.value).length > 0,
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

        async function leaveThread(threadObj) {
            const threadChannel = threadObj.value.channel;
            const me = session.value.actor;
            await graffiti.post(
                {
                    value: {
                        activity:  "Leave",
                        actor:     me,
                        target:    threadChannel,
                        published: Date.now(),
                    },
                    channels: [threadChannel],
                    allowed:  membersOfThread(threadObj),
                },
                session.value,
            );
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
            myThreads,
            filteredMyThreads,
            filterNameInput,
            filterTagsInput,
            filterSizeLimit,
            hasFiltersApplied,
            threadsLoading,
            membersOfThread,
            leaveThread,
            openChat,
            lastPreviewByChannel,
            threadMetaTitle,
            newTitle,
            newTagsInput,
            newSizeLimit,
            isCreating,
            isCreateModalOpen,
            submitCreateFromModal,
        };
    },
});
