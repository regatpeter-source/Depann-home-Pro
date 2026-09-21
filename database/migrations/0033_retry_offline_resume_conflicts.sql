-- Les anciennes versions mobiles pouvaient appliquer une reprise puis la
-- rejouer avec un nouvel identifiant. Le 409 mémorisé empêcherait sinon la
-- route désormais idempotente de constater que la date cible est déjà active.
DO $$
BEGIN
    IF to_regclass('depannhome_offline_operations') IS NULL THEN RETURN; END IF;

    DELETE FROM depannhome_offline_operations
    WHERE method='POST'
        AND response_status=409
        AND path ~ '^/api/calendar/events/[0-9]+/resume($|[?])';
END $$;