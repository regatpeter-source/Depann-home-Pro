import { escapeHtml } from "./utils.js?v=44";
import { synchronizeClients } from "./client-sync.js?v=125";

const TYPES = [
    ["clients", "Clients", "Fiches client, coordonnées et notes"],
    ["quotes", "Devis", "Documents et lignes de prestation"],
    ["invoices", "Factures", "Documents et lignes de prestation"],
    ["reports", "Rapports d’intervention", "Rapports historiques importés en brouillon"]
];

function availableTypes(clientOnly) {
    return clientOnly ? TYPES.filter(([key]) => key === "clients") : TYPES;
}

export function renderDataImportTool(container, { clientOnly = false } = {}) {
    const partnerClientImport = clientOnly;
    const card = document.createElement("article");
    card.className = "brand-card full-card procedure-card data-import-card";
    card.innerHTML = `<p class="eyebrow">Outils</p><h2>${partnerClientImport ? "Importation de clients" : "Importation de données"}</h2><p>${partnerClientImport ? "Ajoutez vos fiches clients depuis un fichier Excel ou CSV sans ressaisie." : "Reprenez vos données Excel ou CSV sans ressaisie."} L’analyse, la correspondance des colonnes et les doublons sont vérifiés avant toute écriture.</p><div class="data-import-actions"><button type="button" class="secondary-button">${partnerClientImport ? "Importer des clients" : "Importer des données"}</button><button type="button" class="secondary-button data-import-history-button">Journal des imports</button></div>`;
    card.querySelector("button").addEventListener("click", () => openWizard(card, clientOnly));
    card.querySelector(".data-import-history-button").addEventListener("click", () => showHistory(card));
    container.appendChild(card);
}

function openWizard(card, clientOnly) {
    const partnerClientImport = clientOnly;
    const modal = document.createElement("section");
    modal.className = "data-import-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.dataset.clientOnly = String(clientOnly);
    modal.innerHTML = `<div class="data-import-dialog"><div class="data-import-dialog-header"><div><p class="eyebrow">Outils · ${partnerClientImport ? "Importation de clients" : "Importation de données"}</p><h2>Assistant d’importation</h2></div><button type="button" class="secondary-button" data-close>Fermer</button></div><ol class="data-import-steps"><li class="active">1. Fichier</li><li>2. Correspondance</li><li>3. Vérification</li><li>4. Import</li></ol><div class="data-import-content"></div></div>`;
    document.body.appendChild(modal);
    modal.querySelector("[data-close]").addEventListener("click", () => modal.remove());
    modal.addEventListener("click", event => { if (event.target === modal) modal.remove(); });
    renderFileStep(modal);
}

function renderFileStep(modal) {
    setStep(modal, 0);
    const content = modal.querySelector(".data-import-content");
    content.innerHTML = `<form class="data-import-form"><label>Type de données<select name="dataType">${availableTypes(modal.dataset.clientOnly === "true").map(([key, label, description]) => `<option value="${key}">${escapeHtml(label)} — ${escapeHtml(description)}</option>`).join("")}</select></label><section class="data-import-template"><strong>Besoin d’un fichier prêt à remplir&nbsp;?</strong><p class="muted">Téléchargez un modèle Excel avec les bonnes colonnes et une feuille d’instructions. Il sera reconnu automatiquement lors de l’import.</p><button type="button" class="secondary-button" data-template>Télécharger le modèle Excel</button></section><label>Fichier Excel ou CSV<input name="file" type="file" accept=".xlsx,.csv" required></label><p class="muted">Formats acceptés : .xlsx et .csv · taille maximale 10 Mo · 10 000 lignes analysées au maximum.</p><div class="form-actions"><button class="secondary-button" type="submit">Analyser le fichier</button></div><p class="auth-message" aria-live="polite"></p></form>`;
    content.querySelector("[data-template]").addEventListener("click", () => { const dataType = content.querySelector('[name="dataType"]').value; window.location.assign(`/api/data-imports/template?dataType=${encodeURIComponent(dataType)}`); });
    content.querySelector("form").addEventListener("submit", async event => {
        event.preventDefault(); const form = event.currentTarget; const feedback = form.querySelector(".auth-message"); const button = form.querySelector("button");
        const file = form.elements.file.files[0]; if (!file) return;
        button.disabled = true; feedback.textContent = "Analyse sécurisée du fichier…"; feedback.classList.remove("error");
        try { const body = new FormData(form); const result = await request("/api/data-imports/analyze", { method: "POST", body }); renderMappingStep(modal, result); } catch (error) { feedback.textContent = error.message; feedback.classList.add("error"); button.disabled = false; }
    });
}

function renderMappingStep(modal, session) {
    setStep(modal, 1); const content = modal.querySelector(".data-import-content"); const mapping = session.suggestedMapping || {}; const clientNameHint = session.dataType === "clients" ? "<p class=\"muted\">« Nom client / société » doit correspondre à une colonne contenant les noms. « Client_ID » est un identifiant technique et ne peut pas remplacer ce champ obligatoire.</p>" : "";
    content.innerHTML = `<div class="data-import-analysis"><strong>${session.rowCount.toLocaleString("fr-FR")} ligne(s) détectée(s)</strong><span>${escapeHtml(session.filename)}</span>${session.readErrors?.length ? `<p class="auth-message error">${session.readErrors.map(escapeHtml).join("<br>")}</p>` : ""}</div><form class="data-import-mapping"><p>Associez les colonnes de votre fichier aux champs Depann'Home Pro. Les champs marqués * sont obligatoires.</p>${clientNameHint}<div class="data-import-mapping-grid">${session.fields.map(field => `<label>${escapeHtml(field.label)}${field.required ? " *" : ""}<select name="${escapeHtml(field.key)}"><option value="">Ne pas importer</option>${session.columns.map(column => `<option value="${escapeHtml(column)}" ${field.key === "name" && isClientIdentifierColumn(column) ? "disabled" : ""} ${mapping[field.key] === column ? "selected" : ""}>${escapeHtml(column)}</option>`).join("")}</select></label>`).join("")}</div><div class="form-actions"><button type="button" class="secondary-button" data-back>Choisir un autre fichier</button><button type="submit" class="secondary-button">Prévisualiser</button></div><p class="auth-message" aria-live="polite"></p></form>`;
    content.querySelector("[data-back]").addEventListener("click", () => renderFileStep(modal));
    content.querySelector("form").addEventListener("submit", async event => {
        event.preventDefault(); const form = event.currentTarget; const feedback = form.querySelector(".auth-message"); const button = form.querySelector('[type="submit"]'); button.disabled = true; feedback.textContent = "Vérification des données…";
        const mapping = Object.fromEntries(new FormData(form));
        try { const preview = await request("/api/data-imports/preview", { method: "POST", json: { sessionId: session.sessionId, mapping, duplicateStrategy: "skip" } }); renderPreviewStep(modal, session, mapping, preview); } catch (error) { feedback.textContent = error.message; feedback.classList.add("error"); button.disabled = false; }
    });
}

function renderPreviewStep(modal, session, mapping, preview) {
    setStep(modal, 2); const content = modal.querySelector(".data-import-content"); const summary = preview.summary;
    content.innerHTML = `<div class="data-import-summary"><span><strong>${summary.detectedRecords}</strong> élément(s)</span><span><strong>${summary.newCount}</strong> nouveau(x)</span><span><strong>${summary.duplicateCount}</strong> doublon(s)</span><span><strong>${summary.errorCount}</strong> erreur(s)</span></div><form class="data-import-confirm"><label>Gestion des doublons<select name="duplicateStrategy"><option value="skip">Ignorer les doublons</option><option value="update">Mettre à jour les données existantes</option><option value="newOnly">Importer uniquement les nouveaux éléments</option></select></label><p class="muted">Les lignes invalides seront signalées dans le journal, sans bloquer les autres lignes. Les rapports importés restent des brouillons non associés à un rendez-vous.</p>${preview.errors?.length ? `<details class="data-import-errors"><summary>${preview.errors.length} erreur(s) identifiée(s)</summary><ul>${preview.errors.map(error => `<li>Ligne ${escapeHtml(error.row)} : ${escapeHtml(error.message)}</li>`).join("")}</ul></details>` : ""}<div class="data-import-preview-table"><table><thead><tr><th>Ligne(s)</th><th>Données</th><th>État</th></tr></thead><tbody>${preview.preview.map(item => `<tr><td>${item.rows.map(escapeHtml).join(", ")}</td><td>${escapeHtml(Object.values(item.data).filter(value => typeof value === "string" && value).join(" · ").slice(0, 300))}</td><td>${item.errors?.length ? `<span class="error">${escapeHtml(item.errors.join(" "))}</span>` : item.duplicate ? "Doublon" : "Prêt"}</td></tr>`).join("")}</tbody></table></div><div class="form-actions"><button type="button" class="secondary-button" data-back>Modifier les correspondances</button><button type="submit" class="secondary-button">Confirmer l’import</button></div><p class="auth-message" aria-live="polite"></p></form>`;
    content.querySelector("[data-back]").addEventListener("click", () => renderMappingStep(modal, session));
    content.querySelector("form").addEventListener("submit", async event => {
        event.preventDefault(); const form = event.currentTarget; const feedback = form.querySelector(".auth-message"); const button = form.querySelector('[type="submit"]'); button.disabled = true; feedback.textContent = "Importation en cours : les lignes valides continuent même si certaines échouent…";
        try { const result = await request("/api/data-imports/confirm", { method: "POST", json: { sessionId: session.sessionId, mapping, duplicateStrategy: form.elements.duplicateStrategy.value } }); renderResultStep(modal, session, result); } catch (error) { feedback.textContent = error.message; feedback.classList.add("error"); button.disabled = false; }
    });
}

function renderResultStep(modal, session, result) {
    setStep(modal, 3); const content = modal.querySelector(".data-import-content");
    content.innerHTML = `<div class="data-import-result"><p class="eyebrow">Import terminé</p><h3>${escapeHtml(result.message)}</h3><div class="data-import-summary"><span><strong>${result.importedCount}</strong> importé(s)</span><span><strong>${result.duplicateCount}</strong> doublon(s)</span><span><strong>${result.errorCount}</strong> erreur(s)</span></div>${result.errors?.length ? `<details class="data-import-errors"><summary>Voir les erreurs</summary><ul>${result.errors.map(error => `<li>Ligne ${escapeHtml(error.row)} : ${escapeHtml(error.message)}</li>`).join("")}</ul></details>` : ""}<div class="form-actions"><button type="button" class="secondary-button" data-history>Voir le journal</button><button type="button" class="secondary-button" data-close>Terminer</button></div></div>`;
    if (session.dataType === "clients") synchronizeClients();
    content.querySelector("[data-close]").addEventListener("click", () => modal.remove());
    content.querySelector("[data-history]").addEventListener("click", () => showHistory(content));
}

async function showHistory(target) {
    const panel = target.closest(".data-import-card") || target.querySelector(".data-import-content") || target; panel.querySelector(".data-import-history")?.remove();
    const history = document.createElement("section"); history.className = "data-import-history"; history.innerHTML = "<p class=\"muted\">Chargement du journal…</p>"; panel.appendChild(history);
    try { const result = await request("/api/data-imports/history"); history.innerHTML = `<h3>Journal des imports</h3>${result.imports.length ? `<div class="data-import-preview-table"><table><thead><tr><th>Date / utilisateur</th><th>Type / fichier</th><th>Importés</th><th>Doublons</th><th>Erreurs</th></tr></thead><tbody>${result.imports.map(item => `<tr><td>${escapeHtml(new Date(item.createdAt).toLocaleString("fr-FR"))}<small>${escapeHtml(item.startedBy)}</small></td><td>${escapeHtml(typeLabel(item.dataType))}<small>${escapeHtml(item.filename)}</small></td><td>${item.importedCount}</td><td>${item.duplicateCount}</td><td>${item.errorCount}</td></tr>`).join("")}</tbody></table></div>` : "<p class=\"muted\">Aucun import enregistré.</p>"}`; } catch (error) { history.innerHTML = `<p class="auth-message error">${escapeHtml(error.message)}</p>`; }
}
function setStep(modal, active) { modal.querySelectorAll(".data-import-steps li").forEach((step, index) => step.classList.toggle("active", index === active)); }
function isClientIdentifierColumn(value) { return /^(client[ _-]?)?id(entifiant)?$/.test(String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim()); }
function typeLabel(value) { return TYPES.find(([key]) => key === value)?.[1] || value; }
async function request(url, options = {}) { const headers = options.json ? { "Content-Type": "application/json" } : {}; const response = await fetch(url, { method: options.method || "GET", headers, body: options.json ? JSON.stringify(options.json) : options.body, credentials: "same-origin" }); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.message || "La demande a échoué."); return payload; }
