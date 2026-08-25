import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const landing = readFileSync(new URL("../public/landing.html", import.meta.url), "utf8");
const privacy = readFileSync(new URL("../public/privacy.html", import.meta.url), "utf8");
const terms = readFileSync(new URL("../public/terms.html", import.meta.url), "utf8");

test("la vitrine publique conserve un accès explicite au logiciel et aux pages légales", () => {
    assert.match(appSource, /app\.get\(\["\/confidentialite"[\s\S]*?privacy\.html/);
    assert.match(appSource, /app\.get\(\["\/conditions-utilisation"[\s\S]*?terms\.html/);
    assert.match(appSource, /app\.get\(\["\/connexion", "\/app", "\/index\.html"\]/);
    assert.match(appSource, /request\.user \? "index\.html" : path\.join\("public", "landing\.html"\)/);
    assert.match(landing, /href="\/connexion"/);
    assert.match(landing, /href="\/confidentialite"/);
    assert.match(landing, /href="\/conditions-utilisation"/);
    assert.match(landing, /assets\/logo\.png\.png/);
    assert.match(landing, /https:\/\/depannhomepro\.com\//);
    assert.doesNotMatch(landing, /depann-home-pro\.onrender\.com/);
});

test("la politique de confidentialité décrit explicitement l'usage limité des données Google", () => {
    assert.match(privacy, /https:\/\/mail\.google\.com\//);
    assert.match(privacy, /Limited Use/);
    assert.match(privacy, /ne vend pas les données Google/);
    assert.match(privacy, /Connexions tierces du compte Google/);
    assert.match(privacy, /support@depannhomepro\.com/);
    assert.match(privacy, /CNIL/);
});

test("les conditions encadrent les comptes, les services connectés et les données métier", () => {
    assert.match(terms, /Comptes, identifiants et sécurité/);
    assert.match(terms, /Connexions Google, Microsoft et autres messageries/);
    assert.match(terms, /Données, contenus et documents professionnels/);
    assert.match(terms, /droit français/);
    assert.match(terms, /href="\/confidentialite"/);
});

test("la vitrine présente la grille tarifaire commerciale complète", () => {
    assert.match(landing, /id="tarifs"/);
    assert.match(landing, /Basic[\s\S]*?20 €[\s\S]*?5 €/);
    assert.match(landing, /Basic\+[\s\S]*?35 €[\s\S]*?8 €/);
    assert.match(landing, /Pro[\s\S]*?70 €[\s\S]*?15 €/);
    assert.match(landing, /Licence Portail Partenaire[\s\S]*?gratuitement/);
    assert.match(landing, /25 € TTC \/ mois[\s\S]*?94 € TTC \/ mois[\s\S]*?200 € TTC \/ mois/);
});