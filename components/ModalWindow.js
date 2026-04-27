export default async () => ({
    template: await fetch(new URL("./ModalWindow.html", import.meta.url)).then((r) => r.text()),
    props: {
        open: { type: Boolean, required: true },
        title: { type: String, default: "" },
    },
    emits: ["close"],
    setup(_, { emit }) {
        function emitClose() {
            emit("close");
        }
        return { emitClose };
    },
});
