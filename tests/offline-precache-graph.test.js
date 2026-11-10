import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("le cache hors ligne contient les versions exactes des modules accessibles depuis l’application", () => {
    const root = new URL("../", import.meta.url);
    const worker = readFileSync(new URL("service-worker.js", root), "utf8");
    const index = readFileSync(new URL("index.html", root), "utf8");
    const assets = new Set([...worker.matchAll(/"\.\/([^"\n]+)"/g)].map(match => new URL(match[1], root).href));
    const script = index.match(/<script\s+type="module"\s+src="([^"]+)"/)?.[1];
    const stylesheet = index.match(/<link\s+rel="stylesheet"\s+href="(css\/style\.css\?[^"]+)"/)?.[1];
    assert.ok(script);
    assert.ok(stylesheet);
    assert.ok(assets.has(new URL(stylesheet, root).href), `Feuille de style absente du cache : ${stylesheet}`);
    const queue = [new URL(script, root)];
    const seen = new Set();
    const missing = [];
    while (queue.length) {
        const url = queue.shift();
        if (seen.has(url.href)) continue;
        seen.add(url.href);
        if (!assets.has(url.href)) missing.push(url.href.replace(root.href, ""));
        const source = readFileSync(fileURLToPath(url), "utf8");
        for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g)) {
            if (!match[1].startsWith(".")) continue;
            const dependency = new URL(match[1], url);
            if (/\.(?:m?js)$/.test(dependency.pathname)) queue.push(dependency);
        }
    }
    assert.deepEqual(missing, [], `Modules absents du cache : ${missing.join(", ")}`);
    const businessSuiteModules = [...seen].filter(url => new URL(url).pathname.endsWith("/js/business-suite.js"));
    assert.deepEqual(businessSuiteModules, [new URL("js/business-suite.js?v=10", root).href]);
    const clientsModules = [...seen].filter(url => new URL(url).pathname.endsWith("/js/clients.js"));
    assert.deepEqual(clientsModules, [new URL("js/clients.js?v=188", root).href]);
    const workspaceModules = [...seen].filter(url => new URL(url).pathname.endsWith("/js/desktop-workspace.js"));
    assert.deepEqual(workspaceModules, [new URL("js/desktop-workspace.js?v=6", root).href]);
});
