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

test("le mois et la semaine partagent le même espace PC et gardent un rendu mobile dédié", () => {
    assert.match(styles, /grid-auto-rows:190px/);
    assert.match(styles, /\.calendar-day\{[\s\S]*?height:190px;[\s\S]*?overflow:hidden/);
    assert.match(styles, /\.calendar-list-week \.calendar-list-day\{[\s\S]*?height:290px;[\s\S]*?overflow:hidden/);
    assert.match(styles, /body\.desktop-device \.calendar-grid-panel\{[\s\S]*?height:clamp\(430px,calc\(100dvh - 310px\),650px\)/);
    assert.match(styles, /body\.desktop-device \.calendar-grid\{[\s\S]*?height:calc\(100% - 31px\)/);
    assert.match(styles, /body\.desktop-device \.calendar-list-view\.calendar-list-week\{[\s\S]*?height:100%/);
    assert.match(styles, /body\.desktop-device \.calendar-list-week \.calendar-list-day\{[\s\S]*?height:100%/);
    assert.match(styles, /\.calendar-list-week\{[\s\S]*?grid-template-columns:repeat\(7/);
    assert.match(styles, /min-width:700px/);
    assert.match(styles, /\.calendar-list-week\{\s*grid-template-columns:1fr/);
    assert.match(styles, /height:250px/);
});

test("les vues jour et semaine PC utilisent une grille horaire de 8 h à 19 h", () => {
    assert.match(calendar, /PLANNING_DAY_START_HOUR = 8/);
    assert.match(calendar, /PLANNING_DAY_END_HOUR = 19/);
    assert.match(calendar, /PLANNING_SLOT_MINUTES = 15/);
    assert.match(calendar, /document\.body\.classList\.contains\("desktop-device"\)\) return renderCalendarTimeline\(panel\)/);
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
});

test("les cartes compactes restent accessibles avec toutes les informations", () => {
    const rendering = calendar.slice(calendar.indexOf("function renderCalendarGrid"), calendar.indexOf("function getEventClientDetails"));
    assert.match(rendering, /calendarEventAccessibleLabel\(event, clientDetails, date\)/);
    assert.match(rendering, /calendarEventAccessibleLabel\(event, client, date\)/);
    assert.match(rendering, /Afficher \$\{hiddenCount\} autre/);
    assert.match(rendering, /closest\("\.calendar-event, \.calendar-overflow-button"\)/);
});
