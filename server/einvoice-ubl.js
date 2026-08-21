const OPERATION_LABELS = Object.freeze({ goods: "Livraison de biens", services: "Prestation de services", mixed: "Livraison de biens et prestation de services" });
const UNIT_CODES = Object.freeze({ heure: "HUR", heures: "HUR", jour: "DAY", jours: "DAY", kg: "KGM", kilogramme: "KGM", litre: "LTR", mètre: "MTR", metre: "MTR", forfait: "C62", unité: "C62", unite: "C62", pièce: "C62", piece: "C62" });

export function generateUblInvoice(document, profile = {}) {
    const isCredit = document?.documentType === "credit";
    if (!isCredit && document?.documentType !== "invoice") throw new TypeError("Seules les factures et les avoirs peuvent être exportés en UBL.");
    const legal = object(document.legalData);
    const lines = normalizeLines(document.lines, isCredit);
    if (!lines.length) throw new TypeError("Le document UBL doit contenir au moins une ligne valide.");
    const supplierId = identifier(profile.siren || profile.registrationNumber || profile.taxNumber);
    const customerId = identifier(legal.customerSiren || legal.customerVatNumber || document.clientId || document.customerName);
    if (!document.documentNumber || !supplierId || !customerId) throw new TypeError("Le numéro du document et les identifiants fournisseur/client sont obligatoires pour l’export UBL.");

    const financial = object(document.financialData);
    const grossHtCents = lines.reduce((sum, line) => sum + line.extensionCents, 0);
    const discountCents = Math.min(grossHtCents, financial.discountMode === "percentage"
        ? cents(grossHtCents / 100 * number(financial.discountAmount) / 100)
        : cents(number(financial.discountAmount)));
    const netHtCents = grossHtCents - discountCents;
    const isFranchise = profile.vatRegime === "franchise" || document.vatRegime === "franchise";
    const taxes = taxBreakdown(lines, grossHtCents, netHtCents, isFranchise);
    const vatCents = taxes.reduce((sum, tax) => sum + tax.amountCents, 0);
    const totalCents = netHtCents + vatCents;
    const aidsCents = Math.min(totalCents, Array.isArray(financial.aids) ? financial.aids.reduce((sum, aid) => sum + (aid?.calculationMode === "percentage" ? cents(netHtCents / 100 * number(aid.amount)) : cents(number(aid?.amount))), 0) : 0);
    const prepaidCents = Math.min(totalCents, aidsCents + cents(number(financial.depositAmount)));
    const payableCents = Math.max(0, totalCents - prepaidCents);
    const root = isCredit ? "CreditNote" : "Invoice";
    const lineTag = isCredit ? "CreditNoteLine" : "InvoiceLine";
    const quantityTag = isCredit ? "CreditedQuantity" : "InvoicedQuantity";
    const issueDate = date(document.issuedAt) || date(document.issueDate);
    const billingAddress = legal.billingAddress || document.customerAddress || "";
    const deliveryAddress = legal.deliveryAddress || "";
    const customerVat = identifier(legal.customerVatNumber);
    const supplierVat = identifier(document.issuerTaxNumber || profile.taxNumber);
    const operationLabel = OPERATION_LABELS[legal.operationCategory] || OPERATION_LABELS.services;
    const namespaces = `xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"`;

    const xml = [
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        `<${root} ${namespaces}>`,
        tag("cbc:CustomizationID", "urn:cen.eu:en16931:2017"),
        tag("cbc:ProfileID", "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0"),
        tag("cbc:ID", document.documentNumber),
        tag("cbc:IssueDate", issueDate),
        !isCredit && document.dueDate ? tag("cbc:DueDate", date(document.dueDate)) : "",
        tag(`cbc:${isCredit ? "CreditNoteTypeCode" : "InvoiceTypeCode"}`, isCredit ? "381" : "380"),
        tag("cbc:Note", [operationLabel, document.notes].filter(Boolean).join(" — ")),
        tag("cbc:DocumentCurrencyCode", "EUR"),
        legal.purchaseOrderReference ? `<cac:OrderReference>${tag("cbc:ID", legal.purchaseOrderReference)}</cac:OrderReference>` : "",
        party("AccountingSupplierParty", { name: profile.companyName, identifier: supplierId, vat: supplierVat, address: [profile.address, profile.postalCode, profile.city].filter(Boolean).join("\n"), postalCode: profile.postalCode, city: profile.city }),
        party("AccountingCustomerParty", { name: document.customerName, identifier: customerId, vat: customerVat, address: billingAddress }),
        legal.serviceDate || deliveryAddress ? `<cac:Delivery>${legal.serviceDate ? tag("cbc:ActualDeliveryDate", legal.serviceDate) : ""}${deliveryAddress ? `<cac:DeliveryLocation>${addressXml(deliveryAddress)}</cac:DeliveryLocation>` : ""}</cac:Delivery>` : "",
        !isCredit && (profile.bankIban || profile.paymentTerms) ? `<cac:PaymentMeans>${tag("cbc:PaymentMeansCode", profile.bankIban ? "30" : "1")}${profile.bankIban ? `<cac:PayeeFinancialAccount>${tag("cbc:ID", profile.bankIban)}${profile.bankBic ? `<cac:FinancialInstitutionBranch>${tag("cbc:ID", profile.bankBic)}</cac:FinancialInstitutionBranch>` : ""}</cac:PayeeFinancialAccount>` : ""}</cac:PaymentMeans>` : "",
        profile.paymentTerms ? `<cac:PaymentTerms>${tag("cbc:Note", profile.paymentTerms)}</cac:PaymentTerms>` : "",
        taxesXml(taxes, vatCents),
        discountCents ? `<cac:AllowanceCharge>${tag("cbc:ChargeIndicator", "false")}${tag("cbc:AllowanceChargeReason", financial.discountLabel || "Remise")}${moneyTag("cbc:Amount", discountCents)}${moneyTag("cbc:BaseAmount", grossHtCents)}</cac:AllowanceCharge>` : "",
        `<cac:LegalMonetaryTotal>${moneyTag("cbc:LineExtensionAmount", grossHtCents)}${moneyTag("cbc:TaxExclusiveAmount", netHtCents)}${moneyTag("cbc:TaxInclusiveAmount", totalCents)}${discountCents ? moneyTag("cbc:AllowanceTotalAmount", discountCents) : ""}${prepaidCents ? moneyTag("cbc:PrepaidAmount", prepaidCents) : ""}${moneyTag("cbc:PayableAmount", payableCents)}</cac:LegalMonetaryTotal>`,
        ...lines.map((line, index) => `<cac:${lineTag}>${tag("cbc:ID", index + 1)}${tag(`cbc:${quantityTag}`, formatQuantity(line.quantity), { unitCode: line.unitCode })}${moneyTag("cbc:LineExtensionAmount", line.extensionCents)}<cac:Item>${tag("cbc:Name", line.description)}<cac:ClassifiedTaxCategory>${tag("cbc:ID", isFranchise || line.exempt ? "E" : "S")}${tag("cbc:Percent", formatRate(isFranchise ? 0 : line.vatRate))}${isFranchise || line.exempt ? tag("cbc:TaxExemptionReason", "TVA non applicable, art. 293 B du CGI") : ""}<cac:TaxScheme>${tag("cbc:ID", "VAT")}</cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item><cac:Price>${moneyTag("cbc:PriceAmount", line.unitPriceCents)}</cac:Price></cac:${lineTag}>`),
        `</${root}>`
    ].filter(Boolean).join("");
    return Buffer.from(xml, "utf8");
}

function normalizeLines(value, credit) {
    if (!Array.isArray(value)) return [];
    return value.map(line => {
        const quantity = Math.abs(number(line?.quantity));
        const unitPriceCents = cents(Math.abs(number(line?.unitPrice ?? line?.unit_price)));
        if (!line?.description || quantity <= 0 || unitPriceCents < 0) return null;
        const vatRate = Math.max(0, Math.min(100, number(line.vatRate)));
        return { description: String(line.description), quantity, unitPriceCents, extensionCents: Math.round(quantity * unitPriceCents), vatRate, exempt: vatRate === 0, unitCode: UNIT_CODES[String(line.unit || "").toLowerCase()] || "C62", credit };
    }).filter(Boolean);
}

function taxBreakdown(lines, grossCents, netCents, franchise) {
    const groups = new Map();
    for (const line of lines) {
        const rate = franchise ? 0 : line.vatRate;
        groups.set(rate, (groups.get(rate) || 0) + line.extensionCents);
    }
    const entries = [...groups.entries()].sort((a, b) => a[0] - b[0]);
    let allocated = 0;
    return entries.map(([rate, gross], index) => {
        const taxableCents = index === entries.length - 1 ? netCents - allocated : Math.round(netCents * gross / (grossCents || 1));
        allocated += taxableCents;
        return { rate, taxableCents, amountCents: franchise ? 0 : Math.round(taxableCents * rate / 100), exempt: franchise || rate === 0 };
    });
}

function taxesXml(taxes, total) {
    return `<cac:TaxTotal>${moneyTag("cbc:TaxAmount", total)}${taxes.map(tax => `<cac:TaxSubtotal>${moneyTag("cbc:TaxableAmount", tax.taxableCents)}${moneyTag("cbc:TaxAmount", tax.amountCents)}<cac:TaxCategory>${tag("cbc:ID", tax.exempt ? "E" : "S")}${tag("cbc:Percent", formatRate(tax.rate))}${tax.exempt ? tag("cbc:TaxExemptionReason", "TVA non applicable, art. 293 B du CGI") : ""}<cac:TaxScheme>${tag("cbc:ID", "VAT")}</cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`).join("")}</cac:TaxTotal>`;
}

function party(role, value) {
    return `<cac:${role}><cac:Party>${tag("cbc:EndpointID", value.identifier, { schemeID: scheme(value.identifier) })}<cac:PartyIdentification>${tag("cbc:ID", value.identifier, { schemeID: scheme(value.identifier) })}</cac:PartyIdentification>${addressXml(value.address, value.postalCode, value.city)}${value.vat ? `<cac:PartyTaxScheme>${tag("cbc:CompanyID", value.vat)}<cac:TaxScheme>${tag("cbc:ID", "VAT")}</cac:TaxScheme></cac:PartyTaxScheme>` : ""}<cac:PartyLegalEntity>${tag("cbc:RegistrationName", value.name || value.identifier)}${tag("cbc:CompanyID", value.identifier)}</cac:PartyLegalEntity></cac:Party></cac:${role}>`;
}

function addressXml(raw, postalCode = "", city = "") {
    const lines = String(raw || "").split(/\r?\n|,\s*/).map(value => value.trim()).filter(Boolean);
    const street = lines.join(", ");
    return `<cac:PostalAddress>${street ? tag("cbc:StreetName", street) : ""}${postalCode ? tag("cbc:PostalZone", postalCode) : ""}${city ? tag("cbc:CityName", city) : ""}<cac:Country>${tag("cbc:IdentificationCode", "FR")}</cac:Country></cac:PostalAddress>`;
}

function tag(name, value, attributes = {}) {
    if (value === undefined || value === null || value === "") return "";
    const attrs = Object.entries(attributes).map(([key, entry]) => ` ${key}="${escapeXml(entry)}"`).join("");
    return `<${name}${attrs}>${escapeXml(value)}</${name}>`;
}
function moneyTag(name, value) { return tag(name, (value / 100).toFixed(2), { currencyID: "EUR" }); }
function escapeXml(value) { return String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]); }
function scheme(value) { return /^FR[A-Z0-9]{2,}$/i.test(value) ? "VAT" : /^\d{9}$/.test(value) ? "0002" : "ZZZ"; }
function identifier(value) { return String(value || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 80); }
function date(value) { const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || "")); return match?.[1] || ""; }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function cents(value) { return Math.round(number(value) * 100); }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function formatRate(value) { return Number(value || 0).toFixed(2); }
function formatQuantity(value) { return Number(value || 0).toFixed(3).replace(/\.?0+$/, ""); }
