const target = new URL(process.env.LOAD_TEST_URL || "http://127.0.0.1:3000/healthz");
const requests = positive(process.env.LOAD_TEST_REQUESTS, 100, 10_000);
const concurrency = positive(process.env.LOAD_TEST_CONCURRENCY, 10, 100);
const timeoutMs = positive(process.env.LOAD_TEST_TIMEOUT_MS, 5_000, 60_000);
const maximumP95 = positive(process.env.LOAD_TEST_MAX_P95_MS, 1_000, 60_000);

if (!["127.0.0.1", "localhost", "::1"].includes(target.hostname) && process.env.LOAD_TEST_ALLOW_REMOTE !== "true") {
    throw new Error("Le test de charge distant est refusé. Définissez LOAD_TEST_ALLOW_REMOTE=true après autorisation de la cible.");
}

const latencies = [];
let cursor = 0;
let failures = 0;
const started = performance.now();
await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, async () => {
    while (cursor < requests) {
        cursor += 1;
        const requestStarted = performance.now();
        try {
            const response = await fetch(target, { signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": "DepannHomePro-Authorized-Load-Test/1.0" } });
            if (!response.ok && response.status !== 503) failures += 1;
            await response.arrayBuffer();
        } catch { failures += 1; }
        latencies.push(performance.now() - requestStarted);
    }
}));
latencies.sort((a, b) => a - b);
const percentile = value => latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * value) - 1)] || 0;
const report = { target: target.origin + target.pathname, requests, concurrency, failures, durationMs: Math.round(performance.now() - started), p50Ms: Math.round(percentile(0.5)), p95Ms: Math.round(percentile(0.95)), p99Ms: Math.round(percentile(0.99)) };
console.log(JSON.stringify(report, null, 2));
if (failures || report.p95Ms > maximumP95) process.exitCode = 1;

function positive(value, fallback, maximum) { const number = Number(value || fallback); return Number.isSafeInteger(number) && number > 0 && number <= maximum ? number : fallback; }
