import { useId } from "vue";

export default async () => ({
    template: await fetch(new URL("./ThreadListToolbar.html", import.meta.url)).then((r) => r.text()),
    props: {
        modelValue: { type: String, default: "" },
        searchLabel: { type: String, default: "Search by name:" },
        disabled: { type: Boolean, default: false },
    },
    emits: ["update:modelValue"],
    setup() {
        const searchInputId = useId();
        return { searchInputId };
    },
});
