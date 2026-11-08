import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const styles = readFileSync(new URL("../css/style.css", import.meta.url), "utf8");
const dialogue = readFileSync(new URL("../css/partner-dialogue.css", import.meta.url), "utf8");
const editor = readFileSync(new URL("../css/report-editor.css", import.meta.url), "utf8");
const health = readFileSync(new URL("../css/health-dashboard.css", import.meta.url), "utf8");

test("les derniers fonds sombres couvrent les écrans PC et mobiles après les règles claires", () => {
    const index = styles.indexOf("/* Surfaces contrôlées sur PC et mobile");
    assert.ok(index > styles.indexOf(".mobile-revenue-card{"));
    const layer = styles.slice(index);
    assert.match(layer, /body:is\(\.desktop-device,\.mobile-device\)\.dark-theme/);
    for (const selector of [".dashboard-company-switcher", ".mobile-workspace-folder", ".library-mobile-tool", ".calendar-mobile-day-heading", ".calendar-day.today", ".report-proofreading-editor", ".report-auto-summary", ".data-import-preview-table", ".partner-mission-dialog>section", ".group-company-modal>section"]) {
        assert.ok(layer.includes(selector), selector);
    }
    assert.match(layer, /background:var\(--surface-alt\)/);
    assert.match(layer, /\.mobile-workspace-folder button:active/);
    assert.match(layer, /\.calendar-event\.color-blue\{background:#172c46;color:#bfdbfe/);
    assert.match(layer, /\.calendar-event\.status-paused\{background:#432c1c!important/);
    assert.match(layer, /\.report-tabs \.secondary-button\.active/);
    assert.match(dialogue, /\.partner-composer-files:focus-within/);
    assert.match(editor, /dark-theme\.report-writing-active \.report-observation-card\{background:transparent/);
    assert.match(health, /body\.dark-theme :is\(\.health-details div,\.health-incident,\.health-table/);
});

test("les documents imprimables et les zones de signature ne sont pas assombris", () => {
    const layer = styles.slice(styles.indexOf("/* Surfaces contrôlées sur PC et mobile"));
    for (const selector of [".pdf-live-page", ".template-page", ".quitus-signature-canvas", ".report-signatures canvas", ".mobile-installation-qr img"]) assert.equal(layer.includes(selector), false, selector);
    assert.match(styles, /\.pdf-live-page,\.billing-logo-preview,\.partner-directory-logo\)\{\s*background:#fff/);
    assert.match(styles, /\.support-assistance-choice select\{[^}]*min-height:44px[^}]*background:var\(--surface\)/);
});

function luminance(hex) {
    const channels = hex.match(/[a-f\d]{2}/gi).map(channel => parseInt(channel, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}

test("les palettes sombres de statut gardent un contraste de texte d’au moins 4,5:1", () => {
    for (const [foreground, background] of [["#e5edf6", "#1e293b"], ["#bfdbfe", "#172c46"], ["#a7f3d0", "#16382f"], ["#fed7aa", "#432c1c"], ["#fecaca", "#432427"], ["#ddd6fe", "#302744"], ["#ffffff", "#0f7650"]]) {
        const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
        const contrast = (values[0] + .05) / (values[1] + .05);
        assert.ok(contrast >= 4.5, `${foreground} sur ${background}: ${contrast.toFixed(2)}:1`);
    }
});
