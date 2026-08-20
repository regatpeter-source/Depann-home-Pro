import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const messageServer = read("../server/messages.js");
const technicalReports = read("../server/technical-reports.js");
const navigation = read("../js/navigation.js");
const schema = read("../database/schema.sql");

test("internal messages are strictly stored in a client conversation", () => {
	assert.match(schema, /CREATE TABLE IF NOT EXISTS depannhome_messages[\s\S]*client_id VARCHAR\(100\) NOT NULL/);
	assert.match(schema, /DELETE FROM depannhome_messages\s+WHERE client_id IS NULL OR BTRIM\(client_id\) = ''/);
	assert.match(messageServer, /ALTER TABLE depannhome_messages ALTER COLUMN client_id SET NOT NULL/);
	assert.match(messageServer, /if \(!clientId\) return response\.status\(403\)/);
	assert.match(messageServer, /createClientMessage\(\{ ownerId, senderId: request\.user\.sub, clientId, body \}\)/);
	assert.doesNotMatch(messageServer, /message\.client_id IS NULL/);
});

test("message notifications open the matching client conversation", () => {
	assert.match(messageServer, /"client_message_received"/);
	assert.match(messageServer, /\{ entityType: "client", entityId: clientId \}/);
	assert.match(messageServer, /\{ clientId, messageId: String\(messageId\)/);
	assert.match(navigation, /if \(entityType === "client"\) return openClients\(entityId \|\| String\(notification\?\.payload\?\.clientId \|\| ""\)\)/);
	assert.match(navigation, /selectedId, focusMessages: true/);
});

test("report correction notes use the shared client conversation", () => {
	assert.match(technicalReports, /import \{ createClientMessage \} from "\.\/messages\.js"/);
	assert.match(technicalReports, /createClientMessage\(\{ ownerId, senderId, clientId: report\.clientId, appointmentId: report\.appointmentId/);
	assert.doesNotMatch(technicalReports, /INSERT INTO depannhome_messages/);
	assert.doesNotMatch(technicalReports, /report\.clientId \|\| null/);
});

test("the Favorites section is absent from product surfaces", () => {
	const sources = [
		"../index.html",
		"../js/app.js",
		"../js/config.js",
		"../js/navigation.js",
		"../js/storage.js",
		"../server/organizations.js",
		"../server/subscription-tiers.js",
		"../docs/ARCHITECTURE.md",
		"../docs/MENU_ARCHITECTURE.md",
		"../docs/PRESENTATION_COMMERCIALE_PARTENAIRES.md"
	].map(read).join("\n");
	assert.doesNotMatch(sources, /favorites|Favoris|Favorites|favoritesBtn|ROUTES\.favorites/);
});
