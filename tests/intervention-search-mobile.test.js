import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const moduleSource = readFileSync(new URL("../js/intervention-search.js", import.meta.url), "utf8");
const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const calendarServer = readFileSync(new URL("../server/calendar.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../css/style.css", import.meta.url), "utf8");
const serviceWorker = readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");

test("la recherche mobile d’intervention possède un écran dédié inspiré du répertoire clients", () => {
    assert.match(moduleSource, /export function renderInterventionSearch/);
    assert.match(moduleSource, /data-intervention-search-form/);
    assert.match(moduleSource, /name="query"/);
    assert.match(moduleSource, /name="status"/);
    assert.match(moduleSource, /name="startDate"/);
    assert.match(moduleSource, /name="endDate"/);
    assert.match(moduleSource, /data-clear-interventions/);
    assert.match(moduleSource, /data-refresh-interventions/);
    assert.match(moduleSource, /paginateItems\(orderedEvents, paginationState\)/);
    assert.match(moduleSource, /renderBusinessPagination/);
});

test("les résultats ouvrent directement la fiche planning de l’intervention", () => {
    assert.match(moduleSource, /data-open-intervention/);
    assert.match(moduleSource, /openIntervention\?\.\(event\)/);
    assert.match(navigation, /openEvent: event => renderCalendar\(\{ date: new Date\(`\$\{event\.date\}T12:00:00`\), event \}\)/);
});

test("la recherche conserve le filtrage serveur du locataire et des affectations", () => {
    assert.match(moduleSource, /\/api\/calendar\/events\?start=/);
    assert.match(moduleSource, /credentials: "same-origin"/);
    assert.match(moduleSource, /event\.eventType === "appointment"/);
    assert.match(calendarServer, /WHERE event\.owner_id = \$1/);
    assert.match(calendarServer, /hasAssignedOnlyCalendar\(request\.user\)/);
});

test("les résultats d’intervention restent lisibles sous forme de cartes sur mobile", () => {
    assert.match(moduleSource, /client-table intervention-search-table/);
    assert.match(styles, /\.intervention-search-heading/);
    assert.match(styles, /\.intervention-search-summary/);
    assert.match(styles, /\.intervention-search-status/);
    assert.match(styles, /\.client-table thead\{\s*display:none/);
});

test("le nouveau module est préchargé par la PWA", () => {
    assert.match(serviceWorker, /js\/intervention-search\.js\?v=1/);
    assert.match(serviceWorker, /depann-home-pro-v527/);
});
