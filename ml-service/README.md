# Attendance forecast service

This small FastAPI service reads the existing PostgreSQL attendance data and exposes `/predict`.
It intentionally starts with a transparent trend model and falls back to the historical average when
there are fewer than three recorded sessions. It should not be treated as a reliable ML forecast until
the choir has accumulated more sessions.

## Render setup

Create a separate Render Web Service from the same repository:

- Root directory: `ml-service`
- Build command: `pip install -r requirements.txt`
- Start command: `uvicorn app:app --host 0.0.0.0 --port $PORT`
- Environment variable: `DATABASE_URL` (the same PostgreSQL connection string used by the API)

The service URL can later be stored in the frontend as `VITE_FORECAST_URL`. Keep the database URL
private and do not expose it to the browser.
