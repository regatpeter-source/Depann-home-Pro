UPDATE depannhome_users owner
SET subscription_label=CASE owner.subscription_tier
        WHEN 'basic' THEN 'Basic Groupe — abonnement global facturé à l’entreprise principale'
        WHEN 'basic_plus' THEN 'Basic+ Groupe — abonnement global facturé à l’entreprise principale'
        ELSE 'Pro Groupe — abonnement global facturé à l’entreprise principale'
    END,
    updated_at=NOW()
FROM depannhome_group_entitlements entitlement
WHERE owner.id=entitlement.principal_company_owner_id
    AND owner.subscription_label IS DISTINCT FROM CASE owner.subscription_tier
        WHEN 'basic' THEN 'Basic Groupe — abonnement global facturé à l’entreprise principale'
        WHEN 'basic_plus' THEN 'Basic+ Groupe — abonnement global facturé à l’entreprise principale'
        ELSE 'Pro Groupe — abonnement global facturé à l’entreprise principale'
    END;
