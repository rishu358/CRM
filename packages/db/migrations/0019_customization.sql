-- Customization: custom fields and picklists, administered (MVP_SPEC M9, ADR-0039).
--
-- Until now `field_definitions` was written only by provisioning and read by
-- everything. M9 lets an administrator change it, and a table that holds the
-- shape of every record in the company is a table to narrow before it is opened.
--
-- What this does:
--
--   1. `section` and `help_text`, so a record page can group fields and say what
--      one is for; and `version`, because a definition is edited by more than one
--      administrator and the second save must not silently overwrite the first.
--
--   2. Withdraws DELETE, and narrows UPDATE to the columns an administrator may
--      change. "Deactivating a field hides it but keeps data" is the spec's rule
--      (M9); a DELETE grant is a way to break it from any request path, and a
--      column-wide UPDATE is a way to change `key` or `type` out from under
--      records that have values stored under them. The application role keeps
--      INSERT. The worker keeps nothing but SELECT: it reads definitions to build
--      the search index and exports, and writes none.
--
--   3. Two triggers that restate rules the service also enforces, because these
--      are the rules that cannot be put right afterwards:
--        * a picklist option's `value` is never removed (records may hold it);
--        * a company has at most 60 custom fields per object.

ALTER TABLE field_definitions
  ADD COLUMN section   text,
  ADD COLUMN help_text text,
  ADD COLUMN version   integer NOT NULL DEFAULT 1;

ALTER TABLE field_definitions
  ADD CONSTRAINT field_definitions_section_chk
    CHECK (section IS NULL OR char_length(section) BETWEEN 1 AND 60),
  ADD CONSTRAINT field_definitions_help_text_chk
    CHECK (help_text IS NULL OR char_length(help_text) BETWEEN 1 AND 280),
  ADD CONSTRAINT field_definitions_label_chk
    CHECK (char_length(label) BETWEEN 1 AND 80),
  ADD CONSTRAINT field_definitions_options_chk
    CHECK (options IS NULL OR (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) <= 100));

-- ---------------------------------------------------------------------------
-- 2. Narrower grants.
-- ---------------------------------------------------------------------------
REVOKE DELETE, UPDATE ON field_definitions FROM crm_app, crm_worker;
REVOKE INSERT ON field_definitions FROM crm_worker;

GRANT UPDATE (label, required, options, validation, position, is_active, section, help_text,
              version, updated_at, updated_by)
  ON field_definitions TO crm_app;

-- ---------------------------------------------------------------------------
-- 3a. A picklist value, once offered, stays valid.
--
-- Records hold the `value`. Dropping it from the list would leave them holding
-- something the field no longer describes, and the next edit of any of them would
-- be refused for a reason nobody can see. Retiring an option is `isActive: false`.
-- ---------------------------------------------------------------------------
CREATE FUNCTION field_definitions_keep_option_values() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.options IS NULL OR jsonb_typeof(OLD.options) <> 'array' THEN
    RETURN NEW;
  END IF;

  IF NEW.options IS NULL OR jsonb_typeof(NEW.options) <> 'array' THEN
    RAISE EXCEPTION 'A field that has options cannot lose them'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'field_definitions_option_values_kept';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(OLD.options) AS old_option
     WHERE NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(NEW.options) AS new_option
        WHERE new_option ->> 'value' = old_option ->> 'value'
     )
  ) THEN
    RAISE EXCEPTION 'A picklist option cannot be removed once it has been offered; deactivate it instead'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'field_definitions_option_values_kept';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER field_definitions_keep_option_values
  BEFORE UPDATE OF options ON field_definitions
  FOR EACH ROW
  EXECUTE FUNCTION field_definitions_keep_option_values();

-- ---------------------------------------------------------------------------
-- 3b. At most 60 custom fields per object, per company.
--
-- A record page with two hundred fields is not a customization, it is a different
-- product, and every list and form reads all of them. The count is taken under an
-- advisory lock for the (company, object) pair, so two administrators adding a
-- field at once cannot both be the sixtieth.
-- ---------------------------------------------------------------------------
CREATE FUNCTION field_definitions_cap_custom_fields() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  existing integer;
BEGIN
  IF NEW.is_system THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('field-cap:' || NEW.tenant_id::text || ':' || NEW.object_type, 0));

  SELECT count(*) INTO existing
    FROM field_definitions
   WHERE tenant_id = NEW.tenant_id AND object_type = NEW.object_type AND NOT is_system;

  IF existing >= 60 THEN
    RAISE EXCEPTION 'A company can have at most 60 custom fields on one object'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'field_definitions_custom_cap';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER field_definitions_cap_custom_fields
  BEFORE INSERT ON field_definitions
  FOR EACH ROW
  EXECUTE FUNCTION field_definitions_cap_custom_fields();
