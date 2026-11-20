-- Additive, repeatable knowledge storage. Never installs an extension.
CREATE TABLE IF NOT EXISTS knowledge_runtime (
    id integer PRIMARY KEY CHECK (id = 1),
    revision bigint NOT NULL DEFAULT 0
);
INSERT INTO knowledge_runtime (id, revision) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS knowledge_sources (
    source_id uuid PRIMARY KEY,
    title text NOT NULL,
    category text NOT NULL DEFAULT '',
    author text NOT NULL DEFAULT '',
    file_name text NOT NULL,
    permission_note text NOT NULL CHECK (length(btrim(permission_note)) > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    is_active boolean NOT NULL DEFAULT true,
    status text NOT NULL DEFAULT 'queued',
    page_count integer NOT NULL DEFAULT 0,
    chunk_count integer NOT NULL DEFAULT 0,
    failed_pages integer[] NOT NULL DEFAULT '{}',
    error_message text,
    indexed_at timestamptz,
    file_bytes bytea NOT NULL,
    file_hash text NOT NULL,
    file_type text NOT NULL,
    bootstrap_hash text
);
ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'queued';
ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS page_count integer NOT NULL DEFAULT 0;
ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS chunk_count integer NOT NULL DEFAULT 0;
ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS failed_pages integer[] NOT NULL DEFAULT '{}';
ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS error_message text;
ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS indexed_at timestamptz;
ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS bootstrap_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_sources_bootstrap_hash_idx
    ON knowledge_sources (bootstrap_hash) WHERE bootstrap_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS knowledge_pages (
    source_id uuid NOT NULL REFERENCES knowledge_sources(source_id) ON DELETE CASCADE,
    page_number integer NOT NULL CHECK (page_number > 0),
    content text NOT NULL,
    PRIMARY KEY (source_id, page_number)
);
CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id uuid PRIMARY KEY,
    source_id uuid NOT NULL REFERENCES knowledge_sources(source_id) ON DELETE CASCADE,
    page_number integer NOT NULL CHECK (page_number > 0),
    chunk_number integer NOT NULL CHECK (chunk_number > 0),
    content text NOT NULL CHECK (length(content) > 0 AND length(content) <= 1500),
    embedding real[] NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    profile text NOT NULL,
    UNIQUE (source_id, page_number, chunk_number)
);
CREATE INDEX IF NOT EXISTS knowledge_chunks_profile_idx ON knowledge_chunks (profile, source_id);
CREATE TABLE IF NOT EXISTS knowledge_jobs (
    source_id uuid PRIMARY KEY REFERENCES knowledge_sources(source_id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'queued',
    queued_at timestamptz NOT NULL DEFAULT now(),
    lease_token uuid,
    lease_until timestamptz,
    attempts integer NOT NULL DEFAULT 0,
    last_error text
);
CREATE INDEX IF NOT EXISTS knowledge_jobs_queue_idx ON knowledge_jobs (status, lease_until, queued_at);

-- Cache revision changes in the same transaction that changes an eligible source.
CREATE OR REPLACE FUNCTION knowledge_bump_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_eligible boolean := false; new_eligible boolean := false;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        old_eligible := OLD.is_active AND OLD.status = 'ready' AND length(btrim(OLD.permission_note)) > 0;
    END IF;
    IF TG_OP <> 'DELETE' THEN
        new_eligible := NEW.is_active AND NEW.status = 'ready' AND length(btrim(NEW.permission_note)) > 0;
    END IF;
    IF old_eligible OR new_eligible THEN
        UPDATE knowledge_runtime SET revision = revision + 1 WHERE id = 1;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS knowledge_sources_revision ON knowledge_sources;
CREATE TRIGGER knowledge_sources_revision AFTER INSERT OR UPDATE OR DELETE ON knowledge_sources
    FOR EACH ROW EXECUTE FUNCTION knowledge_bump_revision();

-- Use pgvector only when an administrator has already installed it, in any schema.
-- The real[] column remains authoritative and is usable without pgvector.
DO $$
DECLARE vector_schema text;
BEGIN
    SELECT n.nspname INTO vector_schema FROM pg_extension e
        JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector';
    IF vector_schema IS NOT NULL THEN
        BEGIN
            EXECUTE format('ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding_vector %I.vector', vector_schema);
            EXECUTE format('UPDATE knowledge_chunks SET embedding_vector = (''['' || array_to_string(embedding, '','') || '']'')::%I.vector WHERE embedding_vector IS NULL AND cardinality(embedding) BETWEEN 1 AND 16000', vector_schema);
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'Optional pgvector column unavailable; using real[] cosine retrieval: %', SQLERRM;
        END;
    END IF;
END $$;
