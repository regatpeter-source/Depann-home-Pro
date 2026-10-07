import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canOpenOperationsMap, canShareLocation, canViewTeamLocations } from "../server/operations-map.js";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const server = read("server/operations-map.js");
const client = read("js/operations-map.js");
const calendar = read("js/calendar.js");
const styles = read("css/style.css");
const navigation = read("js/navigation.js");
const application = read("js/app.js");
const config = read("js/config.js");
const schema = read("database/schema.sql");
const migration = read("database/migrations/0035_operations_map.sql");
const privacy = read("public/privacy.html");
const architecture = read("docs/ARCHITECTURE.md");
const worker = read("service-worker.js");

const user = (role, deviceType = "desktop") => ({ role, deviceType });

test("la carte d’équipe et le partage de position ont des droits distincts", () => {
    assert.equal(canViewTeamLocations(user("admin")), true);
    assert.equal(canViewTeamLocations(user("pc_standard")), true);
    assert.equal(canViewTeamLocations(user("commercial")), true);
    assert.equal(canViewTeamLocations(user("commercial", "mobile")), false);
    assert.equal(canViewTeamLocations(user("team_lead", "mobile")), true);
    assert.equal(canViewTeamLocations(user("technician", "mobile")), false);
    assert.equal(canShareLocation(user("technician", "mobile")), true);
    assert.equal(canShareLocation(user("team_lead", "mobile")), true);
    assert.equal(canShareLocation(user("mobile_admin", "mobile")), true);
    assert.equal(canShareLocation(user("technician")), false);
    assert.equal(canOpenOperationsMap(user("technician", "mobile")), true);
    assert.equal(canOpenOperationsMap(user("accountant")), false);
});

test("le serveur ne conserve que la dernière position et permet son retrait immédiat", () => {
    assert.match(schema, /CREATE TABLE IF NOT EXISTS depannhome_technician_locations/);
    assert.match(migration, /PRIMARY KEY\(owner_id,user_id\)/);
    assert.match(server, /ON CONFLICT\(owner_id,user_id\) DO UPDATE SET latitude/);
    assert.match(server, /DELETE FROM depannhome_technician_locations WHERE owner_id=\$1 AND user_id=\$2/);
    assert.match(server, /POSITION_RETENTION_HOURS = 12/);
    assert.match(server, /LIVE_POSITION_MINUTES = 2/);
    assert.match(server, /LEFT JOIN depannhome_technician_locations[\s\S]*location\.updated_at >= NOW\(\) - \(\$5::text/);
    assert.doesNotMatch(`${schema}\n${migration}`, /location_history|technician_routes|location_tracks/);
});

test("les interventions du jour sont ordonnées, numérotées et isolées par entreprise", () => {
    assert.match(server, /WHERE event\.owner_id=\$1 AND event\.event_date=\$2::date/);
    assert.match(server, /ORDER BY event\.start_time NULLS LAST,event\.created_at,event\.id/);
    assert.match(server, /dayNumber: index \+ 1/);
    assert.match(server, /location\.owner_id=\$1/);
    assert.match(client, /Intervention n°\$\{event\.dayNumber\}/);
    assert.match(client, /data-map-event/);
    assert.match(client, /depannhome:open-map-intervention/);
});

test("l’interface filtre les techniciens et distingue direct et dernière position", () => {
    assert.match(config, /operationsMap: "operations-map"/);
    assert.match(navigation, /operationsMapBtn/);
    assert.match(navigation, /renderOperationsMap/);
    assert.match(client, /Techniciens visibles/);
    assert.match(client, /technician\.isLive \? "En direct"/);
    assert.match(client, /selectedTechnicianIds/);
    assert.match(client, /data-map-team/);
    assert.match(client, /eventsForMapSelection/);
    assert.match(server, /FROM depannhome_teams team/);
    assert.match(server, /teams: teamsResult\.rows/);
    assert.match(client, /15_000/);
});

test("un technicien mobile ne reçoit que sa propre position et ses interventions", () => {
    assert.match(server, /const ownOnly = !canViewTeamLocations\(request\.user\)/);
    assert.match(server, /event\.assigned_technician_id=\$4::bigint/);
    assert.match(server, /assignment\.technician_id=\$4::bigint/);
    assert.match(server, /member\.id=\$4::bigint/);
    assert.match(server, /const teamsResult = ownOnly \? \{ rows: \[\] \}/);
});

test("la planification affiche une carte limitée à l’adresse et aux membres affectés", () => {
    assert.match(server, /cardinality\(\$5::bigint\[\]\)=0/);
    assert.match(server, /selected_assignment\.technician_id=ANY\(\$5::bigint\[\]\)/);
    assert.match(server, /targetAddress = cleanAddress\(request\.query\?\.address\)/);
    assert.match(server, /member\.id=ANY\(\$6::bigint\[\]\)/);
    assert.match(calendar, /id="calendarPlanningMap"/);
    assert.match(calendar, /renderPlanningOperationsMap\(planningMap/);
    assert.match(calendar, /technicianIds: candidate\.assignedTechnicianIds/);
    assert.match(client, /technicianIds: technicianIds\.join\(","\)/);
    assert.match(client, /seuls leurs rendez-vous et positions sont affichés/);
    assert.match(client, /Number\.POSITIVE_INFINITY/);
    assert.match(server, /data\.geopf\.fr\/geocodage/);
    assert.match(server, /provider: "geoplateforme"/);
    assert.match(client, /Adresse d’intervention non localisée/);
    assert.match(client, /Adresse non localisée/);
    assert.match(client, /<em>Intervention<\/em>/);
    assert.match(server, /data\.geopf\.fr\/navigation/);
    assert.match(server, /profile: "car"/);
    assert.match(server, /travelDurationSeconds/);
    assert.match(server, /ROUTE_CACHE_TTL_MS = 10 \* 60 \* 1000/);
    assert.match(server, /MAX_ROUTES_PER_REQUEST = 12/);
    assert.match(client, /formatTravelDuration/);
    assert.match(client, /en voiture/);
    assert.match(client, /trajet indisponible/);
});

test("une intervention urgente utilise la journée courante sur la carte", () => {
    assert.match(calendar, /const urgent = candidate\.color === "red"/);
    assert.match(calendar, /date: urgent \? toDateString\(new Date\(\)\) : candidate\.date/);
    assert.match(client, /Urgence · aujourd’hui/);
});

test("les surfaces client et planning visibles sont couvertes par le thème sombre", () => {
    assert.match(styles, /dark-theme :is\([\s\S]*\.client-intervention-photo/);
    assert.match(styles, /\.client-intervention-history>summary/);
    assert.match(styles, /\.calendar-multi-date-planning/);
    assert.match(styles, /\.calendar-availability/);
    assert.match(styles, /\.message-bubble\.outgoing/);
    assert.match(styles, /\.procedure-meta span/);
    assert.match(styles, /dark-theme \.client-search-results-summary/);
    assert.match(styles, /\.client-results-group-heading/);
    assert.match(styles, /\.client-table th/);
});

test("le partage mobile est volontaire, visible et arrêtable", () => {
    assert.match(client, /navigator\.geolocation\.watchPosition/);
    assert.match(client, /window\.confirm\("Partager votre position pendant le service/);
    assert.match(client, /consent: true/);
    assert.match(client, /data-location-toggle/);
    assert.match(navigation, /data-terrain-location-host/);
    assert.match(navigation, /initializeTerrainLocationSharing\(document\.querySelector\("\[data-terrain-location-host\]"\)\)/);
    assert.match(client, /locationHost\.appendChild\(container\)/);
    assert.doesNotMatch(client, /document\.body\.appendChild\(container\)/);
    assert.doesNotMatch(styles, /\.terrain-location-control\{position:fixed/);
    assert.match(client, /method: "DELETE"/);
    assert.match(application, /await stopTerrainLocationSharing\(\);\s*const result = await signOut\(\)/);
    assert.match(client, /Le partage fonctionne lorsque l’application est ouverte/);
});

test("les limites PWA, la rétention et les fournisseurs cartographiques sont documentés et mis en cache", () => {
    assert.match(privacy, /Seule sa dernière position est conservée/);
    assert.match(privacy, /au maximum douze heures/);
    assert.match(privacy, /OpenFreeMap à partir des données OpenStreetMap/);
    assert.match(client, /tiles\.openfreemap\.org\/styles\/\$\{/);
    assert.match(client, /dark-theme[\s\S]*"dark" : "liberty"/);
    assert.doesNotMatch(client, /tile\.openstreetmap\.org|basemaps\.cartocdn\.com|api[_-]?key/i);
    assert.match(architecture, /ne prétend pas assurer un suivi lorsque le navigateur suspend l’application/);
    assert.match(architecture, /service Android au premier plan/);
    assert.match(worker, /operations-map\.js\?v=9/);
    assert.match(worker, /maplibre-gl\.mjs\?v=6\.11\.2/);
    assert.match(worker, /maplibre-gl-worker\.mjs/);
});
