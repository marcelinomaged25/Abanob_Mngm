using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;

internal sealed class OpenAiChatProvider : IChatCompletion
{
    private static readonly Regex ModelPattern = new("^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,160}$", RegexOptions.Compiled, TimeSpan.FromSeconds(1));
    private readonly HttpClient client;
    private readonly string key;
    private readonly string endpoint;
    private readonly string chatModel;
    private readonly string advancedModel;

    public OpenAiChatProvider(IHttpClientFactory factory, string name, string baseUrl, string key, string chatModel, string advancedModel)
    {
        Name = name;
        this.key = key;
        endpoint = (baseUrl ?? "").TrimEnd('/');
        this.chatModel = CheckModel(chatModel);
        this.advancedModel = CheckModel(advancedModel);
        client = factory.CreateClient("knowledge-ai");
        IsConfigured = !string.IsNullOrWhiteSpace(key) && !string.IsNullOrWhiteSpace(endpoint);
        if (IsConfigured)
        {
            if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var uri))
                throw new InvalidOperationException($"{name.ToUpperInvariant()}_BASE_URL must be an absolute https URL.");
            if (uri.Scheme != Uri.UriSchemeHttps && !uri.IsLoopback)
                throw new InvalidOperationException($"{name.ToUpperInvariant()}_BASE_URL must use https.");
        }
    }

    public string Name { get; }
    public string Profile => $"{Name}:{chatModel}";
    public bool IsConfigured { get; }

    public async Task<string> SelectEvidenceAsync(string question, IReadOnlyList<KnowledgeHit> hits, bool advanced, string conversation, CancellationToken cancellationToken)
    {
        var content = await CompleteAsync(advanced ? advancedModel : chatModel, 0.2, 3200, ChatPrompts.EvidenceInstruction,
            ChatPrompts.EvidencePayload(question, hits, conversation), cancellationToken);
        return ChatPrompts.ExtractJson(content);
    }

    public async Task<string> VerifyAsync(string question, string answer, IReadOnlyList<ChatCitation> sources, CancellationToken cancellationToken)
    {
        var content = await CompleteAsync(chatModel, 0, 64, ChatPrompts.VerifyInstruction, ChatPrompts.VerifyPayload(question, answer, sources), cancellationToken, 20);
        return ChatPrompts.ExtractJson(content);
    }

    public async Task<string> SummarizeAsync(string previousSummary, string transcript, CancellationToken cancellationToken)
    {
        var content = await CompleteAsync(chatModel, 0.2, 600, ChatPrompts.SummaryInstruction,
            ChatPrompts.SummaryPayload(previousSummary, transcript), cancellationToken);
        return ChatPrompts.ExtractJson(content);
    }

    public async Task<bool> CheckAsync(CancellationToken cancellationToken)
    {
        if (!IsConfigured) return false;
        try
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(TimeSpan.FromSeconds(15));
            using var request = new HttpRequestMessage(HttpMethod.Get, $"{endpoint}/models");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
            using var response = await client.SendAsync(request, deadline.Token);
            return response.IsSuccessStatusCode;
        }
        catch (HttpRequestException) { return false; }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { return false; }
    }

    private async Task<string> CompleteAsync(string model, double temperature, int maxTokens, string instruction, string payload, CancellationToken cancellationToken, int timeoutSeconds = 45)
    {
        if (!IsConfigured) throw new AiProviderException("provider_not_configured");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(timeoutSeconds));
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, $"{endpoint}/chat/completions");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
            request.Content = JsonContent.Create(new
            {
                model,
                temperature,
                max_tokens = maxTokens,
                messages = new object[]
                {
                    new { role = "system", content = instruction },
                    new { role = "user", content = payload }
                }
            });
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
            if (!document.RootElement.TryGetProperty("choices", out var choices) || choices.GetArrayLength() == 0
                || !choices[0].TryGetProperty("message", out var message))
                throw new AiProviderException("invalid_provider_response");
            var content = ReadContent(message);
            if (string.IsNullOrWhiteSpace(content)) throw new AiProviderException("invalid_provider_response");
            return content;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { throw new AiProviderException("provider_timeout"); }
        catch (HttpRequestException) { throw new AiProviderException("provider_unavailable"); }
        catch (JsonException) { throw new AiProviderException("invalid_provider_response"); }
        catch (InvalidOperationException) { throw new AiProviderException("invalid_provider_response"); }
    }

    private static string ReadContent(JsonElement message)
    {
        if (!message.TryGetProperty("content", out var content)) return "";
        if (content.ValueKind == JsonValueKind.String) return content.GetString() ?? "";
        if (content.ValueKind != JsonValueKind.Array) return "";
        return string.Concat(content.EnumerateArray()
            .Where(part => part.TryGetProperty("text", out var text) && text.ValueKind == JsonValueKind.String)
            .Select(part => part.GetProperty("text").GetString() ?? ""));
    }

    private static string CheckModel(string? model)
    {
        if (string.IsNullOrEmpty(model) || !ModelPattern.IsMatch(model))
            throw new InvalidOperationException("Invalid chat model name.");
        return model;
    }
}
