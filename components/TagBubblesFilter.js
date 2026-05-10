import { ref } from "vue";
import { truncateTagLabel } from "./tagLabel.js";

export default async () => ({
    template: await fetch(new URL("./TagBubblesFilter.html", import.meta.url)).then((r) => r.text()),
    props: {
        modelValue: { type: Array, default: () => [] },
        draft: { type: String, default: "" },
        disabled: { type: Boolean, default: false },
    },
    emits: ["update:modelValue", "update:draft"],
    setup(props, { emit }) {
        const inputEl = ref(null);

        function focusInput() {
            if (!props.disabled) inputEl.value?.focus();
        }

        function onDraftInput(e) {
            emit("update:draft", e.target.value);
        }

        function commitDraft() {
            const t = props.draft.trim();
            if (!t) return;
            const k = t.toLowerCase();
            const next = [...props.modelValue];
            if (!next.some((x) => String(x).toLowerCase() === k)) next.push(t);
            emit("update:modelValue", next);
            emit("update:draft", "");
        }

        function removeAt(i) {
            if (props.disabled) return;
            const next = props.modelValue.filter((_, j) => j !== i);
            emit("update:modelValue", next);
        }

        function onBackspace(e) {
            if (props.draft !== "") return;
            if (props.modelValue.length === 0) return;
            e.preventDefault();
            removeAt(props.modelValue.length - 1);
        }

        function formatTagBubble(tag) {
            return truncateTagLabel(tag, 9);
        }

        return {
            inputEl,
            focusInput,
            onDraftInput,
            commitDraft,
            removeAt,
            onBackspace,
            formatTagBubble,
        };
    },
});
