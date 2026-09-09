import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const calendar = readFileSync(new URL("../js/calendar.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../css/style.css", import.meta.url), "utf8");

test("les cartes du planning affichent la plage horaire puis le client et son adresse", () => {
    const card = calendar.slice(calendar.indexOf("function renderCalendarEventCard"), calendar.indexOf("function getEventClientDetails"));
    assert.match(card, /calendar-event-time/);
    assert.match(card, /formatEventTime\(event\)/);
    assert.match(card, /calendar-event-client/);
    assert.match(card, /calendar-event-address/);
    assert.ok(card.indexOf("calendar-event-time") < card.indexOf("calendar-event-client"));
    assert.ok(card.indexOf("calendar-event-client") < card.indexOf("calendar-event-address"));
});

test("les interventions distinguent les techniciens par des badges de prénom sans détourner les couleurs de statut", () => {
    const card = calendar.slice(calendar.indexOf("function renderCalendarEventCard"), calendar.indexOf("function getEventClientDetails"));
    assert.match(calendar, /function firstNameFromFullName\(value\)/);
    assert.match(calendar, /function renderTechnicianBadges\(event\)/);
    assert.match(card, /renderTechnicianBadges\(event\)/);
    assert.match(styles, /\.calendar-technician-name\{/);
    assert.match(styles, /body\.mobile-device \.calendar-grid \.calendar-event-technicians\{display:flex/);
    assert.doesNotMatch(styles, /calendar-technician-name[^}]*background:(?:red|green|orange)/);
});

test("les horaires incomplets restent explicites", () => {
    const formatter = calendar.slice(calendar.indexOf("function formatEventTime"), calendar.indexOf("function formatPreviewDate"));
    assert.match(formatter, /`\$\{event\.startTime\} – \$\{event\.endTime\}`/);
    assert.match(formatter, /`Dès \$\{event\.startTime\}`/);
    assert.match(formatter, /`Jusqu’à \$\{event\.endTime\}`/);
    assert.match(formatter, /"Toute la journée"/);
});

test("le mois et la semaine rendent toutes les interventions sélectionnées", () => {
    const rendering = calendar.slice(calendar.indexOf("function renderCalendarGrid"), calendar.indexOf("function getVisibleEvents"));
    assert.match(rendering, /dayEvents\.sort\(compareEventTimes\)/);
    assert.match(rendering, /dayEvents\.forEach\(event =>/);
    assert.match(rendering, /dayEvents\.map\(event =>/);
    assert.doesNotMatch(rendering, /getCalendarEventLimit|calendar-overflow-button|data-calendar-more-date/);
    assert.match(styles, /\.calendar-event-list\{[\s\S]*?overflow:auto;[\s\S]*?scrollbar-width:thin/);
});

test("le mois reste compact et les vues mobiles jour et semaine utilisent un agenda vertical", () => {
    assert.match(styles, /grid-auto-rows:190px/);
    assert.match(styles, /\.calendar-day\{[\s\S]*?height:190px;[\s\S]*?overflow:hidden/);
    assert.match(styles, /\.calendar-list-week \.calendar-list-day\{[\s\S]*?height:290px;[\s\S]*?overflow:hidden/);
    assert.match(styles, /body\.desktop-device \.calendar-grid-panel\{[\s\S]*?height:clamp\(430px,calc\(100dvh - 310px\),650px\)/);
    assert.match(styles, /body\.desktop-device \.calendar-grid\{[\s\S]*?height:calc\(100% - 31px\)/);
    assert.match(styles, /body\.desktop-device \.calendar-list-view\.calendar-list-week\{[\s\S]*?height:100%/);
    assert.match(styles, /body\.desktop-device \.calendar-list-week \.calendar-list-day\{[\s\S]*?height:100%/);
    assert.match(styles, /\.calendar-list-week\{[\s\S]*?grid-template-columns:repeat\(7/);
    assert.match(calendar, /classList\.contains\("mobile-device"\)\) return renderMobileCalendarAgenda\(panel\)/);
    assert.match(calendar, /classList\.contains\("desktop-device"\)\) return renderCalendarTimeline\(panel\)/);
    assert.match(calendar, /function renderMobileCalendarAgenda/);
    assert.match(calendar, /calendar-mobile-agenda-day/);
    assert.match(calendar, /calendar-mobile-agenda-event/);
    assert.match(calendar, /data-calendar-mobile-add/);
    assert.match(calendar, /role="status" aria-live="polite"/);
    assert.match(calendar, /dayEvents\.map\(event =>/);
    assert.match(styles, /body\.mobile-device \.calendar-weekdays,body\.mobile-device \.calendar-grid\{width:100%;min-width:0\}/);
    assert.match(styles, /body\.mobile-device \.calendar-mobile-agenda\{display:grid;gap:12px\}/);
    assert.match(styles, /body\.mobile-device \.calendar-mobile-agenda-day\{[^}]*border-radius:18px/);
    assert.match(styles, /body\.mobile-device \.calendar-mobile-agenda-event\{[^}]*min-height:72px/);
    assert.match(styles, /body\.mobile-device \.calendar-mobile-add\{[^}]*width:42px;height:42px/);
});

test("le planning mobile utilise des contrôles tactiles et des cartes plutôt qu'un tableau PC réduit", () => {
    assert.match(styles, /body\.mobile-device \.calendar-toolbar-actions\{display:grid;grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/);
    assert.match(styles, /body\.mobile-device \.calendar-toolbar-actions \[data-calendar-action="today"\]\{grid-column:span 4/);
    assert.match(styles, /body\.mobile-device \.calendar-view-switcher\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
    assert.match(styles, /body\.mobile-device \.calendar-day\{[^}]*border:0;border-radius:9px[^}]*box-shadow/);
    assert.match(styles, /body\.mobile-device \.calendar-mobile-agenda-summary\{[^}]*linear-gradient/);
    assert.match(styles, /body\.mobile-device \.calendar-mobile-agenda-event\{[^}]*grid-template-columns:70px minmax\(0,1fr\) 20px/);
    assert.match(styles, /body\.mobile-device \.calendar-mobile-agenda-event \.calendar-event-address\{display:block/);
    assert.match(styles, /body\.mobile-device \.calendar-grid \.calendar-event-time\{[^}]*font-size:9px/);
});

test("les vues mois, semaine et jour occupent tout le viewport mobile sans faire défiler la page", () => {
    assert.match(calendar, /classList\.add\("calendar-page-active"\)/);
    assert.match(calendar, /classList\.remove\("calendar-page-active"\)/);
    assert.match(styles, /body\.mobile-device\.calendar-page-active\{[^}]*height:100dvh;overflow:hidden/);
    assert.match(styles, /body\.mobile-device\.calendar-page-active #app\{[^}]*height:calc\(100dvh - 64px - env\(safe-area-inset-bottom\)\)[^}]*overflow:hidden/);
    assert.match(styles, /body\.mobile-device\.calendar-page-active #brands\{[^}]*grid-template-rows:auto minmax\(0,1fr\)[^}]*height:100%/);
    assert.match(styles, /body\.mobile-device\.calendar-page-active \.calendar-grid\{[^}]*grid-template-rows:repeat\(6,minmax\(0,1fr\)\)[^}]*height:calc\(100% - 24px\)/);
    assert.match(styles, /body\.mobile-device\.calendar-page-active \.calendar-grid-panel,body\.mobile-device\.calendar-page-active \.calendar-grid-panel:has\(\.calendar-mobile-agenda\)\{[^}]*height:100%[^}]*overflow-y:auto/);
    assert.match(styles, /body\.mobile-device\.calendar-page-active #brands>\.calendar-form-panel:not\(\[hidden\]\)\{[^}]*position:absolute[^}]*overflow:auto/);
});

test("les ressources PWA versionnées sont servies depuis le cache avant de solliciter le réseau", () => {
    const worker = readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");
    assert.match(worker, /url\.searchParams\.has\("v"\) \? cachedFallback\(\) : fetchAndCache\(\)\.catch\(cachedFallback\)/);
});

test("les définitions de couleurs et de statuts restent masquées sur tous les postes mobiles", () => {
    assert.match(calendar, /<div class="calendar-legend">/);
    assert.match(calendar, /<div class="calendar-status-legend"/);
    assert.match(styles, /body\.mobile-device \.calendar-legend,body\.mobile-device \.calendar-status-legend\{display:none\}/);
    assert.doesNotMatch(styles, /body\[data-role="mobile_admin"\]\.mobile-device \.calendar-(?:legend|status-legend)\{display:(?:flex|grid|block)/);
});

test("les vues jour et semaine PC utilisent une grille horaire de 8 h à 19 h", () => {
    assert.match(calendar, /PLANNING_DAY_START_HOUR = 8/);
    assert.match(calendar, /PLANNING_DAY_END_HOUR = 19/);
    assert.match(calendar, /PLANNING_SLOT_MINUTES = 15/);
    assert.match(calendar, /document\.body\.classList\.contains\("desktop-device"\)\) return renderCalendarTimeline\(panel\)/);
    assert.match(calendar, /function buildTimelineDayLayout/);
    assert.match(calendar, /function finalizeOverlapGroup|const finalizeOverlapGroup/);
    assert.match(calendar, /Sans horaire \/ hors plage/);
    assert.match(calendar, /const canCreate = canCreateCalendarEvents\(\)/);
    assert.match(calendar, /canCreate \? ` tabindex="0" role="button"/);
    assert.match(calendar, /if \(!canCreate\) return/);
    assert.match(calendar, /--event-start:/);
    assert.match(calendar, /--event-duration:/);
    assert.match(calendar, /startTime: minutesToCalendarTime\(startMinutes\)/);
    assert.match(styles, /body\.desktop-device \.calendar-timeline\{/);
    assert.match(styles, /grid-template-columns:52px repeat\(var\(--calendar-day-count\)/);
    assert.match(styles, /top:calc\(var\(--event-start\) \* 100%/);
});

test("les cartes compactes restent accessibles avec toutes les informations", () => {
    const rendering = calendar.slice(calendar.indexOf("function renderCalendarGrid"), calendar.indexOf("function getEventClientDetails"));
    assert.match(rendering, /calendarEventAccessibleLabel\(event, clientDetails, date\)/);
    assert.match(rendering, /calendarEventAccessibleLabel\(event, client, date\)/);
    assert.match(rendering, /closest\("\.calendar-event"\)/);
});

test("le filtre quitte Toute l’équipe sans perdre les autres techniciens cochés", () => {
    const header = calendar.slice(calendar.indexOf("function renderHeader"), calendar.indexOf("function refreshCalendarFilterView"));
    assert.match(header, /if \(showAllTechnicians\) visibleTechnicianIds = new Set\(members\.map/);
    assert.ok(header.indexOf("if (showAllTechnicians) visibleTechnicianIds") < header.indexOf("showAllTechnicians = false"));
});

test("le PC mémorise la vue mais revient toujours à la période actuelle après actualisation", () => {
    const rendering = calendar.slice(calendar.indexOf("export async function renderCalendar"), calendar.indexOf("export function renderCalendarOverview"));
    assert.match(rendering, /options\.currentPeriod && isDesktopCalendarDevice\(\)/);
    assert.match(rendering, /loadPreferredCalendarView\(\)/);
    assert.match(rendering, /firstDayOfMonth\(new Date\(\)\)/);
    assert.match(rendering, /invalidateCalendarEventsCache\(\)/);
    assert.match(calendar, /savePreferredCalendarView\(calendarView\)/);
    const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
    assert.match(navigation, /renderCalendar\(\{ currentPeriod: true \}\)/);
});

test("chaque vue du planning mobile repart de la date actuelle", () => {
    const switcher = calendar.slice(calendar.indexOf("function bindCalendarViewSwitcher"), calendar.indexOf("function bindCalendarNavigation"));
    assert.match(switcher, /const desktop = isDesktopCalendarDevice\(\)/);
    assert.match(switcher, /if \(nextView === calendarView && desktop\) return/);
    assert.match(switcher, /const anchorDate = desktop \? displayedMonth : new Date\(\)/);
    assert.match(switcher, /nextView === "month" \? firstDayOfMonth\(anchorDate\) : atNoon\(anchorDate\)/);
});
