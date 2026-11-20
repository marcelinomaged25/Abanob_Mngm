using Npgsql;
using NpgsqlTypes;
using System.Globalization;
using System.Text.Json;

internal sealed record KnowledgeSourceDto(Guid SourceId, string Title, string Category, string Author,
    string FileName, string PermissionNote, DateTime CreatedAt, bool IsActive, string Status,
    int PageCount, int ChunkCount, int[] FailedPages, string? ErrorMessage, DateTime? IndexedAt);
internal sealed record KnowledgeSourceSave(string? Title, string? Category, string? Author, string? PermissionNote, bool IsActive);
internal sealed record KnowledgePage(int PageNumber, string Text);
internal sealed record KnowledgePendingChunk(Guid Id, int PageNumber, int ChunkNumber, string Content);
internal sealed record KnowledgeLease(Guid SourceId, Guid Token, string FileName, string FileType, byte[] Bytes);
internal sealed class KnowledgeLeaseLostException : Exception
{
    internal KnowledgeLeaseLostException() : base("The knowledge ingestion lease is no longer owned by this worker.") { }
}

internal sealed class KnowledgeStore(NpgsqlDataSource db) : IKnowledgeVectorStore
{
    private const string SourceColumns = "source_id,title,category,author,file_name,permission_note,created_at,is_active,status,page_count,chunk_count,failed_pages,error_message,indexed_at";

    public async Task<long> RevisionAsync(CancellationToken cancellationToken)
    {
        await using var command = db.CreateCommand("SELECT revision FROM knowledge_runtime WHERE id=$1");
        command.Parameters.AddWithValue(1);
        return Convert.ToInt64(await command.ExecuteScalarAsync(cancellationToken), CultureInfo.InvariantCulture);
    }

    internal async Task<IReadOnlyList<KnowledgeSourceDto>> SourcesAsync(CancellationToken ct)
    {
        await using var command = db.CreateCommand($"SELECT {SourceColumns} FROM knowledge_sources ORDER BY created_at DESC,source_id");
        await using var reader = await command.ExecuteReaderAsync(ct);
        var result = new List<KnowledgeSourceDto>();
        while (await reader.ReadAsync(ct)) result.Add(ReadSource(reader));
        return result;
    }

    internal async Task<KnowledgeSourceDto?> SourceAsync(Guid sourceId, CancellationToken ct)
    {
        await using var command = db.CreateCommand($"SELECT {SourceColumns} FROM knowledge_sources WHERE source_id=$1");
        command.Parameters.AddWithValue(sourceId);
        await using var reader = await command.ExecuteReaderAsync(ct);
        return await reader.ReadAsync(ct) ? ReadSource(reader) : null;
    }

    internal async Task<KnowledgeSourceDto> CreateAsync(KnowledgeSourceSave metadata, string fileName,
        string fileType, byte[] bytes, string hash, bool bootstrap, CancellationToken ct)
    {
        await using var connection = await db.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);
        var id = Guid.NewGuid();
        KnowledgeSourceDto? source;
        await using (var command = new NpgsqlCommand($"""
            INSERT INTO knowledge_sources(source_id,title,category,author,file_name,permission_note,is_active,file_bytes,file_hash,file_type,bootstrap_hash)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            ON CONFLICT (bootstrap_hash) WHERE bootstrap_hash IS NOT NULL DO NOTHING RETURNING {SourceColumns}
            """, connection, transaction))
        {
            command.Parameters.AddWithValue(id);
            command.Parameters.AddWithValue(metadata.Title!.Trim());
            command.Parameters.AddWithValue(metadata.Category?.Trim() ?? "");
            command.Parameters.AddWithValue(metadata.Author?.Trim() ?? "");
            command.Parameters.AddWithValue(fileName);
            command.Parameters.AddWithValue(metadata.PermissionNote!.Trim());
            command.Parameters.AddWithValue(metadata.IsActive);
            command.Parameters.AddWithValue(bytes);
            command.Parameters.AddWithValue(hash);
            command.Parameters.AddWithValue(fileType);
            command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Text, Value = bootstrap ? hash : DBNull.Value });
            await using var reader = await command.ExecuteReaderAsync(ct);
            source = await reader.ReadAsync(ct) ? ReadSource(reader) : null;
        }
        if (source is null)
        {
            await using var existing = new NpgsqlCommand($"SELECT {SourceColumns} FROM knowledge_sources WHERE bootstrap_hash=$1", connection, transaction);
            existing.Parameters.AddWithValue(hash);
            await using var reader = await existing.ExecuteReaderAsync(ct);
            if (!await reader.ReadAsync(ct)) throw new InvalidOperationException("Bootstrap source conflict could not be resolved.");
            source = ReadSource(reader);
        }
        else
        {
            await using var job = new NpgsqlCommand("INSERT INTO knowledge_jobs(source_id) VALUES($1)", connection, transaction);
            job.Parameters.AddWithValue(id);
            await job.ExecuteNonQueryAsync(ct);
        }
        await transaction.CommitAsync(ct);
        return source;
    }

    internal async Task<KnowledgeSourceDto?> UpdateAsync(Guid id, KnowledgeSourceSave metadata, CancellationToken ct)
    {
        await using var command = db.CreateCommand($"""
            UPDATE knowledge_sources SET title=$2,category=$3,author=$4,permission_note=$5,is_active=$6
            WHERE source_id=$1 RETURNING {SourceColumns}
            """);
        command.Parameters.AddWithValue(id);
        command.Parameters.AddWithValue(metadata.Title!.Trim());
        command.Parameters.AddWithValue(metadata.Category?.Trim() ?? "");
        command.Parameters.AddWithValue(metadata.Author?.Trim() ?? "");
        command.Parameters.AddWithValue(metadata.PermissionNote!.Trim());
        command.Parameters.AddWithValue(metadata.IsActive);
        await using var reader = await command.ExecuteReaderAsync(ct);
        return await reader.ReadAsync(ct) ? ReadSource(reader) : null;
    }

    internal async Task<bool> DeleteAsync(Guid id, CancellationToken ct)
    {
        await using var connection = await db.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);
        // Match worker lock ordering (job, then source) before the cascading delete.
        await using (var fence = new NpgsqlCommand("SELECT source_id FROM knowledge_jobs WHERE source_id=$1 FOR UPDATE", connection, transaction))
        {
            fence.Parameters.AddWithValue(id);
            await fence.ExecuteScalarAsync(ct);
        }
        await using var command = new NpgsqlCommand("DELETE FROM knowledge_sources WHERE source_id=$1", connection, transaction);
        command.Parameters.AddWithValue(id);
        var deleted = await command.ExecuteNonQueryAsync(ct) > 0;
        await transaction.CommitAsync(ct);
        return deleted;
    }

    internal async Task<bool> QueueAsync(Guid id, CancellationToken ct)
    {
        await using var connection = await db.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);
        // Invalidating the job token fences any older worker before it can publish another batch.
        await using (var job = new NpgsqlCommand("""
            INSERT INTO knowledge_jobs(source_id) SELECT source_id FROM knowledge_sources WHERE source_id=$1
            ON CONFLICT(source_id) DO UPDATE SET status='queued',queued_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,last_error=NULL
            """, connection, transaction))
        {
            job.Parameters.AddWithValue(id);
            if (await job.ExecuteNonQueryAsync(ct) == 0) return false;
        }
        await using (var source = new NpgsqlCommand("""
            UPDATE knowledge_sources SET status='queued',error_message=NULL,indexed_at=NULL WHERE source_id=$1
            """, connection, transaction))
        {
            source.Parameters.AddWithValue(id);
            await source.ExecuteNonQueryAsync(ct);
        }
        await transaction.CommitAsync(ct);
        return true;
    }

    internal async Task<object?> ChunksAsync(Guid id, int offset, int limit, CancellationToken ct)
    {
        await using var connection = await db.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(System.Data.IsolationLevel.RepeatableRead, ct);
        await using (var exists = new NpgsqlCommand("SELECT EXISTS(SELECT 1 FROM knowledge_sources WHERE source_id=$1)", connection, transaction))
        {
            exists.Parameters.AddWithValue(id);
            if (!(bool)(await exists.ExecuteScalarAsync(ct))!) return null;
        }
        long total;
        await using (var count = new NpgsqlCommand("SELECT count(*) FROM knowledge_chunks WHERE source_id=$1", connection, transaction))
        {
            count.Parameters.AddWithValue(id);
            total = (long)(await count.ExecuteScalarAsync(ct))!;
        }
        var chunks = new List<object>();
        await using (var command = new NpgsqlCommand("""
            SELECT id,source_id,page_number,chunk_number,content,metadata::text,created_at,profile
            FROM knowledge_chunks WHERE source_id=$1 ORDER BY page_number,chunk_number OFFSET $2 LIMIT $3
            """, connection, transaction))
        {
            command.Parameters.AddWithValue(id); command.Parameters.AddWithValue(offset); command.Parameters.AddWithValue(limit);
            await using var reader = await command.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
                chunks.Add(new { id = reader.GetGuid(0), sourceId = reader.GetGuid(1), pageNumber = reader.GetInt32(2),
                    chunkNumber = reader.GetInt32(3), content = reader.GetString(4),
                    metadata = JsonSerializer.Deserialize<JsonElement>(reader.GetString(5)), createdAt = reader.GetDateTime(6), profile = reader.GetString(7) });
        }
        await transaction.CommitAsync(ct);
        return new { chunks, total };
    }

    internal async Task<KnowledgeLease?> ClaimAsync(CancellationToken ct)
    {
        await using var connection = await db.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);
        var token = Guid.NewGuid();
        Guid id;
        await using (var claim = new NpgsqlCommand("""
            UPDATE knowledge_jobs SET status='processing',lease_token=$1,lease_until=clock_timestamp()+interval '120 seconds',attempts=attempts+1,last_error=NULL
            WHERE source_id=(SELECT source_id FROM knowledge_jobs
                WHERE status='queued' OR (status='processing' AND lease_until<=clock_timestamp())
                ORDER BY queued_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING source_id
            """, connection, transaction))
        {
            claim.Parameters.AddWithValue(token);
            var value = await claim.ExecuteScalarAsync(ct);
            if (value is not Guid sourceId) return null;
            id = sourceId;
        }
        KnowledgeLease lease;
        await using (var read = new NpgsqlCommand("SELECT file_name,file_type,file_bytes FROM knowledge_sources WHERE source_id=$1 FOR UPDATE", connection, transaction))
        {
            read.Parameters.AddWithValue(id);
            await using var reader = await read.ExecuteReaderAsync(ct);
            if (!await reader.ReadAsync(ct)) throw new KnowledgeLeaseLostException();
            lease = new KnowledgeLease(id, token, reader.GetString(0), reader.GetString(1), reader.GetFieldValue<byte[]>(2));
        }
        foreach (var sql in new[]
        {
            "DELETE FROM knowledge_chunks WHERE source_id=$1",
            "DELETE FROM knowledge_pages WHERE source_id=$1",
            "UPDATE knowledge_sources SET status='extracting',page_count=0,chunk_count=0,failed_pages='{}',error_message=NULL,indexed_at=NULL WHERE source_id=$1"
        })
        {
            await using var clear = new NpgsqlCommand(sql, connection, transaction);
            clear.Parameters.AddWithValue(id);
            await clear.ExecuteNonQueryAsync(ct);
        }
        await transaction.CommitAsync(ct);
        return lease;
    }

    internal async Task RenewAsync(KnowledgeLease lease, CancellationToken ct)
    {
        await using var command = db.CreateCommand("""
            UPDATE knowledge_jobs SET lease_until=clock_timestamp()+interval '120 seconds'
            WHERE source_id=$1 AND lease_token=$2 AND status='processing' AND lease_until>clock_timestamp()
            """);
        command.Parameters.AddWithValue(lease.SourceId); command.Parameters.AddWithValue(lease.Token);
        if (await command.ExecuteNonQueryAsync(ct) != 1) throw new KnowledgeLeaseLostException();
    }

    private static async Task LockLeaseAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, KnowledgeLease lease, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand("""
            SELECT source_id FROM knowledge_jobs WHERE source_id=$1 AND lease_token=$2
            AND status='processing' AND lease_until>clock_timestamp() FOR UPDATE
            """, connection, transaction);
        command.Parameters.AddWithValue(lease.SourceId); command.Parameters.AddWithValue(lease.Token);
        if (await command.ExecuteScalarAsync(ct) is not Guid) throw new KnowledgeLeaseLostException();
        // Extend under the row lock; competing claims/requeues cannot pass this fence until commit.
        await using var renewal = new NpgsqlCommand("UPDATE knowledge_jobs SET lease_until=clock_timestamp()+interval '120 seconds' WHERE source_id=$1 AND lease_token=$2", connection, transaction);
        renewal.Parameters.AddWithValue(lease.SourceId); renewal.Parameters.AddWithValue(lease.Token);
        await renewal.ExecuteNonQueryAsync(ct);
    }

    internal async Task SavePagesAsync(KnowledgeLease lease, IReadOnlyList<KnowledgePage> pages, int[] failedPages, string? error, CancellationToken ct)
    {
        // Bounded transactions keep the lease live even for large sources.
        for (var offset = 0; offset < pages.Count; offset += 20)
        {
            await using var connection = await db.OpenConnectionAsync(ct);
            await using var transaction = await connection.BeginTransactionAsync(ct);
            await LockLeaseAsync(connection, transaction, lease, ct);
            foreach (var page in pages.Skip(offset).Take(20))
            {
                await using var command = new NpgsqlCommand("INSERT INTO knowledge_pages(source_id,page_number,content) VALUES($1,$2,$3)", connection, transaction);
                command.Parameters.AddWithValue(lease.SourceId); command.Parameters.AddWithValue(page.PageNumber); command.Parameters.AddWithValue(page.Text);
                await command.ExecuteNonQueryAsync(ct);
            }
            await transaction.CommitAsync(ct);
        }
        await using var finalConnection = await db.OpenConnectionAsync(ct);
        await using var finalTransaction = await finalConnection.BeginTransactionAsync(ct);
        await LockLeaseAsync(finalConnection, finalTransaction, lease, ct);
        await using var stats = new NpgsqlCommand("""
            UPDATE knowledge_sources SET page_count=$2,failed_pages=$3,error_message=$4,status='embedding' WHERE source_id=$1
            """, finalConnection, finalTransaction);
        stats.Parameters.AddWithValue(lease.SourceId);
        stats.Parameters.AddWithValue(pages.Select(page => page.PageNumber).Concat(failedPages).Distinct().Count());
        stats.Parameters.AddWithValue(failedPages);
        stats.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Text, Value = (object?)error ?? DBNull.Value });
        await stats.ExecuteNonQueryAsync(ct);
        await finalTransaction.CommitAsync(ct);
    }

    internal async Task SaveBatchAsync(KnowledgeLease lease, IReadOnlyList<KnowledgePendingChunk> chunks,
        float[][] embeddings, string profile, int dimensions, CancellationToken ct)
    {
        if (chunks.Count is < 1 or > 20 || embeddings.Length != chunks.Count || string.IsNullOrWhiteSpace(profile))
            throw new InvalidDataException("Invalid embedding batch or profile.");
        foreach (var embedding in embeddings) ValidateEmbedding(embedding, dimensions);
        await using var connection = await db.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);
        await LockLeaseAsync(connection, transaction, lease, ct);
        var vectorSchema = await VectorSchemaAsync(connection, transaction, ct);
        for (var i = 0; i < chunks.Count; i++)
        {
            var chunk = chunks[i];
            await using var command = new NpgsqlCommand("""
                INSERT INTO knowledge_chunks(id,source_id,page_number,chunk_number,content,embedding,metadata,profile)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8)
                """, connection, transaction);
            command.Parameters.AddWithValue(chunk.Id); command.Parameters.AddWithValue(lease.SourceId);
            command.Parameters.AddWithValue(chunk.PageNumber); command.Parameters.AddWithValue(chunk.ChunkNumber);
            command.Parameters.AddWithValue(chunk.Content); command.Parameters.AddWithValue(embeddings[i]);
            command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Jsonb,
                Value = JsonSerializer.Serialize(new { fileName = lease.FileName, pageNumber = chunk.PageNumber, chunkNumber = chunk.ChunkNumber, embeddingDimensions = dimensions }) });
            command.Parameters.AddWithValue(profile);
            await command.ExecuteNonQueryAsync(ct);
        }
        if (vectorSchema is not null && dimensions <= 16000)
        {
            // An unavailable optional extension must never roll back the authoritative real[] batch.
            await transaction.SaveAsync("optional_vector", ct);
            try
            {
                // Only a catalog-derived, quoted identifier is interpolated; all values are parameters.
                await using var vector = new NpgsqlCommand($"""
                    UPDATE knowledge_chunks SET embedding_vector=('[' || array_to_string(embedding, ',') || ']')::{Quote(vectorSchema)}.vector
                    WHERE source_id=$1 AND id=ANY($2)
                    """, connection, transaction);
                vector.Parameters.AddWithValue(lease.SourceId);
                vector.Parameters.AddWithValue(chunks.Select(chunk => chunk.Id).ToArray());
                await vector.ExecuteNonQueryAsync(ct);
            }
            catch (PostgresException error) when (!ct.IsCancellationRequested && error.SqlState is "42703" or "42883" or "42704" or "42501" or "22023" or "54000")
            {
                await transaction.RollbackAsync("optional_vector", ct);
            }
            await transaction.ReleaseAsync("optional_vector", ct);
        }
        await using var stats = new NpgsqlCommand("UPDATE knowledge_sources SET chunk_count=(SELECT count(*)::integer FROM knowledge_chunks WHERE source_id=$1) WHERE source_id=$1", connection, transaction);
        stats.Parameters.AddWithValue(lease.SourceId);
        await stats.ExecuteNonQueryAsync(ct);
        await transaction.CommitAsync(ct);
    }

    internal async Task FinishAsync(KnowledgeLease lease, string status, string? error, CancellationToken ct)
    {
        await using var connection = await db.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);
        await LockLeaseAsync(connection, transaction, lease, ct);
        await using (var source = new NpgsqlCommand("""
            UPDATE knowledge_sources SET status=CASE WHEN $2='ready' AND (cardinality(failed_pages)>0 OR chunk_count=0) THEN 'partial' ELSE $2 END,
                error_message=$3,indexed_at=CASE WHEN $2='ready' AND cardinality(failed_pages)=0 AND chunk_count>0 THEN clock_timestamp() ELSE NULL END
            WHERE source_id=$1
            """, connection, transaction))
        {
            source.Parameters.AddWithValue(lease.SourceId); source.Parameters.AddWithValue(status);
            source.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Text, Value = (object?)error ?? DBNull.Value });
            await source.ExecuteNonQueryAsync(ct);
        }
        await using (var job = new NpgsqlCommand("""
            UPDATE knowledge_jobs SET status=$3,last_error=$4,lease_token=NULL,lease_until=NULL WHERE source_id=$1 AND lease_token=$2
            """, connection, transaction))
        {
            job.Parameters.AddWithValue(lease.SourceId); job.Parameters.AddWithValue(lease.Token);
            job.Parameters.AddWithValue(status == "ready" ? "completed" : "failed");
            job.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Text, Value = (object?)error ?? DBNull.Value });
            await job.ExecuteNonQueryAsync(ct);
        }
        await transaction.CommitAsync(ct);
    }

    internal async Task ReleaseAsync(KnowledgeLease lease, CancellationToken ct)
    {
        // On orderly shutdown, immediately make the same durable file available for a fresh claim.
        await using var connection = await db.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);
        await using var command = new NpgsqlCommand("""
            UPDATE knowledge_jobs SET status='queued',lease_token=NULL,lease_until=NULL,queued_at=clock_timestamp()
            WHERE source_id=$1 AND lease_token=$2 AND status='processing' RETURNING source_id
            """, connection, transaction);
        command.Parameters.AddWithValue(lease.SourceId); command.Parameters.AddWithValue(lease.Token);
        if (await command.ExecuteScalarAsync(ct) is Guid)
        {
            await using var source = new NpgsqlCommand("UPDATE knowledge_sources SET status='queued',indexed_at=NULL WHERE source_id=$1", connection, transaction);
            source.Parameters.AddWithValue(lease.SourceId);
            await source.ExecuteNonQueryAsync(ct);
        }
        await transaction.CommitAsync(ct);
    }

    public async Task<IReadOnlyList<KnowledgeHit>> SearchAsync(float[] embedding, string profile, int topK, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(embedding);
        ValidateEmbedding(embedding, embedding.Length);
        if (string.IsNullOrWhiteSpace(profile)) throw new ArgumentException("An embedding profile is required.", nameof(profile));
        topK = Math.Clamp(topK, 1, 100);
        await using var connection = await db.OpenConnectionAsync(cancellationToken);
        var vectorSchema = await VectorSchemaAsync(connection, null, cancellationToken);
        if (vectorSchema is not null && embedding.Length <= 16000)
        {
            try
            {
                // A late-installed extension or interrupted optional backfill must not hide real[] chunks.
                if (await VectorCoverageAsync(connection, vectorSchema, profile, embedding.Length, cancellationToken))
                    return await VectorSearchAsync(connection, vectorSchema, embedding, profile, topK, cancellationToken);
            }
            catch (PostgresException error) when (error.SqlState is "42703" or "42883" or "42704" or "42501" or "22023" or "54000")
            { /* An extension removed after detection must not disable the real[] fallback. */ }
        }
        return await CosineSearchAsync(connection, embedding, profile, topK, cancellationToken);
    }

    private static async Task<bool> VectorCoverageAsync(NpgsqlConnection connection, string schema, string profile, int dimensions, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand($"""
            SELECT NOT EXISTS(SELECT 1 FROM knowledge_chunks c JOIN knowledge_sources s ON s.source_id=c.source_id
                WHERE s.is_active AND s.status='ready' AND length(btrim(s.permission_note))>0 AND c.profile=$1 AND cardinality(c.embedding)=$2
                AND (c.embedding_vector IS NULL OR {Quote(schema)}.vector_dims(c.embedding_vector)<>$2))
            """, connection);
        command.Parameters.AddWithValue(profile); command.Parameters.AddWithValue(dimensions);
        return (bool)(await command.ExecuteScalarAsync(ct))!;
    }

    private static async Task<IReadOnlyList<KnowledgeHit>> VectorSearchAsync(NpgsqlConnection connection, string schema,
        float[] embedding, string profile, int topK, CancellationToken ct)
    {
        var ns = Quote(schema);
        // MATERIALIZED prevents the planner evaluating cosine on other profiles/dimensions.
        // No ANN index is required: this ordering remains an exact cosine search.
        await using var command = new NpgsqlCommand($"""
            WITH eligible AS MATERIALIZED (
                SELECT c.id,c.source_id,s.title,s.category,c.page_number,c.chunk_number,c.content,c.embedding_vector
                FROM knowledge_chunks c JOIN knowledge_sources s ON s.source_id=c.source_id
                WHERE s.is_active AND s.status='ready' AND length(btrim(s.permission_note))>0
                AND c.profile=$1 AND cardinality(c.embedding)=$2 AND c.embedding_vector IS NOT NULL
                AND {ns}.vector_dims(c.embedding_vector)=$2
            )
            SELECT id,source_id,title,category,page_number,chunk_number,content,
                1-(embedding_vector OPERATOR({ns}.<=>) $3::{ns}.vector) AS similarity
            FROM eligible ORDER BY embedding_vector OPERATOR({ns}.<=>) $3::{ns}.vector,id LIMIT $4
            """, connection);
        command.Parameters.AddWithValue(profile); command.Parameters.AddWithValue(embedding.Length);
        command.Parameters.AddWithValue(VectorLiteral(embedding)); command.Parameters.AddWithValue(topK);
        var result = new List<KnowledgeHit>();
        await using var reader = await command.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            if (!reader.IsDBNull(7) && double.IsFinite(reader.GetDouble(7)))
                result.Add(ReadHit(reader, Math.Clamp(reader.GetDouble(7), -1, 1)));
        }
        return result;
    }

    private static async Task<IReadOnlyList<KnowledgeHit>> CosineSearchAsync(NpgsqlConnection connection,
        float[] embedding, string profile, int topK, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand("""
            SELECT c.id,c.source_id,s.title,s.category,c.page_number,c.chunk_number,c.content,c.embedding
            FROM knowledge_chunks c JOIN knowledge_sources s ON s.source_id=c.source_id
            WHERE s.is_active AND s.status='ready' AND length(btrim(s.permission_note))>0 AND c.profile=$1 AND cardinality(c.embedding)=$2
            ORDER BY c.id
            """, connection);
        command.Parameters.AddWithValue(profile); command.Parameters.AddWithValue(embedding.Length);
        double queryNorm = 0;
        foreach (var value in embedding) queryNorm += (double)value * value;
        var best = new PriorityQueue<KnowledgeHit, double>();
        await using var reader = await command.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            ct.ThrowIfCancellationRequested();
            var stored = reader.GetFieldValue<float[]>(7);
            double dot = 0, norm = 0;
            var valid = stored.Length == embedding.Length;
            for (var i = 0; valid && i < stored.Length; i++)
            {
                if (!float.IsFinite(stored[i])) { valid = false; break; }
                dot += (double)stored[i] * embedding[i]; norm += (double)stored[i] * stored[i];
            }
            if (!valid || norm <= 0) continue;
            var similarity = Math.Clamp(dot / Math.Sqrt(norm * queryNorm), -1, 1);
            if (best.Count < topK || (best.TryPeek(out _, out var minimum) && similarity > minimum))
            {
                best.Enqueue(ReadHit(reader, similarity), similarity);
                if (best.Count > topK) best.Dequeue();
            }
        }
        return best.UnorderedItems.Select(item => item.Element).OrderByDescending(hit => hit.Similarity).ThenBy(hit => hit.Id).ToArray();
    }

    private static async Task<string?> VectorSchemaAsync(NpgsqlConnection connection, NpgsqlTransaction? transaction, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand("""
            SELECT n.nspname FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid
            JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_extension e ON e.extnamespace=n.oid AND e.extname=$3
            WHERE a.attrelid=to_regclass($1) AND a.attname=$2 AND NOT a.attisdropped AND t.typname=$3
            """, connection, transaction);
        command.Parameters.AddWithValue("knowledge_chunks"); command.Parameters.AddWithValue("embedding_vector"); command.Parameters.AddWithValue("vector");
        return await command.ExecuteScalarAsync(ct) as string;
    }

    internal static void ValidateEmbedding(float[]? embedding, int dimensions)
    {
        if (embedding is null || dimensions <= 0 || embedding.Length != dimensions || embedding.Any(value => !float.IsFinite(value)) || !embedding.Any(value => value != 0))
            throw new InvalidDataException("Embedding must be a finite, nonzero vector with the configured dimensions.");
    }
    private static string Quote(string identifier) => new NpgsqlCommandBuilder().QuoteIdentifier(identifier);
    private static string VectorLiteral(float[] embedding) => "[" + string.Join(",", embedding.Select(value => value.ToString("R", CultureInfo.InvariantCulture))) + "]";
    private static KnowledgeHit ReadHit(NpgsqlDataReader r, double similarity) => new(r.GetGuid(0), r.GetGuid(1), r.GetString(2), r.GetString(3), r.GetInt32(4), r.GetInt32(5), r.GetString(6), similarity);
    private static KnowledgeSourceDto ReadSource(NpgsqlDataReader r) => new(r.GetGuid(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetString(4), r.GetString(5), r.GetDateTime(6), r.GetBoolean(7), r.GetString(8), r.GetInt32(9), r.GetInt32(10), r.GetFieldValue<int[]>(11), r.IsDBNull(12) ? null : r.GetString(12), r.IsDBNull(13) ? null : r.GetDateTime(13));
}
