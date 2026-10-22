import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migration = read("database/migrations/0040_client_sticky_notes.sql");
const schema = read("database/schema.sql");
const server = read("server/clients.js");
const client = read("js/clients.js");
const style = read("css/style.css");

test("les post-it sont persistants, isolés par entreprise et rattachés au dossier", () => {
    for (const source of [migration, schema]) {
        assert.match(source, /CREATE TABLE IF NOT EXISTS depannhome_client_sticky_notes/);
        assert.match(source, /CHECK\(color IN \('yellow','red'\)\)/);
        assert.match(source, /CHECK\(CHAR_LENGTH\(BTRIM\(body\)\) BETWEEN 1 AND 1000\)/);
        assert.match(source, /FOREIGN KEY\(owner_id,client_id\)[\s\S]*REFERENCES depannhome_clients\(owner_id,client_id\)[\s\S]*ON DELETE CASCADE/);
    }
});

test("l’API réserve toutes les opérations aux postes PC et filtre par propriétaire", () => {
    const assignmentMiddleware = server.indexOf('app.use("/api/clients/:clientId", asyncHandler(requireAssignedMobileClientAccess))');
    const pcMiddleware = server.indexOf('app.use("/api/clients/:clientId/sticky-notes", requireAuthentication, requireClientStickyNotePcAccess)');
    const stickyRoutes = server.indexOf('app.get("/api/clients/:clientId/sticky-notes"');
    assert.ok(assignmentMiddleware >= 0 && assignmentMiddleware < pcMiddleware && pcMiddleware < stickyRoutes);
    assert.match(server, /function requireClientStickyNotePcAccess[\s\S]*request\.user\?\.deviceType === "desktop"[\s\S]*status\(403\)[\s\S]*réservés aux postes PC/);
    assert.match(server, /WHERE owner_id=\$1 AND client_id=\$2/);
    assert.match(server, /WHERE owner_id=\$1 AND client_id=\$2 AND client_status='active'/);
    assert.match(server, /WHERE id=\$1 AND owner_id=\$2 AND client_id=\$3/);
    assert.match(server, /body\.length > 1000/);
    assert.match(server, /new Set\(\["yellow", "red"\]\)\.has\(color\)/);
});

test("la fiche client crée des post-it jaunes ou rouges et ne les retire que manuellement", () => {
    assert.match(client, /function renderClientStickyNotesSection[\s\S]*document\.body\.dataset\.deviceType !== "desktop"[\s\S]*return ""/);
    assert.match(client, /Post-it à réaliser/);
    assert.match(client, /value="yellow" checked/);
    assert.match(client, /value="red"/);
    assert.match(client, /Tâche réalisée · supprimer/);
    assert.match(client, /method: "DELETE"/);
    assert.match(client, /Cette tâche est-elle réalisée \? Le post-it sera supprimé définitivement\./);
    assert.match(client, /escapeHtml\(note\.body\)/);
    assert.doesNotMatch(server, /expires_at[\s\S]{0,200}depannhome_client_sticky_notes|DELETE FROM depannhome_client_sticky_notes[\s\S]{0,200}(?:interval|created_at\s*[<>])/i);
});

test("les cartes jaunes et rouges restent lisibles sur un écran PC étroit et en thème sombre", () => {
    assert.match(style, /\.client-sticky-note-yellow\{[^}]*background:#fef3c7/);
    assert.match(style, /\.client-sticky-note-red\{[^}]*background:#fee2e2/);
    assert.match(style, /@media\(max-width:760px\)[\s\S]*\.client-sticky-note-list\{grid-template-columns:1fr/);
    assert.match(style, /dark-theme \.client-sticky-note-yellow/);
    assert.match(style, /dark-theme \.client-sticky-note-red/);
});
