import { getClientSessionId } from "./client-session.js?v=10";

const MAX_TABS = 30;
const STORAGE_PREFIX = "depannHomePro:desktopWorkspace";
const DETACHED_PARAMETER = "workspace";
const drafts = new Map();
let openWorkspaceItem = null;
let tabs = [];
let activeKey = "";
let initialized = false;
let detached = false;

export function initializeDesktopWorkspace(options = {}) {
    if (initialized || document.body.dataset.deviceType !== "desktop") return false;
    const workspace = document.getElementById("desktopWorkspace");
    if (!workspace) return false;
    initialized = true;
    openWorkspaceItem = typeof options.open === "function" ? options.open : null;
    detached = new URLSearchParams(window.location.search).has(DETACHED_PARAMETER);
    tabs = loadTabs();
    workspace.hidden = false;
    bindWorkspace(workspace);

    const initial = readDetachedWorkspaceItem();
    if (!initial) {
        renderWorkspace();
        return false;
    }
    registerItem(initial, { activate: true, persist: true });
    window.queueMicrotask(() => openItem(initial));
    return true;
}

function bindWorkspace(workspace) {
    workspace.addEventListener("click", event => {
        const tab = event.target.closest("[data-workspace-tab]");
        if (tab) return activateItem(tab.dataset.workspaceTab);
        const close = event.target.closest("[data-workspace-close]");
        if (close) return closeItem(close.dataset.workspaceClose);
        if (event.target.closest("[data-workspace-detach]")) detachActiveItem();
    });
    window.addEventListener("depannhome:workspace-item", event => registerItem(event.detail));
    window.addEventListener("depannhome:application-view", event => registerItem(event.detail));
    window.addEventListener("storage", event => {
        if (event.key !== storageKey()) return;
        tabs = loadTabs();
        renderWorkspace();
    });
    document.addEventListener("input", rememberDraft, true);
    document.addEventListener("change", rememberDraft, true);
    window.addEventListener("beforeunload", event => {
        if (![...drafts.values()].some(draft => draft.dirty)) return;
        event.preventDefault();
        event.returnValue = "";
    });
}

function registerItem(value, options = {}) {
    if (!initialized) return;
    const item = normalizeItem(value);
    if (!item) return;
    const existing = tabs.findIndex(tab => tab.key === item.key);
    if (existing >= 0) tabs.splice(existing, 1, { ...tabs[existing], ...item });
    else tabs.push(item);
    if (tabs.length > MAX_TABS) {
        const removable = tabs.findIndex(tab => tab.key !== activeKey && !drafts.get(tab.key)?.dirty);
        tabs.splice(removable >= 0 ? removable : 0, 1);
    }
    if (options.activate !== false) activeKey = item.key;
    if (options.persist !== false) saveTabs();
    renderWorkspace();
    restoreDraftSoon(item.key);
}

function normalizeItem(value) {
    if (!value || typeof value !== "object") return null;
    const type = ["route", "client", "mission"].includes(value.type) ? value.type : "";
    const id = String(value.id || "").slice(0, 160);
    const route = String(value.route || "").slice(0, 80);
    const key = String(value.key || (type === "route" ? `route:${route}` : `${type}:${id}`)).slice(0, 250);
    const title = String(value.title || (type === "client" ? "Client" : type === "mission" ? "Mission" : "Espace de travail")).trim().slice(0, 100);
    const view = value.view && typeof value.view === "object" && !Array.isArray(value.view) ? sanitizeView(value.view) : {};
    if (!type || !key || type === "route" && !route || type !== "route" && !id) return null;
    return { key, type, id, route, title, view };
}

function sanitizeView(value) {
    try { return JSON.parse(JSON.stringify(value)); }
    catch { return {}; }
}

function activateItem(key) {
    const item = tabs.find(tab => tab.key === key);
    if (!item || item.key === activeKey) return;
    captureDraft(activeKey);
    activeKey = item.key;
    renderWorkspace();
    openItem(item);
}

function openItem(item) {
    if (!openWorkspaceItem) return;
    Promise.resolve(openWorkspaceItem(item)).finally(() => restoreDraftSoon(item.key));
}

function closeItem(key) {
    const item = tabs.find(tab => tab.key === key);
    if (!item) return;
    const draft = drafts.get(key);
    if (draft?.dirty && !window.confirm(`Fermer « ${item.title} » et abandonner les modifications non enregistrées ?`)) return;
    drafts.delete(key);
    const index = tabs.findIndex(tab => tab.key === key);
    tabs.splice(index, 1);
    if (activeKey === key) {
        const next = tabs[Math.min(index, tabs.length - 1)] || null;
        activeKey = next?.key || "";
        if (next) openItem(next);
        else if (detached) window.close();
    }
    saveTabs();
    renderWorkspace();
}

function detachActiveItem() {
    const item = tabs.find(tab => tab.key === activeKey);
    if (!item) return;
    captureDraft(activeKey);
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";
    url.searchParams.set(DETACHED_PARAMETER, encodeWorkspaceItem(item));
    url.searchParams.set("clientSession", getClientSessionId());
    const popup = window.open(url.href, `depannhome-${item.key.replace(/[^a-z0-9]+/gi, "-")}`, "popup=yes,width=1180,height=820,resizable=yes,scrollbars=yes");
    if (!popup) window.alert("Autorisez les fenêtres pop-up pour déplacer cet onglet sur le second écran.");
}

function rememberDraft(event) {
    if (!activeKey || !event.target.closest("#brands") || !isDraftControl(event.target)) return;
    captureDraft(activeKey, true);
    renderWorkspace();
}

function captureDraft(key, dirty = false) {
    if (!key) return;
    const controls = [...document.querySelectorAll("#brands input, #brands select, #brands textarea")].filter(isDraftControl);
    if (!controls.length) return;
    const values = controls.map((control, index) => ({
        index,
        name: control.name || "",
        id: control.id || "",
        type: control.type || control.tagName.toLowerCase(),
        value: control.value,
        checked: "checked" in control ? control.checked : undefined
    }));
    drafts.set(key, { values, dirty: dirty || drafts.get(key)?.dirty === true });
}

function restoreDraftSoon(key) {
    const draft = drafts.get(key);
    if (!draft) return;
    [0, 120, 500].forEach(delay => window.setTimeout(() => restoreDraft(key), delay));
}

function restoreDraft(key) {
    if (key !== activeKey) return;
    const draft = drafts.get(key);
    if (!draft) return;
    const controls = [...document.querySelectorAll("#brands input, #brands select, #brands textarea")].filter(isDraftControl);
    draft.values.forEach(saved => {
        let control = controls[saved.index];
        if (!control || saved.name && control.name !== saved.name || saved.id && control.id !== saved.id) {
            control = controls.find(candidate => saved.id && candidate.id === saved.id)
                || controls.find(candidate => saved.name && candidate.name === saved.name);
        }
        if (!control) return;
        if (typeof saved.checked === "boolean" && "checked" in control) control.checked = saved.checked;
        if (control.type !== "file") control.value = saved.value;
    });
}

function isDraftControl(control) {
    return control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement
        ? !["file", "password", "hidden", "button", "submit", "reset"].includes(control.type)
        : false;
}

function renderWorkspace() {
    const workspace = document.getElementById("desktopWorkspace");
    const list = workspace?.querySelector("[data-workspace-tabs]");
    if (!workspace || !list) return;
    workspace.classList.toggle("detached", detached);
    list.innerHTML = tabs.length ? tabs.map(item => {
        const active = item.key === activeKey;
        const dirty = drafts.get(item.key)?.dirty === true;
        return `<div class="desktop-workspace-tab${active ? " active" : ""}${dirty ? " dirty" : ""}"><button type="button" data-workspace-tab="${escapeAttribute(item.key)}" ${active ? 'aria-current="page"' : ""} title="${escapeAttribute(item.title)}"><span>${escapeHtml(item.title)}</span>${dirty ? '<b aria-label="Modifications non enregistrées">●</b>' : ""}</button><button type="button" class="desktop-workspace-close" data-workspace-close="${escapeAttribute(item.key)}" aria-label="Fermer ${escapeAttribute(item.title)}">×</button></div>`;
    }).join("") : '<span class="desktop-workspace-empty">Les menus, sous-menus, clients et missions ouverts apparaîtront ici.</span>';
    const detachButton = workspace.querySelector("[data-workspace-detach]");
    if (detachButton) detachButton.disabled = !activeKey;
    const mode = workspace.querySelector("[data-workspace-mode]");
    if (mode) mode.hidden = !detached;
}

function loadTabs() {
    try {
        const value = JSON.parse(localStorage.getItem(storageKey()) || "[]");
        return Array.isArray(value) ? value.map(normalizeItem).filter(Boolean).slice(-MAX_TABS) : [];
    } catch {
        return [];
    }
}

function saveTabs() {
    try { localStorage.setItem(storageKey(), JSON.stringify(tabs)); } catch {}
}

function storageKey() {
    return `${STORAGE_PREFIX}:${document.body.dataset.accountId || "anonymous"}:${document.body.dataset.activeCompanyId || "default"}`;
}

function readDetachedWorkspaceItem() {
    const value = new URLSearchParams(window.location.search).get(DETACHED_PARAMETER);
    if (!value) return null;
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, "=");
    try { return normalizeItem(JSON.parse(decodeURIComponent(escape(atob(padded))))); }
    catch { return null; }
}

function encodeWorkspaceItem(item) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(item)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function escapeHtml(value) {
    const node = document.createElement("span");
    node.textContent = String(value || "");
    return node.innerHTML;
}

function escapeAttribute(value) {
    return escapeHtml(value).replace(/"/g, "&quot;");
}
