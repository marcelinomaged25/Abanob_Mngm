using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;

internal sealed class JinaEmbeddingProvider : IEmbeddingProvider
{
    private static readonly Regex ModelPattern = new("^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,160}$", RegexOptions.Compiled, TimeSpan.FromSeconds(1));
    private readonly HttpClient client;
    private readonly string key;
    private readonly string endpoint;
    private readonly string model;
    private readonly bool supportsTask;

    public string EmbeddingProfile { get; }
    public int Dimensions { get; }
    public bool EmbeddingsConfigured { get; }

    public JinaEmbeddingProvider(IHttpClientFactory factory, IConfiguration configuration)
    {
        client = factory.CreateClient("knowledge-ai");
        key = configuration["JINA_API_KEY"] ?? "";
        var baseUrl = configuration["JINA_BASE_URL"];
        endpoint = (string.IsNullOrWhiteSpace(baseUrl) ? "https://api.jina.ai/v1" : baseUrl).TrimEnd('/');
        model = CheckModel(configuration["JINA_EMBEDDING_MODEL"] ?? "jina-embeddings-v3");
        Dimensions = int.TryParse(configuration["JINA_EMBEDDING_DIMENSIONS"], out var dimensions) ? dimensions : 1024;
        if (Dimensions is < 32 or > 4096) throw new InvalidOperationException("JINA_EMBEDDING_DIMENSIONS must be between 32 and 4096.");
        supportsTask = model.StartsWith("jina-embeddings-v3", StringComparison.OrdinalIgnoreCase);
        EmbeddingProfile = $"jina:{model}:{Dimensions}:v1";
        EmbeddingsConfigured = !string.IsNullOrWhiteSpace(key);
        if (EmbeddingsConfigured)
        {
            if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var uri))
                throw new InvalidOperationException("JINA_BASE_URL must be an absolute https URL.");
            if (uri.Scheme != Uri.UriSchemeHttps && !uri.IsLoopback)
                throw new InvalidOperationException("JINA_BASE_URL must use https.");
        }
    }

    public async Task<float[][]> EmbedAsync(IReadOnlyList<string> texts, bool query, CancellationToken cancellationToken)
    {
        if (texts.Count == 0) return [];
        if (texts.Count > 20) throw new ArgumentOutOfRangeException(nameof(texts));
        if (!EmbeddingsConfigured) throw new AiProviderException("provider_not_configured");
        var body = supportsTask
            ? (object)new { model, input = texts, task = query ? "retrieval.query" : "retrieval.passage", dimensions = Dimensions }
            : new { model, input = texts };
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(120));
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, $"{endpoint}/embeddings");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
            request.Content = JsonContent.Create(body);
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
            if (!response.IsSuccessStatusCode)
            {
                var status = (int)response.StatusCode;
                throw new AiProviderException(response.StatusCode is HttpStatusCode.TooManyRequests or HttpStatusCode.PaymentRequired
                    ? "provider_rate_limit"
                    : response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden
                        ? "provider_auth"
                        : status >= 500 ? "provider_unavailable" : $"provider_http_{status}");
            }
            using var document = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(deadline.Token), cancellationToken: deadline.Token);
            if (!document.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array || data.GetArrayLength() != texts.Count)
                throw new AiProviderException("invalid_embeddings");
            var vectors = new float[texts.Count][];
            foreach (var item in data.EnumerateArray())
            {
                if (!item.TryGetProperty("index", out var indexElement) || !indexElement.TryGetInt32(out var index)
                    || index < 0 || index >= texts.Count || vectors[index] is not null
                    || !item.TryGetProperty("embedding", out var embeddingElement) || embeddingElement.ValueKind != JsonValueKind.Array)
                    throw new AiProviderException("invalid_embeddings");
                vectors[index] = embeddingElement.EnumerateArray().Select(value => value.GetSingle()).ToArray();
            }
            foreach (var vector in vectors)
            {
                if (vector is null || vector.Length != Dimensions || vector.Any(value => !float.IsFinite(value)))
                    throw new AiProviderException("invalid_embeddings");
                var norm = Math.Sqrt(vector.Sum(value => (double)value * value));
                if (norm <= 0) throw new AiProviderException("invalid_embeddings");
                for (var i = 0; i < vector.Length; i++) vector[i] = (float)(vector[i] / norm);
            }
            return vectors;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { throw new AiProviderException("provider_timeout"); }
        catch (HttpRequestException) { throw new AiProviderException("provider_unavailable"); }
        catch (JsonException) { throw new AiProviderException("invalid_embeddings"); }
        catch (InvalidOperationException) { throw new AiProviderException("invalid_embeddings"); }
    }

    private static string CheckModel(string? model)
    {
        if (string.IsNullOrEmpty(model) || !ModelPattern.IsMatch(model))
            throw new InvalidOperationException("Invalid Jina embedding model name.");
        return model;
    }
}
