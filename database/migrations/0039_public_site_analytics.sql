-- Mesure d'audience interne strictement agrégée : aucun identifiant visiteur,
-- cookie, adresse IP, user-agent ou référent n'est conservé.
CREATE TABLE IF NOT EXISTS depannhome_public_analytics_daily (
    metric_date DATE NOT NULL DEFAULT CURRENT_DATE,
    page_path VARCHAR(120) NOT NULL,
    event_type VARCHAR(20) NOT NULL CHECK(event_type IN ('page_view','click')),
    event_target VARCHAR(60) NOT NULL DEFAULT '',
    event_count INTEGER NOT NULL DEFAULT 0 CHECK(event_count >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(metric_date,page_path,event_type,event_target)
);

CREATE INDEX IF NOT EXISTS depannhome_public_analytics_daily_date_idx
    ON depannhome_public_analytics_daily(metric_date DESC);

-- La conservation glissante maximale est de 25 mois.
DELETE FROM depannhome_public_analytics_daily
WHERE metric_date < CURRENT_DATE - INTERVAL '25 months';
