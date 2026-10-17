-- Leads module (MVP_SPEC §M4, §6.2).
--
-- One table, plus the rules that make a conversion permanent. The stance is
-- the one 0007 and 0008 set: anything whose violation would leave a
-- permanently wrong row is enforced here as well as in the service, because an
-- import, a seed or a future code path must not be able to write a row the
-- service would have refused.
--
-- Four rules, in order of how badly each one hurts if it is missing:
--   1. the conversion links point inside this tenant (composite foreign keys)
--   2. `status = 'converted'` and `converted_at` agree, and conversion links
--      only exist on a converted lead
--   3. a conversion is never undone or rewritten (ADR-0022)
--   4. duplicate detection has indexes to work from, including pg_trgm for
--      fuzzy company names (ADR-0023)
--
-- The table is created empty, so none of the index builds below takes a long
-- lock. Any later index on leads, once tenants hold real data, has to be built
-- outside a transaction (the runner wraps each file in one).

CREATE TABLE leads (
  id                     uuid PRIMARY KEY,
  tenant_id              uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  owner_id               uuid REFERENCES users (id) ON DELETE SET NULL,
  first_name             text,
  -- NOT NULL for the reason it is on contacts: a lead becomes a contact, and a
  -- conversion that had to invent a surname would be worse than refusing the
  -- lead in the first place.
  last_name              text NOT NULL,
  company                text,
  email                  citext,
  phone                  text,
  source                 text,
  status                 text NOT NULL DEFAULT 'new',
  converted_at           timestamptz,
  converted_contact_id   uuid,
  converted_account_id   uuid,
  converted_deal_id      uuid,
  custom_fields          jsonb NOT NULL DEFAULT '{}'::jsonb,
  version                integer NOT NULL DEFAULT 1,
  deleted_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_by             uuid,

  CONSTRAINT leads_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT leads_version_chk CHECK (version > 0),
  CONSTRAINT leads_last_name_chk CHECK (length(btrim(last_name)) > 0),
  CONSTRAINT leads_company_chk CHECK (company IS NULL OR length(btrim(company)) > 0),
  -- E.164 at the column, not only in Zod, matching contacts.
  CONSTRAINT leads_phone_chk CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{1,14}$'),
  CONSTRAINT leads_status_chk CHECK (
    status IN ('new', 'contacted', 'qualified', 'unqualified', 'converted')
  ),

  -- 2. The converted state is one fact told two ways; they must agree. Without
  --    this a lead could read "converted" with nothing to show for it, or carry
  --    conversion links while still sitting in the open list.
  CONSTRAINT leads_converted_state_chk CHECK (
    (status = 'converted') = (converted_at IS NOT NULL)
  ),
  CONSTRAINT leads_converted_links_chk CHECK (
    converted_at IS NOT NULL
    OR (converted_contact_id IS NULL
        AND converted_account_id IS NULL
        AND converted_deal_id IS NULL)
  ),

  -- 1. Every conversion link stays inside this tenant. The column list on
  --    SET NULL is required: without it Postgres would try to null tenant_id
  --    too, which is NOT NULL.
  CONSTRAINT leads_converted_contact_same_tenant_fkey
    FOREIGN KEY (tenant_id, converted_contact_id) REFERENCES contacts (tenant_id, id)
    ON DELETE SET NULL (converted_contact_id),
  CONSTRAINT leads_converted_account_same_tenant_fkey
    FOREIGN KEY (tenant_id, converted_account_id) REFERENCES accounts (tenant_id, id)
    ON DELETE SET NULL (converted_account_id),
  CONSTRAINT leads_converted_deal_same_tenant_fkey
    FOREIGN KEY (tenant_id, converted_deal_id) REFERENCES deals (tenant_id, id)
    ON DELETE SET NULL (converted_deal_id)
);

-- Keyset default order (ADR-0012), live rows only.
CREATE INDEX leads_tenant_created_idx
  ON leads (tenant_id, created_at, id) WHERE deleted_at IS NULL;
CREATE INDEX leads_tenant_owner_idx ON leads (tenant_id, owner_id);
-- The working list is "the open leads, by status".
CREATE INDEX leads_tenant_status_created_idx
  ON leads (tenant_id, status, created_at, id) WHERE deleted_at IS NULL;
CREATE INDEX leads_tenant_last_name_idx
  ON leads (tenant_id, last_name, id) WHERE deleted_at IS NULL;
CREATE INDEX leads_custom_fields_idx ON leads USING gin (custom_fields);
-- "Which lead did this contact come from?", for the converted contact's page.
CREATE INDEX leads_tenant_converted_contact_idx
  ON leads (tenant_id, converted_contact_id) WHERE converted_contact_id IS NOT NULL;

-- 4. Duplicate detection (MVP_SPEC M4, ADR-0023).
--
-- Exact on email and phone; fuzzy on the company name through pg_trgm, which
-- is what makes "Rajesh Gold House" find "Rajesh Gold House Pvt Ltd". The
-- equality indexes are partial on live rows, because a match must never offer
-- a record that is sitting in the Recycle Bin.
CREATE INDEX leads_tenant_email_idx
  ON leads (tenant_id, email) WHERE deleted_at IS NULL;
CREATE INDEX leads_tenant_phone_idx
  ON leads (tenant_id, phone) WHERE deleted_at IS NULL;
CREATE INDEX leads_company_trgm_idx ON leads USING gin (company gin_trgm_ops);
-- Accounts carry one already (0002); contacts gain one here, so a person can
-- be matched by a near-miss on their name as well as by an exact email.
CREATE INDEX contacts_last_name_trgm_idx ON contacts USING gin (last_name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 3. A conversion is permanent (ADR-0022).
--
-- "Keeps the history" in the spec is a promise about the data, not about one
-- code path. Once a lead has been converted, its state and its three links are
-- frozen: the service refuses to touch a converted lead, and this refuses it
-- for everything else — an import, a seed, a bulk update, a future automation.
-- Without it a second conversion would silently re-point the lead at new
-- records and orphan the ones it actually became, leaving no trace of which
-- contact a customer originally came from.
--
-- A link a hard delete has set to NULL is allowed to stay NULL: the foreign
-- keys above may null a column, and refusing that would make deleting an
-- account fail instead of orphaning the link.
-- ---------------------------------------------------------------------------
CREATE FUNCTION leads_assert_conversion_final() RETURNS trigger
  LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.converted_at IS DISTINCT FROM OLD.converted_at
     OR NEW.status <> 'converted'
     OR (NEW.converted_contact_id IS DISTINCT FROM OLD.converted_contact_id
         AND NEW.converted_contact_id IS NOT NULL)
     OR (NEW.converted_account_id IS DISTINCT FROM OLD.converted_account_id
         AND NEW.converted_account_id IS NOT NULL)
     OR (NEW.converted_deal_id IS DISTINCT FROM OLD.converted_deal_id
         AND NEW.converted_deal_id IS NOT NULL)
  THEN
    RAISE EXCEPTION 'Lead % has already been converted; its conversion cannot be changed', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'leads_conversion_final';
  END IF;

  RETURN NEW;
END
$fn$;

-- Only when something the rule reads changes, so renaming a converted lead's
-- owner or editing a custom field does not pay for the check.
CREATE TRIGGER leads_conversion_final
  BEFORE UPDATE OF status, converted_at, converted_contact_id, converted_account_id,
                   converted_deal_id ON leads
  FOR EACH ROW
  WHEN (OLD.converted_at IS NOT NULL)
  EXECUTE FUNCTION leads_assert_conversion_final();

-- Granted explicitly rather than relying on the PUBLIC default, matching how
-- current_tenant_id() is granted in 0004.
GRANT EXECUTE ON FUNCTION leads_assert_conversion_final() TO crm_app, crm_worker;

-- ---------------------------------------------------------------------------
-- Row-Level Security and grants (0004).
-- ---------------------------------------------------------------------------
CALL apply_tenant_rls('leads');

GRANT SELECT, INSERT, UPDATE, DELETE ON leads TO crm_app, crm_worker;
