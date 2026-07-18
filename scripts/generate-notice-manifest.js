const fs = require("fs");
const path = require("path");

const noticesDir = path.join(__dirname, "..", "assets", "notices");
const manifestPath = path.join(noticesDir, "manifest.json");

function normalize(value) {
    return String(value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/([a-z])([0-9])/gi, "$1 $2")
        .replace(/([0-9])([a-z])/gi, "$1 $2")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function cleanName(name) {
    let cleaned = name.replace(/\.[^/.]+$/, "");
    cleaned = cleaned.replace(/_/g, " ");
    cleaned = cleaned.replace(/-+/g, " ");
    cleaned = cleaned.replace(/^\d+[a-z]?/i, "");
    cleaned = cleaned.replace(/^[0-9]+/g, "");
    cleaned = cleaned.replace(/\b(fr|web|pdf|notice|notices|utilisation|installation|moteur|coulissant|portail|utilisati)\b/g, "");
    cleaned = cleaned.replace(/\s+/g, " ").trim();
    return cleaned;
}

const supportedFilePattern = /\.(pdf|txt|html?|json|png|jpe?g|webp|svg)$/i;

function scanDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.flatMap(entry => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return scanDir(fullPath);
        }

        if (!entry.isFile()) return [];
        if (entry.name.toLowerCase() === "manifest.json") return [];
        if (!supportedFilePattern.test(entry.name)) return [];

        const relativePath = path.relative(noticesDir, fullPath).replace(/\\/g, "/");
        return [{ path: `assets/notices/${relativePath}`, name: entry.name }];
    });
}

function buildManifest(items) {
    return items.map(item => {
        const name = cleanName(item.name);
        return {
            path: item.path,
            reference: normalize(name),
            product: normalize(name)
        };
    });
}

function main() {
    if (!fs.existsSync(noticesDir)) {
        console.error(`Le dossier de notices n'existe pas : ${noticesDir}`);
        process.exit(1);
    }

    const items = scanDir(noticesDir);

    const manifest = buildManifest(items);

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
    console.log(`Manifest généré avec ${manifest.length} entrées dans ${manifestPath}`);
}

main();
