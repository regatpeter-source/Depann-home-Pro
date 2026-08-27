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
import { createHealthRequestMonitor, initializeHealthDashboard, recordHealthError, registerHealthDashboardRoutes, startHealthMonitoring } from "./server/health-dashboard.js";
import { initializeOrganizations, requireOrganizationFeature } from "./server/organizations.js";
import { registerCreatorRoutes } from "./server/creator.js";
import { billingUploadErrorHandler, initializeBilling, registerBillingRoutes } from "./server/billing.js";
import { documentTemplateUploadErrorHandler, initializeDocumentTemplates, registerDocumentTemplateRoutes } from "./server/document-templates.js";
import { initializeSubscriptionInvoicing, registerSubscriptionInvoicingRoutes, startSubscriptionInvoicingScheduler } from "./server/invoicing.js";
import { initializeAccounting, registerAccountingRoutes } from "./server/accounting.js";
import { initializeElectronicInvoicing, registerElectronicInvoicingRoutes } from "./server/electronic-invoicing.js";
import "./server/einvoice-providers/super-pdp.js";
import { initializeConnectors, registerConnectorRoutes } from "./server/connectors.js";
import { initializePurchases, registerPurchaseRoutes } from "./server/purchases.js";
import { initializeMessages, registerMessageRoutes } from "./server/messages.js";
import { initializeCalendar, registerCalendarRoutes } from "./server/calendar.js";
import { clientUploadErrorHandler, initializeClients, registerClientRoutes } from "./server/clients.js";
import { initializeTechnicalReports, registerTechnicalReportRoutes, technicalReportUploadErrorHandler } from "./server/technical-reports.js";
import { initializeCollaboration, registerCollaborationRoutes } from "./server/collaboration.js";
import { initializePartnerMissions, registerPartnerMissionRoutes } from "./server/partner-missions.js";
import { initializePartnerEmail, registerPartnerEmailRoutes, startPartnerEmailScheduler } from "./server/partner-email.js";
import { initializePartnerDialogue, partnerDialogueUploadErrorHandler, registerPartnerDialogueRoutes } from "./server/partner-dialogue.js";
import { initializePartnerConnections, registerPartnerConnectionRoutes } from "./server/partner-connections.js";
import { initializePartnerRequests, registerPartnerRequestRoutes } from "./server/partner-requests.js";
import { initializePartnerSandbox, registerPartnerSandboxRoutes } from "./server/partner-sandbox.js";
import { initializePartnerApiSandbox, registerPartnerApiSandboxRoutes } from "./server/partner-api-sandbox.js";
import { initializeGroups, registerGroupRoutes } from "./server/groups.js";
import { initializeSupport, registerSupportRoutes } from "./server/support.js";
import { registerPublicOfferRoutes } from "./server/public-offers.js";
import { dataImportUploadErrorHandler, initializeDataImports, registerDataImportRoutes } from "./server/data-imports.js";
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
app.use(createHealthRequestMonitor());

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
app.use("/api/auth/verify-company-totp", authenticationRateLimit);
app.use("/api/auth/company-2fa/enrollment", authenticationRateLimit);
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
app.use("/api/partner-sandbox/external-callback", rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 120,
	standardHeaders: "draft-7",
	legacyHeaders: false,
	message: { message: "Trop de callbacks Sandbox. Réessayez dans quelques minutes." }
}));
app.use("/api/partner-dialogue/external", rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 120,
	standardHeaders: "draft-7",
	legacyHeaders: false,
	message: { message: "Trop de requêtes partenaire. Réessayez dans quelques minutes." }
}));
app.use("/api/e-invoicing/webhooks", rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 600,
	standardHeaders: "draft-7",
	legacyHeaders: false,
	message: { message: "Trop de notifications de facturation électronique." }
}));
app.use("/api/partner-requests", rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 8,
	standardHeaders: "draft-7",
	legacyHeaders: false,
	message: { message: "Trop de demandes ont été envoyées. Réessayez dans quelques minutes." }
}));
app.use("/api/public/offer-requests", rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 5,
	standardHeaders: "draft-7",
	legacyHeaders: false,
	message: { message: "Trop de demandes ont été envoyées. Réessayez dans quelques minutes." }
}));
const requireAccountingFeature = requireOrganizationFeature("accounting");
app.use("/api/accounting", (request, response, next) => {
	if (isElectronicInvoicingOAuthCallback(request)) return next();
	return requireAuthentication(request, response, next);
}, (request, response, next) => {
	if (isElectronicInvoicingOAuthCallback(request)) return next();
	return requireAccountingFeature(request, response, next);
});
app.use("/api/library", requireAuthentication, requireOrganizationFeature("library"));
app.use("/api/technical-reports", requireAuthentication, requireOrganizationFeature("technicalReports"));
app.use("/api/partner-missions", requireAuthentication, requireOrganizationFeature("partnerMissions"));
const requirePartnerEmailFeature = requireOrganizationFeature("companyEmail");
app.use("/api/partner-email", (request, response, next) => {
	if (isPartnerEmailOAuthCallback(request)) return next();
	return requireAuthentication(request, response, next);
}, (request, response, next) => {
	if (isPartnerEmailOAuthCallback(request)) return next();
	return requirePartnerEmailFeature(request, response, next);
});
app.post("/api/partner-email/:connectionId/messages/:messageRef/reply", rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 20,
	standardHeaders: "draft-7",
	legacyHeaders: false,
	message: { message: "Trop de réponses ont été envoyées. Réessayez dans quelques minutes." }
}));
app.use(["/api/partner-email/:connectionId/inbox", "/api/partner-email/:connectionId/messages"], rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 300,
	standardHeaders: "draft-7",
	legacyHeaders: false,
	message: { message: "Trop de consultations de la boîte mail. Réessayez dans quelques minutes." }
}));
app.use("/api/clients", requireAuthentication, requireOrganizationFeature("clients"));
const requireCalendarFeature = requireOrganizationFeature("calendar");
const requireClientFeature = requireOrganizationFeature("clients");
app.use("/api/calendar/events/:eventId/quitus", requireAuthentication, requireOrganizationFeature("quitus"));
app.use("/api/calendar", requireAuthentication, (request, response, next) => (request.path.startsWith("/client-history/") ? requireClientFeature : requireCalendarFeature)(request, response, next));
app.use("/api/billing/document-templates/quitus", requireAuthentication, requireOrganizationFeature("quitus"));
app.use("/api/document-templates/quitus", requireAuthentication, requireOrganizationFeature("quitus"));
app.use("/api/billing/document-templates/report", requireAuthentication, requireOrganizationFeature("technicalReports"));
app.use("/api/document-templates/report", requireAuthentication, requireOrganizationFeature("technicalReports"));
app.use("/api/billing", requireAuthentication, requireOrganizationFeature("billing"));
app.use("/api/document-templates", requireAuthentication, requireOrganizationFeature("billing"));
app.use("/api/purchases", requireAuthentication, requireOrganizationFeature("purchases"));
app.use("/api/messages", requireAuthentication, requireOrganizationFeature("messages"));
app.use("/api/partner-connections", requireAuthentication, requireOrganizationFeature("partnerConnections"));
app.use("/api/partner-dialogue", requireAuthentication, requireOrganizationFeature("partnerMissions"));
app.use("/api/official-partners", requireAuthentication, requireOrganizationFeature("connectors"));
app.use("/api/partner-missions/intakes", requireAuthentication, requireOrganizationFeature("connectors"));
const requirePartnerSandboxFeature = requireOrganizationFeature("connectors");
app.use("/api/partner-sandbox", requireAuthentication, (request, response, next) => {
	if (request.method === "GET" && request.path === "/") return next();
	return requirePartnerSandboxFeature(request, response, next);
});
app.use("/api/connectors", requireAuthentication, requireOrganizationFeature("connectors"));
app.use("/api/data-imports", requireAuthentication, requireOrganizationFeature("imports"));
const requireGroupsFeature = requireOrganizationFeature("groups");
app.use("/api/groups", requireAuthentication, (request, response, next) => {
	if (["/context", "/active-company"].includes(request.path)) return next();
	return requireGroupsFeature(request, response, next);
});
registerAuthRoutes(app);
registerHealthDashboardRoutes(app, requireCreator);
registerCreatorRoutes(app, requireCreator, requireAuthentication);
registerPartnerRequestRoutes(app, requireCreator, requireAuthentication);
registerSubscriptionInvoicingRoutes(app, requireCreator);
registerAccountingRoutes(app, requireAuthentication);
registerElectronicInvoicingRoutes(app, requireAuthentication);
registerConnectorRoutes(app, requireAuthentication, requireCreator);
registerPartnerMissionRoutes(app, requireAuthentication);
registerPartnerEmailRoutes(app, requireAuthentication);
registerPartnerDialogueRoutes(app, requireAuthentication);
registerPartnerConnectionRoutes(app, requireAuthentication);
registerPartnerApiSandboxRoutes(app, requireCreator, requireAuthentication);
registerPartnerSandboxRoutes(app, requireAuthentication);
registerGroupRoutes(app, requireAuthentication);
registerBillingRoutes(app, requireAuthentication);
registerDocumentTemplateRoutes(app, requireAuthentication);
registerPurchaseRoutes(app, requireAuthentication);
registerMessageRoutes(app, requireAuthentication);
registerCalendarRoutes(app, requireAuthentication);
registerCollaborationRoutes(app, requireAuthentication);
registerTechnicalReportRoutes(app, requireAuthentication);
registerClientRoutes(app, requireAuthentication);
registerDataImportRoutes(app, requireAuthentication);
registerLibraryRoutes(app, requireAuthentication);
registerSupportRoutes(app, requireAuthentication);
registerPublicOfferRoutes(app);

// Seul le logo est nécessaire avant connexion. Le catalogue et les notices sont servis
// uniquement après validation du cookie de session HTTP-only.
app.get("/assets/logo.png.png", (request, response) => {
	response.sendFile(path.join(rootDirectory, "assets", "logo.png.png"));
});
app.use("/site-assets", express.static(path.join(rootDirectory, "public"), { index: false, maxAge: "1d" }));
app.get(["/confidentialite", "/politique-de-confidentialite", "/privacy"], (request, response) => {
	response.sendFile(path.join(rootDirectory, "public", "privacy.html"), { headers: { "Cache-Control": "public, max-age=3600" } });
});
app.get(["/conditions-utilisation", "/conditions-d-utilisation", "/terms"], (request, response) => {
	response.sendFile(path.join(rootDirectory, "public", "terms.html"), { headers: { "Cache-Control": "public, max-age=3600" } });
});
app.get("/robots.txt", (request, response) => response.sendFile(path.join(rootDirectory, "public", "robots.txt")));
app.get("/sitemap.xml", (request, response) => response.sendFile(path.join(rootDirectory, "public", "sitemap.xml")));
app.use("/data", requireAuthentication, requireTechnicalWorkspaceAccess, express.static(path.join(rootDirectory, "data"), { index: false }));
app.use("/assets", requireAuthentication, requireTechnicalWorkspaceAccess, express.static(path.join(rootDirectory, "assets"), { index: false }));

app.get(["/connexion", "/app", "/index.html"], (request, response) => {
	response.sendFile(path.join(rootDirectory, "index.html"), { headers: { "Cache-Control": "no-store" } });
});
app.get("/", (request, response) => {
	const page = request.user ? "index.html" : path.join("public", "landing.html");
	response.sendFile(path.join(rootDirectory, page), { headers: { "Cache-Control": "no-store" } });
});
app.use("/css", express.static(path.join(rootDirectory, "css"), { index: false }));
app.use("/js", express.static(path.join(rootDirectory, "js"), { index: false }));
app.use("/vendor/pdfjs", express.static(path.join(rootDirectory, "node_modules", "pdfjs-dist"), { index: false, immutable: true, maxAge: "1y" }));
app.get("/manifest.json", (request, response) => {
	response.sendFile(path.join(rootDirectory, "manifest.json"));
});
app.get("/service-worker.js", (request, response) => {
	response.sendFile(path.join(rootDirectory, "service-worker.js"), { headers: { "Cache-Control": "no-cache" } });
});

app.use(billingUploadErrorHandler);
app.use(documentTemplateUploadErrorHandler);
app.use(clientUploadErrorHandler);
app.use(technicalReportUploadErrorHandler);
app.use(dataImportUploadErrorHandler);
app.use(libraryUploadErrorHandler);
app.use(partnerDialogueUploadErrorHandler);
app.use((error, request, response, next) => {
	console.error(error);
	void recordHealthError(error, request).catch(healthError => console.warn("[health] error observation unavailable", healthError.code || healthError.name || "ERROR"));
	if (response.headersSent) return next(error);
	const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
	return response.status(status).json({ message: status === 500 ? "Erreur interne du serveur." : String(error.message || "Requête invalide.") });
});

async function start() {
	validateAuthenticationConfiguration();
	await initializeDatabase();
	await initializeOrganizations();
	await initializeGroups();
	await initializeBilling();
	await initializeDocumentTemplates();
	await initializeAccounting();
	await initializeElectronicInvoicing();
	await initializeConnectors();
	await initializeSubscriptionInvoicing();
	await initializePurchases();
	await initializeMessages();
	await initializeCalendar();
	await initializeCollaboration();
	await initializeTechnicalReports();
	await initializePartnerMissions();
	await initializePartnerEmail();
	await initializePartnerDialogue();
	await initializePartnerConnections();
	await initializePartnerSandbox();
	await initializePartnerApiSandbox();
	await initializePartnerRequests();
	await initializeSupport();
	await initializeClients();
	await initializeDataImports();
	await initializeLibrary();
	await initializeHealthDashboard();
	await createInitialAdministrator();
	await recoverCreatorPassword();
	await recoverCreatorTotp();
	app.listen(port, () => {
		console.log(`Depann'Home Pro écoute sur le port ${port}.`);
		startSubscriptionInvoicingScheduler();
		startPartnerEmailScheduler();
		startHealthMonitoring();
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

function isPartnerEmailOAuthCallback(request) {
	return request.method === "GET" && /^\/oauth\/(?:google|microsoft)\/callback$/.test(request.path);
}

function isElectronicInvoicingOAuthCallback(request) {
	return request.method === "GET" && String(request.originalUrl || "").split("?", 1)[0] === "/api/accounting/e-invoicing/oauth/callback";
}
