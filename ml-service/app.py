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
            select a.attendance_date,
                   count(distinct a.person_id) filter (where a.attendance_type = 'choir'),
                   count(distinct a.person_id) filter (where a.attendance_type = 'mass')
            from attendance_records a
            join people p on p.id = a.person_id
            where p.is_active = true and p.role = 'boy'
            group by a.attendance_date
            order by a.attendance_date
            """
        )
        return cur.fetchall()


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
    return {
        "basedOnSessions": len(rows),
        "nextChoirAttendance": forecast(choir),
        "nextMassAttendance": forecast(mass),
        "nextFriday": (date.today() + timedelta(days=(4 - date.today().weekday()) % 7)).isoformat(),
        "method": "trend_with_average_fallback",
    }
