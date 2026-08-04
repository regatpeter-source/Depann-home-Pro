import { escapeHtml } from "./utils.js?v=44";

export async function renderPlatformAnnouncement(container) {
    if (!container) return;
    const placeholder = document.createElement("section");
    placeholder.className = "platform-announcement";
    placeholder.hidden = true;
    container.prepend(placeholder);

    try {
        const response = await fetch("/api/creator/platform-announcement/current", { credentials: "same-origin" });
        const data = response.ok ? await response.json().catch(() => null) : null;
        const announcement = data?.announcement;
        if (!announcement?.message || !placeholder.isConnected) return;
        placeholder.hidden = false;
        placeholder.innerHTML = `<p class="eyebrow">Information Depann'Home Pro</p><p>${escapeHtml(announcement.message).replace(/\n/g, "<br>")}</p>`;
    } catch {
        placeholder.remove();
    }
}
