import { ref, computed, watch, nextTick } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useGraffiti, useGraffitiSession, useGraffitiDiscover } from "@graffiti-garden/wrapper-vue";
import { threads, membersOf } from "../store.js";

/** Non-empty placeholder so discover never receives `[]` channels. */
const DISCOVER_IDLE_CHANNEL = "__chat_discover_idle__";

const threadLineSchema = {
    properties: {
        value: {
            required: ["published"],
            properties: {
                published: { type: "number" },
                content: { type: "string" },
                tombstone: { type: "boolean" },
                targetUrl: { type: "string" },
            },
        },
    },
};

export default async () => {
    const MessageBubble = await (await import("../components/MessageBubble.js")).default();

    return {
        props: ["threadUrl"],
        template: await fetch(new URL("./index.html", import.meta.url)).then((r) => r.text()),
        components: { MessageBubble },
        setup() {
            const graffiti = useGraffiti();
            const session = useGraffitiSession();
            const router = useRouter();
            const route = useRoute();

            const threadUrl = computed(() => decodeURIComponent(route.params.threadUrl));
            const activeThread = computed(() => threads.value.find((t) => t.url === threadUrl.value) ?? null);
            const memberActors = computed(() => (activeThread.value ? membersOf(activeThread.value.value.channel) : []));

            const channelGetter = () =>
                activeThread.value?.value.channel ? [activeThread.value.value.channel] : [DISCOVER_IDLE_CHANNEL];

            const { objects: rawObjects, isFirstPoll } = useGraffitiDiscover(
                channelGetter,
                threadLineSchema,
                session,
                true,
            );

            const sortedMessages = computed(() => {
                const raw = rawObjects.value;
                const tombstones = raw.filter((o) => o.value.tombstone === true);
                const messages = raw.filter((o) => typeof o.value.content === "string" && !o.value.tombstone);

                const removedByUrl = new Set(tombstones.map((t) => t.value.targetUrl).filter(Boolean));
                const legacyTombPublished = new Set(
                    tombstones.filter((t) => !t.value.targetUrl).map((t) => t.value.published),
                );

                const visibleMsgs = messages.filter((m) => {
                    if (removedByUrl.has(m.url)) return false;
                    if (legacyTombPublished.has(m.value.published)) return false;
                    return true;
                });

                return [...visibleMsgs, ...tombstones].toSorted((a, b) => {
                    const d = a.value.published - b.value.published;
                    return d !== 0 ? d : a.url.localeCompare(b.url);
                });
            });

            const messagesLoading = computed(() => isFirstPoll.value);

            /** Stable only when visible timeline changes (avoids autopoll deep churn on rawObjects). */
            const timelineSig = computed(() => sortedMessages.value.map((o) => o.url).join("\u0001"));

            const myMessage = ref("");
            const isSending = ref(false);
            const scrollBoxEl = ref(null);
            const scrollEndEl = ref(null);

            function scrollChatToBottom() {
                nextTick(() => {
                    requestAnimationFrame(() => {
                        const box = scrollBoxEl.value;
                        const end = scrollEndEl.value;
                        if (end) {
                            end.scrollIntoView({ block: "end", behavior: "auto" });
                        } else if (box) {
                            box.scrollTop = box.scrollHeight;
                        }
                    });
                });
            }

            watch(timelineSig, () => scrollChatToBottom(), { flush: "post" });

            async function sendMessage() {
                if (!myMessage.value.trim() || !activeThread.value) return;
                isSending.value = true;
                await graffiti.post(
                    {
                        value: {
                            content: myMessage.value.trim(),
                            published: Date.now(),
                        },
                        channels: [activeThread.value.value.channel],
                        allowed: memberActors.value,
                    },
                    session.value,
                );
                myMessage.value = "";
                isSending.value = false;
                scrollChatToBottom();
            }

            async function leaveThread() {
                if (!activeThread.value) return;
                const threadChannel = activeThread.value.value.channel;
                const me = session.value.actor;
                await graffiti.post(
                    {
                        value: {
                            activity: "Leave",
                            actor: me,
                            target: threadChannel,
                            published: Date.now(),
                        },
                        channels: [threadChannel],
                        allowed: membersOf(threadChannel),
                    },
                    session.value,
                );
                router.push("/chats");
            }

            return {
                session,
                activeThread,
                memberActors,
                sortedMessages,
                messagesLoading,
                myMessage,
                isSending,
                sendMessage,
                leaveThread,
                scrollBoxEl,
                scrollEndEl,
            };
        },
    };
};
