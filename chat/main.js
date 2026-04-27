import { ref, computed, watch, nextTick } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useGraffiti, useGraffitiSession, useGraffitiDiscover } from "@graffiti-garden/wrapper-vue";
import { threads, membersOfThread } from "../store.js";

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
                deleted: { type: "boolean" },
                statusAt: { type: "number" },
                clientNonce: { type: "string" },
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
            const memberActors = computed(() => (activeThread.value ? membersOfThread(activeThread.value) : []));

            const chatMetaTitle = computed(() => {
                const t = activeThread.value?.value;
                if (!t) return "";
                const tags = t.tags?.length ? t.tags.join(", ") : "No tags";
                return `${memberActors.value.length} / ${t.sizeLimit} joined · ${tags}`;
            });

            const channelGetter = () =>
                activeThread.value?.value.channel ? [activeThread.value.value.channel] : [DISCOVER_IDLE_CHANNEL];

            const { objects: rawObjects, isFirstPoll } = useGraffitiDiscover(
                channelGetter,
                threadLineSchema,
                session,
                true,
            );
            const optimisticQueue = ref([]);
            const optimisticMessages = ref([]);
            const isFlushingQueue = ref(false);

            const sortedMessages = computed(() => {
                const raw = rawObjects.value;
                const statusEvents = raw.filter((o) => o.value.tombstone === true);
                const messages = raw.filter((o) => typeof o.value.content === "string" && !o.value.tombstone);
                const latestByTarget = new Map();
                const legacyDeletedPublished = new Set();

                for (const evt of statusEvents) {
                    const target = evt.value.targetUrl;
                    if (!target) {
                        if (evt.value.deleted !== false) legacyDeletedPublished.add(evt.value.published);
                        continue;
                    }
                    const prev = latestByTarget.get(target);
                    const curStamp = evt.value.statusAt ?? evt.value.published ?? 0;
                    const prevStamp = prev ? (prev.value.statusAt ?? prev.value.published ?? 0) : -1;
                    if (!prev || curStamp > prevStamp || (curStamp === prevStamp && evt.url > prev.url)) {
                        latestByTarget.set(target, evt);
                    }
                }
                const removedByUrl = new Set();
                const activeTombstones = [];
                for (const [targetUrl, evt] of latestByTarget.entries()) {
                    if (evt.value.deleted !== false) {
                        removedByUrl.add(targetUrl);
                        activeTombstones.push(evt);
                    }
                }

                const visibleMsgs = messages.filter((m) => {
                    if (removedByUrl.has(m.url)) return false;
                    if (legacyDeletedPublished.has(m.value.published)) return false;
                    return true;
                });

                return [...visibleMsgs, ...optimisticMessages.value, ...activeTombstones].toSorted((a, b) => {
                    const d = a.value.published - b.value.published;
                    return d !== 0 ? d : a.url.localeCompare(b.url);
                });
            });

            const messagesLoading = computed(() => isFirstPoll.value);

            /** Stable only when visible timeline changes (avoids autopoll deep churn on rawObjects). */
            const timelineSig = computed(() => sortedMessages.value.map((o) => o.url).join("\u0001"));

            const myMessage = ref("");
            const messageInputEl = ref(null);
            const scrollBoxEl = ref(null);
            const scrollEndEl = ref(null);
            const isComposerBusy = computed(() =>
                isFlushingQueue.value || optimisticQueue.value.length > 0,
            );

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

            function focusComposer() {
                nextTick(() => {
                    requestAnimationFrame(() => {
                        if (messageInputEl.value) {
                            messageInputEl.value.focus();
                        }
                    });
                });
            }

            watch(timelineSig, () => scrollChatToBottom(), { flush: "post" });
            watch(() => activeThread.value?.url, (url) => { if (url) focusComposer(); }, { immediate: true });
            watch(
                () => new Set(rawObjects.value.map((o) => o.value.clientNonce).filter(Boolean)),
                (remoteNonces) => {
                    optimisticMessages.value = optimisticMessages.value.filter(
                        (m) => !remoteNonces.has(m.value.clientNonce),
                    );
                },
                { deep: false },
            );

            async function flushOptimisticQueue() {
                if (isFlushingQueue.value) return;
                isFlushingQueue.value = true;
                try {
                    while (optimisticQueue.value.length > 0) {
                        const next = optimisticQueue.value[0];
                        try {
                            await graffiti.post(next.payload, session.value);
                        } catch (err) {
                            optimisticMessages.value = optimisticMessages.value.filter(
                                (m) => m.value.clientNonce !== next.clientNonce,
                            );
                            console.error(err);
                        }
                        optimisticQueue.value.shift();
                    }
                } finally {
                    isFlushingQueue.value = false;
                }
            }

            function isPendingMessage(obj) {
                return String(obj?.url ?? "").startsWith("local:");
            }

            async function sendMessage() {
                if (!myMessage.value.trim() || !activeThread.value) return;
                const content = myMessage.value.trim();
                const published = Date.now();
                const clientNonce = crypto.randomUUID();
                const payload = {
                    value: {
                        content,
                        published,
                        clientNonce,
                    },
                    channels: [activeThread.value.value.channel],
                };
                const localEcho = {
                    url: `local:${clientNonce}`,
                    actor: session.value.actor,
                    value: payload.value,
                };
                optimisticQueue.value.push({ payload, clientNonce });
                optimisticMessages.value.push(localEcho);
                myMessage.value = "";
                scrollChatToBottom();
                focusComposer();
                flushOptimisticQueue();
                // Omit `allowed`: with a fixed list, joiners often miss messages until
                // membership syncs; Graffiti shows channel objects to all discoverers
                // when `allowed` is absent (@graffiti-garden/wrapper-vue `nt` filter).
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
                        allowed: membersOfThread(activeThread.value),
                    },
                    session.value,
                );
                router.push("/chats");
            }

            return {
                session,
                activeThread,
                memberActors,
                chatMetaTitle,
                sortedMessages,
                messagesLoading,
                myMessage,
                isComposerBusy,
                isPendingMessage,
                sendMessage,
                leaveThread,
                messageInputEl,
                scrollBoxEl,
                scrollEndEl,
            };
        },
    };
};
