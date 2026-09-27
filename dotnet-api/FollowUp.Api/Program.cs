using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Npgsql;

LoadEnvironmentFile(FindEnvironmentFile());
var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls(Environment.GetEnvironmentVariable("ASPNETCORE_URLS") ?? "http://localhost:5080");
var connectionString = ConnectionString(Environment.GetEnvironmentVariable("DATABASE_URL") ?? builder.Configuration.GetConnectionString("Database") ?? "");
var appPassword = Environment.GetEnvironmentVariable("APP_PASSWORD") ?? "";
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

var api = app.MapGroup("/api");
api.AddEndpointFilter(async (context, next) =>
{
    var supplied = context.HttpContext.Request.Headers["X-App-Password"].ToString();
    var suppliedHash = SHA256.HashData(Encoding.UTF8.GetBytes(supplied));
    var expectedHash = SHA256.HashData(Encoding.UTF8.GetBytes(appPassword));
    if (!CryptographicOperations.FixedTimeEquals(suppliedHash, expectedHash)) return Results.Unauthorized();
    context.HttpContext.Items["role"] = "user";
    return await next(context);
});

api.MapGet("/session", () => Results.Ok(new { role = "user" }));
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
    await using var dailyCommand = new NpgsqlCommand("select count(*) filter(where p.is_active), count(*) filter(where p.is_active and a.attendance_type='choir'), count(*) filter(where p.is_active and a.attendance_type='mass') from people p left join attendance_records a on a.person_id=p.id and a.attendance_date=$1", connection);
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
    return Results.Ok(new { selectedDate = dashboardDate.ToString("yyyy-MM-dd"), trendMonth = trendMonth.ToString("yyyy-MM"), summary, dailySummary, people, dailyPeople, calendar, weeklyTrend });
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
    return Results.Ok(new { year = selectedYear, month = monthStart.ToString("yyyy-MM"), totalPeople, daily, monthly, yearly, callDaily, callMonthly, callYearly, servantStats, totals = new { daily = dailyTotal, monthly = monthlyTotal, yearly = yearlyTotal, monthlyCalls, yearlyCalls } });
});

api.MapGet("/history/{personId:long}", async (long personId, NpgsqlDataSource db) =>
{
    await using var connection = await db.OpenConnectionAsync();
    await using var personCommand = new NpgsqlCommand("select id, record_key, name, phone1, group_number, address from people where id=$1", connection);
    personCommand.Parameters.AddWithValue(personId);
    await using var reader = await personCommand.ExecuteReaderAsync();
    if (!await reader.ReadAsync()) return Results.NotFound(new { error = "الاسم غير موجود" });
    var person = new { id = reader.GetInt64(0), recordKey = reader.GetInt32(1), name = reader.GetString(2), phone1 = reader.GetString(3), group = reader.IsDBNull(4) ? "" : reader.GetString(4), address = reader.GetString(5) };
    await reader.CloseAsync();
    await using var eventsCommand = new NpgsqlCommand("select event_date::text, bool_or(kind='visit'), bool_or(kind='call'), bool_or(kind='choir'), bool_or(kind='mass'), max(servant) filter(where kind='call') from (select visit_date event_date, 'visit' kind, '' servant from visit_records where person_id=$1 union all select week_start, 'call', servant from call_records where person_id=$1 union all select attendance_date, attendance_type, '' from attendance_records where person_id=$1) events group by event_date order by event_date", connection);
    eventsCommand.Parameters.AddWithValue(personId);
    await using var eventsReader = await eventsCommand.ExecuteReaderAsync();
    var events = new List<object>();
    while (await eventsReader.ReadAsync()) events.Add(new { date = eventsReader.GetString(0), visited = eventsReader.GetBoolean(1), called = eventsReader.GetBoolean(2), choir = eventsReader.GetBoolean(3), mass = eventsReader.GetBoolean(4), caller = eventsReader.IsDBNull(5) ? "" : eventsReader.GetString(5) });
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

api.MapPost("/people", async (PersonInput payload, NpgsqlDataSource db) =>
{
    if (!ValidPerson(payload, out var error)) return Results.BadRequest(new { error });
    await using var connection = await db.OpenConnectionAsync();
    await using var command = new NpgsqlCommand("insert into people(record_key,name,note,phone1,phone2,group_number,address,role) values((select coalesce(max(record_key),0)+1 from people),$1,$2,$3,$4,$5,$6,$7) returning id", connection);
    command.Parameters.AddWithValue(payload.Name.Trim()); command.Parameters.AddWithValue(payload.Note?.Trim() ?? ""); command.Parameters.AddWithValue(payload.Phone1?.Trim() ?? ""); command.Parameters.AddWithValue(payload.Phone2?.Trim() ?? ""); command.Parameters.AddWithValue(string.IsNullOrWhiteSpace(payload.Group) ? (object)DBNull.Value : payload.Group.Trim()); command.Parameters.AddWithValue(payload.Address?.Trim() ?? ""); command.Parameters.AddWithValue(NormalizeRole(payload.Role));
    var id = (long)(await command.ExecuteScalarAsync())!;
    return Results.Created($"/api/people/{id}", new { id });
});

api.MapPut("/people/{personId:long}", async (long personId, PersonInput payload, NpgsqlDataSource db) =>
{
    if (!ValidPerson(payload, out var error)) return Results.BadRequest(new { error });
    await using var connection = await db.OpenConnectionAsync();
    await using var command = new NpgsqlCommand("update people set name=$1,note=$2,phone1=$3,phone2=$4,group_number=$5,address=$6,role=$7,updated_at=now() where id=$8 and is_active=true", connection);
    command.Parameters.AddWithValue(payload.Name.Trim()); command.Parameters.AddWithValue(payload.Note?.Trim() ?? ""); command.Parameters.AddWithValue(payload.Phone1?.Trim() ?? ""); command.Parameters.AddWithValue(payload.Phone2?.Trim() ?? ""); command.Parameters.AddWithValue(string.IsNullOrWhiteSpace(payload.Group) ? (object)DBNull.Value : payload.Group.Trim()); command.Parameters.AddWithValue(payload.Address?.Trim() ?? ""); command.Parameters.AddWithValue(NormalizeRole(payload.Role)); command.Parameters.AddWithValue(personId);
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
    await using (var command = new NpgsqlCommand("select id,record_key,name,note,phone1,phone2,group_number,address,role from people where is_active=true order by record_key", connection))
    await using (var reader = await command.ExecuteReaderAsync())
        while (await reader.ReadAsync()) people.Add(new Person(reader.GetInt64(0), reader.GetInt32(1), reader.GetString(2), reader.GetString(3), reader.GetString(4), reader.GetString(5), reader.IsDBNull(6) ? "" : reader.GetString(6), reader.GetString(7), reader.GetString(8)));
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
        return new { id = person.Id, recordKey = person.RecordKey, name = person.Name, note = person.Note, phone1 = person.Phone1, phone2 = person.Phone2, group = person.Group, address = person.Address, role = person.Role, visited = mode == "visit" && visits.Contains(person.Id), visitedThisMonth = visitedThisMonth.Contains(person.Id), called = calls.ContainsKey(person.Id), servant = calls.GetValueOrDefault(person.Id) ?? savedAssignments.GetValueOrDefault(person.Group) ?? autoAssignments.GetValueOrDefault(person.Group) ?? "", lastVisitedDate = lastVisit.GetValueOrDefault(person.Id) ?? "", lastCalledWeek = call.Week ?? "", lastCaller = call.Servant ?? "", lastChoirDate = lastChoir.GetValueOrDefault(person.Id) ?? "", lastMassDate = lastMass.GetValueOrDefault(person.Id) ?? "" };
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
static string NormalizeRole(string? role) => role is "servant" ? "servant" : "boy";

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

record Person(long Id, int RecordKey, string Name, string Note, string Phone1, string Phone2, string Group, string Address, string Role);
record Group(string Number, int Members, int[] RecordKeys);
record VisitSave(string Date, Dictionary<string, bool>? Checks);
record CallSave(string? RotationStart, string[]? Servants, Dictionary<string, bool>? Checks);
record PersonInput(string Name, string? Group, string? Phone1, string? Phone2, string? Address, string? Note, string? Role);
record AttendanceSave(string Type, string Date, Dictionary<string, bool>? Checks);
