import { createApp }             from "vue";
import { createRouter, createWebHashHistory } from "vue-router";
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
        return useSharedStore();
    },
})
    .use(GraffitiPlugin, { graffiti: new GraffitiDecentralized() })
    .use(router)
    .mount("#app");
