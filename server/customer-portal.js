import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";
import { getPortalBillingDocumentOutput } from "./billing.js";

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
        const client = await getPool().query("SELECT client_data->>'name' AS name FROM depannhome_clients WHERE owner_id=$1 AND client_id=$2 AND client_status='active'", [ownerId, clientId]);
        if (!client.rows[0]) return response.status(404).json({ message: "Client introuvable." });
        const documents = await getPool().query("SELECT id,document_type AS type FROM depannhome_billing_documents WHERE owner_id=$1 AND client_id=$2 AND id=ANY($3::bigint[])", [ownerId, clientId, documentIds]);
        if (documents.rowCount !== documentIds.length) return response.status(400).json({ message: "Un document n’appartient pas à ce client." });
        const token = randomBytes(32).toString("base64url");
        const id = randomUUID();
        const expiresAt = new Date(Date.now() + durationDays * 86_400_000);
        await getPool().query(`INSERT INTO depannhome_customer_portal_links
            (id,owner_id,client_id,token_hash,label,document_ids,allow_quote_decision,expires_at,created_by)
            VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`, [id, ownerId, clientId, tokenHash(token), clean(request.body?.label, 160), JSON.stringify(documentIds), request.body?.allowQuoteDecision !== false, expiresAt, request.user.sub]);
        const origin = String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || `${request.protocol}://${request.get("host")}`).replace(/\/$/, "");
        response.status(201).json({ id, token, url: `${origin}/portail/${token}`, expiresAt });
    }));

    app.post("/api/customer-portal/links/:linkId/revoke", requireAuthentication, requireAdministration, asyncHandler(async (request, response) => {
        const result = await getPool().query("UPDATE depannhome_customer_portal_links SET revoked_at=COALESCE(revoked_at,NOW()) WHERE id=$1::uuid AND owner_id=$2", [uuid(request.params.linkId), getAccountOwnerId(request)]);
        if (!result.rowCount) return response.status(404).json({ message: "Lien introuvable." });
        response.status(204).end();
    }));

    app.get("/api/customer-portal/quote-decisions", requireAuthentication, asyncHandler(async (request, response) => {
        const clientId = clean(request.query.clientId, 100);
        const { rows } = await getPool().query(`SELECT decision.id,decision.document_id AS "documentId",document.document_number AS "documentNumber",
            decision.decision,decision.signer_name AS "signerName",decision.signer_email AS "signerEmail",decision.message,decision.document_sha256 AS "documentSha256",decision.evidence,decision.decided_at AS "decidedAt"
            FROM depannhome_quote_decisions decision JOIN depannhome_billing_documents document ON document.id=decision.document_id AND document.owner_id=decision.owner_id
            WHERE decision.owner_id=$1 AND ($2='' OR document.client_id=$2) ORDER BY decision.decided_at DESC`, [getAccountOwnerId(request), clientId]);
        response.json({ decisions: rows });
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
        const output = await getPortalBillingDocumentOutput(link.ownerId, documentId);
        if (!output || output.document.clientId !== link.clientId) return response.status(404).send("Document introuvable.");
        await recordAccess(request, link, "download", documentId);
        response.set({ "Content-Type": output.mimeType, "Content-Disposition": `inline; filename="${safeFilename(output.filename)}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }).send(output.buffer);
    }));

    app.post("/portail/:token/devis/:documentId/decision", asyncHandler(async (request, response) => {
        const link = await resolveLink(request.params.token);
        const documentId = positiveId(request.params.documentId);
        const decision = ["accepted", "refused"].includes(request.body?.decision) ? request.body.decision : "";
        const signerName = clean(request.body?.signerName, 160);
        const signerEmail = clean(request.body?.signerEmail, 254);
        if (!link || !link.allowQuoteDecision || !documentId || !link.documentIds.includes(documentId) || !decision || !signerName) return response.status(400).type("html").send(portalPage("Décision impossible", "Les informations transmises sont invalides."));
        const output = await getPortalBillingDocumentOutput(link.ownerId, documentId);
        if (!output || output.document.documentType !== "quote" || output.document.clientId !== link.clientId) return response.status(404).send("Devis introuvable.");
        const database = await getPool().connect();
        try {
            await database.query("BEGIN");
            const locked = await database.query("SELECT document_type FROM depannhome_billing_documents WHERE id=$1 AND owner_id=$2 AND client_id=$3 FOR UPDATE", [documentId, link.ownerId, link.clientId]);
            if (locked.rows[0]?.document_type !== "quote") throw Object.assign(new Error("Devis introuvable."), { status: 404 });
            const previous = await database.query("SELECT decision FROM depannhome_quote_decisions WHERE owner_id=$1 AND document_id=$2", [link.ownerId, documentId]);
            if (previous.rows[0] && previous.rows[0].decision !== decision) throw Object.assign(new Error("Une décision définitive différente a déjà été enregistrée."), { status: 409 });
            if (!previous.rows[0]) await database.query(`INSERT INTO depannhome_quote_decisions(owner_id,document_id,portal_link_id,decision,signer_name,signer_email,message,document_sha256,evidence)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`, [link.ownerId, documentId, link.id, decision, signerName, signerEmail, clean(request.body?.message, 1000), createHash("sha256").update(output.buffer).digest("hex"), JSON.stringify(evidence(request))]);
            await database.query("COMMIT");
        } catch (error) {
            await database.query("ROLLBACK");
            throw error;
        } finally { database.release(); }
        await recordAccess(request, link, `quote_${decision}`, documentId);
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
        decision.decision,decision.decided_at AS "decidedAt"
        FROM depannhome_billing_documents document LEFT JOIN depannhome_quote_decisions decision ON decision.owner_id=document.owner_id AND decision.document_id=document.id
        WHERE document.owner_id=$1 AND document.client_id=$2 AND document.id=ANY($3::bigint[]) ORDER BY document.issue_date DESC,document.id DESC`, [link.ownerId, link.clientId, link.documentIds]);
    return rows;
}

async function recordAccess(request, link, eventType, documentId = null) {
    await getPool().query(`INSERT INTO depannhome_customer_portal_events(owner_id,portal_link_id,event_type,document_id,ip_hash,user_agent_hash)
        VALUES($1,$2,$3,$4,$5,$6)`, [link.ownerId, link.id, eventType, documentId, privateHash(request.ip), privateHash(request.get("User-Agent"))]);
}

function renderPortal(link, documents, result) {
    const notice = result === "accepted" ? "<p class=success>Le devis a été accepté. Merci.</p>" : result === "refused" ? "<p class=success>Le refus du devis a été enregistré.</p>" : "";
    const cards = documents.map(document => {
        const label = document.documentType === "quote" ? "Devis" : document.documentType === "invoice" ? "Facture" : "Avoir";
        const decision = document.decision ? `<p><strong>Décision :</strong> ${document.decision === "accepted" ? "accepté" : "refusé"}</p>` : "";
        const form = document.documentType === "quote" && link.allowQuoteDecision && !document.decision ? `<form method=post action="/portail/${escapeHtml(link.rawToken || "")}/devis/${document.id}/decision"><label>Nom du signataire<input name=signerName maxlength=160 required></label><label>E-mail (facultatif)<input name=signerEmail type=email maxlength=254></label><label>Message (facultatif)<textarea name=message maxlength=1000></textarea></label><button name=decision value=accepted>Accepter le devis</button><button class=secondary name=decision value=refused>Refuser</button></form>` : "";
        return `<article><h2>${label} ${escapeHtml(document.documentNumber)}</h2><p>Émis le ${escapeHtml(document.issueDate)}</p><a class=button href="/portail/${escapeHtml(link.rawToken || "")}/documents/${document.id}" target=_blank rel=noopener>Consulter le PDF</a>${decision}${form}</article>`;
    }).join("") || "<p>Aucun document n’est disponible.</p>";
    return portalPage("Espace documentaire", `${notice}<p class=intro>Accès confidentiel valable jusqu’au ${new Date(link.expiresAt).toLocaleDateString("fr-FR")}.</p>${cards}`);
}

function portalPage(title, body) {
    return `<!doctype html><html lang=fr><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} — Depann'Home Pro</title><style>body{margin:0;background:#f3f6fb;color:#172033;font:16px system-ui,sans-serif}main{max-width:820px;margin:auto;padding:32px 18px}header{background:#102a43;color:white;padding:24px;border-radius:16px}article{background:white;margin:18px 0;padding:22px;border-radius:14px;box-shadow:0 8px 28px #102a4314}label{display:block;margin:14px 0}input,textarea{display:block;width:100%;box-sizing:border-box;padding:10px;margin-top:5px;border:1px solid #b7c5d8;border-radius:8px}.button,button{display:inline-block;background:#0b74de;color:white;border:0;border-radius:8px;padding:10px 14px;text-decoration:none;margin:6px 6px 6px 0;cursor:pointer}.secondary{background:#64748b}.success{padding:14px;background:#dcfce7;color:#166534;border-radius:10px}.intro{color:#526175}</style></head><body><main><header><h1>${escapeHtml(title)}</h1><p>Depann'Home Pro — portail client sécurisé</p></header>${body}</main></body></html>`;
}

function evidence(request) { return { ipHash: privateHash(request.ip), userAgentHash: privateHash(request.get("User-Agent")), recordedAt: new Date().toISOString(), method: "secure_customer_portal" }; }
function tokenHash(value) { return createHash("sha256").update(String(value)).digest("hex"); }
function privateHash(value) { return createHmac("sha256", String(process.env.HEALTH_TELEMETRY_SECRET || process.env.SESSION_SECRET || "portal-audit")).update(String(value || "")).digest("hex"); }
function uniquePositiveIds(values) { return [...new Set((Array.isArray(values) ? values : []).map(positiveId).filter(Boolean))].slice(0, 100); }
function positiveId(value) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : 0; }
function boundedInteger(value, minimum, maximum, fallback) { const number = Number(value); return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback; }
function uuid(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || "")) ? value : "00000000-0000-0000-0000-000000000000"; }
function clean(value, maximum) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
function safeFilename(value) { return String(value || "document.pdf").replace(/[^a-z0-9_.-]+/gi, "-").slice(0, 120); }
function requireAdministration(request, response, next) { return ADMIN_ROLES.has(request.user?.role) ? next() : response.status(403).json({ message: "Fonction réservée aux postes administratifs." }); }
function asyncHandler(handler) { return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next); }
