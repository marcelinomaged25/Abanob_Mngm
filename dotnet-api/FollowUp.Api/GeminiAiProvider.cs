using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;

internal sealed class AiProviderException(string code) : Exception(code)
{
    internal string Code { get; } = code;
}

internal sealed class GeminiAiProvider : IChatCompletion, IEmbeddingProvider
{
    private readonly HttpClient client;
    private readonly string key;
    private readonly string chatModel;
    private readonly string advancedModel;
    private readonly string embeddingModel;
    public string Name => "gemini";
    public string Profile => $"gemini:{chatModel}/{advancedModel}";
    public string ChatModel => chatModel;
    public string EmbeddingProfile => $"gemini:{embeddingModel}:{Dimensions}:v1";
    public int Dimensions { get; }
    public bool IsConfigured { get; }
    public bool EmbeddingsConfigured { get; }

    public GeminiAiProvider(IHttpClientFactory factory, IConfiguration configuration)
    {
        client = factory.CreateClient("knowledge-ai");
        key = configuration["AI_API_KEY"] ?? "";
        chatModel = Model(configuration["AI_CHAT_MODEL"] ?? "gemini-3.1-flash-lite");
        advancedModel = Model(configuration["AI_ADVANCED_CHAT_MODEL"] ?? chatModel);
        embeddingModel = Model(configuration["AI_EMBEDDING_MODEL"] ?? "gemini-embedding-001");
        Dimensions = int.TryParse(configuration["AI_EMBEDDING_DIMENSIONS"], out var dimensions) ? dimensions : 768;
        if (Dimensions is < 128 or > 3072) throw new InvalidOperationException("AI_EMBEDDING_DIMENSIONS must be between 128 and 3072.");
        if (embeddingModel != "gemini-embedding-001") throw new InvalidOperationException("This provider requires gemini-embedding-001; another embedding model needs its task adapter and reindexing.");
        EmbeddingsConfigured = !string.IsNullOrWhiteSpace(key);
        IsConfigured = EmbeddingsConfigured && string.Equals(configuration["AI_PROVIDER"] ?? "gemini", "gemini", StringComparison.OrdinalIgnoreCase);
    }

    private static string Model(string model) => Regex.IsMatch(model, "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$")
        ? model : throw new InvalidOperationException("Invalid AI model name.");

    public async Task<float[][]> EmbedAsync(IReadOnlyList<string> texts, bool query, CancellationToken cancellationToken)
    {
        if (texts.Count == 0) return [];
        if (texts.Count > 20) throw new ArgumentOutOfRangeException(nameof(texts));
        var requests = texts.Select(text => new
        {
            model = $"models/{embeddingModel}",
            content = new { parts = new[] { new { text } } },
            taskType = query ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
            outputDimensionality = Dimensions
        }).ToArray();
        using var document = await SendAsync(embeddingModel, "batchEmbedContents", new { requests }, cancellationToken);
        if (!document.RootElement.TryGetProperty("embeddings", out var embeddings) || embeddings.GetArrayLength() != texts.Count)
            throw new AiProviderException("invalid_embeddings");
        var vectors = embeddings.EnumerateArray().Select(value => value.GetProperty("values").EnumerateArray().Select(x => x.GetSingle()).ToArray()).ToArray();
        foreach (var vector in vectors)
        {
            if (vector.Length != Dimensions || vector.Any(x => !float.IsFinite(x))) throw new AiProviderException("invalid_embeddings");
            var norm = Math.Sqrt(vector.Sum(x => (double)x * x));
            if (norm <= 0) throw new AiProviderException("invalid_embeddings");
            for (var i = 0; i < vector.Length; i++) vector[i] = (float)(vector[i] / norm);
        }
        return vectors;
    }

    public async Task<string> SelectEvidenceAsync(string question, IReadOnlyList<KnowledgeHit> hits, bool advanced, string conversation, CancellationToken cancellationToken)
    {
        var payload = ChatPrompts.EvidencePayload(question, hits, conversation);
        var schema = new
        {
            type = "OBJECT",
            properties = new
            {
                evidence = new
                {
                    type = "ARRAY",
                    maxItems = 4,
                    items = new
                    {
                        type = "OBJECT",
                        properties = new { chunkId = new { type = "STRING" }, segment = new { type = "INTEGER" } },
                        required = new[] { "chunkId", "segment" }
                    }
                },
                answer = new { type = "STRING" }
            },
            required = new[] { "evidence", "answer" }
        };
        using var response = await SendAsync(advanced ? advancedModel : chatModel, "generateContent", new
        {
            systemInstruction = new { parts = new[] { new { text = ChatPrompts.EvidenceInstruction } } },
            contents = new[] { new { role = "user", parts = new[] { new { text = payload } } } },
            generationConfig = new { temperature = 0.2, maxOutputTokens = 3200, responseMimeType = "application/json", responseSchema = schema }
        }, cancellationToken, requireChat: true);
        if (!response.RootElement.TryGetProperty("candidates", out var candidates) || candidates.GetArrayLength() == 0)
            throw new AiProviderException("invalid_evidence");
        var candidate = candidates[0];
        if (!candidate.TryGetProperty("finishReason", out var finish) || finish.GetString() != "STOP")
            throw new AiProviderException("incomplete_evidence");
        return string.Concat(candidate.GetProperty("content").GetProperty("parts").EnumerateArray()
            .Where(part => part.TryGetProperty("text", out _) && !(part.TryGetProperty("thought", out var thought) && thought.GetBoolean()))
            .Select(part => part.GetProperty("text").GetString()));
    }

    public async Task<string> VerifyAsync(string question, string answer, IReadOnlyList<ChatCitation> sources, CancellationToken cancellationToken)
    {
        var payload = ChatPrompts.VerifyPayload(question, answer, sources);
        var schema = new
        {
            type = "OBJECT",
            properties = new { supported = new { type = "BOOLEAN" } },
            required = new[] { "supported" }
        };
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(20));
        try
        {
            using var response = await SendAsync(chatModel, "generateContent", new
            {
                systemInstruction = new { parts = new[] { new { text = ChatPrompts.VerifyInstruction } } },
                contents = new[] { new { role = "user", parts = new[] { new { text = payload } } } },
                generationConfig = new { temperature = 0, maxOutputTokens = 64, responseMimeType = "application/json", responseSchema = schema }
            }, deadline.Token, requireChat: true);
            if (!response.RootElement.TryGetProperty("candidates", out var candidates) || candidates.GetArrayLength() == 0)
                throw new AiProviderException("invalid_verification");
            var candidate = candidates[0];
            if (!candidate.TryGetProperty("finishReason", out var finish) || finish.GetString() != "STOP")
                throw new AiProviderException("invalid_verification");
            var text = string.Concat(candidate.GetProperty("content").GetProperty("parts").EnumerateArray()
                .Where(part => part.TryGetProperty("text", out _) && !(part.TryGetProperty("thought", out var thought) && thought.GetBoolean()))
                .Select(part => part.GetProperty("text").GetString()));
            return ChatPrompts.ExtractJson(text);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { throw new AiProviderException("provider_timeout"); }
    }

    public async Task<string> SummarizeAsync(string previousSummary, string transcript, CancellationToken cancellationToken)
    {
        var payload = ChatPrompts.SummaryPayload(previousSummary, transcript);
        var schema = new
        {
            type = "OBJECT",
            properties = new { summary = new { type = "STRING" } },
            required = new[] { "summary" }
        };
        using var response = await SendAsync(chatModel, "generateContent", new
        {
            systemInstruction = new { parts = new[] { new { text = ChatPrompts.SummaryInstruction } } },
            contents = new[] { new { role = "user", parts = new[] { new { text = payload } } } },
            generationConfig = new { temperature = 0.2, maxOutputTokens = 600, responseMimeType = "application/json", responseSchema = schema }
        }, cancellationToken, requireChat: true);
        if (!response.RootElement.TryGetProperty("candidates", out var candidates) || candidates.GetArrayLength() == 0)
            throw new AiProviderException("invalid_summary");
        var candidate = candidates[0];
        if (!candidate.TryGetProperty("finishReason", out var finish) || finish.GetString() != "STOP")
            throw new AiProviderException("invalid_summary");
        var text = string.Concat(candidate.GetProperty("content").GetProperty("parts").EnumerateArray()
            .Where(part => part.TryGetProperty("text", out _) && !(part.TryGetProperty("thought", out var thought) && thought.GetBoolean()))
            .Select(part => part.GetProperty("text").GetString()));
        using var document = JsonDocument.Parse(text);
        if (!document.RootElement.TryGetProperty("summary", out var summary) || summary.ValueKind != JsonValueKind.String)
            throw new AiProviderException("invalid_summary");
        return summary.GetString() ?? "";
    }

    public async Task<bool> CheckAsync(CancellationToken cancellationToken)
    {
        if (!IsConfigured) return false;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, $"https://generativelanguage.googleapis.com/v1beta/models/{chatModel}");
            request.Headers.Add("x-goog-api-key", key);
            using var response = await client.SendAsync(request, cancellationToken);
            return response.IsSuccessStatusCode;
        }
        catch (HttpRequestException) { return false; }
    }

    private async Task<JsonDocument> SendAsync(string model, string method, object body, CancellationToken cancellationToken, bool requireChat = false)
    {
        if (requireChat ? !IsConfigured : !EmbeddingsConfigured) throw new AiProviderException("provider_not_configured");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(method == "batchEmbedContents" ? 175 : 75));
        try
        {
            for (var attempt = 0; attempt < 3; attempt++)
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, $"https://generativelanguage.googleapis.com/v1beta/models/{model}:{method}");
                request.Headers.Add("x-goog-api-key", key);
                request.Content = JsonContent.Create(body);
                using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
                if (response.IsSuccessStatusCode)
                {
                    await using var stream = await response.Content.ReadAsStreamAsync(deadline.Token);
                    return await JsonDocument.ParseAsync(stream, cancellationToken: deadline.Token);
                }
                if ((response.StatusCode == HttpStatusCode.TooManyRequests || (int)response.StatusCode >= 500) && attempt < 2)
                {
                    var delay = response.Headers.RetryAfter?.Delta
                        ?? (response.Headers.RetryAfter?.Date is { } retryAt ? retryAt - DateTimeOffset.UtcNow : (TimeSpan?)null)
                        ?? TimeSpan.FromSeconds(response.StatusCode == HttpStatusCode.TooManyRequests ? 60 : 2 * (attempt + 1));
                    if (response.StatusCode == HttpStatusCode.TooManyRequests)
                    {
                        try
                        {
                            using var error = JsonDocument.Parse(await response.Content.ReadAsStringAsync(deadline.Token));
                            if (error.RootElement.TryGetProperty("error", out var detail) && detail.TryGetProperty("details", out var details))
                                foreach (var item in details.EnumerateArray())
                                    if (item.TryGetProperty("retryDelay", out var retry) && double.TryParse(retry.GetString()?.TrimEnd('s'), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var seconds))
                                        delay = TimeSpan.FromSeconds(seconds + 1);
                        }
                        catch (JsonException) { }
                    }
                    await Task.Delay(TimeSpan.FromSeconds(Math.Clamp(delay.TotalSeconds, 1, 70)), deadline.Token);
                    continue;
                }
                throw new AiProviderException(response.StatusCode == HttpStatusCode.TooManyRequests ? "provider_rate_limit" : $"provider_http_{(int)response.StatusCode}");
            }
            throw new AiProviderException("provider_unavailable");
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { throw new AiProviderException("provider_timeout"); }
        catch (HttpRequestException) { throw new AiProviderException("provider_unavailable"); }
        catch (JsonException) { throw new AiProviderException("invalid_provider_response"); }
    }
}
