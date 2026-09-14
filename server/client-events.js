const streamsByOwner = new Map();
const HEARTBEAT_INTERVAL = 30_000;

export function openClientEventStream(request, response, ownerId) {
    const key = String(ownerId || "");
    if (!key) return response.status(401).end();

    response.status(200);
    response.set({
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
    });
    response.flushHeaders?.();
    response.write("retry: 5000\n");
    response.write("event: ready\ndata: {}\n\n");

    const streams = streamsByOwner.get(key) || new Set();
    streams.add(response);
    streamsByOwner.set(key, streams);

    const heartbeat = setInterval(() => {
        if (!safeWrite(response, ": heartbeat\n\n")) close();
    }, HEARTBEAT_INTERVAL);
    heartbeat.unref?.();

    const close = () => {
        clearInterval(heartbeat);
        streams.delete(response);
        if (!streams.size) streamsByOwner.delete(key);
    };
    request.once("close", close);
    response.once("close", close);
    return undefined;
}

export function publishClientChange(ownerId, clientId, action = "updated") {
    const streams = streamsByOwner.get(String(ownerId || ""));
    if (!streams?.size) return 0;
    const payload = JSON.stringify({ clientId: String(clientId || ""), action, occurredAt: new Date().toISOString() });
    let delivered = 0;
    streams.forEach(response => {
        if (!safeWrite(response, `event: client-changed\ndata: ${payload}\n\n`)) {
            streams.delete(response);
            return;
        }
        delivered += 1;
    });
    if (!streams.size) streamsByOwner.delete(String(ownerId || ""));
    return delivered;
}

function safeWrite(response, content) {
    if (response.writableEnded || response.destroyed) return false;
    try {
        response.write(content);
        return true;
    } catch {
        return false;
    }
}
