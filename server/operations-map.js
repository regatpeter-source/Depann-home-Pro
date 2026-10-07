import { createHash } from "node:crypto";
import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MOBILE_LOCATION_ROLES = new Set(["mobile_admin", "team_lead", "technician"]);
const TEAM_MAP_ROLES = new Set(["admin", "pc_standard", "commercial", "mobile_admin", "team_lead"]);
const POSITION_RETENTION_HOURS = 12;
const LIVE_POSITION_MINUTES = 2;
const MAX_GEOCODES_PER_REQUEST = 6;
const MAX_ROUTES_PER_REQUEST = 12;
const ROUTE_CACHE_TTL_MS = 10 * 60 * 1000;
let geocodeQueue = Promise.resolve();
let lastGeocodeAt = 0;
let locationCleanupTimer = null;
const routeCache = new Map();

export async function initializeOperationsMap() {
    const database = getPool();
    await database.query(`CREATE TABLE IF NOT EXISTS depannhome_technician_locations (
        owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        user_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        latitude DOUBLE PRECISION NOT NULL CHECK(latitude BETWEEN -90 AND 90),
        longitude DOUBLE PRECISION NOT NULL CHECK(longitude BETWEEN -180 AND 180),
        accuracy_meters DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK(accuracy_meters BETWEEN 0 AND 50000),
        recorded_at TIMESTAMPTZ NOT NULL,
        sharing_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(owner_id,user_id)
    )`);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_technician_locations_updated_idx ON depannhome_technician_locations(owner_id,updated_at DESC)");
    await database.query(`CREATE TABLE IF NOT EXISTS depannhome_map_geocodes (
        owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        address_hash CHAR(64) NOT NULL,
        address VARCHAR(500) NOT NULL,
        latitude DOUBLE PRECISION NOT NULL CHECK(latitude BETWEEN -90 AND 90),
        longitude DOUBLE PRECISION NOT NULL CHECK(longitude BETWEEN -180 AND 180),
        provider VARCHAR(30) NOT NULL DEFAULT 'nominatim',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(owner_id,address_hash)
    )`);
    await deleteExpiredLocations(database);
    if (!locationCleanupTimer) {
        locationCleanupTimer = setInterval(() => deleteExpiredLocations(getPool()).catch(error => console.warn("[operations-map] nettoyage des positions impossible", error.code || error.name || "ERROR")), 60 * 60 * 1000);
        locationCleanupTimer.unref?.();
    }
}

export function registerOperationsMapRoutes(app, requireAuthentication) {
    app.use("/api/operations-map", requireAuthentication);

    app.get("/api/operations-map/day", asyncHandler(async (request, response) => {
        if (!canOpenOperationsMap(request.user)) return response.status(403).json({ message: "La carte terrain n’est pas autorisée pour ce poste." });
        const date = validDate(request.query?.date);
        if (!date) return response.status(400).json({ message: "Date de carte invalide." });
        const ownerId = getAccountOwnerId(request);
        const ownOnly = !canViewTeamLocations(request.user);
        const technicianIds = selectedTechnicianIds(request.query?.technicianIds);
        const targetAddress = cleanAddress(request.query?.address);
        const excludedEventId = positiveId(request.query?.excludeEventId);
        if (request.query?.technicianIds && !technicianIds.length) return response.status(400).json({ message: "Sélection de techniciens invalide." });
        const database = getPool();
        const eventsResult = await database.query(`
            SELECT event.id,event.title,event.client_id AS "clientId",event.client_name AS "clientName",event.location,TO_CHAR(event.event_date,'YYYY-MM-DD') AS date,
                TO_CHAR(event.start_time,'HH24:MI') AS "startTime",TO_CHAR(event.end_time,'HH24:MI') AS "endTime",
                event.event_type AS "eventType",event.event_status AS status,event.assigned_technician_id AS "assignedTechnicianId",event.color,event.notes,
                COALESCE((SELECT json_agg(json_build_object('id',assignment.technician_id,'fullName',COALESCE(member.full_name,member.username,''),'isPrimary',assignment.is_primary) ORDER BY assignment.is_primary DESC,LOWER(COALESCE(member.full_name,member.username,''))) FROM depannhome_calendar_assignments assignment JOIN depannhome_users member ON member.id=assignment.technician_id WHERE assignment.event_id=event.id),'[]'::json) AS "assignedTechnicians"
            FROM depannhome_calendar_events event
            WHERE event.owner_id=$1 AND event.event_date=$2::date AND event.event_type='appointment'
                AND event.event_status NOT IN ('cancelled','paused')
                AND ($3::boolean=FALSE OR event.assigned_technician_id=$4::bigint OR EXISTS(SELECT 1 FROM depannhome_calendar_assignments assignment WHERE assignment.event_id=event.id AND assignment.technician_id=$4::bigint))
                AND (cardinality($5::bigint[])=0 OR event.assigned_technician_id=ANY($5::bigint[]) OR EXISTS(SELECT 1 FROM depannhome_calendar_assignments selected_assignment WHERE selected_assignment.event_id=event.id AND selected_assignment.technician_id=ANY($5::bigint[])))
                AND ($6::bigint IS NULL OR event.id<>$6::bigint)
            ORDER BY event.start_time NULLS LAST,event.created_at,event.id
        `, [ownerId, date, ownOnly, request.user.sub, technicianIds, excludedEventId]);
        const events = eventsResult.rows.map((event, index) => ({ ...event, dayNumber: index + 1 }));
        await attachEventCoordinates(database, ownerId, events);

        const locationsResult = await database.query(`
            SELECT member.id,COALESCE(member.full_name,member.username,'Technicien') AS name,member.role,member.department,
                location.latitude,location.longitude,location.accuracy_meters AS "accuracyMeters",location.recorded_at AS "recordedAt",location.updated_at AS "updatedAt",
                COALESCE(location.updated_at >= NOW() - ($3::text || ' minutes')::interval,FALSE) AS "isLive"
            FROM depannhome_users member
            LEFT JOIN depannhome_technician_locations location ON location.owner_id=$1 AND location.user_id=member.id
                AND location.updated_at >= NOW() - ($5::text || ' hours')::interval
            WHERE member.account_owner_id=$1 AND member.is_active=TRUE AND member.role IN ('mobile_admin','team_lead','technician')
                AND ($2::boolean=FALSE OR member.id=$4::bigint)
                AND (cardinality($6::bigint[])=0 OR member.id=ANY($6::bigint[]))
                AND (cardinality($6::bigint[])>0 OR location.user_id IS NOT NULL)
            ORDER BY LOWER(COALESCE(member.full_name,member.username,''))
        `, [ownerId, ownOnly, String(LIVE_POSITION_MINUTES), request.user.sub, String(POSITION_RETENTION_HOURS), technicianIds]);
        const teamsResult = ownOnly ? { rows: [] } : await database.query(`
            SELECT team.id,team.name,team.site_label AS "siteLabel",team.section,
                COALESCE(json_agg(membership.member_id ORDER BY membership.member_id) FILTER(WHERE membership.member_id IS NOT NULL),'[]'::json) AS "memberIds"
            FROM depannhome_teams team
            LEFT JOIN depannhome_team_memberships membership ON membership.team_id=team.id
            WHERE team.owner_id=$1 AND team.is_active=TRUE
            GROUP BY team.id
            ORDER BY LOWER(team.name)
        `, [ownerId]);
        const target = targetAddress ? { address: targetAddress, location: targetAddress } : null;
        if (target) await attachEventCoordinates(database, ownerId, [target]);
        if (target) await attachTravelTimes(target, locationsResult.rows);
        response.json({ date, teamView: !ownOnly, liveWindowMinutes: LIVE_POSITION_MINUTES, events, technicians: locationsResult.rows, teams: teamsResult.rows, target });
    }));

    app.post("/api/operations-map/location", asyncHandler(async (request, response) => {
        if (!canShareLocation(request.user)) return response.status(403).json({ message: "Le partage de position est réservé aux postes mobiles terrain." });
        if (request.body?.consent !== true) return response.status(400).json({ message: "Le consentement au partage de position est requis." });
        const latitude = finiteCoordinate(request.body?.latitude, -90, 90);
        const longitude = finiteCoordinate(request.body?.longitude, -180, 180);
        const accuracy = finiteCoordinate(request.body?.accuracyMeters ?? 0, 0, 50000);
        const recordedAt = new Date(request.body?.recordedAt || Date.now());
        if (latitude === null || longitude === null || accuracy === null || Number.isNaN(recordedAt.getTime()) || Math.abs(Date.now() - recordedAt.getTime()) > 10 * 60 * 1000) {
            return response.status(400).json({ message: "Position mobile invalide ou trop ancienne." });
        }
        const ownerId = getAccountOwnerId(request);
        await getPool().query(`INSERT INTO depannhome_technician_locations(owner_id,user_id,latitude,longitude,accuracy_meters,recorded_at,sharing_started_at,updated_at)
            VALUES($1,$2,$3,$4,$5,$6,NOW(),NOW())
            ON CONFLICT(owner_id,user_id) DO UPDATE SET latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,accuracy_meters=EXCLUDED.accuracy_meters,recorded_at=EXCLUDED.recorded_at,updated_at=NOW()`,
        [ownerId, request.user.sub, latitude, longitude, accuracy, recordedAt.toISOString()]);
        response.json({ message: "Position terrain actualisée.", recordedAt: recordedAt.toISOString() });
    }));

    app.delete("/api/operations-map/location", asyncHandler(async (request, response) => {
        if (!canShareLocation(request.user)) return response.status(403).json({ message: "Le partage de position est réservé aux postes mobiles terrain." });
        await getPool().query("DELETE FROM depannhome_technician_locations WHERE owner_id=$1 AND user_id=$2", [getAccountOwnerId(request), request.user.sub]);
        response.status(204).end();
    }));
}

export function canViewTeamLocations(user) {
    if (!TEAM_MAP_ROLES.has(user?.role)) return false;
    if (user.role === "admin") return true;
    if (user.role === "pc_standard" || user.role === "commercial") return user.deviceType === "desktop";
    return user.role === "mobile_admin" || user.role === "team_lead";
}

export function canShareLocation(user) {
    return user?.deviceType === "mobile" && MOBILE_LOCATION_ROLES.has(user?.role);
}

export function canOpenOperationsMap(user) {
    return canShareLocation(user) || canViewTeamLocations(user);
}

async function attachEventCoordinates(database, ownerId, events) {
    const addresses = [...new Set(events.map(event => cleanAddress(event.location)).filter(Boolean))];
    if (!addresses.length) return;
    const hashes = addresses.map(addressHash);
    const cached = await database.query("SELECT address_hash AS hash,latitude,longitude FROM depannhome_map_geocodes WHERE owner_id=$1 AND address_hash=ANY($2::char(64)[])", [ownerId, hashes]);
    const coordinates = new Map(cached.rows.map(item => [item.hash.trim(), { latitude: item.latitude, longitude: item.longitude }]));
    const missing = addresses.filter(address => !coordinates.has(addressHash(address))).slice(0, MAX_GEOCODES_PER_REQUEST);
    for (const address of missing) {
        const point = await queueGeocode(address);
        if (!point) continue;
        coordinates.set(addressHash(address), point);
        await database.query(`INSERT INTO depannhome_map_geocodes(owner_id,address_hash,address,latitude,longitude,provider,updated_at) VALUES($1,$2,$3,$4,$5,$6,NOW())
            ON CONFLICT(owner_id,address_hash) DO UPDATE SET address=EXCLUDED.address,latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,provider=EXCLUDED.provider,updated_at=NOW()`, [ownerId, addressHash(address), address, point.latitude, point.longitude, point.provider]);
    }
    for (const event of events) {
        const fromNotes = coordinatesFromNotes(event.notes);
        const point = fromNotes || coordinates.get(addressHash(cleanAddress(event.location)));
        event.latitude = point?.latitude ?? null;
        event.longitude = point?.longitude ?? null;
    }
}

function queueGeocode(address) {
    const task = geocodeQueue.then(async () => {
        const wait = Math.max(0, 1100 - (Date.now() - lastGeocodeAt));
        if (wait) await new Promise(resolve => setTimeout(resolve, wait));
        lastGeocodeAt = Date.now();
        return geocodeAddress(address);
    });
    geocodeQueue = task.catch(() => null);
    return task;
}

async function geocodeAddress(address) {
    const base = String(process.env.GEOCODING_BASE_URL || "https://nominatim.openstreetmap.org").replace(/\/$/, "");
    try {
        const url = `${base}/search?format=jsonv2&limit=1&countrycodes=fr&q=${encodeURIComponent(address)}`;
        const response = await fetch(url, { headers: { "User-Agent": "DepannHomePro/1.0 (support@depannhomepro.com)", Accept: "application/json" }, signal: AbortSignal.timeout(7000) });
        if (response.ok) {
            const result = (await response.json())[0];
            const latitude = finiteCoordinate(result?.lat, -90, 90);
            const longitude = finiteCoordinate(result?.lon, -180, 180);
            if (latitude !== null && longitude !== null) return { latitude, longitude, provider: "nominatim" };
        }
    } catch {}
    const frenchBase = String(process.env.FRENCH_GEOCODING_BASE_URL || "https://data.geopf.fr/geocodage").replace(/\/$/, "");
    try {
        const response = await fetch(`${frenchBase}/search?q=${encodeURIComponent(address)}&limit=1`, { headers: { "User-Agent": "DepannHomePro/1.0 (support@depannhomepro.com)", Accept: "application/json" }, signal: AbortSignal.timeout(7000) });
        if (!response.ok) return null;
        const coordinates = (await response.json())?.features?.[0]?.geometry?.coordinates;
        const longitude = finiteCoordinate(coordinates?.[0], -180, 180);
        const latitude = finiteCoordinate(coordinates?.[1], -90, 90);
        return latitude === null || longitude === null ? null : { latitude, longitude, provider: "geoplateforme" };
    } catch { return null; }
}

async function attachTravelTimes(target, technicians) {
    if (!validCoordinates(target)) return;
    const candidates = technicians.filter(validCoordinates).slice(0, MAX_ROUTES_PER_REQUEST);
    await Promise.all(candidates.map(async technician => {
        const route = await routeEstimate(technician, target);
        if (!route) return;
        technician.routeDistanceMeters = route.distanceMeters;
        technician.travelDurationSeconds = route.durationSeconds;
    }));
}

async function routeEstimate(start, end) {
    const key = [start.longitude, start.latitude, end.longitude, end.latitude].map(value => Number(value).toFixed(4)).join(",");
    const cached = routeCache.get(key);
    if (cached?.expiresAt > Date.now()) return cached.value;
    const base = String(process.env.ROUTING_BASE_URL || "https://data.geopf.fr/navigation").replace(/\/$/, "");
    try {
        const query = new URLSearchParams({ resource: "bdtopo-osrm", start: `${start.longitude},${start.latitude}`, end: `${end.longitude},${end.latitude}`, profile: "car", optimization: "fastest" });
        const response = await fetch(`${base}/itineraire?${query}`, { headers: { "User-Agent": "DepannHomePro/1.0 (support@depannhomepro.com)", Accept: "application/json" }, signal: AbortSignal.timeout(7000) });
        if (!response.ok) return cacheRoute(key, null, 60_000);
        const result = await response.json();
        const distanceMeters = finiteCoordinate(result?.distance, 0, 5_000_000);
        const durationSeconds = finiteCoordinate(result?.duration, 0, 7 * 24 * 60 * 60);
        return cacheRoute(key, distanceMeters === null || durationSeconds === null ? null : { distanceMeters, durationSeconds }, ROUTE_CACHE_TTL_MS);
    } catch { return cacheRoute(key, null, 60_000); }
}

function cacheRoute(key, value, ttl) {
    if (routeCache.size >= 500) routeCache.delete(routeCache.keys().next().value);
    routeCache.set(key, { value, expiresAt: Date.now() + ttl });
    return value;
}

function coordinatesFromNotes(notes) {
    const match = String(notes || "").match(/GPS\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i);
    if (!match) return null;
    const latitude = finiteCoordinate(match[1], -90, 90);
    const longitude = finiteCoordinate(match[2], -180, 180);
    return latitude === null || longitude === null ? null : { latitude, longitude };
}
function validCoordinates(value) { return finiteCoordinate(value?.latitude, -90, 90) !== null && finiteCoordinate(value?.longitude, -180, 180) !== null; }
function finiteCoordinate(value, minimum, maximum) { if (value === null || value === undefined || value === "") return null; const number = Number(value); return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null; }
function validDate(value) { const date = String(value || ""); return DATE_PATTERN.test(date) ? date : ""; }
function positiveId(value) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : null; }
function selectedTechnicianIds(value) { const values = String(value || "").split(",").filter(Boolean); const ids = values.map(positiveId); return ids.some(id => !id) ? [] : [...new Set(ids)].slice(0, 50); }
function cleanAddress(value) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 500); }
function addressHash(value) { return createHash("sha256").update(String(value || "").toLowerCase()).digest("hex"); }
function deleteExpiredLocations(database) { return database.query("DELETE FROM depannhome_technician_locations WHERE updated_at < NOW() - ($1::text || ' hours')::interval", [String(POSITION_RETENTION_HOURS)]); }
function asyncHandler(handler) { return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next); }
