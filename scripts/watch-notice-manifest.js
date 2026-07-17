const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const noticesDir = path.join(__dirname, "..", "assets", "notices");
const manifestPath = path.join(noticesDir, "manifest.json");
const generatorScript = path.join(__dirname, "generate-notice-manifest.js");

function runGenerator() {
    console.log("Génération du manifeste de notices...");
    const generator = spawn(process.execPath, [generatorScript], { stdio: "inherit" });
    generator.on("close", code => {
        if (code !== 0) {
            console.error(`Le générateur s'est terminé avec le code ${code}`);
        } else {
            console.log("Manifest généré avec succès.");
        }
    });
}

function watchDirectory(dir) {
    if (!fs.existsSync(dir)) {
        console.error(`Le dossier n'existe pas : ${dir}`);
        process.exit(1);
    }

    fs.watch(dir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const fullPath = path.join(dir, filename);
        if (path.basename(fullPath) === path.basename(manifestPath)) return;

        console.log(`Changement détecté : ${eventType} ${filename}`);
        runGenerator();
    });

    console.log(`Surveillance active sur : ${dir}`);
}

runGenerator();
watchDirectory(noticesDir);
