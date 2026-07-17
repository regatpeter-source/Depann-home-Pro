import { escapeHtml } from "./utils.js?v=44";

export function getContainer() {
    const container = document.getElementById("brands");
    if (container) container.innerHTML = "";
    return container;
}

export function clearSearch() {
    const search = document.getElementById("search");
    if (search) search.value = "";
}

export function focusSearch() {
    const search = document.getElementById("search");
    if (search) search.focus();
}

export function setPage(title, route, mode = "home") {
    const pageTitle = document.getElementById("pageTitle");
    const breadcrumb = document.getElementById("breadcrumb");

    if (pageTitle) pageTitle.textContent = title;
    if (breadcrumb) breadcrumb.textContent = title;

    document.querySelectorAll(".nav-button").forEach(button => {
        button.classList.toggle("active", button.dataset.nav === route);
    });

    document.body.dataset.pageMode = mode;
}

export function createCard(icon, title, subtitle, onClick, options = {}) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `brand-card${options.full ? " full-card" : ""}`;
    const iconHtml = icon && String(icon).trim() ? `<div class="brand-card-icon">${escapeHtml(icon)}</div>` : "";
    card.innerHTML = `
        ${iconHtml}
        <div class="brand-card-content">
            <h3>${escapeHtml(title)}</h3>
            <p>${escapeHtml(subtitle || "")}</p>
        </div>
    `;

    card.addEventListener("click", onClick);
    return card;
}

export function createButton(label, className, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
}

export function createBackCard(label, onClick) {
    return createButton(label, "brand-card back-card", onClick);
}

export function createInfo(message) {
    const info = document.createElement("article");
    info.className = "brand-card full-card info-card";
    info.innerHTML = `<p>${escapeHtml(message)}</p>`;
    return info;
}

export function appendListSection(parent, title, items, listType = "ul", emptyMessage = "") {
    const section = document.createElement("section");
    section.className = "procedure-section";

    const heading = document.createElement("h3");
    heading.textContent = title;
    section.appendChild(heading);

    if (!Array.isArray(items) || !items.length) {
        if (emptyMessage) {
            const empty = document.createElement("p");
            empty.className = "muted";
            empty.textContent = emptyMessage;
            section.appendChild(empty);
        }

        parent.appendChild(section);
        return;
    }

    const list = document.createElement(listType);
    items.forEach(item => {
        const li = document.createElement("li");
        li.textContent = item;
        list.appendChild(li);
    });

    section.appendChild(list);
    parent.appendChild(section);
}

export function appendSequenceTableSection(parent, title, items, emptyMessage = "") {
    const section = document.createElement("section");
    section.className = "procedure-section";

    const heading = document.createElement("h3");
    heading.textContent = title;
    section.appendChild(heading);

    if (!Array.isArray(items) || !items.length) {
        if (emptyMessage) {
            const empty = document.createElement("p");
            empty.className = "muted";
            empty.textContent = emptyMessage;
            section.appendChild(empty);
        }

        parent.appendChild(section);
        return;
    }

    const table = document.createElement("table");
    table.className = "combination-table";

    const thead = document.createElement("thead");
    thead.innerHTML = `
        <tr>
            <th>Gamme / modèle</th>
            <th>Séquence / action</th>
            <th>Contrôle après</th>
        </tr>
    `;
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    items.forEach(item => {
        const row = normalizeSequenceItem(item);
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>${escapeHtml(row.label)}</td>
            <td>${escapeHtml(row.sequence)}</td>
            <td>${escapeHtml(row.check)}</td>
        `;
        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    section.appendChild(table);
    parent.appendChild(section);
}

function normalizeSequenceItem(item) {
    if (item && typeof item === "object") {
        return {
            label: item.label || item.model || item.brand || "Séquence",
            sequence: item.sequence || item.action || item.text || item.description || "",
            check: item.check || item.validation || item.test || "Faire un cycle complet et confirmer le fonctionnement."
        };
    }

    const text = String(item || "").trim();
    const parts = text.split(/\s*:\s*/);
    const label = parts.length > 1 ? parts.shift() : "Séquence";
    const sequence = parts.join(": ") || text;
    const lower = text.toLowerCase();

    let check = "Faire un cycle complet et confirmer le fonctionnement.";
    if (/télécommande|telecommande|radio|programm/.test(lower)) check = "Tester au moins une fois à proximité puis à distance normale.";
    else if (/sens|rotation/.test(lower)) check = "Contrôler le sens de rotation avant restitution.";
    else if (/butée|butées|course|fins de course/.test(lower)) check = "Refaire un cycle complet et vérifier les fins de course.";
    else if (/reset|réinitial|reinitial/.test(lower)) check = "Reprogrammer et valider sur un seul équipement.";

    return { label, sequence, check };
}

function getManufacturerVisualLinks(brandId, categoryName = "", productName = "", procedureTitle = "") {
    const text = `${categoryName} ${productName} ${procedureTitle}`.toLowerCase();
    const links = [];

    const addLink = (label, url) => {
        if (!url || links.some(item => item.url === url)) return;
        links.push({ label, url });
    };

    if (brandId === "faac") {
        if (text.includes("battant") || text.includes("vérin") || text.includes("verin") || /portail.*battant|battant.*portail/.test(text)) {
            addLink("Visuel portail battant", "https://www.faac.it/automazioni-per-cancelli-a-battente");
            addLink("Vidéos maintenance", "https://www.faac.it/service-and-maintenance");
            addLink("Accessoires compatibles", "https://www.faac.it/accessori-per-automazione");
            return links;
        }

        if (text.includes("portail") || text.includes("coulissant") || text.includes("c720") || text.includes("c721") || text.includes("740") || text.includes("741") || text.includes("746") || text.includes("844")) {
            addLink("Visuel portail coulissant", "https://www.faac.it/automazioni-per-cancelli-scorrevoli");
            addLink("Guide entretien", "https://www.faac.it/service-and-maintenance");
            addLink("Pièces et accessoires", "https://www.faac.it/accessori-per-automazione");
            return links;
        }

        if (text.includes("garage") || text.includes("d600") || text.includes("d700")) {
            addLink("Visuel porte de garage", "https://www.faac.it/automazioni-per-porte-garage");
            addLink("Guide utilisateur", "https://www.faac.it/servizi-per-utente-finale");
            addLink("Support installateur", "https://www.faac.it/servizi-per-installatore");
            return links;
        }

        if (text.includes("volet") || text.includes("store") || text.includes("télécommande") || text.includes("telecommande") || text.includes("clavier") || text.includes("récepteur") || text.includes("recepteur")) {
            addLink("Visuel accessoires", "https://www.faac.it/accessori-per-automazione");
            addLink("Support installateur", "https://www.faac.it/servizi-per-installatore");
            addLink("Maintenance", "https://www.faac.it/service-and-maintenance");
            return links;
        }

        addLink("Centre visuel", "https://www.faac.it/service-and-maintenance");
        return links;
    }

    if (brandId === "came") {
        if (text.includes("battant") || text.includes("bras") || text.includes("vérin") || text.includes("verin") || text.includes("frog") || text.includes("fast") || text.includes("ferni") || text.includes("krono") || text.includes("ati")) {
            addLink("Visuel portail battant", "https://www.came.com/fr/produits/automatisations-de-portails/");
            addLink("Formation installateur", "https://www.came.com/fr/training/");
            addLink("Accessoires sécurité", "https://www.came.com/fr/produits/accessoires-de-controle-et-de-securite/");
            return links;
        }

        if (text.includes("portail") || text.includes("coulissant") || text.includes("bx") || text.includes("bxv") || text.includes("bkv") || text.includes("bk")) {
            addLink("Visuel portail coulissant", "https://www.came.com/fr/produits/automatisations-de-portails/");
            addLink("Formation installateur", "https://www.came.com/fr/training/");
            addLink("Pièces détachées", "https://spareparts.came.com/jsp/Template4/HomePage.jsp");
            return links;
        }

        if (text.includes("télécommande") || text.includes("telecommande") || text.includes("radio") || text.includes("twin") || text.includes("top") || text.includes("tam")) {
            addLink("Visuel contrôle radio", "https://www.came.com/fr/produits/accessoires-de-controle-et-de-securite/");
            addLink("Formation radio", "https://www.came.com/fr/training/");
            addLink("Accueil CAME", "https://www.came.com/fr/");
            return links;
        }

        addLink("Accueil CAME", "https://www.came.com/fr/");
        return links;
    }

    if (brandId === "hormann") {
        if (text.includes("télécommande") || text.includes("telecommande") || text.includes("bisecur") || text.includes("bluesecur")) {
            addLink("Visuel télécommande", "https://www.hormann.fr/faq/?category=147897&title=smart-home");
            addLink("Tutoriel appairage", "https://www.hormann.fr/conseils/detail/programmation-de-votre-telecommande-hoermann-bisecur-instructions-simples-et-detaillees/");
            addLink("Media center", "https://www.hormann.fr/mediacenter/");
            return links;
        }

        addLink("Motorisations", "https://www.hormann.fr/habitat-maitre-doeuvre-marche-residentiel/motorisations/");
        addLink("Media center", "https://www.hormann.fr/mediacenter/");
        return links;
    }

    if (brandId === "servistores") {
        if (text.includes("télécommande") || text.includes("telecommande") || text.includes("commande radio") || text.includes("centralis") || text.includes("récepteur") || text.includes("recepteur")) {
            addLink("Visuel commande radio", "https://www.servistores.com/html/documentation.html?type=VIDEO");
            addLink("Guide radio Servistores", "https://www.servistores.com/html/documentation.html?type=PAGE_AIDE");
            addLink("Référence télis RTS", "https://www.servistores.com/repository/documents/plans/1810630_telisRts_notice.pdf");
            return links;
        }

        if (text.includes("volet battant")) {
            if (text.includes("motoris")) {
                addLink("Visuel volet battant motorisé", "https://www.servistores.com/images-repository-select/images-produits/VOLBAT2MOTALU27MM?preferredWidth=350&preferredAttributs=copyleft");
                addLink("Descriptif volet battant", "https://www.servistores.com/html/categories/volet-battant/descriptif.html");
                return links;
            }
            if (text.includes("aluminium")) {
                addLink("Visuel volet battant alu", "https://www.servistores.com/images-repository-select/images-produits/VOLBAT2ALU27MM?preferredWidth=350&preferredAttributs=copyleft");
                addLink("Descriptif volet battant", "https://www.servistores.com/html/categories/volet-battant/descriptif.html");
                return links;
            }
            addLink("Visuel volet battant PVC", "https://www.servistores.com/images-repository-select/images-produits/VOLBAT2PVC28MM?preferredWidth=350&preferredAttributs=copyleft");
            addLink("Descriptif volet battant", "https://www.servistores.com/html/categories/volet-battant/descriptif.html");
            return links;
        }

        if (text.includes("porte de garage")) {
            addLink("Visuel porte de garage", "https://www.servistores.com/repository/images-categories/motorisation-porte-garage_%230_%23normal_350x350.jpg");
            addLink("Recherche porte de garage", "https://www.servistores.com/html/categories/motorisation-porte-de-garage/recherche.html");
            return links;
        }

        if (text.includes("portail")) {
            addLink("Visuel portail", "https://www.servistores.com/repository/images-categories/motorisation-portail_%234_%23preview_%23opaque_%23accueil_250x250.jpg");
            addLink("Recherche portail", "https://www.servistores.com/html/categories/motorisation-portail/recherche.html");
            return links;
        }

        if (text.includes("moteur volet roulant") || text.includes("motorisation") || text.includes("volet roulant")) {
            addLink("Visuel moteur volet roulant", "https://www.servistores.com/repository/images-categories/moteur-volet-roulant_%230_350x350.jpg");
            addLink("Recherche moteur volet roulant", "https://www.servistores.com/html/categories/moteur-volet-roulant/recherche.html");
            addLink("Notice vidéo", "https://www.servistores.com/html/documentation.html?type=VIDEO");
            return links;
        }

        if (text.includes("pièces") || text.includes("piece")) {
            addLink("Visuel pièces détachées", "https://www.servistores.com/repository/images-categories/piece-detachee-volet-roulant_%231_%23bgwhite_250x250.jpg");
            addLink("Recherche pièces détachées", "https://www.servistores.com/html/categories/pieces-detachees/recherche.html");
            return links;
        }

        addLink("Accueil Servistores", "https://www.servistores.com/");
        addLink("Documentation Servistores", "https://www.servistores.com/html/documentation.html?type=PAGE_AIDE");
        return links;
    }

    if (brandId === "somfy") {
        if (text.includes("volet roulant") || /oximo|altus|ilmo|lt50|lt60|rs100|smoove|situo/i.test(productName)) {
            addLink("Visuel volet roulant", "https://www.somfy.fr/assistance/videos/volet-roulant-somfy");
            addLink("Notice volet roulant", "https://www.somfy.fr/assistance/notices/volet-roulant");
            addLink("Centre vidéos", "https://www.somfy.fr/assistance/videos");
            return links;
        }

        if (text.includes("store") || /sonesse|sunea|j4|store/i.test(productName)) {
            addLink("Visuel store", "https://www.somfy.fr/assistance/videos/store-et-terrasse-somfy");
            addLink("Notice store", "https://www.somfy.fr/assistance/notices/store-de-terrasse");
            addLink("Centre vidéos", "https://www.somfy.fr/assistance/videos");
            return links;
        }

        if (text.includes("porte de garage") || /dexxo|rollixo/i.test(productName)) {
            addLink("Visuel porte de garage", "https://www.somfy.fr/assistance/videos/porte-de-garage-somfy");
            addLink("Notice porte de garage", "https://www.somfy.fr/assistance/notices/garage");
            addLink("Centre vidéos", "https://www.somfy.fr/assistance/videos");
            return links;
        }

        if (text.includes("portail")) {
            addLink("Visuel portail", "https://www.somfy.fr/assistance/videos/portail-somfy");
            addLink("Notice portail", "https://www.somfy.fr/assistance/notices/portail");
            addLink("Centre vidéos", "https://www.somfy.fr/assistance/videos");
            return links;
        }

        addLink("Centre vidéos", "https://www.somfy.fr/assistance/videos");
        addLink("Centre notices", "https://www.somfy.fr/assistance/notices");
        return links;
    }

    if (brandId === "faac") {
        addLink("Vidéos FAAC", "https://www.assistenzatecnicafaac.it/video");
        addLink("Support installateur", "https://www.faac.it/servizi-per-installatore");
        return links;
    }

    if (brandId === "came") {
        addLink("Formation CAME", "https://www.came.com/fr/training/");
        addLink("Accueil CAME", "https://www.came.com/fr/");
        return links;
    }

    if (brandId === "nice") {
        if (text.includes("portail") || text.includes("porte de garage")) {
            addLink("Vidéos portail / garage", "https://support.nice-na.com/hc/en-us/sections/1500000915161-Videos-Webinars");
            addLink("Centre support Nice", "https://support.nice-na.com/hc/en-us/categories/1500000283742-Door");
            return links;
        }

        if (text.includes("volet") || text.includes("store")) {
            addLink("Vidéos installation", "https://support.nice-na.com/hc/en-us/sections/39299148917271-Quick-Start-Videos");
            addLink("Centre support Nice", "https://support.nice-na.com/hc/en-us/categories/1500000283742-Door");
            return links;
        }

        addLink("Centre support Nice", "https://support.nice-na.com/hc/en-us/categories/1500000283742-Door");
        return links;
    }

    if (brandId === "bubendorff") {
        if (text.includes("volet") || text.includes("moteur")) {
            addLink("FAQ volets roulants", "https://www.bubendorff.com/faq-categorie/volets-roulants/");
            addLink("Documentation", "https://doc.bubendorff.com/");
            return links;
        }

        addLink("Documentation", "https://doc.bubendorff.com/");
        return links;
    }

    addLink("Recherche visuelle", `https://www.google.com/search?q=${encodeURIComponent(`${brandId} photos produit`)}`);
    return links;
}

function getManufacturerVisualUrl(brandId, categoryName = "", productName = "", procedureTitle = "") {
    return getManufacturerVisualLinks(brandId, categoryName, productName, procedureTitle)[0]?.url || `https://www.google.com/search?q=${encodeURIComponent(`${brandId} photos produit`)}`;
}

function getManufacturerNoticeUrl(brandId, categoryName = "", productName = "") {
    const text = `${categoryName} ${productName}`.toLowerCase();

    if (brandId === "faac") {
        if (text.includes("battant") || text.includes("vérin") || text.includes("verin")) return "https://www.faac.it/servizi-per-installatore";
        if (text.includes("portail") || text.includes("coulissant") || text.includes("c720") || text.includes("c721") || text.includes("740") || text.includes("741") || text.includes("746") || text.includes("844")) return "https://www.faac.it/service-and-maintenance";
        if (text.includes("garage") || text.includes("d600") || text.includes("d700")) return "https://www.faac.it/servizi-per-utente-finale";
        if (text.includes("volet") || text.includes("store") || text.includes("télécommande") || text.includes("telecommande")) return "https://www.faac.it/accessori-per-automazione";
        return "https://www.faac.it/servizi-per-installatore";
    }

    if (brandId === "came") {
        if (text.includes("télécommande") || text.includes("telecommande") || text.includes("top") || text.includes("tam") || text.includes("twin") || text.includes("radio")) return "https://www.came.com/fr/training/";
        if (text.includes("battant") || text.includes("bras") || text.includes("vérin") || text.includes("verin") || text.includes("coulissant") || text.includes("portail")) return "https://spareparts.came.com/jsp/Template4/HomePage.jsp";
        return "https://www.came.com/fr/produits/automatisations-de-portails/";
    }

    if (brandId === "hormann") {
        if (text.includes("télécommande") || text.includes("telecommande") || text.includes("bisecur") || text.includes("bluesecur")) {
            return "https://www.hormann.fr/faq/?category=147886&title=motorisation";
        }

        return "https://www.hormann.fr/mediacenter/";
    }

    if (brandId === "servistores") {
        if (text.includes("télécommande") || text.includes("telecommande") || text.includes("commande radio") || text.includes("centralis") || text.includes("récepteur") || text.includes("recepteur")) {
            return "https://www.servistores.com/html/documentation.html?type=PAGE_AIDE";
        }

        if (text.includes("volet battant")) return "https://www.servistores.com/html/categories/volet-battant/descriptif.html";
        if (text.includes("porte de garage")) return "https://www.servistores.com/html/categories/motorisation-porte-de-garage/recherche.html";
        if (text.includes("portail")) return "https://www.servistores.com/html/categories/motorisation-portail/recherche.html";
        if (text.includes("pièces") || text.includes("piece")) return "https://www.servistores.com/html/categories/pieces-detachees/recherche.html";
        if (text.includes("moteur volet roulant") || text.includes("volet roulant") || text.includes("motorisation")) return "https://www.servistores.com/html/categories/moteur-volet-roulant/recherche.html";

        return "https://www.servistores.com/";
    }

    if (brandId === "somfy") {
        if (text.includes("volet roulant") || /oximo|altus|ilmo|lt50|lt60|rs100|smoove|situo/i.test(productName)) {
            return "https://www.somfy.fr/assistance/notices/volet-roulant";
        }

        if (text.includes("store") || /sonesse|sunea|j4|store/i.test(productName)) {
            return "https://www.somfy.fr/assistance/notices/store-de-terrasse";
        }

        if (text.includes("porte de garage") || /dexxo|rollixo/i.test(productName)) {
            return "https://www.somfy.fr/assistance/notices/garage";
        }

        if (text.includes("portail")) {
            return "https://www.somfy.fr/assistance/notices/portail";
        }

        return "https://www.somfy.fr/assistance/notices";
    }

    if (brandId === "faac") return "https://www.assistenzatecnicafaac.it/faq";
    if (brandId === "came") return "https://spareparts.came.com/jsp/Template4/HomePage.jsp";
    if (brandId === "nice") return "https://support.niceforyou.com/hc/fr";
    if (brandId === "bubendorff") return "https://www.bubendorff.com/faq-categorie/volets-roulants/";

    return `https://www.google.com/search?q=${encodeURIComponent(`${brandId} notice moteur`)}`;
}

function getManufacturerGuideUrl(brandId, categoryName = "", productName = "") {
    const text = `${categoryName} ${productName}`.toLowerCase();

    if (brandId === "faac") {
        if (text.includes("battant") || text.includes("vérin") || text.includes("verin")) return "https://www.faac.it/servizi-per-installatore";
        if (text.includes("portail") || text.includes("coulissant") || text.includes("c720") || text.includes("c721") || text.includes("740") || text.includes("741") || text.includes("746") || text.includes("844")) return "https://www.faac.it/service-and-maintenance";
        if (text.includes("garage") || text.includes("d600") || text.includes("d700")) return "https://www.faac.it/servizi-per-utente-finale";
        if (text.includes("volet") || text.includes("store") || text.includes("télécommande") || text.includes("telecommande")) return "https://www.faac.it/accessori-per-automazione";
        return "https://www.faac.it/servizi-per-installatore";
    }

    if (brandId === "came") {
        if (text.includes("télécommande") || text.includes("telecommande") || text.includes("top") || text.includes("tam") || text.includes("twin") || text.includes("radio")) return "https://www.came.com/fr/training/";
        if (text.includes("battant") || text.includes("bras") || text.includes("vérin") || text.includes("verin") || text.includes("coulissant") || text.includes("portail")) return "https://spareparts.came.com/jsp/Template4/HomePage.jsp";
        return "https://www.came.com/fr/produits/automatisations-de-portails/";
    }

    if (brandId === "hormann") {
        if (text.includes("télécommande") || text.includes("telecommande") || text.includes("bisecur") || text.includes("bluesecur")) {
            return "https://www.hormann.fr/conseils/detail/programmation-de-votre-telecommande-hoermann-bisecur-instructions-simples-et-detaillees/";
        }

        return "https://www.hormann.fr/conseils/categorie/c/achat-de-portes-de-garage-et-portails/";
    }

    if (brandId === "servistores") {
        if (text.includes("télécommande") || text.includes("telecommande") || text.includes("commande radio") || text.includes("centralis") || text.includes("récepteur") || text.includes("recepteur")) {
            return "https://www.servistores.com/html/documentation.html?type=PAGE_AIDE";
        }

        if (text.includes("volet battant")) {
            if (text.includes("motoris")) return "https://www.servistores.com/wizard.jsp?wizardId=WizardVoletBattantMotoriseEnfant";
            if (text.includes("aluminium")) return "https://www.servistores.com/wizard.jsp?wizardId=WizardVoletBattantManuelAluEnfant";
            return "https://www.servistores.com/wizard.jsp?wizardId=WizardVoletBattantManuelPVCEnfant";
        }

        if (text.includes("porte de garage")) return "https://www.servistores.com/html/categories/motorisation/recherche.html";
        if (text.includes("portail")) return "https://www.servistores.com/html/categories/motorisation/recherche.html";
        if (text.includes("pièces") || text.includes("piece")) return "https://www.servistores.com/html/categories/pieces-detachees/recherche.html";
        if (text.includes("moteur volet roulant") || text.includes("volet roulant") || text.includes("motorisation")) return "https://www.servistores.com/html/categories/motorisation/recherche.html";

        return "https://www.servistores.com/html/categories/motorisation/recherche.html";
    }

    if (brandId === "somfy") {
        if (text.includes("volet roulant") || /oximo|altus|ilmo|lt50|lt60|rs100|smoove|situo/i.test(productName)) {
            return "https://www.somfy.fr/assistance/notices/volet-roulant";
        }

        if (text.includes("store") || /sonesse|sunea|j4|store/i.test(productName)) {
            return "https://www.somfy.fr/assistance/notices/store-de-terrasse";
        }

        if (text.includes("porte de garage") || /dexxo|rollixo/i.test(productName)) {
            return "https://www.somfy.fr/assistance/notices/garage";
        }

        if (text.includes("portail")) {
            return "https://www.somfy.fr/assistance/notices/portail";
        }

        return "https://www.somfy.fr/assistance/notices";
    }

    if (brandId === "faac") return "https://www.assistenzatecnicafaac.it/faq";
    if (brandId === "came") return "https://spareparts.came.com/jsp/Template4/HomePage.jsp";

    if (brandId === "nice") {
        if (text.includes("battant") || text.includes("vérin") || text.includes("verin")) return "https://www.faac.it/automazioni-per-cancelli-a-battente";
        if (text.includes("portail") || text.includes("coulissant") || text.includes("c720") || text.includes("c721") || text.includes("740") || text.includes("741") || text.includes("746") || text.includes("844")) return "https://www.faac.it/service-and-maintenance";
        if (text.includes("garage") || text.includes("d600") || text.includes("d700")) return "https://www.faac.it/servizi-per-utente-finale";
        if (text.includes("volet") || text.includes("store") || text.includes("télécommande") || text.includes("telecommande") || text.includes("clavier") || text.includes("récepteur") || text.includes("recepteur")) return "https://www.faac.it/accessori-per-automazione";
        return "https://www.faac.it/servizi-per-installatore";
    if (brandId === "bubendorff") return "https://www.bubendorff.com/demander-une-intervention";
    return `https://www.google.com/search?q=${encodeURIComponent(`${brandId} notice moteur`)}`;
}
        if (text.includes("télécommande") || text.includes("telecommande") || text.includes("top") || text.includes("tam") || text.includes("twin") || text.includes("radio")) return "https://www.came.com/fr/produits/accessoires-de-controle-et-de-securite/";
        if (text.includes("battant") || text.includes("bras") || text.includes("vérin") || text.includes("verin") || text.includes("coulissant") || text.includes("portail")) return "https://www.came.com/fr/training/";
        return "https://www.came.com/fr/produits/automatisations-de-portails/";
    const urls = {
        somfy: "https://www.somfy.fr/assistance/notices",
        bubendorff: "https://doc.bubendorff.com",
        faac: "https://www.assistenzatecnicafaac.it",
        came: "https://docs.came.com/it",
        nice: "https://www.niceforyou.com/na/support-center",
        hormann: "https://www.hormann.fr/mediacenter/",
        servistores: "https://www.servistores.com/html/categories/motorisation/recherche.html"
    };

    if (brandId === "faac") {
        if (text.includes("battant") || text.includes("vérin") || text.includes("verin")) return "https://www.faac.it/automazioni-per-cancelli-a-battente";
        if (text.includes("portail") || text.includes("coulissant") || text.includes("c720") || text.includes("c721") || text.includes("740") || text.includes("741") || text.includes("746") || text.includes("844")) return "https://www.faac.it/automazioni-per-cancelli-scorrevoli";
        if (text.includes("garage") || text.includes("d600") || text.includes("d700")) return "https://www.faac.it/automazioni-per-porte-garage";
        if (text.includes("volet") || text.includes("store") || text.includes("télécommande") || text.includes("telecommande")) return "https://www.faac.it/accessori-per-automazione";
        return "https://www.faac.it/service-and-maintenance";
    }

    if (brandId === "came") {
        if (text.includes("télécommande") || text.includes("telecommande") || text.includes("top") || text.includes("tam") || text.includes("twin") || text.includes("radio")) return "https://www.came.com/fr/produits/accessoires-de-controle-et-de-securite/";
        if (text.includes("battant") || text.includes("bras") || text.includes("vérin") || text.includes("verin") || text.includes("coulissant") || text.includes("portail")) return "https://www.came.com/fr/produits/automatisations-de-portails/";
        return "https://www.came.com/fr/training/";
    }

    if (brandId === "hormann") {
        if (text.includes("télécommande") || text.includes("telecommande") || text.includes("bisecur") || text.includes("bluesecur")) {
            return "https://www.hormann.fr/faq/?category=147886&title=motorisation";
        }

        return "https://www.hormann.fr/mediacenter/";
    }

    if (brandId === "servistores") {
        if (text.includes("télécommande") || text.includes("telecommande") || text.includes("commande radio") || text.includes("centralis") || text.includes("récepteur") || text.includes("recepteur")) {
            if (text.includes("récepteur") || text.includes("recepteur")) {
                return "https://www.servistores.com/repository/documents/plans/1810315_recepteurPlatineRts_notice.pdf";
            }

            if (text.includes("centralis") || text.includes("commande groupée") || text.includes("groupe")) {
                return "https://www.servistores.com/repository/documents/plans/1810137_90_ensembleCentralisRts_notice.pdf";
            }

            return "https://www.servistores.com/repository/documents/plans/1810630_telisRts_notice.pdf";
        }

        if (text.includes("volet battant")) return "https://www.servistores.com/html/categories/volet-battant/descriptif.html";
        if (text.includes("porte de garage")) return "https://www.servistores.com/html/categories/motorisation-porte-de-garage/recherche.html";
        if (text.includes("portail")) return "https://www.servistores.com/html/categories/motorisation-portail/recherche.html";
        if (text.includes("pièces") || text.includes("piece")) return "https://www.servistores.com/html/categories/pieces-detachees/recherche.html";
        if (text.includes("moteur volet roulant") || text.includes("volet roulant") || text.includes("motorisation")) return "https://www.servistores.com/html/categories/moteur-volet-roulant/recherche.html";

        return urls.servistores;
    }

    if (brandId !== "somfy") {
        return urls[brandId] || `https://www.google.com/search?q=${encodeURIComponent(`${brandId} notice moteur`)}`;
    }

    if (text.includes("volet roulant") || /oximo|altus|ilmo|lt50|lt60|rs100|smoove|situo/i.test(productName)) {
        if (/radio\s*io|\bio\b/i.test(productName) || text.includes("io")) return "https://www.somfy.fr/assistance/notices/volet-roulant/radio-io";
        if (/rts/i.test(productName)) return "https://www.somfy.fr/assistance/notices/volet-roulant/radio-rts";
        return "https://www.somfy.fr/assistance/notices/volet-roulant";
    }

    if (text.includes("store") || /sonesse|sunea|j4|store/i.test(productName)) return "https://www.somfy.fr/assistance/notices/store-de-terrasse";
    if (text.includes("porte de garage") || /dexxo|rollixo/i.test(productName)) return "https://www.somfy.fr/assistance/notices/garage";

    if (text.includes("portail")) {
        if (/coulissant|elixo|freevia|slidymoove/i.test(productName)) return "https://www.somfy.fr/assistance/notices/portail/coulissant";
        if (/ixengo|verin|vérin/i.test(productName)) return "https://www.somfy.fr/assistance/notices/portail/verin";
        if (/bras|axovia|evolvia|lockyvia/i.test(productName)) return "https://www.somfy.fr/assistance/notices/portail/bras-articules";
        if (/enterr|frog/i.test(productName)) return "https://www.somfy.fr/assistance/notices/portail/enterre";
        return "https://www.somfy.fr/assistance/notices/portail";
    }

    return urls[brandId] || `https://www.google.com/search?q=${encodeURIComponent(`${brandId} notice moteur`)}`;
}

export function appendTechnicalNotice(parent, brand, category, product, procedure) {
    if (brand?.id !== "somfy") {
        return;
    }

    const section = document.createElement("section");
    section.className = "procedure-section technical-notice-section";

    const heading = document.createElement("h3");
    heading.textContent = "Notice technique détaillée";
    section.appendChild(heading);

    const context = `${brand?.name || ""} ${category?.name || ""} ${product?.name || ""} ${procedure?.title || ""}`.toLowerCase();
    const family = detectEquipmentFamily(context);

    const summary = document.createElement("p");
    summary.className = "muted";
    summary.textContent = getNoticeSummary(family, brand?.name || "", product?.name || "", procedure?.title || "");
    section.appendChild(summary);

    const diagram = document.createElement("pre");
    diagram.className = "notice-diagram";
    diagram.textContent = getNoticeDiagram(family, brand?.name || "", product?.name || "");
    section.appendChild(diagram);

    appendListSection(section, "Diagnostic rapide", getNoticeDiagnosticBullets(family, brand?.name || "", product?.name || "", procedure?.title || ""));
    appendListSection(section, "Fonctionnement", getNoticeOperationBullets(family, brand?.name || "", product?.name || "", procedure?.title || ""));
    if (Array.isArray(procedure?.combinations) && procedure.combinations.length) {
        appendSequenceTableSection(section, "Combinaisons du catalogue", procedure.combinations);
    }
    const modelSequenceBullets = getNoticeModelSequenceBullets(family, brand?.name || "", product?.name || "", procedure?.title || "");
    if (!Array.isArray(procedure?.combinations) && modelSequenceBullets.length) {
        appendSequenceTableSection(section, " Séquences connues par marque / modèle", modelSequenceBullets);
    }
    const quickCombinationBullets = getNoticeQuickCombinationBullets(family, brand?.name || "", product?.name || "", procedure?.title || "");
    if (quickCombinationBullets.length) {
        appendListSection(section, "Combinaisons utiles", quickCombinationBullets, "ul");
    }
    appendListSection(section, "Câblage / connexions", getNoticeConnectionBullets(family, brand?.name || "", product?.name || "", procedure?.title || ""));
    appendListSection(section, "Voyants / indicateurs", getNoticeIndicatorBullets(family, brand?.name || "", product?.name || "", procedure?.title || ""));
    appendListSection(section, "Réglages et paramétrage", getNoticeSettingsBullets(family, brand?.name || "", product?.name || "", procedure?.title || ""));
    appendListSection(section, "Manips en cas de panne", getNoticeTroubleshootingBullets(family, brand?.name || "", product?.name || "", procedure?.title || ""), "ol");
    appendListSection(section, "Contrôles et essais", getNoticeTestBullets(family, brand?.name || "", product?.name || "", procedure?.title || ""));
    appendListSection(section, "Pannes fréquentes", getNoticeFailureBullets(family, brand?.name || "", product?.name || "", procedure?.title || ""));
    appendListSection(section, "Remise en service", getNoticeRecoveryBullets(family, brand?.name || "", product?.name || "", procedure?.title || ""));

    parent.appendChild(section);
}

function detectEquipmentFamily(text) {
    if (text.includes("télécommande") || text.includes("telecommande") || text.includes("commande radio") || text.includes("récepteur") || text.includes("recepteur") || text.includes("radio")) return "radio";
    if (text.includes("volet roulant") || text.includes("volet") || text.includes("rts") || text.includes("io")) return "roller";
    if (text.includes("portail") && (text.includes("battant") || text.includes("bras") || text.includes("vérin") || text.includes("verin") || text.includes("axovia") || text.includes("evolvia") || text.includes("ixengo") || text.includes("lockyvia") || text.includes("rota"))) return "swing-gate";
    if (text.includes("portail") || text.includes("coulissant") || text.includes("slid") || text.includes("elixo") || text.includes("freevia") || text.includes("linea")) return "slide-gate";
    if (text.includes("porte de garage") || text.includes("garage") || text.includes("dexxo") || text.includes("rollixo") || text.includes("d600") || text.includes("d700")) return "garage";
    if (text.includes("store") || text.includes("sunea") || text.includes("sonesse") || text.includes("j4")) return "awning";
    if (text.includes("alarme") || text.includes("alarm") || text.includes("protex") || text.includes("home alarm")) return "alarm";
    if (text.includes("domotique") || text.includes("tahoma") || text.includes("connexoon") || text.includes("connectivity kit")) return "home-automation";
    return "general";
}

function getNoticeSummary(family, brandName, productName, procedureTitle) {
    const summaries = {
        radio: `Cette fiche décrit le fonctionnement radio de ${productName || "l'équipement"} et les points de mémorisation à contrôler avant tout remplacement ou appairage.`,
        roller: `Cette fiche détaille le fonctionnement du moteur de volet roulant, les fins de course, les commandes de montée/descente et la remise en service.`,
        "swing-gate": `Cette fiche présente la logique d'un portail battant : commande, vérins, butées, sécurités et auto-apprentissage.`,
        "slide-gate": `Cette fiche présente la logique d'un portail coulissant : alimentation, motoréducteur, crémaillère, fins de course et sécurités.`,
        garage: `Cette fiche couvre la motorisation de porte de garage, les réglages de course et les sécurités à valider avant livraison.`,
        awning: `Cette fiche couvre le fonctionnement du store, les réglages de course et les protections mécaniques à vérifier.`,
        alarm: `Cette fiche couvre les organes de sécurité de l'alarme, l'appairage et les tests de surveillance.`,
        "home-automation": `Cette fiche couvre l'association domotique, la clé système et les vérifications de communication.`,
        general: `Cette fiche regroupe les contrôles essentiels de ${brandName || "la marque"} pour ${procedureTitle || productName || "l'équipement"}.`
    };

    return summaries[family] || summaries.general;
}

function getNoticeDiagnosticBullets(family, brandName, productName, procedureTitle) {
    const base = [
        "Commencer par distinguer une panne d'alimentation, de commande ou de mécanique.",
        "Tester localement avant de suspecter la radio, la carte ou l'application.",
        "Confirmer la référence exacte avant d'appliquer une procédure de remise à zéro."
    ];

    const extra = {
        radio: [
            "Remplacer la pile puis tester avec une télécommande connue fonctionnelle.",
            "Contrôler la portée à faible distance avant de conclure à un défaut radio.",
            "Vérifier si un seul canal ou toute la commande est concerné."
        ],
        roller: [
            "Observer si le tablier bouge librement à la main avant toute intervention.",
            "Déterminer si le défaut vient du moteur, du récepteur ou des fins de course.",
            "Comparer le comportement avec un autre point de commande si disponible."
        ],
        "swing-gate": [
            "Déverrouiller puis déplacer chaque vantail pour chercher un point dur mécanique.",
            "Vérifier si un seul bras, un seul vantail ou la centrale entière est en cause.",
            "Contrôler les butées avant de refaire l'auto-apprentissage."
        ],
        "slide-gate": [
            "Ouvrir le portail manuellement pour identifier un frein, un galet ou une crémaillère mal alignée.",
            "Tester la course sans charge avant de relancer l'apprentissage.",
            "Vérifier la présence d'un obstacle sur le rail ou d'un aimant / fin de course déplacé."
        ],
        garage: [
            "Débrayer la porte pour distinguer panne du moteur et panne d'équilibrage.",
            "Vérifier les cellules et la barre palpeuse avant tout réglage de course.",
            "Contrôler le réembrayage et l'état du chariot après chaque essai."
        ],
        awning: [
            "Identifier si le défaut apparaît en sortie, en rentrée ou sur position intermédiaire.",
            "Vérifier vent, bras, toile et butées avant de toucher au paramétrage.",
            "Tester l'ordre depuis le point de commande local puis depuis la box s'il y en a une."
        ],
        alarm: [
            "Contrôler la pile, le capot et la supervision de la zone concernée.",
            "Vérifier si le défaut est isolé à un capteur ou généralisé à toute la centrale.",
            "Reprendre l'apprentissage d'un seul organe à la fois."
        ],
        "home-automation": [
            "Vérifier que le réseau, la box et la clé système sont cohérents avant l'ajout.",
            "Tester la commande locale avant de suspecter l'intégration domotique.",
            "Isoler un seul équipement pour valider la communication de bout en bout."
        ],
        general: [
            "Faire un test court puis un cycle complet pour valider l'hypothèse.",
            "Noter le symptôme exact avant tout effacement de mémoire ou reset.",
            "Si le doute persiste, repartir du schéma constructeur de la gamme."
        ]
    };

    return [...base, ...(extra[family] || extra.general)];
}

function getNoticeDiagram(family, brandName, productName) {
    const diagrams = {
        radio: "[Télécommande] → [Récepteur radio] → [Centrale] → [Relais] → [Moteur]\n     canal / code          validation          commande          mouvement",
        roller: "[Commande] → [Centrale moteur] → [Relais montée/descente] → [Moteur tubulaire] → [Tablier]\n      PROG / appairage          paramètres de course              tube / fin de course",
        "swing-gate": "[Commande] → [Carte électronique] → [Vérin gauche] + [Vérin droit] → [Vantaux]\n     radio / filaire             logique d'apprentissage          ouverture / fermeture",
        "slide-gate": "[Commande] → [Carte électronique] → [Motoréducteur] → [Crémaillère] → [Portail coulissant]\n      radio / filaire           couple / sécurité          ligne mécanique",
        garage: "[Commande] → [Carte électronique] → [Chariot / entraîneur] → [Porte de garage]\n        radio / filaire             réglage des courses            équilibrage",
        awning: "[Commande] → [Moteur] → [Tube d'enroulement] → [Bras / toile / store]\n       radio / filaire        réglage des butées / positions     tension mécanique",
        alarm: "[Détecteur] → [Centrale] → [Sirène / notification]\n    zone / pile         supervision         alerte",
        "home-automation": "[Application] → [Box] → [Équipement] → [Retour d'état / scénario]\n    Wi-Fi / réseau       clé système        pilotage",
        general: `Schéma de fonctionnement\n[${brandName || "Marque"}] → [${productName || "Produit"}] → [Mise en service]`
    };

    return diagrams[family] || diagrams.general;
}

function getNoticeModelSequenceBullets(family, brandName, productName, procedureTitle) {
    if (family !== "roller" && family !== "radio") return [];

    const text = `${brandName || ""} ${productName || ""} ${procedureTitle || ""}`.toLowerCase();
    const bullets = [];

    const pushUnique = item => {
        if (!bullets.includes(item)) bullets.push(item);
    };

    if (/somfy/.test(text)) {
        if (/oximo rts/.test(text) || /altus rts/.test(text) || (/rts/.test(text) && /(volet|roller|situo|smoove|telis)/.test(text))) {
            pushUnique("Somfy RTS (Oximo / Altus / Situo / Smoove / Telis) : lancer la commande source en mode PROG, valider la nouvelle commande, puis tester la montée, la descente et l'arrêt.");
            pushUnique("Somfy Oximo RTS / Altus RTS : si le sens est inversé, utiliser la séquence montée + descente jusqu'au va-et-vient puis confirmer avec MY / STOP selon la gamme.");
            pushUnique("Somfy Oximo RTS : pour un reset de base, utiliser la séquence 2-8-2 sur le moteur concerné avant de refaire fins de course et appairage.");
        }

        if (/rs100 io/.test(text) || /oximo io/.test(text) || (/io/.test(text) && /(volet|roller|situo|smoove)/.test(text))) {
            pushUnique("Somfy io (Oximo / RS100) : réveiller le moteur selon la notice du modèle, puis vérifier le sens de rotation avant de confirmer les fins de course.");
            pushUnique("Somfy io : après modification, refaire l'association du point de commande et vérifier la position favorite si elle est disponible.");
        }
    }

    if (/hormann|hörmann/.test(text)) {
        if (/bisecur/.test(text) || /bluesecur/.test(text) || /telecommande|télécommande/.test(text)) {
            pushUnique("Hörmann BiSecur / BlueSecur : activer le mode apprentissage sur la motorisation ou la centrale, puis valider l'émetteur à mémoriser.");
            pushUnique("Hörmann : après mémorisation, contrôler ouverture, fermeture, arrêt et la position piétonne ou favorite si le modèle la propose.");
        }
    }

    if (/faac/.test(text)) {
        pushUnique("FAAC : utiliser la touche MEMO / SET / PROG de la carte ou du récepteur, puis valider l'émetteur sur le canal souhaité.");
        pushUnique("FAAC : en cas d'ajout sur portail ou volet, tester le cycle complet et la réaction des sécurités avant de quitter le site.");
    }

    if (/came/.test(text)) {
        pushUnique("CAME : placer la centrale en mode programmation avec la touche dédiée, puis mémoriser la télécommande TOP, TWIN ou équivalent.");
        pushUnique("CAME : après ajout, tester l'ouverture, l'arrêt, la fermeture et le comportement sécurité sur un seul canal de contrôle.");
    }

    if (/nice/.test(text)) {
        pushUnique("Nice : passer le récepteur en apprentissage, puis valider l'émetteur Era, Flo, Smilo ou MyGo sur le canal voulu.");
        pushUnique("Nice : refaire un essai local puis un essai radio sur une seule commande avant de dupliquer la programmation.");
    }

    if (/bubendorff/.test(text)) {
        pushUnique("Bubendorff : identifier la génération du moteur / récepteur avant d'appliquer la séquence de programmation ou de reset.");
        pushUnique("Bubendorff : après changement de pile ou réinitialisation, tester montée, descente et arrêt sur un seul volet avant généralisation.");
    }

    if (/servistores/.test(text)) {
        pushUnique("Servistores : identifier la gamme radio exacte (RTS, Centralis, récepteur, etc.), puis utiliser le bouton ou la séquence indiquée sur la notice du modèle.");
        pushUnique("Servistores : mémoriser un seul canal de test avant de dupliquer la programmation sur les autres volets ou commandes.");
    }

    return bullets;
}

function getNoticeQuickCombinationBullets(family, brandName, productName, procedureTitle) {
    if (family !== "roller" && family !== "radio") return [];

    const text = `${brandName || ""} ${productName || ""} ${procedureTitle || ""}`.toLowerCase();

    const somfyRtsRoller = /somfy/.test(text) && /rts/.test(text) && /(volet|roller|oximo|altus|smoove|situo)/.test(text);
    const somfyIoRoller = /somfy/.test(text) && /io/.test(text) && /(volet|roller|oximo|rs100|smoove|situo)/.test(text);
    const somfyRtsRadio = /somfy/.test(text) && /rts/.test(text) && /(telis|situo|smoove|keygo)/.test(text);
    const hormannRadio = /hormann|hörmann/.test(text) && /(bisecur|bluesecur|telecommande|télécommande|radio)/.test(text);
    const faacRadio = /faac/.test(text) && /(telecommande|télécommande|radio|receiver|récepteur)/.test(text);
    const cameRadio = /came/.test(text) && /(telecommande|télécommande|radio|twin|top|tam)/.test(text);
    const niceRadio = /nice/.test(text) && /(telecommande|télécommande|radio|flo|era|smilo|mygo)/.test(text);
    const bubendorffRoller = /bubendorff/.test(text) && /(volet|roller|moteur|telecommande|télécommande)/.test(text);
    const servistoresRadio = /servistores/.test(text) && /(telecommande|télécommande|commande radio|récepteur|recepteur|centralis)/.test(text);

    if (family === "radio") {
        if (somfyRtsRadio) {
            return [
                "Somfy RTS : pour ajouter une télécommande, maintenir PROG sur la commande déjà programmée jusqu'au va-et-vient, puis appuyer brièvement sur PROG de la nouvelle télécommande.",
                "Somfy RTS : pour vérifier une inversion de sens ou un reset moteur, commencer par la séquence prévue sur le moteur concerné avant de refaire l'appairage radio.",
                "Somfy RTS : si la commande pilote plusieurs volets, identifier le canal exact avant toute manipulation pour éviter d'ajouter le mauvais équipement."
            ];
        }

        if (hormannRadio) {
            return [
                "Hörmann BiSecur / BlueSecur : mettre la motorisation ou le récepteur en mode apprentissage avec la touche prévue, puis valider brièvement l'émetteur à mémoriser.",
                "Hörmann BiSecur : pour une remise à zéro radio, suivre la procédure de la génération exacte de la motorisation, notamment sur les gammes de portail, garage ou télécommande.",
                "Hörmann : après association d'une BiSecur ou d'une BlueSecur, tester ouverture, fermeture, arrêt et la position piétonne si elle existe."
            ];
        }

        if (faacRadio) {
            return [
                "FAAC : utiliser le bouton de mémorisation de la carte ou du récepteur (MEMO / SET / PROG selon la gamme), puis valider la nouvelle télécommande.",
                "FAAC : sur les gammes à code tournant ou radio standard, vérifier la logique de programmation avant de lancer un effacement ou un ajout.",
                "FAAC : après programmation d'une télécommande de portail, contrôler le cycle complet et la réaction des cellules / sécurités."
            ];
        }

        if (cameRadio) {
            return [
                "CAME : placer la centrale ou le récepteur en mode programmation avec la touche dédiée, puis mémoriser la télécommande TOP, TWIN ou équivalent sur le canal souhaité.",
                "CAME : selon la gamme, l'effacement radio peut nécessiter un appui long ou une combinaison sur la carte ; suivre la notice du modèle exact.",
                "CAME : valider ensuite l'ouverture, la fermeture, l'arrêt et le comportement en sécurité après l'ajout d'un émetteur."
            ];
        }

        if (niceRadio) {
            return [
                "Nice : mettre le récepteur ou la motorisation en mode apprentissage, puis valider la télécommande Era, Flo, Smilo ou MyGo à ajouter sur le canal voulu.",
                "Nice : pour une remise en service propre, refaire l'association sur une seule commande de test avant de dupliquer les autres.",
                "Nice : vérifier ensuite les positions d'arrêt, le retour de sécurité et la cohérence du groupe si plusieurs moteurs sont couplés."
            ];
        }

        if (servistoresRadio) {
            return [
                "Servistores : identifier d'abord la gamme radio exacte (RTS, commande groupée, récepteur Centralis / équivalent) puis utiliser le bouton ou la séquence d'apprentissage indiquée par la notice du modèle.",
                "Servistores : si la télécommande pilote plusieurs volets, mémoriser un seul canal de test avant de dupliquer la programmation.",
                "Servistores : après ajout, contrôler le va-et-vient de confirmation et tester une commande locale avant de clore l'intervention."
            ];
        }

        return [
            "Séquence appairage standard : maintenir PROG sur la commande source jusqu'au va-et-vient, puis valider brièvement sur la nouvelle commande.",
            "Pour remettre un canal à zéro, se référer à la notice du modèle : certaines télécommandes effacent via PROG long, d'autres via une séquence source + cible.",
            "Si la télécommande pilote un volet roulant, vérifier d'abord le moteur associé avant de refaire un appairage complet."
        ];
    }

    if (somfyRtsRoller) {
        return [
            "Somfy Oximo RTS / Altus RTS : l'inversion du sens se valide souvent par les appuis montée + descente jusqu'au va-et-vient, puis confirmation par my/stop selon le moteur.",
            "Somfy Oximo RTS / Altus RTS : régler les butées hautes et basses en amenant le tablier en position haute, validation, puis en position basse, validation.",
            "Somfy RTS : la réinitialisation la plus connue reste la séquence 2-8-2 sur le moteur concerné, puis remise en service complète et reprogrammation.",
            "Somfy RTS : après toute combinaison, refaire un cycle complet et tester la position favorite si elle existe."
        ];
    }

    if (somfyIoRoller) {
        return [
            "Somfy RS100 io / Oximo io : réveiller ou associer le moteur selon la notice du modèle, puis vérifier le sens de rotation avant de poursuivre.",
            "Somfy RS100 io / Oximo io : régler les fins de course haute et basse uniquement après suppression d'un éventuel point dur mécanique.",
            "Somfy io : après réinitialisation ou changement de paramètre, refaire l'association du point de commande et contrôler le retour de position si disponible.",
            "Somfy io : valider toujours par un cycle complet montée / descente / arrêt."
        ];
    }

    if (bubendorffRoller) {
        return [
            "Bubendorff : commencer par identifier la génération du moteur et de la télécommande, puis utiliser la procédure radio prévue par cette gamme.",
            "Bubendorff : après changement de pile ou réinitialisation, tester la montée, la descente et l'arrêt sur un seul volet avant de généraliser.",
            "Bubendorff : si la course ou le sens paraît incorrect, vérifier d'abord le moteur et le tablier avant toute nouvelle association."
        ];
    }

    return [
        "Inversion du sens : sur beaucoup de moteurs radio, la combinaison de synchronisation se fait par appuis successifs sur montée/descente puis validation par MY/STOP ou PROG selon le modèle.",
        "Réglage des butées hautes et basses : lancer le moteur en mode réglage, positionner la course haute, valider, puis positionner la course basse et valider.",
        "Réinitialisation : réaliser uniquement la séquence prévue par le fabricant pour le modèle exact ; une coupure secteur simple ne suffit pas toujours.",
        "Après inversion ou reset, refaire toujours un cycle complet et tester la position favorite si elle existe."
    ];
}

function getNoticeOperationBullets(family, brandName, productName, procedureTitle) {
    const base = [
        "Identifier la technologie exacte avant toute intervention.",
        "Repérer la commande locale, la radio et les sécurités associées.",
        "Comparer le comportement réel avec la logique attendue de la fiche."
    ];

    const extra = {
        radio: ["La télécommande envoie un code ou une clé radio vers le récepteur.", "Le récepteur déclenche ensuite la centrale ou le contact sec correspondant.", "La portée dépend de la pile, de l'antenne et de l'environnement radio."],
        roller: ["Le moteur tubulaire pilote montée, stop et descente du tablier.", "Les réglages de course définissent les positions haute et basse.", "Une mécanique dure fausse l'apprentissage et les réglages de force.", "Sur certains modèles, les combinaisons télécommande servent à inverser le sens, régler les butées et lancer un reset."],
        "swing-gate": ["Les vérins ou bras déplacent chaque vantail autour des butées mécaniques.", "La carte gère l'auto-apprentissage, les ralentissements et l'arrêt obstacle.", "La géométrie de pose influe directement sur l'effort moteur."],
        "slide-gate": ["Le motoréducteur entraîne le portail via la crémaillère.", "Les fins de course et les sécurités évitent les blocages en course.", "Un point dur mécanique se traduit souvent par un défaut de couple."],
        garage: ["Le chariot entraîne la porte après réembrayage du système.", "Le réglage de course évite les butées excessives en fin de cycle.", "L'équilibrage de la porte conditionne la durée de vie du moteur."],
        awning: ["Le moteur enroule ou déroule le store selon le sens programmé.", "Les positions de sécurité évitent la sur-tension des bras et de la toile.", "La vitesse et la course doivent rester cohérentes avec la mécanique."],
        alarm: ["Chaque zone de sécurité doit rester visible et surveillée.", "Le remplacement de pile ou l'ajout d'un détecteur passe par l'appairage.", "Le test final doit valider la remontée d'alerte sur la centrale."],
        "home-automation": ["La box envoie les ordres vers l'équipement puis récupère l'état lorsqu'il existe.", "La clé système ou le réseau local doit rester cohérent pendant l'ajout.", "Les scènes et groupes doivent être testés après chaque ajout."],
        general: [`Le produit ${productName || "sélectionné"} suit la séquence décrite dans la procédure ${procedureTitle || "courante"}.`]
    };

    return [...base, ...(extra[family] || extra.general)];
}

function getNoticeSettingsBullets(family, brandName, productName, procedureTitle) {
    const base = [
        "Vérifier l'alimentation, la polarité et les sécurités avant de valider un réglage.",
        "Noter toute valeur de course, canal ou paramètre avant modification.",
        "Ne changer qu'un paramètre à la fois pour identifier la cause exacte."
    ];

    const extra = {
        radio: ["Contrôler la mémoire du récepteur, le canal utilisé et la compatibilité de codage.", "En cas de télécommande, vérifier pile, canal, portée et mode apprentissage.", "Sur système multi-sites, vérifier qu'aucune clé système n'entre en conflit."],
        roller: ["Régler les fins de course haute et basse selon la mécanique réelle du tablier.", "Sur moteurs io / RTS, relancer l'apprentissage après toute intervention mécanique.", "Contrôler la position favorite et les séquences de reset propres au moteur."],
        "swing-gate": ["Régler les temps d'ouverture, la fermeture automatique et les ralentissements.", "Vérifier les butées et la course utile avant de lancer l'auto-apprentissage.", "Si le portail est asymétrique, contrôler séparément chaque vantail."],
        "slide-gate": ["Aligner crémaillère, fins de course et déverrouillage manuel avant réglage.", "Ajuster le couple uniquement après suppression des points durs.", "Contrôler la fonction piétonne et les ralentissements si la centrale le permet."],
        garage: ["Vérifier l'équilibrage de la porte avant d'ajuster les fins de course.", "Contrôler les paramètres de sécurité anti-écrasement et les cellules.", "Faire une remise à zéro puis un apprentissage si la course est incohérente."],
        awning: ["Positionner la sortie et la rentrée sans mettre les bras en contrainte.", "Adapter les arrêts à la toile et à l'architecture du store.", "Couper le test en cas de vent fort ou de résistance anormale."],
        alarm: ["Associer les équipements un par un puis renommer les zones.", "Contrôler les temporisations et les notifications après ajout.", "Vérifier la pile, le niveau radio et la surveillance de chaque détecteur."],
        "home-automation": ["Contrôler le Wi‑Fi / réseau et la proximité de la box avant l'ajout.", "Vérifier la clé système et le type de protocole (io, RTS, etc.).", "Créer des pièces et groupes cohérents après validation locale."],
        general: ["Revenir à la fiche fabricant si le paramètre attendu n'apparaît pas dans la procédure.", "Ne jamais valider un réglage sans test complet en ouverture et fermeture.", "Sauvegarder la configuration et la référence exacte de l'équipement."]
    };

    return [...base, ...(extra[family] || extra.general)];
}

function getNoticeTestBullets(family, brandName, productName, procedureTitle) {
    const base = [
        "Tester la commande locale avant la radio pour distinguer panne mécanique et panne de communication.",
        "Vérifier la réaction du moteur, du récepteur ou de la centrale à chaque essai.",
        "Consigner le résultat de chaque test avant de passer à l'étape suivante."
    ];

    const extra = {
        radio: ["Tester la distance de fonctionnement et la réaction du récepteur sur plusieurs canaux.", "Vérifier le retour de va-et-vient ou de voyant après programmation.", "Comparer une télécommande connue fonctionnelle avec la télécommande à dépanner."],
        roller: ["Faire un cycle complet montée / descente / stop / reprise.", "Contrôler les fins de course en haut et en bas, puis la position favorite.", "Vérifier que le tablier ne frotte pas et ne déclenche pas de sécurité."],
        "swing-gate": ["Tester chaque vantail séparément puis le cycle complet.", "Vérifier l'arrêt sur obstacle et la fermeture symétrique.", "Observer le comportement en fin de course et en ouverture piétonne si présente."],
        "slide-gate": ["Tester ouverture totale, fermeture et retour d'obstacle.", "Vérifier la portée des photocellules et la détection de sécurité.", "Contrôler le déplacement manuel après déverrouillage pour éliminer un point dur."],
        garage: ["Réaliser un cycle complet et vérifier l'absence de forçage en haut comme en bas.", "Tester la réouverture sur obstacle et les sécurités de porte.", "Vérifier le réembrayage manuel et la reprise du moteur."],
        awning: ["Tester la montée, la sortie et la position intermédiaire si disponible.", "Vérifier que les bras ne rentrent pas en contrainte sur les butées.", "Contrôler le comportement du store après plusieurs cycles."],
        alarm: ["Tester la remontée d'état sur la centrale ou l'application.", "Déclencher un essai de supervision pour vérifier la zone concernée.", "Valider la sirène, le voyant ou la notification après l'ajout."],
        "home-automation": ["Tester la commande depuis la box et depuis le point de commande local.", "Vérifier le retour d'état si le protocole le permet.", "Relancer l'association si l'équipement disparaît du groupe."],
        general: ["Réaliser un essai complet de bout en bout avant restitution au client.", "Vérifier qu'aucun message d'erreur ne subsiste sur la centrale.", "Noter la configuration finale et le comportement observé."]
    };

    return [...base, ...(extra[family] || extra.general)];
}

function getNoticeFailureBullets(family, brandName, productName, procedureTitle) {
    const base = [
        "Coupure d'alimentation, sécurité ouverte ou commande non appairée.",
        "Blocage mécanique, point dur ou butée mal réglée.",
        "Pile faible, mémoire saturée ou récepteur mal raccordé."
    ];

    const extra = {
        radio: ["Télécommande non reconnue, pile faible ou clé système différente.", "Récepteur saturé, mémoire pleine ou canal mal mémorisé.", "Antenne mal placée ou portée perturbée par l'environnement."],
        roller: ["Moteur silencieux, tablier dur ou fins de course incohérentes.", "Réglage 2-8-2 ou PROG non effectué correctement.", "Sens inversé, volet qui s'arrête trop tôt ou qui force en butée."],
        "swing-gate": ["Vantail qui force, bras mal positionné ou butée déplacée.", "Mauvaise géométrie de pose ou apprentissage de course incomplet.", "Sécurité active, photocellule sale ou entrée STOP ouverte."],
        "slide-gate": ["Crémaillère mal alignée, rail sale ou galet fatigué.", "Défaut de couple ou arrêt intempestif sur obstacle.", "Fin de course / aimant mal placé ou sécurité active."],
        garage: ["Porte mal équilibrée, chariot débrayé ou rail perturbé.", "Sécurité anti-écrasement déclenchée ou cellule ouverte.", "Réglage de course à refaire après remise en ordre mécanique."],
        awning: ["Bras sous contrainte, toile décentrée ou vent trop fort.", "Arrêt de course incorrect ou position de sécurité absente.", "Électronique qui coupe par protection thermique ou effort excessif."],
        alarm: ["Pile faible, zone non supervisée ou défaut de communication.", "Centrale désarmée / armée avec un équipement non ajouté.", "Notification absente à cause d'un compte ou réseau non cohérent."],
        "home-automation": ["Box hors réseau, Wi‑Fi instable ou équipement hors portée.", "Clé système incohérente ou association incomplète.", "Groupe ou pièce mal nommé rendant la maintenance confuse."],
        general: ["Procédure incomplète ou référence exacte non identifiée.", "Contrôle visuel et électrique à refaire avant remise en service.", "Revenir au guide fabricant si le comportement reste non conforme."]
    };

    return [...base, ...(extra[family] || extra.general)];
}

function getNoticeTroubleshootingBullets(family, brandName, productName, procedureTitle) {
    const base = [
        "Couper puis remettre l'alimentation uniquement sur l'équipement concerné.",
        "Tester la commande locale pour savoir si la panne vient du moteur ou de la radio.",
        "Vérifier visuellement le mouvement avant tout nouveau réglage.",
        "Contrôler les sécurités et les entrées STOP / cellule avant de relancer un apprentissage.",
        "Ne refaire qu'un seul réglage à la fois, puis refaire un cycle complet.",
        "Si le défaut persiste, noter la référence exacte et le code / voyant observé avant de continuer."
    ];

    const extra = {
        radio: [
            "Changer la pile de la télécommande si la portée est faible ou intermittente.",
            "Supprimer puis réassocier un seul canal si la mémoire radio semble incohérente.",
            "Tester avec une télécommande connue fonctionnelle pour isoler le défaut.",
            "Vérifier l'antenne du récepteur et son positionnement avant de conclure à une panne de codage."
        ],
        roller: [
            "Contrôler que le tablier monte librement à la main avant d'insister sur le moteur.",
            "Lancer un reset ou une séquence de programmation uniquement sur le moteur concerné.",
            "Si le moteur force, vérifier attaches, verrous, coulisses et butées avant toute réinitialisation.",
            "Reprogrammer les fins de course après correction mécanique, puis refaire deux cycles complets."
        ],
        "swing-gate": [
            "Déverrouiller chaque vantail et vérifier qu'il se déplace sans point dur.",
            "Recontrôler les butées d'ouverture et de fermeture avant l'auto-apprentissage.",
            "Si un seul vantail force, isoler le moteur concerné et corriger sa géométrie.",
            "Tester l'arrêt sur obstacle et la fermeture automatique après recalibrage."
        ],
        "slide-gate": [
            "Déverrouiller le moteur et faire coulisser le portail à la main pour chercher le point dur.",
            "Nettoyer rail, galets, crémaillère et zone de fins de course avant remise en route.",
            "Contrôler l'alignement du pignon et le serrage de la crémaillère avant tout apprentissage.",
            "Relancer la course complète seulement après suppression des défauts mécaniques."
        ],
        garage: [
            "Débrayer la porte et vérifier l'équilibrage avant de relancer le moteur.",
            "Contrôler la tension du rail, le chariot et les cellules avant toute programmation.",
            "Si la porte s'arrête, vérifier d'abord l'équilibrage plutôt que la carte.",
            "Faire un nouvel apprentissage après remise en ordre mécanique et valider plusieurs cycles."
        ],
        awning: [
            "Arrêter immédiatement si la toile ou les bras se mettent en contrainte.",
            "Vérifier vent, butées et capteurs avant de recommencer la manœuvre.",
            "Reprendre le réglage de course avec de petits incréments seulement.",
            "Tester la sortie et la rentrée sans vent, puis enregistrer la position de sécurité."
        ],
        alarm: [
            "Vérifier la pile, le tamper et la portée radio du détecteur concerné.",
            "Supprimer puis réajouter un seul capteur si la supervision ne remonte plus.",
            "Tester la sirène et la remontée d'état sur la centrale après association.",
            "Contrôler le mode armé / désarmé pour éviter un faux défaut de surveillance."
        ],
        "home-automation": [
            "Redémarrer la box ou le pont si l'équipement a disparu de l'application.",
            "Vérifier le Wi‑Fi, la clé système et la proximité radio avant de relancer l'association.",
            "Recréer le groupe ou la pièce si les commandes sont reçues au mauvais endroit.",
            "Faire un test local puis un test via l'application pour confirmer la remise en service."
        ],
        general: [
            "Documenter le symptôme exact avant de modifier un réglage.",
            "Revenir au schéma constructeur si le défaut n'est pas clairement identifié.",
            "Ne pas forcer une mécanique ou une commande qui résiste anormalement."
        ]
    };

    return [...base, ...(extra[family] || extra.general)];
}

function getNoticeConnectionBullets(family, brandName, productName, procedureTitle) {
    const base = [
        "Identifier les bornes d'alimentation, les entrées de sécurité et le mode de commande.",
        "Vérifier le serrage des connexions avant de lancer l'apprentissage ou le test.",
        "Comparer le câblage réel au schéma constructeur de la gamme concernée."
    ];

    const extra = {
        radio: ["Repérer l'alimentation du récepteur, le contact sec et la borne commune.", "Vérifier l'antenne, la polarité si applicable et le cheminement du câble.", "Si un émetteur externe est utilisé, vérifier la compatibilité de codage."],
        roller: ["Identifier montée, descente, neutre et terre selon la technologie du moteur.", "Sur commande radio, vérifier l'alimentation du récepteur ou de la centrale.", "Contrôler les entrées STOP, cellule ou contact de sécurité si présentes."],
        "swing-gate": ["Repérer moteur 1, moteur 2, cellule, feu clignotant et entrée de sécurité.", "Vérifier le câblage des fins de course ou des retours encodeur si présents.", "Contrôler le sens de chaque vantail avant l'auto-apprentissage."],
        "slide-gate": ["Repérer alimentation, moteur, photocellules et entrée contact sec.", "Contrôler le déverrouillage manuel et la position des fins de course / aimants.", "Vérifier la crémaillère et le sens mécanique avant mise sous tension."],
        garage: ["Repérer alimentation, cellules, voyant, contacteur et chariot d'entraînement.", "Vérifier les sécurités anti-écrasement avant toute remise en service.", "Contrôler le rail et le réembrayage si le système est débrayable."],
        awning: ["Repérer alimentation, montée, descente et éventuelles sécurités vent/soleil.", "Vérifier les fins de course ou butées mécaniques avant réglage.", "Contrôler les capteurs connectés si le store est motorisé et domotisé."],
        alarm: ["Repérer centrale, détecteur, sirène et alimentation secours.", "Contrôler la polarité, les tamper et la supervision radio si présente.", "Vérifier le retour d'état de chaque élément ajouté."],
        "home-automation": ["Repérer box, alimentation réseau, protocole radio et appareil associé.", "Vérifier la clé système, les identifiants réseau et les groupes créés.", "S'assurer qu'aucun autre système ne prend la main sur la commande."],
        general: ["Repérer chaque borne ou connecteur avant tout changement.", "Vérifier l'absence de faux contact, de fil abîmé ou de cosse oxydée.", "Resserrer toutes les connexions après essai." ]
    };

    return [...base, ...(extra[family] || extra.general)];
}

function getNoticeIndicatorBullets(family, brandName, productName, procedureTitle) {
    const base = [
        "Observer les voyants de la centrale ou du récepteur pendant chaque test.",
        "Noter tout clignotement, code erreur ou absence de retour visuel.",
        "Comparer l'indication observée avec l'état attendu dans la fiche de la gamme."
    ];

    const extra = {
        radio: ["Voyant d'apprentissage, bip ou va-et-vient confirment souvent l'ajout réussi.", "Si aucune LED ne réagit, vérifier l'alimentation et la mémoire du récepteur.", "Un voyant fixe anormal peut indiquer une mémoire pleine ou un défaut de codage."],
        roller: ["Le va-et-vient sert souvent de confirmation d'apprentissage ou de reset.", "Un clignotement rapide peut signaler un défaut de sécurité ou une course non apprise.", "Sur boîtier radio, vérifier la LED d'état et l'entrée PROG si présente."],
        "swing-gate": ["Les voyants de sécurité doivent rester cohérents sur les deux vantaux.", "Le défaut cellule ou STOP se lit souvent dès la tentative de fermeture.", "La centrale peut afficher une séquence d'auto-apprentissage par LED ou code sonore."],
        "slide-gate": ["Observer le retour de la centrale pendant l'apprentissage de course.", "Une LED ou un code peut signaler un couple trop élevé ou une sécurité ouverte.", "Contrôler les voyants de photocellule et de défaut moteur après chaque cycle."],
        garage: ["Le retour visuel doit confirmer l'ouverture, la fermeture et la réouverture sur obstacle.", "Un voyant de sécurité ouvert signifie souvent cellule ou barre palpeuse en défaut.", "Le chariot ou la carte peuvent signaler un arrêt de sécurité ou de butée."],
        awning: ["Observer l'arrêt net sans clignotement d'erreur sur la commande.", "Une réaction irrégulière peut indiquer une sur-tension mécanique ou un capteur actif.", "Les indications de la box domotique doivent correspondre au mouvement réel."],
        alarm: ["Les LED de supervision doivent confirmer la détection et la fermeture de capot.", "Une alerte persistante signale souvent une pile faible ou un tamper déclenché.", "Le retour d'état doit être visible dans l'application ou sur la centrale."],
        "home-automation": ["La box ou l'application doit afficher l'état de l'équipement après l'ajout.", "Un symbole barré ou grisé indique souvent une liaison incomplète.", "La validation visuelle doit correspondre à la réaction réelle du moteur."],
        general: ["Tout comportement lumineux inhabituel doit être noté avant de poursuivre.", "En cas d'absence totale d'indication, contrôler l'alimentation principale.", "La fin d'essai doit laisser un état visuel clair et cohérent."]
    };

    return [...base, ...(extra[family] || extra.general)];
}

function getNoticeRecoveryBullets(family, brandName, productName, procedureTitle) {
    const base = [
        "Après correction, refaire un cycle complet de validation.",
        "Conserver la référence de l'équipement et le résultat final de la procédure.",
        "Restituer au client le mode de commande et les limites d'utilisation."
    ];

    const extra = {
        radio: ["Tester chaque télécommande ou canal avant de quitter le site.", "Noter les références mémorisées pour éviter les doublons.", "Si nécessaire, refaire un appairage propre sur un canal libre."],
        roller: ["Reprogrammer la position favorite et vérifier les butées.", "Valider la montée, la descente, le stop et l'inversion éventuelle.", "Laisser un cycle complet se terminer sans intervention."],
        "swing-gate": ["Relancer un auto-apprentissage si la géométrie a été corrigée.", "Vérifier le cycle complet des deux vantaux et l'arrêt sur obstacle.", "Consigner la version de réglage et la force si accessible."],
        "slide-gate": ["Après nettoyage ou réalignement, refaire la course complète.", "Tester la fermeture en condition réelle et le déverrouillage manuel.", "S'assurer qu'aucun point dur ne réapparaît en fin de cycle."],
        garage: ["Régler la course finale puis tester plusieurs ouvertures successives.", "Confirmer que la porte reste équilibrée et que le chariot réembraye bien.", "Noter toute anomalie pour un suivi ultérieur."],
        awning: ["Confirmer que la toile rentre et sort sans contrainte.", "Revalider la position de repos après quelques cycles.", "Informer le client de ne pas forcer le store en cas de vent fort."],
        alarm: ["Faire un test de déclenchement et d'acquittement complet.", "Vérifier que toutes les notifications sont revenues normales.", "Déclarer la maintenance terminée seulement après retour d'état nominal."],
        "home-automation": ["Revalider le groupe ou la scène créée.", "Confirmer que la box et les appareils restent visibles après redémarrage.", "Répertorier les équipements ajoutés pour le dossier client."],
        general: ["Faire un dernier test après fermeture de la fiche.", "Noter la configuration finale et les pièces éventuellement remplacées.", "Laisser un message clair de maintenance réussie ou d'action à prévoir."]
    };

    return [...base, ...(extra[family] || extra.general)];
}

export function appendWebPhotoGuides(parent, brand, category, product, procedure) {
    const section = document.createElement("section");
    section.className = "procedure-section";

    const heading = document.createElement("h3");
    heading.textContent = " Liens fabricants";
    section.appendChild(heading);

    const list = document.createElement("ul");
    const commerce = procedure?.commerce || {};
    const items = [
        { label: "Notice", url: commerce.noticeUrl || getManufacturerNoticeUrl(brand.id, category.name, product.name) },
        { label: "Tuto", url: commerce.tutoUrl || getManufacturerGuideUrl(brand.id, category.name, product.name) }
    ];

    items.forEach(item => {
        if (!item.url) return;
        const li = document.createElement("li");
        const link = document.createElement("a");
        link.href = item.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = item.label;
        li.appendChild(link);
        list.appendChild(li);
    });

    if (procedure?.videos?.length) {
        const li = document.createElement("li");
        li.textContent = ` ${procedure.videos[0]}`;
        list.appendChild(li);
    }

    section.appendChild(list);
    parent.appendChild(section);
}

export function appendCommerceSection(parent, procedure) {
    const commerce = procedure?.commerce;
    const offers = Array.isArray(commerce?.offers) ? commerce.offers : [];

    if (!commerce?.buyUrl && !offers.length) return;

    const section = document.createElement("section");
    section.className = "procedure-section commerce-section";

    const heading = document.createElement("h3");
    heading.textContent = " Achat et prix";
    section.appendChild(heading);

    if (commerce?.purchaseLabel || commerce?.buyUrl) {
        const lead = document.createElement("p");
        lead.className = "muted";
        lead.textContent = commerce.purchaseLabel || "Consulter la sélection Servistores correspondante.";
        section.appendChild(lead);

        const buyLink = document.createElement("a");
        buyLink.href = commerce.buyUrl;
        buyLink.target = "_blank";
        buyLink.rel = "noopener noreferrer";
        buyLink.className = "secondary-button commerce-buy-link";
        buyLink.textContent = "Ouvrir la sélection";
        section.appendChild(buyLink);
    }

    if (offers.length) {
        const offersGrid = document.createElement("div");
        offersGrid.className = "commerce-offers";

        offers.forEach(offer => {
            const card = document.createElement("a");
            card.href = offer.url;
            card.target = "_blank";
            card.rel = "noopener noreferrer";
            card.className = "commerce-offer";

            card.innerHTML = `
                <strong>${escapeHtml(offer.label || "Produit")}</strong>
                <span class="commerce-price">${escapeHtml(offer.priceText || "Prix non renseigné")}</span>
                <small>${escapeHtml(offer.availability || "")}</small>
                <span class="commerce-offer-link">Voir la fiche</span>
            `;

            offersGrid.appendChild(card);
        });

        section.appendChild(offersGrid);
    }

    parent.appendChild(section);
}

export function appendResources(parent, procedure) {
    const resources = [
        ...procedure.documents.map(item => ({ label: item, icon: "" })),
        ...procedure.photos.map(item => ({ label: item, icon: "" })),
        ...procedure.videos.map(item => ({ label: item, icon: "" }))
    ];

    if (!resources.length) return;

    const section = document.createElement("section");
    section.className = "procedure-section";

    const heading = document.createElement("h3");
    heading.textContent = " Ressources";
    section.appendChild(heading);

    const list = document.createElement("ul");

    resources.forEach(resource => {
        const item = document.createElement("li");

        if (resource.icon === "" && /^https?:\/\//i.test(resource.label)) {
            const wrapper = document.createElement("a");
            wrapper.href = resource.label;
            wrapper.target = "_blank";
            wrapper.rel = "noopener noreferrer";
            wrapper.className = "resource-image-link";

            const image = document.createElement("img");
            image.src = resource.label;
            image.alt = "Illustration Servistores";
            image.loading = "lazy";

            const caption = document.createElement("span");
            caption.textContent = "Ouvrir l'image";

            wrapper.append(image, caption);
            item.appendChild(wrapper);
        } else if (/^https?:\/\//i.test(resource.label)) {
            const link = document.createElement("a");
            link.href = resource.label;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.textContent = `${resource.icon} Ouvrir le lien`;
            item.appendChild(link);
        } else {
            item.textContent = `${resource.icon} ${resource.label}`;
        }

        list.appendChild(item);
    });

    section.appendChild(list);
    parent.appendChild(section);
}

export function renderError(title, message) {
    const container = getContainer();
    if (!container) return;

    const pageTitle = document.getElementById("pageTitle");
    if (pageTitle) pageTitle.textContent = title;

    container.appendChild(createInfo(`${title} : ${message}`));
}
