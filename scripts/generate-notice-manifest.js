const fs = require("fs");
const path = require("path");

const noticesDir = path.join(__dirname, "..", "assets", "notices");
const manifestPath = path.join(noticesDir, "manifest.json");

function normalize(value) {
    return String(value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function scanDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.flatMap(entry => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return scanDir(fullPath);
        }

        if (!entry.isFile()) return [];
        if (!/\.(pdf|txt|html?|json)$/i.test(entry.name)) return [];

        const relativePath = path.relative(noticesDir, fullPath).replace(/\\/g, "/");
        return [{ path: `assets/notices/${relativePath}`, name: entry.name }];
    });
}

function buildManifest(items) {
    return items.map(item => {
        const name = item.name.replace(/\.[^/.]+$/, "");
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
