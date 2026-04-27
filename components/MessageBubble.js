import { ref, computed } from "vue";
import {
    useGraffiti,
    useGraffitiSession,
    useGraffitiActorToHandle,
} from "@graffiti-garden/wrapper-vue";

const deleteIconUrl = new URL("../images/delete.png", import.meta.url).href;

export default async () => ({
    template: await fetch(new URL("./MessageBubble.html", import.meta.url)).then((r) => r.text()),

    props: {
        message:       { type: Object,  required: true }, // full Graffiti object
        threadChannel: { type: String, required: true }, // needed to post tombstone
        isPending:     { type: Boolean, default: false },
    },

    setup(props) {
        const graffiti = useGraffiti();
        const session = useGraffitiSession();
        const isDeleting = ref(false);
        const actor = computed(() => props.message.actor ?? "");
        const { handle } = useGraffitiActorToHandle(actor);

        const isOwn = computed(() =>
            session.value?.actor === props.message.actor,
        );

        const formattedTime = computed(() => {
            const date = new Date(props.message.value.published);
            return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        });

        const displayName = computed(() => {
            const actorId = actor.value;
            if (!actorId) return "";
            if (handle.value === undefined) return actorId;
            if (handle.value === null) return actorId;
            return String(handle.value);
        });

        const avatarInitials = computed(() =>
            displayName.value.slice(0, 2).padEnd(2, " ").toUpperCase(),
        );

        const avatarBgColor = computed(() => {
            const src = displayName.value || actor.value || "??";
            let hash = 0;
            for (let i = 0; i < src.length; i += 1) {
                hash = (hash * 31 + src.charCodeAt(i)) >>> 0;
            }
            const hue = hash % 360;
            return `hsl(${hue} 70% 82%)`;
        });

        async function deleteMessage() {
            isDeleting.value = true;
            try {
                // 1. Post a tombstone into the same channel so all members see it.
                //    It uses the original published timestamp so it sorts into the
                //    same position in the timeline as the deleted message.
                await graffiti.post(
                    {
                        value: {
                            tombstone: true,
                            published: props.message.value.published,
                            targetUrl: props.message.url,
                        },
                        channels: [props.threadChannel],
                    },
                    session.value,
                );
                if (!props.isPending) {
                    await graffiti.delete({ url: props.message.url }, session.value);
                }
            } finally {
                isDeleting.value = false;
            }
        }

        return {
            isOwn,
            formattedTime,
            isDeleting,
            deleteMessage,
            deleteIconUrl,
            avatarInitials,
            avatarBgColor,
            displayName,
        };
    },
});
