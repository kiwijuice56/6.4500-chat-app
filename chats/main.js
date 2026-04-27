import { computed }                     from "vue";
import { useRouter }                    from "vue-router";
import { useGraffiti, useGraffitiSession } from "@graffiti-garden/wrapper-vue";
import { threads, membersOfThread, lastPreviewByChannel } from "../store.js";

export default async () => ({
    template: await fetch(new URL("./index.html", import.meta.url)).then((r) => r.text()),
    components: {
        ThreadCardLastPreview: await (await import("../components/ThreadCardLastPreview.js")).default(),
    },
    setup() {
        const graffiti = useGraffiti();
        const session  = useGraffitiSession();
        const router   = useRouter();

        const myThreads = computed(() => {
            const me = session.value?.actor;
            if (!me) return [];
            return threads.value.filter((t) => membersOfThread(t).includes(me));
        });

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
            membersOfThread,
            leaveThread,
            openChat,
            lastPreviewByChannel,
            threadMetaTitle,
        };
    },
});
