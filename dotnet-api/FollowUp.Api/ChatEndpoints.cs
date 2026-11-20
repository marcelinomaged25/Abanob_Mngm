using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Caching.Memory;
using Npgsql;

internal sealed record ChatRequest(string? Question, string? ConversationId = null, bool Advanced = false);
internal sealed record ChatCitation(string Title, int Page, string Snippet);
internal sealed record ChatAnswer(string Answer, IReadOnlyList<ChatCitation> Sources, double Confidence, string ConversationId);

internal sealed class ChatEngine(KnowledgeStore store, IKnowledgeVectorStore vectors, IAiProvider provider, IConfiguration configuration) : IDisposable
{
    internal const string Absent = "المعلومة غير موجودة في المصادر المتاحة حاليًا.";
    private readonly MemoryCache cache = new(new MemoryCacheOptions { SizeLimit = 512 });
    private readonly SemaphoreSlim concurrent = new(2);
    private static readonly Regex Spaces = new(@"\s+", RegexOptions.Compiled, TimeSpan.FromSeconds(1));
    private readonly string modelKey = $"{configuration["AI_CHAT_MODEL"] ?? "gemini-3.1-flash-lite"}:{configuration["AI_ADVANCED_CHAT_MODEL"] ?? "default"}";

    internal async Task<ChatAnswer> AskAsync(ChatRequest input, string session, CancellationToken cancellationToken)
    {
        if (!await concurrent.WaitAsync(0, cancellationToken)) throw new AiProviderException("chat_busy");
        try
        {
            var question = Normalize(input.Question!);
            var conversationId = Guid.TryParse(input.ConversationId, out var conversation) ? conversation.ToString() : Guid.NewGuid().ToString();
            var historyKey = $"history:{session}:{conversationId}";
            var contextualQuestion = question;
            if (question.Length < 60 && Regex.IsMatch(question, "(وظيفته|معناه|معناها|دوره|وهو|وهي|وماذا|وما هو|وما هي)"))
            {
                if (cache.TryGetValue<string[]>(historyKey, out var previous) && previous is { Length: > 0 })
                    contextualQuestion = $"{previous[^1]}\nسؤال متابعة: {question}";
            }
            var revision = await store.RevisionAsync(cancellationToken);
            var answerKey = $"answer:{revision}:{provider.EmbeddingProfile}:{modelKey}:{input.Advanced}:{ChatSecurity.Hash(contextualQuestion)}";
            ChatAnswer answer;
            if (cache.TryGetValue<ChatAnswer>(answerKey, out var cached) && cached is not null)
                answer = cached with { ConversationId = conversationId };
            else
            {
                var embeddingKey = $"embedding:{provider.EmbeddingProfile}:{ChatSecurity.Hash(contextualQuestion)}";
                if (!cache.TryGetValue<float[]>(embeddingKey, out var embedding) || embedding is null)
                {
                    embedding = (await provider.EmbedAsync([contextualQuestion], true, cancellationToken))[0];
                    cache.Set(embeddingKey, embedding, new MemoryCacheEntryOptions { Size = 1, AbsoluteExpirationRelativeToNow = TimeSpan.FromHours(12) });
                }
                var hits = await vectors.SearchAsync(embedding, provider.EmbeddingProfile, 24, cancellationToken);
                var relevant = SelectHits(contextualQuestion, hits);
                if (relevant.Length == 0)
                    answer = new ChatAnswer(Absent, [], 0, conversationId);
                else
                {
                    var json = await provider.SelectEvidenceAsync(contextualQuestion, relevant, input.Advanced, cancellationToken);
                    answer = Ground(json, relevant, conversationId);
                }
                cache.Set(answerKey, answer, new MemoryCacheEntryOptions { Size = 1, AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(10) });
            }
            if (revision != await store.RevisionAsync(cancellationToken)) throw new AiProviderException("sources_changed");
            var history = cache.Get<string[]>(historyKey) ?? [];
            cache.Set(historyKey, history.Append(question).TakeLast(3).ToArray(), new MemoryCacheEntryOptions { Size = 1, SlidingExpiration = TimeSpan.FromMinutes(20), AbsoluteExpirationRelativeToNow = TimeSpan.FromHours(1) });
            return answer;
        }
        finally { concurrent.Release(); }
    }

    internal static ChatAnswer Ground(string json, IReadOnlyList<KnowledgeHit> hits, string conversationId)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            if (!document.RootElement.TryGetProperty("evidence", out var evidence) || evidence.ValueKind != JsonValueKind.Array || evidence.GetArrayLength() > 3)
                throw new AiProviderException("invalid_evidence");
            var citations = new List<ChatCitation>();
            var similarities = new List<double>();
            foreach (var item in evidence.EnumerateArray())
            {
                if (!item.TryGetProperty("chunkId", out var id) || !Guid.TryParse(id.GetString(), out var chunkId) || !item.TryGetProperty("segment", out var segmentElement) || !segmentElement.TryGetInt32(out var segment))
                    throw new AiProviderException("invalid_evidence");
                var hit = hits.FirstOrDefault(value => value.Id == chunkId);
                if (hit is null) throw new AiProviderException("invalid_evidence");
                var segments = EvidenceSegments(hit.Content);
                if (segment < 0 || segment >= segments.Length) throw new AiProviderException("invalid_evidence");
                var quote = segments[segment];
                if (quote.Length < 15) throw new AiProviderException("invalid_evidence");
                if (citations.Any(value => value.Title == hit.Title && value.Page == hit.PageNumber && value.Snippet == quote)) continue;
                citations.Add(new ChatCitation(hit.Title, hit.PageNumber, quote));
                similarities.Add(hit.Similarity);
            }
            if (citations.Count == 0) return new ChatAnswer(Absent, [], 0, conversationId);
            var answer = "بحسب المصدر:\n" + string.Join("\n\n", citations.Select(value => $"«{value.Snippet}»"))
                + "\n\nهذه الإجابة من المصدر التعليمي، وليست بديلًا عن إرشاد الكاهن في الأمور العقائدية أو الطقسية.";
            return new ChatAnswer(answer, citations, Math.Round(Math.Clamp(similarities.Average(), 0, 0.99), 2), conversationId);
        }
        catch (JsonException) { throw new AiProviderException("invalid_evidence"); }
        catch (InvalidOperationException) { throw new AiProviderException("invalid_evidence"); }
    }

    internal static string[] EvidenceSegments(string text)
    {
        text = Normalize(text);
        var segments = new List<string>();
        for (var start = 0; start < text.Length;)
        {
            var end = Math.Min(start + 1000, text.Length);
            if (end < text.Length)
            {
                var boundary = text.LastIndexOf(' ', end - 1, end - start);
                if (boundary > start + 500) end = boundary;
            }
            segments.Add(text[start..end].Trim());
            if (end == text.Length) break;
            start = end - 100;
            var nextWord = text.IndexOf(' ', start);
            if (nextWord < end) start = nextWord + 1;
        }
        return segments.ToArray();
    }

    internal static KnowledgeHit[] SelectHits(string question, IReadOnlyList<KnowledgeHit> hits)
    {
        var stopWords = new HashSet<string>(["ما", "هي", "هو", "عن", "في", "من", "هل", "كيف", "لماذا", "متي", "اين", "كم", "معني", "وظيفة", "المستخدمة"], StringComparer.Ordinal);
        var terms = Regex.Matches(SearchText(question), @"[\p{L}\p{N}]+")
            .Select(match => match.Value).Where(term => term.Length > 1 && !stopWords.Contains(term))
            .Select(term => term.StartsWith("ال", StringComparison.Ordinal) ? term[2..] : term).Where(term => term.Length > 1).Distinct().ToArray();
        return hits.Where(hit => hit.Similarity >= 0.25)
            .OrderByDescending(hit => hit.Similarity + (terms.Length == 0 ? 0 : 0.12 * terms.Count(term => SearchText(hit.Content).Contains(term, StringComparison.Ordinal)) / terms.Length))
            .Take(6).ToArray();
    }

    private static string SearchText(string text) => Regex.Replace(Normalize(text), "[\u064b-\u065f\u0670]", "").Replace('أ', 'ا').Replace('إ', 'ا').Replace('آ', 'ا').Replace('ى', 'ي');
    internal static string Normalize(string text) => Spaces.Replace(text.Normalize(NormalizationForm.FormKC), " ").Trim();
    public void Dispose() { cache.Dispose(); concurrent.Dispose(); }
}

internal static class ChatEndpoints
{
    internal static void Map(WebApplication app)
    {
        var chat = app.MapGroup("/api/chat");
        chat.AddEndpointFilter(async (context, next) =>
        {
            context.HttpContext.Response.Headers.CacheControl = "no-store";
            return await next(context);
        });
        chat.MapGet("/health", async (NpgsqlDataSource database, IAiProvider provider, CancellationToken cancellationToken) =>
        {
            await using var connection = await database.OpenConnectionAsync(cancellationToken);
            await using var command = new NpgsqlCommand("select 1", connection);
            await command.ExecuteScalarAsync(cancellationToken);
            return Results.Ok(new { ok = true, providerConfigured = provider.IsConfigured, mode = "source-only", embeddingProfile = provider.EmbeddingProfile });
        });
        chat.MapPost("/session", async (HttpContext context, ChatSecurity security, CancellationToken cancellationToken) =>
        {
            if (!await security.AllowAsync("", security.Ip(context), true, cancellationToken))
                return Failure(context, "session_rate_limit", "تم الوصول إلى الحد المسموح. حاول لاحقًا.", 429);
            return Results.Ok(new { sessionToken = security.CreateSession() });
        });
        chat.MapPost("/ask", async (ChatRequest input, HttpContext context, ChatSecurity security, ChatEngine engine, IAiProvider provider, ILogger<ChatEngine> logger, CancellationToken cancellationToken) =>
        {
            var session = security.ValidateSession(context.Request.Headers["X-Chat-Session"].ToString());
            if (session is null) return Failure(context, "session_required", "انتهت جلسة المحادثة. أعد المحاولة.", 401);
            if (string.IsNullOrWhiteSpace(input.Question) || input.Question.Length is < 3 or > 1000 || input.Question.IndexOfAny(['<', '>']) >= 0 || input.Question.Any(value => char.IsControl(value) && value is not '\n' and not '\r' and not '\t'))
                return Failure(context, "invalid_question", "اكتب سؤالًا من 3 إلى 1000 حرف بدون HTML أو أكواد.", 400);
            if (input.ConversationId is { Length: > 0 } && !Guid.TryParse(input.ConversationId, out _))
                return Failure(context, "invalid_conversation", "معرف المحادثة غير صالح.", 400);
            if (!provider.IsConfigured) return Failure(context, "provider_not_configured", "خدمة الإجابات غير مهيأة حاليًا. حاول لاحقًا.", 503);
            if (!await security.AllowAsync(session, security.Ip(context), false, cancellationToken))
                return Failure(context, "chat_rate_limit", "تم الوصول إلى حد الأسئلة المسموح. حاول لاحقًا.", 429);
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(TimeSpan.FromSeconds(90));
            try
            {
                return Results.Ok(await engine.AskAsync(input, session, deadline.Token));
            }
            catch (AiProviderException exception)
            {
                logger.LogWarning("Educational chat request failed: {Code}", exception.Code);
                var message = exception.Code == "sources_changed" ? "تغيرت المصادر أثناء الإجابة. أعد المحاولة." : "تعذر الحصول على إجابة موثقة الآن. أعد المحاولة بعد قليل.";
                return Failure(context, exception.Code, message, exception.Code == "sources_changed" ? 409 : exception.Code == "chat_busy" ? 429 : 503);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { return Results.StatusCode(499); }
            catch (OperationCanceledException)
            {
                logger.LogWarning("Educational chat request timed out");
                return Failure(context, "provider_timeout", "استغرقت خدمة الإجابات وقتًا طويلًا. أعد المحاولة.", 503);
            }
            catch (PostgresException exception)
            {
                logger.LogWarning("Educational chat storage failed: {Code}", exception.SqlState);
                return Failure(context, "storage_unavailable", "خدمة المصادر غير متاحة الآن. حاول لاحقًا.", 503);
            }
            catch (NpgsqlException)
            {
                logger.LogWarning("Educational chat storage unavailable");
                return Failure(context, "storage_unavailable", "خدمة المصادر غير متاحة الآن. حاول لاحقًا.", 503);
            }
        });
    }

    private static IResult Failure(HttpContext context, string code, string message, int status)
    {
        if (status == 429) context.Response.Headers.RetryAfter = "60";
        return Results.Json(new { code, message }, statusCode: status);
    }
}
