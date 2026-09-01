import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BUSINESS_PAGE_SIZES, paginateItems, paginationPages } from "../js/pagination.js";

const clients = readFileSync(new URL("../js/clients.js", import.meta.url), "utf8");
const billing = readFileSync(new URL("../js/billing.js", import.meta.url), "utf8");
const purchases = readFileSync(new URL("../js/purchases.js", import.meta.url), "utf8");
const reports = readFileSync(new URL("../js/leak-report-wizard.js", import.meta.url), "utf8");
const missions = readFileSync(new URL("../js/partner-missions.js", import.meta.url), "utf8");
const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");

test("le paginateur métier propose les tailles attendues et borne les pages", () => {
    assert.deepEqual(BUSINESS_PAGE_SIZES, [10, 20, 30, 100]);
    const state = { page: 99, pageSize: 10 };
    const page = paginateItems(Array.from({ length: 23 }, (_, index) => index + 1), state);
    assert.equal(page.page, 3);
    assert.deepEqual(page.items, [21, 22, 23]);
    assert.deepEqual(paginationPages(6, 12), [1, 2, "…", 5, 6, 7, "…", 11, 12]);
});

test("les clients sont filtrés avant pagination et regroupés uniquement sur la page active", () => {
    const search = clients.slice(clients.indexOf("async function applyClientDirectorySearch"), clients.indexOf("function renderClientTable"));
    assert.match(search, /clients\.filter\(client => clientMatchesDirectoryFilters/);
    assert.match(search, /paginateItems\(orderedClients, clientDirectoryPagination\)/);
    assert.match(search, /pagination\.items\.forEach/);
    assert.match(search, /pageSizeOptions\(pagination\.pageSize, "clients"\)/);
});

test("devis, factures, avoirs et achats sont filtrés avant pagination", () => {
    const documentList = billing.slice(billing.indexOf("function renderDocumentList"), billing.indexOf("function openNewDocument"));
    const purchaseList = purchases.slice(purchases.indexOf("function renderPurchaseList"), purchases.indexOf("function createNewPurchase"));
    assert.match(documentList, /visibleDocuments = documents\.filter/);
    assert.match(documentList, /paginateItems\(visibleDocuments, billingDocumentPagination\)/);
    assert.match(documentList, /pagination\.items\.forEach/);
    assert.match(documentList, /<option value="credit">Avoirs<\/option>/);
    assert.match(purchaseList, /visiblePurchases = purchases\.filter/);
    assert.match(purchaseList, /paginateItems\(visiblePurchases, purchasePagination\)/);
    assert.match(purchaseList, /pagination\.items\.forEach/);
});

test("les rapports se recherchent et se paginent globalement avant regroupement par statut", () => {
    const directory = reports.slice(reports.indexOf("function renderDirectory"), reports.indexOf("export function openLeakReportCreation"));
    assert.match(directory, /normalizeText\(`\$\{report\.title\}/);
    assert.match(directory, /paginateItems\(ordered, reportDirectoryPagination\)/);
    assert.match(directory, /pagination\.items\.filter\(report => statuses\.includes/);
    assert.match(directory, /data-report-page-size/);
});

test("le détail intégral d’une mission remplace le contenu de page sans fenêtre modale", () => {
    const detail = missions.slice(missions.indexOf("async function showDetail"), missions.indexOf("async function openPartnerMissionPlanning"));
    assert.match(detail, /#partnerMissionContent/);
    assert.match(detail, /Mission partenaire intégrale/);
    assert.match(detail, /Journal complet de la mission/);
    assert.match(detail, /data-back-to-missions/);
    assert.match(detail, /renderSequence !== partnerMissionRenderSequence/);
    assert.doesNotMatch(detail, /openDialog\(/);
});

test("l’accueil permet le changement direct d’entreprise avec l’autorisation serveur existante", () => {
    const home = navigation.slice(navigation.indexOf("async function renderHome"), navigation.indexOf("async function loadDashboardEvents"));
    assert.match(home, /canSwitchGroupCompanies === "true"/);
    assert.match(home, /fetch\("\/api\/groups\/context"/);
    assert.match(home, /fetch\("\/api\/groups\/active-company"/);
    assert.match(home, /Clients, documents, rapports et comptabilité restent strictement isolés/);
    assert.match(home, /window\.location\.reload\(\)/);
    assert.match(app, /document\.body\.dataset\.groupName = user\.groupName \|\| ""/);
});
