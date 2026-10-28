-- Tags on records and a place to manage them (MVP_SPEC M4; ADR-0063).
--
-- Until now a tag could be added to a record and nothing showed it. The settings screen renames, recolours
-- and deletes tags, which needs three things the table did not have:
--
--   1. a `version`, so two administrators editing the same tag get a 409 instead of the last one winning
--   2. a colour that is one of a closed list of names, never free text: the value is stored and sent to
--      every browser, and a name cannot carry CSS
--   3. a name that is unique ignoring case, as the application has always treated it ("VIP" and "vip" are
--      one tag), now enforced here as well, so a rename cannot create a second "vip"
--
-- Size: `tags` holds at most 500 rows per workspace (TAGS_MAX_PER_TENANT), so the new unique index reads
-- a few thousand rows in total and takes no meaningful lock. It runs in the migration's own transaction,
-- which is why it is not CREATE INDEX CONCURRENTLY. The new column carries a constant default, so adding
-- it rewrites nothing, and no row has a colour yet, so the check passes for every existing row.
--
-- The application has always looked a tag up by lower-cased name, so no workspace should hold two tags
-- that differ only by case. If a hand-edited database did, the index below stops the migration, loudly,
-- rather than starting with an ambiguous tag.

ALTER TABLE tags ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE tags ADD CONSTRAINT tags_version_chk CHECK (version > 0);

ALTER TABLE tags ADD CONSTRAINT tags_color_chk CHECK (
  color IS NULL
  OR color IN ('gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet')
);

CREATE UNIQUE INDEX tags_tenant_lower_name_key ON tags (tenant_id, lower(name));
