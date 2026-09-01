import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const clients = readFileSync(new URL("../js/clients.js", import.meta.url), "utf8");

test("le poste PC sépare le répertoire, la création et le dossier client", () => {
    assert.match(clients, /isDesktopClientWorkspace\(\)/);
    assert.match(clients, /activeWorkspace = selectedClient \? "detail" : editingClient \|\| viewOptions\.clientWorkspace === "create" \? "create" : "directory"/);
    assert.match(clients, /renderClientWorkspaceTabs\(activeWorkspace, readOnly, selectedClient \|\| editingClient\)/);
    assert.match(clients, /Répertoire clients/);
    assert.match(clients, /Nouveau client/);
    assert.match(clients, /Dossier client/);
});

test("le parcours mobile historique reste rendu sans onglets", () => {
    const desktopBranchEnd = clients.indexOf("container.appendChild(renderClientToolbar", clients.indexOf("if (isDesktopClientWorkspace())"));
    assert.ok(desktopBranchEnd > 0);
    assert.match(clients.slice(desktopBranchEnd), /container\.appendChild\(renderClientToolbar/);
    assert.match(clients.slice(desktopBranchEnd), /container\.appendChild\(renderClientForm/);
});