export default async () => ({
    template: await fetch(new URL("./ThreadCardTagsDisplay.html", import.meta.url)).then((r) => r.text()),
    props: {
        tags: { type: Array, default: () => [] },
    },
});
