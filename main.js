import { createApp, computed, ref, watch, nextTick } from "vue";
import { createRouter, createWebHashHistory, useRoute } from "vue-router";
import { GraffitiPlugin }         from "@graffiti-garden/wrapper-vue";
import { GraffitiDecentralized }  from "@graffiti-garden/implementation-decentralized";
import { useSharedStore }         from "./store.js";

function loadView(name) {
    return () => import(`./${name}/main.js`).then((m) => m.default());
}

const router = createRouter({
    history: createWebHashHistory(),
    routes: [
        { path: "/",                redirect: "/explore" },
        { path: "/explore",         component: loadView("explore") },
        { path: "/chats",           component: loadView("chats") },
        { path: "/chat/:threadUrl", component: loadView("chat"), props: true },
    ],
});

createApp({
    template: "#template",
    setup() {
        const route = useRoute();
        const { session, ...storeRest } = useSharedStore();
        const appThemeClass = computed(() =>
            route.path === "/chats" || route.path.startsWith("/chat/") ? "app-theme-chat" : null,
        );

        const bootCoverVisible = ref(true);
        const bootCoverFade = ref(false);

        watch(
            session,
            async (v, prev) => {
                if (v === undefined) {
                    bootCoverVisible.value = true;
                    bootCoverFade.value = false;
                    return;
                }
                if (prev === undefined) {
                    await nextTick();
                    bootCoverFade.value = true;
                }
            },
            { immediate: true },
        );

        function onBootCoverTransitionEnd(e) {
            if (e.target !== e.currentTarget || e.propertyName !== "opacity") return;
            if (bootCoverFade.value) bootCoverVisible.value = false;
        }

        return {
            ...storeRest,
            session,
            appThemeClass,
            bootCoverVisible,
            bootCoverFade,
            onBootCoverTransitionEnd,
        };
    },
})
    .use(GraffitiPlugin, { graffiti: new GraffitiDecentralized() })
    .use(router)
    .mount("#app");
