import multer from "multer";
import path from "node:path";
import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_FILES_PER_UPLOAD = 5;
const ALLOWED_EXTENSIONS = new Set([
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".txt", ".csv", ".jpg", ".jpeg", ".png", ".webp"
]);
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES_PER_UPLOAD },
    fileFilter: (request, file, callback) => {
        const extension = path.extname(file.originalname || "").toLowerCase();
        callback(null, ALLOWED_EXTENSIONS.has(extension));
    }
});

export async function initializeLibrary() {
    const database = getPool();

    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_library_sections (
            id BIGSERIAL PRIMARY KEY,
            name VARCHAR(80) NOT NULL,
            slug VARCHAR(100) NOT NULL,
            owner_id BIGINT REFERENCES depannhome_users(id) ON DELETE CASCADE,
            created_by BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE RESTRICT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await database.query(`
        ALTER TABLE depannhome_library_sections
        DROP CONSTRAINT IF EXISTS depannhome_library_sections_slug_key,
        DROP CONSTRAINT IF EXISTS depannhome_library_sections_owner_slug_unique
    `);
    await database.query("ALTER TABLE depannhome_library_sections ADD COLUMN IF NOT EXISTS owner_id BIGINT REFERENCES depannhome_users(id) ON DELETE CASCADE");
    await database.query("UPDATE depannhome_library_sections SET owner_id = created_by WHERE owner_id IS NULL");
    await database.query("ALTER TABLE depannhome_library_sections ALTER COLUMN owner_id SET NOT NULL");
    await database.query(`
        ALTER TABLE depannhome_library_sections
        ADD CONSTRAINT depannhome_library_sections_owner_slug_unique UNIQUE (owner_id, slug)
    `);

    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_library_documents (
            id BIGSERIAL PRIMARY KEY,
            section_id BIGINT NOT NULL REFERENCES depannhome_library_sections(id) ON DELETE CASCADE,
            title VARCHAR(160) NOT NULL,
            description VARCHAR(1000) NOT NULL DEFAULT '',
            original_filename VARCHAR(255) NOT NULL,
            mime_type VARCHAR(150) NOT NULL,
            file_size INTEGER NOT NULL CHECK (file_size > 0 AND file_size <= ${MAX_FILE_SIZE}),
            file_data BYTEA NOT NULL,
            owner_id BIGINT REFERENCES depannhome_users(id) ON DELETE CASCADE,
            created_by BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE RESTRICT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query("ALTER TABLE depannhome_library_documents ADD COLUMN IF NOT EXISTS owner_id BIGINT REFERENCES depannhome_users(id) ON DELETE CASCADE");
    await database.query(`
        UPDATE depannhome_library_documents document
        SET owner_id = section.owner_id
        FROM depannhome_library_sections section
        WHERE document.section_id = section.id AND document.owner_id IS NULL
    `);
    await database.query("ALTER TABLE depannhome_library_documents ALTER COLUMN owner_id SET NOT NULL");

    await database.query(`
        CREATE INDEX IF NOT EXISTS depannhome_library_documents_section_idx
        ON depannhome_library_documents (section_id, created_at DESC)
    `);
}

export function registerLibraryRoutes(app, requireAuthentication) {
    app.use("/api/library", requireAuthentication, requireLibraryReadAccess);
    app.get("/api/library", requireAuthentication, asyncHandler(async (request, response) => {
        const { rows } = await getPool().query(`
            SELECT
                section.id,
                section.name,
                section.slug,
                section.created_at AS "createdAt",
                COUNT(document.id)::int AS "documentCount"
            FROM depannhome_library_sections section
            LEFT JOIN depannhome_library_documents document
                ON document.section_id = section.id AND document.owner_id = $1
            WHERE section.owner_id = $1
            GROUP BY section.id
            ORDER BY LOWER(section.name)
        `, [getAccountOwnerId(request)]);
        response.json({ sections: rows });
    }));

    app.post("/api/library/sections", requireAuthentication, requireLibraryWriteAccess, asyncHandler(async (request, response) => {
        const name = normalizeSectionName(request.body?.name);
        if (!name) return response.status(400).json({ message: "Le nom de la section doit contenir entre 2 et 80 caractères." });

        const slug = slugify(name);
        try {
            const { rows } = await getPool().query(`
                INSERT INTO depannhome_library_sections (name, slug, owner_id, created_by)
                VALUES ($1, $2, $3, $4)
                RETURNING id, name, slug, created_at AS "createdAt"
            `, [name, slug, getAccountOwnerId(request), request.user.sub]);
            return response.status(201).json({ section: rows[0] });
        } catch (error) {
            if (error.code === "23505") {
                return response.status(409).json({ message: "Une section avec ce nom existe déjà dans votre bibliothèque." });
            }
            throw error;
        }
    }));

    app.get("/api/library/search", requireAuthentication, asyncHandler(async (request, response) => {
        const query = cleanText(request.query?.q, 160);
        if (getSearchTokens(query).length < 1) {
            return response.json({ sections: [], documents: [] });
        }

        const database = getPool();
        const [sectionsResult, documentsResult] = await Promise.all([
            database.query(`
                SELECT id, name
                FROM depannhome_library_sections
                WHERE owner_id = $1
                ORDER BY LOWER(name)
            `, [getAccountOwnerId(request)]),
            database.query(`
                SELECT
                    document.id,
                    document.title,
                    document.description,
                    document.original_filename AS "originalFilename",
                    document.file_size AS "fileSize",
                    section.id AS "sectionId",
                    section.name AS "sectionName"
                FROM depannhome_library_documents document
                JOIN depannhome_library_sections section ON section.id = document.section_id
                WHERE document.owner_id = $1 AND section.owner_id = $1
                ORDER BY document.created_at DESC
                LIMIT 500
            `, [getAccountOwnerId(request)])
        ]);

        const sections = sectionsResult.rows.filter(section => matchesSearch(`${section.name} dossier section`, query));
        const documents = documentsResult.rows.filter(document => matchesSearch(
            `${document.sectionName} ${document.title} ${document.description} ${document.originalFilename}`,
            query
        ));
        response.json({ sections, documents });
    }));

    app.get("/api/library/sections/:sectionId/documents", requireAuthentication, asyncHandler(async (request, response) => {
        const sectionId = positiveId(request.params.sectionId);
        if (!sectionId) return response.status(400).json({ message: "Section invalide." });

        const { rows } = await getPool().query(`
            SELECT
                document.id,
                document.title,
                document.description,
                document.original_filename AS "originalFilename",
                document.mime_type AS "mimeType",
                document.file_size AS "fileSize",
                document.created_at AS "createdAt",
                section.name AS "sectionName",
                TRUE AS "canDelete"
            FROM depannhome_library_documents document
            JOIN depannhome_library_sections section ON section.id = document.section_id
            WHERE document.section_id = $1
              AND section.owner_id = $2
              AND document.owner_id = $2
            ORDER BY document.created_at DESC
        `, [sectionId, getAccountOwnerId(request)]);
        response.json({ documents: rows });
    }));

    app.post("/api/library/documents", requireAuthentication, requireLibraryWriteAccess, upload.array("files", MAX_FILES_PER_UPLOAD), asyncHandler(async (request, response) => {
        const sectionId = positiveId(request.body?.sectionId);
        const files = Array.isArray(request.files) ? request.files : [];
        const title = cleanText(request.body?.title, 160);
        const description = cleanText(request.body?.description, 1000);

        if (!sectionId) return response.status(400).json({ message: "Choisissez une section." });
        if (!files.length) return response.status(400).json({ message: "Ajoutez au moins un fichier accepté." });
        if (!title) return response.status(400).json({ message: "Indiquez un titre pour les documents." });

        const database = getPool();
        const section = await database.query(
            "SELECT id FROM depannhome_library_sections WHERE id = $1 AND owner_id = $2",
            [sectionId, getAccountOwnerId(request)]
        );
        if (!section.rowCount) return response.status(404).json({ message: "Section introuvable." });

        const client = await database.connect();
        try {
            await client.query("BEGIN");
            for (const file of files) {
                await client.query(`
                    INSERT INTO depannhome_library_documents
                        (section_id, title, description, original_filename, mime_type, file_size, file_data, owner_id, created_by)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                `, [
                    sectionId,
                    files.length === 1 ? title : `${title} — ${safeFilename(file.originalname)}`,
                    description,
                    safeFilename(file.originalname),
                    safeMimeType(file.mimetype),
                    file.size,
                    file.buffer,
                    getAccountOwnerId(request),
                    request.user.sub
                ]);
            }
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }

        response.status(201).json({ message: `${files.length} fichier(s) ajouté(s).` });
    }));

    app.get("/api/library/documents/:documentId/download", requireAuthentication, asyncHandler(async (request, response) => {
        const documentId = positiveId(request.params.documentId);
        if (!documentId) return response.status(400).json({ message: "Document invalide." });

        const { rows } = await getPool().query(`
                        SELECT document.original_filename, document.mime_type, document.file_data
                        FROM depannhome_library_documents document
                        JOIN depannhome_library_sections section ON section.id = document.section_id
                        WHERE document.id = $1
                            AND document.owner_id = $2
                            AND section.owner_id = $2
                `, [documentId, getAccountOwnerId(request)]);
        if (!rows[0]) return response.status(404).json({ message: "Document introuvable." });

        const document = rows[0];
        response.set({
            "Content-Type": safeMimeType(document.mime_type),
            "Content-Length": document.file_data.length,
            "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(document.original_filename)}`,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff"
        });
        response.send(document.file_data);
    }));

    app.delete("/api/library/documents/:documentId", requireAuthentication, requireLibraryWriteAccess, asyncHandler(async (request, response) => {
        const documentId = positiveId(request.params.documentId);
        if (!documentId) return response.status(400).json({ message: "Document invalide." });

        const { rowCount } = await getPool().query(`
            DELETE FROM depannhome_library_documents
            WHERE id = $1
              AND owner_id = $2
              AND section_id IN (
                  SELECT id FROM depannhome_library_sections WHERE owner_id = $2
              )
        `, [documentId, getAccountOwnerId(request)]);
        if (!rowCount) return response.status(404).json({ message: "Document introuvable." });
        response.status(204).end();
    }));
}

function requireLibraryWriteAccess(request, response, next) {
    if (request.user?.role === "technician") {
        return response.status(403).json({ message: "La bibliothèque est disponible en consultation pour les techniciens." });
    }
    return next();
}

function requireLibraryReadAccess(request, response, next) {
    if (request.user?.role === "accountant") return response.status(403).json({ message: "L’espace comptabilité ne donne pas accès à la bibliothèque technique." });
    return next();
}

export function libraryUploadErrorHandler(error, request, response, next) {
    if (error instanceof multer.MulterError) {
        const message = error.code === "LIMIT_FILE_SIZE"
            ? "Chaque fichier est limité à 20 Mo."
            : "Envoi impossible : vérifiez le nombre et la taille des fichiers.";
        return response.status(400).json({ message });
    }
    return next(error);
}

function normalizeSectionName(value) {
    const name = cleanText(value, 80);
    return name.length >= 2 ? name : "";
}

function cleanText(value, maximumLength) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximumLength);
}

function slugify(value) {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "")
        .slice(0, 100);
}

function matchesSearch(value, query) {
    const queryTokens = getSearchTokens(query);
    const valueTokens = getSearchTokens(value);
    return queryTokens.every(queryToken => valueTokens.some(valueToken => {
        const valueStem = getStem(valueToken);
        const queryStem = getStem(queryToken);
        return valueToken.includes(queryToken)
            || queryToken.includes(valueToken)
            || (valueStem.length >= 4 && queryStem.length >= 4 && (
                valueStem.startsWith(queryStem) || queryStem.startsWith(valueStem)
            ));
    }));
}

function getSearchTokens(value) {
    return String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .split(/\s+/)
        .filter(token => token.length > 1 && !new Set(["au", "aux", "ce", "ces", "de", "des", "du", "en", "et", "la", "le", "les", "pour", "sur", "un", "une"]).has(token));
}

function getStem(token) {
    return token
        .replace(/(ations?|ements?|ions?|er|ez|es|s)$/i, "")
        .replace(/(.)\1+$/i, "$1");
}

function positiveId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function safeFilename(value) {
    return path.basename(String(value || "document")).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_").slice(0, 255) || "document";
}

function safeMimeType(value) {
    const type = String(value || "application/octet-stream").toLowerCase();
    return /^[a-z]+\/[a-z0-9.+-]+$/.test(type) ? type : "application/octet-stream";
}

function asyncHandler(handler) {
    return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}
