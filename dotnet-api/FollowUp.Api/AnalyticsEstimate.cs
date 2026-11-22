internal sealed record WeeklyActivity(DateOnly Week, long Choir, long Mass, long Visits, long Calls);

internal static class AnalyticsEstimate
{
    internal static object? Build(IReadOnlyList<WeeklyActivity> weeks)
    {
        if (weeks.Count == 0) return null;
        var recent = weeks.TakeLast(4).ToArray();
        return new
        {
            basedOnWeeks = weeks.Count,
            lastWeek = weeks[^1].Week.ToString("yyyy-MM-dd"),
            choir = Average(recent.Select(week => week.Choir)),
            mass = Average(recent.Select(week => week.Mass)),
            visits = Average(recent.Select(week => week.Visits)),
            calls = Average(recent.Select(week => week.Calls)),
            trend = Trend(recent.Select(week => week.Choir).ToArray())
        };
    }

    internal static long Average(IEnumerable<long> values)
    {
        var items = values.ToArray();
        return items.Length == 0 ? 0 : (long)Math.Round(items.Average());
    }

    internal static string Trend(IReadOnlyList<long> values)
    {
        if (values.Count < 4) return "unknown";
        var recent = (values[^2] + values[^1]) / 2d;
        var previous = (values[^4] + values[^3]) / 2d;
        if (recent > previous * 1.1) return "up";
        if (recent < previous * 0.9) return "down";
        return "flat";
    }
}
