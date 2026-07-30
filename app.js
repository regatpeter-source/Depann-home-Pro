import "dotenv/config";
import cookieParser from "cookie-parser";
import express from "express";
import helmet from "helmet";
import path from "node:path";
import { fileURLToPath } from "node:url";
import rateLimit from "express-rate-limit";
import {
	authenticateRequest,
	createInitialAdministrator,
	recoverCreatorPassword,
	recoverCreatorTotp,
	requireCreator,
	registerAuthRoutes,
	requireAuthentication,
	validateAuthenticationConfiguration
} from "./server/auth.js";
import { initializeDatabase } from "./server/database.js";
import { registerCreatorRoutes } from "./server/creator.js";
import { billingUploadErrorHandler, initializeBilling, registerBillingRoutes } from "./server/billing.js";
import { initializeSubscriptionInvoicing, registerSubscriptionInvoicingRoutes, startSubscriptionInvoicingScheduler } from "./server/invoicing.js";
import { initializeAccounting, registerAccountingRoutes } from "./server/accounting.js";
import { initializeConnectors, registerConnectorRoutes } from "./server/connectors.js";
import { initializePurchases, registerPurchaseRoutes } from "./server/purchases.js";
import { initializeMessages, registerMessageRoutes } from "./server/messages.js";
import { initializeCalendar, registerCalendarRoutes } from "./server/calendar.js";
import { clientUploadErrorHandler, initializeClients, registerClientRoutes } from "./server/clients.js";
import { initializeTechnicalReports, registerTechnicalReportRoutes, technicalReportUploadErrorHandler } from "./server/technical-reports.js";
import { initializeCollaboration, registerCollaborationRoutes } from "./server/collaboration.js";
import { initializePartnerMissions, registerPartnerMissionRoutes } from "./server/partner-missions.js";
import { initializePartnerDialogue, partnerDialogueUploadErrorHandler, registerPartnerDialogueRoutes } from "./server/partner-dialogue.js";
import { registerSupportRoutes } from "./server/support.js";
import {
	libraryUploadErrorHandler,
	initializeLibrary,
	registerLibraryRoutes
} from "./server/library.js";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: "25mb" }));
app.use(cookieParser());
app.use(authenticateRequest);

const authenticationRateLimit = rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 20,
	standardHeaders: "draft-7",
	legacyHeaders: false,
	message: { message: "Trop de tentatives. Réessayez dans quelques minutes." }
});
app.use("/api/auth/login", authenticationRateLimit);
app.use("/api/auth/register", authenticationRateLimit);
app.use("/api/auth/verify-device-code", authenticationRateLimit);
app.use("/api/auth/verify-creator-totp", authenticationRateLimit);
app.use("/api/support", rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 10,
	standardHeaders: "draft-7",
	legacyHeaders: false,
	message: { message: "Trop de demandes au support. Réessayez dans quelques minutes." }
}));
app.use("/api/partner-intake", rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 120,
	standardHeaders: "draft-7",
	legacyHeaders: false,
	message: { message: "Trop de missions reçues. Réessayez dans quelques minutes." }
}));
app.use("/api/partner-dialogue/external", rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 120,
	standardHeaders: "draft-7",
	legacyHeaders: false,
	message: { message: "Trop de requêtes partenaire. Réessayez dans quelques minutes." }
}));
registerAuthRoutes(app);
registerCreatorRoutes(app, requireCreator);
registerSubscriptionInvoicingRoutes(app, requireCreator);
registerAccountingRoutes(app, requireAuthentication);
registerConnectorRoutes(app, requireAuthentication);
registerPartnerMissionRoutes(app, requireAuthentication);
registerPartnerDialogueRoutes(app, requireAuthentication);
registerBillingRoutes(app, requireAuthentication);
registerPurchaseRoutes(app, requireAuthentication);
registerMessageRoutes(app, requireAuthentication);
registerCalendarRoutes(app, requireAuthentication);
registerCollaborationRoutes(app, requireAuthentication);
registerTechnicalReportRoutes(app, requireAuthentication);
registerClientRoutes(app, requireAuthentication);
registerLibraryRoutes(app, requireAuthentication);
registerSupportRoutes(app, requireAuthentication);

// Seul le logo est nécessaire avant connexion. Le catalogue et les notices sont servis
// uniquement après validation du cookie de session HTTP-only.
app.get("/assets/logo.png.png", (request, response) => {
	response.sendFile(path.join(rootDirectory, "assets", "logo.png.png"));
});
app.use("/data", requireAuthentication, requireTechnicalWorkspaceAccess, express.static(path.join(rootDirectory, "data"), { index: false }));
app.use("/assets", requireAuthentication, requireTechnicalWorkspaceAccess, express.static(path.join(rootDirectory, "assets"), { index: false }));

app.get(["/", "/index.html"], (request, response) => {
	response.sendFile(path.join(rootDirectory, "index.html"), { headers: { "Cache-Control": "no-store" } });
});
app.use("/css", express.static(path.join(rootDirectory, "css"), { index: false }));
app.use("/js", express.static(path.join(rootDirectory, "js"), { index: false }));
app.get("/manifest.json", (request, response) => {
	response.sendFile(path.join(rootDirectory, "manifest.json"));
});
app.get("/service-worker.js", (request, response) => {
	response.sendFile(path.join(rootDirectory, "service-worker.js"), { headers: { "Cache-Control": "no-cache" } });
});

app.use(billingUploadErrorHandler);
app.use(clientUploadErrorHandler);
app.use(technicalReportUploadErrorHandler);
app.use(libraryUploadErrorHandler);
app.use(partnerDialogueUploadErrorHandler);
app.use((error, request, response, next) => {
	console.error(error);
	if (response.headersSent) return next(error);
	return response.status(500).json({ message: "Erreur interne du serveur." });
});

async function start() {
	validateAuthenticationConfiguration();
	await initializeDatabase();
	await initializeBilling();
	await initializeAccounting();
	await initializeConnectors();
	await initializeSubscriptionInvoicing();
	await initializePurchases();
	await initializeMessages();
	await initializeCalendar();
	await initializeCollaboration();
	await initializeTechnicalReports();
	await initializePartnerMissions();
	await initializePartnerDialogue();
	await initializeClients();
	await initializeLibrary();
	await createInitialAdministrator();
	await recoverCreatorPassword();
	await recoverCreatorTotp();
	app.listen(port, () => {
		console.log(`Depann'Home Pro écoute sur le port ${port}.`);
		startSubscriptionInvoicingScheduler();
	});
}

start().catch(error => {
	console.error("Impossible de démarrer l’application :", error.message);
	process.exit(1);
});

function requireTechnicalWorkspaceAccess(request, response, next) {
	if (request.user?.role === "accountant") return response.status(403).json({ message: "L’espace comptabilité ne donne pas accès aux ressources techniques." });
	return next();
}
