import pg from "pg";
import { postgresConnection } from "./database-backup.js";

const USER_OBJECTS_QUERY = `
    WITH user_namespaces AS (
        SELECT oid, nspname FROM pg_namespace
        WHERE nspname <> 'information_schema' AND nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
    )
    SELECT EXISTS (
        SELECT 1 FROM user_namespaces WHERE nspname <> 'public'
        UNION ALL
        SELECT 1 FROM pg_class item JOIN user_namespaces namespace ON namespace.oid=item.relnamespace
            WHERE item.relkind IN ('r','p','v','m','S','f')
        UNION ALL
        SELECT 1 FROM pg_proc item JOIN user_namespaces namespace ON namespace.oid=item.pronamespace
        UNION ALL
        SELECT 1 FROM pg_type item JOIN user_namespaces namespace ON namespace.oid=item.typnamespace
            WHERE item.typtype IN ('c','d','e','r','m')
        UNION ALL
        SELECT 1 FROM pg_collation item JOIN user_namespaces namespace ON namespace.oid=item.collnamespace
        UNION ALL
        SELECT 1 FROM pg_conversion item JOIN user_namespaces namespace ON namespace.oid=item.connamespace
        UNION ALL
        SELECT 1 FROM pg_operator item JOIN user_namespaces namespace ON namespace.oid=item.oprnamespace
        UNION ALL
        SELECT 1 FROM pg_opclass item JOIN user_namespaces namespace ON namespace.oid=item.opcnamespace
        UNION ALL
        SELECT 1 FROM pg_opfamily item JOIN user_namespaces namespace ON namespace.oid=item.opfnamespace
        UNION ALL
        SELECT 1 FROM pg_ts_config item JOIN user_namespaces namespace ON namespace.oid=item.cfgnamespace
        UNION ALL
        SELECT 1 FROM pg_ts_dict item JOIN user_namespaces namespace ON namespace.oid=item.dictnamespace
        UNION ALL
        SELECT 1 FROM pg_ts_parser item JOIN user_namespaces namespace ON namespace.oid=item.prsnamespace
        UNION ALL
        SELECT 1 FROM pg_ts_template item JOIN user_namespaces namespace ON namespace.oid=item.tmplnamespace
        UNION ALL
        SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql'
        UNION ALL
        SELECT 1 FROM pg_event_trigger
    ) AS occupied
`;

function preflightConfiguration(databaseUrl) {
    const url = new URL(databaseUrl);
    const connection = postgresConnection(databaseUrl);
    if (!url.hostname || !url.username || !url.pathname.slice(1)) throw new Error("Les URL PostgreSQL doivent préciser le serveur, l’utilisateur et la base.");
    if ([...url.searchParams.keys()].some(key => key !== "sslmode")) throw new Error("Pour la restauration, les URL PostgreSQL ne peuvent utiliser que le paramètre sslmode.");
    const sslmode = connection.env.PGSSLMODE;
    if (!["disable", "prefer", "require", "verify-ca", "verify-full"].includes(sslmode)) throw new Error("Mode SSL PostgreSQL non pris en charge pour le contrôle de restauration.");
    url.search = "";
    url.searchParams.set("sslmode", sslmode);
    url.searchParams.set("uselibpqcompat", "true");
    for (const [parameter, variable] of [["sslrootcert", "PGSSLROOTCERT"], ["sslcert", "PGSSLCERT"], ["sslkey", "PGSSLKEY"]]) {
        if (connection.env[variable]) url.searchParams.set(parameter, connection.env[variable]);
    }
    return { config: { connectionString: url.toString(), connectionTimeoutMillis: 10000 }, sslmode };
}

async function connectForPreflight(settings, role, createClient) {
    let client = createClient(settings.config, role);
    try {
        await client.connect();
        return client;
    } catch (error) {
        await client.end();
        if (settings.sslmode !== "prefer" || error.message !== "The server does not support SSL connections") throw error;
    }
    const url = new URL(settings.config.connectionString);
    url.searchParams.set("sslmode", "disable");
    client = createClient({ ...settings.config, connectionString: url.toString() }, role);
    try {
        await client.connect();
        return client;
    } catch (error) {
        await client.end();
        throw error;
    }
}

export async function assertSafeRestoreTarget({ sourceUrl, targetUrl, createClient = config => new pg.Client(config) }) {
    if (!sourceUrl) throw new Error("DATABASE_URL est obligatoire pour vérifier la base source.");
    if (!targetUrl) throw new Error("RESTORE_DATABASE_URL est obligatoire et doit désigner explicitement la base cible.");
    const sourceConfig = preflightConfiguration(sourceUrl);
    const targetConfig = preflightConfiguration(targetUrl);
    let source;
    let target;
    try {
        source = await connectForPreflight(sourceConfig, "source", createClient);
        const sourceName = (await source.query("SELECT current_database() AS name")).rows[0]?.name;
        target = await connectForPreflight(targetConfig, "target", createClient);
        const targetName = (await target.query("SELECT current_database() AS name")).rows[0]?.name;
        if (!sourceName || !targetName) throw new Error("Impossible de vérifier l’identité des bases PostgreSQL.");
        if (sourceName === targetName) throw new Error("La source et la cible portent le même nom de base PostgreSQL. Utilisez une base cible distincte avec un autre nom.");
        const occupied = (await target.query(USER_OBJECTS_QUERY)).rows[0]?.occupied;
        if (occupied !== false) throw new Error("La base cible n’est pas vide ou son contenu n’a pas pu être vérifié.");
    } finally {
        await Promise.all([...(target ? [target.end()] : []), ...(source ? [source.end()] : [])]);
    }
}
