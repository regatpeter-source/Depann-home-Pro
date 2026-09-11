DO $$
BEGIN
    IF to_regclass('public.depannhome_subscription_billing_profile') IS NOT NULL THEN
        ALTER TABLE depannhome_subscription_billing_profile
            ADD COLUMN IF NOT EXISTS invoice_due_days INTEGER NOT NULL DEFAULT 30;
        ALTER TABLE depannhome_subscription_billing_profile
            DROP CONSTRAINT IF EXISTS depannhome_subscription_billing_profile_invoice_due_days_check;
        ALTER TABLE depannhome_subscription_billing_profile
            ADD CONSTRAINT depannhome_subscription_billing_profile_invoice_due_days_check
            CHECK (invoice_due_days BETWEEN 0 AND 365);
    END IF;
END $$;
