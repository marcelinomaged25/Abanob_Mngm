using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

internal sealed record KnowledgeExtraction(IReadOnlyList<KnowledgePage> Pages, int[] FailedPages, bool RequiresOcr, string? Error);

internal sealed class KnowledgeIngestionWorker : BackgroundService
{
    private readonly KnowledgeStore store;
    private readonly IAiProvider provider;
    private readonly IConfiguration configuration;
    private readonly ILogger<KnowledgeIngestionWorker> logger;
    private readonly HttpClient ocrClient = new(new SocketsHttpHandler { AllowAutoRedirect = false }) { Timeout = Timeout.InfiniteTimeSpan };
    private const int MaxPages = 1000;
    private const int MaxChunks = 10000;
    private const int MaxExtractedChars = 30 * 1024 * 1024;
    private static readonly Regex PageMarker = new(@"^\s*={5}\s*صفحة\s+([0-9٠-٩۰-۹]+)\s*={5}\s*$", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));

    public KnowledgeIngestionWorker(KnowledgeStore store, IAiProvider provider, IConfiguration configuration, ILogger<KnowledgeIngestionWorker> logger)
    {
        this.store = store; this.provider = provider; this.configuration = configuration; this.logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { await BootstrapAsync(stoppingToken); }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { return; }
        catch (Exception error) { logger.LogError("Knowledge bootstrap failed: {Code}", error.GetType().Name); }
        while (!stoppingToken.IsCancellationRequested)
        {
            KnowledgeLease? lease = null;
            try
            {
                lease = await store.ClaimAsync(stoppingToken);
                if (lease is null) { await Task.Delay(TimeSpan.FromSeconds(3), stoppingToken); continue; }
                await ProcessWithHeartbeatAsync(lease, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (KnowledgeLeaseLostException) { logger.LogInformation("Knowledge lease was superseded; stale work was discarded."); }
            catch (Exception error)
            {
                logger.LogError("Knowledge ingestion failed for {SourceId}: {Code}", lease?.SourceId, error is Npgsql.PostgresException postgres ? postgres.SqlState : error.GetType().Name);
                try { await Task.Delay(TimeSpan.FromSeconds(3), stoppingToken); }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            }
        }
    }

    private async Task ProcessWithHeartbeatAsync(KnowledgeLease lease, CancellationToken stoppingToken)
    {
        using var work = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
        using var heartbeatStop = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
        var heartbeat = HeartbeatAsync(lease, work, heartbeatStop.Token);
        try
        {
            await ProcessAsync(lease, work.Token);
        }
        catch (OperationCanceledException) when (work.IsCancellationRequested)
        {
            if (!stoppingToken.IsCancellationRequested) throw new KnowledgeLeaseLostException();
        }
        catch (KnowledgeLeaseLostException) { throw; }
        catch (Exception error)
        {
            // Do not expose external response bodies, credentials, or internal exception details in source DTOs.
            var message = error switch
            {
                InvalidDataException => error.Message,
                DecoderFallbackException => "The source is not valid UTF-8.",
                JsonException => "The extraction service returned invalid JSON.",
                HttpRequestException => "The extraction service could not be reached or rejected the request.",
                OperationCanceledException => "Extraction or embedding exceeded its bounded timeout.",
                _ => "Ingestion failed; review the worker logs and requeue this source."
            };
            logger.LogWarning("Knowledge source {SourceId} failed ingestion: {Code}", lease.SourceId, error is AiProviderException providerError ? providerError.Code : error.GetType().Name);
            using var failureTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await store.FinishAsync(lease, "failed", message[..Math.Min(message.Length, 1500)], failureTimeout.Token);
        }
        finally
        {
            heartbeatStop.Cancel();
            try { await heartbeat; }
            catch (OperationCanceledException) { }
            if (stoppingToken.IsCancellationRequested)
            {
                using var releaseTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                try { await store.ReleaseAsync(lease, releaseTimeout.Token); }
                catch (Exception error) { logger.LogWarning("Knowledge lease will recover on expiry after shutdown: {Code}", error.GetType().Name); }
            }
        }
    }

    private async Task HeartbeatAsync(KnowledgeLease lease, CancellationTokenSource work, CancellationToken ct)
    {
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(20));
            while (await timer.WaitForNextTickAsync(ct))
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(TimeSpan.FromSeconds(15));
                await store.RenewAsync(lease, timeout.Token);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (Exception error)
        {
            logger.LogWarning("Knowledge heartbeat lost its lease for {SourceId}: {Code}", lease.SourceId, error.GetType().Name);
            work.Cancel();
        }
    }

    private async Task ProcessAsync(KnowledgeLease lease, CancellationToken ct)
    {
        KnowledgeEndpoints.ValidateFile(lease.FileType, lease.Bytes);
        await store.RenewAsync(lease, ct);
        var extraction = lease.FileType switch
        {
            ".jsonl" => ParseJsonl(KnowledgeEndpoints.StrictUtf8.GetString(lease.Bytes), ct),
            ".txt" => ParseText(KnowledgeEndpoints.StrictUtf8.GetString(lease.Bytes), ct),
            ".pdf" => await ExtractPdfAsync(lease, ct),
            _ => throw new InvalidDataException("Unsupported source type.")
        };
        await store.SavePagesAsync(lease, extraction.Pages, extraction.FailedPages, extraction.Error, ct);
        if (extraction.Pages.Count == 0)
        {
            await store.FinishAsync(lease, extraction.RequiresOcr ? "needs_ocr" : "failed",
                extraction.Error ?? "No usable pages were extracted.", ct);
            return;
        }
        if (extraction.FailedPages.Length > 0 || extraction.RequiresOcr)
        {
            await store.FinishAsync(lease, extraction.RequiresOcr ? "needs_ocr" : "partial", extraction.Error, ct);
            return;
        }
        if (!provider.IsConfigured)
        {
            await store.FinishAsync(lease, extraction.RequiresOcr ? "needs_ocr" : "awaiting_embedding",
                extraction.Error ?? "Embedding provider is not configured; pages are stored but this source is not searchable.", ct);
            return;
        }
        var profile = provider.EmbeddingProfile;
        var dimensions = provider.Dimensions;
        if (string.IsNullOrWhiteSpace(profile) || dimensions <= 0) throw new InvalidDataException("The embedding provider profile or dimensions are invalid.");
        var batch = new List<KnowledgePendingChunk>(20);
        var chunkCount = 0;
        foreach (var page in extraction.Pages)
        {
            var number = 0;
            foreach (var content in ChunkPage(page.Text, ct))
            {
                if (++chunkCount > MaxChunks) throw new InvalidDataException("Source exceeds the safe 10000-chunk ingestion limit.");
                batch.Add(new KnowledgePendingChunk(Guid.NewGuid(), page.PageNumber, ++number, content));
                if (batch.Count == 20) { await EmbedBatchAsync(lease, batch, profile, dimensions, ct); batch.Clear(); }
            }
        }
        if (batch.Count > 0) await EmbedBatchAsync(lease, batch, profile, dimensions, ct);
        var status = extraction.FailedPages.Length > 0 ? "partial" : extraction.RequiresOcr ? "needs_ocr" : chunkCount > 0 ? "ready" : "failed";
        await store.FinishAsync(lease, status, extraction.Error ?? (chunkCount == 0 ? "No usable chunks were extracted." : null), ct);
    }

    private async Task EmbedBatchAsync(KnowledgeLease lease, List<KnowledgePendingChunk> batch, string profile, int dimensions, CancellationToken ct)
    {
        // Both the heartbeat and this explicit pre-batch renewal protect provider retry/backoff time.
        await store.RenewAsync(lease, ct);
        if (provider.EmbeddingProfile != profile || provider.Dimensions != dimensions) throw new InvalidDataException("Embedding configuration changed during ingestion; requeue this source.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromMinutes(3));
        var vectors = await provider.EmbedAsync(batch.Select(chunk => chunk.Content).ToArray(), false, timeout.Token);
        if (provider.EmbeddingProfile != profile || provider.Dimensions != dimensions) throw new InvalidDataException("Embedding configuration changed during ingestion; requeue this source.");
        await store.RenewAsync(lease, ct);
        await store.SaveBatchAsync(lease, batch, vectors, profile, dimensions, ct);
    }

    private async Task<KnowledgeExtraction> ExtractPdfAsync(KnowledgeLease lease, CancellationToken ct)
    {
        var configuredUrl = configuration["KNOWLEDGE_OCR_URL"]?.Trim();
        if (string.IsNullOrWhiteSpace(configuredUrl))
            return new KnowledgeExtraction([], [], true, "PDF extraction is unavailable: configure KNOWLEDGE_OCR_URL and KNOWLEDGE_OCR_SECRET, then requeue. No pages have been indexed.");
        if (!Uri.TryCreate(configuredUrl, UriKind.Absolute, out var baseUri) || baseUri.Scheme is not ("http" or "https") || !string.IsNullOrEmpty(baseUri.UserInfo) || !string.IsNullOrEmpty(baseUri.Query) || !string.IsNullOrEmpty(baseUri.Fragment))
            throw new InvalidDataException("KNOWLEDGE_OCR_URL must be an HTTP(S) service URL without embedded credentials, query, or fragment.");
        var secret = configuration["KNOWLEDGE_OCR_SECRET"];
        if (string.IsNullOrWhiteSpace(secret))
            return new KnowledgeExtraction([], [], true, "PDF extraction is unavailable: KNOWLEDGE_OCR_SECRET is not configured. No pages have been indexed.");
        var endpoint = new Uri(baseUri.AbsoluteUri.TrimEnd('/') + (baseUri.AbsolutePath.TrimEnd('/').EndsWith("/extract", StringComparison.Ordinal) ? "" : "/extract"));
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint);
        request.Headers.Add("X-Worker-Secret", secret);
        using var multipart = new MultipartFormDataContent();
        using var file = new ByteArrayContent(lease.Bytes);
        file.Headers.ContentType = new MediaTypeHeaderValue("application/pdf");
        multipart.Add(file, "file", lease.FileName);
        request.Content = multipart;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var seconds = int.TryParse(configuration["KNOWLEDGE_OCR_TIMEOUT_SECONDS"], out var configuredSeconds) ? Math.Clamp(configuredSeconds, 10, 180) : 120;
        timeout.CancelAfter(TimeSpan.FromSeconds(seconds));
        using var response = await ocrClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
        var bytes = await KnowledgeEndpoints.ReadLimitedAsync(stream, 40 * 1024 * 1024, timeout.Token);
        using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 32 });
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("pages", out var pageArray) || pageArray.ValueKind != JsonValueKind.Array ||
            !root.TryGetProperty("failedPages", out var failures) || failures.ValueKind != JsonValueKind.Array ||
            !root.TryGetProperty("requiresOcr", out var needsOcr) || needsOcr.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw new InvalidDataException("OCR response must contain pages, failedPages, and requiresOcr.");
        var pages = new SortedDictionary<int, string>();
        var failed = new SortedSet<int>();
        foreach (var failure in failures.EnumerateArray())
        {
            if (!failure.TryGetInt32(out var number) || number <= 0) throw new InvalidDataException("OCR failedPages must contain positive page numbers.");
            failed.Add(number);
        }
        var total = 0;
        foreach (var page in pageArray.EnumerateArray())
        {
            ct.ThrowIfCancellationRequested();
            if (page.ValueKind != JsonValueKind.Object || !page.TryGetProperty("pageNumber", out var numberValue) || !numberValue.TryGetInt32(out var number) || number <= 0 ||
                !page.TryGetProperty("text", out var textValue) || textValue.ValueKind != JsonValueKind.String)
                throw new InvalidDataException("OCR pages must have a positive pageNumber and text.");
            var text = Normalize(textValue.GetString()!);
            if (pages.ContainsKey(number)) { failed.Add(number); continue; }
            if (!UsableText(text)) { failed.Add(number); continue; }
            total += text.Length;
            if (total > MaxExtractedChars || pages.Count >= MaxPages) throw new InvalidDataException("OCR extraction exceeds the safe page/text limit.");
            pages.Add(number, text);
        }
        if (failed.Count > MaxPages) throw new InvalidDataException("OCR extraction exceeds the safe failed-page limit.");
        return new KnowledgeExtraction(pages.Select(page => new KnowledgePage(page.Key, page.Value)).ToArray(), failed.ToArray(), needsOcr.GetBoolean(),
            failed.Count > 0 ? "Some PDF pages failed extraction; this source is not searchable until all failed pages are recovered." :
            needsOcr.GetBoolean() ? "The extraction service reports that OCR is still required; this source is not searchable." : null);
    }

    internal static KnowledgeExtraction ParseJsonl(string text, CancellationToken ct)
    {
        var pages = new SortedDictionary<int, SortedDictionary<int, string>>();
        var failed = new SortedSet<int>();
        var unknownFailures = false;
        string? expectedSource = null;
        using var input = new StringReader(text.TrimStart('\uFEFF'));
        string? line;
        var lineNumber = 0;
        var total = 0;
        while ((line = input.ReadLine()) is not null)
        {
            ct.ThrowIfCancellationRequested();
            lineNumber++;
            if (string.IsNullOrWhiteSpace(line)) continue;
            var pageNumber = 0;
            try
            {
                using var document = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 16 });
                var item = document.RootElement;
                if (item.ValueKind != JsonValueKind.Object || !item.TryGetProperty("page", out var page) || !page.TryGetInt32(out pageNumber) || pageNumber <= 0)
                    throw new InvalidDataException("Invalid JSONL page.");
                if (!item.TryGetProperty("chunk", out var chunk) || !chunk.TryGetInt32(out var chunkNumber) || chunkNumber < 0 ||
                    !item.TryGetProperty("text", out var content) || content.ValueKind != JsonValueKind.String ||
                    !item.TryGetProperty("source", out var source) || source.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(source.GetString()))
                    throw new InvalidDataException("JSONL records require source, page, chunk, and text.");
                var sourceName = source.GetString()!.Trim();
                expectedSource ??= sourceName;
                if (sourceName != expectedSource) throw new InvalidDataException("One uploaded JSONL file must describe one source.");
                var value = Normalize(content.GetString()!);
                if (!UsableText(value)) throw new InvalidDataException("JSONL chunk is blank or HTML-only.");
                total += value.Length;
                if (total > MaxExtractedChars) throw new InvalidDataException("JSONL extraction exceeds the text limit.");
                if (!pages.TryGetValue(pageNumber, out var chunks))
                {
                    if (pages.Count >= MaxPages) throw new InvalidDataException("JSONL extraction exceeds the page limit.");
                    pages.Add(pageNumber, chunks = new SortedDictionary<int, string>());
                }
                if (chunks.TryGetValue(chunkNumber, out var previous))
                {
                    if (previous != value) failed.Add(pageNumber);
                    continue; // Identical duplicate rows must not duplicate page text.
                }
                chunks.Add(chunkNumber, value);
            }
            catch (Exception error) when (error is JsonException or InvalidDataException or InvalidOperationException or FormatException)
            {
                if (pageNumber > 0) failed.Add(pageNumber);
                else { failed.Add(1); unknownFailures = true; }
            }
        }
        var reconstructed = new List<KnowledgePage>();
        foreach (var page in pages)
        {
            ct.ThrowIfCancellationRequested();
            var content = new StringBuilder();
            int? previousNumber = null;
            foreach (var chunk in page.Value)
            {
                if (previousNumber is int previous && (long)chunk.Key != (long)previous + 1) failed.Add(page.Key);
                previousNumber = chunk.Key;
                AppendWithoutOverlap(content, chunk.Value);
            }
            if (content.Length > 0) reconstructed.Add(new KnowledgePage(page.Key, content.ToString()));
        }
        return new KnowledgeExtraction(reconstructed, failed.ToArray(), false,
            failed.Count == 0 ? null : unknownFailures
                ? "Invalid JSONL records included unknown page numbers (reported against page 1); this source is not searchable."
                : "Some JSONL pages contain invalid, conflicting, or unsafe records; this source is not searchable.");
    }

    internal static KnowledgeExtraction ParseText(string text, CancellationToken ct)
    {
        var pages = new SortedDictionary<int, StringBuilder>();
        var failed = new SortedSet<int>();
        var markedPages = new HashSet<int>();
        var pageNumber = 1;
        using var input = new StringReader(text.TrimStart('\uFEFF'));
        string? line;
        while ((line = input.ReadLine()) is not null)
        {
            ct.ThrowIfCancellationRequested();
            var marker = PageMarker.Match(line);
            if (marker.Success)
            {
                var digits = string.Concat(marker.Groups[1].Value.Select(c => c is >= '٠' and <= '٩' ? (char)('0' + c - '٠') : c is >= '۰' and <= '۹' ? (char)('0' + c - '۰') : c));
                if (!int.TryParse(digits, out pageNumber) || pageNumber <= 0) throw new InvalidDataException("TXT page markers require a positive page number.");
                if (!markedPages.Add(pageNumber)) failed.Add(pageNumber);
                if (!pages.ContainsKey(pageNumber)) pages.Add(pageNumber, new StringBuilder());
            }
            else
            {
                if (!pages.TryGetValue(pageNumber, out var content)) pages.Add(pageNumber, content = new StringBuilder());
                content.AppendLine(line);
            }
            if (pages.Count > MaxPages) throw new InvalidDataException("TXT exceeds the safe page limit.");
        }
        var result = new List<KnowledgePage>();
        foreach (var page in pages)
        {
            var value = Normalize(page.Value.ToString());
            if (UsableText(value)) result.Add(new KnowledgePage(page.Key, value));
            else if (markedPages.Contains(page.Key) || pages.Count == 1) failed.Add(page.Key);
        }
        return new KnowledgeExtraction(result, failed.ToArray(), false, failed.Count > 0 ? "Some TXT pages are empty, unsafe, or have repeated page markers; this source is not searchable." : null);
    }

    private static void AppendWithoutOverlap(StringBuilder previous, string next)
    {
        if (previous.Length == 0) { previous.Append(next); return; }
        // KMP computes the actual longest suffix/prefix match, not an assumed fixed overlap.
        var prefix = new int[next.Length];
        for (var i = 1; i < next.Length; i++)
        {
            var j = prefix[i - 1];
            while (j > 0 && next[i] != next[j]) j = prefix[j - 1];
            if (next[i] == next[j]) j++;
            prefix[i] = j;
        }
        var matched = 0;
        for (var i = Math.Max(0, previous.Length - next.Length); i < previous.Length; i++)
        {
            while (matched > 0 && (matched == next.Length || next[matched] != previous[i])) matched = prefix[matched - 1];
            if (next[matched] == previous[i]) matched++;
        }
        // A coincidental matching letter is not evidence of chunk overlap.
        if (matched >= 20 || matched == next.Length) previous.Append(next.AsSpan(matched));
        else { previous.Append('\n'); previous.Append(next); }
    }

    internal static IEnumerable<string> ChunkPage(string text, CancellationToken ct)
    {
        text = Normalize(text);
        var start = 0;
        while (start < text.Length)
        {
            ct.ThrowIfCancellationRequested();
            var remaining = text.Length - start;
            var end = text.Length;
            if (remaining > 1500)
            {
                var target = start + Math.Min(1100, remaining - 700);
                end = target;
                for (var distance = 0; distance <= 150; distance++)
                {
                    var left = target - distance;
                    var right = target + distance;
                    if (left - start >= 800 && (char.IsWhiteSpace(text[left - 1]) || text[left - 1] is '.' or '؟' or '!' or '؛')) { end = left; break; }
                    if (text.Length - right + 100 >= 800 && (char.IsWhiteSpace(text[right - 1]) || text[right - 1] is '.' or '؟' or '!' or '؛')) { end = right; break; }
                }
            }
            if (end < text.Length && char.IsHighSurrogate(text[end - 1]) && char.IsLowSurrogate(text[end])) end--;
            var chunk = text[start..end].Trim();
            if (chunk.Length > 0) yield return chunk;
            if (end == text.Length) break;
            start = end - 100;
            if (start > 0 && char.IsLowSurrogate(text[start]) && char.IsHighSurrogate(text[start - 1])) start--;
        }
    }

    private static string Normalize(string text) => text.Replace("\r\n", "\n").Replace('\r', '\n').Trim('\uFEFF', ' ', '\t', '\n');
    private static bool UsableText(string text) => !string.IsNullOrWhiteSpace(text) && !text.Contains('\0') &&
        !Regex.IsMatch(text[..Math.Min(text.Length, 4096)], @"^\s*(?:<!--[\s\S]*?-->\s*)*<(?:!doctype\s+html|\?xml\b|(?:html|head|body|script|div|p|span|section|article|main|h[1-6]|table|ul|ol|li|svg|iframe|object|embed|link|meta|style|img)\b)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));

    private async Task BootstrapAsync(CancellationToken ct)
    {
        var path = configuration["KNOWLEDGE_BOOTSTRAP_PATH"]?.Trim();
        var development = string.Equals(configuration["ASPNETCORE_ENVIRONMENT"] ?? configuration["DOTNET_ENVIRONMENT"], "Development", StringComparison.OrdinalIgnoreCase);
        if (string.IsNullOrWhiteSpace(path) && development)
        {
            // Development-only discovery is constrained to supplied root/output, never a filesystem-wide scan.
            var root = Directory.GetCurrentDirectory();
            var explicitRoot = configuration["KNOWLEDGE_BOOTSTRAP_ROOT"];
            if (!string.IsNullOrWhiteSpace(explicitRoot)) root = Path.GetFullPath(explicitRoot);
            else
            {
                var current = new DirectoryInfo(root);
                if (current.Name == "FollowUp.Api" && current.Parent?.Name == "dotnet-api" && current.Parent.Parent is not null)
                    root = current.Parent.Parent.FullName;
            }
            var candidates = new List<string>();
            foreach (var folder in new[] { root, Path.Combine(root, "output") })
                if (Directory.Exists(folder)) candidates.AddRange(Directory.EnumerateFiles(folder, "*.jsonl", SearchOption.TopDirectoryOnly));
            var unique = candidates.Distinct(StringComparer.OrdinalIgnoreCase).Take(2).ToArray();
            if (unique.Length == 1) path = unique[0];
            else if (unique.Length > 1) logger.LogWarning("Multiple bootstrap JSONL files found; set KNOWLEDGE_BOOTSTRAP_PATH explicitly. None were imported.");
        }
        if (string.IsNullOrWhiteSpace(path)) return;
        path = Path.GetFullPath(path);
        if (!string.Equals(Path.GetExtension(path), ".jsonl", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Bootstrap source must be an explicitly supplied JSONL file.");
        await using var input = File.OpenRead(path);
        var bytes = await KnowledgeEndpoints.ReadLimitedAsync(input, KnowledgeEndpoints.MaxFileBytes, ct);
        KnowledgeEndpoints.ValidateFile(".jsonl", bytes);
        var metadata = new KnowledgeSourceSave("كنيستي الأرثوذكسية... ما أجملك", "الطقوس", "الشماس الإكليريكى الدكتور / سامح حلمى إبراهيم",
            "المصدر مقدم من مسؤول الخدمة للاستخدام التعليمي؛ يجب مراجعة حق الاستخدام قبل النشر.", true);
        var source = await store.CreateAsync(metadata, Path.GetFileName(path), ".jsonl", bytes, KnowledgeEndpoints.Hash(bytes), true, ct);
        logger.LogInformation("Durable bootstrap source {SourceId} has status {Status}; file-hash import is idempotent.", source.SourceId, source.Status);
    }

    public override void Dispose() { ocrClient.Dispose(); base.Dispose(); }
}
