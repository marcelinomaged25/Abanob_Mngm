[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("FollowUp.Api.Tests")]

internal sealed record KnowledgeHit(Guid Id, Guid SourceId, string Title, string Category, int PageNumber, int ChunkNumber, string Content, double Similarity);

internal interface IAiProvider
{
    string EmbeddingProfile { get; }
    string ChatProfile { get; }
    int Dimensions { get; }
    bool IsConfigured { get; }
    Task<float[][]> EmbedAsync(IReadOnlyList<string> texts, bool query, CancellationToken cancellationToken);
    Task<string> SelectEvidenceAsync(string question, IReadOnlyList<KnowledgeHit> hits, bool advanced, string conversation, CancellationToken cancellationToken);
    Task<string> SummarizeAsync(string previousSummary, string transcript, CancellationToken cancellationToken);
    Task<bool> CheckAsync(CancellationToken cancellationToken);
}

internal interface IChatCompletion
{
    string Name { get; }
    string Profile { get; }
    bool IsConfigured { get; }
    Task<string> SelectEvidenceAsync(string question, IReadOnlyList<KnowledgeHit> hits, bool advanced, string conversation, CancellationToken cancellationToken);
    Task<string> SummarizeAsync(string previousSummary, string transcript, CancellationToken cancellationToken);
    Task<bool> CheckAsync(CancellationToken cancellationToken);
}

internal interface IEmbeddingProvider
{
    string EmbeddingProfile { get; }
    int Dimensions { get; }
    bool EmbeddingsConfigured { get; }
    Task<float[][]> EmbedAsync(IReadOnlyList<string> texts, bool query, CancellationToken cancellationToken);
}

internal interface IKnowledgeVectorStore
{
    Task<IReadOnlyList<KnowledgeHit>> SearchAsync(float[] embedding, string profile, int topK, CancellationToken cancellationToken);
}
