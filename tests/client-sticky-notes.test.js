import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migration = read("database/migrations/0040_client_sticky_notes.sql");
const schema = read("database/schema.sql");
const server = read("server/clients.js");
const client = read("js/clients.js");
const navigation = read("js/navigation.js");
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
    assert.match(client, /data-sticky-note-toggle aria-expanded="false"/);
    assert.match(client, /data-sticky-note-composer hidden/);
    assert.match(client, /Texte du post-it[\s\S]*Couleur/);
    assert.match(client, /value="yellow" checked/);
    assert.match(client, /value="red"/);
    assert.match(client, /Tâche réalisée · supprimer/);
    assert.match(client, /method: "DELETE"/);
    assert.match(client, /Cette tâche est-elle réalisée \? Le post-it sera supprimé définitivement\./);
    assert.match(client, /escapeHtml\(note\.body\)/);
    assert.match(client, /composer\.hidden = !opening/);
    assert.match(client, /form\.reset\(\);[\s\S]*closeComposer\(\)/);
    assert.match(client, /method: "POST",[\s\S]*keepalive: true/);
    assert.match(client, /credentials: "same-origin", cache: "no-store"/);
    assert.match(server, /response\.set\("Cache-Control", "private, no-store"\)\.status\(201\)/);
    assert.match(server, /response\.set\("Cache-Control", "private, no-store"\)\.json\(\{ stickyNotes: rows \}\)/);
    assert.doesNotMatch(server, /expires_at[\s\S]{0,200}depannhome_client_sticky_notes|DELETE FROM depannhome_client_sticky_notes[\s\S]{0,200}(?:interval|created_at\s*[<>])/i);
});

test("les cartes jaunes et rouges restent lisibles sur un écran PC étroit et en thème sombre", () => {
    assert.match(style, /\.client-sticky-note-yellow\{[^}]*background:#fef3c7/);
    assert.match(style, /\.client-sticky-note-red\{[^}]*background:#fee2e2/);
    assert.match(style, /\.client-sticky-note-list\{[^}]*grid-template-columns:repeat\(auto-fill,240px\)[^}]*justify-content:start/);
    assert.match(style, /\.client-sticky-note\{[^}]*width:240px[^}]*aspect-ratio:1/);
    assert.match(style, /\.client-sticky-note > p\{[^}]*overflow:auto/);
    assert.match(style, /@media\(max-width:760px\)[\s\S]*\.client-sticky-note-list\{grid-template-columns:minmax\(0,240px\)/);
    assert.match(style, /dark-theme \.client-sticky-note-yellow/);
    assert.match(style, /dark-theme \.client-sticky-note-red/);
    assert.match(style, /\.client-sticky-note-composer\{[^}]*position:absolute[^}]*box-shadow/);
});

test("la synthèse PC du tableau de bord est isolée par entreprise et ouvre le dossier client", () => {
    const globalRoute = server.indexOf('app.get("/api/clients/sticky-notes"');
    const clientParameterMiddleware = server.indexOf('app.use("/api/clients/:clientId"');
    assert.ok(globalRoute >= 0 && globalRoute < clientParameterMiddleware);
    assert.match(server, /app\.get\("\/api\/clients\/sticky-notes", requireAuthentication, requireClientStickyNotePcAccess/);
    assert.match(server, /JOIN depannhome_clients client ON client\.owner_id=note\.owner_id AND client\.client_id=note\.client_id/);
    assert.match(server, /WHERE note\.owner_id=\$1[\s\S]*ORDER BY CASE note\.color WHEN 'red' THEN 0 ELSE 1 END/);
    assert.match(navigation, /desktopDashboard \? renderDashboardStickyNotes\(\) : ""/);
    assert.match(navigation, /if \(!section \|\| !list \|\| !counter \|\| !isDesktopDevice\(\)\) return/);
    assert.match(navigation, /loadDashboardJson\("\/api\/clients\/sticky-notes"\)/);
    assert.match(navigation, /data-dashboard-sticky-client[\s\S]*openClients\(button\.dataset\.dashboardStickyClient\)/);
    assert.match(style, /\.dashboard-sticky-note-red\{[^}]*background:#fee2e2/);
    assert.match(style, /dark-theme \.dashboard-sticky-note-red/);
});

test("plusieurs post-it du tableau de bord forment une pile papier déroulable", () => {
    assert.match(navigation, /function dashboardStickyNoteHtml\(note, preview = false\)/);
    assert.match(navigation, /notes\.length === 1[\s\S]*dashboardStickyNoteHtml\(notes\[0\]\)[\s\S]*<details class="dashboard-sticky-note-stack">/);
    assert.match(navigation, /<summary aria-label="Dérouler les \$\{notes\.length\} post-it">/);
    assert.match(navigation, /dashboard-sticky-note-expanded[\s\S]*notes\.map\(note => dashboardStickyNoteHtml\(note\)\)/);
    assert.match(style, /\.dashboard-sticky-note::before\{[^}]*background:rgba\(255,255,255,\.58\)/);
    assert.match(style, /\.dashboard-sticky-note::after\{[^}]*border-width:0 0 24px 24px/);
    assert.match(style, /\.dashboard-sticky-note-stack>summary::before,\.dashboard-sticky-note-stack>summary::after/);
    assert.match(style, /\.dashboard-sticky-note-stack\[open\] \.dashboard-sticky-note-toggle>span:last-child\{display:inline/);
});
