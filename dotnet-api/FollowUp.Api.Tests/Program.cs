using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Npgsql;

var id = Guid.NewGuid();
var hit = new KnowledgeHit(id, Guid.NewGuid(), "مصدر اختبار", "الطقوس", 135, 0, "الإبصالتس كلمة يونانية معناها مرتل أو منشد. يعمل بحفظ الألحان والترتيل بها.", 0.81);
var rewrite = "الإبصالتس كلمة يونانية تعني المرتل أو المنشد، ووظيفته حفظ الألحان والترتيل بها.";
var evidence = JsonSerializer.Serialize(new { evidence = new[] { new { chunkId = id, segment = 0 } }, answer = rewrite });
var answer = ChatEngine.Ground(evidence, [hit], Guid.NewGuid().ToString());
Check(answer.Sources.Count == 1 && answer.Sources[0].Page == 135, "citation page preserved");
Check(answer.Answer == rewrite, "answer uses only the model rewriting");
Check(!answer.Answer.Contains($"«{answer.Sources[0].Snippet}»"), "answer does not paste the stored chunk verbatim");
Check(ChatEngine.Ground("{\"evidence\":[]}", [hit], "test").Answer == ChatEngine.Absent, "exact abstention");
Reject(JsonSerializer.Serialize(new { evidence = new[] { new { chunkId = id, quote = "هذا تفسير لم يرد مطلقًا في المصدر." } }, answer = rewrite }), "fabricated quotation rejected");
Reject(JsonSerializer.Serialize(new { evidence = new[] { new { chunkId = id, segment = 0 } } }), "evidence without a rewritten answer rejected");
Check(ChatEngine.Ground(JsonSerializer.Serialize(new { evidence = new[] { new { chunkId = id, segment = 0 } }, answer = " " }), [hit], "test").Answer == ChatEngine.Absent, "empty rewriting yields exact abstention");
Reject(JsonSerializer.Serialize(new { evidence = new[] { new { chunkId = id, segment = 0 } }, answer = "قصير" }), "too short rewritten answer rejected");
Reject(JsonSerializer.Serialize(new { evidence = new[] { new { chunkId = Guid.NewGuid(), segment = 0 } }, answer = rewrite }), "unknown chunk rejected");
Reject(JsonSerializer.Serialize(new { evidence = new[] { new { chunkId = id, segment = 9 } }, answer = rewrite }), "unknown evidence segment rejected");
var extraText = JsonSerializer.Serialize(new { evidence = new[] { new { chunkId = id, segment = 0, quote = "نص مختلق من النموذج" } }, answer = rewrite });
Check(ChatEngine.Ground(extraText, [hit], "test").Sources[0].Snippet == hit.Content, "only original server text can be quoted");
var segmentText = string.Join(" ", Enumerable.Repeat("نص عربي أصلي لا يتغير.", 100));
Check(ChatEngine.EvidenceSegments(segmentText).All(segment => segment.Length <= 1000 && ChatEngine.Normalize(segmentText).Contains(segment)), "evidence segments are bounded literal substrings");
var glossary = hit with { Id = Guid.NewGuid(), Content = "رتب الشمامسة هي رتب للخدمة.", Similarity = 0.70 };
var generic = hit with { Id = Guid.NewGuid(), Content = "خدمة الشمامسة داخل الكنيسة.", Similarity = 0.74 };
Check(ChatEngine.SelectHits("ما هي رتب الشمامسة؟", [generic, glossary])[0].Id == glossary.Id, "hybrid reranking retains exact source terminology");
Reject("not json", "invalid provider JSON rejected");
Reject("{\"evidence\":{}}", "invalid evidence structure rejected");
Check(ChatPrompts.ExtractJson("```json\n{\"evidence\":[],\"answer\":\"\"}\n```") == "{\"evidence\":[],\"answer\":\"\"}", "fenced provider JSON unwrapped");
Check(AiProviderRouter.ParseOrder(null).SequenceEqual(AiProviderRouter.DefaultOrder), "default chat provider order");
Check(AiProviderRouter.ParseOrder(" Groq , openrouter,,groq ").SequenceEqual(new[] { "groq", "openrouter" }), "chat provider order parsed and deduplicated");
Check(ChatEngine.Normalize(" نص\n\t  عربي ") == "نص عربي", "whitespace normalized");

using var database = NpgsqlDataSource.Create("Host=127.0.0.1;Database=not_used;Username=not_used;Password=not_used");
var settings = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["APP_PASSWORD"] = "unit-test-secret", ["CHAT_SESSION_SECRET"] = "" }).Build();
var security = new ChatSecurity(database, settings);
var token = security.CreateSession();
Check(security.ValidateSession(token) is not null, "valid signed session");
Check(security.ValidateSession(token[..^1] + (token[^1] == 'A' ? 'B' : 'A')) is null, "tampered session rejected");
Check(security.ValidateSession("0.fake.signature") is null, "expired malformed session rejected");
var different = new ChatSecurity(database, new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["APP_PASSWORD"] = "different-secret" }).Build());
Check(different.ValidateSession(token) is null, "empty optional secret uses server secret");
var parsed = KnowledgeIngestionWorker.ParseJsonl("{\"source\":\"test\",\"page\":135,\"chunk\":0,\"text\":\"أول صفحة من الكتاب\"}\n{\"source\":\"test\",\"page\":136,\"chunk\":0,\"text\":\"ثاني صفحة من الكتاب\"}", CancellationToken.None);
Check(parsed.Pages.Select(page => page.PageNumber).SequenceEqual(new[] { 135, 136 }), "JSONL source pages preserved");
Check(parsed.FailedPages.Length == 0, "valid JSONL extracted");
var malformed = KnowledgeIngestionWorker.ParseJsonl("{\"source\":\"test\",\"page\":135,\"chunk\":0,\"text\":\"نص موجود\"}\n{\"page\":136}", CancellationToken.None);
Check(malformed.FailedPages.Contains(136), "failed JSONL page visible");
var marked = KnowledgeIngestionWorker.ParseText("===== صفحة ١٣٥ =====\nنص الصفحة الأولى\n===== صفحة ١٣٦ =====\nنص الصفحة الثانية", CancellationToken.None);
Check(marked.Pages.Select(page => page.PageNumber).SequenceEqual(new[] { 135, 136 }), "Arabic TXT page markers preserved");
foreach (var length in new[] { 1501, 1700, 2000, 2600, 6000 })
{
    var chunks = KnowledgeIngestionWorker.ChunkPage(new string('س', length), CancellationToken.None).ToArray();
    Check(chunks.All(chunk => chunk.Length is >= 800 and <= 1500), $"bounded chunks for {length} characters");
}
Check(KnowledgeIngestionWorker.ChunkPage("صفحة قصيرة حقيقية", CancellationToken.None).Single() == "صفحة قصيرة حقيقية", "short true page preserved");
Check(KnowledgeEndpoints.ValidateMetadata(new KnowledgeSourceSave("عنوان", "الطقوس", "مؤلف", "", true)) is null, "permission note is optional");
Check(KnowledgeEndpoints.ValidateMetadata(new KnowledgeSourceSave("", "الطقوس", "", "", true)) is null, "title is optional");
Check(KnowledgeEndpoints.DetectType(System.Text.Encoding.UTF8.GetBytes("{\"source\":\"a\",\"page\":1,\"chunk\":0,\"text\":\"نص\"}")) == ".jsonl", "jsonl detected without extension");
Check(KnowledgeEndpoints.DetectType(System.Text.Encoding.UTF8.GetBytes("نص عربي عادي")) == ".txt", "text detected without extension");
Check(KnowledgeEndpoints.DetectType(System.Text.Encoding.ASCII.GetBytes("%PDF-1.7\n")) == ".pdf", "pdf detected without extension");
Check(KnowledgeEndpoints.WithDefaultPermissionNote(new KnowledgeSourceSave("عنوان", "الطقوس", "مؤلف", "", true)).PermissionNote == KnowledgeEndpoints.DefaultPermissionNote, "blank permission note records site ownership");
var goodJson = "{\"evidence\":[],\"answer\":\"\"}";
var fallback = await AiProviderRouter.ChooseAsync(
    new IChatCompletion[] { new FakeChat("primary", fail: "provider_rate_limit"), new FakeChat("secondary", reply: goodJson) },
    provider => provider.SelectEvidenceAsync("ما هي رتب الشمامسة؟", [hit], false, "", CancellationToken.None),
    json => json.Contains("evidence"), (_, _) => { }, CancellationToken.None);
Check(fallback == goodJson, "chat falls back to the next provider after a rate limit");
try
{
    await AiProviderRouter.ChooseAsync(
        new IChatCompletion[] { new FakeChat("primary", fail: "provider_rate_limit"), new FakeChat("secondary", reply: "not json") },
        provider => provider.SelectEvidenceAsync("سؤال", [hit], false, "", CancellationToken.None),
        json => json.Contains("evidence"), (_, _) => { }, CancellationToken.None);
    throw new Exception("all unusable providers rejected");
}
catch (AiProviderException exception) when (exception.Code == "invalid_provider_response")
{
    Console.WriteLine("PASS last provider failure surfaces when all providers fail");
}
var stubListener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
stubListener.Start();
var stubPort = ((System.Net.IPEndPoint)stubListener.LocalEndpoint).Port;
var stubServer = Task.Run(async () =>
{
    using var connection = await stubListener.AcceptTcpClientAsync();
    await using var stream = connection.GetStream();
    var buffer = new byte[65536];
    var read = 0;
    while (true)
    {
        var count = await stream.ReadAsync(buffer.AsMemory(read));
        if (count == 0) break;
        read += count;
        var text = System.Text.Encoding.UTF8.GetString(buffer, 0, read);
        var headerEnd = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
        if (headerEnd < 0) continue;
        var headers = text[..headerEnd];
        var body = text[(headerEnd + 4)..];
        var chunked = headers.Contains("Transfer-Encoding: chunked", StringComparison.OrdinalIgnoreCase);
        var contentLength = headers.Split("\r\n")
            .Where(line => line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))
            .Select(line => int.Parse(line.Split(':', 2)[1].Trim()))
            .FirstOrDefault();
        if (chunked ? body.EndsWith("0\r\n\r\n", StringComparison.Ordinal) : System.Text.Encoding.UTF8.GetByteCount(body) >= contentLength) break;
    }
    var requestText = System.Text.Encoding.UTF8.GetString(buffer, 0, read);
    var requestHeaderEnd = requestText.IndexOf("\r\n\r\n", StringComparison.Ordinal);
    var requestHeaders = requestText[..requestHeaderEnd];
    var requestBody = requestText[(requestHeaderEnd + 4)..];
    if (requestHeaders.Contains("Transfer-Encoding: chunked", StringComparison.OrdinalIgnoreCase)) requestBody = Dechunk(requestBody);
    var payload = JsonSerializer.Serialize(new { choices = new[] { new { message = new { content = "```json\n{\"evidence\":[],\"answer\":\"\"}\n```" } } } });
    var bytes = System.Text.Encoding.UTF8.GetBytes($"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {System.Text.Encoding.UTF8.GetByteCount(payload)}\r\nConnection: close\r\n\r\n{payload}");
    await stream.WriteAsync(bytes);
    await stream.FlushAsync();
    stubListener.Stop();
    return (Headers: requestHeaders, Body: requestBody);
});
var httpFactory = new ServiceCollection().AddHttpClient().BuildServiceProvider().GetRequiredService<IHttpClientFactory>();
var compatible = new OpenAiChatProvider(httpFactory, "openai", $"http://127.0.0.1:{stubPort}/v1", "test-key", "test-model", "test-model");
var compatibleJson = await compatible.SelectEvidenceAsync("ما هي رتب الشمامسة؟", [hit], false, "", CancellationToken.None);
Check(compatibleJson == "{\"evidence\":[],\"answer\":\"\"}", "OpenAI-compatible provider unwraps fenced JSON");
var stubRequest = await stubServer;
Check(stubRequest.Headers.Contains("POST /v1/chat/completions") && stubRequest.Headers.Contains("Bearer test-key"), "OpenAI-compatible request targets chat completions with bearer key");
using var stubBody = JsonDocument.Parse(stubRequest.Body);
Check(stubBody.RootElement.GetProperty("model").GetString() == "test-model", "OpenAI-compatible request carries the model");
using var stubPayload = JsonDocument.Parse(stubBody.RootElement.GetProperty("messages")[1].GetProperty("content").GetString()!);
Check(stubPayload.RootElement.GetProperty("question").GetString() == "ما هي رتب الشمامسة؟", "OpenAI-compatible request carries the question");
var routerSettings = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
{
    ["AI_API_KEY"] = "gemini-test-key",
    ["AI_CHAT_MODEL"] = "gemini-3.1-flash-lite",
    ["OPENROUTER_API_KEY"] = "openrouter-test-key",
    ["OPENROUTER_CHAT_MODEL"] = "provider/model:free",
    ["GROQ_API_KEY"] = "groq-test-key",
    ["OPENAI_API_KEY"] = "openai-test-key",
    ["OPENAI_CHAT_MODEL"] = "gpt-4o-mini",
    ["AI_CHAT_PROVIDERS"] = "gemini,openrouter,groq,deepseek,openai"
}).Build();
var routerFactory = new ServiceCollection().AddHttpClient().BuildServiceProvider().GetRequiredService<IHttpClientFactory>();
var router = new AiProviderRouter(new GeminiAiProvider(routerFactory, routerSettings), routerFactory, routerSettings, NullLogger<AiProviderRouter>.Instance);
Check(router.ChatProfile == "gemini:gemini-3.1-flash-lite/gemini-3.1-flash-lite,openrouter:provider/model:free,groq:llama-3.3-70b-versatile,openai:gpt-4o-mini", "chat provider chain follows configured order");
Check(router.IsConfigured, "router is configured when embeddings and one chat provider exist");
var embedListener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
embedListener.Start();
var embedPort = ((System.Net.IPEndPoint)embedListener.LocalEndpoint).Port;
var embedServer = Task.Run(async () =>
{
    using var connection = await embedListener.AcceptTcpClientAsync();
    await using var stream = connection.GetStream();
    var buffer = new byte[65536];
    var read = 0;
    while (true)
    {
        var count = await stream.ReadAsync(buffer.AsMemory(read));
        if (count == 0) break;
        read += count;
        var text = System.Text.Encoding.UTF8.GetString(buffer, 0, read);
        var headerEnd = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
        if (headerEnd < 0) continue;
        var headers = text[..headerEnd];
        var body = text[(headerEnd + 4)..];
        if (headers.Contains("Transfer-Encoding: chunked", StringComparison.OrdinalIgnoreCase)
            ? body.EndsWith("0\r\n\r\n", StringComparison.Ordinal)
            : body.Length > 0) break;
    }
    var requestText = System.Text.Encoding.UTF8.GetString(buffer, 0, read);
    var requestHeaderEnd = requestText.IndexOf("\r\n\r\n", StringComparison.Ordinal);
    var requestHeaders = requestText[..requestHeaderEnd];
    var requestBody = requestText[(requestHeaderEnd + 4)..];
    if (requestHeaders.Contains("Transfer-Encoding: chunked", StringComparison.OrdinalIgnoreCase)) requestBody = Dechunk(requestBody);
    var first = Enumerable.Repeat(0f, 32).ToArray();
    first[0] = 3;
    first[1] = 4;
    var second = Enumerable.Repeat(0f, 32).ToArray();
    second[3] = 2;
    var payload = JsonSerializer.Serialize(new { data = new object[] { new { index = 1, embedding = second }, new { index = 0, embedding = first } } });
    var bytes = System.Text.Encoding.UTF8.GetBytes($"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {System.Text.Encoding.UTF8.GetByteCount(payload)}\r\nConnection: close\r\n\r\n{payload}");
    await stream.WriteAsync(bytes);
    await stream.FlushAsync();
    embedListener.Stop();
    return (Headers: requestHeaders, Body: requestBody);
});
var jinaSettings = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
{
    ["JINA_API_KEY"] = "jina-test-key",
    ["JINA_BASE_URL"] = $"http://127.0.0.1:{embedPort}/v1",
    ["JINA_EMBEDDING_MODEL"] = "jina-embeddings-v3",
    ["JINA_EMBEDDING_DIMENSIONS"] = "32"
}).Build();
var jinaVectors = await new JinaEmbeddingProvider(routerFactory, jinaSettings).EmbedAsync(["نص أول", "نص ثاني"], false, CancellationToken.None);
Check(jinaVectors.Length == 2 && Math.Abs(jinaVectors[0][0] - 0.6f) < 1e-6 && Math.Abs(jinaVectors[0][1] - 0.8f) < 1e-6, "Jina embeddings sorted by index and normalized");
Check(Math.Abs(jinaVectors[1][3] - 1f) < 1e-6, "second Jina embedding normalized in place");
var embedRequest = await embedServer;
Check(embedRequest.Headers.Contains("POST /v1/embeddings") && embedRequest.Headers.Contains("Bearer jina-test-key"), "Jina embeddings request targets the embeddings endpoint with bearer key");
using var embedBody = JsonDocument.Parse(embedRequest.Body);
Check(embedBody.RootElement.GetProperty("model").GetString() == "jina-embeddings-v3" && embedBody.RootElement.GetProperty("dimensions").GetInt32() == 32, "Jina embeddings request carries model and dimensions");
Check(embedBody.RootElement.GetProperty("task").GetString() == "retrieval.passage", "Jina document embeddings use the passage task");
var jinaRouterSettings = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
{
    ["AI_API_KEY"] = "gemini-test-key",
    ["AI_EMBEDDING_PROVIDER"] = "jina",
    ["JINA_API_KEY"] = "jina-test-key",
    ["JINA_EMBEDDING_DIMENSIONS"] = "512"
}).Build();
var jinaRouter = new AiProviderRouter(new GeminiAiProvider(routerFactory, jinaRouterSettings), routerFactory, jinaRouterSettings, NullLogger<AiProviderRouter>.Instance);
Check(jinaRouter.EmbeddingProfile.StartsWith("jina:jina-embeddings-v3:512:", StringComparison.Ordinal) && jinaRouter.Dimensions == 512 && jinaRouter.IsConfigured, "router switches embeddings to Jina while Gemini stays for chat");
Console.WriteLine("All grounding, ingestion and session unit checks passed.");

void Check(bool condition, string name)
{
    if (!condition) throw new Exception(name);
    Console.WriteLine($"PASS {name}");
}
void Reject(string json, string name)
{
    try { ChatEngine.Ground(json, [hit], "test"); }
    catch (AiProviderException) { Console.WriteLine($"PASS {name}"); return; }
    throw new Exception(name);
}
static string Dechunk(string body)
{
    var result = new System.Text.StringBuilder();
    var index = 0;
    while (index < body.Length)
    {
        var lineEnd = body.IndexOf("\r\n", index, StringComparison.Ordinal);
        if (lineEnd < 0) break;
        var size = Convert.ToInt32(body[index..lineEnd].Split(';')[0], 16);
        if (size == 0) break;
        result.Append(body.Substring(lineEnd + 2, Math.Min(size, body.Length - lineEnd - 2)));
        index = lineEnd + 2 + size + 2;
    }
    return result.ToString();
}

sealed class FakeChat(string name, string? reply = null, string? fail = null) : IChatCompletion
{
    public string Name => name;
    public string Profile => name;
    public bool IsConfigured => true;
    public Task<string> SelectEvidenceAsync(string question, IReadOnlyList<KnowledgeHit> hits, bool advanced, string conversation, CancellationToken cancellationToken) => Run();
    public Task<string> SummarizeAsync(string previousSummary, string transcript, CancellationToken cancellationToken) => Run();
    public Task<bool> CheckAsync(CancellationToken cancellationToken) => Task.FromResult(true);
    private Task<string> Run() => fail is null ? Task.FromResult(reply ?? "") : Task.FromException<string>(new AiProviderException(fail));
}
