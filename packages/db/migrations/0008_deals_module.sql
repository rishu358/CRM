-- Deals module (MVP_SPEC §M5, §6.2).
--
-- Five tables: pipelines, pipeline_stages, deals, deal_contacts, exchange_rates.
--
-- The same stance as 0007: every rule the service enforces and whose violation
-- would leave a permanently wrong row is also enforced here, because an import,
-- a seed or a future code path must not be able to write a row the service
-- would have refused. Four rules matter most:
--
--   1. every reference stays inside one tenant (composite foreign keys)
--   2. a deal's stage belongs to the deal's own pipeline
--   3. the closed state of a deal agrees with its stage's type (ADR-0020)
--   4. a stage that has deals cannot change from open to won/lost underneath them
--
-- Tables are created empty, so none of the index builds below take a long lock.
-- Any later index on deals, once tenants hold real data, has to be built
-- outside a transaction (the runner wraps each file in one).

-- Contacts did not carry (tenant_id, id), which a composite reference needs.
-- accounts gained it in 0007.
ALTER TABLE contacts ADD CONSTRAINT contacts_tenant_id_key UNIQUE (tenant_id, id);

-- ---------------------------------------------------------------------------
-- pipelines
-- ---------------------------------------------------------------------------
CREATE TABLE pipelines (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name        text NOT NULL,
  position    integer NOT NULL DEFAULT 0,
  -- The pipeline a new deal lands in when the caller names none.
  is_default  boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  CONSTRAINT pipelines_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT pipelines_name_chk CHECK (length(btrim(name)) > 0)
);
CREATE UNIQUE INDEX pipelines_tenant_name_key ON pipelines (tenant_id, lower(name));
-- At most one default per tenant, enforced rather than hoped for.
CREATE UNIQUE INDEX pipelines_one_default_key ON pipelines (tenant_id) WHERE is_default;
CREATE INDEX pipelines_tenant_position_idx ON pipelines (tenant_id, position, id);

-- ---------------------------------------------------------------------------
-- pipeline_stages
-- ---------------------------------------------------------------------------
CREATE TABLE pipeline_stages (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  pipeline_id  uuid NOT NULL,
  name         text NOT NULL,
  position     integer NOT NULL DEFAULT 0,
  -- Whole percent. A won stage is 100 and a lost stage 0 by rule 3; an open
  -- stage's value is the default a deal takes on entering it.
  probability  integer NOT NULL DEFAULT 0,
  stage_type   text NOT NULL DEFAULT 'open',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_by   uuid,
  CONSTRAINT pipeline_stages_tenant_id_key UNIQUE (tenant_id, id),
  -- Three columns because deals reference the pair (stage, pipeline) to prove
  -- the stage is in the deal's pipeline. A foreign key can only target a
  -- unique key, so this is the key it targets.
  CONSTRAINT pipeline_stages_tenant_id_pipeline_key UNIQUE (tenant_id, id, pipeline_id),
  CONSTRAINT pipeline_stages_pipeline_fkey
    FOREIGN KEY (tenant_id, pipeline_id) REFERENCES pipelines (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT pipeline_stages_name_chk CHECK (length(btrim(name)) > 0),
  CONSTRAINT pipeline_stages_probability_chk CHECK (probability BETWEEN 0 AND 100),
  CONSTRAINT pipeline_stages_type_chk CHECK (stage_type IN ('open', 'won', 'lost')),
  CONSTRAINT pipeline_stages_closed_probability_chk CHECK (
    (stage_type <> 'won' OR probability = 100) AND (stage_type <> 'lost' OR probability = 0)
  )
);
CREATE INDEX pipeline_stages_pipeline_position_idx
  ON pipeline_stages (tenant_id, pipeline_id, position, id);

-- ---------------------------------------------------------------------------
-- deals
-- ---------------------------------------------------------------------------
CREATE TABLE deals (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  owner_id              uuid REFERENCES users (id) ON DELETE SET NULL,
  name                  text NOT NULL,
  account_id            uuid,
  primary_contact_id    uuid,
  pipeline_id           uuid NOT NULL,
  stage_id              uuid NOT NULL,
  -- Money is minor units beside its currency, never a float (ADR-0011).
  amount_minor          bigint,
  currency              char(3),
  probability           integer NOT NULL DEFAULT 0,
  expected_close_date   date,
  closed_at             timestamptz,
  lost_reason           text,
  custom_fields         jsonb NOT NULL DEFAULT '{}'::jsonb,
  version               integer NOT NULL DEFAULT 1,
  deleted_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_by            uuid,
  CONSTRAINT deals_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT deals_version_chk CHECK (version > 0),
  CONSTRAINT deals_name_chk CHECK (length(btrim(name)) > 0),
  CONSTRAINT deals_probability_chk CHECK (probability BETWEEN 0 AND 100),
  CONSTRAINT deals_amount_sign_chk CHECK (amount_minor IS NULL OR amount_minor >= 0),
  -- An amount without its currency is meaningless (ADR-0011); both or neither.
  CONSTRAINT deals_amount_currency_chk CHECK ((amount_minor IS NULL) = (currency IS NULL)),
  CONSTRAINT deals_currency_format_chk CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  CONSTRAINT deals_lost_reason_chk CHECK (lost_reason IS NULL OR length(btrim(lost_reason)) > 0),

  -- 1 + 2. Same tenant, and the stage is in this deal's pipeline.
  CONSTRAINT deals_pipeline_fkey
    FOREIGN KEY (tenant_id, pipeline_id) REFERENCES pipelines (tenant_id, id),
  CONSTRAINT deals_stage_in_pipeline_fkey
    FOREIGN KEY (tenant_id, stage_id, pipeline_id)
    REFERENCES pipeline_stages (tenant_id, id, pipeline_id),
  -- The column list on SET NULL: without it Postgres would try to null
  -- tenant_id too, which is NOT NULL.
  CONSTRAINT deals_account_same_tenant_fkey
    FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id)
    ON DELETE SET NULL (account_id),
  CONSTRAINT deals_primary_contact_same_tenant_fkey
    FOREIGN KEY (tenant_id, primary_contact_id) REFERENCES contacts (tenant_id, id)
    ON DELETE SET NULL (primary_contact_id)
);

-- Keyset default order (ADR-0012), live rows only.
CREATE INDEX deals_tenant_created_idx
  ON deals (tenant_id, created_at, id) WHERE deleted_at IS NULL;
-- The Kanban board: one column is "this stage, in this order".
CREATE INDEX deals_tenant_stage_created_idx
  ON deals (tenant_id, stage_id, created_at, id) WHERE deleted_at IS NULL;
CREATE INDEX deals_tenant_pipeline_idx ON deals (tenant_id, pipeline_id);
CREATE INDEX deals_tenant_owner_idx ON deals (tenant_id, owner_id);
CREATE INDEX deals_tenant_account_idx ON deals (tenant_id, account_id);
CREATE INDEX deals_tenant_primary_contact_idx ON deals (tenant_id, primary_contact_id);
CREATE INDEX deals_tenant_name_id_idx
  ON deals (tenant_id, name, id) WHERE deleted_at IS NULL;
CREATE INDEX deals_tenant_close_date_idx
  ON deals (tenant_id, expected_close_date, id) WHERE deleted_at IS NULL;
CREATE INDEX deals_custom_fields_idx ON deals USING gin (custom_fields);

-- ---------------------------------------------------------------------------
-- 3. A deal's closed state agrees with its stage (ADR-0020).
--
--   won   closed_at is set, probability is 100, no lost reason
--   lost  closed_at is set, probability is 0, a lost reason is present
--   open  closed_at is null, no lost reason
--
-- Not expressible as a CHECK, because the stage type lives in another table.
-- Without it the acceptance criterion "moving a deal to a won stage sets
-- closed_at and probability 100" is a property of one code path rather than of
-- the data, and an import that sets stage_id alone would produce a won deal
-- that is still open.
-- ---------------------------------------------------------------------------
CREATE FUNCTION deals_assert_stage_state() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  kind text;
BEGIN
  SELECT s.stage_type INTO kind
    FROM pipeline_stages s
   WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.stage_id;

  IF kind = 'won' AND (NEW.closed_at IS NULL OR NEW.probability <> 100 OR NEW.lost_reason IS NOT NULL) THEN
    RAISE EXCEPTION 'A deal in a won stage must be closed, at probability 100, with no lost reason'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'deals_stage_state';
  ELSIF kind = 'lost' AND (NEW.closed_at IS NULL OR NEW.probability <> 0 OR NEW.lost_reason IS NULL) THEN
    RAISE EXCEPTION 'A deal in a lost stage must be closed, at probability 0, with a lost reason'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'deals_stage_state';
  ELSIF kind = 'open' AND (NEW.closed_at IS NOT NULL OR NEW.lost_reason IS NOT NULL) THEN
    RAISE EXCEPTION 'A deal in an open stage cannot be closed or carry a lost reason'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'deals_stage_state';
  END IF;

  RETURN NEW;
END
$$;

-- Only when something the rule reads changes, so renaming a deal does not pay
-- for a lookup.
CREATE TRIGGER deals_stage_state
  BEFORE INSERT OR UPDATE OF stage_id, closed_at, probability, lost_reason ON deals
  FOR EACH ROW
  EXECUTE FUNCTION deals_assert_stage_state();

-- ---------------------------------------------------------------------------
-- 4. A stage's type is frozen while it holds deals.
--
-- Turning an open stage into a won one would leave every deal in it open
-- inside a won stage, and rule 3 only checks a deal when the deal is written.
-- Moving the deals out first is the deliberate way to retype a stage.
-- ---------------------------------------------------------------------------
CREATE FUNCTION pipeline_stages_assert_type_stable() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM deals d
     WHERE d.tenant_id = OLD.tenant_id AND d.stage_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'Stage % holds deals, so its type cannot change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pipeline_stages_type_stable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER pipeline_stages_type_stable
  BEFORE UPDATE OF stage_type ON pipeline_stages
  FOR EACH ROW
  WHEN (OLD.stage_type IS DISTINCT FROM NEW.stage_type)
  EXECUTE FUNCTION pipeline_stages_assert_type_stable();

GRANT EXECUTE ON FUNCTION deals_assert_stage_state() TO crm_app, crm_worker;
GRANT EXECUTE ON FUNCTION pipeline_stages_assert_type_stable() TO crm_app, crm_worker;

-- ---------------------------------------------------------------------------
-- deal_contacts: the people on a deal.
-- ---------------------------------------------------------------------------
CREATE TABLE deal_contacts (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  deal_id     uuid NOT NULL,
  contact_id  uuid NOT NULL,
  role        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  CONSTRAINT deal_contacts_deal_fkey
    FOREIGN KEY (tenant_id, deal_id) REFERENCES deals (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT deal_contacts_contact_fkey
    FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT deal_contacts_role_chk CHECK (role IS NULL OR length(btrim(role)) > 0)
);
CREATE UNIQUE INDEX deal_contacts_unique ON deal_contacts (tenant_id, deal_id, contact_id);
CREATE INDEX deal_contacts_contact_idx ON deal_contacts (tenant_id, contact_id);

-- ---------------------------------------------------------------------------
-- exchange_rates: manual rates, per tenant (MVP_SPEC M5; live rates are P1).
--
-- The rate is numeric, never a float: it is read as a decimal string and
-- applied in bigint arithmetic, so no floating-point value ever touches money.
-- It is major-unit to major-unit ("1 USD = 83.25 INR"); the conversion
-- accounts for currencies with a different number of minor-unit decimals.
-- ---------------------------------------------------------------------------
CREATE TABLE exchange_rates (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  from_currency  char(3) NOT NULL,
  to_currency    char(3) NOT NULL,
  rate           numeric(24, 12) NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_by     uuid,
  CONSTRAINT exchange_rates_rate_chk CHECK (rate > 0),
  CONSTRAINT exchange_rates_format_chk
    CHECK (from_currency ~ '^[A-Z]{3}$' AND to_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT exchange_rates_distinct_chk CHECK (from_currency <> to_currency)
);
CREATE UNIQUE INDEX exchange_rates_pair_key
  ON exchange_rates (tenant_id, from_currency, to_currency);

-- ---------------------------------------------------------------------------
-- Row-Level Security and grants (0004).
-- ---------------------------------------------------------------------------
CALL apply_tenant_rls('pipelines');
CALL apply_tenant_rls('pipeline_stages');
CALL apply_tenant_rls('deals');
CALL apply_tenant_rls('deal_contacts');
CALL apply_tenant_rls('exchange_rates');

GRANT SELECT, INSERT, UPDATE, DELETE ON
  pipelines, pipeline_stages, deals, deal_contacts, exchange_rates
TO crm_app, crm_worker;
