using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using Npgsql;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

internal static class KnowledgeEndpoints
{
    internal const int MaxFileBytes = 20 * 1024 * 1024;
    internal static readonly UTF8Encoding StrictUtf8 = new(false, true);

    public static void Map(RouteGroupBuilder api)
    {
        // All management routes inherit the existing header-authenticated servant API group.
        var knowledge = api.MapGroup("/knowledge");
        knowledge.MapGet("/sources", async (KnowledgeStore store, CancellationToken ct) => Results.Ok(await store.SourcesAsync(ct)));
        knowledge.MapPost("/sources", UploadAsync)
            .WithMetadata(new RequestSizeLimitAttribute(MaxFileBytes + 65536))
            .DisableAntiforgery(); // Only multipart; authentication is supplied through headers, not cookies.
        knowledge.MapPut("/sources/{sourceId:guid}", async (Guid sourceId, KnowledgeSourceSave payload, KnowledgeStore store, CancellationToken ct) =>
        {
            var error = ValidateMetadata(payload);
            if (error is not null) return Results.BadRequest(new { error });
            var source = await store.UpdateAsync(sourceId, payload, ct);
            return source is null ? Results.NotFound() : Results.Ok(source);
        });
        knowledge.MapDelete("/sources/{sourceId:guid}", async (Guid sourceId, KnowledgeStore store, CancellationToken ct) =>
            await store.DeleteAsync(sourceId, ct) ? Results.NoContent() : Results.NotFound());
        knowledge.MapGet("/sources/{sourceId:guid}", async (Guid sourceId, KnowledgeStore store, CancellationToken ct) =>
        {
            var source = await store.SourceAsync(sourceId, ct);
            return source is null ? Results.NotFound() : Results.Ok(source);
        });
        knowledge.MapPost("/sources/{sourceId:guid}/ingest", async (Guid sourceId, KnowledgeStore store, CancellationToken ct) =>
            await store.QueueAsync(sourceId, ct)
                ? Results.Accepted($"/api/knowledge/sources/{sourceId}", new { sourceId, status = "queued" })
                : Results.NotFound());
        knowledge.MapGet("/chunks/{sourceId:guid}", async (Guid sourceId, int? offset, int? limit, KnowledgeStore store, CancellationToken ct) =>
        {
            if (offset is < 0 || limit is < 1) return Results.BadRequest(new { error = "offset must be nonnegative and limit must be positive." });
            var result = await store.ChunksAsync(sourceId, offset ?? 0, Math.Min(limit ?? 50, 100), ct);
            return result is null ? Results.NotFound() : Results.Ok(result);
        });
    }

    public static async Task InitializeAsync(NpgsqlDataSource db, CancellationToken cancellationToken = default)
    {
        var path = Path.Combine(AppContext.BaseDirectory, "knowledge-schema.sql");
        var sql = await File.ReadAllTextAsync(path, cancellationToken);
        await using var connection = await db.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        // Serializes additive initialization across instances without requiring extension privileges.
        await using (var advisory = new NpgsqlCommand("SELECT pg_advisory_xact_lock($1)", connection, transaction))
        {
            advisory.Parameters.AddWithValue(718624329123L);
            await advisory.ExecuteNonQueryAsync(cancellationToken);
        }
        await using var command = new NpgsqlCommand(sql, connection, transaction) { CommandTimeout = 120 };
        await command.ExecuteNonQueryAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    private static async Task<IResult> UploadAsync(HttpContext context, KnowledgeStore store, CancellationToken ct)
    {
        if (!context.Request.HasFormContentType || !context.Request.ContentType!.StartsWith("multipart/form-data", StringComparison.OrdinalIgnoreCase))
            return Results.BadRequest(new { error = "Use multipart/form-data with one file." });
        if (context.Request.ContentLength > MaxFileBytes + 65536L)
            return Results.Json(new { error = "Upload limit is 20 MB." }, statusCode: StatusCodes.Status413PayloadTooLarge);
        var bodyLimit = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
        if (bodyLimit is { IsReadOnly: false }) bodyLimit.MaxRequestBodySize = MaxFileBytes + 65536L;
        context.Features.Set<IFormFeature>(new FormFeature(context.Request, new FormOptions
        {
            MultipartBodyLengthLimit = MaxFileBytes,
            ValueLengthLimit = 8192,
            ValueCountLimit = 12,
            MultipartHeadersLengthLimit = 8192
        }));
        try
        {
            var form = await context.Request.ReadFormAsync(ct);
            if (form.Files.Count != 1 || form.Files[0].Name != "file") return Results.BadRequest(new { error = "Supply exactly one file field." });
            foreach (var name in new[] { "title", "category", "author", "permissionNote", "isActive" })
                if (form[name].Count > 1) return Results.BadRequest(new { error = "Duplicate metadata fields are not allowed." });
            var activeText = form["isActive"].ToString();
            var active = true;
            if (activeText.Length > 0 && !bool.TryParse(activeText, out active)) return Results.BadRequest(new { error = "isActive must be true or false." });
            var metadata = new KnowledgeSourceSave(form["title"].ToString(), form["category"].ToString(), form["author"].ToString(), form["permissionNote"].ToString(), active);
            var error = ValidateMetadata(metadata);
            if (error is not null) return Results.BadRequest(new { error });
            var file = form.Files[0];
            if (file.Length is <= 0 or > MaxFileBytes) return Results.BadRequest(new { error = "File must be nonempty and at most 20 MB." });
            var fileName = Path.GetFileName(file.FileName.Replace('\\', '/'));
            if (string.IsNullOrWhiteSpace(fileName) || fileName.Length > 250 || fileName.Any(char.IsControl))
                return Results.BadRequest(new { error = "Invalid file name." });
            var type = Path.GetExtension(fileName).ToLowerInvariant();
            if (type is not (".txt" or ".jsonl" or ".pdf")) return Results.BadRequest(new { error = "Only UTF-8 TXT, JSONL, and PDF are supported." });
            await using var input = file.OpenReadStream();
            var bytes = await ReadLimitedAsync(input, MaxFileBytes, ct);
            ValidateFile(type, bytes);
            var source = await store.CreateAsync(metadata, fileName, type, bytes, Hash(bytes), false, ct);
            return Results.Created($"/api/knowledge/sources/{source.SourceId}", source);
        }
        catch (DecoderFallbackException) { return Results.BadRequest(new { error = "TXT and JSONL must be valid UTF-8." }); }
        catch (InvalidDataException error) { return Results.BadRequest(new { error = error.Message }); }
        catch (BadHttpRequestException error) { return Results.Json(new { error = "Invalid or oversized multipart upload." }, statusCode: error.StatusCode); }
    }

    internal static string? ValidateMetadata(KnowledgeSourceSave metadata)
    {
        if (string.IsNullOrWhiteSpace(metadata.Title) || metadata.Title.Trim().Length > 300) return "Title is required (maximum 300 characters).";
        if (string.IsNullOrWhiteSpace(metadata.PermissionNote) || metadata.PermissionNote.Trim().Length > 4000)
            return "An explicit permission note is required (maximum 4000 characters); do not invent a legal license.";
        if (!(new[] { "الكتاب المقدس", "الطقوس", "العقيدة", "التفاسير", "الألحان", "اللغة القبطية", "كتب أخرى" }).Contains(metadata.Category?.Trim())) return "Choose a supported source category.";
        if (metadata.Author?.Length > 300) return "Author is too long.";
        if (new[] { metadata.Title, metadata.Category, metadata.Author, metadata.PermissionNote }.Any(value => value?.Contains('\0') == true)) return "Metadata cannot contain NUL characters.";
        return null;
    }

    internal static void ValidateFile(string type, byte[] bytes)
    {
        if (bytes.Length is <= 0 or > MaxFileBytes) throw new InvalidDataException("File must be nonempty and at most 20 MB.");
        if (type == ".pdf")
        {
            if (bytes.Length < 8 || !bytes.AsSpan(0, 5).SequenceEqual("%PDF-"u8)) throw new InvalidDataException("The file does not have a valid PDF magic header.");
            return;
        }
        if (type is not (".txt" or ".jsonl")) throw new InvalidDataException("Unsafe or unsupported file extension.");
        var text = StrictUtf8.GetString(bytes).TrimStart('\uFEFF', ' ', '\t', '\r', '\n');
        if (string.IsNullOrWhiteSpace(text) || text.Contains('\0')) throw new InvalidDataException("Text must be nonempty UTF-8 without NUL characters.");
        if (Regex.IsMatch(text[..Math.Min(text.Length, 4096)], @"^\s*(?:<!--[\s\S]*?-->\s*)*<(?:!doctype\s+html|\?xml\b|(?:html|head|body|script|div|p|span|section|article|main|h[1-6]|table|ul|ol|li|svg|iframe|object|embed|link|meta|style|img)\b)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1)))
            throw new InvalidDataException("HTML/XML documents cannot be uploaded as knowledge text.");
    }

    internal static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    internal static async Task<byte[]> ReadLimitedAsync(Stream input, int maximum, CancellationToken ct)
    {
        using var output = new MemoryStream();
        var buffer = new byte[65536];
        int read;
        while ((read = await input.ReadAsync(buffer, ct)) > 0)
        {
            if (output.Length + read > maximum) throw new InvalidDataException("File or extraction response exceeds the configured size limit.");
            await output.WriteAsync(buffer.AsMemory(0, read), ct);
        }
        return output.ToArray();
    }
}
