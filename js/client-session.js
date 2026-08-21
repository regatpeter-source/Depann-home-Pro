const STORAGE_KEY = "depannHomePro:clientWindowSession";
const REPLACED_EVENT = "depannhome:session-replaced";

export function installClientSessionGuard() {
    const clientSessionId = getClientSessionId();
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
        const url = new URL(typeof input === "string" ? input : input.url, window.location.href);
        const headers = new Headers(init.headers || (typeof input !== "string" ? input.headers : undefined));
        if (url.origin === window.location.origin && url.pathname.startsWith("/api/")) headers.set("X-DepannHome-Client-Session", clientSessionId);
        const response = await originalFetch(input, { ...init, headers });
        if (response.headers.get("X-DepannHome-Session-Replaced") === "true") window.dispatchEvent(new CustomEvent(REPLACED_EVENT));
        return response;
    };
}

export function onClientSessionReplaced(handler) {
    window.addEventListener(REPLACED_EVENT, handler);
}

function getClientSessionId() {
    let value = sessionStorage.getItem(STORAGE_KEY);
    if (!value || !/^[0-9a-f-]{36}$/i.test(value)) {
        value = crypto.randomUUID();
        sessionStorage.setItem(STORAGE_KEY, value);
    }
    return value;
}