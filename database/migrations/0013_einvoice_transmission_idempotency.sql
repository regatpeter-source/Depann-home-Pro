WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (
        PARTITION BY owner_id, document_id, platform_code
        ORDER BY updated_at DESC, id DESC
    ) AS position
    FROM depannhome_einvoice_transmissions
    WHERE status IN ('queued','sent','accepted')
)
UPDATE depannhome_einvoice_transmissions transmission
SET status='cancelled',
    message=CASE WHEN transmission.message='' THEN 'Ancienne transmission doublon neutralisée pendant la migration.' ELSE transmission.message END,
    updated_at=NOW()
FROM ranked
WHERE transmission.id=ranked.id AND ranked.position>1;

CREATE UNIQUE INDEX IF NOT EXISTS depannhome_einvoice_transmissions_active_document_unique
ON depannhome_einvoice_transmissions(owner_id,document_id,platform_code)
WHERE status IN ('queued','sent','accepted');
