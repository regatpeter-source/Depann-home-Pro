import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { groupClientActivityEntries } from "../js/clients.js";

const clientSource = readFileSync(new URL("../js/clients.js", import.meta.url), "utf8");
const clientSyncSource = readFileSync(new URL("../js/client-sync.js", import.meta.url), "utf8");
const reportSource = readFileSync(new URL("../server/technical-reports.js", import.meta.url), "utf8");
const styleSource = readFileSync(new URL("../css/style.css", import.meta.url), "utf8");

const entry = (id, appointmentId, createdAt) => ({ id, appointmentId, createdAt });

test("client history separates interventions and orders them by intervention date", () => {
    const appointments = [
        { id: 12, date: "2026-09-03", startTime: "08:00", title: "Cuisine" },
        { id: 13, date: "2026-09-03", startTime: "14:00", title: "Salle de bains" },
        { id: 4, date: "2026-08-10", startTime: "09:00", title: "Ancienne intervention" }
    ];
    const grouped = groupClientActivityEntries([
        entry("old-report", "4", "2026-08-11T10:00:00Z"),
        entry("latest-quote", "13", "2026-09-03T16:00:00Z"),
        entry("latest-appointment", "13", "2026-09-03T14:00:00Z"),
        entry("morning-appointment", "12", "2026-09-03T08:00:00Z"),
        entry("client-created", "", "2026-07-01T10:00:00Z")
    ], appointments);

    assert.deepEqual(grouped.interventions.map(group => group.appointmentId), ["13", "12", "4"]);
    assert.deepEqual(grouped.interventions[0].entries.map(item => item.id), ["latest-quote", "latest-appointment"]);
    assert.deepEqual(grouped.general.map(item => item.id), ["client-created"]);
});

test("linked history without a loaded appointment still keeps its own intervention group", () => {
    const grouped = groupClientActivityEntries([
        entry("report", "99", "2026-08-20T12:00:00Z"),
        entry("invoice", "99", "2026-08-21T12:00:00Z")
    ]);
    assert.equal(grouped.interventions.length, 1);
    assert.equal(grouped.interventions[0].appointmentId, "99");
    assert.deepEqual(grouped.interventions[0].entries.map(item => item.id), ["invoice", "report"]);
});

test("the latest intervention is expanded while previous histories can be reopened", () => {
    assert.match(clientSource, /history\.interventions\.map\(\(group, index\) => renderClientInterventionHistory\(group, client, index === 0\)\)/);
    assert.match(clientSource, /<details class="client-intervention-history"/);
    assert.match(clientSource, /Historique général du client/);
    assert.match(clientSource, /client-intervention-history-toggle" aria-hidden="true"/);
    assert.match(styleSource, /\.client-intervention-history\[open\] \.client-intervention-history-close/);
});

test("the intervention identifier survives client synchronization and report history writes", () => {
    assert.match(clientSyncSource, /appointmentId: String\(activity\?\.appointmentId \|\| ""\)/);
    assert.match(reportSource, /attachmentId: attachment\.id, appointmentId: report\.appointmentId \|\| undefined/);
    assert.match(reportSource, /technical_report_reopened[\s\S]*?appointmentId: report\.appointmentId \|\| undefined/);
});

test("ordinary files remain in history while intervention photos use a separate visual gallery", () => {
    assert.match(clientSource, /const interventionPhotos = client\.attachments\.filter\(isClientPhotoAttachment\)/);
    assert.match(clientSource, /<h3>Photos des interventions<\/h3>/);
    assert.match(clientSource, /renderClientInterventionPhotoGallery\(client, interventionPhotos\)/);
    assert.match(clientSource, /const attachmentEntries = client\.attachments\.filter\(attachment => isInterventionAttachment\(attachment\) && !isImageAttachment\(attachment\)\)/);
    assert.match(clientSource, /appointmentId: String\(attachment\.appointmentId\)/);
    assert.match(clientSource, /client-intervention-photo-gallery/);
    assert.match(clientSource, /Intervention n°\$\{escapeHtml\(photo\.appointmentId\)\}/);
    assert.match(clientSource, /client-intervention-history-file/);
    assert.match(clientSource, /client-intervention-pdf/);
    assert.match(clientSource, /const imageSource = photo\.dataUrl \|\| url/);
    assert.match(clientSource, />Ouvrir<.*>Télécharger<.*>Envoyer par e-mail<.*>Supprimer</s);
});

test("mobile uploads force a full client refresh after transmission", () => {
    const calendarSource = readFileSync(new URL("../js/calendar.js", import.meta.url), "utf8");
    assert.match(calendarSource, /payload\.append\("appointmentId", String\(appointmentId \|\| ""\)\)/);
    assert.match(calendarSource, /synchronizeClients\(\{ forceFull: true \}\)/);
});

test("mobile camera selections display a visual preview before upload", () => {
    const calendarSource = readFileSync(new URL("../js/calendar.js", import.meta.url), "utf8");
    assert.match(calendarSource, /data-selected-photo-preview/);
    assert.match(calendarSource, /initializeInterventionPhotoPreviews/);
    assert.match(calendarSource, /URL\.createObjectURL\(file\)/);
    assert.match(calendarSource, /Photo prête à être ajoutée/);
    assert.match(styleSource, /\.intervention-selected-photo-preview/);
});
