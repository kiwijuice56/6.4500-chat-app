import { computed } from "vue";
import { useGraffitiActorToHandle } from "@graffiti-garden/wrapper-vue";

export default async () => ({
    template: await fetch(new URL("./ThreadCardLastPreview.html", import.meta.url)).then((r) => r.text()),
    props: {
        preview: { type: Object, default: null }, // { actor, content } | null
    },
    setup(props) {
        const actor = computed(() => props.preview?.actor ?? "");
        const { handle } = useGraffitiActorToHandle(actor);

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

        return { displayName, avatarInitials, avatarBgColor };
    },
});
