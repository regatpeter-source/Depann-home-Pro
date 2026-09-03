import { STORAGE_KEYS, DEFAULT_SETTINGS, SETTINGS_KEY } from "./config.js?v=132";

export function getStoredRefs(key) {
    try {
        return JSON.parse(localStorage.getItem(key)) || [];
    } catch {
        return [];
    }
}

export function setStoredRefs(key, refs) {
    localStorage.setItem(key, JSON.stringify(refs));
}

export function addToHistory(ref) {
    const history = getStoredRefs(STORAGE_KEYS.history).filter(item => !sameRef(item, ref));
    history.unshift(ref);
    // respect configured max history size when storing
    const max = (function(){
        try {
            const s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
            return Number.isInteger(s.maxHistory) && s.maxHistory > 0 ? s.maxHistory : DEFAULT_SETTINGS.maxHistory;
        } catch {
            return DEFAULT_SETTINGS.maxHistory;
        }
    })();

    setStoredRefs(STORAGE_KEYS.history, history.slice(0, max));
}

export function getSettings() {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return { ...DEFAULT_SETTINGS };
        const saved = JSON.parse(raw) || {};
        return { ...DEFAULT_SETTINGS, ...saved, notifications: { ...DEFAULT_SETTINGS.notifications, ...(saved.notifications || {}) } };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

export function saveSettings(settings) {
    const toSave = { ...DEFAULT_SETTINGS, ...(settings || {}), notifications: { ...DEFAULT_SETTINGS.notifications, ...(settings?.notifications || {}) } };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(toSave));
    return toSave;
}

export function clearHistory() {
    localStorage.removeItem(STORAGE_KEYS.history);
}

export function sameRef(a, b) {
    return a.brandIndex === b.brandIndex
        && a.categoryIndex === b.categoryIndex
        && a.productIndex === b.productIndex
        && a.procedureIndex === b.procedureIndex;
}
