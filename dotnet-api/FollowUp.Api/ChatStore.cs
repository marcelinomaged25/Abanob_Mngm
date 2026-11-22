using System.Text.Json;
using Npgsql;

internal sealed record ChatMessageDto(string Role, string Text, IReadOnlyList<ChatCitation> Sources, double Confidence);

internal sealed record ChatConversationDto(string ConversationId, string Title, string Summary, int MessageCount, DateTime UpdatedAt);

internal sealed record ChatConversation(string ConversationId, string Title, string Summary, int SummaryMessageCount, int MessageCount, IReadOnlyList<ChatMessageDto> Messages);

internal sealed class ChatStore(NpgsqlDataSource database)
{
    internal const int MaxConversations = 30;
    internal const int RecentMessages = 40;

    internal async Task<IReadOnlyList<ChatConversationDto>> ListAsync(string owner, CancellationToken cancellationToken)
    {
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var command = new NpgsqlCommand("""
            select c.conversation_id,c.title,c.summary,coalesce(m.message_count,0)::int,c.updated_at
            from chat_conversations c
            left join (select conversation_id,count(*)::int message_count from chat_messages group by conversation_id) m on m.conversation_id=c.conversation_id
            where c.session_hash=$1
            order by c.updated_at desc
            limit $2
            """, connection);
        command.Parameters.AddWithValue(owner);
        command.Parameters.AddWithValue(MaxConversations);
        var conversations = new List<ChatConversationDto>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
            conversations.Add(new ChatConversationDto(reader.GetGuid(0).ToString(), reader.GetString(1), reader.GetString(2), reader.GetInt32(3), reader.GetDateTime(4)));
        return conversations;
    }

    internal async Task<ChatConversation?> GetAsync(Guid id, string owner, CancellationToken cancellationToken)
    {
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        string title;
        string summary;
        int summaryMessageCount;
        int messageCount;
        await using (var command = new NpgsqlCommand("select c.title,c.summary,c.summary_message_count,(select count(*)::int from chat_messages m where m.conversation_id=c.conversation_id) from chat_conversations c where c.conversation_id=$1 and c.session_hash=$2", connection))
        {
            command.Parameters.AddWithValue(id);
            command.Parameters.AddWithValue(owner);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken)) return null;
            title = reader.GetString(0);
            summary = reader.GetString(1);
            summaryMessageCount = reader.GetInt32(2);
            messageCount = reader.GetInt32(3);
        }
        await using var messages = new NpgsqlCommand("""
            select role,content,sources,confidence from (
                select message_id,role,content,sources,confidence from chat_messages where conversation_id=$1 order by message_id desc limit $2
            ) recent order by message_id
            """, connection);
        messages.Parameters.AddWithValue(id);
        messages.Parameters.AddWithValue(RecentMessages);
        var list = new List<ChatMessageDto>();
        await using (var reader = await messages.ExecuteReaderAsync(cancellationToken))
        {
            while (await reader.ReadAsync(cancellationToken))
            {
                var sources = JsonSerializer.Deserialize<ChatCitation[]>(reader.GetString(2)) ?? [];
                list.Add(new ChatMessageDto(reader.GetString(0), reader.GetString(1), sources, reader.GetDouble(3)));
            }
        }
        return new ChatConversation(id.ToString(), title, summary, summaryMessageCount, messageCount, list);
    }

    internal async Task SaveTurnAsync(Guid id, string owner, string title, string question, string answer, IReadOnlyList<ChatCitation> sources, double confidence, CancellationToken cancellationToken)
    {
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await using (var create = new NpgsqlCommand("insert into chat_conversations(conversation_id,session_hash,title) values($1,$2,$3) on conflict(conversation_id) do nothing", connection, transaction))
        {
            create.Parameters.AddWithValue(id);
            create.Parameters.AddWithValue(owner);
            create.Parameters.AddWithValue(title);
            await create.ExecuteNonQueryAsync(cancellationToken);
        }
        await using (var user = new NpgsqlCommand("insert into chat_messages(conversation_id,role,content,sources,confidence) values($1,'user',$2,'[]'::jsonb,0)", connection, transaction))
        {
            user.Parameters.AddWithValue(id);
            user.Parameters.AddWithValue(question);
            await user.ExecuteNonQueryAsync(cancellationToken);
        }
        await using (var assistant = new NpgsqlCommand("insert into chat_messages(conversation_id,role,content,sources,confidence) values($1,'assistant',$2,$3::jsonb,$4)", connection, transaction))
        {
            assistant.Parameters.AddWithValue(id);
            assistant.Parameters.AddWithValue(answer);
            assistant.Parameters.AddWithValue(JsonSerializer.Serialize(sources));
            assistant.Parameters.AddWithValue(confidence);
            await assistant.ExecuteNonQueryAsync(cancellationToken);
        }
        await using (var touch = new NpgsqlCommand("update chat_conversations set updated_at=now() where conversation_id=$1 and session_hash=$2", connection, transaction))
        {
            touch.Parameters.AddWithValue(id);
            touch.Parameters.AddWithValue(owner);
            await touch.ExecuteNonQueryAsync(cancellationToken);
        }
        await using (var trim = new NpgsqlCommand("""
            delete from chat_conversations where session_hash=$1 and conversation_id not in (
                select conversation_id from chat_conversations where session_hash=$1 order by updated_at desc limit $2)
            """, connection, transaction))
        {
            trim.Parameters.AddWithValue(owner);
            trim.Parameters.AddWithValue(MaxConversations);
            await trim.ExecuteNonQueryAsync(cancellationToken);
        }
        await transaction.CommitAsync(cancellationToken);
    }

    internal async Task SaveSummaryAsync(Guid id, string owner, string summary, int messageCount, CancellationToken cancellationToken)
    {
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var command = new NpgsqlCommand("update chat_conversations set summary=$3,summary_message_count=$4,updated_at=now() where conversation_id=$1 and session_hash=$2", connection);
        command.Parameters.AddWithValue(id);
        command.Parameters.AddWithValue(owner);
        command.Parameters.AddWithValue(summary);
        command.Parameters.AddWithValue(messageCount);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    internal async Task<bool> DeleteAsync(Guid id, string owner, CancellationToken cancellationToken)
    {
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var command = new NpgsqlCommand("delete from chat_conversations where conversation_id=$1 and session_hash=$2", connection);
        command.Parameters.AddWithValue(id);
        command.Parameters.AddWithValue(owner);
        return await command.ExecuteNonQueryAsync(cancellationToken) > 0;
    }

    internal static async Task InitializeAsync(NpgsqlDataSource database)
    {
        await using var connection = await database.OpenConnectionAsync();
        await using var command = new NpgsqlCommand("""
            create table if not exists chat_conversations(
                conversation_id uuid primary key,
                session_hash text not null,
                title text not null,
                summary text not null default '',
                summary_message_count integer not null default 0,
                created_at timestamptz not null default now(),
                updated_at timestamptz not null default now());
            create index if not exists chat_conversations_owner_idx on chat_conversations(session_hash,updated_at desc);
            create table if not exists chat_messages(
                message_id bigserial primary key,
                conversation_id uuid not null references chat_conversations(conversation_id) on delete cascade,
                role text not null check(role in ('user','assistant')),
                content text not null,
                sources jsonb not null default '[]'::jsonb,
                confidence double precision not null default 0,
                created_at timestamptz not null default now());
            create index if not exists chat_messages_conversation_idx on chat_messages(conversation_id,message_id);
            """, connection);
        await command.ExecuteNonQueryAsync();
    }
}
