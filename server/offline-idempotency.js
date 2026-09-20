import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";

const OPERATION_ID_PATTERN = /^[0-9a-f-]{36}$/i;

export function offlineIdempotent(handler) {
    return (request, response, next) => {
        const operationId = String(request.get("X-DepannHome-Offline-Operation") || "");
        if (!OPERATION_ID_PATTERN.test(operationId) || !request.user?.sub) return Promise.resolve(handler(request, response, next)).catch(next);
        return executeOnce(request, response, next, handler, operationId).catch(next);
    };
}

async function executeOnce(request, response, next, handler, operationId) {
    const database = getPool();
    const ownerId = getAccountOwnerId(request);
    const userId = request.user.sub;
    const claim = await database.query(`
        INSERT INTO depannhome_offline_operations (owner_id,user_id,operation_id,method,path)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (owner_id,user_id,operation_id) DO NOTHING
        RETURNING operation_id
    `, [ownerId, userId, operationId, request.method, request.originalUrl || request.path]);
    if (!claim.rowCount) {
        const { rows } = await database.query(`
            SELECT response_status AS "responseStatus", response_type AS "responseType", response_body AS "responseBody", completed_at AS "completedAt"
            FROM depannhome_offline_operations
            WHERE owner_id=$1 AND user_id=$2 AND operation_id=$3
        `, [ownerId, userId, operationId]);
        const saved = rows[0];
        if (!saved?.completedAt) return response.status(425).json({ message: "Cette opération est déjà en cours de synchronisation." });
        response.set("X-DepannHome-Offline-Replayed", "true");
        if (saved.responseType) response.type(saved.responseType);
        return response.status(saved.responseStatus || 204).send(saved.responseBody || undefined);
    }

    let finalized = false;
    const originalSend = response.send.bind(response);
    const originalEnd = response.end.bind(response);
    const finalize = async body => {
        if (finalized) return;
        finalized = true;
        const serialized = body == null ? "" : Buffer.isBuffer(body) ? body.toString("base64") : typeof body === "string" ? body : JSON.stringify(body);
        await database.query(`
            UPDATE depannhome_offline_operations
            SET response_status=$4,response_type=$5,response_body=$6,completed_at=NOW()
            WHERE owner_id=$1 AND user_id=$2 AND operation_id=$3
        `, [ownerId, userId, operationId, response.statusCode || 204, String(response.get("Content-Type") || ""), serialized]);
    };
    response.send = body => {
        if (finalized) return originalSend(body);
        void finalize(body).then(() => originalSend(body)).catch(next);
        return response;
    };
    response.end = (...arguments_) => {
        if (finalized) return originalEnd(...arguments_);
        void finalize(arguments_[0]).then(() => originalEnd(...arguments_)).catch(next);
        return response;
    };

    try {
        await handler(request, response, next);
    } catch (error) {
        if (!finalized) await database.query("DELETE FROM depannhome_offline_operations WHERE owner_id=$1 AND user_id=$2 AND operation_id=$3 AND completed_at IS NULL", [ownerId, userId, operationId]);
        throw error;
    }
}
