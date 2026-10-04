using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Npgsql;

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
    await using var connection = await db.OpenConnectionAsync();
    await using var personCommand = new NpgsqlCommand("select id,record_key,name,group_number from people where qr_token=$1 and is_active=true and role='boy'", connection);
    personCommand.Parameters.AddWithValue(token);
    await using var personReader = await personCommand.ExecuteReaderAsync();
    if (!await personReader.ReadAsync()) return Results.NotFound(new { error = "QR code غير صالح أو الاسم غير متاح" });
    var personId = personReader.GetInt64(0);
    var person = new { recordKey = personReader.GetInt32(1), name = personReader.GetString(2), group = personReader.IsDBNull(3) ? "" : personReader.GetString(3) };
    await personReader.CloseAsync();

    var attendance = new List<PublicAttendanceItem>();
    await using (var attendanceCommand = new NpgsqlCommand("select a.attendance_type,a.attendance_date::text,to_char(a.recorded_at at time zone 'Africa/Cairo','YYYY-MM-DD\"T\"HH24:MI:SS'),coalesce(c.comment,'') from attendance_records a left join attendance_comments c on c.person_id=a.person_id and c.attendance_type=a.attendance_type and c.attendance_date=a.attendance_date where a.person_id=$1 order by a.attendance_date desc,a.recorded_at desc", connection))
    {
        attendanceCommand.Parameters.AddWithValue(personId);
        await using var attendanceReader = await attendanceCommand.ExecuteReaderAsync();
        while (await attendanceReader.ReadAsync()) attendance.Add(new PublicAttendanceItem(attendanceReader.GetString(0), attendanceReader.GetString(1), $"{attendanceReader.GetString(2)}|{attendanceReader.GetString(3)}", attendanceReader.GetString(3)));
    }
    var sessionTotals = new Dictionary<(string Type, string Month), int>();
    await using (var sessionsCommand = new NpgsqlCommand("select attendance_type,to_char(date_trunc('month',attendance_date),'YYYY-MM'),count(distinct attendance_date) from attendance_records group by attendance_type,date_trunc('month',attendance_date)", connection))
    await using (var sessionsReader = await sessionsCommand.ExecuteReaderAsync())
    {
    while (await sessionsReader.ReadAsync()) sessionTotals[(sessionsReader.GetString(0), sessionsReader.GetString(1))] = sessionsReader.GetInt64(2) > int.MaxValue ? int.MaxValue : (int)sessionsReader.GetInt64(2);
    }
    var firstAttendance = attendance.Count == 0 ? (DateOnly?)null : DateOnly.Parse(attendance.Min(item => item.Date)!);
    var fridaySessions = 0;
    if (firstAttendance is not null)
    {
        await using var fridayCommand = new NpgsqlCommand("select count(*) from generate_series(date_trunc('week',$1::date)::date + 4, current_date, interval '7 days') d", connection);
        fridayCommand.Parameters.AddWithValue(firstAttendance.Value);
        fridaySessions = Convert.ToInt32(await fridayCommand.ExecuteScalarAsync());
    }
    var choirCount = attendance.Count(item => item.Type == "choir");
    var massCount = attendance.Count(item => item.Type == "mass");
    var ratedPerson = new { person.recordKey, person.name, person.group, choirRate = fridaySessions == 0 ? 0 : (int)Math.Round(choirCount * 100d / fridaySessions), massRate = fridaySessions == 0 ? 0 : (int)Math.Round(massCount * 100d / fridaySessions), fridaySessions };
    var monthly = attendance.GroupBy(item => new { Month = item.Date[..7], Type = item.Type })
        .GroupBy(group => group.Key.Month)
        .OrderByDescending(group => group.Key)
        .Select(group => { var choir = group.Where(item => item.Key.Type == "choir").Sum(item => item.Count()); var mass = group.Where(item => item.Key.Type == "mass").Sum(item => item.Count()); var choirSessions = sessionTotals.GetValueOrDefault(("choir", group.Key)); var massSessions = sessionTotals.GetValueOrDefault(("mass", group.Key)); return new { month = group.Key, choir, mass, choirRate = choirSessions == 0 ? 0 : (int)Math.Round(choir * 100d / choirSessions), massRate = massSessions == 0 ? 0 : (int)Math.Round(mass * 100d / massSessions) }; })
        .ToArray();
    return Results.Ok(new { person = ratedPerson, attendance, monthly });
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
    await using var peopleCommand = new NpgsqlCommand("select p.id,p.record_key,p.name,p.group_number,p.role,count(distinct a.attendance_date) filter(where a.attendance_type='choir'),count(distinct a.attendance_date) filter(where a.attendance_type='mass'),count(distinct v.visit_date),count(distinct c.week_start),max(v.visit_date)::text,(max(a.attendance_date) filter(where a.attendance_type='choir'))::text,(max(a.attendance_date) filter(where a.attendance_type='mass'))::text from people p left join attendance_records a on a.person_id=p.id left join visit_records v on v.person_id=p.id left join call_records c on c.person_id=p.id where p.is_active=true group by p.id order by count(distinct a.attendance_date) filter(where a.attendance_type='choir') + count(distinct a.attendance_date) filter(where a.attendance_type='mass'), count(distinct v.visit_date) + count(distinct c.week_start), p.name", connection);
    await using var peopleReader = await peopleCommand.ExecuteReaderAsync();
    var people = new List<object>();
    while (await peopleReader.ReadAsync()) people.Add(new { id = peopleReader.GetInt64(0), recordKey = peopleReader.GetInt32(1), name = peopleReader.GetString(2), group = peopleReader.IsDBNull(3) ? "" : peopleReader.GetString(3), role = peopleReader.GetString(4), choirCount = peopleReader.GetInt64(5), massCount = peopleReader.GetInt64(6), visitCount = peopleReader.GetInt64(7), callCount = peopleReader.GetInt64(8), lastVisit = peopleReader.IsDBNull(9) ? "" : peopleReader.GetString(9), lastChoir = peopleReader.IsDBNull(10) ? "" : peopleReader.GetString(10), lastMass = peopleReader.IsDBNull(11) ? "" : peopleReader.GetString(11) });
    await peopleReader.CloseAsync();
    await using var calendarCommand = new NpgsqlCommand("select event_date::text, count(*) filter(where kind='choir'), count(*) filter(where kind='mass'), count(*) filter(where kind='visit'), count(*) filter(where kind='call') from (select attendance_date event_date, attendance_type kind from attendance_records union all select visit_date, 'visit' from visit_records union all select week_start, 'call' from call_records) events group by event_date order by event_date desc", connection);
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
    await using var trendCommand = new NpgsqlCommand("select d::date::text, count(distinct a.person_id) filter(where a.attendance_type='choir'), count(distinct a.person_id) filter(where a.attendance_type='mass') from generate_series(date_trunc('month',$1::date)::date, (date_trunc('month',$1::date) + interval '1 month - 1 day')::date, interval '1 day') d left join attendance_records a on a.attendance_date=d::date where extract(dow from d)=5 group by d order by d", connection);
    trendCommand.Parameters.AddWithValue(trendMonth);
    await using var trendReader = await trendCommand.ExecuteReaderAsync();
    var weeklyTrend = new List<object>();
    while (await trendReader.ReadAsync()) weeklyTrend.Add(new { date = trendReader.GetString(0), choir = trendReader.GetInt64(1), mass = trendReader.GetInt64(2) });
    await trendReader.CloseAsync();
    var assistantInsights = await BuildAssistantInsights(connection, dashboardDate);
    return Results.Ok(new { selectedDate = dashboardDate.ToString("yyyy-MM-dd"), trendMonth = trendMonth.ToString("yyyy-MM"), summary, dailySummary, people, dailyPeople, calendar, weeklyTrend, assistantInsights });
});

api.MapGet("/assistant", async (string? question, NpgsqlDataSource db) =>
{
    await using var connection = await db.OpenConnectionAsync();
    var insights = await BuildAssistantInsights(connection, CairoToday());
    var text = (question ?? "").Trim();
    var normalized = NormalizeArabic(text);
    var asksForChoir = normalized.Contains("خورس");
    var asksForMass = normalized.Contains("قداس");
    var wantsAbsence = normalized.Contains("غياب") || normalized.Contains("متابعه") || normalized.Contains("متابعة") || normalized.Contains("اسبوع") || normalized.Contains("أسبوع") || asksForChoir || asksForMass;
    if (string.IsNullOrWhiteSpace(text) || wantsAbsence)
    {
        var people = insights.RepeatedAbsences.Where(person => !asksForChoir || person.ChoirMissed > 0).Where(person => !asksForMass || person.MassMissed > 0).ToList();
        var subject = asksForChoir && !asksForMass ? "الخورس" : asksForMass && !asksForChoir ? "القداس" : "الخورس والقداس";
        return Results.Ok(new { answer = people.Count == 0 ? $"لا توجد حالات غياب متكرر عن {subject} تحتاج متابعة حاليًا." : $"وجدت {people.Count} حالة تحتاج متابعة بسبب الغياب عن {subject}.", people, kind = "absence" });
    }

    await using var command = new NpgsqlCommand("select id,record_key,name,group_number from people where is_active=true and role='boy' and name ilike $1 order by name limit 20", connection);
    command.Parameters.AddWithValue($"%{text}%");
    await using var reader = await command.ExecuteReaderAsync();
    var matches = new List<object>();
    while (await reader.ReadAsync()) matches.Add(new { id = reader.GetInt64(0), recordKey = reader.GetInt32(1), name = reader.GetString(2), group = reader.IsDBNull(3) ? "" : reader.GetString(3) });
    return Results.Ok(new { answer = matches.Count == 0 ? "لم أجد اسمًا مطابقًا في البيانات الحالية." : $"وجدت {matches.Count} اسم مطابق للبحث.", people = matches, kind = "search" });
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
    await using (var command = new NpgsqlCommand($"select week_start::text,count(distinct person_id) from call_records where week_start >= DATE '{monthStartSql}' and week_start < DATE '{monthEndSql}' group by week_start order by week_start desc", connection))
    await using (var reader = await command.ExecuteReaderAsync())
        while (await reader.ReadAsync()) callDaily.Add(new { date = reader.GetString(0), count = reader.GetInt64(1) });
    var callDetails = new Dictionary<string, List<object>>();
    await using (var command = new NpgsqlCommand($"select c.week_start::text,p.record_key,p.name,c.servant from call_records c join people p on p.id=c.person_id where c.week_start >= DATE '{monthStartSql}' and c.week_start < DATE '{monthEndSql}' order by c.week_start,p.name", connection))
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
    await using var connection = await db.OpenConnectionAsync();
    await using var personCommand = new NpgsqlCommand("select id, record_key, name, note, phone1, group_number, address from people where id=$1", connection);
    personCommand.Parameters.AddWithValue(personId);
    await using var reader = await personCommand.ExecuteReaderAsync();
    if (!await reader.ReadAsync()) return Results.NotFound(new { error = "الاسم غير موجود" });
    var person = new { id = reader.GetInt64(0), recordKey = reader.GetInt32(1), name = reader.GetString(2), note = reader.IsDBNull(3) ? "" : reader.GetString(3), phone1 = reader.GetString(4), group = reader.IsDBNull(5) ? "" : reader.GetString(5), address = reader.GetString(6) };
    await reader.CloseAsync();
    await using var eventsCommand = new NpgsqlCommand("select event_date::text, bool_or(kind='visit'), bool_or(kind='call'), bool_or(kind='choir'), bool_or(kind='mass'), max(servant) filter(where kind='call'), string_agg(nullif(comment,''), ' / ' order by comment) filter(where comment is not null) from (select visit_date event_date, 'visit' kind, '' servant, null::text comment from visit_records where person_id=$1 union all select week_start, 'call', servant, null::text from call_records where person_id=$1 union all select a.attendance_date, a.attendance_type, '', c.comment from attendance_records a left join attendance_comments c on c.person_id=a.person_id and c.attendance_type=a.attendance_type and c.attendance_date=a.attendance_date where a.person_id=$1) events group by event_date order by event_date", connection);
    eventsCommand.Parameters.AddWithValue(personId);
    await using var eventsReader = await eventsCommand.ExecuteReaderAsync();
    var events = new List<object>();
    while (await eventsReader.ReadAsync()) events.Add(new { date = eventsReader.GetString(0), visited = eventsReader.GetBoolean(1), called = eventsReader.GetBoolean(2), choir = eventsReader.GetBoolean(3), mass = eventsReader.GetBoolean(4), caller = eventsReader.IsDBNull(5) ? "" : eventsReader.GetString(5), comment = eventsReader.IsDBNull(6) ? "" : eventsReader.GetString(6) });
    return Results.Ok(new { person, events });
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
    await using var connection = await db.OpenConnectionAsync();
    await using var transaction = await connection.BeginTransactionAsync();
    await using (var delete = new NpgsqlCommand("delete from attendance_records where attendance_type=$1 and attendance_date=$2", connection, transaction))
    { delete.Parameters.AddWithValue(attendanceType); delete.Parameters.AddWithValue(attendanceDate); await delete.ExecuteNonQueryAsync(); }
    await using (var insert = new NpgsqlCommand("insert into attendance_records(person_id,attendance_type,attendance_date) select p.id,$1,$2 from jsonb_each_text($3::jsonb) checks join people p on p.record_key=checks.key::integer where checks.value='true' and p.is_active=true on conflict do nothing", connection, transaction))
    { insert.Parameters.AddWithValue(attendanceType); insert.Parameters.AddWithValue(attendanceDate); insert.Parameters.AddWithValue(JsonSerializer.Serialize(payload.Checks ?? new Dictionary<string, bool>())); await insert.ExecuteNonQueryAsync(); }
    await transaction.CommitAsync();
    return Results.Ok(new { type = attendanceType, date = attendanceDate.ToString("yyyy-MM-dd") });
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

api.MapPost("/people", async (PersonInput payload, NpgsqlDataSource db) =>
{
    if (!ValidPerson(payload, out var error)) return Results.BadRequest(new { error });
    await using var connection = await db.OpenConnectionAsync();
    await using var command = new NpgsqlCommand("insert into people(record_key,name,note,phone1,phone2,group_number,address,role,qr_token) values((select coalesce(max(record_key),0)+1 from people),$1,$2,$3,$4,$5,$6,$7,$8) returning id", connection);
    command.Parameters.AddWithValue(payload.Name.Trim()); command.Parameters.AddWithValue(payload.Note?.Trim() ?? ""); command.Parameters.AddWithValue(NormalizeEgyptianPhone(payload.Phone1)); command.Parameters.AddWithValue(NormalizeEgyptianPhone(payload.Phone2)); command.Parameters.AddWithValue(string.IsNullOrWhiteSpace(payload.Group) ? (object)DBNull.Value : payload.Group.Trim()); command.Parameters.AddWithValue(payload.Address?.Trim() ?? ""); command.Parameters.AddWithValue(NormalizeRole(payload.Role)); command.Parameters.AddWithValue(Convert.ToHexString(RandomNumberGenerator.GetBytes(18)).ToLowerInvariant());
    var id = (long)(await command.ExecuteScalarAsync())!;
    return Results.Created($"/api/people/{id}", new { id });
});

api.MapPut("/people/{personId:long}", async (long personId, PersonInput payload, NpgsqlDataSource db) =>
{
    if (!ValidPerson(payload, out var error)) return Results.BadRequest(new { error });
    await using var connection = await db.OpenConnectionAsync();
    await using var command = new NpgsqlCommand("update people set name=$1,note=$2,phone1=$3,phone2=$4,group_number=$5,address=$6,role=$7,updated_at=now() where id=$8 and is_active=true", connection);
    command.Parameters.AddWithValue(payload.Name.Trim()); command.Parameters.AddWithValue(payload.Note?.Trim() ?? ""); command.Parameters.AddWithValue(NormalizeEgyptianPhone(payload.Phone1)); command.Parameters.AddWithValue(NormalizeEgyptianPhone(payload.Phone2)); command.Parameters.AddWithValue(string.IsNullOrWhiteSpace(payload.Group) ? (object)DBNull.Value : payload.Group.Trim()); command.Parameters.AddWithValue(payload.Address?.Trim() ?? ""); command.Parameters.AddWithValue(NormalizeRole(payload.Role)); command.Parameters.AddWithValue(personId);
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
    await using (var delete = new NpgsqlCommand("delete from visit_records where visit_date=$1 and person_id in (select id from people where is_active=true)", connection, transaction))
    {
        delete.Parameters.AddWithValue(date);
        await delete.ExecuteNonQueryAsync();
    }
    await using (var insert = new NpgsqlCommand("insert into visit_records(person_id,visit_date) select p.id,$1 from jsonb_each_text($2::jsonb) checks join people p on p.record_key=checks.key::integer where checks.value='true' and p.is_active=true on conflict do nothing", connection, transaction))
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
    var servants = (payload.Servants ?? []).Select(name => name.Trim()).Where(name => name.Length > 0).Distinct(StringComparer.Ordinal).ToArray();
    if (servants.Length == 0) return Results.BadRequest(new { error = "أضف أسماء الخدام أولًا" });
    await using var connection = await db.OpenConnectionAsync();
    await using var transaction = await connection.BeginTransactionAsync();
    var savedRotationStart = await GetSetting<string?>(connection, "rotationStart");
    var rotationStart = ParseDate(payload.RotationStart, ParseDate(savedRotationStart, today));
    // Allow editing the servant list before the first rotation date; keep the
    // saved start date as the week that receives the new distribution.
    var week = today < rotationStart ? rotationStart : WeekStart(today, rotationStart);
    // Keep call groups dynamic: one nearly equal group per servant.
    await using (var regroupGroups = new NpgsqlCommand(@"
        insert into groups(number, display_order)
        select x::text, x from generate_series(1, $1) x
        on conflict (number) do update set display_order = excluded.display_order;", connection, transaction))
    {
        regroupGroups.Parameters.AddWithValue(servants.Length);
        await regroupGroups.ExecuteNonQueryAsync();
    }
    await using (var regroupPeople = new NpgsqlCommand(@"
        with ranked as (
          select id, ((row_number() over(order by record_key) - 1) % $1 + 1)::text as next_group
          from people where is_active = true and role = 'boy'
        )
        update people p set group_number = ranked.next_group, updated_at = now()
        from ranked where p.id = ranked.id;", connection, transaction))
    {
        regroupPeople.Parameters.AddWithValue(servants.Length);
        await regroupPeople.ExecuteNonQueryAsync();
    }
    var groups = new List<string>();
    await using (var groupCommand = new NpgsqlCommand("select g.number from groups g where exists (select 1 from people p where p.group_number=g.number and p.is_active=true and p.role='boy') order by g.display_order", connection, transaction))
    await using (var reader = await groupCommand.ExecuteReaderAsync())
        while (await reader.ReadAsync()) groups.Add(reader.GetString(0));
    var assignment = Assignments(groups, servants, week, rotationStart);
    await SetSetting(connection, transaction, "servants", servants);
    await SetSetting(connection, transaction, "rotationStart", rotationStart.ToString("yyyy-MM-dd"));
    await using (var deleteAssignments = new NpgsqlCommand("delete from call_assignments where week_start=$1", connection, transaction))
    {
        deleteAssignments.Parameters.AddWithValue(week);
        await deleteAssignments.ExecuteNonQueryAsync();
    }
    foreach (var (group, servant) in assignment)
    await using (var assign = new NpgsqlCommand("insert into call_assignments(week_start,group_number,servant) values($1,$2,$3)", connection, transaction))
    {
        assign.Parameters.AddWithValue(week); assign.Parameters.AddWithValue(group); assign.Parameters.AddWithValue(servant);
        await assign.ExecuteNonQueryAsync();
    }
    await using (var deleteCalls = new NpgsqlCommand("delete from call_records where week_start=$1 and person_id in (select id from people where is_active=true)", connection, transaction))
    {
        deleteCalls.Parameters.AddWithValue(week);
        await deleteCalls.ExecuteNonQueryAsync();
    }
    await using (var saveCalls = new NpgsqlCommand("insert into call_records(person_id,week_start,servant) select p.id,$1,coalesce(a.servant,'') from people p join jsonb_each_text($2::jsonb) checks on checks.key::integer=p.record_key left join call_assignments a on a.week_start=$1 and a.group_number=p.group_number where checks.value='true' and p.is_active=true", connection, transaction))
    {
        saveCalls.Parameters.AddWithValue(week);
        saveCalls.Parameters.AddWithValue(JsonSerializer.Serialize(payload.Checks ?? new Dictionary<string, bool>()));
        await saveCalls.ExecuteNonQueryAsync();
    }
    await transaction.CommitAsync();
    return Results.Ok(await BuildState(db, "call", null, null));
});

app.Run();

static async Task<AssistantInsights> BuildAssistantInsights(NpgsqlConnection connection, DateOnly today)
{
    const string sql = """
        with sessions as (
            select attendance_type, count(distinct attendance_date)::int as total
            from attendance_records
            group by attendance_type
        ), attendance as (
            select person_id,
                count(distinct attendance_date) filter (where attendance_type='choir')::int as choir_count,
                count(distinct attendance_date) filter (where attendance_type='mass')::int as mass_count,
                max(attendance_date) filter (where attendance_type='choir')::text as last_choir,
                max(attendance_date) filter (where attendance_type='mass')::text as last_mass
            from attendance_records
            group by person_id
        )
        select p.id,p.record_key,p.name,coalesce(p.group_number,''),
            coalesce(a.choir_count,0),coalesce(a.mass_count,0),
            coalesce((select total from sessions where attendance_type='choir'),0),
            coalesce((select total from sessions where attendance_type='mass'),0),
            coalesce(a.last_choir,''),coalesce(a.last_mass,'')
        from people p left join attendance a on a.person_id=p.id
        where p.is_active=true and p.role='boy'
        order by (coalesce(a.choir_count,0)+coalesce(a.mass_count,0)),p.name
        """;
    await using var command = new NpgsqlCommand(sql, connection);
    await using var reader = await command.ExecuteReaderAsync();
    var result = new List<AssistantPerson>();
    while (await reader.ReadAsync())
    {
        var choirCount = reader.GetInt32(4);
        var massCount = reader.GetInt32(5);
        var choirSessions = reader.GetInt32(6);
        var massSessions = reader.GetInt32(7);
        var choirMissed = Math.Max(0, choirSessions - choirCount);
        var massMissed = Math.Max(0, massSessions - massCount);
        if (choirMissed + massMissed < 2) continue;
        result.Add(new AssistantPerson(reader.GetInt64(0), reader.GetInt32(1), reader.GetString(2), reader.GetString(3), choirMissed, massMissed, choirMissed + massMissed, reader.GetString(8), reader.GetString(9)));
    }
    return new AssistantInsights(result);
}

static async Task<object> BuildState(NpgsqlDataSource db, string mode, string? selectedDate, string? selectedWeek)
{
    await using var connection = await db.OpenConnectionAsync();
    var today = CairoToday();
    var date = ParseDate(selectedDate, today);
    var rotation = ParseDate(await GetSetting<string?>(connection, "rotationStart"), today);
    var distributionNotStarted = mode == "call" && today < rotation;
    var week = mode == "call" ? (distributionNotStarted ? rotation : WeekStart(today, rotation)) : WeekStart(ParseDate(selectedWeek, today), rotation);
    var servants = await GetSetting<string[]>(connection, "servants") ?? [];
    var verse = await GetSetting<string?>(connection, "verse") ?? "";
    var people = new List<Person>();
    await using (var command = new NpgsqlCommand("select id,record_key,name,note,phone1,phone2,group_number,address,role,qr_token from people where is_active=true order by record_key", connection))
    await using (var reader = await command.ExecuteReaderAsync())
        while (await reader.ReadAsync()) people.Add(new Person(reader.GetInt64(0), reader.GetInt32(1), reader.GetString(2), reader.GetString(3), reader.GetString(4), reader.GetString(5), reader.IsDBNull(6) ? "" : reader.GetString(6), reader.GetString(7), reader.GetString(8), reader.IsDBNull(9) ? "" : reader.GetString(9)));
    var visitedThisMonth = new HashSet<long>();
    var monthStart = new DateOnly(date.Year, date.Month, 1);
    await using (var command = new NpgsqlCommand("select person_id from visit_records where visit_date >= $1 and visit_date < $2", connection))
    {
        command.Parameters.AddWithValue(monthStart); command.Parameters.AddWithValue(monthStart.AddMonths(1));
        await using var reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync()) visitedThisMonth.Add(reader.GetInt64(0));
    }
    var groups = new List<Group>();
    await using (var command = new NpgsqlCommand("select g.number,g.display_order from groups g where exists (select 1 from people p where p.group_number=g.number and p.is_active=true and p.role='boy') order by g.display_order", connection))
    await using (var reader = await command.ExecuteReaderAsync())
        while (await reader.ReadAsync()) groups.Add(new Group(reader.GetString(0), people.Count(person => person.Group == reader.GetString(0)), people.Where(person => person.Group == reader.GetString(0)).Select(person => person.RecordKey).ToArray()));
    var visits = new HashSet<long>();
    await using (var command = new NpgsqlCommand("select person_id from visit_records where visit_date=$1", connection))
    {
        command.Parameters.AddWithValue(date);
        await using var reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync()) visits.Add(reader.GetInt64(0));
    }
    var calls = new Dictionary<long, string>();
    await using (var command = new NpgsqlCommand("select person_id,servant from call_records where week_start=$1", connection))
    {
        command.Parameters.AddWithValue(week);
        await using var reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync()) calls[reader.GetInt64(0)] = reader.GetString(1);
    }
    var savedAssignments = new Dictionary<string, string>();
    await using (var command = new NpgsqlCommand("select group_number,servant from call_assignments where week_start=$1", connection))
    {
        command.Parameters.AddWithValue(week);
        await using var reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync()) savedAssignments[reader.GetString(0)] = reader.GetString(1);
    }
    var autoAssignments = Assignments(groups.Select(group => group.Number), servants, week, rotation);
    var lastVisit = new Dictionary<long, string>();
    await using (var command = new NpgsqlCommand("select person_id,max(visit_date)::text from visit_records group by person_id", connection))
    await using (var reader = await command.ExecuteReaderAsync())
        while (await reader.ReadAsync()) lastVisit[reader.GetInt64(0)] = reader.GetString(1);
    var lastCall = new Dictionary<long, (string Week, string Servant)>();
    await using (var command = new NpgsqlCommand("select distinct on(person_id) person_id,week_start::text,servant from call_records order by person_id,week_start desc", connection))
    await using (var reader = await command.ExecuteReaderAsync())
        while (await reader.ReadAsync()) lastCall[reader.GetInt64(0)] = (reader.GetString(1), reader.GetString(2));
    var lastChoir = new Dictionary<long, string>();
    var lastMass = new Dictionary<long, string>();
    await using (var command = new NpgsqlCommand("select person_id,attendance_type,max(attendance_date)::text from attendance_records group by person_id,attendance_type", connection))
    await using (var reader = await command.ExecuteReaderAsync())
        while (await reader.ReadAsync()) { if (reader.GetString(1) == "choir") lastChoir[reader.GetInt64(0)] = reader.GetString(2); else lastMass[reader.GetInt64(0)] = reader.GetString(2); }
    var rows = people.Select(person =>
    {
        lastCall.TryGetValue(person.Id, out var call);
        return new { id = person.Id, recordKey = person.RecordKey, name = person.Name, note = person.Note, phone1 = person.Phone1, phone2 = person.Phone2, group = person.Group, address = person.Address, role = person.Role, qrToken = person.QrToken, visited = mode == "visit" && visits.Contains(person.Id), visitedThisMonth = visitedThisMonth.Contains(person.Id), called = calls.ContainsKey(person.Id), servant = calls.GetValueOrDefault(person.Id) ?? savedAssignments.GetValueOrDefault(person.Group) ?? autoAssignments.GetValueOrDefault(person.Group) ?? "", lastVisitedDate = lastVisit.GetValueOrDefault(person.Id) ?? "", lastCalledWeek = call.Week ?? "", lastCaller = call.Servant ?? "", lastChoirDate = lastChoir.GetValueOrDefault(person.Id) ?? "", lastMassDate = lastMass.GetValueOrDefault(person.Id) ?? "" };
    }).ToArray();
    var groupStates = groups.Select(group => new { number = group.Number, members = group.Members, recordKeys = group.RecordKeys, servant = savedAssignments.GetValueOrDefault(group.Number) ?? autoAssignments.GetValueOrDefault(group.Number) ?? "" }).ToArray();
    var weekEnd = week.AddDays(6);
    var monthTotal = people.Count(person => person.Role == "boy");
    return new { rows, groups = groupStates, servants, monthVisitedCount = visitedThisMonth.Count, monthTotal, rotationStart = rotation.ToString("yyyy-MM-dd"), distributionNotStarted, selectedDate = date.ToString("yyyy-MM-dd"), selectedWeek = week.ToString("yyyy-MM-dd"), weekEnd = weekEnd.ToString("yyyy-MM-dd"), verse, historySummary = rows.Select(row => new { row.recordKey, row.lastVisitedDate, row.lastCalledWeek, row.lastCaller }).ToArray() };
}

static async Task<T?> GetSetting<T>(NpgsqlConnection connection, string key)
{
    await using var command = new NpgsqlCommand("select value::text from settings where key=$1", connection);
    command.Parameters.AddWithValue(key);
    var json = await command.ExecuteScalarAsync() as string;
    return json is null ? default : JsonSerializer.Deserialize<T>(json);
}

static async Task SetSetting(NpgsqlConnection connection, NpgsqlTransaction transaction, string key, object value)
{
    await using var command = new NpgsqlCommand("insert into settings(key,value) values($1,$2::jsonb) on conflict(key) do update set value=excluded.value,updated_at=now()", connection, transaction);
    command.Parameters.AddWithValue(key); command.Parameters.AddWithValue(JsonSerializer.Serialize(value));
    await command.ExecuteNonQueryAsync();
}

static bool ValidPerson(PersonInput payload, out string error)
{
    if (string.IsNullOrWhiteSpace(payload.Name)) { error = "اكتب اسم الشخص"; return false; }
    error = "";
    return true;
}

static string CsvCell(string value) => $"\"{value.Replace("\"", "\"\"")}\"";
static string NormalizeArabic(string value) => value.Replace('إ', 'ا').Replace('أ', 'ا').Replace('آ', 'ا').Replace('ى', 'ي').Trim().ToLowerInvariant();
static string NormalizeRole(string? role) => role is "servant" ? "servant" : "boy";
static string NormalizeEgyptianPhone(string? value)
{
    var digits = new string((value ?? "").Where(char.IsDigit).ToArray());
    if (digits.Length == 0) return "";
    if (digits.StartsWith("20")) return $"+{digits}";
    if (digits.StartsWith("0")) return $"+20{digits[1..]}";
    return $"+20{digits}";
}

static Dictionary<string, string> Assignments(IEnumerable<string> groups, string[] servants, DateOnly week, DateOnly rotation)
{
    if (servants.Length == 0) return [];
    var offset = (int)(((week.DayNumber - rotation.DayNumber) / 7 % servants.Length + servants.Length) % servants.Length);
    return groups.Select((group, index) => (group, servant: servants[(index + offset) % servants.Length])).ToDictionary(item => item.group, item => item.servant);
}

static DateOnly ParseDate(string? value, DateOnly fallback) => DateOnly.TryParse(value, out var date) ? date : fallback;
static DateOnly WeekStart(DateOnly date, DateOnly firstWeekStart)
{
    var days = date.DayNumber - firstWeekStart.DayNumber;
    var weeks = Math.DivRem(days, 7, out var remainder);
    if (days < 0 && remainder != 0) weeks--;
    return firstWeekStart.AddDays(weeks * 7);
}

static DateOnly CairoToday()
{
    TimeZoneInfo cairo;
    try { cairo = TimeZoneInfo.FindSystemTimeZoneById("Africa/Cairo"); }
    catch (TimeZoneNotFoundException) { cairo = TimeZoneInfo.FindSystemTimeZoneById("Egypt Standard Time"); }
    return DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, cairo));
}
static string ConnectionString(string value)
{
    if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || (uri.Scheme != "postgres" && uri.Scheme != "postgresql")) return value;
    var builder = new NpgsqlConnectionStringBuilder { Host = uri.Host, Port = uri.IsDefaultPort ? 5432 : uri.Port, Username = Uri.UnescapeDataString(uri.UserInfo.Split(':')[0]), Password = Uri.UnescapeDataString(uri.UserInfo.Split(':').Skip(1).FirstOrDefault() ?? ""), Database = uri.AbsolutePath.TrimStart('/'), SslMode = SslMode.Require, Timeout = 15, CommandTimeout = 30 };
    return builder.ConnectionString;
}

static string? FindEnvironmentFile()
{
    var directory = new DirectoryInfo(Directory.GetCurrentDirectory());
    while (directory is not null)
    {
        var path = Path.Combine(directory.FullName, ".env");
        if (File.Exists(path)) return path;
        directory = directory.Parent;
    }
    return null;
}

static void LoadEnvironmentFile(string? path)
{
    if (path is null || !File.Exists(path)) return;
    foreach (var line in File.ReadLines(path))
    {
        var entry = line.Trim();
        if (entry.Length == 0 || entry.StartsWith('#')) continue;
        var separator = entry.IndexOf('=');
        if (separator < 1) continue;
        var key = entry[..separator].Trim();
        var value = entry[(separator + 1)..].Trim().Trim('"', '\'');
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(key))) Environment.SetEnvironmentVariable(key, value);
    }
}

record Person(long Id, int RecordKey, string Name, string Note, string Phone1, string Phone2, string Group, string Address, string Role, string QrToken);
record Group(string Number, int Members, int[] RecordKeys);
record VisitSave(string Date, Dictionary<string, bool>? Checks);
record CallSave(string? RotationStart, string[]? Servants, Dictionary<string, bool>? Checks);
record PersonInput(string Name, string? Group, string? Phone1, string? Phone2, string? Address, string? Note, string? Role);
record AttendanceSave(string Type, string Date, Dictionary<string, bool>? Checks);
record AttendanceCommentSave(string Type, string Date, int RecordKey, string Comment);
record FollowUpNoteSave(long PersonId, string? Servant, string Type, string Date, string Note);
record PublicAttendanceItem(string Type, string Date, string RecordedAt, string Comment);
record AssistantInsights(List<AssistantPerson> RepeatedAbsences);
record AssistantPerson(long Id, int RecordKey, string Name, string Group, int ChoirMissed, int MassMissed, int Missed, string LastChoir, string LastMass);
