const encodedPayload = document.body?.dataset.oauthPayload || "";

if (encodedPayload && window.opener) {
    try {
        const normalized = encodedPayload.replace(/-/g, "+").replace(/_/g, "/");
        const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
        const bytes = Uint8Array.from(atob(padded), character => character.charCodeAt(0));
        const payload = JSON.parse(new TextDecoder().decode(bytes));
        window.opener.postMessage(payload, window.location.origin);
    } catch {
        // La page reste lisible si sa charge utile est invalide ; aucune donnée n'est transmise.
    }
}

window.close();
