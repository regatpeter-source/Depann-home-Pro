const TIER_LABELS = Object.freeze({ basic: "Basic", basic_plus: "Basic+", pro: "Pro" });
const STATUS_LABELS = Object.freeze({ active: "Actif", trial: "Essai", past_due: "Paiement en retard", suspended: "Suspendu", cancelled: "Résilié" });
const INTERFACE_LABELS = Object.freeze({ standard: "Standard", partner: "Partenaire gratuit", group: "Groupe" });
const LICENSE_LABELS = Object.freeze({ depannhome_standard: "Depann’Home Pro Standard", partner_portal: "Portail Partenaire", depannhome_group: "Depann’Home Pro Groupe" });

export function creatorHistoryPresentation(entry = {}) {
    const previous = entry.previousValue || {};
    const next = entry.nextValue || {};
    if (entry.category === "trial") return trialPresentation(entry);
    if (entry.category === "lifecycle") return { title: entry.action === "restored" ? "Entreprise restaurée" : "Entreprise archivée", details: entry.details?.reason ? [`Motif : ${entry.details.reason}`] : [] };
    if (entry.category === "organization") return organizationPresentation(entry, previous, next);
    if (entry.action === "activation_changed") return { title: next.isActive ? "Entreprise réactivée" : "Entreprise suspendue", details: [`Accès : ${next.isActive ? "réactivé" : "suspendu"}`] };

    const details = accountChangeDetails(previous, next);
    const oldTier = tierRank(previous.subscriptionTier);
    const newTier = tierRank(next.subscriptionTier);
    const pcDelta = numericDelta(previous.maxPcUsers, next.maxPcUsers);
    const mobileDelta = numericDelta(previous.maxTechnicians, next.maxTechnicians);
    let title = entry.action === "capacity_changed" ? capacityTitle(pcDelta, mobileDelta) : "Compte entreprise mis à jour";
    if (oldTier && newTier && oldTier !== newTier) title = newTier < oldTier ? "Rétrogradation de l’offre" : "Évolution de l’offre";
    else if (pcDelta || mobileDelta) title = capacityTitle(pcDelta, mobileDelta);
    else if (previous.subscriptionStatus !== next.subscriptionStatus && next.subscriptionStatus === "suspended") title = "Abonnement suspendu";
    else if (previous.subscriptionStatus !== next.subscriptionStatus && next.subscriptionStatus === "active") title = "Abonnement réactivé";
    return { title, details };
}

function organizationPresentation(entry, previous, next) {
    const details = [];
    pushChange(details, "Facturation", previous.subscriptionPlan, next.subscriptionPlan, value => ({ free: "Gratuite", paid: "Payante" })[value] || readableValue(value));
    pushChange(details, "Interface", previous.interfaceType, next.interfaceType, value => INTERFACE_LABELS[value] || readableValue(value));
    pushChange(details, "Licence", previous.licenseType, next.licenseType, value => LICENSE_LABELS[value] || readableValue(value));
    pushChange(details, "Type d’organisation", previous.organizationType, next.organizationType, readableValue);
    return { title: entry.action === "created" ? "Organisation créée" : "Organisation mise à jour", details };
}

function trialPresentation(entry) {
    const titles = { activated: "Essai de 15 jours activé", renewed: "Essai renouvelé", expired: "Essai expiré — entreprise suspendue", ended: "Essai terminé", converted: "Essai converti en abonnement payant" };
    const details = [];
    if (entry.nextValue?.trialEndsAt) details.push(`Fin prévue : ${formatHistoryDate(entry.nextValue.trialEndsAt)}`);
    if (entry.details?.billingStartsOn) details.push(`Début de facturation : ${entry.details.billingStartsOn}`);
    return { title: titles[entry.action] || "Essai mis à jour", details };
}

function accountChangeDetails(previous, next) {
    const details = [];
    pushChange(details, "Offre", previous.subscriptionTier, next.subscriptionTier, value => TIER_LABELS[value] || readableValue(value));
    pushChange(details, "Postes administratifs", previous.maxPcUsers, next.maxPcUsers, readableValue, true);
    pushChange(details, "Postes mobiles", previous.maxTechnicians, next.maxTechnicians, readableValue, true);
    pushChange(details, "Entreprises autorisées", previous.maxGroupCompanies, next.maxGroupCompanies, readableValue, true);
    pushChange(details, "Statut de l’abonnement", previous.subscriptionStatus, next.subscriptionStatus, value => STATUS_LABELS[value] || readableValue(value));
    pushChange(details, "Tarif mensuel", previous.monthlyPriceCents, next.monthlyPriceCents, cents);
    pushChange(details, "Réduction", previous.discountValue, next.discountValue, readableValue);
    pushChange(details, "Type de réduction", previous.discountMode, next.discountMode, value => ({ fixed: "Montant fixe", percentage: "Pourcentage" })[value] || readableValue(value));
    pushChange(details, "Libellé de réduction", previous.discountLabel, next.discountLabel, readableValue);
    pushChange(details, "Prochaine échéance", previous.subscriptionRenewalDate, next.subscriptionRenewalDate, value => value || "Aucune");
    pushChange(details, "Référence de paiement", previous.billingReference, next.billingReference, readableValue);
    pushChange(details, "Entreprise", previous.companyName, next.companyName, readableValue);
    pushChange(details, "Responsable", previous.fullName, next.fullName, readableValue);
    pushChange(details, "E-mail de facturation", previous.billingEmail, next.billingEmail, readableValue);
    pushChange(details, "Téléphone", previous.phone, next.phone, readableValue);
    if (Object.hasOwn(next, "creatorNote")) details.push("Note interne Créateur modifiée");
    for (const [field, label] of [["quoteTemplatePolicy", "Politique des devis"], ["quitusTemplatePolicy", "Politique des quitus"], ["reportTemplatePolicy", "Politique des rapports"]]) pushChange(details, label, previous[field], next[field], readableValue);
    return details;
}

function capacityTitle(pcDelta, mobileDelta) {
    if ((pcDelta > 0 || mobileDelta > 0) && (pcDelta < 0 || mobileDelta < 0)) return "Répartition des postes modifiée";
    if (pcDelta > 0 || mobileDelta > 0) return "Ajout de postes";
    if (pcDelta < 0 || mobileDelta < 0) return "Retrait de postes";
    return "Capacité mise à jour";
}

function pushChange(details, label, previous, next, format = readableValue, includeDelta = false) {
    if (next === undefined || JSON.stringify(previous ?? null) === JSON.stringify(next ?? null)) return;
    const delta = includeDelta ? numericDelta(previous, next) : 0;
    details.push(`${label} : ${format(previous)} → ${format(next)}${delta ? ` (${delta > 0 ? "+" : ""}${delta})` : ""}`);
}

function numericDelta(previous, next) { return Number.isFinite(Number(previous)) && Number.isFinite(Number(next)) ? Number(next) - Number(previous) : 0; }
function tierRank(value) { return ({ basic: 1, basic_plus: 2, pro: 3 })[value] || 0; }
function cents(value) { return Number.isFinite(Number(value)) ? `${(Number(value) / 100).toFixed(2).replace(".", ",")} €` : "—"; }
function readableValue(value) { return value === undefined || value === null || value === "" ? "Aucun" : String(value).replaceAll("_", " "); }
function formatHistoryDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value || "") : date.toLocaleDateString("fr-FR"); }
