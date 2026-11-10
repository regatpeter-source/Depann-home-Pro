import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import helmet from "helmet";
import nodemailer from "nodemailer";
import pg from "pg";

dotenv.config({ path: fileURLToPath(new URL("../.env.test.local", import.meta.url)) });

test("the customer portal serves the exact PDF snapshot used for quote decisions", { skip: !process.env.TEST_DATABASE_URL }, async t => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    assert.match(new URL(databaseUrl).pathname, /test/i, "TEST_DATABASE_URL must point to a test database");

    const schemaName = `test_customer_portal_${process.pid}_${Date.now()}`;
    const adminPool = new pg.Pool({ connectionString: databaseUrl });
    let database, server, schemaCreated = false;
    try {
        await adminPool.query(`CREATE SCHEMA ${schemaName}`);
        schemaCreated = true;
        process.env.DATABASE_URL = databaseUrl;
        process.env.PGOPTIONS = `-c search_path=${schemaName}`;
        process.env.SESSION_SECRET = "test-only-customer-portal-secret";
        process.env.BREVO_SMTP_HOST = "smtp.test.invalid";
        process.env.BREVO_SMTP_USER = "test-user";
        process.env.BREVO_SMTP_PASSWORD = "test-password";
        process.env.BREVO_SMTP_FROM = "Depann Home <noreply@example.test>";
        const sentMessages = [];
        let failEmails = false;
        t.mock.method(nodemailer, "createTransport", () => ({
            async sendMail(message) {
                if (failEmails) throw Object.assign(new Error("Test-only SMTP failure"), { code: "SMTP_TEST_FAILURE" });
                sentMessages.push(message);
                return { accepted: [message.to] };
            }
        }));

        const root = new URL("../", import.meta.url);
        const { getPool } = await import(new URL("server/database.js", root));
        const { registerCustomerPortalRoutes } = await import(new URL("server/customer-portal.js", root));
        const { contentSecurityPolicy, createOriginProtection } = await import(new URL("server/security-hardening.js", root));
        database = getPool();

        const schema = await readFile(new URL("database/schema.sql", root), "utf8");
        const tableDefinition = name => {
            const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
            const end = schema.indexOf("\n);", start);
            assert.ok(start >= 0 && end > start, `Missing table definition for ${name}`);
            return schema.slice(start, end + 3);
        };
        await database.query(`CREATE TABLE depannhome_users (
            id BIGINT PRIMARY KEY, quote_template_policy VARCHAR(30) NOT NULL DEFAULT 'integrated_only'
        )`);
        await database.query(`CREATE TABLE depannhome_clients (
            owner_id BIGINT NOT NULL, client_id VARCHAR(100) NOT NULL,
            client_status VARCHAR(20) NOT NULL, client_data JSONB NOT NULL
        )`);
        await database.query("CREATE TABLE depannhome_calendar_events (id BIGINT PRIMARY KEY, owner_id BIGINT)");
        await database.query("CREATE TABLE depannhome_calendar_assignments (event_id BIGINT, technician_id BIGINT)");
        for (const table of [
            "depannhome_billing_profiles", "depannhome_document_templates",
            "depannhome_billing_documents", "depannhome_customer_portal_links",
            "depannhome_customer_portal_events", "depannhome_quote_decisions"
        ]) {
            await database.query(tableDefinition(table));
        }
        await database.query("ALTER TABLE depannhome_billing_documents ADD COLUMN IF NOT EXISTS financial_data JSONB NOT NULL DEFAULT '{}'::jsonb");
        await database.query(await readFile(new URL("database/migrations/0044_customer_portal_document_snapshots.sql", root), "utf8"));
        await database.query("INSERT INTO depannhome_users(id) VALUES(1),(2)");
        await database.query("INSERT INTO depannhome_billing_profiles(owner_id,company_name,email) VALUES(1,'Fictional Company','company@example.test'),(2,'Other Fictional Company','other@example.test')");
        await database.query(`INSERT INTO depannhome_clients(owner_id,client_id,client_status,client_data)
            VALUES(1,'client-one','active','{"name":"Fictional Client","email":"client@example.test"}'),
                  (2,'client-two','active','{"name":"Other Client","email":"other-client@example.test"}')`);
        const lines = JSON.stringify([{ description: "Fictional repair", quantity: 1, unit: "fixed", unitPrice: 100, vatRate: 20 }]);
        await database.query(`INSERT INTO depannhome_billing_documents
            (id,owner_id,created_by,created_by_name,document_type,document_number,client_id,customer_name,issue_date,status,lines)
            VALUES(101,1,1,'Fictional User','quote','QUOTE-TEST','client-one','Fictional Client','2026-11-10','sent',$1::jsonb),
                  (102,1,1,'Fictional User','invoice','INVOICE-TEST','client-one','Fictional Client','2026-11-10','draft',$1::jsonb),
                  (103,1,1,'Fictional User','quote','QUOTE-REFUSED','client-one','Fictional Client','2026-11-10','sent',$1::jsonb),
                  (104,1,1,'Fictional User','quote','QUOTE-DRAFT','client-one','Fictional Client','2026-11-10','draft',$1::jsonb),
                  (201,2,2,'Fictional User','quote','OTHER-QUOTE','client-two','Other Client','2026-11-10','sent',$1::jsonb)`, [lines]);

        const app = express();
        app.set("trust proxy", 1);
        app.use(helmet({ contentSecurityPolicy: contentSecurityPolicy(), crossOriginEmbedderPolicy: false }));
        app.use(express.json(), express.urlencoded({ extended: false }), createOriginProtection());
        app.use((request, _response, next) => {
            const ownerId = request.get("X-Test-Owner");
            if (ownerId) request.user = { sub: ownerId, accountOwnerId: ownerId, role: "admin" };
            next();
        });
        registerCustomerPortalRoutes(app, (request, response, next) => request.user ? next() : response.status(401).end());
        app.use((error, _request, response, _next) => response.status(error.status || 500).json({ message: error.message }));
        server = app.listen(0, "127.0.0.1");
        await new Promise(resolve => server.once("listening", resolve));
        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        process.env.PUBLIC_BASE_URL = baseUrl;

        const createLink = (documentIds, sendEmail = false) => fetch(`${baseUrl}/api/customer-portal/links`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Test-Owner": "1" },
            body: JSON.stringify({ clientId: "client-one", documentIds, durationDays: 14, allowQuoteDecision: true, sendEmail })
        });
        assert.equal((await createLink([201])).status, 400);
        const createdResponse = await createLink([101, 102, 103, 104], true);
        assert.equal(createdResponse.status, 201);
        const link = await createdResponse.json();
        assert.equal(link.emailSent, true);
        assert.equal(sentMessages.length, 1);
        assert.equal(sentMessages[0].to, "client@example.test");
        failEmails = true;
        const failedEmailResponse = await createLink([101], true);
        assert.equal(failedEmailResponse.status, 201);
        const failedEmailLink = await failedEmailResponse.json();
        assert.equal(failedEmailLink.emailSent, false);
        assert.match(failedEmailLink.emailWarning, /transmettre manuellement/);
        assert.equal((await fetch(failedEmailLink.url)).status, 200);
        failEmails = false;
        const snapshots = await database.query("SELECT document_id,pdf_sha256,pdf_data FROM depannhome_customer_portal_document_snapshots WHERE portal_link_id=$1 ORDER BY document_id", [link.id]);
        assert.equal(snapshots.rowCount, 4);

        const portalResponse = await fetch(link.url);
        assert.equal(portalResponse.status, 200);
        const portalHtml = await portalResponse.text();
        assert.match(portalHtml, /Accepter le devis/);
        assert.match(portalHtml, /ne constitue pas une signature électronique certifiée/);
        assert.equal([...portalHtml.matchAll(/<form method=post action="\/portail\//g)].length, 2);

        const pdfResponse = await fetch(`${link.url}/documents/101`);
        assert.equal(pdfResponse.status, 200);
        const viewedPdf = Buffer.from(await pdfResponse.arrayBuffer());
        assert.equal(viewedPdf.subarray(0, 4).toString(), "%PDF");
        const viewedHash = createHash("sha256").update(viewedPdf).digest("hex");
        assert.equal(snapshots.rows.find(row => row.document_id === "101").pdf_sha256.trim(), viewedHash);

        await database.query("UPDATE depannhome_billing_documents SET lines=$2::jsonb WHERE id=$1", [101, JSON.stringify([{ description: "Modified after sharing", quantity: 1, unit: "fixed", unitPrice: 500, vatRate: 20 }])]);
        const repeatPdfResponse = await fetch(`${link.url}/documents/101`);
        const repeatPdf = Buffer.from(await repeatPdfResponse.arrayBuffer());
        assert.deepEqual(repeatPdf, viewedPdf);
        assert.equal((await fetch(`${link.url}/documents/201`)).status, 404);
        assert.equal((await fetch(`${link.url}/documents/102`)).status, 200);

        const formHeaders = { "Content-Type": "application/x-www-form-urlencoded", Origin: baseUrl };
        const decision = (documentId, value) => fetch(`${link.url}/devis/${documentId}/decision`, {
            method: "POST", redirect: "manual", headers: formHeaders,
            body: new URLSearchParams({ signerName: "Fictional Client", decision: value })
        });
        assert.equal((await decision(102, "accepted")).status, 404);
        assert.equal((await decision(104, "accepted")).status, 409);
        assert.equal((await decision(103, "refused")).status, 409);
        assert.equal((await fetch(`${link.url}/documents/103`)).status, 200);
        failEmails = true;
        assert.equal((await decision(101, "accepted")).status, 303);
        failEmails = false;
        assert.equal((await decision(101, "accepted")).status, 303);
        assert.equal((await decision(101, "refused")).status, 409);
        assert.equal((await decision(103, "refused")).status, 303);

        const accepted = await database.query("SELECT decision,document_sha256 FROM depannhome_quote_decisions WHERE owner_id=1 AND document_id=101");
        assert.equal(accepted.rows[0].decision, "accepted");
        assert.equal(accepted.rows[0].document_sha256.trim(), viewedHash);
        const quote = await database.query("SELECT status FROM depannhome_billing_documents WHERE id=101");
        assert.equal(quote.rows[0].status, "accepted");
        const refusedQuote = await database.query("SELECT status FROM depannhome_billing_documents WHERE id=103");
        assert.equal(refusedQuote.rows[0].status, "refused");
        assert.equal(sentMessages.length, 2);
        const ownerDecisions = await fetch(`${baseUrl}/api/customer-portal/quote-decisions?clientId=client-one`, { headers: { "X-Test-Owner": "1" } });
        const ownerDecisionsBody = await ownerDecisions.json();
        assert.equal(ownerDecisionsBody.decisions.length, 2);
        assert.equal(ownerDecisionsBody.decisions.find(item => item.documentId === "101").notificationStatus, "failed");
        assert.equal(ownerDecisionsBody.decisions.find(item => item.documentId === "103").notificationStatus, "sent");
        const retryNotification = await fetch(`${baseUrl}/api/customer-portal/quote-decisions/101/notify`, {
            method: "POST", headers: { "X-Test-Owner": "1", Origin: baseUrl }
        });
        assert.equal(retryNotification.status, 200);
        assert.equal(sentMessages.length, 3);
        const updatedDecisions = await fetch(`${baseUrl}/api/customer-portal/quote-decisions?clientId=client-one`, { headers: { "X-Test-Owner": "1" } });
        assert.ok((await updatedDecisions.json()).decisions.every(item => item.notificationStatus === "sent"));
        const otherOwnerDecisions = await fetch(`${baseUrl}/api/customer-portal/quote-decisions?clientId=client-one`, { headers: { "X-Test-Owner": "2" } });
        assert.equal((await otherOwnerDecisions.json()).decisions.length, 0);

        const revokeResponse = await fetch(`${baseUrl}/api/customer-portal/links/${link.id}/revoke`, {
            method: "POST", headers: { "X-Test-Owner": "1", Origin: baseUrl }
        });
        assert.equal(revokeResponse.status, 204);
        assert.equal((await fetch(link.url)).status, 404);
    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        if (database) await database.end();
        if (schemaCreated) await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
        await adminPool.end();
    }
});
