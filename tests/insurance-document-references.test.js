import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("la fiche client conserve et affiche toutes les formalités assurance", () => {
    const clients = read("js/clients.js");
    for (const field of ["insurance", "insuranceDossier", "mandateNumber", "claimNumber", "insuredNumber", "principal", "manager", "expert"]) {
        assert.match(clients, new RegExp(`name="${field}"`));
        assert.match(clients, new RegExp(`${field}: String\\(formData\\.get\\("${field}"\\)`));
    }
    assert.match(clients, /Assurance \/ mission partenaire/);
    assert.match(clients, /Dossier assurance \/ Réf\. assurance/);
});

test("les missions partenaires alimentent la fiche et réparent les anciens dossiers", () => {
    const missions = read("server/partner-missions.js");
    assert.match(missions, /insuranceDossier: data\.insuranceDossier \|\| data\.partnerReference/);
    assert.match(missions, /mandateNumber: data\.mandateNumber \|\| old\.mandateNumber/);
    assert.match(missions, /client\.client_data->>'insuranceDossier'/);
    assert.match(missions, /client\.client_data->>'mandateNumber'/);
});

test("la RDF reprend dossier, mandat et intervenants dans ses informations générales et son PDF", () => {
    const editor = read("js/leak-report-wizard.js");
    const server = read("server/technical-reports.js");
    const pdf = read("server/leak-report-template.js");
    for (const label of ["Dossier assurance / Réf. assurance", "N° mandat", "N° sociétaire / assuré", "Mandant / donneur d’ordre", "Gestionnaire", "Expert"]) assert.match(editor, new RegExp(label.replace("/", "\\/")));
    for (const field of ["insuranceDossier", "mandateNumber", "insuredNumber", "principal", "manager", "expert"]) assert.match(server, new RegExp(field));
    assert.match(pdf, /\["Dossier assurance", snapshot\.insuranceDossier/);
    assert.match(pdf, /\["Mandat", snapshot\.mandateNumber/);
});

test("les documents commerciaux et le quitus impriment dossier et mandat", () => {
    const billingClient = read("js/billing.js");
    const billingServer = read("server/billing.js");
    const calendar = read("server/calendar.js");
    assert.match(billingClient, /insuranceDossier: client\.insuranceDossier \|\| client\.partnerReference/);
    assert.match(billingClient, /mandateNumber: client\.mandateNumber \|\| client\.mandate/);
    assert.match(billingServer, /`Dossier assurance : \$\{legalData\.insuranceDossier\}`/);
    assert.match(billingServer, /`Mandat : \$\{legalData\.mandateNumber\}`/);
    assert.match(calendar, /`Dossier assurance : \$\{client\.insuranceDossier \|\| client\.partnerReference\}`/);
    assert.match(calendar, /`Mandat : \$\{client\.mandateNumber \|\| client\.mandate\}`/);
});