/* ==========================================================
   DEPANN'HOME PRO
   Version 0.1
========================================================== */

const home = document.getElementById("home");
const content = document.getElementById("content");
const searchInput = document.getElementById("searchInput");

const data = {

    somfy: [
        "Volets roulants",
        "Télécommandes",
        "Télécommandes centrales",
        "Stores",
        "Portails",
        "Portes de garage",
        "Diagnostic"
    ],

    faac: [
        "Portails battants",
        "Portails coulissants",
        "Télécommandes",
        "Cartes électroniques",
        "Diagnostic"
    ],

    bubendorff: [
        "Volets roulants",
        "Télécommandes",
        "Réinitialisation",
        "Diagnostic"
    ],

    nice: [
        "Portails",
        "Volets roulants",
        "Télécommandes",
        "Diagnostic"
    ],

    came: [
        "Portails",
        "Télécommandes",
        "Cartes électroniques",
        "Diagnostic"
    ]

};

/* ==========================
        MENU MARQUES
========================== */

document.querySelectorAll(".brand").forEach(card => {

    card.addEventListener("click", () => {

        openBrand(card.dataset.brand);

    });

});

/* ==========================
        OUVRIR UNE MARQUE
========================== */

function openBrand(brand){

    home.style.display = "none";

    content.classList.remove("hidden");

    let html = `

        <button id="backButton">
            ← Retour
        </button>

        <h2 class="pageTitle">
            ${brand.toUpperCase()}
        </h2>

        <div class="menu">

    `;

    data[brand].forEach(item => {

        html += `

            <div class="card menuCard">

                ${item}

            </div>

        `;

    });

    html += "</div>";

    content.innerHTML = html;

    document
        .getElementById("backButton")
        .addEventListener("click", goHome);

}

/* ==========================
        RETOUR
========================== */

function goHome(){

    content.classList.add("hidden");

    home.style.display = "grid";

}

/* ==========================
        RECHERCHE
========================== */

searchInput.addEventListener("keyup", function(){

    const value = this.value.toLowerCase();

    document.querySelectorAll(".brand").forEach(card=>{

        const txt = card.innerText.toLowerCase();

        if(txt.includes(value)){

            card.style.display="block";

        }

        else{

            card.style.display="none";

        }

    });

});

/* ==========================
        PWA
========================== */

if ("serviceWorker" in navigator){

    window.addEventListener("load",()=>{

        navigator.serviceWorker
            .register("service-worker.js");

    });

}
