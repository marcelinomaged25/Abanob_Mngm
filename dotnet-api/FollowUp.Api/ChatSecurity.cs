using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Npgsql;

internal sealed class ChatSecurity(NpgsqlDataSource database, IConfiguration configuration)
{
    private readonly byte[] signingKey = SHA256.HashData(Encoding.UTF8.GetBytes(!string.IsNullOrWhiteSpace(configuration["CHAT_SESSION_SECRET"]) ? configuration["CHAT_SESSION_SECRET"]! : configuration["APP_PASSWORD"] ?? throw new InvalidOperationException("Chat session secret is required.")));

    internal string CreateSession()
    {
        var payload = $"{DateTimeOffset.UtcNow.AddHours(12).ToUnixTimeSeconds()}.{Convert.ToHexString(RandomNumberGenerator.GetBytes(16))}";
        return $"{payload}.{Convert.ToHexString(HMACSHA256.HashData(signingKey, Encoding.UTF8.GetBytes(payload)))}";
    }

    internal string? ValidateSession(string token)
    {
        if (token.Length > 160) return null;
        var parts = token.Split('.');
        if (parts.Length != 3 || parts[1].Length != 32 || parts[2].Length != 64 || !long.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out var expires)) return null;
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        if (expires < now || expires > now + 12 * 3600 + 60) return null;
        try
        {
            var expected = HMACSHA256.HashData(signingKey, Encoding.UTF8.GetBytes($"{parts[0]}.{parts[1]}"));
            return CryptographicOperations.FixedTimeEquals(expected, Convert.FromHexString(parts[2])) ? Hash(parts[1]) : null;
        }
        catch (FormatException) { return null; }
    }

    internal static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    internal string Ip(HttpContext context) => Convert.ToHexString(HMACSHA256.HashData(signingKey, Encoding.UTF8.GetBytes(context.Connection.RemoteIpAddress?.ToString() ?? "unknown")));

    internal async Task<bool> AllowAsync(string session, string ip, bool mint, CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var hour = new DateTimeOffset(now.Year, now.Month, now.Day, now.Hour, 0, 0, TimeSpan.Zero);
        var day = hour.Date;
        var buckets = mint
            ? new[] { ("mint-ip", ip, hour, 30), ("mint-global", "global", hour, Limit("CHAT_SESSION_HOURLY_LIMIT", 500)) }
            : new[] { ("session", session, hour, Limit("CHAT_SESSION_HOURLY_LIMIT_ASK", 12)), ("ip", ip, hour, Limit("CHAT_IP_HOURLY_LIMIT", 30)), ("global", "global", new DateTimeOffset(day, TimeSpan.Zero), Limit("CHAT_GLOBAL_DAILY_LIMIT", 200)) };
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        foreach (var (bucket, subject, window, limit) in buckets.OrderBy(x => x.Item1))
        {
            await using var command = new NpgsqlCommand("insert into knowledge_chat_usage(bucket,subject,window_start,request_count) values($1,$2,$3,1) on conflict(bucket,subject,window_start) do update set request_count=knowledge_chat_usage.request_count+1 where knowledge_chat_usage.request_count<$4 returning request_count", connection, transaction);
            command.Parameters.AddWithValue(bucket);
            command.Parameters.AddWithValue(subject);
            command.Parameters.AddWithValue(window);
            command.Parameters.AddWithValue(limit);
            if (await command.ExecuteScalarAsync(cancellationToken) is null)
            {
                await transaction.RollbackAsync(cancellationToken);
                return false;
            }
        }
        await using var cleanup = new NpgsqlCommand("delete from knowledge_chat_usage where window_start < now()-interval '2 days'", connection, transaction);
        await cleanup.ExecuteNonQueryAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return true;
    }

    private int Limit(string name, int fallback) => int.TryParse(configuration[name], out var value) && value > 0 ? value : fallback;

    internal static async Task InitializeAsync(NpgsqlDataSource database)
    {
        await using var connection = await database.OpenConnectionAsync();
        await using var command = new NpgsqlCommand("create table if not exists knowledge_chat_usage(bucket text not null,subject text not null,window_start timestamptz not null,request_count integer not null,primary key(bucket,subject,window_start)); create index if not exists knowledge_chat_usage_expiry on knowledge_chat_usage(window_start);", connection);
        await command.ExecuteNonQueryAsync();
    }
}
