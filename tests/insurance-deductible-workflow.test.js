import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const schema = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");
const server = readFileSync(new URL("../server/calendar.js", import.meta.url), "utf8");
const calendar = readFileSync(new URL("../js/calendar.js", import.meta.url), "utf8");
const clients = readFileSync(new URL("../js/clients.js", import.meta.url), "utf8");
const clientServer = readFileSync(new URL("../server/clients.js", import.meta.url), "utf8");
const billingServer = readFileSync(new URL("../server/billing.js", import.meta.url), "utf8");
const billingClient = readFileSync(new URL("../js/billing.js", import.meta.url), "utf8");

test("la franchise est conservée avec collecte, contrôle administratif et verrouillage", () => {
	assert.match(schema, /deductible_status VARCHAR\(20\) NOT NULL DEFAULT 'none'/);
	assert.match(schema, /deductible_amount_cents INTEGER NOT NULL DEFAULT 0/);
	assert.match(schema, /deductible_photo_attachment_id VARCHAR\(100\) NOT NULL DEFAULT ''/);
	assert.match(schema, /depannhome_protect_validated_deductible/);
	assert.match(schema, /OLD\.deductible_status = 'validated'/);
	assert.match(schema, /depannhome_calendar_events_deductible_status_idx/);
	assert.match(server, /Une franchise validée est immuable/);
});

test("seul le poste mobile affecté soumet une franchise de mission assurance", () => {
	assert.match(server, /request\.user\?\.deviceType !== "mobile"/);
	assert.match(server, /DEDUCTIBLE_FIELD_ROLES/);
	assert.match(server, /mission\.mapped_data->>'insurance'/);
	assert.match(server, /assignment\.technician_id=\$3::bigint/);
	assert.match(server, /Cette intervention est terminée : sa franchise ne peut plus être enregistrée/);
	assert.match(server, /\["pending", "validated"\]\.includes\(appointment\.deductibleStatus\)/);
	assert.match(server, /Une photo JPEG, PNG ou WebP valide est obligatoire/);
	assert.match(server, /isValidImageFile\(request\.file\)/);
});

test("les moyens de paiement sont limités et la preuve est liée à l’intervention", () => {
	["Chèque", "Espèces", "Virement", "Carte bancaire"].forEach(method => assert.ok(server.includes(method)));
	assert.match(server, /type: "Photo franchise"/);
	assert.match(server, /appointmentId: id/);
	assert.match(server, /Franchise transmise au poste administratif pour validation/);
	assert.match(calendar, /capture="environment" required/);
});

test("seul un poste administratif autorisé valide ou refuse avec un motif", () => {
	assert.match(server, /request\.user\?\.deviceType !== "desktop"/);
	assert.match(server, /DEDUCTIBLE_PC_ROLES/);
	assert.match(server, /decision === "rejected" && !reviewNote/);
	assert.match(calendar, /data-deductible-decision="validated"/);
	assert.match(calendar, /data-deductible-decision="rejected"/);
});

test("la collecte écrit immédiatement le montant, le paiement et la photo dans l’historique", () => {
	assert.match(server, /type: "insurance_deductible"/);
	assert.match(server, /status: "pending"/);
	assert.match(server, /formatEuros\(amountCents\)/);
	assert.match(server, /paymentMethod/);
	assert.match(server, /Intervention n°\$\{id\}/);
	assert.match(server, /attachmentId: attachment\.id/);
	assert.match(clients, /data-view-deductible/);
	assert.match(clients, /Voir la photo de preuve/);
});

test("le contrôle remplace l’état de la franchise sans créer de doublon", () => {
	assert.match(server, /id: `insurance-deductible-\$\{id\}`/);
	assert.match(server, /replaceDeductibleHistory\(client\.activityHistory, id, historyEntry\)/);
	assert.match(server, /status: decision/);
	assert.match(server, /item\?\.type !== "insurance_deductible"/);
	assert.match(server, /String\(item\?\.appointmentId \|\| ""\) !== String\(appointmentId\)/);
	assert.match(server, /Franchise encaissée et validée/);
	assert.match(server, /Franchise refusée/);
});

test("la franchise prévue est renseignée sur la fiche client et visible par le technicien", () => {
	assert.match(clients, /name="insuranceDeductibleAmount"/);
	assert.match(clients, /Franchise prévue/);
	assert.match(clients, /insuranceDeductibleAmountCents: parseClientMoneyToCents/);
	assert.match(clientServer, /insuranceDeductibleAmountCents: sanitizeDeductibleAmount/);
	assert.match(calendar, /Franchise prévue sur la fiche client/);
	assert.match(calendar, /event\.deductibleAmountCents \|\| expectedAmountCents/);
});

test("la franchise validée est proposée en soustraction sur la facture du donneur d’ordre", () => {
	assert.match(billingServer, /mission\.billing_mode='principal'/);
	assert.match(billingServer, /deductible_status='validated'/);
	assert.match(billingServer, /Franchise client encaissée/);
	assert.match(billingServer, /Cette déduction est réservée à la facture adressée au donneur d’ordre/);
	assert.match(billingServer, /Cette franchise est déjà déduite sur la facture/);
	assert.match(billingClient, /data-insurance-deductible/);
	assert.match(billingClient, /Primes \/ aides \/ franchise/);
});
