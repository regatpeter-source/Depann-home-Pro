import { ROUTES } from "./config.js?v=57";
import { getSearchResults } from "./search.js?v=57";
import { resetSelection } from "./state.js?v=44";
import {
    createButton,
    createCard,
    createInfo,
    clearSearch,
    getContainer,
    renderError,
    setPage
} from "./ui.js?v=44";
import { escapeHtml, normalizeText } from "./utils.js?v=44";

let classifierPromise = null;
let currentDatabase = { brands: [] };

export async function analyzeEquipmentPhoto(file, database) {
    const predictions = await classifyImage(file).catch(() => []);
    const query = buildSearchQuery(file.name, predictions);
    const bankResults = getImageBankResults(database, file, predictions, query);
    const searchResults = getSearchResults(database, query);
    const results = mergeResults(bankResults, searchResults);
    return { file, predictions, query, results, bankResults, searchResults };
}

export function isPhotoRecognitionConfident(predictions, bestResult) {
    if (!predictions.length) return false;
    const topScore = predictions[0].score || 0;
    return topScore >= 0.35 && Boolean(bestResult);
}

export function renderPhotoRecognition(database, navigateToRef) {
    clearSearch();
    resetSelection("all");
    setPage("Reconnaissance visuelle", ROUTES.photo, "detail");

    const container = getContainer();
    const panel = document.createElement("article");
    panel.className = "brand-card full-card procedure-card photo-recognition-panel";

    panel.innerHTML = `
        <div class="procedure-header">
            <div>
                <p class="eyebrow">Photo d’équipement</p>
                <h2> Reconnaissance visuelle</h2>
            </div>
        </div>
        <p class="muted">Prenez ou importez une photo d’un moteur, d’une télécommande, d’un portail ou d’un volet roulant pour ouvrir automatiquement le dossier le plus probable.</p>

        <section class="procedure-section">
            <h3>1. Choisir la photo</h3>
            <div class="photo-recognition-actions">
                <label class="photo-capture-label">
                    Prendre une photo depuis l’app
                    <input id="photoRecognitionInput" type="file" accept="image/*" capture="environment">
                </label>

                <button type="button" class="secondary-button" id="analyzePhotoBtn">
                    Analyser la photo
                </button>
            </div>
            <p class="muted small-note">La reconnaissance est assistée par IA quand le navigateur peut charger le modèle. Sinon, l’app propose des correspondances à partir du catalogue.</p>
        </section>

        <section class="procedure-section">
            <h3>2. Résultat</h3>
            <div id="photoRecognitionStatus" class="muted">Aucune photo analysée pour le moment.</div>
            <div id="photoRecognitionPreview"></div>
            <div id="photoRecognitionResults"></div>
        </section>
    `;

    container.appendChild(panel);

    const input = panel.querySelector("#photoRecognitionInput");
    const analyzeButton = panel.querySelector("#analyzePhotoBtn");
    const status = panel.querySelector("#photoRecognitionStatus");
    const preview = panel.querySelector("#photoRecognitionPreview");
    const resultsContainer = panel.querySelector("#photoRecognitionResults");

    let selectedFile = null;

    const openCamera = () => {
        if (!input) return;
        try {
            input.click();
        } catch {
            // fallback silently if browser blocks the automatic click
        }
    };

    window.setTimeout(openCamera, 150);

    input.addEventListener("change", event => {
        selectedFile = event.target.files?.[0] || null;
        preview.innerHTML = selectedFile ? renderPreview(selectedFile) : "";
        resultsContainer.innerHTML = "";
        status.textContent = selectedFile
            ? `Photo sélectionnée : ${selectedFile.name}`
            : "Aucune photo sélectionnée.";

        if (selectedFile) {
            window.setTimeout(() => analyzeButton.click(), 120);
        }
    });

    analyzeButton.addEventListener("click", async () => {
        if (!selectedFile) {
            status.textContent = "Choisissez d’abord une photo.";
            return;
        }

        analyzeButton.disabled = true;
        analyzeButton.textContent = "Analyse en cours...";
        status.textContent = "Analyse de la photo en cours...";
        resultsContainer.innerHTML = "";

        try {
            const analysis = await analyzePhoto(selectedFile, database);
            renderAnalysisResults(analysis, resultsContainer, navigateToRef, status);
        } catch (error) {
            renderError("Reconnaissance visuelle indisponible", error.message);
        } finally {
            analyzeButton.disabled = false;
            analyzeButton.textContent = "Analyser la photo";
        }
    });
}

async function analyzePhoto(file, database) {
    currentDatabase = database;
    return analyzeEquipmentPhoto(file, database);
}

function getImageBankResults(database, file, predictions, query) {
    const fileTokens = tokenize([file.name, query, ...predictions.map(item => item.label)].join(" "));
    const results = [];

    database.brands.forEach((brand, brandIndex) => {
        brand.categories.forEach((category, categoryIndex) => {
            category.products.forEach((product, productIndex) => {
                const searchable = normalizeText([
                    brand.name,
                    category.name,
                    product.name,
                    product.reference || "",
                    ...(Array.isArray(product.keywords) ? product.keywords : []),
                    ...(Array.isArray(product.photos) ? product.photos.map(getFileName) : [])
                ].join(" "));

                let score = 0;
                fileTokens.forEach(token => {
                    if (token.length < 2) return;
                    if (searchable.includes(token)) score += 1;
                    if (normalizeText(product.reference || "").replace(/\s+/g, "").includes(token.replace(/\s+/g, ""))) score += 2;
                });

                if (score <= 0) return;

                results.push({
                    icon: "",
                    title: product.name,
                    subtitle: `${brand.name} · ${category.name} · catalogue`,
                    ref: { type: "product", brandIndex, categoryIndex, productIndex },
                    score,
                    source: "catalogue"
                });
            });
        });
    });

    return results.sort((a, b) => b.score - a.score).slice(0, 12);
}

function mergeResults(primaryResults, fallbackResults) {
    const merged = [];
    const seen = new Set();

    [...primaryResults, ...fallbackResults].forEach(result => {
        const key = JSON.stringify(result.ref);
        if (seen.has(key)) return;
        seen.add(key);
        merged.push(result);
    });

    return merged.slice(0, 40);
}
function getRefPhoto(ref) {
    if (ref?.type !== "product") return "";
    const product = currentDatabase?.brands?.[ref.brandIndex]?.categories?.[ref.categoryIndex]?.products?.[ref.productIndex];
    return Array.isArray(product?.photos) && product.photos.length ? product.photos[0] : "";
}
function tokenize(value) {
    return normalizeText(value)
        .split(/\s+/)
        .map(token => token.trim())
        .filter(Boolean);
}

function getFileName(filePath) {
    return String(filePath || "").split("/").pop() || "";
}

function renderAnalysisResults(analysis, resultsContainer, navigateToRef, status) {
    const { file, predictions, query, results } = analysis;

    const predictionsText = predictions.length
        ? predictions.map(item => `${item.label} (${Math.round(item.score * 100)}%)`).join(" · ")
        : "Aucune détection IA disponible";

    status.innerHTML = `
        <strong>Requête générée :</strong> ${escapeHtml(query)}<br>
        <strong>Indices visuels :</strong> ${escapeHtml(predictionsText)}
    `;

    if (!results.length) {
        resultsContainer.appendChild(createInfo("Aucun dossier correspondant n’a été trouvé. Essayez une photo plus nette ou utilisez la recherche textuelle."));
        return;
    }

    const best = results[0];
    const openButton = createButton("Ouvrir le meilleur dossier", "secondary-button", () => navigateToRef(best.ref));
    resultsContainer.appendChild(openButton);

    const topResult = document.createElement("div");
    topResult.className = "photo-recognition-best";
    topResult.innerHTML = `
        <p class="eyebrow">Correspondance principale</p>
        <h4>${escapeHtml(best.title)}</h4>
        <p class="muted">${escapeHtml(best.subtitle)}</p>
    `;
    resultsContainer.appendChild(topResult);

    const suggestions = document.createElement("div");
    suggestions.className = "photo-recognition-suggestions";
    suggestions.innerHTML = `<h4>Autres pistes</h4>`;

    results.slice(0, 5).forEach(result => {
        suggestions.appendChild(
            createCard(
                result.icon,
                result.title,
                result.subtitle,
                () => navigateToRef(result.ref),
                { full: true, image: getRefPhoto(result.ref) }
            )
        );
    });

    resultsContainer.appendChild(suggestions);

    const shouldAutoOpen = isConfidentEnough(predictions, best);
    if (shouldAutoOpen) {
        status.textContent = "Bonne correspondance trouvée, ouverture du dossier...";
        window.setTimeout(() => navigateToRef(best.ref), 850);
    }
}

function buildSearchQuery(fileName, predictions) {
    const source = normalizeText([fileName, ...predictions.map(pred => pred.label)].join(" "));
    const keywords = new Set();

    const refMatch = source.match(/([a-z0-9]+(?:[-_ ](?:io|rts|wt|s|m|xl))?)/gi);
    if (refMatch) {
        refMatch.forEach(token => {
            const cleaned = token.replace(/[^a-z0-9]+/g, " ").trim();
            if (cleaned.length) keywords.add(cleaned);
        });
    }

    if (/(remote control|clicker|transmitter|keypad|keyless|telecommande|commande)/.test(source)) {
        keywords.add("télécommande");
        keywords.add("commande");
    }

    if (/(garage door|door opener|gate|swing|sliding|barrier|portail|porte de garage)/.test(source)) {
        keywords.add("portail");
        keywords.add("porte de garage");
    }

    if (/(window blind|window shade|blind|shade|shutter|awning|roller blind|volet|store)/.test(source)) {
        keywords.add("volet roulant");
        keywords.add("store");
    }

    if (/(camera|security camera|alarm|monitor)/.test(source)) {
        keywords.add("alarme");
        keywords.add("caméra");
    }

    if (/(keypad|keyboard|switch|control)/.test(source)) {
        keywords.add("clavier");
        keywords.add("point de commande");
    }

    if (/(solar|panel|battery|sun)/.test(source)) {
        keywords.add("solaire");
    }

    const topLabels = predictions.slice(0, 4).map(pred => pred.label.replace(/[()]/g, " "));
    return [...keywords, ...topLabels].join(" ") || fileName;
}

function isConfidentEnough(predictions, bestResult) {
    if (!predictions.length) return false;
    const topScore = predictions[0].score || 0;
    return topScore >= 0.35 && Boolean(bestResult);
}

async function classifyImage(file) {
    const classifier = await loadClassifier();
    if (!classifier) return [];

    const image = await fileToImage(file);
    const predictions = await classifier(image, 5);

    return Array.isArray(predictions)
        ? predictions.map(prediction => ({
            label: prediction.label || "Inconnu",
            score: Number(prediction.score) || 0
        }))
        : [];
}

async function loadClassifier() {
    if (!classifierPromise) {
        classifierPromise = (async () => {
            const { pipeline } = await import("https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/+esm");
            return pipeline("image-classification", "Xenova/mobilenet_v2");
        })().catch(() => null);
    }

    return classifierPromise;
}

function fileToImage(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const image = new Image();

        image.onload = () => {
            URL.revokeObjectURL(url);
            resolve(image);
        };

        image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("Impossible de lire la photo."));
        };

        image.src = url;
    });
}

function renderPreview(file) {
    const url = URL.createObjectURL(file);
    window.setTimeout(() => URL.revokeObjectURL(url), 15_000);

    return `
        <figure class="photo-recognition-preview">
            <img src="${escapeHtml(url)}" alt="Aperçu de la photo sélectionnée">
            <figcaption>${escapeHtml(file.name)}</figcaption>
        </figure>
    `;
}
