using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Npgsql;
using static ApiHelpers;

LoadEnvironmentFile(FindEnvironmentFile());
var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls(Environment.GetEnvironmentVariable("ASPNETCORE_URLS") ?? "http://localhost:5080");
var connectionString = ConnectionString(Environment.GetEnvironmentVariable("DATABASE_URL") ?? builder.Configuration.GetConnectionString("Database") ?? "");
var appPassword = Environment.GetEnvironmentVariable("APP_PASSWORD") ?? "";
var appUsername = Environment.GetEnvironmentVariable("APP_USERNAME") ?? "admin";
var frontendOrigin = Environment.GetEnvironmentVariable("FRONTEND_ORIGIN") ?? "http://localhost:5173";
if (string.IsNullOrWhiteSpace(connectionString)) throw new InvalidOperationException("Set DATABASE_URL before starting the API.");
if (string.IsNullOrWhiteSpace(appPassword)) throw new InvalidOperationException("Set APP_PASSWORD before starting the API.");

var dataSource = NpgsqlDataSource.Create(connectionString);
builder.Services.AddSingleton(dataSource);
builder.Services.AddCors(options => options.AddPolicy("frontend", policy => policy
    .SetIsOriginAllowed(origin =>
    {
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri)) return false;
        return uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
            || uri.Host.Equals("127.0.0.1", StringComparison.OrdinalIgnoreCase)
            || uri.Host.EndsWith(".vercel.app", StringComparison.OrdinalIgnoreCase)
            || uri.ToString().TrimEnd('/').Equals(frontendOrigin.TrimEnd('/'), StringComparison.OrdinalIgnoreCase);
    })
    .AllowAnyHeader().AllowAnyMethod()));

var app = builder.Build();
app.UseCors("frontend");

await using (var connection = await dataSource.OpenConnectionAsync())
await using (var command = new NpgsqlCommand(await File.ReadAllTextAsync(Path.Combine(AppContext.BaseDirectory, "schema.sql")), connection))
    await command.ExecuteNonQueryAsync();

await using (var connection = await dataSource.OpenConnectionAsync())
await using (var transaction = await connection.BeginTransactionAsync())
{
    await using var marker = new NpgsqlCommand("select exists(select 1 from settings where key='servant-call-credit-kyrillos-samah-to-milad-adly-v1')", connection, transaction);
    var correctionApplied = (bool)(await marker.ExecuteScalarAsync() ?? false);
    if (!correctionApplied)
    {
        await using (var backfill = new NpgsqlCommand("update call_records c set servant=a.servant from people p,call_assignments a where p.id=c.person_id and p.group_number=a.group_number and c.week_start=a.week_start and p.role='boy' and nullif(btrim(c.servant),'') is null and nullif(btrim(a.servant),'') is not null", connection, transaction))
            await backfill.ExecuteNonQueryAsync();
        const string sourceMatch = "regexp_replace(translate(servant,'إأآ','ااا'),'\\s+','','g')=regexp_replace(translate($1,'إأآ','ااا'),'\\s+','','g')";
        await using var countSource = new NpgsqlCommand($"select count(*) from call_records where {sourceMatch}", connection, transaction);
        countSource.Parameters.AddWithValue("كيرلس سامح");
        var sourceCount = Convert.ToInt64(await countSource.ExecuteScalarAsync());
        if (sourceCount == 11)
        {
            await using var transfer = new NpgsqlCommand($"update call_records set servant=$2 where {sourceMatch}", connection, transaction);
            transfer.Parameters.AddWithValue("كيرلس سامح");
            transfer.Parameters.AddWithValue("ميلاد عدلي");
            var transferred = await transfer.ExecuteNonQueryAsync();
            if (transferred == 11)
            {
                await using var saveMarker = new NpgsqlCommand("insert into settings(key,value) values('servant-call-credit-kyrillos-samah-to-milad-adly-v1','true'::jsonb) on conflict(key) do nothing", connection, transaction);
                await saveMarker.ExecuteNonQueryAsync();
            }
        }
    }
    await transaction.CommitAsync();
}

app.MapGet("/", () => Results.Ok(new { service = "Abanob Choir Follow-up API", status = "ok" }));
app.MapGet("/api/health", async (NpgsqlDataSource db) =>
{
    await using var connection = await db.OpenConnectionAsync();
    await using var command = new NpgsqlCommand("select 1", connection);
    await command.ExecuteScalarAsync();
    return Results.Ok(new { ok = true });
});

app.MapGet("/api/public/qr/{token}", async (string token, NpgsqlDataSource db) =>
{
    var attendanceStart = new DateOnly(2026, 10, 2);
    var attendanceThrough = CairoToday();
    await using var connection = await db.OpenConnectionAsync();
    await using var personCommand = new NpgsqlCommand("select id,record_key,name,group_number from people where qr_token=$1 and is_active=true and role='boy'", connection);
    personCommand.Parameters.AddWithValue(token);
    await using var personReader = await personCommand.ExecuteReaderAsync();
    if (!await personReader.ReadAsync()) return Results.NotFound(new { error = "QR code غير صالح أو الاسم غير متاح" });
    var personId = personReader.GetInt64(0);
    var person = new { recordKey = personReader.GetInt32(1), name = personReader.GetString(2), group = personReader.IsDBNull(3) ? "" : personReader.GetString(3) };
    await personReader.CloseAsync();

    var attendance = new List<PublicAttendanceItem>();
    await using (var attendanceCommand = new NpgsqlCommand("select a.attendance_type,a.attendance_date::text,to_char(a.recorded_at at time zone 'Africa/Cairo','YYYY-MM-DD\"T\"HH24:MI:SS'),coalesce(c.comment,'') from attendance_records a left join attendance_comments c on c.person_id=a.person_id and c.attendance_type=a.attendance_type and c.attendance_date=a.attendance_date where a.person_id=$1 and a.attendance_date >= $2 and a.attendance_date <= $3 order by a.attendance_date desc,a.recorded_at desc", connection))
    {
        attendanceCommand.Parameters.AddWithValue(personId);
        attendanceCommand.Parameters.AddWithValue(attendanceStart);
        attendanceCommand.Parameters.AddWithValue(attendanceThrough);
        await using var attendanceReader = await attendanceCommand.ExecuteReaderAsync();
        while (await attendanceReader.ReadAsync()) attendance.Add(new PublicAttendanceItem(attendanceReader.GetString(0), attendanceReader.GetString(1), $"{attendanceReader.GetString(2)}|{attendanceReader.GetString(3)}", attendanceReader.GetString(3)));
    }
    var sessionTotals = new Dictionary<string, int>();
    for (var session = attendanceStart; session <= attendanceThrough; session = session.AddDays(7))
        sessionTotals[session.ToString("yyyy-MM")] = sessionTotals.GetValueOrDefault(session.ToString("yyyy-MM")) + 1;
    var fridaySessions = sessionTotals.Values.Sum();
    var choirCount = attendance.Count(item => item.Type == "choir");
    var massCount = attendance.Count(item => item.Type == "mass");
    var choirAbsent = Math.Max(0, fridaySessions - choirCount);
    var massAbsent = Math.Max(0, fridaySessions - massCount);
    var ratedPerson = new { person.recordKey, person.name, person.group, attendanceStart = attendanceStart.ToString("yyyy-MM-dd"), fridaySessions, choirCount, choirAbsent, choirRate = fridaySessions == 0 ? 0 : (int)Math.Round(choirCount * 100d / fridaySessions), massCount, massAbsent, massRate = fridaySessions == 0 ? 0 : (int)Math.Round(massCount * 100d / fridaySessions) };
    var monthlyAttendance = attendance.GroupBy(item => item.Date![..7]).ToDictionary(group => group.Key, group => new { choir = group.Count(item => item.Type == "choir"), mass = group.Count(item => item.Type == "mass") });
    var monthly = sessionTotals.OrderByDescending(item => item.Key).Select(item =>
    {
        var counts = monthlyAttendance.GetValueOrDefault(item.Key, new { choir = 0, mass = 0 });
        return new { month = item.Key, choir = counts.choir, choirAbsent = Math.Max(0, item.Value - counts.choir), mass = counts.mass, massAbsent = Math.Max(0, item.Value - counts.mass), choirRate = item.Value == 0 ? 0 : (int)Math.Round(counts.choir * 100d / item.Value), massRate = item.Value == 0 ? 0 : (int)Math.Round(counts.mass * 100d / item.Value) };
    }).ToArray();
    var requests = new List<object>();
    await using (var requestCommand = new NpgsqlCommand("select id,request_type,status,created_at::text,message from followup_requests where person_id=$1 order by created_at desc limit 10", connection))
    {
        requestCommand.Parameters.AddWithValue(personId);
        await using var requestReader = await requestCommand.ExecuteReaderAsync();
        while (await requestReader.ReadAsync()) requests.Add(new { id = requestReader.GetInt64(0), type = requestReader.GetString(1), status = requestReader.GetString(2), createdAt = requestReader.GetString(3), message = requestReader.GetString(4) });
    }
    var servants = new List<object>();
    await using (var servantCommand = new NpgsqlCommand(@"
        select p.id, p.name, coalesce(p.phone1, ''), coalesce(p.phone2, ''),
               case when extract(dow from (now() at time zone 'Africa/Cairo'))=5
                         and extract(hour from (now() at time zone 'Africa/Cairo')) >= 12
                         and extract(hour from (now() at time zone 'Africa/Cairo')) < 15 then
                   case when exists (select 1 from attendance_records a where a.person_id=p.id and a.attendance_type='choir' and a.attendance_date=(now() at time zone 'Africa/Cairo')::date) then 'present' else 'absent' end
               else 'available' end
        from people p
        where p.is_active=true and p.role='servant'
        order by p.name", connection))
    await using (var servantReader = await servantCommand.ExecuteReaderAsync())
    {
        while (await servantReader.ReadAsync())
        {
            var phone1 = servantReader.GetString(2);
            var phone2 = servantReader.GetString(3);
            servants.Add(new { id = servantReader.GetInt64(0), name = servantReader.GetString(1), phone1, phone2, choirStatus = servantReader.GetString(4) });
        }
    }
    return Results.Ok(new { person = ratedPerson, attendance, monthly, followUpRequests = requests, servants });
});

app.MapPost("/api/public/qr/{token}/followup-request", async (string token, FollowUpRequestSave payload, NpgsqlDataSource db) =>
{
    if (payload.Type is not ("call" or "visit")) return Results.BadRequest(new { error = "اختر نوع المتابعة" });
    await using var connection = await db.OpenConnectionAsync();
    await using var command = new NpgsqlCommand("insert into followup_requests(person_id,request_type,message) select id,$1,$2 from people where qr_token=$3 and is_active=true and role='boy' and not exists (select 1 from followup_requests r where r.person_id=people.id and r.status in ('new','in_progress') and r.created_at > now() - interval '7 days') returning id", connection);
    command.Parameters.AddWithValue(payload.Type); command.Parameters.AddWithValue(payload.Message?.Trim() ?? ""); command.Parameters.AddWithValue(token);
    var id = await command.ExecuteScalarAsync();
    return id is null ? Results.Conflict(new { error = "يوجد طلب متابعة قائم بالفعل خلال هذا الأسبوع" }) : Results.Ok(new { id });
});

app.MapGet("/api/public/people", async (string? query, NpgsqlDataSource db) =>
{
    var search = query?.Trim() ?? "";
    if (search.Length < 2) return Results.Ok(Array.Empty<object>());
    await using var connection = await db.OpenConnectionAsync();
    await using var command = new NpgsqlCommand("select name,qr_token from people where is_active=true and role='boy' and name ilike $1 order by name limit 20", connection);
    command.Parameters.AddWithValue($"%{search}%");
    await using var reader = await command.ExecuteReaderAsync();
    var people = new List<object>();
    while (await reader.ReadAsync()) people.Add(new { name = reader.GetString(0), token = reader.GetString(1) });
    return Results.Ok(people);
});

app.MapGet("/api/public/learning-items", async (NpgsqlDataSource db) =>
{
    await using var connection = await db.OpenConnectionAsync();
    await using var command = new NpgsqlCommand("select id,lesson_date::text,category,title,resource_url,description,background_url,links::text from learning_items order by lesson_date desc,category,title,id", connection);
    await using var reader = await command.ExecuteReaderAsync();
    var items = new List<object>();
    while (await reader.ReadAsync()) items.Add(new { id = reader.GetInt64(0), date = reader.GetString(1), category = reader.GetString(2), title = reader.GetString(3), url = reader.GetString(4), description = reader.GetString(5), backgroundUrl = reader.GetString(6), links = LearningLinks(reader.GetString(7), reader.GetString(4)) });
    return Results.Ok(items);
});

app.MapGet("/api/public/league", async (string? month, NpgsqlDataSource db) =>
{
    var selectedMonth = DateOnly.TryParseExact($"{month}-01", "yyyy-MM-dd", out var parsedMonth)
        ? new DateOnly(parsedMonth.Year, parsedMonth.Month, 1)
        : new DateOnly(CairoToday().Year, CairoToday().Month, 1);
    var monthEnd = selectedMonth.AddMonths(1);
    var lastFriday = LastFridayOfMonth(selectedMonth);
    var rows = new List<(int RecordKey, string Name, long Points, long Attendance, long Evaluations, long MonthPoints, long MonthAttendance, long MonthEvaluations)>();
    await using var connection = await db.OpenConnectionAsync();
    await using var command = new NpgsqlCommand(@"
        with attendance as (
            select person_id,
                   count(*) filter(where attendance_type='choir') as choir_count,
                   count(*) filter(where attendance_type='mass') as mass_count,
                   count(*) filter(where attendance_type='choir' and attendance_date >= $1 and attendance_date < $2) as month_choir,
                   count(*) filter(where attendance_type='mass' and attendance_date >= $1 and attendance_date < $2) as month_mass
            from attendance_records group by person_id
        ), evaluations as (
            select e.person_id, sum(e.points) as points,
                   sum(e.points) filter(where e.attendance_date >= $1 and e.attendance_date < $2) as month_points
            from choir_evaluations e
            join attendance_records a on a.person_id=e.person_id and a.attendance_type='choir' and a.attendance_date=e.attendance_date
            group by e.person_id
        )
        select p.record_key,p.name,
               coalesce(a.choir_count,0)+coalesce(a.mass_count,0)+coalesce(e.points,0) as points,
               coalesce(a.choir_count,0)+coalesce(a.mass_count,0) as attendance,
               coalesce(e.points,0) as evaluations,
               coalesce(a.month_choir,0)+coalesce(a.month_mass,0)+coalesce(e.month_points,0) as month_points,
               coalesce(a.month_choir,0)+coalesce(a.month_mass,0) as month_attendance,
               coalesce(e.month_points,0) as month_evaluations
        from people p left join attendance a on a.person_id=p.id left join evaluations e on e.person_id=p.id
        where p.is_active=true and p.role='boy'", connection);
    command.Parameters.AddWithValue(selectedMonth);
    command.Parameters.AddWithValue(monthEnd);
    await using (var reader = await command.ExecuteReaderAsync())
        while (await reader.ReadAsync()) rows.Add((reader.GetInt32(0), reader.GetString(1), reader.GetInt64(2), reader.GetInt64(3), reader.GetInt64(4), reader.GetInt64(5), reader.GetInt64(6), reader.GetInt64(7)));
    var rankedRows = rows
        .OrderByDescending(row => row.MonthPoints)
        .ThenByDescending(row => row.MonthAttendance)
        .ThenByDescending(row => row.MonthEvaluations)
        .ThenBy(row => row.Name, StringComparer.Create(System.Globalization.CultureInfo.GetCultureInfo("ar"), false))
        .ToArray();
    var monthlyLeader = rankedRows.FirstOrDefault(row => row.MonthPoints > 0);
    return Results.Ok(new
    {
        month = selectedMonth.ToString("yyyy-MM"),
        lastFriday = lastFriday.ToString("yyyy-MM-dd"),
        isFinalized = lastFriday <= CairoToday(),
        monthlyLeader = monthlyLeader.Name is null ? null : new { name = monthlyLeader.Name, points = monthlyLeader.MonthPoints },
        rows = rankedRows.Select((row, index) => new { rank = index + 1, recordKey = row.RecordKey, name = row.Name, points = row.MonthPoints })
    });
});

var api = app.MapGroup("/api");
api.AddEndpointFilter(async (context, next) =>
{
    var suppliedUsername = context.HttpContext.Request.Headers["X-App-Username"].ToString();
    var supplied = context.HttpContext.Request.Headers["X-App-Password"].ToString();
    if (!string.Equals(suppliedUsername, appUsername, StringComparison.Ordinal)) return Results.Unauthorized();
    var suppliedHash = SHA256.HashData(Encoding.UTF8.GetBytes(supplied));
    var expectedHash = SHA256.HashData(Encoding.UTF8.GetBytes(appPassword));
    if (!CryptographicOperations.FixedTimeEquals(suppliedHash, expectedHash)) return Results.Unauthorized();
    context.HttpContext.Items["role"] = "user";
    return await next(context);
});

api.MapGet("/session", () => Results.Ok(new { role = "user" }));
api.MapGet("/whatsapp-template", async (NpgsqlDataSource db) =>
{
    await using var connection = await db.OpenConnectionAsync();
    var message = await GetSetting<string?>(connection, "strayWhatsAppTemplate") ?? "أهلاً {{name}}، بنطمن عليك. يا رب تكون بخير.";
    return Results.Ok(new { message });
});
api.MapPut("/whatsapp-template", async (WhatsAppTemplateSave payload, NpgsqlDataSource db) =>
{
    var message = payload.Message?.Trim();
    if (string.IsNullOrWhiteSpace(message) || message.Length > 2000) return Results.BadRequest(new { error = "اكتب رسالة من 1 إلى 2000 حرف" });
    await using var connection = await db.OpenConnectionAsync();
    await using var transaction = await connection.BeginTransactionAsync();
    await SetSetting(connection, transaction, "strayWhatsAppTemplate", message);
    await transaction.CommitAsync();
    return Results.Ok(new { message });
});
api.MapGet("/learning-items", async (NpgsqlDataSource db) =>
{
    await using var connection = await db.OpenConnectionAsync();
    await using var command = new NpgsqlCommand("select id,lesson_date::text,category,title,resource_url,description,background_url,links::text from learning_items order by lesson_date desc,category,title,id", connection);
    await using var reader = await command.ExecuteReaderAsync();
    var items = new List<object>();
    while (await reader.ReadAsync()) items.Add(new { id = reader.GetInt64(0), date = reader.GetString(1), category = reader.GetString(2), title = reader.GetString(3), url = reader.GetString(4), description = reader.GetString(5), backgroundUrl = reader.GetString(6), links = LearningLinks(reader.GetString(7), reader.GetString(4)) });
    return Results.Ok(items);
});
api.MapPost("/learning-items", async (LearningItemSave payload, NpgsqlDataSource db) =>
{
    if (!ValidLearningItem(payload, out var lessonDate, out var error)) return Results.BadRequest(new { error });
    await using var connection = await db.OpenConnectionAsync();
    var links = NormalizeLearningLinks(payload.Links, payload.Url);
    await using var command = new NpgsqlCommand("insert into learning_items(lesson_date,category,title,resource_url,description,background_url,links) values($1,$2,$3,$4,$5,$6,$7::jsonb) returning id", connection);
    command.Parameters.AddWithValue(lessonDate); command.Parameters.AddWithValue(payload.Category.Trim()); command.Parameters.AddWithValue(payload.Title.Trim()); command.Parameters.AddWithValue(links[0].Url); command.Parameters.AddWithValue(payload.Description?.Trim() ?? ""); command.Parameters.AddWithValue(payload.BackgroundUrl?.Trim() ?? ""); command.Parameters.AddWithValue(JsonSerializer.Serialize(links));
    var id = (long)(await command.ExecuteScalarAsync())!;
    return Results.Created($"/api/learning-items/{id}", new { id });
});
api.MapPut("/learning-items/{id:long}", async (long id, LearningItemSave payload, NpgsqlDataSource db) =>
{
    if (!ValidLearningItem(payload, out var lessonDate, out var error)) return Results.BadRequest(new { error });
    await using var connection = await db.OpenConnectionAsync();
    var links = NormalizeLearningLinks(payload.Links, payload.Url);
    await using var command = new NpgsqlCommand("update learning_items set lesson_date=$1,category=$2,title=$3,resource_url=$4,description=$5,background_url=$6,links=$7::jsonb,updated_at=now() where id=$8", connection);
    command.Parameters.AddWithValue(lessonDate); command.Parameters.AddWithValue(payload.Category.Trim()); command.Parameters.AddWithValue(payload.Title.Trim()); command.Parameters.AddWithValue(links[0].Url); command.Parameters.AddWithValue(payload.Description?.Trim() ?? ""); command.Parameters.AddWithValue(payload.BackgroundUrl?.Trim() ?? ""); command.Parameters.AddWithValue(JsonSerializer.Serialize(links)); command.Parameters.AddWithValue(id);
    return await command.ExecuteNonQueryAsync() == 0 ? Results.NotFound() : Results.Ok(new { id });
});
api.MapDelete("/learning-items/{id:long}", async (long id, NpgsqlDataSource db) =>
{
    await using var connection = await db.OpenConnectionAsync();
    await using var command = new NpgsqlCommand("delete from learning_items where id=$1", connection);
    command.Parameters.AddWithValue(id);
    return await command.ExecuteNonQueryAsync() == 0 ? Results.NotFound() : Results.NoContent();
});
api.MapGet("/qr/{token}", async (string token, NpgsqlDataSource db) =>
{
    await using var connection = await db.OpenConnectionAsync();
    await using var command = new NpgsqlCommand("select id,record_key,name,phone1,role from people where qr_token=$1 and is_active=true", connection);
    command.Parameters.AddWithValue(token);
    await using var reader = await command.ExecuteReaderAsync();
    if (!await reader.ReadAsync()) return Results.NotFound(new { error = "QR code غير صالح" });
    return Results.Ok(new { id = reader.GetInt64(0), recordKey = reader.GetInt32(1), name = reader.GetString(2), phone1 = reader.GetString(3), role = reader.GetString(4) });
});
api.MapGet("/export/visits", async (NpgsqlDataSource db) =>
{
    await using var connection = await db.OpenConnectionAsync();
    await using var command = new NpgsqlCommand("select v.visit_date::text,p.record_key,p.name,p.phone1,p.address from visit_records v join people p on p.id=v.person_id order by v.visit_date desc,p.record_key", connection);
    await using var reader = await command.ExecuteReaderAsync();
    var csv = new StringBuilder("التاريخ,رقم السجل,الاسم,الهاتف,العنوان\n");
    while (await reader.ReadAsync()) csv.Append(string.Join(',', CsvCell(reader.GetString(0)), reader.GetInt32(1), CsvCell(reader.GetString(2)), CsvCell(reader.GetString(3)), CsvCell(reader.GetString(4)))).Append('\n');
    return Results.Text(csv.ToString(), "text/csv; charset=utf-8");
});

api.MapGet("/state", async (string? mode, string? date, string? week, NpgsqlDataSource db) =>
    Results.Ok(await BuildState(db, mode == "visit" ? "visit" : "call", date, week)));

api.MapGet("/dashboard", async (string? date, string? month, NpgsqlDataSource db) =>
{
    var dashboardDate = ParseDate(date, CairoToday());
    var trendMonth = DateOnly.TryParse($"{month}-01", out var parsedMonth) ? parsedMonth : new DateOnly(dashboardDate.Year, dashboardDate.Month, 1);
    await using var connection = await db.OpenConnectionAsync();
    await using var statsCommand = new NpgsqlCommand("select count(*) filter(where is_active), count(*) filter(where is_active and role='servant'), (select count(*) from visit_records v join people p on p.id=v.person_id where p.is_active), (select count(*) from call_records c join people p on p.id=c.person_id where p.is_active), (select count(*) from attendance_records a join people p on p.id=a.person_id where p.is_active and a.attendance_type='choir'), (select count(*) from attendance_records a join people p on p.id=a.person_id where p.is_active and a.attendance_type='mass') from people", connection);
    await using var stats = await statsCommand.ExecuteReaderAsync();
    await stats.ReadAsync();
    var summary = new { people = stats.GetInt64(0), servants = stats.GetInt64(1), visits = stats.GetInt64(2), calls = stats.GetInt64(3), choirAttendance = stats.GetInt64(4), massAttendance = stats.GetInt64(5) };
    await stats.CloseAsync();
    await using var dailyCommand = new NpgsqlCommand("select count(distinct p.id) filter(where p.is_active and p.role='boy'), count(distinct p.id) filter(where p.is_active and p.role='boy' and a.attendance_type='choir'), count(distinct p.id) filter(where p.is_active and p.role='boy' and a.attendance_type='mass') from people p left join attendance_records a on a.person_id=p.id and a.attendance_date=$1", connection);
    dailyCommand.Parameters.AddWithValue(dashboardDate);
    await using var dailyReader = await dailyCommand.ExecuteReaderAsync();
    await dailyReader.ReadAsync();
    var dailySummary = new { total = dailyReader.GetInt64(0), choirPresent = dailyReader.GetInt64(1), massPresent = dailyReader.GetInt64(2) };
    await dailyReader.CloseAsync();
    await using var peopleCommand = new NpgsqlCommand("select p.id,p.record_key,p.name,p.group_number,p.role,p.phone1,p.phone2,count(distinct a.attendance_date) filter(where a.attendance_type='choir'),count(distinct a.attendance_date) filter(where a.attendance_type='mass'),count(distinct v.visit_date) filter(where p.role<>'servant'),count(distinct (c.person_id,c.week_start)) filter(where c.person_id is not null),max(v.visit_date)::text,(max(a.attendance_date) filter(where a.attendance_type='choir'))::text,(max(a.attendance_date) filter(where a.attendance_type='mass'))::text from people p left join attendance_records a on a.person_id=p.id left join visit_records v on v.person_id=p.id left join call_records c on (p.role='servant' and regexp_replace(translate(c.servant,'إأآ','ااا'),'\\s+','','g') = regexp_replace(translate(p.name,'إأآ','ااا'),'\\s+','','g')) or (p.role<>'servant' and c.person_id=p.id) where p.is_active=true group by p.id order by count(distinct a.attendance_date) filter(where a.attendance_type='choir') + count(distinct a.attendance_date) filter(where a.attendance_type='mass'), count(distinct (c.person_id,c.week_start)) filter(where c.person_id is not null), p.name", connection);
    await using var peopleReader = await peopleCommand.ExecuteReaderAsync();
    var people = new List<object>();
    while (await peopleReader.ReadAsync()) people.Add(new { id = peopleReader.GetInt64(0), recordKey = peopleReader.GetInt32(1), name = peopleReader.GetString(2), group = peopleReader.IsDBNull(3) ? "" : peopleReader.GetString(3), role = peopleReader.GetString(4), phone1 = peopleReader.GetString(5), phone2 = peopleReader.GetString(6), choirCount = peopleReader.GetInt64(7), massCount = peopleReader.GetInt64(8), visitCount = peopleReader.GetInt64(9), callCount = peopleReader.GetInt64(10), lastVisit = peopleReader.IsDBNull(11) ? "" : peopleReader.GetString(11), lastChoir = peopleReader.IsDBNull(12) ? "" : peopleReader.GetString(12), lastMass = peopleReader.IsDBNull(13) ? "" : peopleReader.GetString(13) });
    await peopleReader.CloseAsync();
    await using var calendarCommand = new NpgsqlCommand("select event_date::text, count(*) filter(where kind='choir'), count(*) filter(where kind='mass'), count(*) filter(where kind='visit'), count(*) filter(where kind='call') from (select attendance_date event_date, attendance_type kind from attendance_records union all select visit_date, 'visit' from visit_records union all select (recorded_at at time zone 'Africa/Cairo')::date, 'call' from call_records) events group by event_date order by event_date desc", connection);
    await using var calendarReader = await calendarCommand.ExecuteReaderAsync();
    var calendar = new List<object>();
    while (await calendarReader.ReadAsync()) calendar.Add(new { date = calendarReader.GetString(0), choir = calendarReader.GetInt64(1), mass = calendarReader.GetInt64(2), visits = calendarReader.GetInt64(3), calls = calendarReader.GetInt64(4) });
    await calendarReader.CloseAsync();
    await using var dailyPeopleCommand = new NpgsqlCommand("select p.id,p.name,p.group_number,p.role,coalesce(bool_or(a.attendance_type='choir'),false),coalesce(bool_or(a.attendance_type='mass'),false) from people p left join attendance_records a on a.person_id=p.id and a.attendance_date=$1 where p.is_active=true group by p.id order by p.name", connection);
    dailyPeopleCommand.Parameters.AddWithValue(dashboardDate);
    await using var dailyPeopleReader = await dailyPeopleCommand.ExecuteReaderAsync();
    var dailyPeople = new List<object>();
    while (await dailyPeopleReader.ReadAsync()) dailyPeople.Add(new { id = dailyPeopleReader.GetInt64(0), name = dailyPeopleReader.GetString(1), group = dailyPeopleReader.IsDBNull(2) ? "" : dailyPeopleReader.GetString(2), role = dailyPeopleReader.GetString(3), choirPresent = dailyPeopleReader.GetBoolean(4), massPresent = dailyPeopleReader.GetBoolean(5) });
    await dailyPeopleReader.CloseAsync();
    await using var trendCommand = new NpgsqlCommand("select d::date::text, count(distinct a.person_id) filter(where p.id is not null and a.attendance_type='choir'), count(distinct a.person_id) filter(where p.id is not null and a.attendance_type='mass') from generate_series(date_trunc('month',$1::date)::date, (date_trunc('month',$1::date) + interval '1 month - 1 day')::date, interval '1 day') d left join attendance_records a on a.attendance_date=d::date left join people p on p.id=a.person_id and p.is_active=true and p.role='boy' where extract(dow from d)=5 group by d order by d", connection);
    trendCommand.Parameters.AddWithValue(trendMonth);
    await using var trendReader = await trendCommand.ExecuteReaderAsync();
    var weeklyTrend = new List<object>();
    while (await trendReader.ReadAsync()) weeklyTrend.Add(new { date = trendReader.GetString(0), choir = trendReader.GetInt64(1), mass = trendReader.GetInt64(2) });
    return Results.Ok(new { selectedDate = dashboardDate.ToString("yyyy-MM-dd"), trendMonth = trendMonth.ToString("yyyy-MM"), summary, dailySummary, people, dailyPeople, calendar, weeklyTrend });
});

api.MapGet("/servant-stats", async (int? year, NpgsqlDataSource db) =>
{
    var selectedYear = year ?? CairoToday().Year;
    await using var connection = await db.OpenConnectionAsync();
    var today = CairoToday();
    var rotation = ParseDate(await GetSetting<string?>(connection, "rotationStart"), today);
    var configuredActivityStart = await GetSetting<string?>(connection, "servantActivityStart");
    var activityStart = ParseDate(configuredActivityStart, WeekStart(today, rotation));
    if (configuredActivityStart is null || activityStart > today)
    {
        activityStart = WeekStart(today, rotation);
        await using var startCommand = new NpgsqlCommand("insert into settings(key,value) values('servantActivityStart',$1::jsonb) on conflict(key) do update set value=excluded.value,updated_at=now()", connection);
        startCommand.Parameters.AddWithValue(JsonSerializer.Serialize(activityStart.ToString("yyyy-MM-dd")));
        await startCommand.ExecuteNonQueryAsync();
    }
    var stats = new List<object>();
    await using (var command = new NpgsqlCommand(@"select p.id,p.name,
        (select count(distinct a.attendance_date) from attendance_records a where a.person_id=p.id and a.attendance_type='choir'),
        (select count(distinct a.attendance_date) from attendance_records a where a.person_id=p.id and a.attendance_type='mass'),
        (select count(*) from call_records c where regexp_replace(translate(c.servant,'إأآ','ااا'),'\s+','','g') = regexp_replace(translate(p.name,'إأآ','ااا'),'\s+','','g') or exists (select 1 from people called_person where called_person.id=c.person_id and called_person.group_number in (select ca.group_number from call_assignments ca where ca.week_start=c.week_start and regexp_replace(translate(ca.servant,'إأآ','ااا'),'\s+','','g') = regexp_replace(translate(p.name,'إأآ','ااا'),'\s+','','g')))),
        (select count(distinct c.week_start) from call_records c where regexp_replace(translate(c.servant,'إأآ','ااا'),'\s+','','g') = regexp_replace(translate(p.name,'إأآ','ااا'),'\s+','','g') or exists (select 1 from people called_person where called_person.id=c.person_id and called_person.group_number in (select ca.group_number from call_assignments ca where ca.week_start=c.week_start and regexp_replace(translate(ca.servant,'إأآ','ااا'),'\s+','','g') = regexp_replace(translate(p.name,'إأآ','ااا'),'\s+','','g'))))
        from people p
        where p.is_active=true and p.role='servant'
        order by (select count(*) from call_records c where c.week_start >= $1 and (regexp_replace(translate(c.servant,'إأآ','ااا'),'\s+','','g') = regexp_replace(translate(p.name,'إأآ','ااا'),'\s+','','g') or exists (select 1 from people called_person join call_assignments ca on ca.week_start=c.week_start and ca.group_number=called_person.group_number where called_person.id=c.person_id and regexp_replace(translate(ca.servant,'إأآ','ااا'),'\s+','','g') = regexp_replace(translate(p.name,'إأآ','ااا'),'\s+','','g')))) desc,p.name", connection))
    {
        await using var reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync()) stats.Add(new { id = reader.GetInt64(0), name = reader.GetString(1), choir = reader.GetInt64(2), mass = reader.GetInt64(3), calls = reader.GetInt64(4), callWeeks = reader.GetInt64(5) });
    }
    var monthly = new List<object>();
    await using (var command = new NpgsqlCommand(@"select to_char(month,'YYYY-MM'),sum(choir),sum(mass),sum(calls) from (
        select date_trunc('month',attendance_date)::date month,count(*) filter(where attendance_type='choir') choir,count(*) filter(where attendance_type='mass') mass,0 calls from attendance_records a join people p on p.id=a.person_id where p.is_active=true and p.role='servant' and extract(year from attendance_date)=$1 group by 1
        union all select date_trunc('month',week_start)::date,0,0,count(*) from call_records c join people p on p.is_active=true and p.role='servant' and regexp_replace(translate(c.servant,'إأآ','ااا'),'\s+','','g') = regexp_replace(translate(p.name,'إأآ','ااا'),'\s+','','g') where week_start >= $2 and extract(year from week_start)=$1 group by 1
    ) data group by month order by month", connection))
    {
        command.Parameters.AddWithValue(selectedYear); command.Parameters.AddWithValue(activityStart);
        await using var reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync()) monthly.Add(new { month = reader.GetString(0), choir = reader.GetInt64(1), mass = reader.GetInt64(2), calls = reader.GetInt64(3) });
    }
    return Results.Ok(new { year = selectedYear, activityStart = activityStart.ToString("yyyy-MM-dd"), stats, monthly });
});

api.MapGet("/visit-reports", async (int? year, string? month, NpgsqlDataSource db) =>
{
    var today = CairoToday();
    var selectedYear = year is >= 2000 and <= 2100 ? year.Value : today.Year;
    var monthNumber = DateOnly.TryParse($"{month}-01", out var requestedMonth) && requestedMonth.Year == selectedYear ? requestedMonth.Month : (selectedYear == today.Year ? today.Month : 1);
    var monthStart = new DateOnly(selectedYear, monthNumber, 1);
    var monthEnd = monthStart.AddMonths(1);
    var yearStart = new DateOnly(selectedYear, 1, 1);
    var yearEnd = new DateOnly(selectedYear + 1, 1, 1);
    var monthStartSql = monthStart.ToString("yyyy-MM-dd");
    var monthEndSql = monthEnd.ToString("yyyy-MM-dd");
    var yearStartSql = yearStart.ToString("yyyy-MM-dd");
    var yearEndSql = yearEnd.ToString("yyyy-MM-dd");
    await using var connection = await db.OpenConnectionAsync();
    async Task<long> Scalar(string sql, params (string Name, object Value)[] parameters)
    {
        await using var command = new NpgsqlCommand(sql, connection);
        foreach (var parameter in parameters) command.Parameters.AddWithValue(parameter.Name, parameter.Value);
        return Convert.ToInt64(await command.ExecuteScalarAsync());
    }
    var totalPeople = await Scalar("select count(*) from people where is_active=true and role='boy'");
    var dailyTotal = await Scalar($"select count(distinct person_id) from visit_records where visit_date = DATE '{today:yyyy-MM-dd}'");
    var monthlyTotal = await Scalar($"select count(distinct person_id) from visit_records where visit_date >= DATE '{monthStartSql}' and visit_date < DATE '{monthEndSql}'");
    var yearlyTotal = await Scalar($"select count(distinct person_id) from visit_records where visit_date >= DATE '{yearStartSql}' and visit_date < DATE '{yearEndSql}'");
    var daily = new List<object>();
    await using (var command = new NpgsqlCommand($"select visit_date::text,count(distinct person_id) from visit_records where visit_date >= DATE '{monthStartSql}' and visit_date < DATE '{monthEndSql}' group by visit_date order by visit_date desc", connection))
    {
        await using var reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync()) daily.Add(new { date = reader.GetString(0), count = reader.GetInt64(1) });
    }
    var visitDetails = new Dictionary<string, List<object>>();
    await using (var command = new NpgsqlCommand($"select v.visit_date::text,p.record_key,p.name from visit_records v join people p on p.id=v.person_id where v.visit_date >= DATE '{monthStartSql}' and v.visit_date < DATE '{monthEndSql}' order by v.visit_date,p.name", connection))
    await using (var reader = await command.ExecuteReaderAsync())
    {
        while (await reader.ReadAsync())
        {
            var date = reader.GetString(0);
            if (!visitDetails.TryGetValue(date, out var people)) visitDetails[date] = people = new List<object>();
            people.Add(new { recordKey = reader.GetInt32(1), name = reader.GetString(2) });
        }
    }
    var visitMonthlyDetails = new Dictionary<string, List<object>>();
    await using (var command = new NpgsqlCommand("select to_char(date_trunc('month',v.visit_date),'YYYY-MM'),p.record_key,p.name from visit_records v join people p on p.id=v.person_id where extract(year from v.visit_date)=$1 group by date_trunc('month',v.visit_date),p.record_key,p.name order by date_trunc('month',v.visit_date),p.name", connection))
    {
        command.Parameters.AddWithValue(selectedYear);
        await using var reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            var monthKey = reader.GetString(0);
            if (!visitMonthlyDetails.TryGetValue(monthKey, out var people)) visitMonthlyDetails[monthKey] = people = new List<object>();
            people.Add(new { recordKey = reader.GetInt32(1), name = reader.GetString(2) });
        }
    }
    var visitYearlyDetails = new Dictionary<string, List<object>>();
    await using (var command = new NpgsqlCommand("select extract(year from v.visit_date)::int,p.record_key,p.name from visit_records v join people p on p.id=v.person_id group by extract(year from v.visit_date),p.record_key,p.name order by extract(year from v.visit_date),p.name", connection))
    await using (var reader = await command.ExecuteReaderAsync())
    {
        while (await reader.ReadAsync())
        {
            var yearKey = reader.GetInt32(0).ToString();
            if (!visitYearlyDetails.TryGetValue(yearKey, out var people)) visitYearlyDetails[yearKey] = people = new List<object>();
            people.Add(new { recordKey = reader.GetInt32(1), name = reader.GetString(2) });
        }
    }
    var monthly = new List<object>();
    await using (var command = new NpgsqlCommand("select to_char(date_trunc('month',visit_date),'YYYY-MM'),count(distinct person_id) from visit_records where extract(year from visit_date)=$1 group by date_trunc('month',visit_date) order by date_trunc('month',visit_date)", connection))
    {
        command.Parameters.AddWithValue(selectedYear);
        await using var reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync()) monthly.Add(new { month = reader.GetString(0), count = reader.GetInt64(1) });
    }
    var yearly = new List<object>();
    await using (var command = new NpgsqlCommand("select extract(year from visit_date)::int,count(distinct person_id) from visit_records group by extract(year from visit_date) order by extract(year from visit_date) desc", connection))
    await using (var reader = await command.ExecuteReaderAsync())
        while (await reader.ReadAsync()) yearly.Add(new { year = reader.GetInt32(0), count = reader.GetInt64(1) });
    var callDaily = new List<object>();
    await using (var command = new NpgsqlCommand($"select (recorded_at at time zone 'Africa/Cairo')::date::text,count(distinct person_id) from call_records where (recorded_at at time zone 'Africa/Cairo')::date >= DATE '{monthStartSql}' and (recorded_at at time zone 'Africa/Cairo')::date < DATE '{monthEndSql}' group by (recorded_at at time zone 'Africa/Cairo')::date order by (recorded_at at time zone 'Africa/Cairo')::date desc", connection))
    await using (var reader = await command.ExecuteReaderAsync())
        while (await reader.ReadAsync()) callDaily.Add(new { date = reader.GetString(0), count = reader.GetInt64(1) });
    var callDetails = new Dictionary<string, List<object>>();
    await using (var command = new NpgsqlCommand($"select (c.recorded_at at time zone 'Africa/Cairo')::date::text,p.record_key,p.name,c.servant from call_records c join people p on p.id=c.person_id where (c.recorded_at at time zone 'Africa/Cairo')::date >= DATE '{monthStartSql}' and (c.recorded_at at time zone 'Africa/Cairo')::date < DATE '{monthEndSql}' order by (c.recorded_at at time zone 'Africa/Cairo')::date,p.name", connection))
    await using (var reader = await command.ExecuteReaderAsync())
    {
        while (await reader.ReadAsync())
        {
            var date = reader.GetString(0);
            if (!callDetails.TryGetValue(date, out var people)) callDetails[date] = people = new List<object>();
            people.Add(new { recordKey = reader.GetInt32(1), name = reader.GetString(2), servant = reader.GetString(3) });
        }
    }
    var callMonthlyDetails = new Dictionary<string, List<object>>();
    await using (var command = new NpgsqlCommand("select to_char(date_trunc('month',c.week_start),'YYYY-MM'),p.record_key,p.name,max(c.servant) from call_records c join people p on p.id=c.person_id where extract(year from c.week_start)=$1 group by date_trunc('month',c.week_start),p.record_key,p.name order by date_trunc('month',c.week_start),p.name", connection))
    {
        command.Parameters.AddWithValue(selectedYear);
        await using var reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            var monthKey = reader.GetString(0);
            if (!callMonthlyDetails.TryGetValue(monthKey, out var people)) callMonthlyDetails[monthKey] = people = new List<object>();
            people.Add(new { recordKey = reader.GetInt32(1), name = reader.GetString(2), servant = reader.IsDBNull(3) ? "" : reader.GetString(3) });
        }
    }
    var callYearlyDetails = new Dictionary<string, List<object>>();
    await using (var command = new NpgsqlCommand("select extract(year from c.week_start)::int,p.record_key,p.name,max(c.servant) from call_records c join people p on p.id=c.person_id group by extract(year from c.week_start),p.record_key,p.name order by extract(year from c.week_start),p.name", connection))
    await using (var reader = await command.ExecuteReaderAsync())
    {
        while (await reader.ReadAsync())
        {
            var yearKey = reader.GetInt32(0).ToString();
            if (!callYearlyDetails.TryGetValue(yearKey, out var people)) callYearlyDetails[yearKey] = people = new List<object>();
            people.Add(new { recordKey = reader.GetInt32(1), name = reader.GetString(2), servant = reader.IsDBNull(3) ? "" : reader.GetString(3) });
        }
    }
    var callMonthly = new List<object>();
    await using (var command = new NpgsqlCommand("select to_char(date_trunc('month',week_start),'YYYY-MM'),count(distinct person_id) from call_records where extract(year from week_start)=$1 group by date_trunc('month',week_start) order by date_trunc('month',week_start)", connection))
    {
        command.Parameters.AddWithValue(selectedYear);
        await using var reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync()) callMonthly.Add(new { month = reader.GetString(0), count = reader.GetInt64(1) });
    }
    var callYearly = new List<object>();
    await using (var command = new NpgsqlCommand("select extract(year from week_start)::int,count(distinct person_id) from call_records group by extract(year from week_start) order by extract(year from week_start) desc", connection))
    await using (var reader = await command.ExecuteReaderAsync())
        while (await reader.ReadAsync()) callYearly.Add(new { year = reader.GetInt32(0), count = reader.GetInt64(1) });
    var monthlyCalls = await Scalar($"select count(distinct person_id) from call_records where week_start >= DATE '{monthStartSql}' and week_start < DATE '{monthEndSql}'");
    var yearlyCalls = await Scalar($"select count(distinct person_id) from call_records where week_start >= DATE '{yearStartSql}' and week_start < DATE '{yearEndSql}'");
    var servantStats = new List<object>();
    await using (var servantCommand = new NpgsqlCommand($"select coalesce(nullif(servant,''),'غير محدد'),count(distinct person_id),count(distinct week_start) from call_records where week_start >= DATE '{yearStartSql}' and week_start < DATE '{yearEndSql}' group by 1 order by count(distinct person_id) desc", connection))
    {
        await using var servantReader = await servantCommand.ExecuteReaderAsync();
        while (await servantReader.ReadAsync()) servantStats.Add(new { servant = servantReader.GetString(0), people = servantReader.GetInt64(1), calls = servantReader.GetInt64(2) });
    }
    return Results.Ok(new { year = selectedYear, month = monthStart.ToString("yyyy-MM"), totalPeople, daily, visitDetails, visitMonthlyDetails, visitYearlyDetails, monthly, yearly, callDaily, callDetails, callMonthlyDetails, callYearlyDetails, callMonthly, callYearly, servantStats, totals = new { daily = dailyTotal, monthly = monthlyTotal, yearly = yearlyTotal, monthlyCalls, yearlyCalls } });
});

api.MapGet("/history/{personId:long}", async (long personId, NpgsqlDataSource db) =>
{
    var attendanceStart = new DateOnly(2026, 10, 2);
    var attendanceThrough = CairoToday();
    await using var connection = await db.OpenConnectionAsync();
    await using var personCommand = new NpgsqlCommand("select id, record_key, name, note, phone1, group_number, address from people where id=$1", connection);
    personCommand.Parameters.AddWithValue(personId);
    await using var reader = await personCommand.ExecuteReaderAsync();
    if (!await reader.ReadAsync()) return Results.NotFound(new { error = "الاسم غير موجود" });
    var person = new { id = reader.GetInt64(0), recordKey = reader.GetInt32(1), name = reader.GetString(2), note = reader.IsDBNull(3) ? "" : reader.GetString(3), phone1 = reader.GetString(4), group = reader.IsDBNull(5) ? "" : reader.GetString(5), address = reader.GetString(6) };
    await reader.CloseAsync();
    await using var eventsCommand = new NpgsqlCommand("select event_date::text, bool_or(kind='visit'), bool_or(kind='call'), bool_or(kind='choir'), bool_or(kind='mass'), max(servant) filter(where kind='call'), string_agg(nullif(comment,''), ' / ' order by comment) filter(where comment is not null) from (select visit_date event_date, 'visit' kind, '' servant, null::text comment from visit_records where person_id=$1 union all select (recorded_at at time zone 'Africa/Cairo')::date, 'call', servant, null::text from call_records where person_id=$1 union all select a.attendance_date, a.attendance_type, '', c.comment from attendance_records a left join attendance_comments c on c.person_id=a.person_id and c.attendance_type=a.attendance_type and c.attendance_date=a.attendance_date where a.person_id=$1 and a.attendance_date >= $2 and a.attendance_date <= $3) events group by event_date order by event_date", connection);
    eventsCommand.Parameters.AddWithValue(personId);
    eventsCommand.Parameters.AddWithValue(attendanceStart);
    eventsCommand.Parameters.AddWithValue(attendanceThrough);
    await using var eventsReader = await eventsCommand.ExecuteReaderAsync();
    var events = new List<object>();
    while (await eventsReader.ReadAsync()) events.Add(new { date = eventsReader.GetString(0), visited = eventsReader.GetBoolean(1), called = eventsReader.GetBoolean(2), choir = eventsReader.GetBoolean(3), mass = eventsReader.GetBoolean(4), caller = eventsReader.IsDBNull(5) ? "" : eventsReader.GetString(5), comment = eventsReader.IsDBNull(6) ? "" : eventsReader.GetString(6) });
    await eventsReader.CloseAsync();
    var expectedFridays = 0;
    for (var session = attendanceStart; session <= attendanceThrough; session = session.AddDays(7)) expectedFridays++;
    await using var attendanceSummaryCommand = new NpgsqlCommand("select count(distinct attendance_date) filter(where attendance_type='choir'),count(distinct attendance_date) filter(where attendance_type='mass') from attendance_records where person_id=$1 and attendance_date >= $2 and attendance_date <= $3", connection);
    attendanceSummaryCommand.Parameters.AddWithValue(personId);
    attendanceSummaryCommand.Parameters.AddWithValue(attendanceStart);
    attendanceSummaryCommand.Parameters.AddWithValue(attendanceThrough);
    await using var attendanceSummaryReader = await attendanceSummaryCommand.ExecuteReaderAsync();
    await attendanceSummaryReader.ReadAsync();
    var choir = attendanceSummaryReader.GetInt64(0);
    var mass = attendanceSummaryReader.GetInt64(1);
    var attendanceSummary = new { start = attendanceStart.ToString("yyyy-MM-dd"), expectedFridays, choirPresent = choir, choirAbsent = Math.Max(0, expectedFridays - choir), choirRate = expectedFridays == 0 ? 0 : (int)Math.Round(choir * 100d / expectedFridays), massPresent = mass, massAbsent = Math.Max(0, expectedFridays - mass), massRate = expectedFridays == 0 ? 0 : (int)Math.Round(mass * 100d / expectedFridays) };
    return Results.Ok(new { person, events, attendanceSummary });
});

api.MapGet("/attendance", async (string? type, string? date, NpgsqlDataSource db) =>
{
    var attendanceType = type is "choir" or "mass" ? type : "choir";
    var attendanceDate = ParseDate(date, CairoToday());
    await using var connection = await db.OpenConnectionAsync();
    var attended = new HashSet<long>();
    await using var command = new NpgsqlCommand("select p.record_key from attendance_records a join people p on p.id=a.person_id where a.attendance_type=$1 and a.attendance_date=$2", connection);
    command.Parameters.AddWithValue(attendanceType); command.Parameters.AddWithValue(attendanceDate);
    await using var reader = await command.ExecuteReaderAsync();
    while (await reader.ReadAsync()) attended.Add(reader.GetInt64(0));
    return Results.Ok(new { type = attendanceType, date = attendanceDate.ToString("yyyy-MM-dd"), attended });
});

api.MapPost("/attendance", async (AttendanceSave payload, NpgsqlDataSource db) =>
{
    var attendanceType = payload.Type is "choir" or "mass" ? payload.Type : "";
    if (attendanceType.Length == 0) return Results.BadRequest(new { error = "اختر نوع الحضور" });
    var attendanceDate = ParseDate(payload.Date, CairoToday());
    var checksJson = JsonSerializer.Serialize(payload.Checks ?? new Dictionary<string, bool>());
    await using var connection = await db.OpenConnectionAsync();
    await using var transaction = await connection.BeginTransactionAsync();
    await using (var insert = new NpgsqlCommand("insert into attendance_records(person_id,attendance_type,attendance_date) select p.id,$1,$2 from jsonb_each_text($3::jsonb) checks join people p on p.record_key=checks.key::integer where checks.value='true' and p.is_active=true on conflict do nothing", connection, transaction))
    { insert.Parameters.AddWithValue(attendanceType); insert.Parameters.AddWithValue(attendanceDate); insert.Parameters.AddWithValue(checksJson); await insert.ExecuteNonQueryAsync(); }
    await using (var delete = new NpgsqlCommand("delete from attendance_records a using people p, jsonb_each_text($3::jsonb) checks where a.person_id=p.id and p.record_key=checks.key::integer and checks.value='false' and a.attendance_type=$1 and a.attendance_date=$2", connection, transaction))
    { delete.Parameters.AddWithValue(attendanceType); delete.Parameters.AddWithValue(attendanceDate); delete.Parameters.AddWithValue(checksJson); await delete.ExecuteNonQueryAsync(); }
    await transaction.CommitAsync();
    return Results.Ok(new { type = attendanceType, date = attendanceDate.ToString("yyyy-MM-dd") });
});

api.MapGet("/evaluations", async (string? date, NpgsqlDataSource db) =>
{
    var evaluationDate = ParseDate(date, CairoToday());
    await using var connection = await db.OpenConnectionAsync();
    await using var command = new NpgsqlCommand(@"
        select p.record_key,p.name,e.points
        from attendance_records a
        join people p on p.id=a.person_id
        left join choir_evaluations e on e.person_id=a.person_id and e.attendance_date=a.attendance_date
        where a.attendance_type='choir' and a.attendance_date=$1 and p.is_active=true and p.role='boy'
        order by p.name", connection);
    command.Parameters.AddWithValue(evaluationDate);
    await using var reader = await command.ExecuteReaderAsync();
    var people = new List<object>();
    while (await reader.ReadAsync()) people.Add(new { recordKey = reader.GetInt32(0), name = reader.GetString(1), points = reader.IsDBNull(2) ? (int?)null : reader.GetInt32(2) });
    return Results.Ok(new { date = evaluationDate.ToString("yyyy-MM-dd"), people });
});

api.MapPost("/evaluations", async (EvaluationSave payload, NpgsqlDataSource db) =>
{
    var evaluationDate = ParseDate(payload.Date, CairoToday());
    var scores = payload.Scores ?? new Dictionary<string, int>();
    if (scores.Values.Any(score => score is < 0 or > 10)) return Results.BadRequest(new { error = "التقييم يجب أن يكون من صفر إلى 10" });
    var scoresJson = JsonSerializer.Serialize(scores);
    await using var connection = await db.OpenConnectionAsync();
    await using var command = new NpgsqlCommand(@"
        insert into choir_evaluations(person_id,attendance_date,points)
        select p.id,$1,e.value::integer
        from jsonb_each_text($2::jsonb) e
        join people p on p.record_key=e.key::integer and p.is_active=true and p.role='boy'
        join attendance_records a on a.person_id=p.id and a.attendance_type='choir' and a.attendance_date=$1
        where e.value::integer between 0 and 10
        on conflict(person_id,attendance_date) do update set points=excluded.points,updated_at=now()", connection);
    command.Parameters.AddWithValue(evaluationDate);
    command.Parameters.AddWithValue(scoresJson);
    var saved = await command.ExecuteNonQueryAsync();
    return Results.Ok(new { date = evaluationDate.ToString("yyyy-MM-dd"), saved });
});

api.MapPost("/attendance-comment", async (AttendanceCommentSave payload, NpgsqlDataSource db) =>
{
    if (payload.Type is not ("choir" or "mass") || string.IsNullOrWhiteSpace(payload.Comment)) return Results.BadRequest(new { error = "اكتب تعليقًا صحيحًا" });
    await using var connection = await db.OpenConnectionAsync();
    await using var command = new NpgsqlCommand("insert into attendance_comments(person_id,attendance_type,attendance_date,comment) select id,$1,$2,$3 from people where record_key=$4 and is_active=true on conflict(person_id,attendance_type,attendance_date) do update set comment=excluded.comment,recorded_at=now()", connection);
    command.Parameters.AddWithValue(payload.Type); command.Parameters.AddWithValue(ParseDate(payload.Date, CairoToday())); command.Parameters.AddWithValue(payload.Comment.Trim()); command.Parameters.AddWithValue(payload.RecordKey);
    await command.ExecuteNonQueryAsync();
    return Results.Ok();
});
api.MapDelete("/attendance-comment", async (string type, string date, int recordKey, NpgsqlDataSource db) =>
{
    await using var connection = await db.OpenConnectionAsync();
    await using var command = new NpgsqlCommand("delete from attendance_comments c using people p where c.person_id=p.id and c.attendance_type=$1 and c.attendance_date=$2 and p.record_key=$3", connection);
    command.Parameters.AddWithValue(type); command.Parameters.AddWithValue(ParseDate(date, CairoToday())); command.Parameters.AddWithValue(recordKey);
    await command.ExecuteNonQueryAsync();
    return Results.NoContent();
});
api.MapGet("/followup-notes", async (NpgsqlDataSource db) =>
{
    await using var connection = await db.OpenConnectionAsync();
    await using var command = new NpgsqlCommand("select n.id,n.note_date::text,n.note_type,n.servant,n.note,p.id,p.name,p.group_number from followup_notes n join people p on p.id=n.person_id where p.is_active=true order by n.note_date desc,n.id desc", connection);
    await using var reader = await command.ExecuteReaderAsync();
    var notes = new List<object>();
    while (await reader.ReadAsync()) notes.Add(new { id = reader.GetInt64(0), date = reader.GetString(1), type = reader.GetString(2), servant = reader.GetString(3), note = reader.GetString(4), personId = reader.GetInt64(5), name = reader.GetString(6), group = reader.IsDBNull(7) ? "" : reader.GetString(7) });
    return Results.Ok(notes);
});
api.MapPost("/followup-notes", async (FollowUpNoteSave payload, NpgsqlDataSource db) =>
{
    if (string.IsNullOrWhiteSpace(payload.Note) || payload.Type is not ("visit" or "call")) return Results.BadRequest(new { error = "اكتب الملاحظة واختر نوع الافتقاد" });
    await using var connection = await db.OpenConnectionAsync();
    await using var command = new NpgsqlCommand("insert into followup_notes(person_id,servant,note_type,note_date,note) select id,$1,$2,$3,$4 from people where id=$5 and is_active=true returning id", connection);
    command.Parameters.AddWithValue(payload.Servant?.Trim() ?? ""); command.Parameters.AddWithValue(payload.Type); command.Parameters.AddWithValue(ParseDate(payload.Date, CairoToday())); command.Parameters.AddWithValue(payload.Note.Trim()); command.Parameters.AddWithValue(payload.PersonId);
    var id = await command.ExecuteScalarAsync();
    return id is null ? Results.NotFound(new { error = "الولد غير موجود" }) : Results.Ok(new { id });
});
api.MapDelete("/followup-notes/{id:long}", async (long id, NpgsqlDataSource db) =>
{
    await using var connection = await db.OpenConnectionAsync();
    await using var command = new NpgsqlCommand("delete from followup_notes where id=$1", connection); command.Parameters.AddWithValue(id);
    return await command.ExecuteNonQueryAsync() == 0 ? Results.NotFound() : Results.NoContent();
});
api.MapGet("/followup-requests", async (NpgsqlDataSource db) =>
{
    await using var connection = await db.OpenConnectionAsync();
    await using var command = new NpgsqlCommand("select r.id,r.request_type,r.status,r.message,r.created_at::text,p.id,p.name,p.group_number from followup_requests r join people p on p.id=r.person_id where p.is_active=true order by r.created_at desc", connection);
    await using var reader = await command.ExecuteReaderAsync();
    var requests = new List<object>();
    while (await reader.ReadAsync()) requests.Add(new { id = reader.GetInt64(0), type = reader.GetString(1), status = reader.GetString(2), message = reader.GetString(3), createdAt = reader.GetString(4), personId = reader.GetInt64(5), name = reader.GetString(6), group = reader.IsDBNull(7) ? "" : reader.GetString(7) });
    return Results.Ok(requests);
});
api.MapPatch("/followup-requests/{id:long}", async (long id, FollowUpRequestStatus payload, NpgsqlDataSource db) =>
{
    if (payload.Status is not ("new" or "in_progress" or "done")) return Results.BadRequest(new { error = "حالة الطلب غير صحيحة" });
    await using var connection = await db.OpenConnectionAsync();
    await using var command = new NpgsqlCommand("update followup_requests set status=$1,updated_at=now() where id=$2", connection); command.Parameters.AddWithValue(payload.Status); command.Parameters.AddWithValue(id);
    return await command.ExecuteNonQueryAsync() == 0 ? Results.NotFound() : Results.Ok(new { id, status = payload.Status });
});

api.MapPost("/people", async (PersonInput payload, NpgsqlDataSource db) =>
{
    if (!ValidPerson(payload, out var error)) return Results.BadRequest(new { error });
    await using var connection = await db.OpenConnectionAsync();
    var normalizedRole = NormalizeRole(payload.Role);
    var assignedGroup = normalizedRole != "boy" ? null : string.IsNullOrWhiteSpace(payload.Group) ? await SelectLeastFilledGroupAsync(connection) : payload.Group.Trim();
    await using var command = new NpgsqlCommand("insert into people(record_key,name,note,phone1,phone2,group_number,address,role,qr_token) values((select coalesce(max(record_key),0)+1 from people),$1,$2,$3,$4,$5,$6,$7,$8) returning id", connection);
    command.Parameters.AddWithValue(payload.Name.Trim()); command.Parameters.AddWithValue(payload.Note?.Trim() ?? ""); command.Parameters.AddWithValue(NormalizeEgyptianPhone(payload.Phone1)); command.Parameters.AddWithValue(NormalizeEgyptianPhone(payload.Phone2)); command.Parameters.AddWithValue(string.IsNullOrWhiteSpace(assignedGroup) ? (object)DBNull.Value : assignedGroup.Trim()); command.Parameters.AddWithValue(payload.Address?.Trim() ?? ""); command.Parameters.AddWithValue(normalizedRole); command.Parameters.AddWithValue(Convert.ToHexString(RandomNumberGenerator.GetBytes(18)).ToLowerInvariant());
    var id = (long)(await command.ExecuteScalarAsync())!;
    return Results.Created($"/api/people/{id}", new { id });
});

api.MapPut("/people/{personId:long}", async (long personId, PersonInput payload, NpgsqlDataSource db) =>
{
    if (!ValidPerson(payload, out var error)) return Results.BadRequest(new { error });
    await using var connection = await db.OpenConnectionAsync();
    var normalizedRole = NormalizeRole(payload.Role);
    var currentPerson = await GetPersonAsync(connection, personId);
    var targetGroup = normalizedRole == "servant" ? null : string.IsNullOrWhiteSpace(payload.Group) ? currentPerson?.Group : payload.Group.Trim();
    if (normalizedRole == "boy" && string.IsNullOrWhiteSpace(targetGroup)) targetGroup = await SelectLeastFilledGroupAsync(connection, personId);
    await using var command = new NpgsqlCommand("update people set name=$1,note=$2,phone1=$3,phone2=$4,group_number=$5,address=$6,role=$7,updated_at=now() where id=$8 and is_active=true", connection);
    command.Parameters.AddWithValue(payload.Name.Trim()); command.Parameters.AddWithValue(payload.Note?.Trim() ?? ""); command.Parameters.AddWithValue(NormalizeEgyptianPhone(payload.Phone1)); command.Parameters.AddWithValue(NormalizeEgyptianPhone(payload.Phone2)); command.Parameters.AddWithValue(string.IsNullOrWhiteSpace(targetGroup) ? (object)DBNull.Value : targetGroup.Trim()); command.Parameters.AddWithValue(payload.Address?.Trim() ?? ""); command.Parameters.AddWithValue(normalizedRole); command.Parameters.AddWithValue(personId);
    if (await command.ExecuteNonQueryAsync() == 0) return Results.NotFound(new { error = "الاسم غير موجود" });
    return Results.NoContent();
});

api.MapDelete("/people/{personId:long}", async (long personId, NpgsqlDataSource db) =>
{
    await using var connection = await db.OpenConnectionAsync();
    await using var command = new NpgsqlCommand("update people set is_active=false,updated_at=now() where id=$1 and is_active=true", connection);
    command.Parameters.AddWithValue(personId);
    if (await command.ExecuteNonQueryAsync() == 0) return Results.NotFound(new { error = "الاسم غير موجود" });
    return Results.NoContent();
});

api.MapPost("/visits", async (VisitSave payload, NpgsqlDataSource db) =>
{
    var date = ParseDate(payload.Date, CairoToday());
    await using var connection = await db.OpenConnectionAsync();
    await using var transaction = await connection.BeginTransactionAsync();
    await using (var delete = new NpgsqlCommand("delete from visit_records where visit_date=$1 and person_id in (select id from people where is_active=true and role='boy')", connection, transaction))
    {
        delete.Parameters.AddWithValue(date);
        await delete.ExecuteNonQueryAsync();
    }
    await using (var insert = new NpgsqlCommand("insert into visit_records(person_id,visit_date) select p.id,$1 from jsonb_each_text($2::jsonb) checks join people p on p.record_key=checks.key::integer where checks.value='true' and p.is_active=true and p.role='boy' on conflict do nothing", connection, transaction))
    {
        insert.Parameters.AddWithValue(date);
        insert.Parameters.AddWithValue(JsonSerializer.Serialize(payload.Checks ?? new Dictionary<string, bool>()));
        await insert.ExecuteNonQueryAsync();
    }
    await transaction.CommitAsync();
    return Results.Ok(await BuildState(db, "visit", date.ToString("yyyy-MM-dd"), null));
});

api.MapPost("/calls", async (CallSave payload, NpgsqlDataSource db) =>
{
    var today = CairoToday();
    await using var connection = await db.OpenConnectionAsync();
    await using var transaction = await connection.BeginTransactionAsync();
    var availableServants = new HashSet<string>(StringComparer.Ordinal);
    await using (var servantCommand = new NpgsqlCommand("select name from people where is_active=true and role='servant'", connection, transaction))
    await using (var servantReader = await servantCommand.ExecuteReaderAsync())
        while (await servantReader.ReadAsync()) availableServants.Add(CanonicalServantName(servantReader.GetString(0)));
    var servants = (payload.Servants ?? []).Select(CanonicalServantName).Where(name => name.Length > 0 && availableServants.Contains(name)).Distinct(StringComparer.Ordinal).ToArray();
    if (servants.Length == 0) return Results.BadRequest(new { error = "اختار خادمًا مسجلًا في إدارة الخورس أولًا" });
    var savedRotationStart = await GetSetting<string?>(connection, "rotationStart");
    var rotationStart = ParseDate(payload.RotationStart, ParseDate(savedRotationStart, today));
    var week = today < rotationStart ? rotationStart : WeekStart(today, rotationStart);

    await EnsureGroupSeriesAsync(connection, transaction, Math.Max(1, servants.Length));
    var groups = await LoadGroupNumbersAsync(connection, transaction);
    var existingAssignments = await LoadWeekAssignmentsAsync(connection, transaction, week);
    if (existingAssignments.Count == 0)
    {
        var assignment = Assignments(groups, servants, week, rotationStart);
        foreach (var item in assignment)
        {
            await UpsertAssignmentAsync(connection, transaction, week, item.Key, item.Value);
        }
    }
    else
    {
        var duplicateGroups = existingAssignments
            .GroupBy(item => CanonicalServantName(item.Value), StringComparer.Ordinal)
            .Where(group => group.Count() > 1)
            .SelectMany(group =>
            {
                var ordered = group.OrderBy(item => item.Value == group.Key ? 0 : 1)
                    .ThenBy(item => groups.IndexOf(item.Key))
                    .ToArray();
                return ordered.Skip(1);
            })
            .ToArray();
        var activeGroups = existingAssignments
            .Where(item => !duplicateGroups.Any(duplicate => duplicate.Key == item.Key))
            .Select(item => item.Key)
            .ToList();
        foreach (var duplicateGroup in duplicateGroups)
        {
            if (activeGroups.Count > 0)
                await RedistributeGroupMembersAsync(connection, transaction, duplicateGroup.Key, activeGroups, week);
            await DeleteWeekAssignmentAsync(connection, transaction, week, duplicateGroup.Key);
            existingAssignments.Remove(duplicateGroup.Key);
        }

        var removedGroups = existingAssignments.Where(item => !servants.Contains(CanonicalServantName(item.Value), StringComparer.Ordinal)).ToArray();
        var destinationGroups = existingAssignments
            .Where(item => servants.Contains(CanonicalServantName(item.Value), StringComparer.Ordinal))
            .Select(item => item.Key)
            .ToList();

        if (removedGroups.Length > 0 && destinationGroups.Count > 0)
        {
            var destinationServants = destinationGroups.ToDictionary(group => group, group => existingAssignments[group], StringComparer.Ordinal);
            foreach (var removedGroup in removedGroups)
            {
                await RedistributeAllGroupMembersAsync(connection, transaction, removedGroup.Key, destinationGroups);
                await DeleteWeekAssignmentAsync(connection, transaction, week, removedGroup.Key);
                existingAssignments.Remove(removedGroup.Key);
            }
        }

        var assignedServants = new HashSet<string>(existingAssignments.Values.Select(CanonicalServantName), StringComparer.Ordinal);
        var emptyGroups = groups.Where(group => !existingAssignments.ContainsKey(group)).ToList();
        foreach (var servant in servants.Where(name => !assignedServants.Contains(name)))
        {
            if (emptyGroups.Count == 0) break;
            var groupNumber = emptyGroups[0];
            emptyGroups.RemoveAt(0);
            await UpsertAssignmentAsync(connection, transaction, week, groupNumber, servant);
            existingAssignments[groupNumber] = servant;
        }
    }

    // Only an explicit distribution save may move uncalled boys. A normal
    // group/save action must never rebalance unrelated groups.
    if (payload.Redistribute)
        await BalanceUncalledMembersAsync(connection, transaction, week, existingAssignments.Keys.ToArray());

    // Persist every displayed weekly assignment before writing call records.
    // Auto-assigned groups must still carry their servant into call_records.
    var displayedAssignments = Assignments(groups, servants, week, rotationStart);
    foreach (var item in displayedAssignments)
    {
        if (!existingAssignments.ContainsKey(item.Key))
        {
            await UpsertAssignmentAsync(connection, transaction, week, item.Key, item.Value);
            existingAssignments[item.Key] = item.Value;
        }
    }

    await SetSetting(connection, transaction, "rotationStart", rotationStart.ToString("yyyy-MM-dd"));
    await SetSetting(connection, transaction, "callSelectedServants", servants);

    var checks = payload.Checks ?? new Dictionary<string, bool>();
    await using (var deleteCalls = new NpgsqlCommand("delete from call_records where week_start=$1 and person_id in (select p.id from people p join jsonb_each_text($2::jsonb) checks on checks.key::integer=p.record_key where p.is_active=true and p.role='boy' and checks.value='false')", connection, transaction))
    {
        deleteCalls.Parameters.AddWithValue(week);
        deleteCalls.Parameters.AddWithValue(JsonSerializer.Serialize(checks));
        await deleteCalls.ExecuteNonQueryAsync();
    }
    await using (var saveCalls = new NpgsqlCommand("insert into call_records(person_id,week_start,servant) select p.id,$1,coalesce(a.servant,'') from people p join jsonb_each_text($2::jsonb) checks on checks.key::integer=p.record_key left join call_assignments a on a.week_start=$1 and a.group_number=p.group_number where checks.value='true' and p.is_active=true and p.role='boy' on conflict (person_id,week_start) do nothing", connection, transaction))
    {
        saveCalls.Parameters.AddWithValue(week);
        saveCalls.Parameters.AddWithValue(JsonSerializer.Serialize(checks));
        await saveCalls.ExecuteNonQueryAsync();
    }
    await transaction.CommitAsync();
    return Results.Ok(await BuildState(db, "call", null, null));
});

app.Run();

record Person(long Id, int RecordKey, string Name, string Note, string Phone1, string Phone2, string Group, string Address, string Role, string QrToken);
record Group(string Number, int Members, int[] RecordKeys);
record VisitSave(string Date, Dictionary<string, bool>? Checks);
record CallSave(string? RotationStart, string[]? Servants, Dictionary<string, bool>? Checks, bool Redistribute = false);
record PersonInput(string Name, string? Group, string? Phone1, string? Phone2, string? Address, string? Note, string? Role);
record AttendanceSave(string Type, string Date, Dictionary<string, bool>? Checks);
record EvaluationSave(string Date, Dictionary<string, int>? Scores);
record AttendanceCommentSave(string Type, string Date, int RecordKey, string Comment);
record FollowUpNoteSave(long PersonId, string? Servant, string Type, string Date, string Note);
record FollowUpRequestSave(string Type, string? Message);
record WhatsAppTemplateSave(string? Message);
record LearningItemSave(string Date, string Category, string Title, string Url, string? Description, string? BackgroundUrl, List<LearningResourceLink>? Links);
record LearningResourceLink(string Label, string Url);
record FollowUpRequestStatus(string Status);
record PublicAttendanceItem(string Type, string Date, string RecordedAt, string Comment);
