import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { accountHistoryChanges, recordAccountHistory } from "../server/account-history.js";
import { creatorHistoryPresentation } from "../js/creator-history.js";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("l'audit du compte ne conserve que les valeurs réellement modifiées", () => {
    const changes = accountHistoryChanges(
        { subscriptionTier: "pro", maxPcUsers: 2, maxTechnicians: 1, discountLabel: "Ancienne" },
        { subscriptionTier: "basic_plus", maxPcUsers: 4, maxTechnicians: 1, subscriptionDiscountLabel: "Nouvelle" }
    );
    assert.deepEqual(changes.previousValue, { subscriptionTier: "pro", maxPcUsers: 2, discountLabel: "Ancienne" });
    assert.deepEqual(changes.nextValue, { subscriptionTier: "basic_plus", maxPcUsers: 4, discountLabel: "Nouvelle" });
});

test("une mise à jour sans changement ne crée aucun événement", async () => {
    let writes = 0;
    const database = { async query() { writes += 1; } };
    assert.equal(await recordAccountHistory(database, { accountOwnerId: 24, actorId: 1, previous: { maxPcUsers: 2 }, next: { maxPcUsers: 2 } }), false);
    assert.equal(writes, 0);
});

test("un changement est journalisé avec son état avant et après", async () => {
    let write;
    const database = { async query(sql, parameters) { write = { sql, parameters }; return { rows: [] }; } };
    assert.equal(await recordAccountHistory(database, { accountOwnerId: 24, actorId: 1, action: "capacity_changed", previous: { maxPcUsers: 2 }, next: { maxPcUsers: 4 } }), true);
    assert.match(write.sql, /INSERT INTO depannhome_account_audit/);
    assert.deepEqual(write.parameters.slice(0, 3), [24, 1, "capacity_changed"]);
    assert.deepEqual(JSON.parse(write.parameters[3]), { maxPcUsers: 2 });
    assert.deepEqual(JSON.parse(write.parameters[4]), { maxPcUsers: 4 });
});

test("l'historique qualifie rétrogradation, ajout de postes et suspension", () => {
    const downgrade = creatorHistoryPresentation({ category: "account", action: "account_updated", previousValue: { subscriptionTier: "pro" }, nextValue: { subscriptionTier: "basic_plus" } });
    assert.equal(downgrade.title, "Rétrogradation de l’offre");
    assert.deepEqual(downgrade.details, ["Offre : Pro → Basic+"]);

    const seats = creatorHistoryPresentation({ category: "account", action: "capacity_changed", previousValue: { maxPcUsers: 2, maxTechnicians: 1 }, nextValue: { maxPcUsers: 4, maxTechnicians: 2 } });
    assert.equal(seats.title, "Ajout de postes");
    assert.deepEqual(seats.details, ["Postes administratifs : 2 → 4 (+2)", "Postes mobiles : 1 → 2 (+1)"]);

    const suspension = creatorHistoryPresentation({ category: "account", action: "activation_changed", previousValue: { isActive: true }, nextValue: { isActive: false } });
    assert.deepEqual(suspension, { title: "Entreprise suspendue", details: ["Accès : suspendu"] });

    const subscriptionSuspension = creatorHistoryPresentation({ category: "account", action: "account_updated", previousValue: { subscriptionStatus: "active" }, nextValue: { subscriptionStatus: "suspended" } });
    assert.equal(subscriptionSuspension.title, "Abonnement suspendu");
    assert.deepEqual(subscriptionSuspension.details, ["Statut de l’abonnement : Actif → Suspendu"]);
});

test("l'historique consolide organisation, compte, essai et cycle de vie", () => {
    const organizations = read("server/organizations.js");
    const migration = read("database/migrations/0020_account_history.sql");
    const schema = read("database/schema.sql");
    for (const source of [migration, schema]) {
        assert.match(source, /CREATE TABLE IF NOT EXISTS depannhome_account_audit/);
        assert.match(source, /previous_value JSONB/);
        assert.match(source, /next_value JSONB/);
    }
    assert.match(organizations, /'organization' AS category/);
    assert.match(organizations, /'account'/);
    assert.match(organizations, /'trial'/);
    assert.match(organizations, /'lifecycle'/);
    assert.match(organizations, /ORDER BY history\."createdAt" DESC/);
});

test("les événements d'essai et d'archive ont des libellés explicites", () => {
    assert.equal(creatorHistoryPresentation({ category: "trial", action: "expired" }).title, "Essai expiré — entreprise suspendue");
    assert.equal(creatorHistoryPresentation({ category: "trial", action: "converted" }).title, "Essai converti en abonnement payant");
    assert.deepEqual(creatorHistoryPresentation({ category: "lifecycle", action: "archived", details: { reason: "Cessation" } }), { title: "Entreprise archivée", details: ["Motif : Cessation"] });
});
