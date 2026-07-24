const DATABASE_NAME = "depannHomeProLocalLibrary";
const DATABASE_VERSION = 1;
const SECTIONS_STORE = "sections";
const DOCUMENTS_STORE = "documents";

export async function getLocalLibrarySections(accountId) {
    const database = await openDatabase();
    const transaction = database.transaction([SECTIONS_STORE, DOCUMENTS_STORE], "readonly");
    const sections = await requestToPromise(transaction.objectStore(SECTIONS_STORE).index("accountId").getAll(String(accountId)));
    const documents = await requestToPromise(transaction.objectStore(DOCUMENTS_STORE).index("accountId").getAll(String(accountId)));
    await transactionComplete(transaction);
    return sections
        .map(section => normalizeSection({ ...section, documentCount: documents.filter(document => document.sectionId === section.id).length }))
        .sort((first, second) => first.name.localeCompare(second.name, "fr"));
}

export async function createLocalLibrarySection(accountId, name) {
    const section = {
        id: `local-section-${crypto.randomUUID()}`,
        accountId: String(accountId),
        name: String(name || "").trim(),
        createdAt: new Date().toISOString()
    };
    const database = await openDatabase();
    const transaction = database.transaction(SECTIONS_STORE, "readwrite");
    transaction.objectStore(SECTIONS_STORE).add(section);
    await transactionComplete(transaction);
    return normalizeSection(section);
}

export async function getLocalLibraryDocuments(accountId, sectionId) {
    const database = await openDatabase();
    const transaction = database.transaction(DOCUMENTS_STORE, "readonly");
    const documents = await requestToPromise(transaction.objectStore(DOCUMENTS_STORE).index("accountIdSectionId").getAll([String(accountId), String(sectionId)]));
    await transactionComplete(transaction);
    return documents
        .map(normalizeDocument)
        .sort((first, second) => new Date(second.createdAt) - new Date(first.createdAt));
}

export async function addLocalLibraryDocuments(accountId, sectionId, title, description, files) {
    const createdAt = new Date().toISOString();
    const documents = Array.from(files).map(file => ({
        id: `local-document-${crypto.randomUUID()}`,
        accountId: String(accountId),
        sectionId: String(sectionId),
        title: files.length === 1 ? String(title).trim() : `${String(title).trim()} — ${file.name}`,
        description: String(description || "").trim(),
        originalFilename: file.name || "notice",
        mimeType: file.type || "application/octet-stream",
        fileSize: file.size,
        file,
        createdAt
    }));
    const database = await openDatabase();
    const transaction = database.transaction(DOCUMENTS_STORE, "readwrite");
    const store = transaction.objectStore(DOCUMENTS_STORE);
    documents.forEach(document => store.add(document));
    await transactionComplete(transaction);
    return documents.map(normalizeDocument);
}

export function openLocalLibraryDocument(document) {
    const url = URL.createObjectURL(document.file);
    const popup = window.open(url, "_blank", "noopener,noreferrer");
    if (!popup) {
        URL.revokeObjectURL(url);
        throw new Error("Autorisez les fenêtres pop-up pour ouvrir le document.");
    }
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
            const database = request.result;
            const sections = database.createObjectStore(SECTIONS_STORE, { keyPath: "id" });
            sections.createIndex("accountId", "accountId", { unique: false });
            const documents = database.createObjectStore(DOCUMENTS_STORE, { keyPath: "id" });
            documents.createIndex("accountId", "accountId", { unique: false });
            documents.createIndex("accountIdSectionId", ["accountId", "sectionId"], { unique: false });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Stockage local indisponible."));
    });
}

function requestToPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Lecture du stockage local impossible."));
    });
}

function transactionComplete(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error("Écriture du stockage local impossible."));
        transaction.onabort = () => reject(transaction.error || new Error("Écriture du stockage local annulée."));
    });
}

function normalizeSection(section) {
    return { ...section, isLocal: true, documentCount: Number(section.documentCount) || 0 };
}

function normalizeDocument(document) {
    return { ...document, isLocal: true, canDelete: false, createdBy: "Cet appareil" };
}
