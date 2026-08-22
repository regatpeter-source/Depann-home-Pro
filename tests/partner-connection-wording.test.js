import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../js/partner-connections.js", import.meta.url), "utf8");

test("l’interface distingue une API entrante d’une connexion au compte partenaire", () => {
    assert.match(source, /API entrantes personnalisées/);
    assert.match(source, /ne connecte pas à son interface/);
    assert.match(source, /ne demande aucun identifiant ni mot de passe/);
    assert.match(source, /Générer l’endpoint et la clé API/);
    assert.match(source, /Connectez un organisme extérieur par identifiants sécurisés ou OAuth/);
});
