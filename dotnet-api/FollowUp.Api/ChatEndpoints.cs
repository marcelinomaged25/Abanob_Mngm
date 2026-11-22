using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Caching.Memory;
using Npgsql;

internal sealed record ChatRequest(string? Question, string? ConversationId = null, bool Advanced = false);
internal sealed record ChatCitation(string Title, int Page, string Snippet);
internal sealed record ChatAnswer(string Answer, IReadOnlyList<ChatCitation> Sources, double Confidence, string ConversationId, string Summary = "");

internal sealed class ChatEngine(KnowledgeStore store, ChatStore chats, IKnowledgeVectorStore vectors, IAiProvider provider, IConfiguration configuration) : IDisposable
{
    internal const string Absent = "المعلومة غير موجودة في المصادر المتاحة حاليًا.";
    private const int SummaryEveryMessages = 4;
    private readonly MemoryCache cache = new(new MemoryCacheOptions { SizeLimit = 512 });
    private readonly SemaphoreSlim concurrent = new(2);
    private static readonly Regex Spaces = new(@"\s+", RegexOptions.Compiled, TimeSpan.FromSeconds(1));
    private static readonly Regex FollowUp = new(@"(^|\s)(و|وبعدين|بعدين|طيب|كمان|وكمان|تاني|تانى|ده|دي|دول|هو|هي|هم|ليه|ازاي|إزاي|يعني|برضه|بردو|فين|امتى|إمتى|وايه|وإيه|بس|وماذا|وما هو|وما هي|وظيفته|معناه|معناها|دوره)(\s|$|؟|\?)", RegexOptions.Compiled, TimeSpan.FromSeconds(1));
    private static readonly Regex Greeting = new(@"^(?:السلام(?:\s+عليكم)?|سلام(?:\s+عليكم)?|أهلا(?:\s+وسهلا)?|اهلا(?:\s+وسهلا)?|هلا(?:\s+بيك)?|هاي|hello|hi|صباح(?:\s+الخير|\s+النور)|مساء(?:\s+الخير|\s+النور)|إزيك|ازيك|إزاي\s+حالك|ازاي\s+حالك|عامل\s+إيه|عامل\s+ايه|إيه\s+الأخبار|ايه\s+الاخبار|أخبارك\s+إيه|اخبارك\s+ايه|وحشتني)(?:\s+يا\s+[\p{L}\s]+)?[\s!؟.،]*$", RegexOptions.IgnoreCase | RegexOptions.Compiled, TimeSpan.FromSeconds(1));
    private static readonly Regex Thanks = new(@"^(?:شكرا|شكرًا|متشكر(?:ة)?|ربنا\s+يخليك|ربنا\s+يباركك|تسلم|ميرسي|thanks|thank\s+you)(?:\s+يا\s+[\p{L}\s]+)?[\s!؟.،]*$", RegexOptions.IgnoreCase | RegexOptions.Compiled, TimeSpan.FromSeconds(1));
    private static readonly Regex Identity = new(@"^(?:مين\s+انت|انت\s+مين|إنت\s+مين|اسمك\s+إيه|اسمك\s+ايه|بتعمل\s+إيه|بتعمل\s+ايه)(?:\s+يا\s+[\p{L}\s]+)?[\s!؟.،]*$", RegexOptions.IgnoreCase | RegexOptions.Compiled, TimeSpan.FromSeconds(1));
    private static readonly Regex Farewell = new(@"^(?:باي|وداعا|وداعًا|إلى\s+اللقاء|الى\s+اللقاء|تصبح\s+على\s+خير|bye|goodbye)(?:\s+يا\s+[\p{L}\s]+)?[\s!؟.،]*$", RegexOptions.IgnoreCase | RegexOptions.Compiled, TimeSpan.FromSeconds(1));
    private static readonly Regex Confused = new(@"^(?:مش\s+فاهم(?:ة)?(?:\s+حاجة)?|وضح(?:لي|لى)?(?:\s+شوية)?|مش\s+واضح)[\s!؟.،]*$", RegexOptions.Compiled, TimeSpan.FromSeconds(1));
    private readonly string modelKey = $"{configuration["AI_CHAT_MODEL"] ?? "gemini-3.1-flash-lite"}:{configuration["AI_ADVANCED_CHAT_MODEL"] ?? "default"}";

    internal async Task<ChatAnswer> AskAsync(ChatRequest input, string session, CancellationToken cancellationToken)
    {
        if (!await concurrent.WaitAsync(0, cancellationToken)) throw new AiProviderException("chat_busy");
        try
        {
            var question = Normalize(input.Question!);
            var conversation = Guid.TryParse(input.ConversationId, out var requested) ? await chats.GetAsync(requested, session, cancellationToken) : null;
            var conversationId = conversation?.ConversationId ?? Guid.NewGuid().ToString();
            var history = conversation?.Messages ?? [];
            var summary = conversation?.Summary ?? "";
            var title = conversation?.Title ?? Title(question);
            var lastUser = history.LastOrDefault(message => message.Role == "user");
            var contextualQuestion = lastUser is not null && (question.Length < 25 || FollowUp.IsMatch(question))
                ? $"{lastUser.Text}\nسؤال متابعة: {question}"
                : question;
            var contextKey = ChatSecurity.Hash(summary + "\u0001" + string.Join("\u0001", history.TakeLast(2).Select(message => message.Text)));
            ChatAnswer answer;
            var smallTalk = SmallTalk(question);
            if (smallTalk is not null)
                answer = new ChatAnswer(smallTalk, [], 0, conversationId);
            else
            {
                var revision = await store.RevisionAsync(cancellationToken);
                var answerKey = $"answer:{revision}:{provider.EmbeddingProfile}:{modelKey}:{input.Advanced}:{contextKey}:{ChatSecurity.Hash(contextualQuestion)}";
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
                        var json = await provider.SelectEvidenceAsync(contextualQuestion, relevant, input.Advanced, ConversationContext(summary, history), cancellationToken);
                        answer = Ground(json, relevant, conversationId);
                    }
                    cache.Set(answerKey, answer, new MemoryCacheEntryOptions { Size = 1, AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(10) });
                }
                if (revision != await store.RevisionAsync(cancellationToken)) throw new AiProviderException("sources_changed");
            }
            var id = Guid.Parse(conversationId);
            await chats.SaveTurnAsync(id, session, title, question, answer.Answer, answer.Sources, answer.Confidence, cancellationToken);
            var newSummary = await UpdateSummaryAsync(conversation, id, session, question, answer.Answer, cancellationToken);
            return answer with { Summary = newSummary };
        }
        finally { concurrent.Release(); }
    }

    private async Task<string> UpdateSummaryAsync(ChatConversation? conversation, Guid id, string session, string question, string answer, CancellationToken cancellationToken)
    {
        var previous = conversation?.Summary ?? "";
        var messageCount = (conversation?.MessageCount ?? 0) + 2;
        if (messageCount - (conversation?.SummaryMessageCount ?? 0) < SummaryEveryMessages) return previous;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(15));
            var summary = Normalize(await provider.SummarizeAsync(previous, Transcript(conversation, question, answer), timeout.Token));
            if (summary.Length is < 15 or > 1200 || summary.Contains('\0')) return previous;
            await chats.SaveSummaryAsync(id, session, summary, messageCount, cancellationToken);
            return summary;
        }
        catch (AiProviderException) { return previous; }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { return previous; }
        catch (NpgsqlException) { return previous; }
    }

    private static string? SmallTalk(string question)
    {
        if (Greeting.IsMatch(question)) return "أهلًا بيك يا حبيبي. أنا هنا أساعدك تدور في المصادر الكنسية عن الطقس، أو الكتاب المقدس، أو القديسين، أو الألحان، أو أي موضوع في الكنيسة. اسألني براحتك.";
        if (Thanks.IsMatch(question)) return "ربنا يباركك يا حبيبي. لو عندك سؤال تاني في أي موضوع كنسي أنا موجود.";
        if (Identity.IsMatch(question)) return "أنا مساعد تعليمي بسيط، بدور لك في المصادر الكنسية اللي رفعها الخدام، وأجاوبك منها بأسلوب بسيط. اسألني عن الكتاب، أو القديسين، أو الطقس، أو أي موضوع في الكنيسة.";
        if (Farewell.IsMatch(question)) return "سلام ونعمة يا حبيبي. لو احتجت أي حاجة في الكنيسة أنا هنا.";
        if (Confused.IsMatch(question)) return "ولا يهمك يا حبيبي. قولّي السؤال بطريقة تانية، أو اكتب اسم الموضوع لوحده زي «مارمرقس» أو «رتب الشمامسة»، وأنا أدور معاك في المصادر.";
        return null;
    }

    private static string ConversationContext(string summary, IReadOnlyList<ChatMessageDto> messages)
    {
        if (summary.Length == 0 && messages.Count == 0) return "";
        var builder = new StringBuilder();
        if (summary.Length > 0) builder.AppendLine("ملخص المحادثة: " + summary);
        foreach (var message in messages.TakeLast(8))
            builder.AppendLine((message.Role == "user" ? "الولد: " : "الخادم: ") + Clip(message.Text, 600));
        var text = builder.ToString();
        return text.Length > 3000 ? text[^3000..] : text;
    }

    private static string Transcript(ChatConversation? conversation, string question, string answer)
    {
        var builder = new StringBuilder();
        if (conversation is { Summary.Length: > 0 }) builder.AppendLine("الملخص السابق: " + conversation.Summary);
        foreach (var message in (conversation?.Messages ?? []).TakeLast(10))
            builder.AppendLine((message.Role == "user" ? "الولد: " : "الخادم: ") + Clip(message.Text, 700));
        builder.AppendLine("الولد: " + Clip(question, 700));
        builder.AppendLine("الخادم: " + Clip(answer, 700));
        var text = builder.ToString();
        return text.Length > 7000 ? text[^7000..] : text;
    }

    private static string Clip(string text, int length) => text.Length <= length ? text : text[..length];

    private static string Title(string question) => question.Length <= 70 ? question : question[..70].TrimEnd() + "…";

    internal static ChatAnswer Ground(string json, IReadOnlyList<KnowledgeHit> hits, string conversationId)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (!root.TryGetProperty("evidence", out var evidence) || evidence.ValueKind != JsonValueKind.Array || evidence.GetArrayLength() > 3)
                throw new AiProviderException("invalid_evidence");
            if (evidence.GetArrayLength() == 0) return new ChatAnswer(Absent, [], 0, conversationId);
            if (!root.TryGetProperty("answer", out var answerElement) || answerElement.ValueKind != JsonValueKind.String)
                throw new AiProviderException("invalid_evidence");
            var rewrite = Normalize(answerElement.GetString() ?? "");
            if (rewrite.Length is < 15 or > 4000 || rewrite.Contains('\0')) throw new AiProviderException("invalid_evidence");
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
            return new ChatAnswer(rewrite, citations, Math.Round(Math.Clamp(similarities.Average(), 0, 0.99), 2), conversationId);
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
        chat.MapGet("/conversations", async (HttpContext context, ChatSecurity security, ChatStore chats, ILogger<ChatEngine> logger, CancellationToken cancellationToken) =>
        {
            var session = security.ValidateSession(context.Request.Headers["X-Chat-Session"].ToString());
            if (session is null) return Failure(context, "session_required", "انتهت جلسة المحادثة. أعد المحاولة.", 401);
            try { return Results.Ok(new { conversations = await chats.ListAsync(session, cancellationToken) }); }
            catch (NpgsqlException) { logger.LogWarning("Chat conversation list failed"); return Failure(context, "storage_unavailable", "تعذر تحميل المحادثات الآن. حاول لاحقًا.", 503); }
        });
        chat.MapGet("/conversations/{id:guid}", async (Guid id, HttpContext context, ChatSecurity security, ChatStore chats, ILogger<ChatEngine> logger, CancellationToken cancellationToken) =>
        {
            var session = security.ValidateSession(context.Request.Headers["X-Chat-Session"].ToString());
            if (session is null) return Failure(context, "session_required", "انتهت جلسة المحادثة. أعد المحاولة.", 401);
            try
            {
                var conversation = await chats.GetAsync(id, session, cancellationToken);
                return conversation is null ? Failure(context, "not_found", "المحادثة غير موجودة.", 404) : Results.Ok(new { conversation });
            }
            catch (NpgsqlException) { logger.LogWarning("Chat conversation load failed"); return Failure(context, "storage_unavailable", "تعذر تحميل المحادثة الآن. حاول لاحقًا.", 503); }
        });
        chat.MapDelete("/conversations/{id:guid}", async (Guid id, HttpContext context, ChatSecurity security, ChatStore chats, ILogger<ChatEngine> logger, CancellationToken cancellationToken) =>
        {
            var session = security.ValidateSession(context.Request.Headers["X-Chat-Session"].ToString());
            if (session is null) return Failure(context, "session_required", "انتهت جلسة المحادثة. أعد المحاولة.", 401);
            try { return await chats.DeleteAsync(id, session, cancellationToken) ? Results.NoContent() : Failure(context, "not_found", "المحادثة غير موجودة.", 404); }
            catch (NpgsqlException) { logger.LogWarning("Chat conversation delete failed"); return Failure(context, "storage_unavailable", "تعذر حذف المحادثة الآن. حاول لاحقًا.", 503); }
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
