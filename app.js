async function loadDatabase() {

    const response = await fetch("data/database.json");

    const database = await response.json();

    displayBrands(database.brands);

}

function displayBrands(brands) {

    const container = document.getElementById("brands");

    container.innerHTML = "";

    brands.forEach(brand => {

        const card = document.createElement("div");

        card.className = "brand-card";

        card.innerHTML = `
            <h2>${brand.name}</h2>
        `;

        container.appendChild(card);

    });

}

loadDatabase();
