import crypto from "node:crypto";

export const SANDBOX_PARTNER = Object.freeze({
    name: "Dépann'Home Test Services",
    keyPrefix: "depannhome-test-services",
    email: "api@depannhome-test.invalid",
    phone: "+33 1 00 00 00 00",
    address: "1 avenue du Bac à sable, 75000 Paris",
    label: "🧪 MODE SANDBOX"
});

export const SANDBOX_FAULTS = new Set(["none", "400", "401", "403", "404", "500", "timeout", "unavailable", "invalid_json", "duplicate", "missing_mission"]);
export const SANDBOX_STATUSES = new Map([
    ["accepted", "accepted"],
    ["in_progress", "report_in_progress"],
    ["completed", "work_completed"],
    ["rejected", "rejected"]
]);

export function sandboxMissionPayload(sequence = Date.now()) {
    const suffix = String(sequence).replace(/\D/g, "").slice(-12) || String(Date.now());
    return {
        missionNumber: `DHTS-${suffix}`,
        partnerReference: `TEST-${suffix}`,
        priority: "normal",
        interventionType: "Recherche de fuite Sandbox",
        description: "Mission fictive transmise par l’API externe de test.",
        client: {
            name: "Camille Test",
            phone: "+33 6 00 00 00 00",
            email: "camille.test@example.invalid",
            address: "25 rue de la Recette",
            city: "Paris"
        }
    };
}

export function redactSandboxValue(value, key = "") {
    const sensitiveKey = /api.?key|authorization|secret|token|password/i.test(key);
    if (sensitiveKey) return "[REDACTED]";
    if (Array.isArray(value)) return value.slice(0, 30).map(item => redactSandboxValue(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactSandboxValue(childValue, childKey)]));
    if (typeof value !== "string") return value;
    if (/email/i.test(key)) return maskEmail(value);
    if (/phone|mobile|telephone/i.test(key)) return value.replace(/\d(?=\D*\d{2}\D*$)/g, "•");
    if (/address|location/i.test(key)) return value ? "[ADRESSE TEST MASQUÉE]" : "";
    return value.slice(0, 2000);
}

export function encryptSandboxSecret(value, masterSecret) {
    const key = crypto.createHash("sha256").update(String(masterSecret)).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptSandboxSecret(value, masterSecret) {
    const [ivValue, tagValue, encryptedValue] = String(value || "").split(".");
    if (!ivValue || !tagValue || !encryptedValue) throw new Error("Secret Sandbox illisible.");
    const key = crypto.createHash("sha256").update(String(masterSecret)).digest();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]).toString("utf8");
}

export function sandboxHash(value) {
    return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function sandboxStatus(value) {
    return SANDBOX_STATUSES.get(String(value || "")) || "";
}

function maskEmail(value) {
    const [local, domain] = String(value).split("@");
    if (!domain) return "[E-MAIL TEST MASQUÉ]";
    return `${local.slice(0, 1) || "•"}•••@${domain}`;
}
