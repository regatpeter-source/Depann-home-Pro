import { getDeviceIdentity } from "./auth.js?v=127";

const STORAGE_KEY = "depannHomePro:clientWindowSession";
const REPLACED_EVENT = "depannhome:session-replaced";
const AUTHENTICATION_REQUIRED_EVENT = "depannhome:authentication-required";

export function installClientSessionGuard() {
    const clientSessionId = getClientSessionId();
    const device = getDeviceIdentity();
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
        const url = new URL(typeof input === "string" ? input : input.url, window.location.href);
        const headers = new Headers(init.headers || (typeof input !== "string" ? input.headers : undefined));
        if (url.origin === window.location.origin && url.pathname.startsWith("/api/")) {
            headers.set("X-DepannHome-Client-Session", clientSessionId);
            headers.set("X-DepannHome-Device-Id", device.deviceId);
            headers.set("X-DepannHome-Device-Type", device.deviceType);
        }
        const response = await originalFetch(input, { ...init, headers });
        if (response.headers.get("X-DepannHome-Session-Replaced") === "true") window.dispatchEvent(new CustomEvent(REPLACED_EVENT));
        else if (response.status === 401 && url.origin === window.location.origin && url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/auth/")) {
            window.dispatchEvent(new CustomEvent(AUTHENTICATION_REQUIRED_EVENT));
        }
        return response;
    };
}

export function onClientSessionReplaced(handler) {
    window.addEventListener(REPLACED_EVENT, handler);
}

export function onAuthenticationRequired(handler) {
    window.addEventListener(AUTHENTICATION_REQUIRED_EVENT, handler);
}

export function clientSessionUrl(path) {
    const url = new URL(path, window.location.href);
    if (url.origin === window.location.origin) url.searchParams.set("clientSession", getClientSessionId());
    return `${url.pathname}${url.search}${url.hash}`;
}

export function getClientSessionId() {
    let value = sessionStorage.getItem(STORAGE_KEY);
    if (!value || !/^[0-9a-f-]{36}$/i.test(value)) {
        value = crypto.randomUUID();
        sessionStorage.setItem(STORAGE_KEY, value);
    }
    return value;
}