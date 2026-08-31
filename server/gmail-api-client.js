import crypto from "node:crypto";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 10_000;

export async function gmailProfile(accessToken, fetchImpl = fetch) {
    return gmailJson(accessToken, `${GMAIL_API_BASE}/profile`, {}, fetchImpl);
}

export async function gmailListMessages(accessToken, { query = "in:inbox", limit = 100, offset = 0 } = {}, fetchImpl = fetch) {
    const messages = [];
    let skipped = 0;
    let pageToken = "";
    let hasMore = false;
    const target = Math.max(1, Math.min(500, Number(limit) || 100));
    const start = Math.max(0, Number(offset) || 0);
    do {
        const remainingSkip = Math.max(0, start - skipped);
        const pageSize = Math.max(1, Math.min(500, remainingSkip + target - messages.length));
        const params = new URLSearchParams({ q: query, maxResults: String(pageSize), includeSpamTrash: "false" });
        if (pageToken) params.set("pageToken", pageToken);
        const payload = await gmailJson(accessToken, `${GMAIL_API_BASE}/messages?${params}`, {}, fetchImpl);
        const page = Array.isArray(payload.messages) ? payload.messages.filter(item => item?.id) : [];
        if (remainingSkip >= page.length) skipped += page.length;
        else {
            const first = remainingSkip;
            messages.push(...page.slice(first, first + target - messages.length));
            skipped += first;
        }
        pageToken = typeof payload.nextPageToken === "string" ? payload.nextPageToken : "";
        hasMore = Boolean(pageToken) || page.length > Math.max(0, start - skipped) + (target - messages.length);
    } while (pageToken && messages.length < target);
    return { messages: messages.slice(0, target), hasMore, nextPageToken: pageToken };
}

export async function gmailMessageRaw(accessToken, messageId, fetchImpl = fetch) {
    const payload = await gmailJson(accessToken, `${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}?format=raw`, {}, fetchImpl);
    if (!payload.raw) throw gmailError(404, "Gmail message content unavailable.");
    return { id: payload.id, threadId: payload.threadId || "", source: decodeBase64Url(payload.raw) };
}

export async function gmailMessageDetails(accessToken, messageId, fetchImpl = fetch) {
    const payload = await gmailJson(accessToken, `${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}?format=full`, {}, fetchImpl);
    const headers = gmailHeaders(payload.payload?.headers);
    const parts = flattenParts(payload.payload);
    const textPart = parts.find(part => part.mimeType === "text/plain" && !part.filename) || parts.find(part => part.mimeType === "text/html" && !part.filename);
    const body = textPart?.body?.data ? decodeBase64Url(textPart.body.data).toString("utf8") : "";
    const attachments = parts.filter(part => part.filename && (part.body?.attachmentId || part.body?.data)).map(part => ({
        id: String(part.partId || ""),
        name: part.filename,
        contentType: String(part.mimeType || "application/octet-stream").toLowerCase(),
        size: Math.max(0, Number(part.body?.size) || 0)
    })).filter(item => item.id);
    return {
        id: payload.id,
        threadId: payload.threadId || "",
        subject: headers.subject || "",
        from: parseAddressHeader(headers.from),
        replyTo: parseAddressHeader(headers["reply-to"] || headers.from),
        to: parseAddressList(headers.to),
        cc: parseAddressList(headers.cc),
        receivedAt: Number(payload.internalDate) ? new Date(Number(payload.internalDate)).toISOString() : headers.date || null,
        isRead: !Array.isArray(payload.labelIds) || !payload.labelIds.includes("UNREAD"),
        snippet: String(payload.snippet || ""),
        bodyText: String(textPart?.mimeType || "").toLowerCase() === "text/html" ? htmlToText(body) : body,
        attachments,
        messageId: headers["message-id"] || "",
        inReplyTo: headers["in-reply-to"] || "",
        references: headers.references || ""
    };
}

export async function gmailDownloadAttachment(accessToken, messageId, partId, fetchImpl = fetch, maxBytes = 5 * 1024 * 1024) {
    const message = await gmailJson(accessToken, `${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}?format=full`, {}, fetchImpl);
    const part = flattenParts(message.payload).find(item => String(item.partId || "") === String(partId));
    if (!part?.filename) throw gmailError(404, "Gmail attachment unavailable.");
    if (Number(part.body?.size) > maxBytes) throw gmailError(413, "Gmail attachment exceeds the allowed size.");
    let data = part.body?.data || "";
    if (!data && part.body?.attachmentId) {
        const attachment = await gmailJson(accessToken, `${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`, {}, fetchImpl);
        data = attachment.data || "";
    }
    if (!data) throw gmailError(404, "Gmail attachment unavailable.");
    const content = decodeBase64Url(data);
    if (content.length > maxBytes) throw gmailError(413, "Gmail attachment exceeds the allowed size.");
    return { name: part.filename, contentType: part.mimeType || "application/octet-stream", size: content.length, content };
}

export async function gmailSendMessage(accessToken, rawMessage, threadId = "", fetchImpl = fetch) {
    const body = { raw: encodeBase64Url(rawMessage) };
    if (threadId) body.threadId = threadId;
    return gmailJson(accessToken, `${GMAIL_API_BASE}/messages/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, fetchImpl);
}

export async function gmailJson(accessToken, url, options = {}, fetchImpl = fetch) {
    const response = await gmailFetch(accessToken, url, options, fetchImpl);
    return response.status === 204 ? {} : response.json().catch(() => ({}));
}

async function gmailFetch(accessToken, url, options, fetchImpl) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        let response;
        try {
            response = await fetchImpl(url, { ...options, headers: { Authorization: `Bearer ${accessToken}`, ...(options.headers || {}) }, redirect: "error", signal: AbortSignal.timeout(20_000) });
        } catch (error) {
            if (error?.name === "TimeoutError") throw gmailError(503, "Gmail API timed out.");
            throw error;
        }
        if (response.ok) return response;
        const payload = await response.json().catch(() => ({}));
        const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
        const retryable = response.status === 429 || response.status === 503;
        const retryDelay = retryAfterSeconds ? retryAfterSeconds * 1000 : 1000 * (2 ** attempt);
        if (retryable && attempt < MAX_RETRIES && retryDelay <= MAX_RETRY_DELAY_MS) {
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            continue;
        }
        const reason = payload?.error?.errors?.[0]?.reason || payload?.error?.status || "gmail_api_error";
        const error = gmailError(response.status, response.status === 401 || response.status === 403 ? "Gmail API authentication failed." : response.status === 404 ? "Gmail resource unavailable." : "Gmail API request failed.");
        error.code = String(reason).slice(0, 80);
        error.authenticationFailed = response.status === 401 || response.status === 403;
        error.throttled = response.status === 429;
        error.retryAfterSeconds = retryAfterSeconds;
        throw error;
    }
    throw gmailError(503, "Gmail API request failed.");
}

export function gmailSearchQuery({ since, before } = {}) {
    const values = ["in:inbox"];
    if (since instanceof Date && Number.isFinite(since.getTime())) values.push(`after:${Math.floor(since.getTime() / 1000)}`);
    if (before instanceof Date && Number.isFinite(before.getTime())) values.push(`before:${Math.floor(before.getTime() / 1000)}`);
    return values.join(" ");
}

export function gmailMessageUid(messageId) {
    const digest = crypto.createHash("sha256").update(String(messageId || "")).digest("hex").slice(0, 13);
    return Number.parseInt(digest, 16);
}

export function encodeBase64Url(value) {
    return Buffer.from(value).toString("base64url");
}

export function decodeBase64Url(value) {
    return Buffer.from(String(value || ""), "base64url");
}

function flattenParts(root) {
    const result = [];
    const visit = part => { if (!part) return; result.push(part); for (const child of part.parts || []) visit(child); };
    visit(root);
    return result;
}

function gmailHeaders(values) {
    return Object.fromEntries((Array.isArray(values) ? values : []).map(header => [String(header?.name || "").toLowerCase(), String(header?.value || "")]));
}

function parseAddressList(value) {
    return String(value || "").split(/,(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)/).map(parseAddressHeader).filter(item => item.address);
}

function parseAddressHeader(value) {
    const text = String(value || "").trim();
    const match = /^(?:"?([^"<]*)"?\s*)?<([^<>\s]+@[^<>\s]+)>$/.exec(text);
    if (match) return { name: match[1].trim(), address: match[2].toLowerCase() };
    const address = /[^\s<>]+@[^\s<>]+/.exec(text)?.[0] || "";
    return { name: address ? text.replace(address, "").replace(/[<>\"]/g, "").trim() : "", address: address.toLowerCase() };
}

function htmlToText(value) {
    return String(value || "").replace(/<\s*(?:script|style)[^>]*>[\s\S]*?<\s*\/\s*(?:script|style)\s*>/gi, " ").replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\s*\/\s*(?:p|div|li|tr|h[1-6])\s*>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").trim();
}

function parseRetryAfter(value) {
    const text = String(value || "").trim();
    if (!text) return 0;
    if (/^\d+$/.test(text)) return Math.max(1, Math.min(3600, Number(text)));
    const date = Date.parse(text);
    return Number.isFinite(date) && date > Date.now() ? Math.max(1, Math.min(3600, Math.ceil((date - Date.now()) / 1000))) : 0;
}

function gmailError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}
