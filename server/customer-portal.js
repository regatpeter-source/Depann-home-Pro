import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";
import { getPortalBillingDocumentOutput } from "./billing.js";
import { sendCustomerPortalLinkEmail, sendCustomerQuoteDecisionEmail } from "./email.js";

const ADMIN_ROLES = new Set(["admin", "pc_standard", "commercial", "mobile_admin"]);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,180}$/;

export function registerCustomerPortalRoutes(app, requireAuthentication) {
    app.get("/api/customer-portal/links", requireAuthentication, requireAdministration, asyncHandler(async (request, response) => {
        const clientId = clean(request.query.clientId, 100);
        const { rows } = await getPool().query(`
            SELECT link.id,link.client_id AS "clientId",link.label,link.document_ids AS "documentIds",link.allow_quote_decision AS "allowQuoteDecision",
                link.expires_at AS "expiresAt",link.revoked_at AS "revokedAt",link.created_at AS "createdAt",link.last_accessed_at AS "lastAccessedAt",
                COUNT(event.id)::integer AS "accessCount"
            FROM depannhome_customer_portal_links link
            LEFT JOIN depannhome_customer_portal_events event ON event.portal_link_id=link.id AND event.event_type='view'
            WHERE link.owner_id=$1 AND ($2='' OR link.client_id=$2)
            GROUP BY link.id ORDER BY link.created_at DESC LIMIT 200
        `, [getAccountOwnerId(request), clientId]);
        response.json({ links: rows });
    }));

    app.post("/api/customer-portal/links", requireAuthentication, requireAdministration, asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request);
        const clientId = clean(request.body?.clientId, 100);
        const documentIds = uniquePositiveIds(request.body?.documentIds);
        const durationDays = boundedInteger(request.body?.durationDays, 1, 90, 14);
        if (!clientId || !documentIds.length) return response.status(400).json({ message: "Un client et au moins un document sont obligatoires." });
        const client = await getPool().query("SELECT client_data->>'name' AS name,client_data->>'email' AS email FROM depannhome_clients WHERE owner_id=$1 AND client_id=$2 AND client_status='active'", [ownerId, clientId]);
        if (!client.rows[0]) return response.status(404).json({ message: "Client introuvable." });
        const sendToClient = request.body?.sendEmail === true;
        const clientEmail = clean(client.rows[0].email, 254);
        if (sendToClient && !isEmail(clientEmail)) return response.status(400).json({ message: "Le client n’a pas d’adresse e-mail valide dans sa fiche." });
        const documents = await getPool().query("SELECT id,document_type AS type,document_number AS number FROM depannhome_billing_documents WHERE owner_id=$1 AND client_id=$2 AND id=ANY($3::bigint[])", [ownerId, clientId, documentIds]);
        if (documents.rowCount !== documentIds.length) return response.status(400).json({ message: "Un document n’appartient pas à ce client." });
        const snapshots = [];
        for (let index = 0; index < documents.rows.length; index += 5) {
            const batch = await Promise.all(documents.rows.slice(index, index + 5).map(async document => {
                const output = await getPortalBillingDocumentOutput(ownerId, document.id);
                if (!output || output.document.clientId !== clientId || output.document.documentType !== document.type) {
                    throw Object.assign(new Error("Un document n’a pas pu être préparé pour le portail."), { status: 409 });
                }
                return {
                    documentId: document.id,
                    documentType: document.type,
                    documentNumber: document.number,
                    filename: safeFilename(output.filename),
                    mimeType: output.mimeType,
                    buffer: output.buffer,
                    sha256: createHash("sha256").update(output.buffer).digest("hex")
                };
            }));
            snapshots.push(...batch);
        }
        const token = randomBytes(32).toString("base64url");
        const id = randomUUID();
        const expiresAt = new Date(Date.now() + durationDays * 86_400_000);
        const database = await getPool().connect();
        try {
            await database.query("BEGIN");
            await database.query(`INSERT INTO depannhome_customer_portal_links
                (id,owner_id,client_id,token_hash,label,document_ids,allow_quote_decision,expires_at,created_by)
                VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`, [id, ownerId, clientId, tokenHash(token), clean(request.body?.label, 160), JSON.stringify(documentIds), request.body?.allowQuoteDecision !== false, expiresAt, request.user.sub]);
            for (const snapshot of snapshots) {
                await database.query(`INSERT INTO depannhome_customer_portal_document_snapshots
                    (owner_id,portal_link_id,document_id,document_type,document_number,filename,mime_type,pdf_data,pdf_sha256)
                    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [ownerId, id, snapshot.documentId, snapshot.documentType, snapshot.documentNumber, snapshot.filename, snapshot.mimeType, snapshot.buffer, snapshot.sha256]);
            }
            await database.query("COMMIT");
        } catch (error) {
            await database.query("ROLLBACK");
            throw error;
        } finally {
            database.release();
        }
        const origin = String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || `${request.protocol}://${request.get("host")}`).replace(/\/$/, "");
        const url = `${origin}/portail/${token}`;
        let emailSent = false;
        let emailWarning = "";
        if (sendToClient) {
            try {
                const delivery = await sendCustomerPortalLinkEmail({
                    recipient: clientEmail,
                    recipientName: client.rows[0].name,
                    url,
                    expiresAt,
                    documentLabels: snapshots.map(snapshot => snapshot.documentNumber)
                });
                if (!delivery.accepted?.length) throw new Error("SMTP_RECIPIENT_REJECTED");
                emailSent = true;
            } catch (error) {
                emailWarning = "Le lien a été créé, mais l’e-mail n’a pas pu être envoyé. Copiez le lien pour le transmettre manuellement.";
                console.warn("[customer-portal] portal link email failed", error.code || error.name || "ERROR");
            }
        }
        response.status(201).json({ id, token, url, expiresAt, emailRequested: sendToClient, emailSent, emailWarning });
    }));

    app.post("/api/customer-portal/links/:linkId/revoke", requireAuthentication, requireAdministration, asyncHandler(async (request, response) => {
        const result = await getPool().query("UPDATE depannhome_customer_portal_links SET revoked_at=COALESCE(revoked_at,NOW()) WHERE id=$1::uuid AND owner_id=$2", [uuid(request.params.linkId), getAccountOwnerId(request)]);
        if (!result.rowCount) return response.status(404).json({ message: "Lien introuvable." });
        response.status(204).end();
    }));

    app.get("/api/customer-portal/quote-decisions", requireAuthentication, asyncHandler(async (request, response) => {
        const clientId = clean(request.query.clientId, 100);
        const { rows } = await getPool().query(`SELECT decision.id,decision.document_id AS "documentId",document.document_number AS "documentNumber",
            decision.decision,decision.signer_name AS "signerName",decision.signer_email AS "signerEmail",decision.message,decision.document_sha256 AS "documentSha256",decision.evidence,decision.decided_at AS "decidedAt",
            CASE WHEN notification.event_type='quote_decision_email_sent' THEN 'sent' WHEN notification.event_type='quote_decision_email_failed' THEN 'failed' ELSE 'unknown' END AS "notificationStatus"
            FROM depannhome_quote_decisions decision JOIN depannhome_billing_documents document ON document.id=decision.document_id AND document.owner_id=decision.owner_id
            LEFT JOIN LATERAL (SELECT event.event_type FROM depannhome_customer_portal_events event
                WHERE event.owner_id=decision.owner_id AND event.portal_link_id=decision.portal_link_id AND event.document_id=decision.document_id
                    AND event.event_type IN ('quote_decision_email_sent','quote_decision_email_failed')
                ORDER BY event.id DESC LIMIT 1) notification ON TRUE
            WHERE decision.owner_id=$1 AND ($2='' OR document.client_id=$2) ORDER BY decision.decided_at DESC`, [getAccountOwnerId(request), clientId]);
        response.json({ decisions: rows });
    }));

    app.post("/api/customer-portal/quote-decisions/:documentId/notify", requireAuthentication, requireAdministration, asyncHandler(async (request, response) => {
        const documentId = positiveId(request.params.documentId);
        if (!documentId) return response.status(400).json({ message: "Devis invalide." });
        const ownerId = getAccountOwnerId(request);
        const decision = await loadQuoteDecision(ownerId, documentId);
        if (!decision) return response.status(404).json({ message: "Décision introuvable." });
        const error = await attemptQuoteDecisionNotification(decision);
        const eventType = error ? "quote_decision_email_failed" : "quote_decision_email_sent";
        await recordEvent(ownerId, decision.portalLinkId, documentId, eventType, error ? { reason: error.code || error.name || "ERROR" } : { recipient: decision.notificationEmail });
        if (error) {
            console.warn("[customer-portal] quote decision notification failed", error.code || error.name || "ERROR");
            return response.status(503).json({ message: "La décision est conservée, mais l’e-mail n’a pas pu être envoyé. Vérifiez la configuration et réessayez." });
        }
        response.json({ sent: true });
    }));

    app.get("/portail/:token", asyncHandler(async (request, response) => {
        const link = await resolveLink(request.params.token);
        if (!link) return response.status(404).type("html").send(portalPage("Lien indisponible", "Ce lien est invalide, expiré ou révoqué."));
        await recordAccess(request, link, "view");
        const documents = await listDocuments(link);
        response.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }).type("html").send(renderPortal(link, documents, request.query.result));
    }));

    app.get("/portail/:token/documents/:documentId", asyncHandler(async (request, response) => {
        const link = await resolveLink(request.params.token);
        const documentId = positiveId(request.params.documentId);
        if (!link || !documentId || !link.documentIds.includes(documentId)) return response.status(404).send("Document introuvable.");
        const snapshot = await getPortalDocumentSnapshot(link, documentId);
        if (!snapshot) return response.status(404).send("Document introuvable.");
        await recordAccess(request, link, "download", documentId, { documentSha256: snapshot.sha256 });
        response.set({ "Content-Type": snapshot.mimeType, "Content-Disposition": `inline; filename="${snapshot.filename}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }).send(snapshot.buffer);
    }));

    app.post("/portail/:token/devis/:documentId/decision", asyncHandler(async (request, response) => {
        const link = await resolveLink(request.params.token);
        const documentId = positiveId(request.params.documentId);
        const decision = ["accepted", "refused"].includes(request.body?.decision) ? request.body.decision : "";
        const signerName = clean(request.body?.signerName, 160);
        const signerEmail = clean(request.body?.signerEmail, 254);
        if (!link || !link.allowQuoteDecision || !documentId || !link.documentIds.includes(documentId) || !decision || !signerName) return response.status(400).type("html").send(portalPage("Décision impossible", "Les informations transmises sont invalides."));
        const snapshot = await getPortalDocumentSnapshot(link, documentId);
        if (!snapshot || snapshot.documentType !== "quote") return response.status(404).send("Devis introuvable.");
        const database = await getPool().connect();
        let decisionCreated = false;
        try {
            await database.query("BEGIN");
            const activeLink = await database.query("SELECT id FROM depannhome_customer_portal_links WHERE id=$1 AND owner_id=$2 AND revoked_at IS NULL AND expires_at>NOW() FOR UPDATE", [link.id, link.ownerId]);
            if (!activeLink.rows[0]) throw Object.assign(new Error("Ce lien est invalide, expiré ou révoqué."), { status: 404 });
            const locked = await database.query("SELECT document_type AS type,status FROM depannhome_billing_documents WHERE id=$1 AND owner_id=$2 AND client_id=$3 FOR UPDATE", [documentId, link.ownerId, link.clientId]);
            if (locked.rows[0]?.type !== "quote") throw Object.assign(new Error("Devis introuvable."), { status: 404 });
            const quoteStatus = String(locked.rows[0].status || "").trim().toLowerCase();
            if (["draft", "brouillon"].includes(quoteStatus)) {
                throw Object.assign(new Error("Ce devis doit être finalisé et envoyé avant de recevoir une décision."), { status: 409 });
            }
            if (["cancelled", "canceled", "annulé", "annule"].includes(quoteStatus)) {
                throw Object.assign(new Error("Ce devis a été annulé et ne peut plus recevoir de décision."), { status: 409 });
            }
            const viewedPdf = await database.query(`SELECT 1 FROM depannhome_customer_portal_events
                WHERE owner_id=$1 AND portal_link_id=$2 AND document_id=$3 AND event_type='download'
                    AND details->>'documentSha256'=$4 LIMIT 1`, [link.ownerId, link.id, documentId, snapshot.sha256]);
            if (!viewedPdf.rowCount) throw Object.assign(new Error("Consultez le PDF du devis avant d’enregistrer votre décision."), { status: 409 });
            const previous = await database.query("SELECT decision FROM depannhome_quote_decisions WHERE owner_id=$1 AND document_id=$2", [link.ownerId, documentId]);
            if (previous.rows[0] && previous.rows[0].decision !== decision) throw Object.assign(new Error("Une décision définitive différente a déjà été enregistrée."), { status: 409 });
            if (!previous.rows[0]) {
                await database.query(`INSERT INTO depannhome_quote_decisions(owner_id,document_id,portal_link_id,decision,signer_name,signer_email,message,document_sha256,evidence)
                    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`, [link.ownerId, documentId, link.id, decision, signerName, signerEmail, clean(request.body?.message, 1000), snapshot.sha256, JSON.stringify(evidence(request))]);
                await database.query("UPDATE depannhome_billing_documents SET status=$3,updated_at=NOW() WHERE id=$1 AND owner_id=$2", [documentId, link.ownerId, decision]);
                decisionCreated = true;
            }
            await database.query("COMMIT");
        } catch (error) {
            await database.query("ROLLBACK");
            throw error;
        } finally { database.release(); }
        await recordAccess(request, link, `quote_${decision}`, documentId, { documentSha256: snapshot.sha256 });
        if (!decisionCreated) {
            return response.redirect(303, `/portail/${encodeURIComponent(request.params.token)}?result=${decision}`);
        }
        const savedDecision = await loadQuoteDecision(link.ownerId, documentId);
        const notificationError = await attemptQuoteDecisionNotification(savedDecision);
        const notificationEvent = notificationError ? "quote_decision_email_failed" : "quote_decision_email_sent";
        await recordEvent(link.ownerId, link.id, documentId, notificationEvent, notificationError
            ? { reason: notificationError.code || notificationError.name || "ERROR" }
            : { recipient: savedDecision.notificationEmail });
        if (notificationError) {
            const error = notificationError;
            console.warn("[customer-portal] quote decision notification failed", error.code || error.name || "ERROR");
        }
        response.redirect(303, `/portail/${encodeURIComponent(request.params.token)}?result=${decision}`);
    }));
}

async function resolveLink(rawToken) {
    if (!TOKEN_PATTERN.test(String(rawToken || ""))) return null;
    const { rows } = await getPool().query(`SELECT id,owner_id AS "ownerId",client_id AS "clientId",label,document_ids AS "documentIds",allow_quote_decision AS "allowQuoteDecision",expires_at AS "expiresAt"
        FROM depannhome_customer_portal_links WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>NOW()`, [tokenHash(rawToken)]);
    if (!rows[0]) return null;
    rows[0].documentIds = uniquePositiveIds(rows[0].documentIds);
    rows[0].rawToken = String(rawToken);
    await getPool().query("UPDATE depannhome_customer_portal_links SET last_accessed_at=NOW() WHERE id=$1", [rows[0].id]);
    return rows[0];
}

async function listDocuments(link) {
    const { rows } = await getPool().query(`SELECT document.id,document.document_type AS "documentType",document.document_number AS "documentNumber",document.customer_name AS "customerName",TO_CHAR(document.issue_date,'DD/MM/YYYY') AS "issueDate",document.status,
        (document.document_type='quote' AND LOWER(BTRIM(COALESCE(document.status,''))) NOT IN ('draft','brouillon','cancelled','canceled','annulé','annule')) AS "canDecide",
        decision.decision,decision.decided_at AS "decidedAt"
        FROM depannhome_billing_documents document LEFT JOIN depannhome_quote_decisions decision ON decision.owner_id=document.owner_id AND decision.document_id=document.id
        WHERE document.owner_id=$1 AND document.client_id=$2 AND document.id=ANY($3::bigint[]) ORDER BY document.issue_date DESC,document.id DESC`, [link.ownerId, link.clientId, link.documentIds]);
    return rows;
}

async function getPortalDocumentSnapshot(link, documentId) {
    let { rows } = await getPool().query(`SELECT document_type AS "documentType",document_number AS "documentNumber",filename,mime_type AS "mimeType",pdf_data AS "buffer",pdf_sha256 AS sha256
        FROM depannhome_customer_portal_document_snapshots WHERE owner_id=$1 AND portal_link_id=$2 AND document_id=$3`, [link.ownerId, link.id, documentId]);
    if (!rows[0]) {
        const output = await getPortalBillingDocumentOutput(link.ownerId, documentId);
        if (!output || output.document.clientId !== link.clientId) return null;
        const snapshot = {
            documentType: output.document.documentType,
            documentNumber: output.document.documentNumber,
            filename: safeFilename(output.filename),
            mimeType: output.mimeType,
            buffer: output.buffer,
            sha256: createHash("sha256").update(output.buffer).digest("hex")
        };
        await getPool().query(`INSERT INTO depannhome_customer_portal_document_snapshots
            (owner_id,portal_link_id,document_id,document_type,document_number,filename,mime_type,pdf_data,pdf_sha256)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(portal_link_id,document_id) DO NOTHING`,
        [link.ownerId, link.id, documentId, snapshot.documentType, snapshot.documentNumber, snapshot.filename, snapshot.mimeType, snapshot.buffer, snapshot.sha256]);
        ({ rows } = await getPool().query(`SELECT document_type AS "documentType",document_number AS "documentNumber",filename,mime_type AS "mimeType",pdf_data AS "buffer",pdf_sha256 AS sha256
            FROM depannhome_customer_portal_document_snapshots WHERE owner_id=$1 AND portal_link_id=$2 AND document_id=$3`, [link.ownerId, link.id, documentId]));
    }
    if (!rows[0]) throw new Error("L’archive PDF du portail n’a pas pu être créée.");
    const snapshot = rows[0];
    snapshot.buffer = Buffer.from(snapshot.buffer);
    if (createHash("sha256").update(snapshot.buffer).digest("hex") !== snapshot.sha256.trim()) {
        throw new Error("L’empreinte de l’archive PDF du portail est invalide.");
    }
    return snapshot;
}

async function recordAccess(request, link, eventType, documentId = null, details = {}) {
    await getPool().query(`INSERT INTO depannhome_customer_portal_events(owner_id,portal_link_id,event_type,document_id,ip_hash,user_agent_hash,details)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, [link.ownerId, link.id, eventType, documentId, privateHash(request.ip), privateHash(request.get("User-Agent")), JSON.stringify(details)]);
}

async function loadQuoteDecision(ownerId, documentId) {
    const { rows } = await getPool().query(`SELECT decision.id,decision.portal_link_id AS "portalLinkId",decision.decision,decision.signer_name AS "signerName",
        decision.signer_email AS "signerEmail",decision.message,decision.decided_at AS "decidedAt",document.document_number AS "documentNumber",
        document.customer_name AS "clientName",profile.email AS "notificationEmail"
        FROM depannhome_quote_decisions decision
        JOIN depannhome_billing_documents document ON document.id=decision.document_id AND document.owner_id=decision.owner_id
        LEFT JOIN depannhome_billing_profiles profile ON profile.owner_id=decision.owner_id
        WHERE decision.owner_id=$1 AND decision.document_id=$2`, [ownerId, documentId]);
    return rows[0] || null;
}

async function sendQuoteDecisionNotification(decision) {
    if (!isEmail(decision.notificationEmail)) throw Object.assign(new Error("L’adresse e-mail de l’entreprise est absente ou invalide."), { code: "COMPANY_EMAIL_INVALID" });
    const delivery = await sendCustomerQuoteDecisionEmail({
        recipient: decision.notificationEmail,
        documentNumber: decision.documentNumber,
        clientName: decision.clientName,
        decision: decision.decision,
        signerName: decision.signerName,
        signerEmail: decision.signerEmail,
        message: decision.message,
        decidedAt: decision.decidedAt
    });
    if (!delivery.accepted?.length) throw Object.assign(new Error("Le destinataire a refusé la notification."), { code: "SMTP_RECIPIENT_REJECTED" });
}

async function attemptQuoteDecisionNotification(decision) {
    try {
        await sendQuoteDecisionNotification(decision);
        return null;
    } catch (error) {
        return error;
    }
}

async function recordEvent(ownerId, linkId, documentId, eventType, details) {
    await getPool().query(`INSERT INTO depannhome_customer_portal_events(owner_id,portal_link_id,event_type,document_id,details)
        VALUES($1,$2,$3,$4,$5::jsonb)`, [ownerId, linkId, eventType, documentId, JSON.stringify(details)]);
}

function renderPortal(link, documents, result) {
    const notice = result === "accepted" ? "<p class=success>Le devis a été accepté. Merci.</p>" : result === "refused" ? "<p class=success>Le refus du devis a été enregistré.</p>" : "";
    const cards = documents.map(document => {
        const label = document.documentType === "quote" ? "Devis" : document.documentType === "invoice" ? "Facture" : "Avoir";
        const decision = document.decision ? `<p><strong>Décision :</strong> ${document.decision === "accepted" ? "accepté" : "refusé"}</p>` : "";
        const form = document.documentType === "quote" && document.canDecide && link.allowQuoteDecision && !document.decision ? `<form method=post action="/portail/${escapeHtml(link.rawToken || "")}/devis/${document.id}/decision"><label>Votre nom<input name=signerName maxlength=160 required></label><label>E-mail (facultatif)<input name=signerEmail type=email maxlength=254></label><label>Message (facultatif)<textarea name=message maxlength=1000></textarea></label><p class=intro>Consultez le PDF avant de répondre. Cette action enregistre votre décision et l’empreinte du document. Elle ne constitue pas une signature électronique certifiée.</p><button name=decision value=accepted>Accepter le devis</button><button class=secondary name=decision value=refused>Refuser</button></form>` : "";
        return `<article><h2>${label} ${escapeHtml(document.documentNumber)}</h2><p>Émis le ${escapeHtml(document.issueDate)}</p><a class=button href="/portail/${escapeHtml(link.rawToken || "")}/documents/${document.id}" target=_blank rel=noopener>Consulter le PDF</a>${decision}${form}</article>`;
    }).join("") || "<p>Aucun document n’est disponible.</p>";
    return portalPage("Espace documentaire", `${notice}<p class=intro>Accès confidentiel valable jusqu’au ${new Date(link.expiresAt).toLocaleDateString("fr-FR")}.</p>${cards}`);
}

function portalPage(title, body) {
    return `<!doctype html><html lang=fr><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><meta name=color-scheme content="light dark"><title>${escapeHtml(title)} — Depann'Home Pro</title><style>
        :root{color-scheme:light;--page:#f3f6fb;--surface:#fff;--surface-alt:#eef3f8;--text:#172033;--muted:#526175;--border:#b7c5d8;--header:#102a43;--primary:#0b74de;--secondary:#64748b;--success-bg:#dcfce7;--success-text:#166534;--shadow:0 8px 28px #102a4314}
        *{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--text);font:16px system-ui,sans-serif}main{max-width:820px;margin:auto;padding:32px 18px}header{background:var(--header);color:#fff;padding:24px;border-radius:16px}header :is(h1,p){color:#fff}article{background:var(--surface);color:var(--text);border:1px solid var(--border);margin:18px 0;padding:22px;border-radius:14px;box-shadow:var(--shadow)}label{display:block;margin:14px 0;color:var(--text)}input,textarea{display:block;width:100%;padding:10px;margin-top:5px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text)}.button,button{display:inline-block;background:var(--primary);color:#fff;border:0;border-radius:8px;padding:10px 14px;text-decoration:none;margin:6px 6px 6px 0;cursor:pointer}.secondary{background:var(--secondary)}.success{padding:14px;background:var(--success-bg);color:var(--success-text);border-radius:10px}.intro{color:var(--muted)}
        @media(prefers-color-scheme:dark){:root{color-scheme:dark;--page:#0f172a;--surface:#172033;--surface-alt:#1e293b;--text:#e5edf6;--muted:#a8b5c5;--border:#3b4a60;--header:#0c2638;--primary:#2563a9;--secondary:#475569;--success-bg:#143323;--success-text:#bbf7d0;--shadow:0 8px 28px #0006}article{box-shadow:var(--shadow)}input:focus,textarea:focus{outline:2px solid #60a5fa;outline-offset:1px}.button:hover,button:hover{filter:brightness(1.15)}}
    </style></head><body><main><header><h1>${escapeHtml(title)}</h1><p>Depann'Home Pro — portail client sécurisé</p></header>${body}</main></body></html>`;
}

function evidence(request) { return { ipHash: privateHash(request.ip), userAgentHash: privateHash(request.get("User-Agent")), recordedAt: new Date().toISOString(), method: "secure_customer_portal" }; }
function tokenHash(value) { return createHash("sha256").update(String(value)).digest("hex"); }
function privateHash(value) { return createHmac("sha256", String(process.env.HEALTH_TELEMETRY_SECRET || process.env.SESSION_SECRET || "portal-audit")).update(String(value || "")).digest("hex"); }
function uniquePositiveIds(values) { return [...new Set((Array.isArray(values) ? values : []).map(positiveId).filter(Boolean))].slice(0, 100); }
function positiveId(value) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : 0; }
function boundedInteger(value, minimum, maximum, fallback) { const number = Number(value); return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback; }
function uuid(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || "")) ? value : "00000000-0000-0000-0000-000000000000"; }
function clean(value, maximum) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum); }
function isEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "")); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
function safeFilename(value) { return String(value || "document.pdf").replace(/[^a-z0-9_.-]+/gi, "-").slice(0, 120); }
function requireAdministration(request, response, next) { return ADMIN_ROLES.has(request.user?.role) ? next() : response.status(403).json({ message: "Fonction réservée aux postes administratifs." }); }
function asyncHandler(handler) { return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next); }
