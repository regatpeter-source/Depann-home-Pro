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

test("les horaires incomplets restent explicites", () => {
    const formatter = calendar.slice(calendar.indexOf("function formatEventTime"), calendar.indexOf("function formatPreviewDate"));
    assert.match(formatter, /`\$\{event\.startTime\} – \$\{event\.endTime\}`/);
    assert.match(formatter, /`Dès \$\{event\.startTime\}`/);
    assert.match(formatter, /`Jusqu’à \$\{event\.endTime\}`/);
    assert.match(formatter, /"Toute la journée"/);
});

test("le mois et la semaine limitent les cartes selon le poste sans perdre les interventions", () => {
    const rendering = calendar.slice(calendar.indexOf("function renderCalendarGrid"), calendar.indexOf("function getVisibleEvents"));
    const limits = calendar.slice(calendar.indexOf("function getCalendarEventLimit"), calendar.indexOf("function getEventClientDetails"));
    assert.match(rendering, /dayEvents\.sort\(compareEventTimes\)/);
    assert.match(rendering, /slice\(0, getCalendarEventLimit\("month"\)\)/);
    assert.match(rendering, /slice\(0, getCalendarEventLimit\(calendarView\)\)/);
    assert.match(rendering, /calendar-overflow-button/);
    assert.match(rendering, /data-calendar-more-date/);
    assert.match(limits, /view === "month" \? \(mobile \? 2 : 3\) : \(mobile \? 3 : 4\)/);
    assert.match(limits, /calendarView = "day"/);
    assert.match(limits, /refreshCalendarPeriod\(\)/);
});

test("le mois et la semaine mobiles affichent sept jours en largeur sans défilement horizontal", () => {
    assert.match(styles, /grid-auto-rows:190px/);
    assert.match(styles, /\.calendar-day\{[\s\S]*?height:190px;[\s\S]*?overflow:hidden/);
    assert.match(styles, /\.calendar-list-week \.calendar-list-day\{[\s\S]*?height:290px;[\s\S]*?overflow:hidden/);
    assert.match(styles, /body\.desktop-device \.calendar-grid-panel\{[\s\S]*?height:clamp\(430px,calc\(100dvh - 310px\),650px\)/);
    assert.match(styles, /body\.desktop-device \.calendar-grid\{[\s\S]*?height:calc\(100% - 31px\)/);
    assert.match(styles, /body\.desktop-device \.calendar-list-view\.calendar-list-week\{[\s\S]*?height:100%/);
    assert.match(styles, /body\.desktop-device \.calendar-list-week \.calendar-list-day\{[\s\S]*?height:100%/);
    assert.match(styles, /\.calendar-list-week\{[\s\S]*?grid-template-columns:repeat\(7/);
    assert.match(calendar, /classList\.contains\("desktop-device"\) \|\| document\.body\.classList\.contains\("mobile-device"\)/);
    assert.match(styles, /body\.mobile-device \.calendar-weekdays,body\.mobile-device \.calendar-grid\{width:100%;min-width:0\}/);
    assert.match(styles, /body\.mobile-device \.calendar-timeline\{[^}]*grid-template-rows:auto auto 660px[^}]*width:100%;min-width:0/);
    assert.match(styles, /grid-template-columns:40px repeat\(var\(--calendar-day-count\),minmax\(0,1fr\)\)/);
    assert.match(styles, /body\.mobile-device \.calendar-grid-panel:has\(\.calendar-timeline\)\{[^}]*overflow-x:hidden;overflow-y:auto/);
    assert.doesNotMatch(styles, /body\.mobile-device \.calendar-timeline\{[^}]*min-width:760px/);
});

test("le planning mobile utilise des contrôles tactiles et des cartes plutôt qu'un tableau PC réduit", () => {
    assert.match(styles, /body\.mobile-device \.calendar-toolbar-actions\{display:grid;grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/);
    assert.match(styles, /body\.mobile-device \.calendar-toolbar-actions \[data-calendar-action="today"\]\{grid-column:span 4/);
    assert.match(styles, /body\.mobile-device \.calendar-view-switcher\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
    assert.match(styles, /body\.mobile-device \.calendar-day\{[^}]*border:0;border-radius:9px[^}]*box-shadow/);
    assert.match(styles, /body\.mobile-device \.calendar-timeline-header\{position:sticky;top:0/);
    assert.match(styles, /body\.mobile-device \.calendar-timeline-event\{[^}]*height:max\(32px[^}]*border-radius:7px[^}]*box-shadow/);
    assert.match(styles, /body\.mobile-device \.calendar-grid \.calendar-event-time\{[^}]*font-size:9px/);
});

test("les définitions de couleurs et de statuts restent masquées sur tous les postes mobiles", () => {
    assert.match(calendar, /<div class="calendar-legend">/);
    assert.match(calendar, /<div class="calendar-status-legend"/);
    assert.match(styles, /body\.mobile-device \.calendar-legend,body\.mobile-device \.calendar-status-legend\{display:none\}/);
    assert.doesNotMatch(styles, /body\[data-role="mobile_admin"\]\.mobile-device \.calendar-(?:legend|status-legend)\{display:(?:flex|grid|block)/);
});

test("les vues jour et semaine PC et mobile utilisent une grille horaire de 8 h à 19 h", () => {
    assert.match(calendar, /PLANNING_DAY_START_HOUR = 8/);
    assert.match(calendar, /PLANNING_DAY_END_HOUR = 19/);
    assert.match(calendar, /PLANNING_SLOT_MINUTES = 15/);
    assert.match(calendar, /document\.body\.classList\.contains\("desktop-device"\) \|\| document\.body\.classList\.contains\("mobile-device"\)\) return renderCalendarTimeline\(panel\)/);
    assert.match(calendar, /function buildTimelineDayLayout/);
    assert.match(calendar, /function finalizeOverlapGroup|const finalizeOverlapGroup/);
    assert.match(calendar, /Sans horaire \/ hors plage/);
    assert.match(calendar, /const canCreate = !isReadOnlyCalendar\(\)/);
    assert.match(calendar, /canCreate \? ` tabindex="0" role="button"/);
    assert.match(calendar, /if \(!canCreate\) return/);
    assert.match(calendar, /--event-start:/);
    assert.match(calendar, /--event-duration:/);
    assert.match(calendar, /startTime: minutesToCalendarTime\(startMinutes\)/);
    assert.match(styles, /body\.desktop-device \.calendar-timeline\{/);
    assert.match(styles, /grid-template-columns:52px repeat\(var\(--calendar-day-count\)/);
    assert.match(styles, /top:calc\(var\(--event-start\) \* 100%/);
    assert.match(styles, /body\.mobile-device \.calendar-time-axis\{[^}]*position:sticky/);
    assert.match(styles, /body\.mobile-device \.calendar-timeline-day \.calendar-event-time\{display:block/);
});

test("les cartes compactes restent accessibles avec toutes les informations", () => {
    const rendering = calendar.slice(calendar.indexOf("function renderCalendarGrid"), calendar.indexOf("function getEventClientDetails"));
    assert.match(rendering, /calendarEventAccessibleLabel\(event, clientDetails, date\)/);
    assert.match(rendering, /calendarEventAccessibleLabel\(event, client, date\)/);
    assert.match(rendering, /Afficher \$\{hiddenCount\} autre/);
    assert.match(rendering, /closest\("\.calendar-event, \.calendar-overflow-button"\)/);
});
