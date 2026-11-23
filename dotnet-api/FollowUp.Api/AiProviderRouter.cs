using System.Text.Json;

internal sealed class AiProviderRouter : IAiProvider
{
    internal static readonly string[] DefaultOrder = ["gemini", "openrouter", "groq", "deepseek", "openai"];
    private readonly IEmbeddingProvider embeddings;
    private readonly IChatCompletion[] chain;
    private readonly ILogger<AiProviderRouter> logger;

    public AiProviderRouter(GeminiAiProvider gemini, IHttpClientFactory factory, IConfiguration configuration, ILogger<AiProviderRouter> logger)
    {
        this.logger = logger;
        embeddings = SelectEmbeddingProvider(gemini, factory, configuration);
        var candidates = Build(factory, configuration, gemini);
        var ordered = new List<IChatCompletion>();
        foreach (var name in ParseOrder(configuration["AI_CHAT_PROVIDERS"]))
        {
            if (!candidates.TryGetValue(name, out var provider))
            {
                logger.LogWarning("Chat provider {Provider} is not configured; skipping it", name);
                continue;
            }
            if (!provider.IsConfigured) continue;
            ordered.Add(provider);
        }
        chain = [.. ordered];
        if (chain.Length == 0) logger.LogError("No chat providers are configured; chat answers are unavailable");
    }

    public string EmbeddingProfile => embeddings.EmbeddingProfile;
    public string ChatProfile => string.Join(",", chain.Select(provider => provider.Profile));
    public int Dimensions => embeddings.Dimensions;
    public bool IsConfigured => embeddings.EmbeddingsConfigured && chain.Length > 0;

    public Task<float[][]> EmbedAsync(IReadOnlyList<string> texts, bool query, CancellationToken cancellationToken) =>
        embeddings.EmbedAsync(texts, query, cancellationToken);

    public Task<string> SelectEvidenceAsync(string question, IReadOnlyList<KnowledgeHit> hits, bool advanced, string conversation, CancellationToken cancellationToken) =>
        RunAsync(provider => provider.SelectEvidenceAsync(question, hits, advanced, conversation, cancellationToken), HasEvidence, cancellationToken);

    public Task<string> VerifyAsync(string question, string answer, IReadOnlyList<ChatCitation> sources, CancellationToken cancellationToken) =>
        RunAsync(provider => provider.VerifyAsync(question, answer, sources, cancellationToken), HasVerdict, cancellationToken);

    public Task<string> SummarizeAsync(string previousSummary, string transcript, CancellationToken cancellationToken) =>
        RunAsync(provider => provider.SummarizeAsync(previousSummary, transcript, cancellationToken), HasSummary, cancellationToken);

    public async Task<bool> CheckAsync(CancellationToken cancellationToken)
    {
        foreach (var provider in chain)
            if (await provider.CheckAsync(cancellationToken)) return true;
        return false;
    }

    internal static string[] ParseOrder(string? raw) =>
        string.IsNullOrWhiteSpace(raw)
            ? DefaultOrder
            : raw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(name => name.ToLowerInvariant())
                .Distinct()
                .ToArray();

    private Task<string> RunAsync(Func<IChatCompletion, Task<string>> call, Func<string, bool> usable, CancellationToken cancellationToken) =>
        ChooseAsync(chain, call, usable,
            (provider, reason) => logger.LogWarning("Chat provider {Provider} {Reason}; trying the next provider", provider.Name, reason),
            cancellationToken);

    internal static async Task<string> ChooseAsync(IReadOnlyList<IChatCompletion> chain, Func<IChatCompletion, Task<string>> call,
        Func<string, bool> usable, Action<IChatCompletion, string> onFailure, CancellationToken cancellationToken)
    {
        AiProviderException? failure = null;
        foreach (var provider in chain)
        {
            try
            {
                var content = await call(provider);
                if (usable(content)) return content;
                failure = new AiProviderException("invalid_provider_response");
                onFailure(provider, "returned unusable output");
            }
            catch (AiProviderException exception)
            {
                failure = exception;
                onFailure(provider, exception.Code);
            }
        }
        throw failure ?? new AiProviderException("provider_unavailable");
    }

    private Dictionary<string, IChatCompletion> Build(IHttpClientFactory factory, IConfiguration configuration, GeminiAiProvider gemini)
    {
        var candidates = new Dictionary<string, IChatCompletion>(StringComparer.OrdinalIgnoreCase)
        {
            ["gemini"] = gemini
        };
        Add(factory, configuration, candidates, "openrouter", "https://openrouter.ai/api/v1", null);
        Add(factory, configuration, candidates, "groq", "https://api.groq.com/openai/v1", "openai/gpt-oss-120b");
        Add(factory, configuration, candidates, "deepseek", "https://api.deepseek.com/v1", "deepseek-flash");
        Add(factory, configuration, candidates, "openai", "https://api.openai.com/v1", "gpt-6-luna");
        return candidates;
    }

    private IEmbeddingProvider SelectEmbeddingProvider(GeminiAiProvider gemini, IHttpClientFactory factory, IConfiguration configuration)
    {
        var name = (configuration["AI_EMBEDDING_PROVIDER"] ?? "gemini").Trim().ToLowerInvariant();
        IEmbeddingProvider provider = name switch
        {
            "gemini" => gemini,
            "jina" => new JinaEmbeddingProvider(factory, configuration),
            _ => throw new InvalidOperationException("AI_EMBEDDING_PROVIDER must be gemini or jina.")
        };
        if (!provider.EmbeddingsConfigured)
            logger.LogError("The selected embedding provider {Provider} is not configured; ingestion and search are unavailable", name);
        return provider;
    }

    private void Add(IHttpClientFactory factory, IConfiguration configuration, Dictionary<string, IChatCompletion> candidates,
        string name, string defaultBaseUrl, string? defaultModel)
    {
        var prefix = name.ToUpperInvariant();
        var key = configuration[$"{prefix}_API_KEY"];
        if (string.IsNullOrWhiteSpace(key)) return;
        var model = configuration[$"{prefix}_CHAT_MODEL"];
        if (string.IsNullOrWhiteSpace(model)) model = defaultModel;
        if (string.IsNullOrWhiteSpace(model))
        {
            logger.LogWarning("Chat provider {Provider} has a key but no model; skipping it", name);
            return;
        }
        var baseUrl = configuration[$"{prefix}_BASE_URL"];
        if (string.IsNullOrWhiteSpace(baseUrl)) baseUrl = defaultBaseUrl;
        var advancedModel = configuration[$"{prefix}_ADVANCED_CHAT_MODEL"];
        if (string.IsNullOrWhiteSpace(advancedModel)) advancedModel = model;
        candidates[name] = new OpenAiChatProvider(factory, name, baseUrl, key, model, advancedModel);
    }

    private static bool HasEvidence(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(ChatPrompts.ExtractJson(json));
            return document.RootElement.TryGetProperty("evidence", out var evidence)
                && evidence.ValueKind == JsonValueKind.Array
                && document.RootElement.TryGetProperty("answer", out var answer)
                && answer.ValueKind == JsonValueKind.String;
        }
        catch (JsonException) { return false; }
    }

    private static bool HasSummary(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(ChatPrompts.ExtractJson(json));
            return document.RootElement.TryGetProperty("summary", out var summary) && summary.ValueKind == JsonValueKind.String;
        }
        catch (JsonException) { return false; }
    }

    private static bool HasVerdict(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(ChatPrompts.ExtractJson(json));
            return document.RootElement.TryGetProperty("supported", out var supported)
                && supported.ValueKind is JsonValueKind.True or JsonValueKind.False;
        }
        catch (JsonException) { return false; }
    }
}
