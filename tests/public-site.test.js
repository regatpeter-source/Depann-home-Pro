import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const landing = readFileSync(new URL("../public/landing.html", import.meta.url), "utf8");
const privacy = readFileSync(new URL("../public/privacy.html", import.meta.url), "utf8");
const terms = readFileSync(new URL("../public/terms.html", import.meta.url), "utf8");
const legal = readFileSync(new URL("../public/mentions.html", import.meta.url), "utf8");
const businessSoftware = readFileSync(new URL("../public/logiciel-entreprise-depannage.html", import.meta.url), "utf8");
const schedulingSoftware = readFileSync(new URL("../public/logiciel-planning-interventions.html", import.meta.url), "utf8");
const invoicingSoftware = readFileSync(new URL("../public/logiciel-devis-factures-artisans.html", import.meta.url), "utf8");
const siteScript = readFileSync(new URL("../public/site.js", import.meta.url), "utf8");
const sitemap = readFileSync(new URL("../public/sitemap.xml", import.meta.url), "utf8");
const clientApp = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const googleVerification = readFileSync(new URL("../docs/GOOGLE_OAUTH_VERIFICATION.md", import.meta.url), "utf8");

test("la vitrine publique conserve un accès explicite au logiciel et aux pages légales", () => {
    assert.match(appSource, /app\.get\(\["\/confidentialite"[\s\S]*?privacy\.html/);
    assert.match(appSource, /app\.get\(\["\/conditions-utilisation"[\s\S]*?terms\.html/);
    assert.match(appSource, /app\.get\(\["\/mentions-legales"[\s\S]*?mentions\.html/);
    assert.match(appSource, /app\.get\(\["\/connexion", "\/app", "\/index\.html"\]/);
    assert.match(appSource, /request\.user \? "index\.html" : path\.join\("public", "landing\.html"\)/);
    assert.match(appSource, /app\.get\("\/favicon\.ico"/);
    assert.match(appSource, /response\.type\("image\/png"\)\.sendFile/);
    assert.match(landing, /href="\/connexion"/);
    assert.match(landing, /href="\/confidentialite"/);
    assert.match(landing, /href="\/conditions-utilisation"/);
    assert.match(landing, /href="\/mentions-legales"/);
    assert.match(landing, /assets\/logo\.png\.png/);
    assert.match(landing, /https:\/\/depannhomepro\.com\//);
    assert.doesNotMatch(landing, /depann-home-pro\.onrender\.com/);
});

test("les pages publiques utilisent le logo officiel intact", () => {
    [landing, privacy, terms, legal].forEach(page => {
        assert.match(page, /class="brand-logo" src="\/assets\/logo\.png\.png"/);
        assert.match(page, /class="brand-name">Depann'Home <b>Pro<\/b>/);
        assert.doesNotMatch(page, /brand-mark\.svg/);
    });
    assert.doesNotMatch(readFileSync(new URL("../public/site.css", import.meta.url), "utf8"), /footer-logo img[^}]*object-fit:\s*cover/);
});

test("les mentions légales identifient précisément l’éditeur et le responsable de publication", () => {
    [landing, privacy, terms, legal].forEach(page => {
        assert.match(page, /Peter Regat/);
        assert.match(page, /15 allée Marcel Pagnol/);
        assert.match(page, /44410 Herbignac/);
        assert.match(page, /492 647 375/);
        assert.match(page, /support@depannhomepro\.com/);
    });
    assert.match(legal, /Responsable de la publication/);
    assert.match(legal, /Render Services, Inc\./);
    assert.match(sitemap, /https:\/\/depannhomepro\.com\/mentions-legales/);
});

test("la politique de confidentialité décrit explicitement l'usage limité des données Google", () => {
    assert.match(privacy, /https:\/\/www\.googleapis\.com\/auth\/gmail\.readonly/);
    assert.match(privacy, /https:\/\/www\.googleapis\.com\/auth\/gmail\.send/);
    assert.doesNotMatch(privacy, /https:\/\/mail\.google\.com\//);
    assert.match(privacy, /Limited Use/);
    assert.match(privacy, /ne vend pas les données Google/);
    assert.match(privacy, /Connexions tierces du compte Google/);
    assert.match(privacy, /support@depannhomepro\.com/);
    assert.match(privacy, /CNIL/);
    assert.match(privacy, /Demandes commerciales/);
    assert.match(privacy, /demande d’offre/);
});

test("le dossier de vérification Google aligne scopes, vidéo et accès reviewer", () => {
    assert.match(googleVerification, /https:\/\/www\.googleapis\.com\/auth\/gmail\.readonly/);
    assert.match(googleVerification, /https:\/\/www\.googleapis\.com\/auth\/gmail\.send/);
    assert.match(googleVerification, /gmail\.metadata` cannot access message bodies or attachments/);
    assert.match(googleVerification, /gmail\.compose` is not sufficient/);
    assert.match(googleVerification, /language to \*\*English\*\*/);
    assert.match(googleVerification, /Google Workspace source account/);
    assert.match(googleVerification, /Test credentials and reviewer navigation/);
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
    assert.match(landing, /Inclus dans toutes les offres[\s\S]*?connexion directe à SUPER PDP/);
    assert.equal((landing.match(/Connexion directe à SUPER PDP incluse/g) || []).length, 3);
    assert.equal((landing.match(/Espace e-mail de l’entreprise/g) || []).length, 2);
    assert.match(landing, /Postes Admin et Postes Admin Mobile/);
    const basicOffer = landing.slice(landing.indexOf('<p class="pricing-name">Basic</p>'), landing.indexOf('<p class="pricing-name">Basic+</p>'));
    assert.doesNotMatch(basicOffer, /Espace e-mail de l’entreprise/);
});

test("la vitrine propose une demande d’offre transmise au support", () => {
    assert.match(landing, /id="demande-offre"/);
    assert.match(landing, /data-offer-form/);
    assert.match(landing, /name="privacyConsent"/);
    assert.match(appSource, /\/api\/public\/offer-requests/);
    assert.match(appSource, /registerPublicOfferRoutes\(app\)/);
    assert.match(siteScript, /fetch\("\/api\/public\/offer-requests"/);
    assert.match(siteScript, /credentials: "omit"/);
});

test("la vitrine présente une démo gratuite de 15 jours sans paiement ni engagement", () => {
    assert.match(landing, /id="demo-gratuite"/);
    assert.match(landing, /15 jours gratuits/);
    assert.match(landing, /sans carte bancaire/i);
    assert.match(landing, /sans engagement/i);
    assert.match(landing, /sans abonnement automatique/i);
    assert.match(landing, /value="demo-15-days"/);
    assert.match(landing, /href="#demande-offre">Démarrer ma démo/);
});

test("la vitrine cible des recherches métier avec un contenu factuel et indexable", () => {
    assert.match(landing, /<title>Logiciel de gestion pour dépannage \| Depann'Home Pro<\/title>/);
    assert.match(landing, /name="robots" content="index, follow/);
    assert.match(landing, /property="og:locale" content="fr_FR"/);
    assert.match(landing, /logiciel de gestion conçu pour les entreprises de dépannage/i);
    assert.match(landing, /id="questions-frequentes"/);
    assert.match(landing, /planning d’interventions/);
    assert.match(sitemap, /<loc>https:\/\/depannhomepro\.com\/<\/loc><lastmod>2026-09-13<\/lastmod>/);
    assert.match(landing, /application\/ld\+json/);
    assert.match(landing, /"@type":"SoftwareApplication"/);
    assert.doesNotMatch(landing, /aggregateRating|ratingValue|ratingCount/);
});

test("les pages solutions métier sont publiques, canoniques et reliées à la vitrine", () => {
    const pages = [
        ["logiciel-entreprise-depannage", businessSoftware],
        ["logiciel-planning-interventions", schedulingSoftware],
        ["logiciel-devis-factures-artisans", invoicingSoftware]
    ];
    pages.forEach(([slug, page]) => {
        assert.match(appSource, new RegExp(`app\\.get\\("/${slug}"[\\s\\S]*?${slug}\\.html`));
        assert.match(page, /name="robots" content="index, follow/);
        assert.match(page, new RegExp(`<link rel="canonical" href="https://depannhomepro\\.com/${slug}">`));
        assert.match(page, /"@type":"WebPage"/);
        assert.match(page, /"@type":"SoftwareApplication"/);
        assert.match(page, /"@type":"BreadcrumbList"/);
        assert.match(sitemap, new RegExp(`<loc>https://depannhomepro\\.com/${slug}</loc>`));
        assert.match(landing, new RegExp(`href="/${slug}"`));
        assert.doesNotMatch(page, /aggregateRating|ratingValue|ratingCount/);
    });
});

test("chaque page solution répond à une intention de recherche distincte et factuelle", () => {
    assert.match(businessSoftware, /<title>Logiciel pour entreprise de dépannage/);
    assert.match(businessSoftware, /Clients et historique[\s\S]*Planning et affectations[\s\S]*Suivi depuis le terrain/);
    assert.match(schedulingSoftware, /<title>Logiciel de planning d'interventions/);
    assert.match(schedulingSoftware, /vues mois, semaine et jour[\s\S]*conflits et indisponibilités/i);
    assert.match(invoicingSoftware, /<title>Logiciel devis et factures pour artisans/);
    assert.match(invoicingSoftware, /devis, factures et avoirs[\s\S]*SUPER PDP/i);
});

test("les données structurées des pages commerciales sont des JSON-LD valides", () => {
    [landing, businessSoftware, schedulingSoftware, invoicingSoftware].forEach(page => {
        const match = page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
        assert.ok(match, "un bloc JSON-LD doit être présent");
        assert.doesNotThrow(() => JSON.parse(match[1]));
    });
});

test("la déconnexion et le lancement PWA ouvrent l’authentification plutôt que la vitrine", () => {
    assert.match(clientApp, /redirectToAuthentication\("logged-out"\)/);
    assert.match(clientApp, /window\.location\.replace\(`\/connexion\$\{query\}`\)/);
    assert.doesNotMatch(clientApp, /window\.location\.replace\("\/"\)/);
    assert.equal(manifest.start_url, "/connexion");
    assert.equal(new URL(manifest.start_url, "https://depannhomepro.com").href, "https://depannhomepro.com/connexion");
});