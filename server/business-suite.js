import { randomUUID } from "node:crypto";
import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";
import { hasInternalBusinessWorkspaceAccess } from "./workstation-permissions.js";
import { strictDateOnly } from "./date-validation.js";

const ADMIN_ROLES = new Set(["admin", "pc_standard", "commercial", "mobile_admin"]);
const MANAGER_ROLES = new Set(["admin", "pc_standard", "mobile_admin"]);
const MOVEMENT_TYPES = new Set(["in", "out", "adjustment", "consumption"]);

export function registerBusinessSuiteRoutes(app, requireAuthentication) {
    app.get("/api/business-suite/overview", requireAuthentication, requireReadAccess, asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request);
        const [clients, documents, events, purchases] = await Promise.all([
            getPool().query("SELECT client_id AS id,client_data->>'name' AS name FROM depannhome_clients WHERE owner_id=$1 AND client_status='active' AND COALESCE(client_data->>'isSandbox','false')<>'true' ORDER BY LOWER(client_data->>'name')", [ownerId]),
            getPool().query("SELECT id,client_id AS \"clientId\",document_type AS \"documentType\",document_number AS \"documentNumber\",customer_name AS \"customerName\",TO_CHAR(issue_date,'YYYY-MM-DD') AS \"issueDate\" FROM depannhome_billing_documents WHERE owner_id=$1 AND document_type IN ('quote','invoice') ORDER BY issue_date DESC,id DESC LIMIT 500", [ownerId]),
            getPool().query("SELECT id,title,client_id AS \"clientId\",client_name AS \"clientName\",TO_CHAR(event_date,'YYYY-MM-DD') AS \"eventDate\",event_status AS \"eventStatus\" FROM depannhome_calendar_events WHERE owner_id=$1 ORDER BY event_date DESC,id DESC LIMIT 500", [ownerId]),
            getPool().query("SELECT id,description,supplier,client_id AS \"clientId\",event_id AS \"eventId\",amount_ht::float AS \"amountHt\" FROM depannhome_purchases WHERE owner_id=$1 ORDER BY purchase_date DESC,id DESC LIMIT 500", [ownerId])
        ]);
        response.json({ clients: clients.rows, documents: documents.rows, events: events.rows, purchases: purchases.rows });
    }));

    app.get("/api/business-suite/clients/:clientId/assets", requireAuthentication, requireReadAccess, asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request);
        const clientId = clean(request.params.clientId, 100);
        const [sites, equipment, contracts] = await Promise.all([
            getPool().query(`SELECT id,name,address,postal_code AS "postalCode",city,contact_name AS "contactName",contact_phone AS "contactPhone",access_notes AS "accessNotes" FROM depannhome_client_sites WHERE owner_id=$1 AND client_id=$2 ORDER BY name`, [ownerId, clientId]),
            getPool().query(`SELECT id,site_id AS "siteId",name,category,brand,model,serial_number AS "serialNumber",TO_CHAR(installed_on,'YYYY-MM-DD') AS "installedOn",TO_CHAR(warranty_ends_on,'YYYY-MM-DD') AS "warrantyEndsOn",status,notes FROM depannhome_client_equipment WHERE owner_id=$1 AND client_id=$2 ORDER BY name`, [ownerId, clientId]),
            getPool().query(`SELECT contract.id,contract.site_id AS "siteId",contract.equipment_id AS "equipmentId",contract.reference,contract.title,contract.status,
                TO_CHAR(contract.starts_on,'YYYY-MM-DD') AS "startsOn",TO_CHAR(contract.ends_on,'YYYY-MM-DD') AS "endsOn",
                contract.frequency_months AS "frequencyMonths",TO_CHAR(contract.next_service_on,'YYYY-MM-DD') AS "nextServiceOn",
                contract.sla_hours AS "slaHours",contract.annual_amount_ht::float AS "annualAmountHt",contract.notes,
                contract.service_description AS "serviceDescription",contract.billing_interval_months AS "billingIntervalMonths",
                contract.billing_amount_ht::float AS "billingAmountHt",contract.billing_vat_rate::float AS "billingVatRate",
                TO_CHAR(contract.next_invoice_on,'YYYY-MM-DD') AS "nextInvoiceOn",
                COALESCE((SELECT json_agg(json_build_object('id',document.id,'kind',document.document_kind,
                    'fileName',document.file_name,'sha256',document.sha256,'createdAt',document.created_at)
                    ORDER BY document.created_at DESC,document.id DESC)
                    FROM depannhome_maintenance_contract_documents document
                    WHERE document.owner_id=contract.owner_id AND document.contract_id=contract.id),'[]'::json) AS documents,
                COALESCE((SELECT json_agg(json_build_object('id',invoice.billing_document_id,
                    'documentNumber',billing.document_number,'periodStart',TO_CHAR(invoice.period_start,'YYYY-MM-DD'),
                    'amountHt',invoice.amount_ht::float) ORDER BY invoice.period_start DESC)
                    FROM depannhome_contract_invoice_drafts invoice
                    JOIN depannhome_billing_documents billing ON billing.id=invoice.billing_document_id AND billing.owner_id=invoice.owner_id
                    WHERE invoice.owner_id=contract.owner_id AND invoice.contract_id=contract.id),'[]'::json) AS "invoiceDrafts"
                FROM depannhome_maintenance_contracts contract
                WHERE contract.owner_id=$1 AND contract.client_id=$2 ORDER BY contract.starts_on DESC,contract.id DESC`, [ownerId, clientId])
        ]);
        response.json({ sites: sites.rows, equipment: equipment.rows, contracts: contracts.rows });
    }));

    app.post("/api/business-suite/clients/:clientId/sites", requireAuthentication, requireAdministration, asyncHandler(async (request, response) => {
        const clientId = await requireClient(request);
        if (!clientId) return response.status(404).json({ message: "Client introuvable." });
        const name = clean(request.body?.name, 160);
        if (!name) return response.status(400).json({ message: "Le nom du site est obligatoire." });
        const { rows } = await getPool().query(`INSERT INTO depannhome_client_sites(owner_id,client_id,name,address,postal_code,city,contact_name,contact_phone,access_notes)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [getAccountOwnerId(request), clientId, name, clean(request.body?.address, 500), clean(request.body?.postalCode, 20), clean(request.body?.city, 120), clean(request.body?.contactName, 160), clean(request.body?.contactPhone, 50), clean(request.body?.accessNotes, 1000)]);
        response.status(201).json({ id: rows[0].id });
    }));

    app.post("/api/business-suite/clients/:clientId/equipment", requireAuthentication, requireAdministration, asyncHandler(async (request, response) => {
        const clientId = await requireClient(request);
        const ownerId = getAccountOwnerId(request);
        const name = clean(request.body?.name, 160);
        const siteId = optionalId(request.body?.siteId);
        if (!clientId) return response.status(404).json({ message: "Client introuvable." });
        if (!name || siteId && !await owns("depannhome_client_sites", siteId, ownerId, clientId)) return response.status(400).json({ message: "Nom ou site invalide." });
        const { rows } = await getPool().query(`INSERT INTO depannhome_client_equipment(owner_id,client_id,site_id,name,category,brand,model,serial_number,installed_on,warranty_ends_on,status,notes)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10::date,$11,$12) RETURNING id`, [ownerId, clientId, siteId, name, clean(request.body?.category, 100), clean(request.body?.brand, 100), clean(request.body?.model, 120), clean(request.body?.serialNumber, 160), dateOrNull(request.body?.installedOn), dateOrNull(request.body?.warrantyEndsOn), ["active", "maintenance", "retired"].includes(request.body?.status) ? request.body.status : "active", clean(request.body?.notes, 2000)]);
        response.status(201).json({ id: rows[0].id });
    }));

    app.post("/api/business-suite/clients/:clientId/contracts", requireAuthentication, requireAdministration, requireInternalBusinessWorkspace, asyncHandler(async (request, response) => {
        const clientId = await requireClient(request);
        const ownerId = getAccountOwnerId(request);
        const reference = clean(request.body?.reference, 100);
        const title = clean(request.body?.title, 160);
        const startsOn = strictDateOnly(request.body?.startsOn);
        const siteId = optionalId(request.body?.siteId);
        const equipmentId = optionalId(request.body?.equipmentId);
        if (!clientId) return response.status(404).json({ message: "Client introuvable." });
        const endsOn = request.body?.endsOn ? strictDateOnly(request.body.endsOn) : "";
        const nextServiceOn = request.body?.nextServiceOn ? strictDateOnly(request.body.nextServiceOn) : "";
        const nextInvoiceOn = request.body?.nextInvoiceOn ? strictDateOnly(request.body.nextInvoiceOn) : "";
        const status = request.body?.status || "draft";
        const rawAnnualAmount = Number(request.body?.annualAmountHt || 0);
        if (!reference || !title || !startsOn || request.body?.endsOn && !endsOn || request.body?.nextServiceOn && !nextServiceOn || request.body?.nextInvoiceOn && !nextInvoiceOn || endsOn && endsOn < startsOn || !["draft", "active", "suspended", "expired", "cancelled"].includes(status) || !Number.isFinite(rawAnnualAmount) || rawAnnualAmount < 0 || rawAnnualAmount > 100000000 || siteId && !await owns("depannhome_client_sites", siteId, ownerId, clientId) || equipmentId && !await owns("depannhome_client_equipment", equipmentId, ownerId, clientId)) return response.status(400).json({ message: "Les informations du contrat sont invalides." });
        const frequencyMonths = integer(request.body?.frequencyMonths, 1, 120, 12);
        const billingIntervalMonths = integer(request.body?.billingIntervalMonths, 1, 120, 12);
        const rawBillingAmount = Number(request.body?.billingAmountHt || 0);
        if (!Number.isFinite(rawBillingAmount) || rawBillingAmount < 0 || rawBillingAmount > 100000000 || request.body?.billingIntervalMonths && billingIntervalMonths !== Number(request.body.billingIntervalMonths)) {
            return response.status(400).json({ message: "Le montant ou la périodicité de facturation est invalide." });
        }
        const billingAmountHt = money(rawBillingAmount);
        const billingVatRate = request.body?.billingVatRate === undefined || request.body?.billingVatRate === "" ? 20 : Number(request.body.billingVatRate);
        if (!Number.isFinite(billingVatRate) || billingVatRate < 0 || billingVatRate > 100) return response.status(400).json({ message: "Le taux de TVA périodique est invalide." });
        const { rows } = await getPool().query(`INSERT INTO depannhome_maintenance_contracts(owner_id,client_id,site_id,equipment_id,reference,title,status,starts_on,ends_on,frequency_months,next_service_on,sla_hours,annual_amount_ht,notes,service_description,billing_interval_months,billing_amount_ht,billing_vat_rate,next_invoice_on)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$10,$11::date,$12,$13,$14,$15,$16,$17,$18,$19::date) RETURNING id`, [ownerId, clientId, siteId, equipmentId, reference, title, status, startsOn, endsOn || null, frequencyMonths, nextServiceOn || null, integer(request.body?.slaHours, 0, 8760, 0), money(rawAnnualAmount), clean(request.body?.notes, 2000), clean(request.body?.serviceDescription, 5000), billingIntervalMonths, billingAmountHt, billingVatRate, nextInvoiceOn || null]);
        response.status(201).json({ id: rows[0].id });
    }));

    app.patch("/api/business-suite/clients/:clientId/contracts/:contractId/schedule", requireAuthentication, requireAdministration, requireInternalBusinessWorkspace, asyncHandler(async (request, response) => {
        const clientId = clean(request.params.clientId, 100);
        const contractId = positiveId(request.params.contractId);
        const status = request.body?.status;
        const endsOn = request.body?.endsOn === "" || request.body?.endsOn === null ? null : strictDateOnly(request.body?.endsOn);
        const nextServiceOn = request.body?.nextServiceOn === "" || request.body?.nextServiceOn === null ? null : strictDateOnly(request.body?.nextServiceOn);
        if (!clientId || !contractId || !["draft", "active", "suspended", "expired", "cancelled"].includes(status) || endsOn === "" || nextServiceOn === "") {
            return response.status(400).json({ message: "Statut ou échéances du contrat invalides." });
        }
        const result = await getPool().query(`UPDATE depannhome_maintenance_contracts SET status=$4,ends_on=$5::date,next_service_on=$6::date,updated_at=NOW()
            WHERE owner_id=$1 AND client_id=$2 AND id=$3`, [getAccountOwnerId(request), clientId, contractId, status, endsOn, nextServiceOn]);
        if (!result.rowCount) return response.status(404).json({ message: "Contrat introuvable." });
        response.status(204).end();
    }));

    app.delete("/api/business-suite/:resource/:id", requireAuthentication, requireAdministration, asyncHandler(async (request, response) => {
        const tables = { sites: "depannhome_client_sites", equipment: "depannhome_client_equipment", contracts: "depannhome_maintenance_contracts" };
        const table = tables[request.params.resource];
        const id = positiveId(request.params.id);
        if (!table || !id) return response.status(400).json({ message: "Ressource invalide." });
        if (request.params.resource === "contracts") {
            if (!hasInternalBusinessWorkspaceAccess(request.user)) return response.status(403).json({ message: "Fonction indisponible pour cette organisation ou pendant la prise en main Support." });
            const history = await getPool().query(`SELECT
                EXISTS(SELECT 1 FROM depannhome_maintenance_contract_documents WHERE owner_id=$1 AND contract_id=$2)
                OR EXISTS(SELECT 1 FROM depannhome_contract_invoice_drafts WHERE owner_id=$1 AND contract_id=$2) AS has_history`, [getAccountOwnerId(request), id]);
            if (history.rows[0]?.has_history) return response.status(409).json({ message: "Ce contrat possède des documents ou échéances archivés. Modifiez son statut au lieu de le supprimer." });
        }
        const result = await getPool().query(`DELETE FROM ${table} WHERE id=$1 AND owner_id=$2`, [id, getAccountOwnerId(request)]);
        if (!result.rowCount) return response.status(404).json({ message: "Ressource introuvable." });
        response.status(204).end();
    }));

    app.patch("/api/business-suite/events/:eventId/assets", requireAuthentication, requireAdministration, asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request);
        const eventId = positiveId(request.params.eventId);
        const event = await getPool().query("SELECT client_id FROM depannhome_calendar_events WHERE id=$1 AND owner_id=$2", [eventId, ownerId]);
        if (!event.rows[0]) return response.status(404).json({ message: "Intervention introuvable." });
        const clientId = event.rows[0].client_id;
        const siteId = optionalId(request.body?.siteId), equipmentId = optionalId(request.body?.equipmentId), contractId = optionalId(request.body?.contractId);
        if (siteId && !await owns("depannhome_client_sites", siteId, ownerId, clientId) || equipmentId && !await owns("depannhome_client_equipment", equipmentId, ownerId, clientId) || contractId && !await owns("depannhome_maintenance_contracts", contractId, ownerId, clientId)) return response.status(400).json({ message: "Le site, l’équipement ou le contrat ne correspond pas au client de l’intervention." });
        await getPool().query("UPDATE depannhome_calendar_events SET site_id=$3,equipment_id=$4,contract_id=$5,updated_at=NOW() WHERE id=$1 AND owner_id=$2", [eventId, ownerId, siteId, equipmentId, contractId]);
        response.status(204).end();
    }));

    app.patch("/api/business-suite/purchases/:purchaseId/event", requireAuthentication, requireAdministration, asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request), purchaseId = positiveId(request.params.purchaseId), eventId = optionalId(request.body?.eventId);
        const purchase = await getPool().query("SELECT client_id FROM depannhome_purchases WHERE id=$1 AND owner_id=$2", [purchaseId, ownerId]);
        if (!purchase.rows[0]) return response.status(404).json({ message: "Achat introuvable." });
        if (eventId) {
            const event = await getPool().query("SELECT client_id FROM depannhome_calendar_events WHERE id=$1 AND owner_id=$2", [eventId, ownerId]);
            if (!event.rows[0]) return response.status(404).json({ message: "Intervention introuvable." });
            if (purchase.rows[0].client_id && event.rows[0].client_id && purchase.rows[0].client_id !== event.rows[0].client_id) return response.status(409).json({ message: "L’achat et l’intervention ne sont pas rattachés au même client." });
        }
        await getPool().query("UPDATE depannhome_purchases SET event_id=$3,updated_at=NOW() WHERE id=$1 AND owner_id=$2", [purchaseId, ownerId, eventId]);
        response.status(204).end();
    }));

    app.get("/api/business-suite/inventory", requireAuthentication, requireReadAccess, asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request);
        const database = await getPool().connect();
        try {
            await database.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
            const locations = await database.query(`SELECT id,name,location_type AS "locationType",vehicle_registration AS "vehicleRegistration",assigned_user_id AS "assignedUserId",is_active AS "isActive" FROM depannhome_inventory_locations WHERE owner_id=$1 ORDER BY name`, [ownerId]);
            const items = await database.query(`SELECT item.id,item.sku,item.name,item.unit,item.default_unit_cost::float AS "defaultUnitCost",item.reorder_level::float AS "reorderLevel",item.is_active AS "isActive",COALESCE(SUM(movement.quantity),0)::float AS quantity
                FROM depannhome_inventory_items item LEFT JOIN depannhome_inventory_movements movement ON movement.owner_id=item.owner_id AND movement.item_id=item.id WHERE item.owner_id=$1 GROUP BY item.id ORDER BY item.name`, [ownerId]);
            const movements = await database.query(`SELECT movement.id,movement.item_id AS "itemId",item.name AS "itemName",movement.location_id AS "locationId",location.name AS "locationName",movement.movement_type AS "movementType",movement.quantity::float,movement.unit_cost::float AS "unitCost",movement.event_id AS "eventId",movement.reason,movement.created_at AS "createdAt" FROM depannhome_inventory_movements movement JOIN depannhome_inventory_items item ON item.id=movement.item_id JOIN depannhome_inventory_locations location ON location.id=movement.location_id WHERE movement.owner_id=$1 ORDER BY movement.created_at DESC,movement.id DESC LIMIT 200`, [ownerId]);
            const balances = await database.query(`SELECT movement.item_id AS "itemId",movement.location_id AS "locationId",location.name AS "locationName",location.location_type AS "locationType",location.is_active AS "locationIsActive",SUM(movement.quantity)::float AS quantity
                FROM depannhome_inventory_movements movement
                JOIN depannhome_inventory_items item ON item.id=movement.item_id AND item.owner_id=movement.owner_id
                JOIN depannhome_inventory_locations location ON location.id=movement.location_id AND location.owner_id=movement.owner_id
                WHERE movement.owner_id=$1 GROUP BY movement.item_id,movement.location_id,location.name,location.location_type,location.is_active
                ORDER BY location.name,movement.item_id`, [ownerId]);
            await database.query("COMMIT");
            response.json({ locations: locations.rows, items: items.rows, movements: movements.rows, balances: balances.rows });
        } catch (error) { await database.query("ROLLBACK"); throw error; } finally { database.release(); }
    }));

    app.post("/api/business-suite/inventory/locations", requireAuthentication, requireManager, asyncHandler(async (request, response) => {
        const name = clean(request.body?.name, 160);
        const type = ["warehouse", "vehicle"].includes(request.body?.locationType) ? request.body.locationType : "";
        if (!name || !type) return response.status(400).json({ message: "Nom ou type d’emplacement invalide." });
        const { rows } = await getPool().query(`INSERT INTO depannhome_inventory_locations(owner_id,name,location_type,vehicle_registration,assigned_user_id) VALUES($1,$2,$3,$4,$5) RETURNING id`, [getAccountOwnerId(request), name, type, clean(request.body?.vehicleRegistration, 40), optionalId(request.body?.assignedUserId)]);
        response.status(201).json({ id: rows[0].id });
    }));

    app.post("/api/business-suite/inventory/items", requireAuthentication, requireManager, asyncHandler(async (request, response) => {
        const sku = clean(request.body?.sku, 100).toUpperCase(), name = clean(request.body?.name, 200);
        if (!sku || !name) return response.status(400).json({ message: "La référence et le nom sont obligatoires." });
        const { rows } = await getPool().query(`INSERT INTO depannhome_inventory_items(owner_id,sku,name,unit,default_unit_cost,reorder_level) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [getAccountOwnerId(request), sku, name, clean(request.body?.unit, 30) || "unité", money(request.body?.defaultUnitCost), quantity(request.body?.reorderLevel, true)]);
        response.status(201).json({ id: rows[0].id });
    }));

    app.patch("/api/business-suite/inventory/items/:itemId/threshold", requireAuthentication, requireManager, requireInternalBusinessWorkspace, asyncHandler(async (request, response) => {
        const itemId = positiveId(request.params.itemId);
        const value = request.body?.reorderLevel;
        const amount = Number(value);
        const validType = typeof value === "number" || (typeof value === "string" && value.trim() !== "");
        if (!itemId || !validType || !Number.isFinite(amount) || amount < 0 || amount > 100000000 || Math.abs(amount * 1000 - Math.round(amount * 1000)) > 1e-7) {
            return response.status(400).json({ message: "Le seuil doit être compris entre 0 et 100 000 000, avec trois décimales au maximum." });
        }
        const result = await getPool().query("UPDATE depannhome_inventory_items SET reorder_level=$3,updated_at=NOW() WHERE owner_id=$1 AND id=$2", [getAccountOwnerId(request), itemId, amount]);
        if (!result.rowCount) return response.status(404).json({ message: "Article introuvable." });
        response.status(204).end();
    }));

    app.post("/api/business-suite/inventory/movements", requireAuthentication, requireAdministration, asyncHandler(async (request, response) => {
        const type = MOVEMENT_TYPES.has(request.body?.movementType) ? request.body.movementType : "";
        const amount = quantity(request.body?.quantity);
        const adjustment = Number(request.body?.quantity);
        const signedQuantity = ["out", "consumption"].includes(type) ? -amount : type === "adjustment" && Number.isFinite(adjustment) && adjustment !== 0 && Math.abs(adjustment) <= 100000000 ? Math.round(adjustment * 1000) / 1000 : type === "adjustment" ? 0 : amount;
        if (!type || !Number.isFinite(signedQuantity) || signedQuantity === 0) return response.status(400).json({ message: "Mouvement invalide." });
        const movement = await createMovement(request, { itemId: positiveId(request.body?.itemId), locationId: positiveId(request.body?.locationId), type, signedQuantity, unitCost: request.body?.unitCost === "" || request.body?.unitCost === null || request.body?.unitCost === undefined ? null : money(request.body.unitCost), eventId: optionalId(request.body?.eventId), reason: clean(request.body?.reason, 500) });
        response.status(201).json(movement);
    }));

    app.post("/api/business-suite/inventory/transfers", requireAuthentication, requireAdministration, asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request), itemId = positiveId(request.body?.itemId), fromId = positiveId(request.body?.fromLocationId), toId = positiveId(request.body?.toLocationId), amount = quantity(request.body?.quantity);
        if (!itemId || !fromId || !toId || fromId === toId || !amount) return response.status(400).json({ message: "Transfert invalide." });
        const database = await getPool().connect(), reference = randomUUID();
        try {
            await database.query("BEGIN");
            await lockInventoryEntities(database, ownerId, itemId, [fromId, toId]);
            const balance = await currentBalance(database, ownerId, itemId, fromId);
            if (balance < amount) throw Object.assign(new Error("Stock insuffisant dans l’emplacement source."), { status: 409 });
            const configuredCost = request.body?.unitCost === "" || request.body?.unitCost === null || request.body?.unitCost === undefined
                ? Number((await database.query("SELECT default_unit_cost::float AS cost FROM depannhome_inventory_items WHERE id=$1 AND owner_id=$2", [itemId, ownerId])).rows[0]?.cost || 0)
                : money(request.body.unitCost);
            const values = [ownerId, itemId, amount, configuredCost, reference, clean(request.body?.reason, 500), request.user.sub];
            await database.query(`INSERT INTO depannhome_inventory_movements(owner_id,item_id,location_id,movement_type,quantity,unit_cost,transfer_reference,reason,created_by) VALUES($1,$2,$8,'transfer_out',$3 * -1,$4,$5,$6,$7),($1,$2,$9,'transfer_in',$3,$4,$5,$6,$7)`, [...values, fromId, toId]);
            await database.query("COMMIT");
        } catch (error) { await database.query("ROLLBACK"); throw error; } finally { database.release(); }
        response.status(201).json({ transferReference: reference });
    }));

    app.get("/api/business-suite/events/:eventId/profitability", requireAuthentication, requireReadAccess, asyncHandler(async (request, response) => {
        const result = await calculateProfitability(getAccountOwnerId(request), positiveId(request.params.eventId));
        if (!result) return response.status(404).json({ message: "Intervention introuvable." });
        response.json({ profitability: result });
    }));

    app.get("/api/business-suite/profitability", requireAuthentication, requireReadAccess, asyncHandler(async (request, response) => {
        const from = strictDateOnly(request.query.from) || "2000-01-01", to = strictDateOnly(request.query.to) || "2999-12-31";
        const { rows } = await getPool().query("SELECT id FROM depannhome_calendar_events WHERE owner_id=$1 AND event_date BETWEEN $2::date AND $3::date ORDER BY event_date DESC LIMIT 500", [getAccountOwnerId(request), from, to]);
        const entries = (await Promise.all(rows.map(row => calculateProfitability(getAccountOwnerId(request), row.id)))).filter(Boolean);
        response.json({ entries, totals: entries.reduce((total, item) => ({ revenueHt: total.revenueHt + item.revenueHt, laborCost: total.laborCost + item.laborCost, partsCost: total.partsCost + item.partsCost, purchasesCost: total.purchasesCost + item.purchasesCost, margin: total.margin + item.margin }), { revenueHt: 0, laborCost: 0, partsCost: 0, purchasesCost: 0, margin: 0 }) });
    }));

    app.get("/api/business-suite/labor-costs", requireAuthentication, requireManager, asyncHandler(async (request, response) => {
        const { rows } = await getPool().query("SELECT role,hourly_cost::float AS \"hourlyCost\" FROM depannhome_labor_cost_settings WHERE owner_id=$1 ORDER BY role", [getAccountOwnerId(request)]);
        response.json({ costs: rows });
    }));
    app.put("/api/business-suite/labor-costs/:role", requireAuthentication, requireManager, asyncHandler(async (request, response) => {
        const role = clean(request.params.role, 30), hourlyCost = money(request.body?.hourlyCost);
        if (!role) return response.status(400).json({ message: "Rôle invalide." });
        await getPool().query(`INSERT INTO depannhome_labor_cost_settings(owner_id,role,hourly_cost) VALUES($1,$2,$3) ON CONFLICT(owner_id,role) DO UPDATE SET hourly_cost=EXCLUDED.hourly_cost,updated_at=NOW()`, [getAccountOwnerId(request), role, hourlyCost]);
        response.status(204).end();
    }));
}

async function createMovement(request, movement) {
    const ownerId = getAccountOwnerId(request), database = await getPool().connect();
    try {
        await database.query("BEGIN");
        await lockInventoryEntities(database, ownerId, movement.itemId, [movement.locationId]);
        if (movement.unitCost === null) {
            const item = await database.query("SELECT default_unit_cost::float AS cost FROM depannhome_inventory_items WHERE id=$1 AND owner_id=$2", [movement.itemId, ownerId]);
            movement.unitCost = Number(item.rows[0]?.cost || 0);
        }
        if (movement.eventId) {
            const event = await database.query("SELECT 1 FROM depannhome_calendar_events WHERE id=$1 AND owner_id=$2", [movement.eventId, ownerId]);
            if (!event.rowCount) throw Object.assign(new Error("Intervention introuvable."), { status: 400 });
        }
        const balance = await currentBalance(database, ownerId, movement.itemId, movement.locationId);
        const newBalance = Math.round((balance + movement.signedQuantity) * 1000) / 1000;
        const override = request.user?.role === "admin" && request.body?.allowNegative === true && movement.reason.length >= 5;
        if (newBalance < 0 && !override) throw Object.assign(new Error("Stock insuffisant. Un administrateur peut autoriser l’écart avec un motif."), { status: 409 });
        const result = await database.query(`INSERT INTO depannhome_inventory_movements(owner_id,item_id,location_id,movement_type,quantity,unit_cost,event_id,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [ownerId, movement.itemId, movement.locationId, movement.type, movement.signedQuantity, movement.unitCost, movement.eventId, movement.reason, request.user.sub]);
        await database.query("COMMIT");
        return { id: result.rows[0].id, balance: newBalance };
    } catch (error) { await database.query("ROLLBACK"); throw error; } finally { database.release(); }
}
async function lockInventoryEntities(database, ownerId, itemId, locationIds) {
    if (!itemId || locationIds.some(id => !id)) throw Object.assign(new Error("Article ou emplacement invalide."), { status: 400 });
    const item = await database.query("SELECT 1 FROM depannhome_inventory_items WHERE id=$1 AND owner_id=$2 AND is_active=TRUE FOR UPDATE", [itemId, ownerId]);
    const locations = await database.query("SELECT id FROM depannhome_inventory_locations WHERE owner_id=$1 AND id=ANY($2::bigint[]) AND is_active=TRUE ORDER BY id FOR UPDATE", [ownerId, locationIds]);
    if (!item.rowCount || locations.rowCount !== new Set(locationIds).size) throw Object.assign(new Error("Article ou emplacement introuvable."), { status: 404 });
}
async function currentBalance(database, ownerId, itemId, locationId) { const { rows } = await database.query("SELECT COALESCE(SUM(quantity),0)::float AS value FROM depannhome_inventory_movements WHERE owner_id=$1 AND item_id=$2 AND location_id=$3", [ownerId, itemId, locationId]); return Number(rows[0].value); }

export async function calculateProfitability(ownerId, eventId) {
    if (!eventId) return null;
    const { rows } = await getPool().query(`WITH event AS (SELECT id,title,client_name,event_date,event_status FROM depannhome_calendar_events WHERE owner_id=$1 AND id=$2),
        document_totals AS (SELECT document_type,financial_data,COALESCE((SELECT SUM(COALESCE(NULLIF(line->>'quantity','')::numeric,0)*COALESCE(NULLIF(line->>'unitPrice','')::numeric,0)) FROM jsonb_array_elements(lines) line),0) gross FROM depannhome_billing_documents WHERE owner_id=$1 AND appointment_id=$2 AND issued_at IS NOT NULL AND document_type IN ('invoice','credit')),
        revenue AS (SELECT COALESCE(SUM((CASE WHEN document_type='credit' THEN -1 ELSE 1 END) * (gross-LEAST(gross,CASE WHEN financial_data->>'discountMode'='percentage' THEN gross*COALESCE(NULLIF(financial_data->>'discountAmount','')::numeric,0)/100 ELSE COALESCE(NULLIF(financial_data->>'discountAmount','')::numeric,0) END))),0) value FROM document_totals),
        labor AS (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(session.ended_at,NOW())-session.started_at))/3600 * COALESCE(cost.hourly_cost,0)),0) value,COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(session.ended_at,NOW())-session.started_at))/3600),0) hours FROM depannhome_intervention_work_sessions session JOIN depannhome_users member ON member.id=session.technician_id LEFT JOIN depannhome_labor_cost_settings cost ON cost.owner_id=session.owner_id AND cost.role=member.role WHERE session.owner_id=$1 AND session.event_id=$2),
        parts AS (SELECT COALESCE(SUM(ABS(quantity)*unit_cost),0) value FROM depannhome_inventory_movements WHERE owner_id=$1 AND event_id=$2 AND movement_type='consumption'),
        purchases AS (SELECT COALESCE(SUM(amount_ht),0) value FROM depannhome_purchases WHERE owner_id=$1 AND event_id=$2)
        SELECT event.id,event.title,event.client_name AS "clientName",TO_CHAR(event.event_date,'YYYY-MM-DD') AS "eventDate",event.event_status AS "eventStatus",revenue.value::float AS "revenueHt",labor.value::float AS "laborCost",labor.hours::float AS "laborHours",parts.value::float AS "partsCost",purchases.value::float AS "purchasesCost" FROM event,revenue,labor,parts,purchases`, [ownerId, eventId]);
    if (!rows[0]) return null;
    const item = rows[0], margin = round(item.revenueHt - item.laborCost - item.partsCost - item.purchasesCost);
    return { ...item, revenueHt: round(item.revenueHt), laborCost: round(item.laborCost), laborHours: round(item.laborHours), partsCost: round(item.partsCost), purchasesCost: round(item.purchasesCost), margin, marginRate: item.revenueHt ? round(margin / item.revenueHt * 100) : null, formulaVersion: 1, isEstimated: false };
}
async function requireClient(request) { const clientId=clean(request.params.clientId,100); const { rowCount }=await getPool().query("SELECT 1 FROM depannhome_clients WHERE owner_id=$1 AND client_id=$2 AND client_status='active'",[getAccountOwnerId(request),clientId]); return rowCount ? clientId : ""; }
async function owns(table,id,ownerId,clientId) { const { rowCount }=await getPool().query(`SELECT 1 FROM ${table} WHERE id=$1 AND owner_id=$2 AND client_id=$3`,[id,ownerId,clientId]); return Boolean(rowCount); }
function positiveId(value){const number=Number(value);return Number.isSafeInteger(number)&&number>0?number:0;} function optionalId(value){return value===null||value===undefined||value===""?null:positiveId(value)||null;} function clean(value,max){return String(value||"").replace(/[\u0000-\u001f\u007f]/g," ").trim().slice(0,max);} function dateOrNull(value){return value?strictDateOnly(value):null;} function integer(value,min,max,fallback){const number=Number(value);return Number.isInteger(number)&&number>=min&&number<=max?number:fallback;} function money(value){const number=Number(value);return Number.isFinite(number)&&number>=0&&number<=100000000?round(number):0;} function quantity(value,allowZero=false){const number=Number(value);return Number.isFinite(number)&&(allowZero?number>=0:number>0)&&number<=100000000?Math.round(number*1000)/1000:0;} function round(value){return Math.round(Number(value||0)*100)/100;}
function requireInternalBusinessWorkspace(request,response,next){return hasInternalBusinessWorkspaceAccess(request.user)?next():response.status(403).json({message:"Fonction indisponible pour cette organisation ou pendant la prise en main Support."});}
function requireAdministration(request,response,next){return ADMIN_ROLES.has(request.user?.role)?next():response.status(403).json({message:"Fonction réservée aux postes administratifs."});} function requireManager(request,response,next){return MANAGER_ROLES.has(request.user?.role)?next():response.status(403).json({message:"Fonction réservée aux responsables."});} function requireReadAccess(request,response,next){return request.user?.role==="accountant"||ADMIN_ROLES.has(request.user?.role)?next():response.status(403).json({message:"Accès réservé aux postes administratifs."});} function asyncHandler(handler){return(request,response,next)=>Promise.resolve(handler(request,response,next)).catch(next);}
