-- TD-05 §8: Search indexes
-- Migration 0007_search_indexes.sql

-- GIN trigram indexes for global search
CREATE INDEX ix_envelopes_name_trgm ON envelopes USING gin (name gin_trgm_ops);
CREATE INDEX ix_envelopes_owner_name_trgm ON envelopes USING gin (owner_name gin_trgm_ops);
CREATE INDEX ix_categories_name_trgm ON categories USING gin (name gin_trgm_ops);
