import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("tous les imports statiques de la navigation pointent vers un module existant", () => {
    const sourceUrl = new URL("../js/navigation.js", import.meta.url);
    const source = readFileSync(sourceUrl, "utf8");
    const imports = [...source.matchAll(/from\s+["'](\.[^"']+)["']/g)].map(match => match[1]);
    assert.ok(imports.length > 0);
    for (const specifier of imports) {
        const moduleUrl = new URL(specifier.split("?")[0], sourceUrl);
        assert.equal(existsSync(fileURLToPath(moduleUrl)), true, `Module navigateur introuvable : ${specifier}`);
    }
});