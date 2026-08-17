import { getContainer, setPage, createBackCard } from "./ui.js?v=44";
import { ROUTES } from "./config.js?v=123";
import { escapeHtml } from "./utils.js?v=44";

const LABELS = { quote: "devis", invoice: "facture", quitus: "quitus", report: "rapport de recherche de fuite" };
let pdfJsPromise = null;

export async function renderDocumentTemplateEditor(type, onBack) {
    if (!LABELS[type]) return;
    setPage(`Modèle de ${LABELS[type]}`, ROUTES.settings, "detail");
    const container = getContainer();
    container.appendChild(createBackCard("Retour aux modèles de documents", onBack));
    const shell = document.createElement("section");
    shell.className = "template-studio";
    shell.innerHTML = `<header class="template-studio-heading"><div><p class="eyebrow">Modèle personnalisé</p><h2>${escapeHtml(capitalize(LABELS[type]))}</h2><p class="muted">Le modèle actif remplace entièrement la présentation Depann’Home Pro. Seules les zones ci-dessous reçoivent les données métier.</p></div></header><div class="template-studio-loading">Chargement…</div>`;
    container.appendChild(shell);
    const result = await api(`/api/document-templates/${type}`);
    if (!result.ok) { shell.querySelector(".template-studio-loading").textContent = result.message || "Chargement impossible."; return; }
    renderStudio(shell, type, result.data, onBack);
}

function renderStudio(shell, type, payload, onBack, preferredId = 0) {
    const templates = payload.templates || [];
    let current = templates.find(item => Number(item.id) === Number(preferredId)) || templates[0] || null;
    let definition = clone(current?.definition || emptyDefinition());
    let selectedId = definition.zones?.[0]?.id || "";
    shell.innerHTML = `
        <header class="template-studio-heading"><div><p class="eyebrow">Éditeur de modèle</p><h2>${escapeHtml(capitalize(LABELS[type]))}</h2><p class="muted">Un seul rendu visuel est généré : votre modèle et les données placées dans ses zones.</p></div><span class="template-studio-status ${current?.status === "active" ? "active" : ""}">${current?.status === "active" ? "Modèle actif" : "Modèle natif actif"}</span></header>
        <section class="template-studio-import"><form data-upload enctype="multipart/form-data"><label>Nom du modèle<input name="name" maxlength="160" placeholder="Ex. Papier à en-tête 2026"></label><label>Importer un PDF, PNG ou JPEG<input name="template" type="file" accept="application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg" required></label><button class="secondary-button" type="submit">Importer et configurer</button></form><p class="auth-message" data-message></p></section>
        ${templates.length ? `<nav class="template-version-list">${templates.map(item => `<button type="button" data-version="${item.id}" class="${current?.id === item.id ? "selected" : ""}"><strong>v${item.version} · ${escapeHtml(item.name)}</strong><small>${item.status === "active" ? "Actif" : "Brouillon"} · ${escapeHtml(item.sourceFilename)}</small></button>`).join("")}</nav>` : '<div class="empty-state">Importez un modèle pour ouvrir l’éditeur. Le modèle Depann’Home Pro reste utilisé jusque-là.</div>'}
        ${current ? editorHtml(payload.fields, definition) : ""}`;
    bindUpload(shell, type, onBack);
    if (!current) return;
    shell.querySelectorAll("[data-version]").forEach(button => button.addEventListener("click", () => renderStudio(shell, type, payload, onBack, button.dataset.version)));
    const stage = shell.querySelector("[data-template-stage]");
    const zoneLayer = shell.querySelector("[data-zone-layer]");
    const render = () => {
        stage.style.aspectRatio = `${definition.page.width}/${definition.page.height}`;
        zoneLayer.replaceChildren(...definition.zones.map(zone => zoneNode(zone, definition, selectedId, selectZone)));
        renderProperties();
    };
    const selectZone = id => { selectedId = id; zoneLayer.querySelectorAll(".template-zone").forEach(node => node.classList.toggle("selected", node.dataset.zoneId === id)); renderProperties(); };
    const renderProperties = () => {
        const panel = shell.querySelector("[data-zone-properties]"); const zone = definition.zones.find(item => item.id === selectedId);
        if (!zone) { panel.innerHTML = '<p class="muted">Sélectionnez une zone sur la page.</p>'; return; }
        panel.innerHTML = `<h3>Zone sélectionnée</h3><label>Identifiant<input data-prop="id" value="${escapeHtml(zone.id)}"></label>${zone.type === "fixed" ? `<label>Texte fixe<textarea data-prop="text" rows="3">${escapeHtml(zone.text || "")}</textarea></label>` : `<label>Champ<select data-prop="field">${payload.fields.map(field => `<option value="${field}" ${field === zone.field ? "selected" : ""}>${escapeHtml(field)}</option>`).join("")}</select></label>`}<div class="template-property-grid"><label>Taille<input data-style="fontSize" type="number" min="5" max="36" value="${zone.style.fontSize || 10}"></label><label>Couleur<input data-style="color" type="color" value="${zone.style.color || "#172033"}"></label><label>Bordure<input data-style="borderColor" type="color" value="${zone.style.borderColor || "#d7dde3"}"></label><label>Épaisseur<input data-style="borderWidth" type="number" min="0" max="8" value="${zone.style.borderWidth || 0}"></label><label>Page<select data-prop="page"><option value="first" ${zone.page === "first" ? "selected" : ""}>Première</option><option value="all" ${zone.page === "all" ? "selected" : ""}>Toutes</option><option value="final" ${zone.page === "final" ? "selected" : ""}>Dernière</option></select></label><label>Alignement<select data-style="align"><option value="left" ${zone.style.align === "left" ? "selected" : ""}>Gauche</option><option value="center" ${zone.style.align === "center" ? "selected" : ""}>Centre</option><option value="right" ${zone.style.align === "right" ? "selected" : ""}>Droite</option></select></label></div><label class="template-check"><input data-style="bold" type="checkbox" ${zone.style.bold ? "checked" : ""}> Texte en gras</label><button type="button" class="danger-button secondary-button" data-delete-zone>Supprimer la zone</button>`;
        panel.querySelectorAll("[data-prop]").forEach(input => input.addEventListener("change", () => { const previous = zone.id; zone[input.dataset.prop] = input.value; if (input.dataset.prop === "id") selectedId = input.value || previous; render(); }));
        panel.querySelectorAll("[data-style]").forEach(input => input.addEventListener("change", () => { zone.style[input.dataset.style] = input.type === "checkbox" ? input.checked : input.type === "number" ? Number(input.value) : input.value; render(); }));
        panel.querySelector("[data-delete-zone]").addEventListener("click", () => { definition.zones = definition.zones.filter(item => item !== zone); selectedId = definition.zones[0]?.id || ""; render(); });
    };
    bindPageControls(shell, definition, render);
    shell.querySelector("[data-add-field]").addEventListener("click", () => { const field = shell.querySelector("[data-field-library]").value; const typeForField = field.endsWith(".lines") ? "table" : field.endsWith(".photos") ? "photos" : field.endsWith(".observations") && type === "report" ? "repeatText" : field.endsWith(".logo") ? "image" : field.endsWith(".signature") ? "signature" : "text"; const zone = newZone(field.replaceAll(".", "-"), typeForField, field); definition.zones.push(zone); selectedId = zone.id; render(); });
    shell.querySelector("[data-add-fixed]").addEventListener("click", () => { const zone = newZone(`texte-${definition.zones.length + 1}`, "fixed", ""); zone.text = "Nouveau texte fixe"; definition.zones.push(zone); selectedId = zone.id; render(); });
    shell.querySelector("[data-save]").addEventListener("click", async () => { const result = await api(`/api/document-templates/${type}/${current.id}`, { method: "PUT", body: JSON.stringify({ name: current.name, definition }) }); feedback(shell, result.ok ? "Modèle enregistré en brouillon." : result.message, !result.ok); });
    shell.querySelector("[data-activate]").addEventListener("click", async () => { await saveSilently(type, current, definition); const result = await api(`/api/document-templates/${type}/${current.id}/activate`, { method: "POST", body: "{}" }); if (!result.ok) return feedback(shell, result.message || "Activation impossible.", true); await reload(shell, type, onBack, current.id); });
    shell.querySelector("[data-native]").addEventListener("click", async () => { const result = await api(`/api/document-templates/${type}/native`, { method: "POST", body: "{}" }); if (result.ok) await reload(shell, type, onBack, current.id); else feedback(shell, result.message, true); });
    shell.querySelector("[data-preview]").addEventListener("click", () => preview(type, current.id, definition, false));
    shell.querySelector("[data-test]").addEventListener("click", () => preview(type, current.id, definition, true));
    renderSource(stage, current, type);
    render();
}

function editorHtml(fields, definition) {
    return `<div class="template-studio-toolbar"><label>Champ dynamique<select data-field-library>${fields.map(field => `<option value="${field}">${escapeHtml(field)}</option>`).join("")}</select></label><button type="button" class="secondary-button" data-add-field>Ajouter le champ</button><button type="button" class="secondary-button" data-add-fixed>Ajouter un texte fixe</button></div><div class="template-studio-layout"><aside class="template-page-settings"><h3>Page et couleurs</h3><label>Couleur principale<input data-page-color="primary" type="color" value="${definition.colors?.primary || "#003b73"}"></label><label>Couleur secondaire<input data-page-color="secondary" type="color" value="${definition.colors?.secondary || "#0a5c36"}"></label>${["top", "right", "bottom", "left"].map(side => `<label>Marge ${side}<input data-margin="${side}" type="number" min="0" max="200" value="${definition.page?.margins?.[side] ?? 30}"></label>`).join("")}<div data-zone-properties></div></aside><main class="template-canvas-wrap"><div class="template-page" data-template-stage><canvas data-source-canvas></canvas><img data-source-image alt="Modèle importé" hidden><div class="template-zone-layer" data-zone-layer></div></div></main></div><footer class="template-studio-actions"><p class="auth-message" data-editor-message></p><button type="button" class="secondary-button" data-native>Utiliser le modèle Depann’Home Pro</button><button type="button" class="secondary-button" data-save>Enregistrer</button><button type="button" class="secondary-button" data-preview>Prévisualiser</button><button type="button" class="secondary-button" data-test>Tester le modèle</button><button type="button" class="secondary-button" data-activate>Activer comme modèle par défaut</button></footer>`;
}

function zoneNode(zone, definition, selectedId, select) {
    const node = document.createElement("button"); node.type = "button"; node.className = `template-zone ${zone.id === selectedId ? "selected" : ""} type-${zone.type}`; node.dataset.zoneId = zone.id;
    Object.assign(node.style, { left: `${zone.x / definition.page.width * 100}%`, top: `${zone.y / definition.page.height * 100}%`, width: `${zone.width / definition.page.width * 100}%`, height: `${zone.height / definition.page.height * 100}%`, color: zone.style.color || "#172033", borderColor: zone.style.borderColor || definition.colors.primary, fontSize: `${Math.max(8, zone.style.fontSize || 10)}px` });
    node.innerHTML = `<span>${escapeHtml(zone.type === "fixed" ? zone.text || "Texte fixe" : zone.field)}</span><i aria-hidden="true"></i>`;
    node.addEventListener("click", event => { event.stopPropagation(); select(zone.id); });
    bindPointer(node, zone, definition, select);
    return node;
}

function bindPointer(node, zone, definition, select) {
    node.addEventListener("pointerdown", event => {
        event.preventDefault(); select(zone.id); const resize = event.target.tagName === "I"; const rect = node.parentElement.getBoundingClientRect(); const start = { x: event.clientX, y: event.clientY, zone: { ...zone } };
        node.setPointerCapture(event.pointerId);
        const move = current => { const dx = (current.clientX - start.x) / rect.width * definition.page.width; const dy = (current.clientY - start.y) / rect.height * definition.page.height; if (resize) { zone.width = clamp(start.zone.width + dx, 20, definition.page.width - zone.x); zone.height = clamp(start.zone.height + dy, 12, definition.page.height - zone.y); } else { zone.x = clamp(start.zone.x + dx, 0, definition.page.width - zone.width); zone.y = clamp(start.zone.y + dy, 0, definition.page.height - zone.height); } Object.assign(node.style, { left: `${zone.x / definition.page.width * 100}%`, top: `${zone.y / definition.page.height * 100}%`, width: `${zone.width / definition.page.width * 100}%`, height: `${zone.height / definition.page.height * 100}%` }); };
        node.addEventListener("pointermove", move); node.addEventListener("pointerup", () => node.removeEventListener("pointermove", move), { once: true });
    });
}

async function renderSource(stage, template, type) {
    const canvas = stage.querySelector("[data-source-canvas]"); const image = stage.querySelector("[data-source-image]"); const url = `/api/document-templates/${type}/${template.id}/source`;
    if (template.sourceMimeType === "application/pdf") { image.hidden = true; canvas.hidden = false; const pdfjs = await loadPdfJs(); const task = pdfjs.getDocument({ url, withCredentials: true, standardFontDataUrl: "/vendor/pdfjs/standard_fonts/", cMapUrl: "/vendor/pdfjs/cmaps/", cMapPacked: true, wasmUrl: "/vendor/pdfjs/wasm/" }); const pdf = await task.promise; const page = await pdf.getPage(1); const initial = page.getViewport({ scale: 1 }); const viewport = page.getViewport({ scale: 1100 / initial.width }); canvas.width = viewport.width; canvas.height = viewport.height; await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise; }
    else { canvas.hidden = true; image.hidden = false; image.src = url; }
}
function loadPdfJs() { if (!pdfJsPromise) pdfJsPromise = import("/vendor/pdfjs/build/pdf.min.mjs?v=5.4.54").then(pdfjs => { pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/build/pdf.worker.min.mjs?v=5.4.54"; return pdfjs; }); return pdfJsPromise; }
function bindPageControls(shell, definition, render) { shell.querySelectorAll("[data-margin]").forEach(input => input.addEventListener("change", () => { definition.page.margins[input.dataset.margin] = Number(input.value); })); shell.querySelectorAll("[data-page-color]").forEach(input => input.addEventListener("change", () => { definition.colors[input.dataset.pageColor] = input.value; render(); })); }
function bindUpload(shell, type, onBack) { shell.querySelector("[data-upload]").addEventListener("submit", async event => { event.preventDefault(); const result = await api(`/api/document-templates/${type}`, { method: "POST", body: new FormData(event.currentTarget) }); if (!result.ok) return feedback(shell, result.message || "Import impossible.", true); await reload(shell, type, onBack, result.data.template.id); }); }
async function reload(shell, type, onBack, id) { const result = await api(`/api/document-templates/${type}`); if (result.ok) renderStudio(shell, type, result.data, onBack, id); }
async function saveSilently(type, current, definition) { return api(`/api/document-templates/${type}/${current.id}`, { method: "PUT", body: JSON.stringify({ name: current.name, definition }) }); }
async function preview(type, id, definition, stress) { const response = await fetch(`/api/document-templates/${type}/${id}/${stress ? "test" : "preview"}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ definition }) }); if (!response.ok) { const error = await response.json().catch(() => null); alert(error?.message || "Prévisualisation impossible."); return; } const warnings = JSON.parse(decodeURIComponent(response.headers.get("X-Template-Warnings") || "%5B%5D")); const blob = await response.blob(); const url = URL.createObjectURL(blob); const dialog = document.createElement("section"); dialog.className = "template-preview-dialog"; dialog.innerHTML = `<div><header><div><p class="eyebrow">${stress ? "Test automatique multipage" : "Prévisualisation finale"}</p><h2>Aperçu sans modèle natif superposé</h2>${warnings.length ? `<p class="auth-message error">${warnings.map(escapeHtml).join(" · ")}</p>` : '<p class="auth-message">Aucun débordement ou chevauchement de zones détecté.</p>'}</div><button type="button" class="secondary-button">Fermer</button></header><iframe title="Prévisualisation du modèle"></iframe></div>`; dialog.querySelector("iframe").src = url; dialog.querySelector("button").addEventListener("click", () => { URL.revokeObjectURL(url); dialog.remove(); }); document.body.append(dialog); }
function newZone(id, type, field) { return { id: `${id}-${Date.now().toString(36)}`, type, field, text: "", page: ["table", "photos", "repeatText"].includes(type) ? "all" : "first", x: 55, y: 150, width: type === "table" || type === "photos" || type === "repeatText" ? 480 : 220, height: type === "table" ? 360 : type === "photos" ? 260 : 50, style: { fontSize: 10, color: "#172033", borderColor: "#d7dde3", borderWidth: 1, align: "left", bold: false, rowHeight: 22, rows: 2, gap: 8 } }; }
function emptyDefinition() { return { schemaVersion: 1, page: { width: 595.28, height: 841.89, margins: { top: 30, right: 30, bottom: 30, left: 30 } }, colors: { primary: "#003b73", secondary: "#0a5c36" }, zones: [] }; }
function feedback(shell, text, error = false) { const node = shell.querySelector("[data-editor-message]") || shell.querySelector("[data-message]"); if (!node) return; node.textContent = text || ""; node.classList.toggle("error", error); }
async function api(url, options = {}) { try { const headers = options.body instanceof FormData ? {} : { "Content-Type": "application/json", ...(options.headers || {}) }; const response = await fetch(url, { credentials: "same-origin", ...options, headers }); const data = response.status === 204 ? null : await response.json().catch(() => null); return { ok: response.ok, data, message: data?.message }; } catch { return { ok: false, data: null, message: "Serveur indisponible." }; } }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function capitalize(value) { return value.charAt(0).toUpperCase() + value.slice(1); }
