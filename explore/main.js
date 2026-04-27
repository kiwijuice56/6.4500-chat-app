import { ref }                          from "vue";
import { useRouter }                    from "vue-router";
import { useGraffiti, useGraffitiSession } from "@graffiti-garden/wrapper-vue";
import { CLASS_CHANNEL, threads, membersOfThread } from "../store.js";

export default async () => ({
    template: await fetch(new URL("./index.html", import.meta.url)).then((r) => r.text()),
    setup() {
        const graffiti = useGraffiti();
        const session  = useGraffitiSession();
        const router   = useRouter();

        const newTitle     = ref("");
        const newTagsInput = ref("");
        const newSizeLimit = ref(5);

        async function createThread() {
            const tags = newTagsInput.value.split(",").map((t) => t.trim()).filter(Boolean);
            const me   = session.value.actor;
            const now  = Date.now();
            const channel = crypto.randomUUID();
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
            newSizeLimit.value = 5;
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

        return { session, threads, membersOfThread, newTitle, newTagsInput, newSizeLimit, createThread, joinThread, openChat };
    },
});
