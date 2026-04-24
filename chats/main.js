import { computed }                     from "vue";
import { useRouter }                    from "vue-router";
import { useGraffiti, useGraffitiSession } from "@graffiti-garden/wrapper-vue";
import { threads, membersOf }           from "../store.js";

export default async () => ({
    template: await fetch(new URL("./index.html", import.meta.url)).then((r) => r.text()),
    setup() {
        const graffiti = useGraffiti();
        const session  = useGraffitiSession();
        const router   = useRouter();

        const myThreads = computed(() => {
            const me = session.value?.actor;
            if (!me) return [];
            return threads.value.filter((t) => membersOf(t.value.channel).includes(me));
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
                    allowed:  membersOf(threadChannel),
                },
                session.value,
            );
        }

        function openChat(threadObj) {
            router.push(`/chat/${encodeURIComponent(threadObj.url)}`);
        }

        return { session, myThreads, membersOf, leaveThread, openChat };
    },
});
