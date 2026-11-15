import os
from datetime import date, timedelta

import psycopg
from fastapi import FastAPI, HTTPException
app = FastAPI(title="Abanob Attendance Forecast")


def connection():
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is required")
    return psycopg.connect(url)


def weekly_counts():
    with connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            with events as (
                select a.attendance_date as week_date,
                       count(distinct a.person_id) filter (where a.attendance_type = 'choir') as choir,
                       count(distinct a.person_id) filter (where a.attendance_type = 'mass') as mass,
                       0::bigint as visits, 0::bigint as calls
                from attendance_records a join people p on p.id = a.person_id
                where p.is_active = true and p.role = 'boy'
                group by a.attendance_date
                union all
                select v.visit_date, 0, 0, count(distinct v.person_id), 0
                from visit_records v join people p on p.id = v.person_id
                where p.is_active = true and p.role = 'boy'
                group by v.visit_date
                union all
                select c.week_start, 0, 0, 0, count(distinct c.person_id)
                from call_records c join people p on p.id = c.person_id
                where p.is_active = true and p.role = 'boy'
                group by c.week_start
            )
            select date_trunc('week', week_date)::date,
                   sum(choir), sum(mass), sum(visits), sum(calls)
            from events
            group by 1
            order by 1
            """
        )
        return cur.fetchall()


def active_boys():
    with connection() as conn, conn.cursor() as cur:
        cur.execute("select count(*) from people where is_active = true and role = 'boy'")
        return int(cur.fetchone()[0])


def forecast(values):
    if not values:
        return 0
    if len(values) < 3:
        return round(sum(values) / len(values))
    # Transparent least-squares trend without a heavyweight ML dependency.
    x_mean = (len(values) - 1) / 2
    y_mean = sum(values) / len(values)
    denominator = sum((index - x_mean) ** 2 for index in range(len(values))) or 1
    slope = sum((index - x_mean) * (value - y_mean) for index, value in enumerate(values)) / denominator
    return max(0, round(y_mean + slope * (len(values) - x_mean)))


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/predict")
def predict():
    try:
        rows = weekly_counts()
    except Exception as exc:
        raise HTTPException(status_code=500, detail="تعذر قراءة بيانات الحضور") from exc
    choir = [int(row[1]) for row in rows]
    mass = [int(row[2]) for row in rows]
    visits = [int(row[3]) for row in rows]
    calls = [int(row[4]) for row in rows]
    boys = active_boys()
    expected = max(1, boys)
    return {
        "basedOnSessions": len(rows),
        "nextChoirAttendance": forecast(choir),
        "nextMassAttendance": forecast(mass),
        "nextVisits": forecast(visits),
        "nextCalls": forecast(calls),
        "nextChoirRate": round(forecast(choir) * 100 / expected),
        "nextMassRate": round(forecast(mass) * 100 / expected),
        "lastWeeks": [
            {"week": row[0].isoformat(), "choir": int(row[1]), "mass": int(row[2]), "visits": int(row[3]), "calls": int(row[4])}
            for row in rows[-8:]
        ],
        "nextFriday": (date.today() + timedelta(days=(4 - date.today().weekday()) % 7)).isoformat(),
        "method": "weekly_multi_signal_trend_with_average_fallback",
    }
