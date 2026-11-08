import crypto from "node:crypto";
import multer from "multer";
import PDFDocument from "pdfkit";
import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";
import { hasBillingWorkspaceAccess, hasInternalBusinessWorkspaceAccess } from "./workstation-permissions.js";
import { strictDateOnly } from "./date-validation.js";

const ADMIN_ROLES = new Set(["admin", "pc_standard", "commercial", "mobile_admin"]);
const MANAGER_ROLES = new Set(["admin", "pc_standard", "mobile_admin"]);
const MAX_SIGNED_PDF_BYTES = 10 * 1024 * 1024;
const DEFAULT_TEMPLATE = Object.freeze({
    introduction: "Le présent document décrit les modalités du contrat de maintenance conclu entre les parties identifiées ci-dessus.",
    scope: "Périmètre, équipements concernés et prestations : à préciser avant signature.",
    exclusions: "Exclusions et limites de prestation : à préciser avant signature.",
    paymentTerms: "Montant, périodicité et modalités de paiement : à confirmer par les parties.",
    renewalTerms: "Modalités de renouvellement : confirmer la règle applicable avant signature.",
    cancellationTerms: "Conditions et modalités de résiliation : à préciser avant signature."
});
const signedPdfUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_SIGNED_PDF_BYTES, files: 1 },
    fileFilter: (_request, file, callback) => callback(null, file.mimetype === "application/pdf")
});

export function registerMaintenanceContractRoutes(app, requireAuthentication) {
    app.get("/api/business-suite/contracts/template", requireAuthentication, requireReadAccess, asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request);
        const result = await getPool().query(`SELECT introduction,scope,exclusions,
            payment_terms AS "paymentTerms",renewal_terms AS "renewalTerms",
            cancellation_terms AS "cancellationTerms"
            FROM depannhome_maintenance_contract_templates WHERE owner_id=$1`, [ownerId]);
        response.json({ template: { ...DEFAULT_TEMPLATE, ...result.rows[0] } });
    }));

    app.put("/api/business-suite/contracts/template", requireAuthentication, requireManager, requireInternalWorkspace, asyncHandler(async (request, response) => {
        const template = sanitizeContractTemplate(request.body);
        if (!template.ok) return response.status(400).json({ message: template.message });
        await getPool().query(`
            INSERT INTO depannhome_maintenance_contract_templates
                (owner_id,introduction,scope,exclusions,payment_terms,renewal_terms,cancellation_terms,updated_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,NOW())
            ON CONFLICT(owner_id) DO UPDATE SET introduction=EXCLUDED.introduction,
                scope=EXCLUDED.scope,exclusions=EXCLUDED.exclusions,payment_terms=EXCLUDED.payment_terms,
                renewal_terms=EXCLUDED.renewal_terms,cancellation_terms=EXCLUDED.cancellation_terms,
                updated_at=NOW()
        `, [getAccountOwnerId(request), template.introduction, template.scope, template.exclusions, template.paymentTerms, template.renewalTerms, template.cancellationTerms]);
        response.status(204).end();
    }));

    app.get("/api/business-suite/contracts/:contractId/documents/:documentId", requireAuthentication, requireReadAccess, asyncHandler(async (request, response) => {
        const contractId = positiveId(request.params.contractId);
        const documentId = positiveId(request.params.documentId);
        if (!contractId || !documentId) return response.status(400).json({ message: "Document de contrat invalide." });
        const { rows } = await getPool().query(`
            SELECT file_name AS "fileName",mime_type AS "mimeType",pdf_data AS data,sha256
            FROM depannhome_maintenance_contract_documents
            WHERE owner_id=$1 AND contract_id=$2 AND id=$3
        `, [getAccountOwnerId(request), contractId, documentId]);
        if (!rows[0]) return response.status(404).json({ message: "Document de contrat introuvable." });
        if (hashPdf(rows[0].data) !== rows[0].sha256) return response.status(500).json({ message: "L’empreinte du document archivé ne correspond plus au fichier. Contactez l’administrateur." });
        response.type("application/pdf");
        response.set("Content-Disposition", `inline; filename="${downloadName(rows[0].fileName)}"`);
        response.send(rows[0].data);
    }));

    app.post("/api/business-suite/contracts/:contractId/documents/generate", requireAuthentication, requireAdministration, requireInternalWorkspace, asyncHandler(async (request, response) => {
        const contract = await loadContractSnapshot(getAccountOwnerId(request), positiveId(request.params.contractId));
        if (!contract) return response.status(404).json({ message: "Contrat introuvable." });
        if (["cancelled", "expired"].includes(contract.status)) return response.status(409).json({ message: "Un contrat annulé ou expiré ne peut pas produire un nouveau projet." });
        const snapshot = { ...contract, generatedAt: new Date().toISOString(), template: await loadContractTemplate(getAccountOwnerId(request)) };
        const pdf = await createMaintenanceContractPdf(snapshot);
        const sha256 = hashPdf(pdf);
        const fileName = `contrat-${safeFilePart(contract.reference)}-projet.pdf`;
        const { rows } = await getPool().query(`
            INSERT INTO depannhome_maintenance_contract_documents
                (owner_id,contract_id,document_kind,file_name,mime_type,pdf_data,sha256,snapshot,created_by)
            VALUES($1,$2,'generated',$3,'application/pdf',$4,$5,$6::jsonb,$7)
            RETURNING id,created_at AS "createdAt"
        `, [getAccountOwnerId(request), contract.id, fileName, pdf, sha256, JSON.stringify(snapshot), request.user?.sub || null]);
        response.status(201).json({ id: rows[0].id, fileName, sha256, createdAt: rows[0].createdAt, draft: true });
    }));

    app.post("/api/business-suite/contracts/:contractId/documents/signed", requireAuthentication, requireAdministration, requireInternalWorkspace, signedPdfUpload.single("file"), asyncHandler(async (request, response) => {
        const contractId = positiveId(request.params.contractId);
        if (!contractId) return response.status(400).json({ message: "Contrat invalide." });
        const ownerId = getAccountOwnerId(request);
        const contract = await getPool().query("SELECT id,reference FROM depannhome_maintenance_contracts WHERE id=$1 AND owner_id=$2", [contractId, ownerId]);
        if (!contract.rows[0]) return response.status(404).json({ message: "Contrat introuvable." });
        if (!request.file || !request.file.buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) return response.status(400).json({ message: "Sélectionnez un fichier PDF valide signé hors du logiciel." });
        if (!await isValidPdf(request.file.buffer)) return response.status(400).json({ message: "Le fichier transmis n’est pas un PDF lisible." });
        const draft = await getPool().query("SELECT 1 FROM depannhome_maintenance_contract_documents WHERE owner_id=$1 AND contract_id=$2 AND document_kind='generated' LIMIT 1", [ownerId, contractId]);
        if (!draft.rowCount) return response.status(409).json({ message: "Générez d’abord le projet de contrat à faire signer." });
        const existing = await getPool().query("SELECT 1 FROM depannhome_maintenance_contract_documents WHERE owner_id=$1 AND contract_id=$2 AND document_kind='signed'", [ownerId, contractId]);
        if (existing.rowCount) return response.status(409).json({ message: "Un document signé est déjà archivé pour ce contrat." });
        const sha256 = hashPdf(request.file.buffer);
        const fileName = `contrat-${safeFilePart(contract.rows[0].reference)}-signe.pdf`;
        try {
            const { rows } = await getPool().query(`
                INSERT INTO depannhome_maintenance_contract_documents
                    (owner_id,contract_id,document_kind,file_name,mime_type,pdf_data,sha256,snapshot,created_by)
                VALUES($1,$2,'signed',$3,'application/pdf',$4,$5,$6::jsonb,$7)
                RETURNING id,created_at AS "createdAt"
            `, [ownerId, contractId, fileName, request.file.buffer, sha256, JSON.stringify({ originalFileName: cleanText(request.file.originalname, 255), uploadedAt: new Date().toISOString(), manualArchive: true }), request.user?.sub || null]);
            response.status(201).json({ id: rows[0].id, fileName, sha256, createdAt: rows[0].createdAt, activatesContract: false });
        } catch (error) {
            if (error.code === "23505") return response.status(409).json({ message: "Un document signé est déjà archivé pour ce contrat." });
            throw error;
        }
    }));

    app.post("/api/business-suite/contracts/:contractId/renew", requireAuthentication, requireAdministration, requireInternalWorkspace, asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request);
        const contractId = positiveId(request.params.contractId);
        const reference = cleanText(request.body?.reference, 100);
        const startsOn = strictDateOnly(request.body?.startsOn);
        const endsOn = optionalDate(request.body?.endsOn);
        const nextServiceOn = optionalDate(request.body?.nextServiceOn);
        const nextInvoiceOn = optionalDate(request.body?.nextInvoiceOn);
        if (!contractId || !reference || !startsOn || invalidOptionalDate(request.body?.endsOn, endsOn) || invalidOptionalDate(request.body?.nextServiceOn, nextServiceOn) || invalidOptionalDate(request.body?.nextInvoiceOn, nextInvoiceOn) || endsOn && endsOn < startsOn) {
            return response.status(400).json({ message: "Référence ou dates du renouvellement invalides." });
        }
        const database = await getPool().connect();
        try {
            await database.query("BEGIN");
            const { rows } = await database.query(`SELECT * FROM depannhome_maintenance_contracts
                WHERE id=$1 AND owner_id=$2 FOR UPDATE`, [contractId, ownerId]);
            const source = rows[0];
            if (!source) {
                await database.query("ROLLBACK");
                return response.status(404).json({ message: "Contrat introuvable." });
            }
            if (["cancelled", "draft"].includes(source.status)) {
                await database.query("ROLLBACK");
                return response.status(409).json({ message: "Seul un contrat actif ou arrivé à échéance peut être renouvelé." });
            }
            const created = await database.query(`
                INSERT INTO depannhome_maintenance_contracts
                    (owner_id,client_id,site_id,equipment_id,reference,title,status,starts_on,ends_on,
                     frequency_months,next_service_on,sla_hours,annual_amount_ht,notes,service_description,
                     billing_interval_months,billing_amount_ht,billing_vat_rate,next_invoice_on)
                VALUES($1,$2,$3,$4,$5,$6,'draft',$7::date,$8::date,$9,$10::date,$11,$12,$13,$14,$15,$16,$17,$18::date)
                RETURNING id
            `, [ownerId, source.client_id, source.site_id, source.equipment_id, reference, source.title, startsOn,
                endsOn || null, source.frequency_months, nextServiceOn || null, source.sla_hours,
                source.annual_amount_ht, source.notes, source.service_description || "",
                source.billing_interval_months || 12, source.billing_amount_ht || 0,
                source.billing_vat_rate ?? 20, nextInvoiceOn || startsOn]);
            await database.query("COMMIT");
            response.status(201).json({ id: created.rows[0].id, status: "draft", requiresManualActivation: true });
        } catch (error) {
            await database.query("ROLLBACK");
            if (error.code === "23505") return response.status(409).json({ message: "Cette référence de contrat existe déjà." });
            throw error;
        } finally {
            database.release();
        }
    }));

    app.post("/api/business-suite/contracts/:contractId/invoice-drafts", requireAuthentication, requireManager, requireInternalWorkspace, requireBillingAccess, asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request);
        const contractId = positiveId(request.params.contractId);
        if (!contractId) return response.status(400).json({ message: "Contrat invalide." });
        const database = await getPool().connect();
        try {
            await database.query("BEGIN");
            const { rows } = await database.query(`SELECT contract.*,client.client_data AS "clientData",
                client.client_status AS "clientStatus",(contract.next_invoice_on<=CURRENT_DATE) AS "invoiceDue",
                TO_CHAR(contract.next_invoice_on,'YYYY-MM-DD') AS "periodStart"
                FROM depannhome_maintenance_contracts contract
                JOIN depannhome_clients client ON client.owner_id=contract.owner_id AND client.client_id=contract.client_id
                WHERE contract.id=$1 AND contract.owner_id=$2 FOR UPDATE OF contract`, [contractId, ownerId]);
            const contract = rows[0];
            if (!contract) {
                await database.query("ROLLBACK");
                return response.status(404).json({ message: "Contrat ou client introuvable." });
            }
            if (contract.status !== "active" || contract.clientStatus !== "active") {
                await database.query("ROLLBACK");
                return response.status(409).json({ message: "Le contrat et le client doivent être actifs pour préparer une facture." });
            }
            if (!contract.next_invoice_on || !contract.invoiceDue) {
                await database.query("ROLLBACK");
                return response.status(409).json({ message: "Aucune échéance de facturation n’est due." });
            }
            const amount = Number(contract.billing_amount_ht);
            if (!Number.isFinite(amount) || amount <= 0) {
                await database.query("ROLLBACK");
                return response.status(409).json({ message: "Le montant de facturation périodique doit être supérieur à zéro." });
            }
            const periodStart = strictDateOnly(contract.periodStart);
            const client = contract.clientData || {};
            const customerName = cleanText(client.name || client.company || [client.firstName, client.lastName].filter(Boolean).join(" ") || "Client", 160);
            const customerAddress = cleanText([client.billingAddress || client.address, client.postalCode, client.city].filter(Boolean).join(", "), 500);
            const { rows: profileRows } = await database.query("SELECT vat_regime,tax_number FROM depannhome_billing_profiles WHERE owner_id=$1", [ownerId]);
            const vatRegime = profileRows[0]?.vat_regime === "franchise" ? "franchise" : "standard";
            const vatRate = vatRegime === "franchise" ? 0 : Number(contract.billing_vat_rate);
            const draftReference = `BROUILLON-FAC-${crypto.randomUUID()}`;
            const line = [{ description: cleanText(contract.service_description || contract.title, 500), quantity: 1, unit: "forfait", unitPrice: amount, vatRate }];
            const legalData = { billingAddress: customerAddress, operationCategory: "services" };
            const financialData = { discountMode: "fixed", discountAmount: 0, depositAmount: 0, depositDate: "", depositMethod: "", depositReference: "", conditions: "", comments: `Échéance du contrat ${contract.reference}`, aids: [] };
            const { rows: invoiceRows } = await database.query(`
                INSERT INTO depannhome_billing_documents
                    (owner_id,created_by,created_by_name,document_type,document_number,client_id,customer_type,
                     customer_name,customer_address,issue_date,status,vat_regime,issuer_tax_number,lines,
                     legal_data,notes,financial_data)
                VALUES($1,$2,$3,'invoice',$4,$5,$6,$7,$8,CURRENT_DATE,'draft',$9,$10,$11::jsonb,$12::jsonb,$13,$14::jsonb)
                RETURNING id,document_number AS "documentNumber"
            `, [ownerId, request.user?.sub || null, cleanText(request.user?.fullName || request.user?.username, 160),
                draftReference, contract.client_id, client.company ? "Professionnel" : "Particulier", customerName,
                customerAddress, vatRegime, cleanText(profileRows[0]?.tax_number, 100),
                JSON.stringify(line), JSON.stringify(legalData), `Brouillon à vérifier avant émission. Contrat ${contract.reference}.`,
                JSON.stringify(financialData)]);
            await database.query(`INSERT INTO depannhome_contract_invoice_drafts
                (owner_id,contract_id,period_start,billing_document_id,amount_ht)
                VALUES($1,$2,$3::date,$4,$5)`, [ownerId, contractId, periodStart, invoiceRows[0].id, amount]);
            await database.query(`UPDATE depannhome_maintenance_contracts
                SET next_invoice_on=next_invoice_on+(billing_interval_months*INTERVAL '1 month'),updated_at=NOW()
                WHERE owner_id=$1 AND id=$2`, [ownerId, contractId]);
            await database.query("COMMIT");
            response.status(201).json({ id: invoiceRows[0].id, documentNumber: invoiceRows[0].documentNumber, status: "draft", periodStart, amountHt: amount });
        } catch (error) {
            await database.query("ROLLBACK");
            if (error.code === "23505") return response.status(409).json({ message: "Un brouillon existe déjà pour cette échéance." });
            throw error;
        } finally {
            database.release();
        }
    }));
}

export function sanitizeContractTemplate(value) {
    const output = {};
    for (const [field, maximum] of Object.entries({ introduction: 3000, scope: 5000, exclusions: 5000, paymentTerms: 3000, renewalTerms: 3000, cancellationTerms: 3000 })) {
        if (typeof value?.[field] !== "string" || value[field].length > maximum) return { ok: false, message: `Le champ ${field} est invalide ou trop long.` };
        output[field] = cleanText(value[field], maximum);
    }
    return { ok: true, ...output };
}

export function createMaintenanceContractPdf(snapshot) {
    return new Promise((resolve, reject) => {
        const pdf = new PDFDocument({ size: "A4", margin: 48, info: { Title: `Projet de contrat ${snapshot.reference}`, Author: snapshot.company?.name || "Depann'Home Pro" } });
        const chunks = [];
        pdf.on("data", chunk => chunks.push(chunk));
        pdf.on("error", reject);
        pdf.on("end", () => resolve(Buffer.concat(chunks)));
        pdf.fillColor("#172033").font("Helvetica-Bold").fontSize(18).text("CONTRAT DE MAINTENANCE", { align: "center" });
        pdf.moveDown(0.35).fillColor("#a13d16").fontSize(10).text("PROJET - A relire et valider avant signature", { align: "center" });
        pdf.moveDown(1);
        pdf.fillColor("#172033");
        pdf.font("Helvetica-Bold").fontSize(12).text("Reference et objet");
        pdf.font("Helvetica").fontSize(10).text(`${snapshot.reference} - ${snapshot.title}`);
        section(pdf, "Prestataire", [snapshot.company?.name, snapshot.company?.legalForm, snapshot.company?.address, snapshot.company?.registrationNumber, snapshot.company?.email, snapshot.company?.phone].filter(Boolean).join("\n") || "Coordonnees de l'entreprise a completer.");
        section(pdf, "Client", [snapshot.client?.name, snapshot.client?.address, snapshot.client?.email, snapshot.client?.phone].filter(Boolean).join("\n") || "Coordonnees du client a completer.");
        section(pdf, "Site et equipement", [snapshot.site?.name, snapshot.site?.address, snapshot.equipment?.name, snapshot.equipment?.serialNumber].filter(Boolean).join("\n") || "Aucun site ou equipement rattache.");
        section(pdf, "Durée et suivi", `Début : ${snapshot.startsOn || "à préciser"}\nFin : ${snapshot.endsOn || "non renseignée"}\nFréquence des visites : ${snapshot.frequencyMonths || 12} mois\nProchaine visite : ${snapshot.nextServiceOn || "à planifier"}\nDélai d'intervention (SLA) : ${snapshot.slaHours || 0} heure(s)\nMontant annuel HT indicatif : ${Number(snapshot.annualAmountHt || 0).toFixed(2)} EUR\nFacturation périodique prévue : ${Number(snapshot.billingAmountHt || 0).toFixed(2)} EUR HT tous les ${snapshot.billingIntervalMonths || 12} mois\nProchaine échéance de facturation : ${snapshot.nextInvoiceOn || "non définie"}`);
        section(pdf, "Prestations prevues", snapshot.serviceDescription || "Prestations et equipements a preciser avant signature.");
        section(pdf, "Introduction", snapshot.template?.introduction || DEFAULT_TEMPLATE.introduction);
        section(pdf, "Perimetre des prestations", snapshot.template?.scope || DEFAULT_TEMPLATE.scope);
        section(pdf, "Exclusions", snapshot.template?.exclusions || DEFAULT_TEMPLATE.exclusions);
        section(pdf, "Paiement", snapshot.template?.paymentTerms || DEFAULT_TEMPLATE.paymentTerms);
        section(pdf, "Renouvellement", snapshot.template?.renewalTerms || DEFAULT_TEMPLATE.renewalTerms);
        section(pdf, "Resiliation", snapshot.template?.cancellationTerms || DEFAULT_TEMPLATE.cancellationTerms);
        pdf.moveDown(1).font("Helvetica").fontSize(10).text("Fait en deux exemplaires. La signature est recueillie en dehors du logiciel; importer ensuite le PDF signe pour archivage.", { align: "left" });
        pdf.moveDown(2).font("Helvetica-Bold").text("Le prestataire : ____________________        Le client : ____________________");
        pdf.moveDown(1).font("Helvetica").text("Date : ______________________________        Date : _________________________");
        pdf.end();
    });
}

function section(pdf, title, text) {
    pdf.moveDown(0.8).font("Helvetica-Bold").fontSize(11).fillColor("#0a5c36").text(title);
    pdf.moveDown(0.25).font("Helvetica").fontSize(9.5).fillColor("#172033").text(String(text), { lineGap: 2 });
}

async function loadContractSnapshot(ownerId, contractId) {
    if (!contractId) return null;
    const { rows } = await getPool().query(`
        SELECT contract.id,contract.owner_id AS "ownerId",contract.client_id AS "clientId",
            contract.reference,contract.title,contract.status,
            TO_CHAR(contract.starts_on,'YYYY-MM-DD') AS "startsOn",
            TO_CHAR(contract.ends_on,'YYYY-MM-DD') AS "endsOn",
            contract.frequency_months AS "frequencyMonths",
            TO_CHAR(contract.next_service_on,'YYYY-MM-DD') AS "nextServiceOn",
            contract.sla_hours AS "slaHours",contract.annual_amount_ht::float AS "annualAmountHt",
            contract.service_description AS "serviceDescription",contract.billing_interval_months AS "billingIntervalMonths",
            contract.billing_amount_ht::float AS "billingAmountHt",TO_CHAR(contract.next_invoice_on,'YYYY-MM-DD') AS "nextInvoiceOn",
            client.client_data AS client,
            json_build_object('name',profile.company_name,'legalForm',profile.legal_form,'address',profile.address,
                'postalCode',profile.postal_code,'city',profile.city,'registrationNumber',profile.registration_number,
                'email',profile.email,'phone',profile.phone) AS company,
            CASE WHEN site.id IS NULL THEN NULL ELSE json_build_object('name',site.name,'address',
                concat_ws(', ',site.address,site.postal_code,site.city)) END AS site,
            CASE WHEN equipment.id IS NULL THEN NULL ELSE json_build_object('name',equipment.name,'serialNumber',equipment.serial_number) END AS equipment
        FROM depannhome_maintenance_contracts contract
        JOIN depannhome_clients client ON client.owner_id=contract.owner_id AND client.client_id=contract.client_id
        LEFT JOIN depannhome_billing_profiles profile ON profile.owner_id=contract.owner_id
        LEFT JOIN depannhome_client_sites site ON site.id=contract.site_id AND site.owner_id=contract.owner_id
        LEFT JOIN depannhome_client_equipment equipment ON equipment.id=contract.equipment_id AND equipment.owner_id=contract.owner_id
        WHERE contract.id=$1 AND contract.owner_id=$2
    `, [contractId, ownerId]);
    const row = rows[0];
    if (!row) return null;
    const client = row.client || {};
    return {
        ...row,
        client: {
            name: cleanText(client.name || client.company || [client.firstName, client.lastName].filter(Boolean).join(" "), 160),
            address: cleanText([client.billingAddress || client.address, client.postalCode, client.city].filter(Boolean).join(", "), 500),
            email: cleanText(client.email, 160),
            phone: cleanText(client.phone, 50)
        }
    };
}

async function loadContractTemplate(ownerId) {
    const { rows } = await getPool().query(`SELECT introduction,scope,exclusions,payment_terms AS "paymentTerms",
        renewal_terms AS "renewalTerms",cancellation_terms AS "cancellationTerms"
        FROM depannhome_maintenance_contract_templates WHERE owner_id=$1`, [ownerId]);
    return { ...DEFAULT_TEMPLATE, ...rows[0] };
}

function requireReadAccess(request, response, next) {
    if (request.user?.role === "accountant" || ADMIN_ROLES.has(request.user?.role)) return requireInternalWorkspace(request, response, next);
    return response.status(403).json({ message: "Accès réservé aux postes administratifs." });
}

function requireAdministration(request, response, next) {
    if (!ADMIN_ROLES.has(request.user?.role)) return response.status(403).json({ message: "Fonction réservée aux postes administratifs." });
    next();
}

function requireManager(request, response, next) {
    if (!MANAGER_ROLES.has(request.user?.role)) return response.status(403).json({ message: "Fonction réservée aux responsables." });
    next();
}

function requireInternalWorkspace(request, response, next) {
    if (!hasInternalBusinessWorkspaceAccess(request.user)) return response.status(403).json({ message: "Fonction indisponible pour cette organisation ou pendant la prise en main Support." });
    next();
}

function requireBillingAccess(request, response, next) {
    if (!hasBillingWorkspaceAccess(request.user)) return response.status(403).json({ message: "Accès à la facturation non autorisé pour ce poste." });
    next();
}

function asyncHandler(handler) {
    return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

function positiveId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function cleanText(value, maximum) {
    return String(value || "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, maximum);
}

function optionalDate(value) {
    return value === undefined || value === null || value === "" ? "" : strictDateOnly(value);
}

function invalidOptionalDate(input, result) {
    return Boolean(input) && !result;
}

function hashPdf(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function isValidPdf(buffer) {
    try {
        const { PDFDocument } = await import("pdf-lib");
        const document = await PDFDocument.load(buffer, { updateMetadata: false });
        return document.getPageCount() > 0;
    } catch {
        return false;
    }
}

function safeFilePart(value) {
    return cleanText(value, 80).replace(/[^a-zA-Z0-9._-]/g, "-") || "contrat";
}

function downloadName(value) {
    return String(value || "contrat.pdf").replace(/[^a-zA-Z0-9._-]/g, "_");
}
