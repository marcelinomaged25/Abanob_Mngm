using System.Text.Json;
using Npgsql;

internal static class ApiHelpers
{
    internal static async Task<object> BuildState(NpgsqlDataSource db, string mode, string? selectedDate, string? selectedWeek)
    {
        await using var connection = await db.OpenConnectionAsync();
        var today = CairoToday();
        var date = ParseDate(selectedDate, today);
        var rotation = ParseDate(await GetSetting<string?>(connection, "rotationStart"), today);
        var distributionNotStarted = mode == "call" && today < rotation;
        var week = mode == "call" ? (distributionNotStarted ? rotation : WeekStart(today, rotation)) : WeekStart(ParseDate(selectedWeek, today), rotation);
        var availableServants = await GetServantNamesAsync(connection);
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
            while (await reader.ReadAsync()) groups.Add(new Group(reader.GetString(0), people.Count(person => person.Role == "boy" && person.Group == reader.GetString(0)), people.Where(person => person.Role == "boy" && person.Group == reader.GetString(0)).Select(person => person.RecordKey).ToArray()));
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
            while (await reader.ReadAsync()) savedAssignments[reader.GetString(0)] = CanonicalServantName(reader.GetString(1));
        }
        var assignmentGroups = new List<string>();
        await using (var command = new NpgsqlCommand("select number from groups order by display_order", connection))
        await using (var reader = await command.ExecuteReaderAsync())
            while (await reader.ReadAsync()) assignmentGroups.Add(reader.GetString(0));
        var configuredServants = await GetSetting<string[]>(connection, "callSelectedServants") ?? Array.Empty<string>();
        var selectedServants = configuredServants.Select(CanonicalServantName).Where(name => availableServants.Contains(name, StringComparer.Ordinal)).Distinct(StringComparer.Ordinal).ToArray();
        var autoAssignments = Assignments(assignmentGroups, selectedServants, week, rotation);
        var lastVisit = new Dictionary<long, string>();
        await using (var command = new NpgsqlCommand("select person_id,max(visit_date)::text from visit_records group by person_id", connection))
        await using (var reader = await command.ExecuteReaderAsync())
            while (await reader.ReadAsync()) lastVisit[reader.GetInt64(0)] = reader.GetString(1);
        var visitCounts = new Dictionary<long, long>();
        await using (var command = new NpgsqlCommand("select person_id,count(*) from visit_records group by person_id", connection))
        await using (var reader = await command.ExecuteReaderAsync())
            while (await reader.ReadAsync()) visitCounts[reader.GetInt64(0)] = reader.GetInt64(1);
        var lastCall = new Dictionary<long, (string Week, string Servant)>();
        await using (var command = new NpgsqlCommand("select distinct on(person_id) person_id,week_start::text,servant from call_records order by person_id,week_start desc", connection))
        await using (var reader = await command.ExecuteReaderAsync())
            while (await reader.ReadAsync()) lastCall[reader.GetInt64(0)] = (reader.GetString(1), reader.GetString(2));
        var lastChoir = new Dictionary<long, string>();
        var lastMass = new Dictionary<long, string>();
        await using (var command = new NpgsqlCommand("select person_id,attendance_type,max(attendance_date)::text from attendance_records group by person_id,attendance_type", connection))
        await using (var reader = await command.ExecuteReaderAsync())
            while (await reader.ReadAsync()) { if (reader.GetString(1) == "choir") lastChoir[reader.GetInt64(0)] = reader.GetString(2); else lastMass[reader.GetInt64(0)] = reader.GetString(2); }
        var choirCounts = new Dictionary<long, long>();
        var massCounts = new Dictionary<long, long>();
        await using (var command = new NpgsqlCommand("select person_id,count(distinct attendance_date) filter(where attendance_type='choir'),count(distinct attendance_date) filter(where attendance_type='mass') from attendance_records group by person_id", connection))
        await using (var reader = await command.ExecuteReaderAsync())
            while (await reader.ReadAsync()) { choirCounts[reader.GetInt64(0)] = reader.GetInt64(1); massCounts[reader.GetInt64(0)] = reader.GetInt64(2); }
        var boyCallCounts = new Dictionary<long, long>();
        await using (var command = new NpgsqlCommand("select person_id,count(*) from call_records group by person_id", connection))
        await using (var reader = await command.ExecuteReaderAsync())
            while (await reader.ReadAsync()) boyCallCounts[reader.GetInt64(0)] = reader.GetInt64(1);
        var servantCallCounts = new Dictionary<string, long>(StringComparer.Ordinal);
        await using (var command = new NpgsqlCommand(@"select effective_servant,count(*) from (select coalesce(nullif(c.servant,''),ca.servant) effective_servant from call_records c join people cp on cp.id=c.person_id left join call_assignments ca on ca.week_start=c.week_start and ca.group_number=cp.group_number) sub where effective_servant is not null and effective_servant<>'' group by effective_servant", connection))
        await using (var reader = await command.ExecuteReaderAsync())
            while (await reader.ReadAsync()) { var name = CanonicalServantName(reader.GetString(0)); servantCallCounts[name] = servantCallCounts.GetValueOrDefault(name) + reader.GetInt64(1); }
        var rows = people.Select(person =>
        {
            lastCall.TryGetValue(person.Id, out var call);
            var group = person.Role == "servant" ? "" : person.Group;
            return new { id = person.Id, recordKey = person.RecordKey, name = person.Name, note = person.Note, phone1 = person.Phone1, phone2 = person.Phone2, group, address = person.Address, role = person.Role, qrToken = person.QrToken, visited = mode == "visit" && visits.Contains(person.Id), visitedThisMonth = visitedThisMonth.Contains(person.Id), called = calls.ContainsKey(person.Id), servant = calls.GetValueOrDefault(person.Id) ?? savedAssignments.GetValueOrDefault(person.Group) ?? autoAssignments.GetValueOrDefault(person.Group) ?? "", lastVisitedDate = lastVisit.GetValueOrDefault(person.Id) ?? "", visitCount = visitCounts.GetValueOrDefault(person.Id), lastCalledWeek = call.Week ?? "", lastCaller = call.Servant ?? "", lastChoirDate = lastChoir.GetValueOrDefault(person.Id) ?? "", lastMassDate = lastMass.GetValueOrDefault(person.Id) ?? "", callCount = person.Role == "servant" ? servantCallCounts.GetValueOrDefault(CanonicalServantName(person.Name)) : boyCallCounts.GetValueOrDefault(person.Id), choirCount = choirCounts.GetValueOrDefault(person.Id), massCount = massCounts.GetValueOrDefault(person.Id) };
        }).ToArray();
        var groupStates = groups.Select(group => new { number = group.Number, members = group.Members, recordKeys = group.RecordKeys, servant = savedAssignments.GetValueOrDefault(group.Number) ?? autoAssignments.GetValueOrDefault(group.Number) ?? "" }).ToArray();
        var weekEnd = week.AddDays(6);
        var monthTotal = people.Count(person => person.Role == "boy");
        return new { rows, groups = groupStates, servants = mode == "call" ? selectedServants : Array.Empty<string>(), monthVisitedCount = visitedThisMonth.Count, monthTotal, rotationStart = rotation.ToString("yyyy-MM-dd"), distributionNotStarted, selectedDate = date.ToString("yyyy-MM-dd"), selectedWeek = week.ToString("yyyy-MM-dd"), weekEnd = weekEnd.ToString("yyyy-MM-dd"), verse, historySummary = rows.Select(row => new { row.recordKey, row.lastVisitedDate, row.lastCalledWeek, row.lastCaller }).ToArray() };
    }

    internal static bool ValidLearningItem(LearningItemSave payload, out DateOnly date, out string error)
    {
        error = "";
        if (!DateOnly.TryParse(payload.Date, out date)) error = "اختر تاريخ اللقاء";
        else if (string.IsNullOrWhiteSpace(payload.Category) || payload.Category.Trim().Length > 100) error = "اكتب تصنيفًا من 1 إلى 100 حرف";
        else if (string.IsNullOrWhiteSpace(payload.Title) || payload.Title.Trim().Length > 180) error = "اكتب اسم المادة من 1 إلى 180 حرفًا";
        else if (payload.Description?.Length > 1200) error = "الوصف طويل جدًا (الحد 1200 حرف)";
        else if (payload.Links is { Count: > 10 }) error = "يمكن إضافة 10 روابط كحد أقصى لكل مادة";
        else if (payload.Links is { Count: > 0 } links && links.Any(link => !ValidLearningLink(link))) error = "راجع أسماء الروابط وتأكد أن كل رابط يبدأ بـ https://";
        else if ((payload.Links is null || payload.Links.Count == 0) && !ValidLearningLink(new LearningResourceLink("فتح المادة", payload.Url ?? ""))) error = "أضف رابطًا صحيحًا يبدأ بـ https://";
        else if ((payload.Links?.Any(link => string.Equals(link.Url.Trim(), payload.Url?.Trim(), StringComparison.OrdinalIgnoreCase)) ?? false) == false && payload.Url?.Length > 2000) error = "رابط المادة الرئيسي طويل جدًا";
        else if (!string.IsNullOrWhiteSpace(payload.BackgroundUrl) && (payload.BackgroundUrl.Length > 2000 || !Uri.TryCreate(payload.BackgroundUrl.Trim(), UriKind.Absolute, out var backgroundUri) || backgroundUri.Scheme != Uri.UriSchemeHttps)) error = "رابط الخلفية يجب أن يبدأ بـ https://";
        return error.Length == 0;
    }

    internal static bool ValidMassSchedule(MassScheduleSave payload, out DateOnly date, out TimeOnly time, out string error)
    {
        date = default;
        time = default;
        error = "";
        if (!DateOnly.TryParseExact(payload.Date, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out date)) error = "اختر تاريخ القداس";
        else if (!TimeOnly.TryParseExact(payload.Time, "HH:mm", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out time)) error = "أدخل موعدًا صحيحًا للقداس";
        else if (string.IsNullOrWhiteSpace(payload.Location) || payload.Location.Trim().Length > 250) error = "اكتب مكان القداس (حتى 250 حرفًا)";
        return error.Length == 0;
    }

    internal static bool ValidLearningLink(LearningResourceLink link) =>
        !string.IsNullOrWhiteSpace(link.Label) && link.Label.Trim().Length <= 80 && link.Url?.Length <= 2000 &&
        Uri.TryCreate(link.Url?.Trim(), UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps;

    internal static List<LearningResourceLink> NormalizeLearningLinks(List<LearningResourceLink>? links, string legacyUrl)
    {
        var source = links is { Count: > 0 } ? links : [new LearningResourceLink("فتح المادة", legacyUrl)];
        return source.Select(link => new LearningResourceLink(link.Label.Trim(), link.Url.Trim())).ToList();
    }

    internal static List<LearningResourceLink> LearningLinks(string json, string legacyUrl)
    {
        try
        {
            var links = JsonSerializer.Deserialize<List<LearningResourceLink>>(json);
            return links is { Count: > 0 } ? links : [new LearningResourceLink("فتح المادة", legacyUrl)];
        }
        catch (JsonException) { return [new LearningResourceLink("فتح المادة", legacyUrl)]; }
    }

    internal static async Task<T?> GetSetting<T>(NpgsqlConnection connection, string key)
    {
        await using var command = new NpgsqlCommand("select value::text from settings where key=$1", connection);
        command.Parameters.AddWithValue(key);
        var json = await command.ExecuteScalarAsync() as string;
        return json is null ? default : JsonSerializer.Deserialize<T>(json);
    }

    internal static async Task SetSetting(NpgsqlConnection connection, NpgsqlTransaction transaction, string key, object value)
    {
        await using var command = new NpgsqlCommand("insert into settings(key,value) values($1,$2::jsonb) on conflict(key) do update set value=excluded.value,updated_at=now()", connection, transaction);
        command.Parameters.AddWithValue(key); command.Parameters.AddWithValue(JsonSerializer.Serialize(value));
        await command.ExecuteNonQueryAsync();
    }

    internal static async Task<string[]> GetServantNamesAsync(NpgsqlConnection connection)
    {
        var names = new List<string>();
        await using var command = new NpgsqlCommand("select distinct name from people where is_active=true and role='servant' order by name", connection);
        await using var reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            var name = CanonicalServantName(reader.GetString(0));
            if (!string.IsNullOrWhiteSpace(name)) names.Add(name);
        }
        return names.Distinct(StringComparer.Ordinal).ToArray();
    }

    internal static async Task EnsureGroupSeriesAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, int requiredCount)
    {
        if (requiredCount <= 0) return;
        await using var countCommand = new NpgsqlCommand("select count(*) from groups", connection, transaction);
        var existingCount = (long)(await countCommand.ExecuteScalarAsync() ?? 0L);
        if (existingCount >= requiredCount) return;
        await using var insert = new NpgsqlCommand(@"insert into groups(number, display_order)
            select x::text, x from generate_series($1, $2) x
            on conflict (number) do nothing", connection, transaction);
        insert.Parameters.AddWithValue(existingCount + 1);
        insert.Parameters.AddWithValue(requiredCount);
        await insert.ExecuteNonQueryAsync();
    }

    internal static async Task<List<string>> LoadGroupNumbersAsync(NpgsqlConnection connection, NpgsqlTransaction? transaction = null)
    {
        var groups = new List<string>();
        var commandText = "select number from groups order by display_order";
        await using var command = transaction is null
            ? new NpgsqlCommand(commandText, connection)
            : new NpgsqlCommand(commandText, connection, transaction);
        await using var reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync()) groups.Add(reader.GetString(0));
        return groups;
    }

    internal static async Task<Dictionary<string, string>> LoadWeekAssignmentsAsync(NpgsqlConnection connection, NpgsqlTransaction? transaction, DateOnly week)
    {
        var assignments = new Dictionary<string, string>(StringComparer.Ordinal);
        var commandText = "select group_number, servant from call_assignments where week_start=$1";
        await using var command = transaction is null
            ? new NpgsqlCommand(commandText, connection)
            : new NpgsqlCommand(commandText, connection, transaction);
        command.Parameters.AddWithValue(week);
        await using var reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            var group = reader.GetString(0);
            var servant = reader.IsDBNull(1) ? "" : reader.GetString(1).Trim();
            if (!string.IsNullOrWhiteSpace(servant)) assignments[group] = servant;
        }
        return assignments;
    }

    internal static async Task RedistributeGroupMembersAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, string sourceGroup, IReadOnlyList<string> destinationGroups, DateOnly week)
    {
        if (destinationGroups.Count == 0) return;

        var destinationCounts = new Dictionary<string, int>(StringComparer.Ordinal);
        await using (var countCommand = new NpgsqlCommand(@"select g.number, count(p.id)::int
            from groups g
            left join people p on p.group_number=g.number and p.is_active=true and p.role='boy'
            where g.number=any($1)
            group by g.number, g.display_order
            order by g.display_order", connection, transaction))
        {
            countCommand.Parameters.AddWithValue(destinationGroups.ToArray());
            await using var reader = await countCommand.ExecuteReaderAsync();
            while (await reader.ReadAsync()) destinationCounts[reader.GetString(0)] = reader.GetInt32(1);
        }

        var personIds = new List<long>();
        await using (var peopleCommand = new NpgsqlCommand("select p.id from people p where p.group_number=$1 and p.is_active=true and p.role='boy' and not exists (select 1 from call_records c where c.person_id=p.id and c.week_start=$2) order by p.record_key", connection, transaction))
        {
            peopleCommand.Parameters.AddWithValue(sourceGroup);
            peopleCommand.Parameters.AddWithValue(week);
            await using var reader = await peopleCommand.ExecuteReaderAsync();
            while (await reader.ReadAsync()) personIds.Add(reader.GetInt64(0));
        }

        foreach (var personId in personIds)
        {
            var destination = destinationGroups.OrderBy(group => destinationCounts.GetValueOrDefault(group)).First();
            await using var update = new NpgsqlCommand("update people set group_number=$1, updated_at=now() where id=$2", connection, transaction);
            update.Parameters.AddWithValue(destination);
            update.Parameters.AddWithValue(personId);
            await update.ExecuteNonQueryAsync();
            destinationCounts[destination]++;
        }
    }

    internal static async Task RedistributeAllGroupMembersAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, string sourceGroup, IReadOnlyList<string> destinationGroups)
    {
        if (destinationGroups.Count == 0) return;
        var destinationCounts = destinationGroups.ToDictionary(group => group, _ => 0, StringComparer.Ordinal);
        await using (var countCommand = new NpgsqlCommand("select group_number,count(*)::int from people where is_active=true and role='boy' and group_number=any($1) group by group_number", connection, transaction))
        {
            countCommand.Parameters.AddWithValue(destinationGroups.ToArray());
            await using var reader = await countCommand.ExecuteReaderAsync();
            while (await reader.ReadAsync()) destinationCounts[reader.GetString(0)] = reader.GetInt32(1);
        }
        var personIds = new List<long>();
        await using (var peopleCommand = new NpgsqlCommand("select id from people where group_number=$1 and is_active=true and role='boy' order by record_key", connection, transaction))
        {
            peopleCommand.Parameters.AddWithValue(sourceGroup);
            await using var reader = await peopleCommand.ExecuteReaderAsync();
            while (await reader.ReadAsync()) personIds.Add(reader.GetInt64(0));
        }
        foreach (var personId in personIds)
        {
            var destination = destinationGroups.OrderBy(group => destinationCounts[group]).ThenBy(group => group).First();
            await using var update = new NpgsqlCommand("update people set group_number=$1, updated_at=now() where id=$2", connection, transaction);
            update.Parameters.AddWithValue(destination); update.Parameters.AddWithValue(personId);
            await update.ExecuteNonQueryAsync();
            destinationCounts[destination]++;
        }
    }

    internal static async Task BalanceUncalledMembersAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, DateOnly week, IReadOnlyList<string> groups)
    {
        if (groups.Count == 0) return;
        var totals = groups.ToDictionary(group => group, _ => 0, StringComparer.Ordinal);
        var uncalled = groups.ToDictionary(group => group, _ => new Queue<long>(), StringComparer.Ordinal);
        await using (var command = new NpgsqlCommand(@"select p.id,p.group_number
            from people p where p.is_active=true and p.role='boy'
            and not exists (select 1 from call_records c where c.person_id=p.id and c.week_start=$1)
            order by p.record_key", connection, transaction))
        {
            command.Parameters.AddWithValue(week);
            await using var reader = await command.ExecuteReaderAsync();
            while (await reader.ReadAsync())
            {
                var group = reader.IsDBNull(1) ? "" : reader.GetString(1);
                if (totals.ContainsKey(group))
                {
                    totals[group]++;
                    uncalled[group].Enqueue(reader.GetInt64(0));
                }
            }
        }
        await using (var countCommand = new NpgsqlCommand("select group_number,count(*)::int from people where is_active=true and role='boy' and group_number=any($1) group by group_number", connection, transaction))
        {
            countCommand.Parameters.AddWithValue(groups.ToArray());
            await using var reader = await countCommand.ExecuteReaderAsync();
            while (await reader.ReadAsync()) totals[reader.GetString(0)] = reader.GetInt32(1);
        }
        while (true)
        {
            var source = uncalled.Where(item => item.Value.Count > 0).OrderByDescending(item => totals[item.Key]).ThenBy(item => item.Key).FirstOrDefault();
            var target = totals.OrderBy(item => item.Value).ThenBy(item => item.Key).First();
            if (source.Key is null || source.Key == target.Key || totals[source.Key] <= totals[target.Key] + 1) break;
            var personId = source.Value.Dequeue();
            await using var update = new NpgsqlCommand("update people set group_number=$1,updated_at=now() where id=$2", connection, transaction);
            update.Parameters.AddWithValue(target.Key); update.Parameters.AddWithValue(personId);
            await update.ExecuteNonQueryAsync();
            totals[source.Key]--; totals[target.Key]++;
            uncalled[target.Key].Enqueue(personId);
        }
    }

    internal static async Task UpsertAssignmentAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, DateOnly week, string groupNumber, string servant)
    {
        await using var assign = new NpgsqlCommand("insert into call_assignments(week_start,group_number,servant) values($1,$2,$3) on conflict (week_start,group_number) do update set servant=excluded.servant, assigned_at=now()", connection, transaction);
        assign.Parameters.AddWithValue(week);
        assign.Parameters.AddWithValue(groupNumber);
        assign.Parameters.AddWithValue(CanonicalServantName(servant));
        await assign.ExecuteNonQueryAsync();
    }

    internal static async Task DeleteWeekAssignmentAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, DateOnly week, string groupNumber)
    {
        await using var command = new NpgsqlCommand("delete from call_assignments where week_start=$1 and group_number=$2", connection, transaction);
        command.Parameters.AddWithValue(week);
        command.Parameters.AddWithValue(groupNumber);
        await command.ExecuteNonQueryAsync();
    }

    internal static string CanonicalServantName(string? value)
    {
        var name = (value ?? "").Trim();
        if (name.Length == 0) return "";
        name = System.Text.RegularExpressions.Regex.Replace(name, @"^[أإآا]\s*[/.]\s*", "");
        var normalized = name.Replace("إ", "ا").Replace("أ", "ا").Replace("آ", "ا");
        var compact = string.Concat(normalized.Where(character => !char.IsWhiteSpace(character)));
        return compact is "ميلاد" or "ميلد" or "ميلادعدلي" ? "ميلاد عدلي" : name;
    }

    internal static async Task<Person?> GetPersonAsync(NpgsqlConnection connection, long personId)
    {
        await using var command = new NpgsqlCommand("select id,record_key,name,note,phone1,phone2,group_number,address,role,qr_token from people where id=$1 and is_active=true", connection);
        command.Parameters.AddWithValue(personId);
        await using var reader = await command.ExecuteReaderAsync();
        if (!await reader.ReadAsync()) return null;
        return new Person(reader.GetInt64(0), reader.GetInt32(1), reader.GetString(2), reader.GetString(3), reader.GetString(4), reader.GetString(5), reader.IsDBNull(6) ? "" : reader.GetString(6), reader.GetString(7), reader.GetString(8), reader.IsDBNull(9) ? "" : reader.GetString(9));
    }

    internal static async Task<string> SelectLeastFilledGroupAsync(NpgsqlConnection connection, long? excludedPersonId = null)
    {
        await using var ensureGroup = new NpgsqlCommand("insert into groups(number, display_order) values('1', 1) on conflict (number) do nothing", connection);
        await ensureGroup.ExecuteNonQueryAsync();

        var selectionSql = excludedPersonId.HasValue
            ? "select g.number from groups g left join people p on p.group_number = g.number and p.is_active = true and p.role = 'boy' and p.id <> $1 group by g.number, g.display_order order by count(p.id), g.display_order limit 1"
            : "select g.number from groups g left join people p on p.group_number = g.number and p.is_active = true and p.role = 'boy' group by g.number, g.display_order order by count(p.id), g.display_order limit 1";
        await using var command = new NpgsqlCommand(selectionSql, connection);
        if (excludedPersonId.HasValue) command.Parameters.AddWithValue(excludedPersonId.Value);
        var result = await command.ExecuteScalarAsync();
        return result is null || result is DBNull ? "1" : result.ToString()!;
    }

    internal static bool ValidPerson(PersonInput payload, out string error)
    {
        if (string.IsNullOrWhiteSpace(payload.Name)) { error = "اكتب اسم الشخص"; return false; }
        error = "";
        return true;
    }

    internal static string CsvCell(string value) => $"\"{value.Replace("\"", "\"\"")}\"";
    internal static string NormalizeRole(string? role) => role is "servant" ? "servant" : "boy";
    internal static string NormalizeEgyptianPhone(string? value)
    {
        var digits = new string((value ?? "").Where(char.IsDigit).ToArray());
        if (digits.Length == 0) return "";
        if (digits.StartsWith("20")) return $"+{digits}";
        if (digits.StartsWith("0")) return $"+20{digits[1..]}";
        return $"+20{digits}";
    }

    internal static Dictionary<string, string> Assignments(IEnumerable<string> groups, string[] servants, DateOnly week, DateOnly rotation)
    {
        if (servants.Length == 0) return [];
        var offset = (int)(((week.DayNumber - rotation.DayNumber) / 7 % servants.Length + servants.Length) % servants.Length);
        return groups.Select((group, index) => (group, servant: servants[(index + offset) % servants.Length])).ToDictionary(item => item.group, item => item.servant);
    }

    internal static DateOnly ParseDate(string? value, DateOnly fallback) => DateOnly.TryParse(value, out var date) ? date : fallback;
    internal static DateOnly WeekStart(DateOnly date, DateOnly firstWeekStart)
    {
        var days = date.DayNumber - firstWeekStart.DayNumber;
        var weeks = Math.DivRem(days, 7, out var remainder);
        if (days < 0 && remainder != 0) weeks--;
        return firstWeekStart.AddDays(weeks * 7);
    }

    internal static DateOnly CairoToday()
    {
        TimeZoneInfo cairo;
        try { cairo = TimeZoneInfo.FindSystemTimeZoneById("Africa/Cairo"); }
        catch (TimeZoneNotFoundException) { cairo = TimeZoneInfo.FindSystemTimeZoneById("Egypt Standard Time"); }
        return DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, cairo));
    }
    internal static DateOnly LastFridayOfMonth(DateOnly month)
    {
        var lastDay = month.AddMonths(1).AddDays(-1);
        var daysAfterFriday = ((int)lastDay.DayOfWeek - (int)DayOfWeek.Friday + 7) % 7;
        return lastDay.AddDays(-daysAfterFriday);
    }
    internal static string ConnectionString(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || (uri.Scheme != "postgres" && uri.Scheme != "postgresql")) return value;
        var builder = new NpgsqlConnectionStringBuilder { Host = uri.Host, Port = uri.IsDefaultPort ? 5432 : uri.Port, Username = Uri.UnescapeDataString(uri.UserInfo.Split(':')[0]), Password = Uri.UnescapeDataString(uri.UserInfo.Split(':').Skip(1).FirstOrDefault() ?? ""), Database = uri.AbsolutePath.TrimStart('/'), SslMode = SslMode.Require, Timeout = 15, CommandTimeout = 30 };
        return builder.ConnectionString;
    }

    internal static string? FindEnvironmentFile()
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

    internal static void LoadEnvironmentFile(string? path)
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

}
