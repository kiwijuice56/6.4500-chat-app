import { ref, computed }                from "vue";
import { useRouter }                    from "vue-router";
import { useGraffiti, useGraffitiSession } from "@graffiti-garden/wrapper-vue";
import { threads, membersOfThread, lastPreviewByChannel } from "../store.js";

export default async () => ({
    template: await fetch(new URL("./index.html", import.meta.url)).then((r) => r.text()),
    components: {
        ThreadCardLastPreview: await (await import("../components/ThreadCardLastPreview.js")).default(),
        ThreadListToolbar: await (await import("../components/ThreadListToolbar.js")).default(),
    },
    setup() {
        const graffiti = useGraffiti();
        const session  = useGraffitiSession();
        const router   = useRouter();

        const filterNameInput = ref("");
        const filterTagsInput = ref("");
        const filterSizeLimit = ref("");

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
            membersOfThread,
            leaveThread,
            openChat,
            lastPreviewByChannel,
            threadMetaTitle,
        };
    },
});
