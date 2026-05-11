import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { truncateTagLabel } from "./tagLabel.js";

/** ~20% smaller than original base sizing */
const FONT_SCALE = 0.8;
/** Smallest tag `font-size` (rem); largest = `FONT_REM_MIN * TAG_FONT_SIZE_RATIO` (default 2×). */
const FONT_REM_MIN = 0.48 * FONT_SCALE;
const TAG_FONT_SIZE_RATIO = 2;
/** Uniform scale on every tag’s `font-size` (rem). */
const CLOUD_FONT_FLAT_SCALE = 1.5;

/** World %-space origin for placement + pan recenter (middle of the panning canvas). */
const WORLD_VISUAL_CENTER_X_PCT = 50;
const WORLD_VISUAL_CENTER_Y_PCT = 50;

const PLACEMENT_ATTEMPTS = 80;
/** First random-walk step length (% of world); multiplied after each failed collision. */
const WALK_DIST0 = 0.38;
const WALK_DIST_MULT = 1.09;
const WALK_DIST_CAP = 9;
const COLLISION_GAP_PCT = 0.12;

/** Draw dashed rects matching `rectsOverlap` geometry (set true while debugging layout). */
const SHOW_TAG_CLOUD_COLLISION_DEBUG = false;

/** Clears pending settle timers/listeners when re-hovering or unmounting mid-transition. */
const wordWiggleCleanups = new WeakMap();

function cleanupWordWiggle(inner) {
    const fn = wordWiggleCleanups.get(inner);
    if (fn) {
        fn();
        wordWiggleCleanups.delete(inner);
    }
}

function rotationDegFromTransform(transform) {
    if (!transform || transform === "none") return 0;
    const Matrix = typeof DOMMatrixReadOnly !== "undefined" ? DOMMatrixReadOnly : typeof DOMMatrix !== "undefined" ? DOMMatrix : null;
    if (!Matrix) return 0;
    try {
        const m = new Matrix(transform);
        return (Math.atan2(m.b, m.a) * 180) / Math.PI;
    } catch {
        return 0;
    }
}

/** Collapse rapid layout updates (e.g. threads streaming in) to one pan recenter at the end. */
const PAN_RECENTER_DEBOUNCE_MS = 300;

/** When no collision-free spot is found after all attempts, still place and mark this color. */
const DEBUG_FORCED_PLACEMENT_COLOR = "#c62828";

function hash32(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
}

/** Fallback when world has no px size yet (avoid `px/0` → invalid % and full-width debug rects). */
function estimateBoxPercent(labelText, fontSizeRem) {
    const fs = Math.max(0.55, fontSizeRem);
    const ch = Math.max(1, labelText.length);
    const w0 = clamp(3.4 + ch * 2.05 * fs, 7.5, 82);
    const h0 = clamp(4.0 + fs * 5.4, 5, 22);
    return {
        w: Math.min(88, w0 * 1.02),
        h: Math.min(28, h0 * 1.02),
    };
}

let _measureCanvas;
function measureTextWidthPx(label, fontSizeRem, rootPx) {
    if (typeof document === "undefined") return null;
    if (!_measureCanvas) _measureCanvas = document.createElement("canvas");
    const ctx = _measureCanvas.getContext("2d");
    if (!ctx) return null;
    const fontPx = fontSizeRem * rootPx;
    const family =
        typeof getComputedStyle === "function"
            ? getComputedStyle(document.body).fontFamily || "system-ui, sans-serif"
            : "system-ui, sans-serif";
    ctx.font = `600 ${fontPx}px ${family}`;
    const m = ctx.measureText(label);
    const w = m.width;
    return Number.isFinite(w) ? w : null;
}

/**
 * Collision box in %-of-world from measured glyph width (matches on-screen word + padding).
 * Requires positive world pixel size so `%` never becomes NaN/Infinity (which stretches boxes to the edge).
 */
function labelBoxPercent(labelText, fontSizeRem, worldWpx, worldHpx) {
    const rootPx =
        typeof document !== "undefined"
            ? parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
            : 16;
    const fontPx = fontSizeRem * rootPx;
    /* Match .explore-tag-cloud-word padding: 0.14em 0.168em (em = element font = rem-sized here). */
    const padX = 2 * 0.168 * fontPx;
    const padY = 2 * 0.14 * fontPx;
    const lineH = fontPx * 1.15;

    if (worldWpx <= 0 || worldHpx <= 0 || typeof document === "undefined") {
        return estimateBoxPercent(labelText, fontSizeRem);
    }

    const textW = measureTextWidthPx(labelText, fontSizeRem, rootPx);
    const wPx = (textW != null ? textW : fontPx * Math.max(1, labelText.length) * 0.52) + padX;
    const hPx = lineH + padY;
    const wPct = clamp((wPx / worldWpx) * 100, 1.8, 94);
    const hPct = clamp((hPx / worldHpx) * 100, 1.5, 30);
    return { w: wPct, h: hPct };
}

function rectsOverlap(a, b) {
    const g = COLLISION_GAP_PCT;
    return !(
        a.left + a.w + g <= b.left - g ||
        b.left + b.w + g <= a.left - g ||
        a.top + a.h + g <= b.top - g ||
        b.top + b.h + g <= a.top - g
    );
}

function tagsFingerprint(list) {
    return [...list]
        .map((t) => `${t.key}\0${t.count}`)
        .sort()
        .join("|");
}

/** One row per unique tag (case-insensitive); count = chats containing that tag. */
function tagCountsFromThreads(threads) {
    const map = new Map();
    for (const obj of threads) {
        const seen = new Set();
        for (const raw of obj.value?.tags ?? []) {
            const t = String(raw).trim();
            if (!t) continue;
            const k = t.toLowerCase();
            if (seen.has(k)) continue;
            seen.add(k);
            const cur = map.get(k);
            if (!cur) map.set(k, { display: t, count: 1 });
            else {
                cur.count += 1;
            }
        }
    }
    return [...map.values()].map((v) => ({ key: v.display.toLowerCase(), display: v.display, count: v.count }));
}

/** Maps frequency in the current list so rarest → `FONT_REM_MIN`, most common → `FONT_REM_MIN * ratio`. */
function fontSizeForCount(t, logMin, logMax) {
    const logC = Math.log(1 + t.count);
    const span = logMax - logMin;
    const fontRemMax = FONT_REM_MIN * TAG_FONT_SIZE_RATIO;
    if (span < 1e-9) {
        return (FONT_REM_MIN + fontRemMax) / 2;
    }
    const s = (logC - logMin) / span;
    return FONT_REM_MIN + (fontRemMax - FONT_REM_MIN) * s;
}

/**
 * Highest-frequency tags first in the placement algorithm.
 * DOM order is sorted by tag key (stable) so Vue does not reorder nodes and apply move/FLIP
 * transforms that fight `left`/`top`. Stacking uses `z-index` from font size instead.
 *
 * @returns {{ items: Array }} Word placement only; pan is independent (see `resetPanToCenter`).
 */
function layoutCloudWords(list, layoutFingerprint, worldWpx, worldHpx) {
    if (list.length === 0) {
        return { items: [] };
    }
    const logs = list.map((t) => Math.log(1 + t.count));
    const logMax = Math.max(...logs, 1e-9);
    const logMin = Math.min(...logs);

    const scored = list.map((t) => {
        const fontSizeRem =
            list.length === 1
                ? FONT_REM_MIN * TAG_FONT_SIZE_RATIO * CLOUD_FONT_FLAT_SCALE
                : fontSizeForCount(t, logMin, logMax) * CLOUD_FONT_FLAT_SCALE;
        const logC = Math.log(1 + t.count);
        const scale = logC / logMax;
        const opacity = 0.35 + 0.65 * scale;
        const short = truncateTagLabel(t.display, 9);
        const label = `${short} (${t.count})`;
        const box = labelBoxPercent(label, fontSizeRem, worldWpx, worldHpx);
        return { t, fontSizeRem, opacity, label, box };
    });

    scored.sort((a, b) => {
        if (b.t.count !== a.t.count) return b.t.count - a.t.count;
        return b.fontSizeRem - a.fontSizeRem;
    });

    const placed = [];
    const originX = WORLD_VISUAL_CENTER_X_PCT;
    const originY = WORLD_VISUAL_CENTER_Y_PCT;

    const built = scored.map((row, index) => {
        const { t, fontSizeRem, opacity, label, box } = row;

        const minCx = 1.5 + box.w / 2;
        const maxCx = 97.5 - box.w / 2;
        const minCy = 1 + box.h / 2;
        const maxCy = 96 - box.h / 2;

        const rng = mulberry32(hash32(`${layoutFingerprint}|${index}|${t.key}`));
        let cx = clamp(originX, minCx, maxCx);
        let cy = clamp(originY, minCy, maxCy);
        let dist = WALK_DIST0;

        let placedOk = false;
        for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
            const left = cx - box.w / 2;
            const top = cy - box.h / 2;
            const rect = { left, top, w: box.w, h: box.h };
            if (!placed.some((p) => rectsOverlap(rect, p))) {
                placed.push(rect);
                placedOk = true;
                break;
            }
            const ang = rng() * 2 * Math.PI;
            cx = clamp(cx + Math.cos(ang) * dist, minCx, maxCx);
            cy = clamp(cy + Math.sin(ang) * dist, minCy, maxCy);
            dist = Math.min(WALK_DIST_CAP, dist * WALK_DIST_MULT);
        }

        const left = cx - box.w / 2;
        const top = cy - box.h / 2;
        const rect = { left, top, w: box.w, h: box.h };
        if (!placedOk) {
            placed.push(rect);
        }

        const style = {
            left: `${left}%`,
            top: `${top}%`,
            fontSize: `${fontSizeRem}rem`,
            "--tag-cloud-op": String(opacity),
            zIndex: String(Math.round(100 + fontSizeRem * 800)),
        };
        if (!placedOk) {
            style.color = DEBUG_FORCED_PLACEMENT_COLOR;
        }

        const item = {
            key: t.key,
            display: t.display,
            label,
            style,
            isPrimary: index === 0,
        };
        if (SHOW_TAG_CLOUD_COLLISION_DEBUG) {
            item.collisionBoxStyle = {
                left: `${left}%`,
                top: `${top}%`,
                width: `${box.w}%`,
                height: `${box.h}%`,
            };
        }
        return item;
    });

    built.sort((a, b) => a.key.localeCompare(b.key));
    return { items: built };
}

export default async () => ({
    template: await fetch(new URL("./ExploreTagWordCloud.html", import.meta.url)).then((r) => r.text()),
    props: {
        threads: { type: Array, default: () => [] },
        draft: { type: String, default: "" },
        /** Tags already in the filter; excluded from cloud + strip (unknown strings are ignored). */
        selectedTags: { type: Array, default: () => [] },
        disabled: { type: Boolean, default: false },
    },
    emits: ["pick"],
    setup(props) {
        /** Tag list for the cloud; new array each call — do not watch this ref directly. */
        function buildFilteredTagList() {
            const stats = tagCountsFromThreads(props.threads ?? []);
            const q = props.draft.trim().toLowerCase();
            if (!q) return stats;
            return stats.filter((t) => t.key.includes(q) || t.display.toLowerCase().includes(q));
        }

        /** Draft-filtered stats minus tags already chosen in the filter bar. */
        function buildCloudPoolTagList() {
            const selected = new Set(
                (props.selectedTags ?? []).map((s) => String(s).trim().toLowerCase()).filter(Boolean),
            );
            return buildFilteredTagList().filter((t) => !selected.has(t.key));
        }

        /**
         * Stable string: only changes when visible tag keys/counts or draft filter meaningfully change.
         * Watching `filteredStats`-style arrays reset pan whenever the parent passes a new `threads`
         * array (same tags) because those computables always allocate fresh arrays.
         */
        const cloudLayoutFingerprint = computed(() => tagsFingerprint(buildCloudPoolTagList()));

        /** Collapsed strip: same pool as the cloud, highest frequency first. */
        const stripItems = computed(() => {
            const pool = [...buildCloudPoolTagList()];
            pool.sort((a, b) => {
                if (b.count !== a.count) return b.count - a.count;
                return a.key.localeCompare(b.key);
            });
            return pool.map((t) => {
                const short = truncateTagLabel(t.display, 9);
                return { key: t.key, display: t.display, label: `${short} (${t.count})` };
            });
        });

        const showDisclaimer = computed(
            () => props.draft.trim().length > 0 && buildFilteredTagList().length === 0,
        );

        const layoutItems = ref([]);

        const cloudCollapsed = ref(false);

        function toggleCloudCollapsed() {
            if (props.disabled) return;
            cloudCollapsed.value = !cloudCollapsed.value;
        }

        const viewportEl = ref(null);
        const worldEl = ref(null);
        const panX = ref(0);
        const panY = ref(0);

        /** After first in-view pan from real data, further layout churn only updates pan on the debounced edge. */
        const panSeededFromLayout = ref(false);
        let panRecenterTimer = null;

        const worldStyle = computed(() => ({
            transform: `translate3d(${panX.value}px, ${panY.value}px, 0)`,
        }));

        let panDrag = null;

        function getPanBounds() {
            const vw = viewportEl.value?.clientWidth ?? 0;
            const vh = viewportEl.value?.clientHeight ?? 0;
            const ww = worldEl.value?.offsetWidth ?? 0;
            const wh = worldEl.value?.offsetHeight ?? 0;
            const minX = Math.min(0, vw - ww);
            const minY = Math.min(0, vh - wh);
            return { minX, minY, maxX: 0, maxY: 0, vw, vh, ww, wh };
        }

        function clampPan() {
            const { minX, minY, maxX, maxY } = getPanBounds();
            panX.value = clamp(panX.value, minX, maxX);
            panY.value = clamp(panY.value, minY, maxY);
        }

        /** Align fixed world center (50%, 50%) with viewport center — independent of tag positions / CSS motion. */
        function resetPanToCenter() {
            const { minX, minY, vw, vh, ww, wh } = getPanBounds();
            if (vw <= 0 || vh <= 0 || ww <= 0 || wh <= 0) return;
            const targetX = (WORLD_VISUAL_CENTER_X_PCT / 100) * ww;
            const targetY = (WORLD_VISUAL_CENTER_Y_PCT / 100) * wh;
            panX.value = clamp(vw / 2 - targetX, minX, 0);
            panY.value = clamp(vh / 2 - targetY, minY, 0);
        }

        function schedulePanRecenter(immediateIfPristine) {
            const run = () => {
                panRecenterTimer = null;
                if (panDrag) return;
                resetPanToCenter();
                clampPan();
            };
            clearTimeout(panRecenterTimer);
            if (immediateIfPristine && !panSeededFromLayout.value) {
                nextTick(run);
                panSeededFromLayout.value = true;
            }
            panRecenterTimer = setTimeout(run, PAN_RECENTER_DEBOUNCE_MS);
        }

        function onViewportPointerDown(e) {
            if (props.disabled) return;
            if (e.pointerType === "mouse" && e.button !== 0) return;
            if (e.target.closest?.(".explore-tag-cloud-word")) return;

            e.preventDefault();

            panDrag = {
                pointerId: e.pointerId,
                startX: e.clientX,
                startY: e.clientY,
                originX: panX.value,
                originY: panY.value,
                moved: false,
            };
            try {
                e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
                /* ignore */
            }
            e.currentTarget.classList.add("explore-tag-cloud-viewport--grabbing");
        }

        function onViewportPointerMove(e) {
            if (!panDrag || e.pointerId !== panDrag.pointerId) return;
            const dx = e.clientX - panDrag.startX;
            const dy = e.clientY - panDrag.startY;
            if (Math.abs(dx) + Math.abs(dy) > 4) panDrag.moved = true;
            panX.value = panDrag.originX + dx;
            panY.value = panDrag.originY + dy;
            clampPan();
        }

        function endPan(e) {
            if (!panDrag || e.pointerId !== panDrag.pointerId) return;
            const el = viewportEl.value;
            if (el) {
                try {
                    el.releasePointerCapture(panDrag.pointerId);
                } catch {
                    /* ignore */
                }
                el.classList.remove("explore-tag-cloud-viewport--grabbing");
            }
            panDrag = null;
        }

        function onViewportPointerUp(e) {
            endPan(e);
        }

        function onViewportPointerCancel(e) {
            endPan(e);
        }

        function onViewportWheel(e) {
            if (props.disabled) return;
            panX.value -= e.deltaX;
            panY.value -= e.deltaY;
            clampPan();
        }

        let ro;
        watch(
            viewportEl,
            (el) => {
                ro?.disconnect();
                if (el) {
                    ro = new ResizeObserver(() => {
                        clampPan();
                    });
                    ro.observe(el);
                    nextTick(() => {
                        if (layoutItems.value.length) {
                            resetPanToCenter();
                            clampPan();
                        }
                    });
                }
            },
            { flush: "post" },
        );
        onUnmounted(() => {
            ro?.disconnect();
            clearTimeout(panRecenterTimer);
        });

        function onWordPointerEnter(e) {
            if (props.disabled) return;
            const inner = e.currentTarget?.querySelector?.(".explore-tag-cloud-word-inner");
            if (!inner) return;
            cleanupWordWiggle(inner);
            inner.style.animation = "";
            inner.style.transform = "";
            inner.style.transition = "";
        }

        function onWordPointerLeave(e) {
            const inner = e.currentTarget?.querySelector?.(".explore-tag-cloud-word-inner");
            if (!inner) return;
            cleanupWordWiggle(inner);
            if (props.disabled) {
                inner.style.animation = "";
                inner.style.transform = "";
                inner.style.transition = "";
                return;
            }
            if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
                inner.style.animation = "";
                inner.style.transform = "";
                inner.style.transition = "";
                return;
            }

            const angleDeg = rotationDegFromTransform(getComputedStyle(inner).transform);
            inner.style.animation = "none";
            inner.style.transition = "none";
            inner.style.transform = `rotate(${angleDeg}deg)`;
            void inner.offsetWidth;
            inner.style.transition = "transform 0.38s ease-out";
            inner.style.transform = "rotate(0deg)";

            let failSafe = null;
            const settle = () => {
                inner.removeEventListener("transitionend", onTransitionEnd);
                if (failSafe != null) {
                    clearTimeout(failSafe);
                    failSafe = null;
                }
                wordWiggleCleanups.delete(inner);
                inner.style.transition = "";
                inner.style.transform = "";
                inner.style.animation = "";
            };
            const onTransitionEnd = (evt) => {
                if (evt.propertyName !== "transform") return;
                settle();
            };
            inner.addEventListener("transitionend", onTransitionEnd);
            failSafe = setTimeout(settle, 450);
            wordWiggleCleanups.set(inner, () => {
                inner.removeEventListener("transitionend", onTransitionEnd);
                if (failSafe != null) {
                    clearTimeout(failSafe);
                    failSafe = null;
                }
                wordWiggleCleanups.delete(inner);
            });
        }

        watch(
            cloudLayoutFingerprint,
            (fp) => {
                const list = buildCloudPoolTagList();
                if (!list.length) {
                    clearTimeout(panRecenterTimer);
                    panRecenterTimer = null;
                    layoutItems.value = [];
                    panX.value = 0;
                    panY.value = 0;
                    panSeededFromLayout.value = false;
                    return;
                }

                /**
                 * `Transition mode="out-in"` mounts the cloud after the disclaimer node leaves, so
                 * `worldEl` is often missing or 0×0 on the first tick — one `nextTick` is not enough.
                 * Show estimate-based layout immediately, then replace once the world has real size.
                 */
                function applyLayoutWhenWorldSized() {
                    const commit = (ww, wh) => {
                        if (tagsFingerprint(buildCloudPoolTagList()) !== fp) return;
                        const wasEmpty = layoutItems.value.length === 0;
                        if (!wasEmpty) {
                            clearTimeout(panRecenterTimer);
                            panRecenterTimer = null;
                        }
                        layoutItems.value = layoutCloudWords(list, fp, ww, wh).items;
                        if (wasEmpty) {
                            schedulePanRecenter(!panSeededFromLayout.value);
                        } else {
                            nextTick(() => clampPan());
                        }
                    };
                    nextTick(() => {
                        if (tagsFingerprint(buildCloudPoolTagList()) !== fp) return;
                        const ww0 = worldEl.value?.offsetWidth ?? 0;
                        const wh0 = worldEl.value?.offsetHeight ?? 0;
                        if (ww0 > 0 && wh0 > 0) {
                            commit(ww0, wh0);
                            return;
                        }
                        commit(0, 0);
                        let frames = 0;
                        const step = () => {
                            if (tagsFingerprint(buildCloudPoolTagList()) !== fp) return;
                            const ww = worldEl.value?.offsetWidth ?? 0;
                            const wh = worldEl.value?.offsetHeight ?? 0;
                            if (ww > 0 && wh > 0) {
                                commit(ww, wh);
                                return;
                            }
                            frames += 1;
                            if (frames > 48) return;
                            requestAnimationFrame(step);
                        };
                        requestAnimationFrame(step);
                    });
                }

                applyLayoutWhenWorldSized();
            },
            { immediate: true },
        );

        watch(showDisclaimer, (v) => {
            if (v) {
                clearTimeout(panRecenterTimer);
                panRecenterTimer = null;
                panX.value = 0;
                panY.value = 0;
                panSeededFromLayout.value = false;
                panDrag = null;
            }
        });

        return {
            showDisclaimer,
            layoutItems,
            stripItems,
            cloudCollapsed,
            toggleCloudCollapsed,
            showCollisionDebug: SHOW_TAG_CLOUD_COLLISION_DEBUG,
            viewportEl,
            worldEl,
            worldStyle,
            onViewportPointerDown,
            onViewportPointerMove,
            onViewportPointerUp,
            onViewportPointerCancel,
            onViewportWheel,
            onWordPointerEnter,
            onWordPointerLeave,
        };
    },
});
