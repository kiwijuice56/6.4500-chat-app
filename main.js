import { createApp, computed, ref, watch, nextTick, onMounted, onUnmounted } from "vue";
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
        const navMobileOpen = ref(false);

        const appLayoutClass = computed(() => {
            const o = {};
            if (route.path === "/chats" || route.path.startsWith("/chat/")) {
                o["app-theme-chat"] = true;
            }
            if (navMobileOpen.value) {
                o["nav-mobile-open"] = true;
            }
            return o;
        });

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

        function toggleNavMobile() {
            navMobileOpen.value = !navMobileOpen.value;
        }

        function closeNavMobile() {
            navMobileOpen.value = false;
        }

        watch(
            () => route.fullPath,
            () => {
                navMobileOpen.value = false;
            },
        );

        function onNavMobileEscape(e) {
            if (e.key === "Escape") closeNavMobile();
        }

        onMounted(() => {
            window.addEventListener("keydown", onNavMobileEscape);
        });
        onUnmounted(() => {
            window.removeEventListener("keydown", onNavMobileEscape);
        });

        return {
            ...storeRest,
            session,
            appLayoutClass,
            bootCoverVisible,
            bootCoverFade,
            onBootCoverTransitionEnd,
            navMobileOpen,
            toggleNavMobile,
            closeNavMobile,
        };
    },
})
    .use(GraffitiPlugin, { graffiti: new GraffitiDecentralized() })
    .use(router)
    .mount("#app");
