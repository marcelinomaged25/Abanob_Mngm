using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Npgsql;

var id = Guid.NewGuid();
var hit = new KnowledgeHit(id, Guid.NewGuid(), "مصدر اختبار", "الطقوس", 135, 0, "الإبصالتس كلمة يونانية معناها مرتل أو منشد. يعمل بحفظ الألحان والترتيل بها.", 0.81);
var evidence = JsonSerializer.Serialize(new { evidence = new[] { new { chunkId = id, segment = 0 } } });
var answer = ChatEngine.Ground(evidence, [hit], Guid.NewGuid().ToString());
Check(answer.Sources.Count == 1 && answer.Sources[0].Page == 135, "citation page preserved");
Check(answer.Answer.Contains(answer.Sources[0].Snippet) && answer.Answer.Contains("إرشاد الكاهن"), "answer is extractive and qualified");
Check(ChatEngine.Ground("{\"evidence\":[]}", [hit], "test").Answer == ChatEngine.Absent, "exact abstention");
Reject(JsonSerializer.Serialize(new { evidence = new[] { new { chunkId = id, quote = "هذا تفسير لم يرد مطلقًا في المصدر." } } }), "fabricated quotation rejected");
Reject(JsonSerializer.Serialize(new { evidence = new[] { new { chunkId = Guid.NewGuid(), segment = 0 } } }), "unknown chunk rejected");
Reject(JsonSerializer.Serialize(new { evidence = new[] { new { chunkId = id, segment = 9 } } }), "unknown evidence segment rejected");
var extraText = JsonSerializer.Serialize(new { evidence = new[] { new { chunkId = id, segment = 0, quote = "نص مختلق من النموذج" } } });
Check(ChatEngine.Ground(extraText, [hit], "test").Sources[0].Snippet == hit.Content, "only original server text can be quoted");
var segmentText = string.Join(" ", Enumerable.Repeat("نص عربي أصلي لا يتغير.", 100));
Check(ChatEngine.EvidenceSegments(segmentText).All(segment => segment.Length <= 1000 && ChatEngine.Normalize(segmentText).Contains(segment)), "evidence segments are bounded literal substrings");
var glossary = hit with { Id = Guid.NewGuid(), Content = "رتب الشمامسة هي رتب للخدمة.", Similarity = 0.70 };
var generic = hit with { Id = Guid.NewGuid(), Content = "خدمة الشمامسة داخل الكنيسة.", Similarity = 0.74 };
Check(ChatEngine.SelectHits("ما هي رتب الشمامسة؟", [generic, glossary])[0].Id == glossary.Id, "hybrid reranking retains exact source terminology");
Reject("not json", "invalid provider JSON rejected");
Reject("{\"evidence\":{}}", "invalid evidence structure rejected");
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
Check(KnowledgeEndpoints.WithDefaultPermissionNote(new KnowledgeSourceSave("عنوان", "الطقوس", "مؤلف", "", true)).PermissionNote == KnowledgeEndpoints.DefaultPermissionNote, "blank permission note records site ownership");
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
