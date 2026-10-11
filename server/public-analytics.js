import { getPool } from "./database.js";

const EVENT_TYPES = new Set(["page_view", "click"]);
const PUBLIC_PAGES = new Set([
    "/",
    "/confidentialite",
    "/conditions-utilisation",
    "/mentions-legales",
    "/logiciel-entreprise-depannage",
    "/logiciel-planning-interventions",
    "/logiciel-devis-factures-artisans",
    "/logiciel-gestion-plombier",
    "/logiciel-maintenance-sav",
    "/logiciel-gestion-interventions-terrain",
    "/application-mobile-techniciens",
    "/logiciel-facturation-electronique-artisans"
]);
const CLICK_TARGETS = new Set([
    "demo_request",
    "offer_request",
    "login",
    "support_email",
    "pricing",
    "features",
    "security",
    "faq",
    "solution_business",
    "solution_planning",
    "solution_invoicing",
    "legal_privacy",
    "legal_terms",
    "legal_notices"
]);
const PERIODS = new Set([7, 30, 90, 365]);

export function registerPublicAnalyticsRoutes(app, requireCreator) {
    app.post("/api/public/analytics/events", asyncHandler(async (request, response) => {
        const event = sanitizePublicAnalyticsEvent(request.body);
        if (!event) return response.status(400).json({ message: "Événement de vitrine invalide." });
        await getPool().query(`WITH purged AS (
            DELETE FROM depannhome_public_analytics_daily WHERE metric_date<CURRENT_DATE-INTERVAL '25 months'
        ) INSERT INTO depannhome_public_analytics_daily(metric_date,page_path,event_type,event_target,event_count)
            VALUES(CURRENT_DATE,$1,$2,$3,1)
            ON CONFLICT(metric_date,page_path,event_type,event_target)
            DO UPDATE SET event_count=depannhome_public_analytics_daily.event_count+1,updated_at=NOW()`, [event.page, event.type, event.target]);
        response.status(204).end();
    }));

    app.get("/api/creator/public-analytics", requireCreator, asyncHandler(async (request, response) => {
        response.set("Cache-Control", "no-store");
        const days = PERIODS.has(Number(request.query.days)) ? Number(request.query.days) : 30;
        const database = getPool();
        const [summary, daily, pages, actions] = await Promise.all([
            database.query(`SELECT
                COALESCE(SUM(event_count) FILTER(WHERE event_type='page_view'),0)::integer AS "pageViews",
                COALESCE(SUM(event_count) FILTER(WHERE event_type='click'),0)::integer AS clicks,
                COALESCE(SUM(event_count) FILTER(WHERE event_type='page_view' AND metric_date=CURRENT_DATE),0)::integer AS "todayViews",
                COALESCE(SUM(event_count) FILTER(WHERE event_type='click' AND event_target IN ('demo_request','offer_request')),0)::integer AS "intentClicks"
                FROM depannhome_public_analytics_daily WHERE metric_date>=CURRENT_DATE-($1::integer-1)`, [days]),
            database.query(`SELECT TO_CHAR(metric_date,'YYYY-MM-DD') AS date,
                COALESCE(SUM(event_count) FILTER(WHERE event_type='page_view'),0)::integer AS views,
                COALESCE(SUM(event_count) FILTER(WHERE event_type='click'),0)::integer AS clicks
                FROM depannhome_public_analytics_daily WHERE metric_date>=CURRENT_DATE-($1::integer-1)
                GROUP BY metric_date ORDER BY metric_date`, [days]),
            database.query(`SELECT page_path AS page,SUM(event_count)::integer AS count
                FROM depannhome_public_analytics_daily WHERE metric_date>=CURRENT_DATE-($1::integer-1) AND event_type='page_view'
                GROUP BY page_path ORDER BY count DESC,page_path LIMIT 20`, [days]),
            database.query(`SELECT event_target AS target,SUM(event_count)::integer AS count
                FROM depannhome_public_analytics_daily WHERE metric_date>=CURRENT_DATE-($1::integer-1) AND event_type='click'
                GROUP BY event_target ORDER BY count DESC,event_target LIMIT 20`, [days])
        ]);
        response.json({ days, summary: summary.rows[0], daily: daily.rows, pages: pages.rows, actions: actions.rows });
    }));
}

export function sanitizePublicAnalyticsEvent(value) {
    const type = EVENT_TYPES.has(value?.type) ? value.type : "";
    const page = normalizePublicPage(value?.page);
    const target = type === "click" && CLICK_TARGETS.has(value?.target) ? value.target : type === "page_view" ? "" : null;
    return type && page && target !== null ? { type, page, target } : null;
}

function normalizePublicPage(value) {
    let pathname;
    try { pathname = new URL(String(value || ""), "https://depannhomepro.com").pathname; }
    catch { return ""; }
    pathname = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
    return PUBLIC_PAGES.has(pathname) ? pathname : "";
}

function asyncHandler(handler) {
    return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}
