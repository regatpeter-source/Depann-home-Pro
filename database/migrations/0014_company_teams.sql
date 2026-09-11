CREATE TABLE IF NOT EXISTS depannhome_teams (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    site_label VARCHAR(160) NOT NULL DEFAULT '',
    section VARCHAR(80) NOT NULL DEFAULT '',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS depannhome_teams_owner_name_unique
ON depannhome_teams(owner_id, LOWER(name));
CREATE INDEX IF NOT EXISTS depannhome_teams_owner_active_idx
ON depannhome_teams(owner_id, is_active, LOWER(name));

CREATE TABLE IF NOT EXISTS depannhome_team_memberships (
    team_id BIGINT NOT NULL REFERENCES depannhome_teams(id) ON DELETE CASCADE,
    member_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    membership_role VARCHAR(20) NOT NULL DEFAULT 'member' CHECK(membership_role IN ('member','leader')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(team_id, member_id)
);
CREATE INDEX IF NOT EXISTS depannhome_team_memberships_member_idx
ON depannhome_team_memberships(member_id, team_id);

CREATE OR REPLACE FUNCTION depannhome_validate_team_membership() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM depannhome_teams team
        JOIN depannhome_users member ON member.id=NEW.member_id
        WHERE team.id=NEW.team_id AND team.owner_id=member.account_owner_id
            AND member.role IN ('technician','team_lead')
    ) THEN
        RAISE EXCEPTION 'Le membre et l’équipe doivent appartenir à la même entreprise.' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS depannhome_team_membership_company ON depannhome_team_memberships;
CREATE TRIGGER depannhome_team_membership_company
BEFORE INSERT OR UPDATE ON depannhome_team_memberships
FOR EACH ROW EXECUTE FUNCTION depannhome_validate_team_membership();
