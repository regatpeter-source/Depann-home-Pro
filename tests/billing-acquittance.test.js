import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { archiveBillingAcquittance } from "../server/billing.js";

test("the acquittance is a separate hash-linked PDF and leaves the issued archive unchanged", async () => {
    const sourceDocument = await PDFDocument.create();
    sourceDocument.addPage();
    const source = Buffer.from(await sourceDocument.save());
    const sourceHash = crypto.createHash("sha256").update(source).digest("hex");
    const originalSnapshot = Buffer.from(source);
    let insertedParameters;
    const database = {
        async query(sql, parameters) {
            if (sql.includes("FROM depannhome_billing_acquittances") && sql.includes("document_id=$2")) return { rows: [] };
            if (sql.includes("FROM depannhome_billing_documents")) return { rows: [{ id: 7, documentNumber: "FAC-2026-007", customerName: "Client Test", pdfData: source, pdfSha256: sourceHash }] };
            if (sql.includes("FROM depannhome_accounting_settlements")) return { rows: [{ id: 9, date: "2026-03-12", amount: 120, method: "Virement", reference: "VIR-9" }] };
            if (sql.includes("INSERT INTO depannhome_billing_acquittances")) { insertedParameters = parameters; return { rows: [{ id: 3, pdfSha256: parameters[7], filename: parameters[8] }] }; }
            throw new Error(`Unexpected SQL: ${sql}`);
        }
    };
    const result = await archiveBillingAcquittance({ ownerId: 1, documentId: 7, finalSettlementId: 9, actorId: 2, database });
    assert.equal(result.alreadyArchived, false);
    assert.deepEqual(source, originalSnapshot);
    assert.equal(insertedParameters[5], sourceHash);
    assert.equal(insertedParameters[7], crypto.createHash("sha256").update(insertedParameters[6]).digest("hex"));
    const derivative = await PDFDocument.load(insertedParameters[6]);
    assert.equal(derivative.getPageCount(), 2);
});
