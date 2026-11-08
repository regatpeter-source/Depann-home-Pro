(function () {
    function replaceValue(value, replacements) {
        if (typeof value === "string") return replacements.get(value) || value;
        if (Array.isArray(value)) return value.map(item => replaceValue(item, replacements));
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceValue(item, replacements)]));
        return value;
    }

    function remapUrl(url, mappings) {
        let result = url;
        for (const { localId, remoteId } of mappings) {
            result = result.replaceAll(encodeURIComponent(localId), encodeURIComponent(remoteId)).replaceAll(localId, remoteId);
        }
        return result;
    }

    function remapBody(body, mappings) {
        if (!body || !mappings.length) return body;
        const replacements = new Map(mappings.map(({ localId, remoteId }) => [localId, remoteId]));
        if (body.type === "text") {
            try {
                return { ...body, value: JSON.stringify(replaceValue(JSON.parse(body.value), replacements)) };
            } catch (error) {
                if (error instanceof SyntaxError) return body;
                throw error;
            }
        }
        if (body.type === "form-data") {
            return { ...body, entries: body.entries.map(entry => entry.kind === "text" ? { ...entry, value: replaceValue(entry.value, replacements) } : entry) };
        }
        return body;
    }

    function responseMappings(operation, data) {
        const metadata = operation.metadata || {};
        const mappings = [];
        if (metadata.localEventIds?.length) {
            const ids = Array.isArray(data?.ids) ? data.ids.map(id => String(id || "")) : [];
            if (ids.length !== metadata.localEventIds.length || ids.some(id => !/^[1-9]\d*$/.test(id)) || new Set(ids).size !== ids.length) {
                throw new Error("Réponse de synchronisation incomplète : identifiants des interventions manquants.");
            }
            metadata.localEventIds.forEach((localId, index) => mappings.push([localId, ids[index]]));
        } else if (metadata.localEventId || metadata.localReportId) {
            const id = String(data?.id || "");
            if (!/^[1-9]\d*$/.test(id)) throw new Error("Réponse de synchronisation incomplète : identifiant distant manquant.");
            if (metadata.localEventId) mappings.push([metadata.localEventId, id]);
            if (metadata.localReportId) mappings.push([metadata.localReportId, id]);
        }
        const mediaIds = metadata.localMediaIds || [];
        if (mediaIds.length) {
            const media = Array.isArray(data?.media) ? data.media : [];
            const remoteIds = mediaIds.map((_, index) => String(media[index]?.id || ""));
            if (remoteIds.some(id => !id) || new Set(remoteIds).size !== mediaIds.length) {
                throw new Error("Réponse de synchronisation incomplète : identifiant de photo manquant.");
            }
            mediaIds.forEach((localId, index) => mappings.push([localId, remoteIds[index]]));
        }
        return mappings;
    }

    function hasExpectedMappings(operation) {
        return Boolean(operation.metadata?.localEventId || operation.metadata?.localEventIds?.length || operation.metadata?.localReportId || operation.metadata?.localMediaIds?.length);
    }

    function recordAttempt(database, operationId, message, blocked) {
        return new Promise((resolve, reject) => {
            const transaction = database.transaction("operations", "readwrite");
            const store = transaction.objectStore("operations");
            const request = store.get(operationId);
            request.onsuccess = () => {
                const current = request.result;
                if (current) store.put({ ...current, attempts: Number(current.attempts || 0) + 1, lastAttemptAt: Date.now(), lastError: message, blocked });
            };
            transaction.oncomplete = () => resolve();
            transaction.onabort = transaction.onerror = () => reject(transaction.error || request.error || new Error("Mise à jour de la file hors ligne impossible."));
        });
    }

    function unblock(database, operationId) {
        return new Promise((resolve, reject) => {
            const transaction = database.transaction("operations", "readwrite");
            const store = transaction.objectStore("operations");
            const request = store.get(operationId);
            request.onsuccess = () => {
                if (request.result?.blocked) store.put({ ...request.result, blocked: false, retryAfterConflict: true });
            };
            transaction.oncomplete = () => resolve();
            transaction.onabort = transaction.onerror = () => reject(transaction.error || request.error || new Error("Réactivation de la file hors ligne impossible."));
        });
    }

    globalThis.DepannHomeOfflineReplay = Object.freeze({ remapUrl, remapBody, responseMappings, hasExpectedMappings, recordAttempt, unblock });
})();
