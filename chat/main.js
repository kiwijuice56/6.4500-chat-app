import { ref, computed, watch, nextTick } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useGraffiti, useGraffitiSession, useGraffitiDiscover } from "@graffiti-garden/wrapper-vue";
import { CLASS_CHANNEL, threads, threadsLoading, membersOfThread } from "../store.js";

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

            const isThreadOwner = computed(
                () =>
                    !!activeThread.value &&
                    !!session.value?.actor &&
                    activeThread.value.actor === session.value.actor,
            );

            const isDeletingThread = ref(false);

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

                const remoteNonces = new Set(visibleMsgs.map((m) => m.value?.clientNonce).filter(Boolean));
                const optimisticDeduped = optimisticMessages.value.filter(
                    (m) => !m.value?.clientNonce || !remoteNonces.has(m.value.clientNonce),
                );

                return [...visibleMsgs, ...optimisticDeduped, ...activeTombstones].toSorted((a, b) => {
                    const d = a.value.published - b.value.published;
                    return d !== 0 ? d : a.url.localeCompare(b.url);
                });
            });

            const messagesLoading = computed(() => isFirstPoll.value);

            const myMessage = ref("");
            const messageInputEl = ref(null);
            const scrollBoxEl = ref(null);
            const scrollEndEl = ref(null);
            const scrollAnimRunId = ref(0);
            const isComposerBusy = computed(() =>
                isFlushingQueue.value || optimisticQueue.value.length > 0,
            );

            function isNearBottom(box, thresholdPx = 48) {
                return box.scrollHeight - box.scrollTop - box.clientHeight <= thresholdPx;
            }

            /** If newList extends oldList with the same prefix (in order), return appended slice; else null. */
            function appendedTail(oldList, newList) {
                if (!newList?.length) return null;
                if (!oldList?.length) return newList.length ? [...newList] : null;
                if (newList.length <= oldList.length) return null;
                for (let i = 0; i < oldList.length; i += 1) {
                    if (oldList[i].url !== newList[i].url) return null;
                }
                return newList.slice(oldList.length);
            }

            function isChatLineMessage(m) {
                return typeof m.value?.content === "string" && !m.value?.tombstone;
            }

            function scrollChatToBottomInstant() {
                scrollAnimRunId.value += 1;
                nextTick(() => {
                    const box = scrollBoxEl.value;
                    if (!box) return;
                    box.scrollTop = box.scrollHeight - box.clientHeight;
                });
            }

            /** Linear ~100ms scroll to bottom; invalidates prior runs via scrollAnimRunId. */
            function scrollChatToBottomAnimated() {
                const runId = ++scrollAnimRunId.value;
                nextTick(() => {
                    requestAnimationFrame(() => {
                        const box = scrollBoxEl.value;
                        if (!box || runId !== scrollAnimRunId.value) return;
                        const start = box.scrollTop;
                        const durationMs = 100;
                        const t0 = performance.now();
                        function step(now) {
                            if (runId !== scrollAnimRunId.value) return;
                            const b = scrollBoxEl.value;
                            if (!b) return;
                            const t = Math.min(1, (now - t0) / durationMs);
                            const end = b.scrollHeight - b.clientHeight;
                            if (t >= 1) {
                                b.scrollTop = end;
                                return;
                            }
                            b.scrollTop = start + (end - start) * t;
                            requestAnimationFrame(step);
                        }
                        requestAnimationFrame(step);
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

            watch(
                sortedMessages,
                (newList, oldList) => {
                    const box = scrollBoxEl.value;
                    if (!box || oldList === undefined) return;
                    const wasPinned = isNearBottom(box);
                    const tail = appendedTail(oldList, newList);
                    if (!tail?.length) return;
                    const chatTail = tail.filter(isChatLineMessage);
                    if (!chatTail.length) return;
                    const me = session.value?.actor;
                    const hasIncomingFromOther = chatTail.some(
                        (m) => m.actor !== me && !isPendingMessage(m),
                    );
                    if (hasIncomingFromOther && wasPinned) scrollChatToBottomAnimated();
                },
                { flush: "sync" },
            );

            watch(
                () => activeThread.value?.url,
                (url) => {
                    if (url) {
                        focusComposer();
                        scrollChatToBottomInstant();
                    }
                },
                { immediate: true },
            );

            watch(
                messagesLoading,
                (loading) => {
                    if (loading) return;
                    scrollChatToBottomInstant();
                },
                { immediate: true },
            );
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

            /** Stable across optimistic → server row so the bubble (avatar) is not remounted. */
            function messageBubbleKey(obj) {
                const n = obj.value?.clientNonce;
                if (n) return `nonce:${n}`;
                return obj.url;
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
                scrollChatToBottomAnimated();
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

            async function deleteThread() {
                if (!activeThread.value || !isThreadOwner.value || isDeletingThread.value) return;
                if (
                    !confirm(
                        "Delete this chat for everyone? The chat will disappear from Explore and My Chats. This cannot be undone.",
                    )
                ) {
                    return;
                }
                isDeletingThread.value = true;
                try {
                    const t = activeThread.value;
                    await graffiti.post(
                        {
                            value: {
                                tombstone: true,
                                published: t.value.published ?? Date.now(),
                                targetUrl: t.url,
                                deleted: true,
                                statusAt: Date.now(),
                            },
                            channels: [CLASS_CHANNEL],
                        },
                        session.value,
                    );
                    router.push("/chats");
                } catch (err) {
                    console.error(err);
                } finally {
                    isDeletingThread.value = false;
                }
            }

            return {
                session,
                threadsLoading,
                activeThread,
                memberActors,
                chatMetaTitle,
                sortedMessages,
                messagesLoading,
                myMessage,
                isComposerBusy,
                isPendingMessage,
                messageBubbleKey,
                sendMessage,
                leaveThread,
                deleteThread,
                isThreadOwner,
                isDeletingThread,
                messageInputEl,
                scrollBoxEl,
                scrollEndEl,
            };
        },
    };
};
