import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import pg from "pg";
import { createMaintenanceContractPdf, sanitizeContractTemplate } from "../server/maintenance-contracts.js";

dotenv.config({ path: fileURLToPath(new URL("../.env.test.local", import.meta.url)) });
const databaseUrl = String(process.env.TEST_DATABASE_URL || "");
const enabled = Boolean(databaseUrl);
const schema = `test_maintenance_contracts_${process.pid}_${Date.now()}`;
let administration;
let database;
let server;
let baseUrl;

before(async () => {
    if (!enabled) return;
    if (!/test/i.test(new URL(databaseUrl).pathname)) throw new Error("TEST_DATABASE_URL doit désigner une base de test.");
    administration = new pg.Pool({ connectionString: databaseUrl });
    await administration.query(`CREATE SCHEMA ${schema}`);
    process.env.PGOPTIONS = `-c search_path=${schema}`;
    process.env.DATABASE_URL = databaseUrl;
    const { getPool } = await import("../server/database.js");
    database = getPool();
    await database.query(`
        CREATE TABLE depannhome_users(id BIGINT PRIMARY KEY);
        CREATE TABLE depannhome_clients(
            owner_id BIGINT NOT NULL,client_id VARCHAR(100) NOT NULL,client_data JSONB NOT NULL,
            client_status VARCHAR(20) NOT NULL,PRIMARY KEY(owner_id,client_id)
        );
        CREATE TABLE depannhome_billing_profiles(
            owner_id BIGINT PRIMARY KEY,company_name VARCHAR(160),legal_form VARCHAR(100),address VARCHAR(255),
            postal_code VARCHAR(20),city VARCHAR(100),registration_number VARCHAR(100),email VARCHAR(160),
            phone VARCHAR(50),vat_regime VARCHAR(20),tax_number VARCHAR(100)
        );
        CREATE TABLE depannhome_client_sites(
            id BIGINT PRIMARY KEY,owner_id BIGINT NOT NULL,client_id VARCHAR(100) NOT NULL,name VARCHAR(160) NOT NULL,
            address VARCHAR(500),postal_code VARCHAR(20),city VARCHAR(120),contact_name VARCHAR(160),
            contact_phone VARCHAR(50),access_notes VARCHAR(1000)
        );
        CREATE TABLE depannhome_client_equipment(
            id BIGINT PRIMARY KEY,owner_id BIGINT NOT NULL,client_id VARCHAR(100) NOT NULL,
            site_id BIGINT,name VARCHAR(160) NOT NULL,category VARCHAR(100),brand VARCHAR(100),model VARCHAR(120),
            serial_number VARCHAR(160),installed_on DATE,warranty_ends_on DATE,status VARCHAR(20),notes VARCHAR(2000)
        );
        CREATE TABLE depannhome_maintenance_contracts(
            id BIGSERIAL PRIMARY KEY,owner_id BIGINT NOT NULL,client_id VARCHAR(100) NOT NULL,
            site_id BIGINT,equipment_id BIGINT,reference VARCHAR(100) NOT NULL,title VARCHAR(160) NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'active',starts_on DATE NOT NULL,ends_on DATE,
            frequency_months INTEGER NOT NULL DEFAULT 12,next_service_on DATE,sla_hours INTEGER NOT NULL DEFAULT 0,
            annual_amount_ht NUMERIC(12,2) NOT NULL DEFAULT 0,notes VARCHAR(2000) NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(owner_id,reference)
        );
        CREATE TABLE depannhome_billing_documents(
            id BIGSERIAL PRIMARY KEY,owner_id BIGINT NOT NULL,created_by BIGINT,created_by_name VARCHAR(160),
            document_type VARCHAR(10) NOT NULL,document_number VARCHAR(80) NOT NULL,client_id VARCHAR(100),
            customer_type VARCHAR(30),customer_name VARCHAR(160),customer_address VARCHAR(500),
            issue_date DATE NOT NULL,due_date DATE,status VARCHAR(30),vat_regime VARCHAR(20),
            issuer_tax_number VARCHAR(100),issued_at TIMESTAMPTZ,lines JSONB,legal_data JSONB,notes VARCHAR(2000),financial_data JSONB
        );
        INSERT INTO depannhome_users VALUES(1),(2);
        INSERT INTO depannhome_clients VALUES
            (1,'client-1','{"name":"Client Test","address":"1 rue des Essais","postalCode":"75001","city":"Paris","email":"client@example.test"}','active'),
            (2,'client-2','{"name":"Autre client"}','active');
        INSERT INTO depannhome_billing_profiles(owner_id,company_name,legal_form,address,postal_code,city,registration_number,email,phone,vat_regime,tax_number)
        VALUES(1,'Entreprise Test','SAS','2 rue du Test','75002','Paris','123456789','contact@example.test','0102030405','standard','FR12345678901'),
            (2,'Autre Entreprise','','','','','','','','franchise','');
    `);
    await database.query(await readFile(new URL("../database/migrations/0042_maintenance_contract_lifecycle.sql", import.meta.url), "utf8"));
    await database.query(`
        INSERT INTO depannhome_maintenance_contracts
            (id,owner_id,client_id,reference,title,status,starts_on,ends_on,frequency_months,next_service_on,sla_hours,annual_amount_ht,service_description)
        VALUES
            (101,1,'client-1','C-101','Maintenance plomberie','active',CURRENT_DATE-INTERVAL '1 year',CURRENT_DATE+INTERVAL '1 day',12,CURRENT_DATE+INTERVAL '1 day',24,1200,'Visite annuelle et vérification'),
            (102,2,'client-2','C-102','Autre entreprise','active',CURRENT_DATE, NULL,12,NULL,0,0,'');
        SELECT setval(pg_get_serial_sequence('depannhome_maintenance_contracts','id'),102,TRUE);
    `);
    const { registerBusinessSuiteRoutes } = await import("../server/business-suite.js");
    const { registerMaintenanceContractRoutes } = await import("../server/maintenance-contracts.js");
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = {
            sub: request.get("X-Test-Owner") || "1",
            accountOwnerId: request.get("X-Test-Owner") || "1",
            role: request.get("X-Test-Role") || "admin",
            fullName: "Administrateur test",
            organization: { interfaceType: request.get("X-Test-Interface") || "standard" },
            isSupportControl: request.get("X-Test-Support") === "true"
        };
        next();
    });
    const authentication = (_request, _response, next) => next();
    registerBusinessSuiteRoutes(app, authentication);
    registerMaintenanceContractRoutes(app, authentication);
    app.use((error, _request, response, _next) => response.status(error.status || 500).json({ message: error.message }));
    server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (database) await database.end();
    if (administration) {
        await administration.query(`DROP SCHEMA ${schema} CASCADE`);
        await administration.end();
    }
});

test("le modèle personnalisé est validé et les projets de contrat sont de vrais PDF", async () => {
    const template = {
        introduction: "Contrat de maintenance",
        scope: "Visite annuelle",
        exclusions: "Pièces non comprises",
        paymentTerms: "Paiement à 30 jours",
        renewalTerms: "Renouvellement après accord écrit",
        cancellationTerms: "Résiliation selon les conditions convenues"
    };
    assert.deepEqual(sanitizeContractTemplate(template), { ok: true, ...template });
    assert.equal(sanitizeContractTemplate({ ...template, scope: "x".repeat(5001) }).ok, false);
    assert.equal(sanitizeContractTemplate({ ...template, renewalTerms: null }).ok, false);
    const pdf = await createMaintenanceContractPdf({
        reference: "C-101", title: "Maintenance plomberie", startsOn: "2026-01-01",
        client: { name: "Client Test", address: "Paris" }, company: { name: "Entreprise Test" },
        template, frequencyMonths: 12, billingIntervalMonths: 12, billingAmountHt: 120
    });
    assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
    assert.ok(pdf.length > 1000);
});

test("PostgreSQL : cycle manuel du contrat, archives immuables, renouvellement et facturation en brouillon", { skip: !enabled }, async () => {
    const request = (path, options = {}) => fetch(`${baseUrl}${path}`, {
        method: options.method || "GET",
        headers: {
            "X-Test-Owner": String(options.owner || 1),
            "X-Test-Role": options.role || "admin",
            "X-Test-Interface": options.interfaceType || "standard",
            "X-Test-Support": options.supportControl ? "true" : "false",
            ...(options.body instanceof FormData ? {} : options.body ? { "Content-Type": "application/json" } : {})
        },
        body: options.body instanceof FormData ? options.body : options.body ? JSON.stringify(options.body) : undefined
    });

    let response = await request("/api/business-suite/contracts/template");
    assert.equal(response.status, 200);
    const template = (await response.json()).template;
    response = await request("/api/business-suite/contracts/template", { method: "PUT", body: { ...template, scope: "Périmètre réservé à ce client." } });
    assert.equal(response.status, 204);
    assert.equal((await (await request("/api/business-suite/contracts/template")).json()).template.scope, "Périmètre réservé à ce client.");
    assert.equal((await request("/api/business-suite/contracts/template", { method: "PUT", interfaceType: "partner", body: template })).status, 403);
    assert.equal((await request("/api/business-suite/contracts/template", { method: "PUT", role: "technician", body: template })).status, 403);

    const today = (await database.query("SELECT TO_CHAR(CURRENT_DATE,'YYYY-MM-DD') AS today")).rows[0].today;
    response = await request("/api/business-suite/clients/client-1/contracts", {
        method: "POST",
        body: { reference: "C-NEW", title: "Nouveau contrat", startsOn: today, billingVatRate: 20 }
    });
    assert.equal(response.status, 201);
    assert.equal((await database.query("SELECT status FROM depannhome_maintenance_contracts WHERE reference='C-NEW'")).rows[0].status, "draft");
    assert.equal((await request("/api/business-suite/clients/client-1/contracts", {
        method: "POST", interfaceType: "partner",
        body: { reference: "C-PARTNER", title: "Interdit", startsOn: today, billingVatRate: 20 }
    })).status, 403);

    response = await request("/api/business-suite/contracts/101/documents/generate", { method: "POST", body: {} });
    assert.equal(response.status, 201);
    const generated = await response.json();
    response = await request(`/api/business-suite/contracts/101/documents/${generated.id}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString("ascii"), "%PDF-");
    assert.equal((await request(`/api/business-suite/contracts/101/documents/${generated.id}`, { owner: 2 })).status, 404);

    const signedPdf = await createMaintenanceContractPdf({
        reference: "C-101", title: "Maintenance plomberie", client: { name: "Client Test" },
        company: { name: "Entreprise Test" }, template
    });
    const signedForm = new FormData();
    signedForm.append("file", new Blob([signedPdf], { type: "application/pdf" }), "contrat-signe.pdf");
    response = await request("/api/business-suite/contracts/101/documents/signed", { method: "POST", body: signedForm });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).activatesContract, false);
    assert.equal((await request("/api/business-suite/contracts/101/documents/signed", { method: "POST", body: signedForm })).status, 409);
    assert.equal((await request("/api/business-suite/contracts/101", { method: "DELETE" })).status, 409);

    response = await request("/api/business-suite/contracts/101/renew", {
        method: "POST",
        body: { reference: "C-101-R", startsOn: "2027-01-01", endsOn: "2027-12-31", nextServiceOn: "2027-01-01" }
    });
    assert.equal(response.status, 201);
    const renewed = await response.json();
    assert.equal(renewed.status, "draft");
    assert.equal((await database.query("SELECT status FROM depannhome_maintenance_contracts WHERE id=$1", [renewed.id])).rows[0].status, "draft");
    assert.equal((await request("/api/business-suite/contracts/101/renew", { method: "POST", body: { reference: "C-101-R", startsOn: "2027-01-01" } })).status, 409);
    assert.equal((await request("/api/business-suite/contracts/101/renew", { method: "POST", body: { reference: "C-BAD", startsOn: "2027-01-01", endsOn: "2026-01-01" } })).status, 400);

    await database.query(`UPDATE depannhome_maintenance_contracts SET billing_amount_ht=100,
        billing_interval_months=1,billing_vat_rate=20,next_invoice_on=CURRENT_DATE-1 WHERE id=101`);
    const draftResponses = await Promise.all([
        request("/api/business-suite/contracts/101/invoice-drafts", { method: "POST", body: {} }),
        request("/api/business-suite/contracts/101/invoice-drafts", { method: "POST", body: {} })
    ]);
    const drafts = await Promise.all(draftResponses.map(async item => ({ status: item.status, payload: await item.text() })));
    assert.deepEqual(drafts.map(item => item.status).sort(), [201, 409], JSON.stringify(drafts));
    const created = drafts.filter(item => item.status === 201).map(item => JSON.parse(item.payload));
    assert.equal(created.length, 1);
    const invoice = created[0];
    assert.equal(invoice.status, "draft");
    const invoiceRecord = await database.query("SELECT status,issued_at,lines->0->>'description' AS description FROM depannhome_billing_documents WHERE id=$1", [invoice.id]);
    assert.deepEqual(invoiceRecord.rows[0], { status: "draft", issued_at: null, description: "Visite annuelle et vérification" });
    assert.equal((await database.query("SELECT COUNT(*)::int AS count FROM depannhome_contract_invoice_drafts WHERE contract_id=101")).rows[0].count, 1);
    response = await request("/api/business-suite/clients/client-1/assets");
    assert.equal(response.status, 200);
    const assets = await response.json();
    const storedContract = assets.contracts.find(item => String(item.id) === "101");
    assert.deepEqual(storedContract.documents.map(item => item.kind).sort(), ["generated", "signed"]);
    assert.equal(storedContract.invoiceDrafts.length, 1);
    assert.equal((await request("/api/business-suite/contracts/101/invoice-drafts", { method: "POST", body: {} })).status, 409);
    assert.equal((await request("/api/business-suite/contracts/101/invoice-drafts", { method: "POST", role: "technician", body: {} })).status, 403);
    assert.equal((await request("/api/business-suite/contracts/101/invoice-drafts", { method: "POST", interfaceType: "partner", body: {} })).status, 403);

    assert.equal((await request("/api/business-suite/contracts/101/documents/generate", { method: "POST", owner: 2, body: {} })).status, 404);
    assert.equal((await request("/api/business-suite/contracts/101/documents/generate", { method: "POST", interfaceType: "partner", body: {} })).status, 403);
    assert.equal((await request("/api/business-suite/contracts/101/documents/generate", { method: "POST", role: "technician", body: {} })).status, 403);
    assert.equal((await request("/api/business-suite/contracts/101/documents/signed", { method: "POST", body: new FormData(), interfaceType: "partner" })).status, 403);
    assert.equal((await request("/api/business-suite/contracts/101/documents/signed", { method: "POST", body: new FormData(), role: "technician" })).status, 403);
    assert.equal((await request("/api/business-suite/contracts/template", { method: "GET", interfaceType: "partner" })).status, 403);
    assert.equal((await request("/api/business-suite/contracts/template", { method: "GET", supportControl: true })).status, 403);
});
