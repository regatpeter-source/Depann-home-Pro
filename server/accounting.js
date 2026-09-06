import crypto from "node:crypto";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";
import {
    DEFAULT_JOURNALS,
    buildFecFile,
    createDocumentAccountingEntry,
    createSettlementAccountingEntry,
    fecFileName,
    normalizeAccountingConfig,
    validateLedger
} from "./accounting-ledger.js";
import { allocateBillingNumber } from "./billing-numbering.js";
import { hasAccountingWorkspaceAccess } from "./workstation-permissions.js";
import { isElectronicInvoicingOAuthCallback } from "./electronic-invoicing.js";
import { DELAYED_PAYMENT_METHODS, declareDelayedPayment, loadDelayedPayments, reviewDelayedPayment } from "./delayed-payments.js";
import { buildB2cReportCsv, loadB2cReport, loadB2cReports, prepareB2cReport } from "./b2c-transaction-export.js";

const AID_TYPES = new Set(["cee", "maprimerenov", "coup_de_pouce", "eco_ptz", "regional", "departmental", "supplier", "manufacturer", "custom"]);
const AID_MODES = new Set(["fixed", "percentage"]);
const EXPORT_SCOPES = new Set(["invoices", "quotes", "credits", "settlements", "clients", "overdue", "all"]);
export const INVOICE_PAYMENT_METHODS = new Set(["Chèque", "Espèces", "Virement", "Carte bancaire"]);

export async function initializeAccounting() {
    const database = getPool();
    await database.query(`
        ALTER TABLE depannhome_billing_documents
        ADD COLUMN IF NOT EXISTS financial_data JSONB NOT NULL DEFAULT '{}'::jsonb
    `);
    await database.query("ALTER TABLE depannhome_billing_documents DROP CONSTRAINT IF EXISTS depannhome_billing_documents_document_type_check");
    await database.query(`
        ALTER TABLE depannhome_billing_documents
        ADD CONSTRAINT depannhome_billing_documents_document_type_check CHECK (document_type IN ('quote', 'invoice', 'credit'))
    `);
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_accounting_aids (
            id BIGSERIAL PRIMARY KEY,
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            name VARCHAR(160) NOT NULL,
            description VARCHAR(1000) NOT NULL DEFAULT '',
            aid_type VARCHAR(40) NOT NULL DEFAULT 'custom',
            calculation_mode VARCHAR(20) NOT NULL DEFAULT 'fixed',
            amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
            auto_apply BOOLEAN NOT NULL DEFAULT FALSE,
            rules JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_accounting_aids_owner_idx ON depannhome_accounting_aids (owner_id, auto_apply, LOWER(name))");
    await database.query("UPDATE depannhome_accounting_aids SET auto_apply=FALSE WHERE auto_apply=TRUE");
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_accounting_settlements (
            id BIGSERIAL PRIMARY KEY,
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            document_id BIGINT NOT NULL REFERENCES depannhome_billing_documents(id) ON DELETE CASCADE,
            settlement_date DATE NOT NULL,
            amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
            method VARCHAR(40) NOT NULL DEFAULT 'Virement',
            reference VARCHAR(160) NOT NULL DEFAULT '',
            notes VARCHAR(1000) NOT NULL DEFAULT '',
            created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_accounting_settlements_owner_document_idx ON depannhome_accounting_settlements (owner_id, document_id, settlement_date DESC)");
    await database.query("ALTER TABLE depannhome_accounting_settlements DROP CONSTRAINT IF EXISTS depannhome_accounting_settlements_document_id_fkey");
    await database.query(`
        ALTER TABLE depannhome_accounting_settlements
        ADD CONSTRAINT depannhome_accounting_settlements_document_id_fkey
        FOREIGN KEY (document_id) REFERENCES depannhome_billing_documents(id) ON DELETE RESTRICT
    `);
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_accounting_settings (
            owner_id BIGINT PRIMARY KEY REFERENCES depannhome_users(id) ON DELETE CASCADE,
            chart_config JSONB NOT NULL DEFAULT '{}'::jsonb,
            aid_engine_config JSONB NOT NULL DEFAULT '{}'::jsonb,
            pdp_provider VARCHAR(60) NOT NULL DEFAULT '',
            pdp_platform_name VARCHAR(160) NOT NULL DEFAULT '',
            pdp_api_url VARCHAR(1000) NOT NULL DEFAULT '',
            pdp_identifier VARCHAR(160) NOT NULL DEFAULT '',
            pdp_api_secret TEXT NOT NULL DEFAULT '',
            pdp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query(`
        ALTER TABLE depannhome_accounting_settings
        ADD COLUMN IF NOT EXISTS journal_config JSONB NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS fec_config JSONB NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS pdp_platform_name VARCHAR(160) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS pdp_api_url VARCHAR(1000) NOT NULL DEFAULT ''
    `);
    await database.query("ALTER TABLE depannhome_accounting_settings ALTER COLUMN pdp_provider SET DEFAULT ''");
    await database.query("UPDATE depannhome_accounting_settings SET pdp_provider='',pdp_enabled=FALSE,pdp_api_secret='' WHERE pdp_provider='sandbox'");
    await database.query("DROP TABLE IF EXISTS depannhome_accounting_sandbox_sessions");
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_accounting_journals (
            id BIGSERIAL PRIMARY KEY,
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            journal_type VARCHAR(30) NOT NULL CHECK (journal_type IN ('sales','bank','cash','general','purchase')),
            code VARCHAR(10) NOT NULL,
            label VARCHAR(100) NOT NULL,
            description VARCHAR(300) NOT NULL DEFAULT '',
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            next_sequence BIGINT NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT depannhome_accounting_journals_owner_type_unique UNIQUE (owner_id, journal_type),
            CONSTRAINT depannhome_accounting_journals_owner_code_unique UNIQUE (owner_id, code),
            CONSTRAINT depannhome_accounting_journals_owner_id_unique UNIQUE (owner_id, id)
        )
    `);
    await database.query("ALTER TABLE depannhome_accounting_journals DROP CONSTRAINT IF EXISTS depannhome_accounting_journals_journal_type_check");
    await database.query("ALTER TABLE depannhome_accounting_journals ADD CONSTRAINT depannhome_accounting_journals_journal_type_check CHECK (journal_type IN ('sales','bank','cash','general','purchase'))");
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_accounting_entries (
            id BIGSERIAL PRIMARY KEY,
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            journal_id BIGINT NOT NULL,
            journal_code VARCHAR(10) NOT NULL,
            journal_label VARCHAR(100) NOT NULL,
            entry_number VARCHAR(80) NOT NULL,
            entry_date DATE NOT NULL,
            piece_reference VARCHAR(160) NOT NULL,
            piece_date DATE NOT NULL,
            description VARCHAR(300) NOT NULL,
            source_type VARCHAR(30) NOT NULL,
            source_id VARCHAR(120) NOT NULL,
            client_id VARCHAR(100) NOT NULL DEFAULT '',
            appointment_id BIGINT,
            status VARCHAR(20) NOT NULL DEFAULT 'validated' CHECK (status='validated'),
            validated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT depannhome_accounting_entries_journal_owner_fk FOREIGN KEY (owner_id, journal_id) REFERENCES depannhome_accounting_journals(owner_id, id) ON DELETE RESTRICT,
            CONSTRAINT depannhome_accounting_entries_owner_number_unique UNIQUE (owner_id, entry_number),
            CONSTRAINT depannhome_accounting_entries_owner_source_unique UNIQUE (owner_id, source_type, source_id),
            CONSTRAINT depannhome_accounting_entries_owner_id_unique UNIQUE (owner_id, id)
        )
    `);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_accounting_entries_owner_date_idx ON depannhome_accounting_entries (owner_id, entry_date, validated_at, id)");
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_accounting_entries_client_idx ON depannhome_accounting_entries (owner_id, client_id, entry_date DESC)");
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_accounting_entry_lines (
            id BIGSERIAL PRIMARY KEY,
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            entry_id BIGINT NOT NULL,
            line_number INTEGER NOT NULL CHECK (line_number > 0),
            account_number VARCHAR(20) NOT NULL CHECK (account_number ~ '^[0-9]{3,20}$'),
            account_label VARCHAR(160) NOT NULL,
            auxiliary_number VARCHAR(40) NOT NULL DEFAULT '',
            auxiliary_label VARCHAR(160) NOT NULL DEFAULT '',
            debit NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
            credit NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
            lettering VARCHAR(40) NOT NULL DEFAULT '',
            lettering_date DATE,
            currency_amount NUMERIC(14,2),
            currency_code VARCHAR(3) NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT depannhome_accounting_entry_lines_entry_owner_fk FOREIGN KEY (owner_id, entry_id) REFERENCES depannhome_accounting_entries(owner_id, id) ON DELETE RESTRICT,
            CONSTRAINT depannhome_accounting_entry_lines_owner_entry_line_unique UNIQUE (owner_id, entry_id, line_number),
            CONSTRAINT depannhome_accounting_entry_lines_direction_check CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)),
            CONSTRAINT depannhome_accounting_entry_lines_lettering_check CHECK (lettering_date IS NULL OR lettering <> '')
        )
    `);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_accounting_entry_lines_account_idx ON depannhome_accounting_entry_lines (owner_id, account_number, entry_id)");
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_accounting_allocations (
            id BIGSERIAL PRIMARY KEY,
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            settlement_id BIGINT NOT NULL REFERENCES depannhome_accounting_settlements(id) ON DELETE RESTRICT,
            document_id BIGINT NOT NULL REFERENCES depannhome_billing_documents(id) ON DELETE RESTRICT,
            amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
            lettering VARCHAR(40) NOT NULL DEFAULT '',
            lettering_date DATE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT depannhome_accounting_allocations_owner_settlement_unique UNIQUE (owner_id, settlement_id),
            CONSTRAINT depannhome_accounting_allocations_lettering_check CHECK (lettering_date IS NULL OR lettering <> '')
        )
    `);
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_accounting_audit (
            id BIGSERIAL PRIMARY KEY,
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            action VARCHAR(80) NOT NULL,
            target_type VARCHAR(40) NOT NULL,
            target_id VARCHAR(120) NOT NULL,
            details JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_accounting_audit_owner_created_idx ON depannhome_accounting_audit (owner_id, created_at DESC)");
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_accounting_exports (
            id BIGSERIAL PRIMARY KEY,
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            export_type VARCHAR(20) NOT NULL CHECK (export_type IN ('csv','xlsx','fec')),
            period_start DATE,
            period_end DATE,
            entry_count INTEGER NOT NULL DEFAULT 0,
            line_count INTEGER NOT NULL DEFAULT 0,
            validation_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
            file_hash VARCHAR(64) NOT NULL,
            filename VARCHAR(255) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_accounting_exports_owner_created_idx ON depannhome_accounting_exports (owner_id, created_at DESC)");
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_einvoice_transmissions (
            id BIGSERIAL PRIMARY KEY,
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            document_id BIGINT NOT NULL REFERENCES depannhome_billing_documents(id) ON DELETE CASCADE,
            provider VARCHAR(60) NOT NULL,
            remote_id VARCHAR(160) NOT NULL DEFAULT '',
            status VARCHAR(30) NOT NULL DEFAULT 'draft',
            message VARCHAR(1000) NOT NULL DEFAULT '',
            attempts INTEGER NOT NULL DEFAULT 0,
            last_attempt_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query("ALTER TABLE depannhome_einvoice_transmissions ALTER COLUMN provider TYPE VARCHAR(160)");
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_einvoice_transmissions_owner_idx ON depannhome_einvoice_transmissions (owner_id, status, updated_at DESC)");
    await database.query("DELETE FROM depannhome_einvoice_transmissions WHERE provider='sandbox' OR remote_id LIKE 'sandbox-%'");
}

export function registerAccountingRoutes(app, requireAuthentication) {
    app.use("/api/accounting", (request, response, next) => {
        if (isElectronicInvoicingOAuthCallback(request)) return next();
        return requireAuthentication(request, response, next);
    }, (request, response, next) => {
        if (isElectronicInvoicingOAuthCallback(request)) return next();
        return requireAccountingAdministration(request, response, next);
    });

    app.get("/api/accounting", asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request);
        const [documents, settlements, purchases, aids, settings, transmissions, entries, profile, delayedPayments, b2cReports] = await Promise.all([
            loadDocuments(ownerId), loadSettlements(ownerId), loadPurchases(ownerId), loadAids(ownerId), loadSettings(ownerId), loadTransmissions(ownerId), loadLedgerEntries(ownerId), loadAccountingProfile(ownerId), loadDelayedPayments(ownerId), loadB2cReports(ownerId)
        ]);
        response.json({
            dashboard: buildDashboard(documents, settlements, purchases),
            documents, settlements, purchases, aids,
            settings: publicSettings(settings),
            ledger: { entries, control: validateLedger(entries, { ownerId }) },
            accountingProfile: profile,
            transmissions,
            delayedPayments,
            b2cReports
        });
    }));

    app.get("/api/accounting/aids", asyncHandler(async (request, response) => response.json({ aids: await loadAids(getAccountOwnerId(request)) })));
    app.post("/api/accounting/aids", requireAccountingWriteAccess, asyncHandler(async (request, response) => {
        const aid = sanitizeAid(request.body);
        if (!aid.ok) return response.status(400).json({ message: aid.message });
        const { rows } = await getPool().query(`
            INSERT INTO depannhome_accounting_aids (owner_id, name, description, aid_type, calculation_mode, amount, auto_apply, rules)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
            RETURNING id
        `, [getAccountOwnerId(request), aid.name, aid.description, aid.aidType, aid.calculationMode, aid.amount, aid.autoApply, JSON.stringify(aid.rules)]);
        response.status(201).json({ id: rows[0].id });
    }));
    app.put("/api/accounting/aids/:aidId", requireAccountingWriteAccess, asyncHandler(async (request, response) => {
        const id = positiveId(request.params.aidId);
        const aid = sanitizeAid(request.body);
        if (!id || !aid.ok) return response.status(400).json({ message: aid.message || "Aide invalide." });
        const result = await getPool().query(`
            UPDATE depannhome_accounting_aids SET name=$3, description=$4, aid_type=$5, calculation_mode=$6, amount=$7, auto_apply=$8, rules=$9::jsonb, updated_at=NOW()
            WHERE id=$1 AND owner_id=$2
        `, [id, getAccountOwnerId(request), aid.name, aid.description, aid.aidType, aid.calculationMode, aid.amount, aid.autoApply, JSON.stringify(aid.rules)]);
        if (!result.rowCount) return response.status(404).json({ message: "Aide introuvable." });
        response.status(204).end();
    }));
    app.delete("/api/accounting/aids/:aidId", requireAccountingWriteAccess, asyncHandler(async (request, response) => {
        const result = await getPool().query("DELETE FROM depannhome_accounting_aids WHERE id=$1 AND owner_id=$2", [positiveId(request.params.aidId), getAccountOwnerId(request)]);
        if (!result.rowCount) return response.status(404).json({ message: "Aide introuvable." });
        response.status(204).end();
    }));

    app.put("/api/accounting/documents/:documentId/financial-data", requireAccountingWriteAccess, asyncHandler(async (request, response) => {
        const id = positiveId(request.params.documentId);
        const financialData = sanitizeFinancialData(request.body);
        if (!id || !financialData.ok) return response.status(400).json({ message: financialData.message || "Données financières invalides." });
        const result = await getPool().query(`
            UPDATE depannhome_billing_documents SET financial_data=$3::jsonb, updated_at=NOW()
            WHERE id=$1 AND owner_id=$2 AND issued_at IS NULL AND is_accounted=FALSE
        `, [id, getAccountOwnerId(request), JSON.stringify(financialData.value)]);
        if (!result.rowCount) return response.status(409).json({ message: "Un document comptabilisé est immuable. Créez un avoir ou une écriture corrective." });
        response.status(204).end();
    }));

    app.post("/api/accounting/documents/:documentId/post", requireAccountingWriteAccess, asyncHandler(async (request, response) => {
        const documentId = positiveId(request.params.documentId);
        if (!documentId) return response.status(400).json({ message: "Document invalide." });
        const result = await postAccountingDocument({ ownerId: getAccountOwnerId(request), documentId, actorId: request.user.sub });
        response.status(result.alreadyPosted ? 200 : 201).json(result);
    }));

    app.post("/api/accounting/documents/:documentId/credits", requireAccountingWriteAccess, asyncHandler(async (request, response) => {
        const sourceId = positiveId(request.params.documentId);
        const ownerId = getAccountOwnerId(request);
        const client = await getPool().connect();
        try {
            await client.query("BEGIN");
            const { rows } = await client.query(`SELECT * FROM depannhome_billing_documents WHERE id=$1 AND owner_id=$2 AND document_type='invoice' AND issued_at IS NOT NULL FOR UPDATE`, [sourceId, ownerId]);
            const invoice = rows[0];
            if (!invoice) { await client.query("ROLLBACK"); return response.status(404).json({ message: "Facture introuvable." }); }
            const amount = positiveMoney(request.body?.amount);
            const total = calculateDocumentTotals(invoice.lines, invoice.financial_data).netPayable;
            if (amount === null || amount > total) { await client.query("ROLLBACK"); return response.status(400).json({ message: "Le montant de l’avoir doit être positif et ne pas dépasser le montant facturé." }); }
            await postAccountingDocument({ ownerId, documentId: sourceId, actorId: request.user.sub, database: client });
            const issueDate = today();
            const number = await allocateBillingNumber(client, ownerId, "credit", Number(issueDate.slice(0, 4)));
            const vatRate = weightedVatRate(invoice.lines);
            const lines = [{ description: `Avoir sur facture ${invoice.document_number}`, quantity: 1, unit: "forfait", unitPrice: roundMoney(-amount / (1 + vatRate / 100)), vatRate }];
            const notes = cleanText(request.body?.notes, 2000);
            const creatorName = cleanText(request.user.fullName || request.user.username, 160);
            const creditDocument = {
                documentType: "credit", documentNumber: number, sourceInvoiceId: invoice.id, sourceInvoiceNumber: invoice.document_number,
                sourceInvoiceDate: invoice.issue_date, clientId: invoice.client_id, customerType: invoice.customer_type, customerName: invoice.customer_name,
                customerAddress: invoice.customer_address, issueDate, quoteReference: invoice.document_number, vatRegime: invoice.vat_regime,
                issuerTaxNumber: invoice.issuer_tax_number, legalData: invoice.legal_data || {}, lines, notes,
                creatorName, reason: notes || `Avoir sur facture ${invoice.document_number}`, financialData: { sourceInvoiceId: invoice.id }
            };
            const { buildBillingLegalArchive } = await import("./billing.js");
            const archive = await buildBillingLegalArchive(creditDocument, { ownerId, database: client });
            const { rows: created } = await client.query(`
                INSERT INTO depannhome_billing_documents (owner_id, created_by, document_type, document_number, client_id, customer_type, customer_name, customer_address, issue_date, status, issued_at, finalized_by, legal_snapshot, structured_data, structured_mime_type, structured_sha256, pdf_data, pdf_sha256, source_quote_id, quote_reference, vat_regime, issuer_tax_number, legal_data, lines, notes, financial_data, created_by_name)
                VALUES ($1,$2,'credit',$3,$4,$5,$6,$7,$8::date,'issued',NOW(),$2,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20::jsonb,$21,$22::jsonb,$23) RETURNING id
            `, [ownerId, request.user.sub, number, invoice.client_id, invoice.customer_type, invoice.customer_name, invoice.customer_address, issueDate,
                JSON.stringify({ ...archive.legalSnapshot, sourceInvoiceLegalSnapshot: invoice.legal_snapshot || {} }), archive.structuredData,
                archive.structuredMimeType, archive.structuredSha256, archive.pdfData, archive.pdfSha256, invoice.source_quote_id,
                invoice.document_number, invoice.vat_regime, invoice.issuer_tax_number, JSON.stringify(invoice.legal_data || {}), JSON.stringify(lines), notes,
                JSON.stringify({ sourceInvoiceId: invoice.id }), creatorName]);
            const posting = await postAccountingDocument({ ownerId, documentId: created[0].id, actorId: request.user.sub, database: client });
            await client.query("COMMIT");
            response.status(201).json({ id: created[0].id, documentNumber: number, posting });
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally { client.release(); }
    }));

    app.post("/api/accounting/settlements", requireAccountingWriteAccess, asyncHandler(async (request, response) => {
        const result = await recordInvoiceSettlement({ ownerId: getAccountOwnerId(request), actorId: request.user.sub, actorName: request.user.fullName || request.user.username, input: request.body });
        response.status(201).json(result);
    }));

    app.patch("/api/accounting/delayed-payments/:declarationId/review", requireDesktopAdministrator, asyncHandler(async (request, response) => {
        const declarationId = positiveId(request.params.declarationId);
        if (!declarationId) return response.status(400).json({ message: "Déclaration de règlement invalide." });
        const result = await reviewDelayedPayment({ ownerId: getAccountOwnerId(request), declarationId, actorId: request.user.sub, actorName: request.user.fullName || request.user.username, decision: request.body?.decision, bankEvidenceConfirmed: request.body?.bankEvidenceConfirmed === true, reviewNote: request.body?.reviewNote });
        response.json(result);
    }));

    app.post("/api/accounting/b2c-reports", requireAccountingWriteAccess, requireDesktopAdministrator, asyncHandler(async (request, response) => {
        const period = sanitizeLedgerPeriod(request.body, true);
        if (!period.ok) return response.status(400).json({ message: period.message });
        const result = await prepareB2cReport({ ownerId: getAccountOwnerId(request), actorId: request.user.sub, periodStart: period.start, periodEnd: period.end });
        response.status(201).json(result);
    }));

    app.get("/api/accounting/b2c-reports/:batchId/csv", requireDesktopAdministrator, asyncHandler(async (request, response) => {
        const batchId = positiveId(request.params.batchId);
        if (!batchId) return response.status(400).json({ message: "Lot e-reporting invalide." });
        const ownerId = getAccountOwnerId(request);
        const report = await loadB2cReport(ownerId, batchId);
        if (!report) return response.status(404).json({ message: "Lot e-reporting introuvable." });
        const content = Buffer.from(buildB2cReportCsv(report), "utf8");
        await getPool().query(`INSERT INTO depannhome_b2c_report_events(owner_id,batch_id,actor_id,event_type,details) VALUES($1,$2,$3,'downloaded_local',$4::jsonb)`, [ownerId, batchId, request.user.sub, JSON.stringify({ format: "csv", transmissionStatus: "not_transmitted" })]);
        response.set({ "X-Ereporting-Status": "prepared-local-not-transmitted" });
        return sendTextDownload(response, content, `e-reporting-b2c-${report.periodStart}-${report.periodEnd}.csv`, "text/csv; charset=utf-8");
    }));

    app.get("/api/accounting/settings", asyncHandler(async (request, response) => response.json({ settings: publicSettings(await loadSettings(getAccountOwnerId(request))) })));
    app.put("/api/accounting/settings", requireAccountingWriteAccess, asyncHandler(async (request, response) => {
        const settings = sanitizeSettings(request.body);
        if (!settings.ok) return response.status(400).json({ message: settings.message });
        const ownerId = getAccountOwnerId(request);
        await getPool().query(`
            INSERT INTO depannhome_accounting_settings (owner_id, chart_config, aid_engine_config, journal_config, fec_config)
            VALUES ($1,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb)
            ON CONFLICT (owner_id) DO UPDATE SET chart_config=EXCLUDED.chart_config, aid_engine_config=EXCLUDED.aid_engine_config,
                journal_config=EXCLUDED.journal_config, fec_config=EXCLUDED.fec_config, updated_at=NOW()
        `, [ownerId, JSON.stringify(settings.chartConfig), JSON.stringify(settings.aidEngineConfig), JSON.stringify(settings.journalConfig), JSON.stringify(settings.fecConfig)]);
        await ensureAccountingJournals(getPool(), ownerId, settings.journalConfig, true);
        response.status(204).end();
    }));

    app.get("/api/accounting/ledger", asyncHandler(async (request, response) => {
        const period = sanitizeLedgerPeriod(request.query);
        if (!period.ok) return response.status(400).json({ message: period.message });
        const ownerId = getAccountOwnerId(request);
        const entries = await loadLedgerEntries(ownerId, period);
        response.json({ entries, control: validateLedger(entries, { ownerId }) });
    }));

    app.post("/api/accounting/export/control", asyncHandler(async (request, response) => {
        const period = sanitizeLedgerPeriod(request.body);
        if (!period.ok) return response.status(400).json({ message: period.message });
        const ownerId = getAccountOwnerId(request);
        const [entries, profile] = await Promise.all([loadLedgerEntries(ownerId, period), loadAccountingProfile(ownerId)]);
        const confirmations = sanitizeFecConfirmations(request.body);
        const control = validateLedger(entries, { ownerId, requireFiscalCompleteness: Boolean(request.body?.fec), siren: profile.siren, ...confirmations });
        response.json({ control, period, profile: { companyName: profile.companyName, siren: profile.siren }, warning: accountingExportWarning() });
    }));

    app.get("/api/accounting/export/ledger", asyncHandler(async (request, response) => {
        const period = sanitizeLedgerPeriod(request.query);
        if (!period.ok) return response.status(400).json({ message: period.message });
        const format = request.query?.format === "xlsx" ? "xlsx" : "csv";
        const ownerId = getAccountOwnerId(request);
        const entries = await loadLedgerEntries(ownerId, period);
        const control = validateLedger(entries, { ownerId });
        if (!control.valid) return response.status(409).json({ message: "L’export comptable est bloqué par des anomalies.", control });
        if (format === "xlsx") {
            const workbook = await buildLedgerWorkbook(entries, control);
            const content = Buffer.from(await workbook.xlsx.writeBuffer());
            const filename = ledgerExportFileName("xlsx", period);
            await recordAccountingExport(ownerId, request.user.sub, "xlsx", period, control, content, filename);
            response.set({ "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename=\"${filename}\"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
            return response.send(content);
        }
        const content = Buffer.from(buildLedgerCsv(entries), "utf8");
        const filename = ledgerExportFileName("csv", period);
        await recordAccountingExport(ownerId, request.user.sub, "csv", period, control, content, filename);
        return sendTextDownload(response, content, filename, "text/csv; charset=utf-8");
    }));

    app.post("/api/accounting/export/fec", asyncHandler(async (request, response) => {
        const period = sanitizeLedgerPeriod(request.body, true);
        if (!period.ok) return response.status(400).json({ message: period.message });
        const ownerId = getAccountOwnerId(request);
        const [entries, profile] = await Promise.all([loadLedgerEntries(ownerId, period), loadAccountingProfile(ownerId)]);
        const control = validateLedger(entries, { ownerId, requireFiscalCompleteness: true, siren: profile.siren, ...sanitizeFecConfirmations(request.body) });
        if (!control.valid) return response.status(409).json({ message: "La préparation FEC est bloquée par des anomalies.", control, warning: accountingExportWarning() });
        const content = Buffer.from(buildFecFile(entries), "utf8");
        const filename = fecFileName(profile.siren, period.end);
        await recordAccountingExport(ownerId, request.user.sub, "fec", period, control, content, filename);
        response.set({ "X-Accounting-Warning": encodeURIComponent(accountingExportWarning()) });
        return sendTextDownload(response, content, filename, "text/plain; charset=utf-8");
    }));

    app.get("/api/accounting/export", asyncHandler(async (request, response) => {
        if (request.query?.format === "fec" || request.query?.scope === "fec") return response.status(410).json({ message: "L’ancien export FEC a été retiré. Utilisez l’assistant de contrôle FEC dédié." });
        const options = sanitizeExportOptions(request.query);
        if (!options.ok) return response.status(400).json({ message: options.message });
        const data = await collectExportData(getAccountOwnerId(request), options);
        if (options.format === "csv") return sendTextDownload(response, buildCsv(data, options.scope), `${exportFileBase(options)}.csv`, "text/csv; charset=utf-8");
        if (options.format === "pdf") {
            const pdf = await buildExportPdf(data, options);
            response.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename=\"${exportFileBase(options)}.pdf\"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
            return response.send(pdf);
        }
        const workbook = await buildWorkbook(data, options.scope);
        const buffer = await workbook.xlsx.writeBuffer();
        response.set({ "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename=\"${exportFileBase(options)}.xlsx\"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
        response.send(Buffer.from(buffer));
    }));
}

function requireAccountingAdministration(request, response, next) {
    if (hasAccountingWorkspaceAccess(request.user)) return next();
    return response.status(403).json({ message: "L’accès à l’espace Comptabilité n’est pas autorisé pour ce poste administratif ou n’est pas inclus dans l’offre active." });
}

function requireAccountingWriteAccess(request, response, next) {
    if (request.user?.role !== "accountant") return next();
    return response.status(403).json({ message: "Ce poste administratif est en consultation uniquement." });
}

function requireDesktopAdministrator(request, response, next) {
    if (request.user?.role === "admin" && request.user?.deviceType === "desktop") return next();
    return response.status(403).json({ message: "Cette validation est réservée à l’administrateur depuis un poste PC approuvé." });
}

export async function recordInvoiceSettlement({ ownerId, actorId, actorName = "", input, databasePool = getPool() }) {
    const settlement = sanitizeSettlement(input);
    if (!settlement.ok) throw accountingError(400, settlement.message);
    if (DELAYED_PAYMENT_METHODS.has(settlement.method)) return declareDelayedPayment({ ownerId, actorId, actorName, input: settlement, database: databasePool });
    return recordConfirmedInvoiceSettlement({ ownerId, actorId, input: settlement, databasePool });
}

export async function recordConfirmedInvoiceSettlement({ ownerId, actorId, input, database, databasePool = getPool() }) {
    const settlement = input?.ok ? input : sanitizeSettlement(input);
    if (!settlement.ok) throw accountingError(400, settlement.message);
    const ownsTransaction = !database;
    const client = database || await databasePool.connect();
    try {
        if (ownsTransaction) await client.query("BEGIN");
        const { rows } = await client.query(`SELECT id,owner_id AS "ownerId",document_type AS "documentType",document_number AS "documentNumber",client_id AS "clientId",customer_name AS "customerName",TO_CHAR(issue_date,'YYYY-MM-DD') AS "issueDate",status,lines,financial_data AS "financialData",appointment_id AS "appointmentId" FROM depannhome_billing_documents WHERE id=$1 AND owner_id=$2 AND document_type='invoice' AND issued_at IS NOT NULL FOR UPDATE`, [settlement.documentId, ownerId]);
        const document = rows[0];
        if (!document) throw accountingError(404, "Facture émise introuvable.");
        const settled = await client.query("SELECT COALESCE(SUM(amount),0)::float AS total FROM depannhome_accounting_settlements WHERE owner_id=$1 AND document_id=$2", [ownerId, document.id]);
        const pending = ownsTransaction ? await client.query("SELECT COALESCE(SUM(amount),0)::float AS total FROM depannhome_delayed_payment_declarations WHERE owner_id=$1 AND document_id=$2 AND status='pending'", [ownerId, document.id]) : { rows: [{ total: 0 }] };
        const totalDue = calculateDocumentTotals(document.lines, document.financialData).netPayable;
        const remainingAmount = roundMoney(totalDue - Number(settled.rows[0].total) - Number(pending.rows[0].total));
        if (remainingAmount <= 0) throw accountingError(409, "Cette facture est déjà intégralement réglée.");
        if (settlement.amount > remainingAmount + 0.01) throw accountingError(400, "Le règlement dépasse le solde restant de la facture.");
        await postAccountingDocument({ ownerId, documentId: document.id, actorId, database: client });
        const { rows: created } = await client.query(`INSERT INTO depannhome_accounting_settlements(owner_id,document_id,settlement_date,amount,method,reference,notes,created_by) VALUES($1,$2,$3::date,$4,$5,$6,$7,$8) RETURNING id,owner_id AS "ownerId",TO_CHAR(settlement_date,'YYYY-MM-DD') AS date,amount::float AS amount,method,reference`, [ownerId, document.id, settlement.date, settlement.amount, settlement.method, settlement.reference, settlement.notes, actorId]);
        const settings = await loadSettings(ownerId, client);
        const posting = await postSettlementEntry(client, { ownerId, actorId, settlement: created[0], document, settings });
        const paidTotal = roundMoney(Number(settled.rows[0].total) + settlement.amount);
        const paymentStatus = paidTotal >= totalDue - 0.01 ? "paid" : "partial";
        await client.query("UPDATE depannhome_einvoice_transmissions SET payment_status=$3,updated_at=NOW() WHERE owner_id=$1 AND document_id=$2", [ownerId, document.id, paymentStatus]);
        await client.query("INSERT INTO depannhome_einvoice_events(owner_id,connection_id,transmission_id,actor_id,event_type,status,message,details) SELECT owner_id,connection_id,id,$3,'payment_reconciled',$4,$5,$6::jsonb FROM depannhome_einvoice_transmissions WHERE owner_id=$1 AND document_id=$2", [ownerId, document.id, actorId, paymentStatus, paymentStatus === "paid" ? "Facture réglée dans Depann’Home Pro." : "Règlement partiel enregistré dans Depann’Home Pro.", JSON.stringify({ settlementId: created[0].id, paidTotal, method: settlement.method })]);
        if (paymentStatus === "paid") {
            const { archiveBillingAcquittance } = await import("./billing.js");
            await archiveBillingAcquittance({ ownerId, documentId: document.id, finalSettlementId: created[0].id, actorId, database: client });
        }
        if (ownsTransaction) await client.query("COMMIT");
        return { id: created[0].id, settlement: created[0], paidTotal, remainingAmount: roundMoney(Math.max(0, totalDue - paidTotal)), paymentStatus, posting, acquittanceAvailable: paymentStatus === "paid" };
    } catch (error) {
        if (ownsTransaction) await client.query("ROLLBACK");
        throw error;
    } finally { if (ownsTransaction) client.release(); }
}

export async function postAccountingDocument({ ownerId, documentId, actorId, database = getPool() }) {
    const ownsTransaction = typeof database.release !== "function";
    const client = ownsTransaction ? await database.connect() : database;
    try {
        if (ownsTransaction) await client.query("BEGIN");
        const existing = await client.query("SELECT id, entry_number AS \"entryNumber\" FROM depannhome_accounting_entries WHERE owner_id=$1 AND source_type IN ('invoice','credit') AND source_id=$2::text", [ownerId, documentId]);
        if (existing.rows[0]) {
            if (ownsTransaction) await client.query("COMMIT");
            return { entryId: existing.rows[0].id, entryNumber: existing.rows[0].entryNumber, alreadyPosted: true };
        }
        const { rows } = await client.query(`
            SELECT id, owner_id AS "ownerId", document_type AS "documentType", document_number AS "documentNumber",
                client_id AS "clientId", customer_name AS "customerName", TO_CHAR(issue_date,'YYYY-MM-DD') AS "issueDate",
                status, issued_at AS "issuedAt", lines, financial_data AS "financialData", appointment_id AS "appointmentId"
            FROM depannhome_billing_documents WHERE id=$1 AND owner_id=$2 FOR UPDATE
        `, [documentId, ownerId]);
        const document = rows[0];
        if (!document) throw accountingError(404, "Document introuvable.");
        if (!['invoice', 'credit'].includes(document.documentType)) throw accountingError(400, "Seules les factures et les avoirs peuvent être comptabilisés.");
        if (!document.issuedAt) throw accountingError(409, "Émettez définitivement la pièce avant sa comptabilisation.");
        if (['draft', 'cancelled', 'rejected'].includes(String(document.status).toLowerCase())) throw accountingError(409, "Validez ou émettez la pièce avant sa comptabilisation.");
        const settings = await loadSettings(ownerId, client);
        const journals = await ensureAccountingJournals(client, ownerId, settings.journalConfig);
        const sequence = await allocateJournalSequence(client, ownerId, "sales");
        const entry = createDocumentAccountingEntry({ document, chartConfig: settings.chartConfig, journal: journals.sales, entryNumber: sequence.entryNumber, validDate: today() });
        const entryId = await persistAccountingEntry(client, ownerId, actorId, sequence.id, entry);
        await client.query("UPDATE depannhome_billing_documents SET is_accounted=TRUE, accounted_at=COALESCE(accounted_at,CURRENT_DATE), updated_at=NOW() WHERE id=$1 AND owner_id=$2", [documentId, ownerId]);
        await recordAccountingAudit(client, ownerId, actorId, "entry_posted", document.documentType, documentId, { entryId, entryNumber: entry.entryNumber, totalDebit: entry.totalDebit, totalCredit: entry.totalCredit });
        if (ownsTransaction) await client.query("COMMIT");
        return { entryId, entryNumber: entry.entryNumber, alreadyPosted: false };
    } catch (error) {
        if (ownsTransaction) await client.query("ROLLBACK");
        throw error;
    } finally {
        if (ownsTransaction) client.release();
    }
}

async function postSettlementEntry(client, { ownerId, actorId, settlement, document, settings }) {
    const journals = await ensureAccountingJournals(client, ownerId, settings.journalConfig);
    const journalType = settlement.method === "Espèces" ? "cash" : "bank";
    const sequence = await allocateJournalSequence(client, ownerId, journalType);
    const entry = createSettlementAccountingEntry({ settlement, document, chartConfig: settings.chartConfig, journal: journals[journalType], entryNumber: sequence.entryNumber, validDate: today() });
    const entryId = await persistAccountingEntry(client, ownerId, actorId, sequence.id, entry);
    await client.query(`INSERT INTO depannhome_accounting_allocations(owner_id,settlement_id,document_id,amount) VALUES($1,$2,$3,$4)`, [ownerId, settlement.id, document.id, settlement.amount]);
    await recordAccountingAudit(client, ownerId, actorId, "settlement_posted", "settlement", settlement.id, { entryId, entryNumber: entry.entryNumber, documentId: document.id, amount: settlement.amount });
    return { entryId, entryNumber: entry.entryNumber };
}

async function ensureAccountingJournals(database, ownerId, journalConfig = {}, updateConfiguration = false) {
    const normalized = normalizeAccountingConfig({}, journalConfig).journals;
    for (const [journalType, journal] of Object.entries(normalized)) {
        if (["general", "sales", "bank", "cash"].includes(journalType)) {
            await database.query(`
                INSERT INTO depannhome_accounting_journals(owner_id,journal_type,code,label,description,is_active)
                VALUES($1,$2,$3,$4,$5,$6)
                ON CONFLICT(owner_id,journal_type) DO UPDATE SET
                    code=CASE WHEN $7 THEN EXCLUDED.code ELSE depannhome_accounting_journals.code END,
                    label=CASE WHEN $7 THEN EXCLUDED.label ELSE depannhome_accounting_journals.label END,
                    description=CASE WHEN $7 THEN EXCLUDED.description ELSE depannhome_accounting_journals.description END,
                    is_active=CASE WHEN $7 THEN EXCLUDED.is_active ELSE depannhome_accounting_journals.is_active END,
                    updated_at=CASE WHEN $7 THEN NOW() ELSE depannhome_accounting_journals.updated_at END
            `, [ownerId, journalType, journal.code, journal.label, journal.description, journal.active, updateConfiguration]);
        }
    }
    const { rows } = await database.query(`SELECT id,journal_type AS "journalType",code,label,description,is_active AS active FROM depannhome_accounting_journals WHERE owner_id=$1`, [ownerId]);
    return Object.fromEntries(rows.map(row => [row.journalType, row]));
}

async function allocateJournalSequence(database, ownerId, journalType) {
    const { rows } = await database.query(`
        UPDATE depannhome_accounting_journals SET next_sequence=next_sequence+1,updated_at=NOW()
        WHERE owner_id=$1 AND journal_type=$2 AND is_active=TRUE
        RETURNING id,code,label,next_sequence-1 AS sequence
    `, [ownerId, journalType]);
    if (!rows[0]) throw accountingError(409, `Le journal ${journalType} est inactif ou introuvable.`);
    return { ...rows[0], entryNumber: `${rows[0].code}${String(rows[0].sequence).padStart(8, "0")}` };
}

async function persistAccountingEntry(database, ownerId, actorId, journalId, entry) {
    const { rows } = await database.query(`
        INSERT INTO depannhome_accounting_entries(owner_id,journal_id,journal_code,journal_label,entry_number,entry_date,piece_reference,piece_date,description,source_type,source_id,client_id,appointment_id,created_by)
        VALUES($1,$2,$3,$4,$5,$6::date,$7,$8::date,$9,$10,$11,$12,$13,$14) RETURNING id
    `, [ownerId, journalId, entry.journalCode, entry.journalLabel, entry.entryNumber, entry.entryDate, entry.pieceRef, entry.pieceDate, entry.description, entry.sourceType, String(entry.sourceId), entry.clientId, entry.appointmentId, actorId]);
    const entryId = rows[0].id;
    for (const [index, line] of entry.lines.entries()) {
        await database.query(`
            INSERT INTO depannhome_accounting_entry_lines(owner_id,entry_id,line_number,account_number,account_label,auxiliary_number,auxiliary_label,debit,credit,lettering,lettering_date,currency_amount,currency_code)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12,$13)
        `, [ownerId, entryId, index + 1, line.accountNumber, line.accountLabel, line.auxiliaryNumber, line.auxiliaryLabel, line.debit, line.credit, line.lettering, line.letteringDate || null, line.currencyAmount || null, line.currencyCode || ""]);
    }
    return entryId;
}

async function loadLedgerEntries(ownerId, period = {}, database = getPool()) {
    const { rows: entries } = await database.query(`
        SELECT id,owner_id AS "ownerId",journal_code AS "journalCode",journal_label AS "journalLabel",entry_number AS "entryNumber",
            TO_CHAR(entry_date,'YYYY-MM-DD') AS "entryDate",piece_reference AS "pieceRef",TO_CHAR(piece_date,'YYYY-MM-DD') AS "pieceDate",
            description,source_type AS "sourceType",source_id AS "sourceId",client_id AS "clientId",appointment_id AS "appointmentId",
            TO_CHAR(validated_at AT TIME ZONE 'Europe/Paris','YYYY-MM-DD') AS "validDate"
        FROM depannhome_accounting_entries
        WHERE owner_id=$1 AND ($2::date IS NULL OR entry_date >= $2::date) AND ($3::date IS NULL OR entry_date <= $3::date)
        ORDER BY validated_at,id
    `, [ownerId, period.start || null, period.end || null]);
    if (!entries.length) return [];
    const { rows: lines } = await database.query(`
        SELECT entry_id AS "entryId",account_number AS "accountNumber",account_label AS "accountLabel",auxiliary_number AS "auxiliaryNumber",
            auxiliary_label AS "auxiliaryLabel",debit::float AS debit,credit::float AS credit,lettering,
            COALESCE(TO_CHAR(lettering_date,'YYYY-MM-DD'),'') AS "letteringDate",currency_amount::float AS "currencyAmount",currency_code AS "currencyCode"
        FROM depannhome_accounting_entry_lines WHERE owner_id=$1 AND entry_id=ANY($2::bigint[]) ORDER BY entry_id,line_number
    `, [ownerId, entries.map(entry => entry.id)]);
    const linesByEntry = lines.reduce((map, line) => {
        const key = String(line.entryId);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(line);
        return map;
    }, new Map());
    return entries.map(entry => ({ ...entry, lines: (linesByEntry.get(String(entry.id)) || []).map(({ entryId, ...line }) => line) }));
}

async function loadAccountingProfile(ownerId, database = getPool()) {
    const { rows } = await database.query(`SELECT COALESCE(NULLIF(profile.company_name,''),owner.company_name,owner.full_name,owner.username) AS "companyName",REGEXP_REPLACE(COALESCE(profile.siren,''),'[^0-9]','','g') AS siren FROM depannhome_users owner LEFT JOIN depannhome_billing_profiles profile ON profile.owner_id=owner.id WHERE owner.id=$1`, [ownerId]);
    return rows[0] || { companyName: "", siren: "" };
}

async function recordAccountingAudit(database, ownerId, actorId, action, targetType, targetId, details = {}) {
    await database.query(`INSERT INTO depannhome_accounting_audit(owner_id,actor_id,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [ownerId, actorId, action, targetType, String(targetId), JSON.stringify(details)]);
}

async function loadDocuments(ownerId) {
    const { rows } = await getPool().query(`
        SELECT document.id, document_type AS "documentType", document_number AS "documentNumber", client_id AS "clientId", customer_type AS "customerType", customer_name AS "customerName",
            customer_address AS "customerAddress", TO_CHAR(issue_date, 'YYYY-MM-DD') AS "issueDate", TO_CHAR(due_date, 'YYYY-MM-DD') AS "dueDate", status,
            issued_at AS "issuedAt", (structured_data IS NOT NULL) AS "hasStructuredData", lines, notes, financial_data AS "financialData", is_accounted AS "isAccounted", quote_reference AS "quoteReference",
            COALESCE((SELECT SUM(amount) FROM depannhome_accounting_settlements settlement WHERE settlement.owner_id=document.owner_id AND settlement.document_id=document.id), 0)::float AS "settledAmount",
            COALESCE((SELECT SUM(amount) FROM depannhome_delayed_payment_declarations pending WHERE pending.owner_id=document.owner_id AND pending.document_id=document.id AND pending.status='pending'), 0)::float AS "pendingAmount",
            EXISTS(SELECT 1 FROM depannhome_billing_acquittances acquittance WHERE acquittance.owner_id=document.owner_id AND acquittance.document_id=document.id) AS "hasAcquittance"
        FROM depannhome_billing_documents document
        WHERE owner_id=$1 AND (document_type <> 'invoice' OR issued_at IS NOT NULL)
        ORDER BY issue_date DESC, id DESC
    `, [ownerId]);
    return rows.map(document => {
        const totals = calculateDocumentTotals(document.lines, document.financialData);
        const settledAmount = Number(document.settledAmount || 0);
        return { ...document, financialData: normalizeFinancialData(document.financialData), totals, settledAmount, pendingAmount: Number(document.pendingAmount || 0), remainingAmount: Math.max(0, roundMoney(totals.netPayable - settledAmount)), paymentStatus: document.documentType === "invoice" ? paymentStatus(document, totals.netPayable, settledAmount) : "not_applicable" };
    });
}

async function loadSettlements(ownerId) {
    const { rows } = await getPool().query(`
        SELECT settlement.id, settlement.document_id AS "documentId", TO_CHAR(settlement.settlement_date, 'YYYY-MM-DD') AS date, settlement.amount::float AS amount,
            settlement.method, settlement.reference, settlement.notes, document.document_number AS "documentNumber", document.customer_name AS "customerName"
        FROM depannhome_accounting_settlements settlement JOIN depannhome_billing_documents document ON document.id=settlement.document_id
        WHERE settlement.owner_id=$1 ORDER BY settlement.settlement_date DESC, settlement.id DESC
    `, [ownerId]);
    return rows;
}

async function loadPurchases(ownerId) {
    const { rows } = await getPool().query(`SELECT id, TO_CHAR(purchase_date, 'YYYY-MM-DD') AS date, supplier, description, amount_ht::float AS "amountHt", vat_rate::float AS "vatRate", is_accounted AS "isAccounted" FROM depannhome_purchases WHERE owner_id=$1 ORDER BY purchase_date DESC`, [ownerId]);
    return rows;
}

async function loadAids(ownerId) {
    const { rows } = await getPool().query(`SELECT id, name, description, aid_type AS "aidType", calculation_mode AS "calculationMode", amount::float AS amount, auto_apply AS "autoApply", rules FROM depannhome_accounting_aids WHERE owner_id=$1 ORDER BY auto_apply DESC, LOWER(name)`, [ownerId]);
    return rows;
}

async function loadSettings(ownerId, database = getPool()) {
    const { rows } = await database.query("SELECT chart_config AS \"chartConfig\", aid_engine_config AS \"aidEngineConfig\", journal_config AS \"journalConfig\", fec_config AS \"fecConfig\", pdp_provider AS \"pdpProvider\", pdp_platform_name AS \"pdpPlatformName\", pdp_api_url AS \"pdpApiUrl\", pdp_identifier AS \"pdpIdentifier\", pdp_api_secret AS \"pdpApiSecret\", pdp_enabled AS \"pdpEnabled\" FROM depannhome_accounting_settings WHERE owner_id=$1", [ownerId]);
    return rows[0] || { chartConfig: {}, aidEngineConfig: {}, journalConfig: {}, fecConfig: {}, pdpProvider: "", pdpPlatformName: "", pdpApiUrl: "", pdpIdentifier: "", pdpApiSecret: "", pdpEnabled: false };
}

async function loadTransmissions(ownerId) {
    const { rows } = await getPool().query(`
        SELECT transmission.id, transmission.document_id AS "documentId", document.document_number AS "documentNumber", transmission.provider, transmission.remote_id AS "remoteId",
            transmission.status, transmission.message, transmission.attempts, transmission.last_attempt_at AS "lastAttemptAt", transmission.updated_at AS "updatedAt"
        FROM depannhome_einvoice_transmissions transmission JOIN depannhome_billing_documents document ON document.id=transmission.document_id AND document.owner_id=transmission.owner_id
        WHERE transmission.owner_id=$1 ORDER BY transmission.updated_at DESC LIMIT 100
    `, [ownerId]);
    return rows;
}

function publicSettings(settings) {
    const normalized = normalizeAccountingConfig(settings.chartConfig, settings.journalConfig);
    return { chartConfig: normalized.accounts, journalConfig: normalized.journals, fecConfig: settings.fecConfig || {}, aidEngineConfig: settings.aidEngineConfig || {} };
}

function buildDashboard(documents, settlements, purchases) {
    const invoices = documents.filter(item => item.documentType === "invoice");
    const credits = documents.filter(item => item.documentType === "credit");
    const turnover = invoices.reduce((sum, item) => sum + item.totals.netPayable, 0) + credits.reduce((sum, item) => sum + item.totals.netPayable, 0);
    const collected = settlements.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const purchasesHt = purchases.reduce((sum, item) => sum + Number(item.amountHt || 0), 0);
    const overdue = invoices.filter(item => item.paymentStatus === "overdue");
    return { turnover: roundMoney(turnover), collected: roundMoney(collected), outstanding: roundMoney(invoices.reduce((sum, item) => sum + item.remainingAmount, 0)), overdueAmount: roundMoney(overdue.reduce((sum, item) => sum + item.remainingAmount, 0)), overdueCount: overdue.length, purchasesHt: roundMoney(purchasesHt), invoicesCount: invoices.length };
}

function calculateDocumentTotals(lines, financialData) {
    const data = normalizeFinancialData(financialData);
    const getPrice = line => Number(line.unitPrice ?? line.unit_price ?? 0);
    const getVatRate = line => Number(line.vatRate ?? line.vat_rate ?? 0);
    const ht = (Array.isArray(lines) ? lines : []).reduce((sum, line) => sum + Number(line.quantity || 0) * getPrice(line), 0);
    const grossVat = (Array.isArray(lines) ? lines : []).reduce((sum, line) => sum + Number(line.quantity || 0) * getPrice(line) * getVatRate(line) / 100, 0);
    if (ht < 0) return { ht: roundMoney(ht), vat: roundMoney(grossVat), ttc: roundMoney(ht + grossVat), discount: 0, aids: 0, netPayable: roundMoney(ht + grossVat) };
    const discount = Math.min(ht, data.discountMode === "percentage" ? ht * data.discountAmount / 100 : data.discountAmount);
    const vat = ht ? grossVat * (ht - discount) / ht : 0;
    const aids = data.aids.reduce((sum, aid) => sum + (aid.calculationMode === "percentage" ? (ht - discount) * Number(aid.amount || 0) / 100 : Number(aid.amount || 0)), 0);
    const ttc = ht - discount + vat;
    return { ht: roundMoney(ht), vat: roundMoney(vat), ttc: roundMoney(ttc), discount: roundMoney(discount), aids: roundMoney(Math.min(ttc, aids)), netPayable: roundMoney(Math.max(0, ttc - aids)) };
}

function normalizeFinancialData(value) {
    const data = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return { discountMode: AID_MODES.has(data.discountMode) ? data.discountMode : "fixed", discountAmount: safeMoney(data.discountAmount), depositAmount: safeMoney(data.depositAmount), conditions: cleanText(data.conditions, 2000), comments: cleanText(data.comments, 2000), photos: Array.isArray(data.photos) ? data.photos.map(item => cleanText(item, 500)).filter(Boolean).slice(0, 10) : [], options: Array.isArray(data.options) ? data.options.map(item => cleanText(item, 500)).filter(Boolean).slice(0, 20) : [], subtotals: Array.isArray(data.subtotals) ? data.subtotals.map(item => cleanText(item, 160)).filter(Boolean).slice(0, 30) : [], aids: Array.isArray(data.aids) ? data.aids.map(sanitizeAidSnapshot).filter(Boolean).slice(0, 30) : [] };
}

function sanitizeFinancialData(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, message: "Données financières invalides." };
    return { ok: true, value: normalizeFinancialData(value) };
}

function sanitizeAidSnapshot(value) {
    const name = cleanText(value?.name, 160);
    const amount = safeMoney(value?.amount);
    const calculationMode = AID_MODES.has(value?.calculationMode) ? value.calculationMode : "fixed";
    return name ? { name, amount, calculationMode, aidType: AID_TYPES.has(value?.aidType) ? value.aidType : "custom", description: cleanText(value?.description, 1000) } : null;
}

function sanitizeAid(value) {
    const name = cleanText(value?.name, 160);
    const amount = safeMoney(value?.amount);
    if (!name || amount === null) return { ok: false, message: "Le nom et le montant de l’aide sont obligatoires." };
    const aidType = AID_TYPES.has(value?.aidType) ? value.aidType : "custom";
    const calculationMode = AID_MODES.has(value?.calculationMode) ? value.calculationMode : "fixed";
    return { ok: true, name, amount, aidType, calculationMode, description: cleanText(value?.description, 1000), autoApply: false, rules: sanitizeRules(value?.rules) };
}

function sanitizeRules(value) {
    const rules = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return { workType: cleanText(rules.workType, 120), equipment: cleanText(rules.equipment, 120), customerCategory: cleanText(rules.customerCategory, 120), location: cleanText(rules.location, 120), validFrom: sanitizeDate(rules.validFrom), validTo: sanitizeDate(rules.validTo) };
}

function sanitizeSettlement(value) {
    const documentId = positiveId(value?.documentId);
    const amount = positiveMoney(value?.amount);
    const date = sanitizeDate(value?.date);
    const method = cleanText(value?.method, 40);
    if (!documentId || amount === null || !date) return { ok: false, message: "Facture, date et montant du règlement sont obligatoires." };
    if (!INVOICE_PAYMENT_METHODS.has(method)) return { ok: false, message: "Choisissez un mode de règlement valide : chèque, espèces, virement ou carte bancaire." };
    return { ok: true, documentId, amount, date, method, reference: cleanText(value?.reference, 160), notes: cleanText(value?.notes, 1000) };
}

function sanitizeSettings(value) {
    const normalized = normalizeAccountingConfig(value?.chartConfig, value?.journalConfig);
    const journalCodes = Object.values(normalized.journals).map(journal => journal.code);
    if (new Set(journalCodes).size !== journalCodes.length) return { ok: false, message: "Chaque journal doit avoir un code distinct." };
    return { ok: true, chartConfig: normalized.accounts, journalConfig: normalized.journals, fecConfig: { fiscalYearStart: sanitizeDate(value?.fecConfig?.fiscalYearStart), fiscalYearEnd: sanitizeDate(value?.fecConfig?.fiscalYearEnd) }, aidEngineConfig: { enabled: Boolean(value?.aidEngineConfig?.enabled), mode: cleanText(value?.aidEngineConfig?.mode, 40) || "manual", source: cleanText(value?.aidEngineConfig?.source, 160) } };
}

function sanitizeLedgerPeriod(value, required = false) {
    const start = value?.start ? sanitizeDate(value.start) : "";
    const end = value?.end ? sanitizeDate(value.end) : "";
    if ((required && (!start || !end)) || (value?.start && !start) || (value?.end && !end) || (start && end && start > end)) return { ok: false, message: required ? "Les dates de début et de clôture de l’exercice sont obligatoires." : "Période comptable invalide.", start, end };
    return { ok: true, start, end };
}

function sanitizeFecConfirmations(value) {
    return { openingEntriesConfirmed: value?.openingEntriesConfirmed === true, inventoryEntriesConfirmed: value?.inventoryEntriesConfirmed === true, completeLedgerConfirmed: value?.completeLedgerConfirmed === true };
}

function accountingExportWarning() {
    return "Préparation d’écritures comptables à faire valider par votre cabinet comptable. Depann’Home Pro n’est ni un logiciel comptable certifié, ni une PDP agréée par l’État.";
}

function buildLedgerRows(entries) {
    return entries.flatMap(entry => entry.lines.map(line => ({
        Journal: entry.journalCode, "Libellé journal": entry.journalLabel, "N° écriture": entry.entryNumber,
        "Date écriture": entry.entryDate, Compte: line.accountNumber, "Libellé compte": line.accountLabel,
        Auxiliaire: line.auxiliaryNumber, "Libellé auxiliaire": line.auxiliaryLabel, Pièce: entry.pieceRef,
        "Date pièce": entry.pieceDate, Libellé: entry.description, Débit: line.debit, Crédit: line.credit,
        Lettrage: line.lettering, "Date lettrage": line.letteringDate, "Date validation": entry.validDate
    })));
}

function buildLedgerCsv(entries) {
    const rows = buildLedgerRows(entries);
    const headers = rows.length ? Object.keys(rows[0]) : ["Aucune écriture"];
    const escape = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
    return `\ufeff${headers.map(escape).join(";")}\r\n${rows.map(row => headers.map(header => escape(row[header])).join(";")).join("\r\n")}`;
}

async function buildLedgerWorkbook(entries, control) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Depann’Home Pro";
    const journal = workbook.addWorksheet("Journal comptable");
    const rows = buildLedgerRows(entries);
    const headers = rows.length ? Object.keys(rows[0]) : ["Aucune écriture"];
    journal.columns = headers.map(header => ({ header, key: header, width: Math.max(14, Math.min(32, header.length + 4)) }));
    rows.forEach(row => journal.addRow(row));
    journal.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    journal.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF003B73" } };
    journal.views = [{ state: "frozen", ySplit: 1 }];
    const summary = workbook.addWorksheet("Contrôle");
    [["Avertissement", accountingExportWarning()], ["Écritures", control.entries], ["Lignes", control.lines], ["Pièces", control.pieces], ["Journaux", control.journals], ["Total débit", control.totalDebit], ["Total crédit", control.totalCredit], ["Écart", control.difference]].forEach(row => summary.addRow(row));
    return workbook;
}

function ledgerExportFileName(extension, period) { return `export-comptable-${period.start || "debut"}-${period.end || today()}.${extension}`; }

async function recordAccountingExport(ownerId, actorId, exportType, period, control, content, filename) {
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    await getPool().query(`INSERT INTO depannhome_accounting_exports(owner_id,actor_id,export_type,period_start,period_end,entry_count,line_count,validation_summary,file_hash,filename) VALUES($1,$2,$3,$4::date,$5::date,$6,$7,$8::jsonb,$9,$10)`, [ownerId, actorId, exportType, period.start || null, period.end || null, control.entries, control.lines, JSON.stringify(control), hash, filename]);
}

function accountingError(status, message) { const error = new Error(message); error.status = status; return error; }

function sanitizeExportOptions(value) {
    const format = ["csv", "xlsx", "pdf"].includes(value?.format) ? value.format : "csv";
    const scope = EXPORT_SCOPES.has(value?.scope) ? value.scope : "all";
    const start = value?.start ? sanitizeDate(value.start) : "";
    const end = value?.end ? sanitizeDate(value.end) : "";
    if ((value?.start && !start) || (value?.end && !end) || (start && end && start > end)) return { ok: false, message: "Période d’export invalide." };
    return { ok: true, format, scope, start, end };
}

async function collectExportData(ownerId, options) {
    const [documents, settlements, purchases] = await Promise.all([loadDocuments(ownerId), loadSettlements(ownerId), loadPurchases(ownerId)]);
    const inPeriod = (date) => (!options.start || date >= options.start) && (!options.end || date <= options.end);
    const filteredDocuments = documents.filter(item => inPeriod(item.issueDate));
    return { documents: filteredDocuments, settlements: settlements.filter(item => inPeriod(item.date)), purchases: purchases.filter(item => inPeriod(item.date)), options };
}

function exportRows(data, scope) {
    const all = scope === "all";
    if (scope === "settlements") return data.settlements.map(item => ({ Date: item.date, Facture: item.documentNumber, Client: item.customerName, Montant: item.amount, Mode: item.method, Référence: item.reference }));
    if (scope === "clients") return data.documents.map(item => ({ Client: item.customerName, Adresse: item.customerAddress })).filter((item, index, items) => items.findIndex(candidate => candidate.Client === item.Client) === index);
    if (scope === "overdue") return data.documents.filter(item => item.paymentStatus === "overdue").map(documentExportRow);
    const types = scope === "invoices" ? ["invoice"] : scope === "quotes" ? ["quote"] : scope === "credits" ? ["credit"] : all ? ["quote", "invoice", "credit"] : [];
    return data.documents.filter(item => types.includes(item.documentType)).map(documentExportRow);
}

function documentExportRow(item) {
    return { Type: item.documentType === "quote" ? "Devis" : item.documentType === "credit" ? "Avoir" : "Facture", Numéro: item.documentNumber, Date: item.issueDate, Échéance: item.dueDate, Client: item.customerName, Statut: documentStatusLabel(item.status), "Total HT": item.totals.ht, TVA: item.totals.vat, "Total TTC": item.totals.ttc, Aides: item.totals.aids, "Reste à charge": item.totals.netPayable, Réglé: item.settledAmount, Solde: item.remainingAmount, Paiement: paymentStatusLabel(item.paymentStatus) };
}

function documentStatusLabel(value) {
    return ({ draft: "Brouillon", sent: "Envoyé", validated: "Validé", paid: "Réglé", issued: "Émis", cancelled: "Annulé", accepted: "Accepté", rejected: "Refusé", pending: "En attente" })[String(value || "").toLowerCase()] || "Non renseigné";
}

function paymentStatusLabel(value) {
    return ({ paid: "Réglée", partial: "Partiellement réglée", unpaid: "À encaisser", overdue: "Impayée / échue", not_applicable: "Non concerné" })[String(value || "").toLowerCase()] || "Non concerné";
}

function buildCsv(data, scope) {
    const rows = exportRows(data, scope);
    const headers = rows.length ? Object.keys(rows[0]) : ["Aucune donnée"];
    const escape = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
    return `\ufeff${headers.map(escape).join(";")}\n${rows.map(row => headers.map(header => escape(row[header])).join(";")).join("\n")}`;
}

async function buildWorkbook(data, scope) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Depann’Home Pro";
    const addSheet = (name, rows) => {
        const sheet = workbook.addWorksheet(name);
        const headers = rows.length ? Object.keys(rows[0]) : ["Aucune donnée"];
        sheet.columns = headers.map(header => ({ header, key: header, width: Math.max(14, Math.min(34, header.length + 6)) }));
        rows.forEach(row => sheet.addRow(row));
        sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
        sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF003B73" } };
        sheet.views = [{ state: "frozen", ySplit: 1 }];
    };
    if (scope === "all") { addSheet("Documents", exportRows(data, "all")); addSheet("Règlements", exportRows(data, "settlements")); addSheet("Achats", data.purchases.map(item => ({ Date: item.date, Fournisseur: item.supplier, Libellé: item.description, "Montant HT": item.amountHt, TVA: item.vatRate, Comptabilisé: item.isAccounted ? "Oui" : "Non" }))); }
    else addSheet("Export", exportRows(data, scope));
    return workbook;
}

function buildExportPdf(data, options) {
    return new Promise((resolve, reject) => {
        const pdf = new PDFDocument({ size: "A4", margin: 44, info: { Title: "Export comptable", Author: "Depann’Home Pro" } });
        const chunks = [];
        pdf.on("data", chunk => chunks.push(chunk)); pdf.on("end", () => resolve(Buffer.concat(chunks))); pdf.on("error", reject);
        const rows = exportRows(data, options.scope);
        pdf.fillColor("#003b73").font("Helvetica-Bold").fontSize(20).text("EXPORT COMPTABLE");
        pdf.fillColor("#475569").font("Helvetica").fontSize(9).text(`Période : ${options.start || "début"} au ${options.end || "aujourd’hui"} · ${rows.length} ligne(s)`);
        pdf.moveDown();
        rows.slice(0, 120).forEach((row, index) => { if (pdf.y > 745) pdf.addPage(); pdf.fillColor(index % 2 ? "#172033" : "#334155").fontSize(8).text(Object.entries(row).map(([key, value]) => `${key}: ${value}`).join(" · "), { width: 505 }); });
        if (rows.length > 120) pdf.fillColor("#475569").text("Export tronqué dans cet aperçu PDF. Utilisez CSV ou Excel pour l’intégralité des lignes.");
        pdf.end();
    });
}

function paymentStatus(document, total, settled) {
    if (settled >= total - 0.01) return "paid";
    if (document.dueDate && document.dueDate < today()) return "overdue";
    return settled > 0 ? "partial" : "unpaid";
}
function weightedVatRate(lines) { const total = (lines || []).reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unit_price ?? line.unitPrice ?? 0), 0); return total ? roundMoney((lines || []).reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unit_price ?? line.unitPrice ?? 0) * Number(line.vat_rate ?? line.vatRate ?? 0), 0) / total) : 20; }
function today() { return new Date().toISOString().slice(0, 10); }
function exportFileBase(options) { return `export-comptable-${options.scope}-${options.start || "complet"}-${options.end || today()}`.replace(/[^a-z0-9_-]/gi, "-"); }
function sendTextDownload(response, content, filename, contentType) { response.set({ "Content-Type": contentType, "Content-Disposition": `attachment; filename=\"${filename}\"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }); response.send(content); }
function roundMoney(value) { return Math.round((Number(value) || 0) * 100) / 100; }
function safeMoney(value) { const number = Number(value); return Number.isFinite(number) && number >= 0 && number <= 100000000 ? roundMoney(number) : null; }
function positiveMoney(value) { const number = safeMoney(value); return number !== null && number > 0 ? number : null; }
function positiveId(value) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : 0; }
function cleanText(value, max) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, max); }
function sanitizeDate(value) { const date = String(value || ""); return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(new Date(`${date}T12:00:00`).getTime()) ? date : ""; }
function asyncHandler(handler) { return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next); }
