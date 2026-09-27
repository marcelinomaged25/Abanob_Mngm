import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, CalendarDays, Check, ChevronLeft, ChevronRight, Church, CircleAlert, Clock3, Copy, Home, LayoutDashboard, LoaderCircle, Pencil, Phone, Plus, Search, Trash2, UserCheck, Users, X } from "lucide-react";

const apiUrl = (import.meta.env.VITE_API_URL || "https://abanob-mngm.onrender.com").replace(/\/$/, "");
const today = () => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};
const dateLabel = (value) => value ? new Intl.DateTimeFormat("ar-EG", { day: "numeric", month: "long", year: "numeric" }).format(new Date(`${value}T12:00:00`)) : "—";
const normalizeArabic = (value) => String(value || "").replace(/[إأآ]/g, "ا");
const emptyState = { rows: [], groups: [], servants: [], historySummary: [] };
const emptyVisitReports = { totalPeople: 0, year: new Date().getFullYear(), daily: [], monthly: [], yearly: [], totals: { daily: 0, monthly: 0, yearly: 0 } };
const emptyPerson = { name: "", group: "", phone1: "", phone2: "", address: "", note: "", role: "boy" };

function groupTone(group) {
  const number = Number.parseInt(String(group).replace(/\D/g, ""), 10);
  return Number.isFinite(number) ? ((number - 1) % 9) + 1 : 1;
}

export default function App() {
  const [password, setPassword] = useState(() => sessionStorage.getItem("choir-password") || "");
  const [passwordDraft, setPasswordDraft] = useState("");
  const [mode, setMode] = useState("home");
  const [state, setState] = useState(emptyState);
  const [selectedDate, setSelectedDate] = useState(today());
  const [rotationStart, setRotationStart] = useState("");
  const [servantsText, setServantsText] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [report, setReport] = useState(null);
  const [editingPerson, setEditingPerson] = useState(null);
  const [personDraft, setPersonDraft] = useState(emptyPerson);
  const [attendanceType, setAttendanceType] = useState("choir");
  const [attendanceDate, setAttendanceDate] = useState(today());
  const [attendanceChecks, setAttendanceChecks] = useState({});
  const [dashboard, setDashboard] = useState({ summary: {}, people: [] });
  const [visitReports, setVisitReports] = useState(emptyVisitReports);
  const [reportMonth, setReportMonth] = useState(today().slice(0, 7));
  const [activity, setActivity] = useState([]);
  const [includeVisitedThisMonth, setIncludeVisitedThisMonth] = useState(false);
  const [dashboardDate, setDashboardDate] = useState(today());
  const [trendMonth, setTrendMonth] = useState(today().slice(0, 7));

  const request = useCallback(async (path, options = {}, auth = password) => {
    const response = await fetch(`${apiUrl}${path}`, { ...options, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(auth ? { "X-App-Password": auth } : {}), ...options.headers } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `تعذر إكمال الطلب (${response.status})`);
    return body;
  }, [password]);

  const load = useCallback(async (nextMode = mode, date = selectedDate, auth = password, monthOverride = trendMonth) => {
    if (!auth) return;
    setLoading(true); setError("");
    try {
      if (nextMode === "home") {
        const result = await request(`/api/dashboard?date=${date || today()}&month=${monthOverride}`, {}, auth); setDashboard(result); setDashboardDate(result.selectedDate); setTrendMonth(result.trendMonth || monthOverride); return;
      }
      if (nextMode === "stray") {
        const result = await request(`/api/dashboard?date=${date || today()}&month=${monthOverride}`, {}, auth); setDashboard(result); setDashboardDate(result.selectedDate); setTrendMonth(result.trendMonth || monthOverride); return;
      }
      if (nextMode === "reports") { const selectedMonth = monthOverride || reportMonth; setVisitReports(await request(`/api/visit-reports?month=${selectedMonth}`, {}, auth)); return; }
      if (nextMode === "activity") { setActivity(await request("/api/activity", {}, auth)); return; }
      if (nextMode === "attendance") {
        const result = await request(`/api/attendance?type=${attendanceType}&date=${date || today()}`, {}, auth);
        const directory = await request("/api/state?mode=visit", {}, auth);
        setState(directory); setAttendanceDate(result.date); setAttendanceChecks(Object.fromEntries((result.attended || []).map((id) => [id, true]))); return;
      }
      const params = new URLSearchParams({ mode: nextMode === "visit" ? "visit" : "call" });
      if (nextMode === "visit") params.set("date", date || today());
      const result = await request(`/api/state?${params}`, {}, auth);
      setState(result);
      if (nextMode === "visit") setSelectedDate(result.selectedDate);
      setRotationStart(result.rotationStart || "");
      setServantsText((result.servants || []).join("\n"));
    } catch (loadError) {
      setError(loadError.message);
      if (loadError.message.includes("401")) { sessionStorage.removeItem("choir-password"); setPassword(""); }
    } finally { setLoading(false); }
  }, [attendanceType, mode, password, reportMonth, request, selectedDate]);

  useEffect(() => { if (password) { load(mode, mode === "attendance" ? attendanceDate : selectedDate, password); } }, [password]);

  const rows = useMemo(() => {
    const term = normalizeArabic(query).trim().toLocaleLowerCase("ar");
    return state.rows.filter((row) => normalizeArabic([row.name, row.group, row.phone1, row.phone2, row.address, row.note, row.servant, row.lastCaller].filter(Boolean).join(" ")).toLocaleLowerCase("ar").includes(term));
  }, [query, state.rows]);
  const visitRows = useMemo(() => { const term = normalizeArabic(query).trim().toLocaleLowerCase("ar"); const base = includeVisitedThisMonth ? state.rows : state.rows.filter((row) => !row.visitedThisMonth); return base.filter((row) => normalizeArabic([row.name, row.group, row.phone1, row.phone2, row.address, row.note, row.servant, row.lastCaller].filter(Boolean).join(" ")).toLocaleLowerCase("ar").includes(term)); }, [includeVisitedThisMonth, query, state.rows]);
  const checkedCount = state.rows.filter((row) => mode === "visit" ? row.visited : row.called).length;
  const percent = state.rows.length ? Math.round(checkedCount * 100 / state.rows.length) : 0;
  const followUpMode = mode === "visit" || mode === "call";

  async function login(event) {
    event.preventDefault();
    const candidate = passwordDraft.trim();
    if (!candidate) return;
    setBusy(true); setError(""); sessionStorage.setItem("choir-password", candidate); setPassword(candidate);
    try {
      await request("/api/session", {}, candidate);
      const result = await request(`/api/dashboard?date=${today()}&month=${today().slice(0, 7)}`, {}, candidate);
      setDashboard(result);
      setDashboardDate(result.selectedDate);
      setTrendMonth(result.trendMonth || today().slice(0, 7));
      const followUp = await request(`/api/state?mode=visit&date=${today()}`, {}, candidate);
      setState(followUp); setSelectedDate(followUp.selectedDate); setRotationStart(followUp.rotationStart || ""); setServantsText((followUp.servants || []).join("\n"));
    } catch (loginError) { sessionStorage.removeItem("choir-password"); setPassword(""); setError(loginError.message); }
    finally { setBusy(false); }
  }

  function switchMode(nextMode) {
    setMode(nextMode); setQuery(""); setReport(null);
    if (nextMode === "people") { setEditingPerson(null); setPersonDraft(emptyPerson); }
    if (nextMode === "attendance") load(nextMode, attendanceDate); else if (nextMode === "home" || nextMode === "stray") load(nextMode, dashboardDate); else if (nextMode === "reports") load(nextMode); else load(nextMode, nextMode === "visit" ? selectedDate : undefined);
  }

  async function exportCsv() {
    try {
      const response = await fetch(`${apiUrl}/api/export/visits`, { headers: { "X-App-Password": password } });
      if (!response.ok) throw new Error("تعذر تصدير التقرير");
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `follow-up-visits-${today()}.csv`; link.click(); URL.revokeObjectURL(url); setNotice("تم تصدير التقرير");
    } catch (exportError) { setError(exportError.message); }
  }

  function updateCheck(recordKey, field, checked) {
    setState((current) => ({ ...current, rows: current.rows.map((row) => row.recordKey === recordKey ? { ...row, [field]: checked } : row) }));
  }

  async function saveFollowUp(assign = false) {
    setBusy(true); setNotice(""); setError("");
    try {
      let result;
      if (mode === "visit") {
        const checks = Object.fromEntries(state.rows.map((row) => [row.recordKey, row.visited === true]));
        result = await request("/api/visits", { method: "POST", body: JSON.stringify({ date: selectedDate, checks }) });
      } else {
        const checks = Object.fromEntries(state.rows.map((row) => [row.recordKey, row.called === true]));
        const servants = servantsText.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
        result = await request("/api/calls", { method: "POST", body: JSON.stringify({ rotationStart, servants, checks }) });
      }
      setState(result); setRotationStart(result.rotationStart || rotationStart); setServantsText((result.servants || []).join("\n"));
      setNotice(assign ? "تم حفظ دورة التوزيع" : "تم حفظ العلامات");
    } catch (saveError) { setError(saveError.message); }
    finally { setBusy(false); }
  }

  async function savePerson(event) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      await request(editingPerson ? `/api/people/${editingPerson.id}` : "/api/people", { method: editingPerson ? "PUT" : "POST", body: JSON.stringify(personDraft) });
      setNotice(editingPerson ? "تم تعديل بيانات الاسم" : "تمت إضافة الاسم");
      setEditingPerson(null); setPersonDraft(emptyPerson); await load("people");
    } catch (saveError) { setError(saveError.message); }
    finally { setBusy(false); }
  }

  async function saveAttendance() {
    setBusy(true); setError(""); setNotice("");
    try { await request("/api/attendance", { method: "POST", body: JSON.stringify({ type: attendanceType, date: attendanceDate, checks: attendanceChecks }) }); setNotice("تم حفظ الحضور"); await load("attendance", attendanceDate); }
    catch (saveError) { setError(saveError.message); } finally { setBusy(false); }
  }

  async function archivePerson(person) {
    if (!window.confirm(`سيتم إخفاء ${person.name} من المتابعة مع الاحتفاظ بسجله. هل تريد المتابعة؟`)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await request(`/api/people/${person.id}`, { method: "DELETE" });
      if (editingPerson?.id === person.id) { setEditingPerson(null); setPersonDraft(emptyPerson); }
      setNotice("تم حذف الاسم من المتابعة"); await load("people");
    } catch (deleteError) { setError(deleteError.message); }
    finally { setBusy(false); }
  }

  function editPerson(person) {
    setEditingPerson(person);
    setPersonDraft({ name: person.name || "", group: person.group || "", phone1: person.phone1 || "", phone2: person.phone2 || "", address: person.address || "", note: person.note || "", role: person.role || "boy" });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function openReport(person) {
    try { setReport(await request(`/api/history/${person.id}`)); }
    catch (reportError) { setError(reportError.message); }
  }

  if (!password) return <main className="login-screen"><form className="login-panel" onSubmit={login}><div className="login-brand"><img src="/saint-abanoub.png" alt="القديس أبانوب" /></div><p className="eyebrow">كنيسة السيدة العذراء مريم بارض الشركة</p><h1>إدارة خورس القديس أبانوب</h1><label htmlFor="app-password">كلمة مرور الخدام</label><input id="app-password" type="password" autoComplete="current-password" value={passwordDraft} onChange={(event) => setPasswordDraft(event.target.value)} required autoFocus /><button className="primary-button" disabled={busy}>{busy ? <LoaderCircle size={17} className="spin" /> : null} دخول</button>{error && <p className="login-error">{error}</p>}</form></main>;

  const navItem = (nextMode, icon, label) => <button className={`sidebar-item ${mode === nextMode || (nextMode === "visit" && (mode === "call" || mode === "history" || mode === "reports")) ? "active" : ""}`} onClick={() => switchMode(nextMode)}>{icon}<span>{label}</span></button>;
  return <main className="app-shell">
    <aside className="app-sidebar"><div className="sidebar-brand"><img src="/saint-abanoub.png" alt="القديس أبانوب" /><div><strong>كنيستي</strong><span>إدارة الخدمة</span></div></div><p className="sidebar-label">أقسام لوحة الإدارة</p><nav className="sidebar-nav">{navItem("home", <LayoutDashboard size={17} />, "نظرة عامة")}{navItem("attendance", <UserCheck size={17} />, "الحضور والغياب")}{navItem("visit", <Home size={17} />, "الافتقاد")}{navItem("stray", <CircleAlert size={17} />, "الخروف الضال")}{navItem("history", <Users size={17} />, "أفراد الخورس")}{navItem("people", <Pencil size={17} />, "إدارة الخورس")}{navItem("activity", <Clock3 size={17} />, "سجل النشاط")}</nav><div className="sidebar-footer"><span>خورس القديس أبانوب</span><button className="icon-button" title="تسجيل الخروج" aria-label="تسجيل الخروج" onClick={() => { sessionStorage.removeItem("choir-password"); setPassword(""); setPasswordDraft(""); }}>×</button></div></aside>
    <section className="app-content"><header className="topbar"><div className="brand-lockup"><div><p className="eyebrow">كنيسة السيدة العذراء مريم بارض الشركة</p><h1>إدارة خورس القديس أبانوب</h1></div></div><div className="top-actions">{mode === "reports" && <button className="copy-phone" title="تصدير التقرير" onClick={exportCsv}><Copy size={14} /></button>}<span className="save-state">{loading ? "جاري التحميل" : busy ? "جاري الحفظ" : notice || "جاهز"}</span></div></header>
    {mode === "visit" && state.verse && <section className="verse-band"><p>{state.verse}</p></section>}
    {mode === "visit" || mode === "call" || mode === "reports" ? <div className="sub-tabs"><button className={mode === "visit" ? "active" : ""} onClick={() => switchMode("visit")}><Home size={15} /> زيارة البيت</button><button className={mode === "call" ? "active" : ""} onClick={() => switchMode("call")}><Phone size={15} /> الاتصال الأسبوعي</button><button className={mode === "reports" ? "active" : ""} onClick={() => switchMode("reports")}><BarChart3 size={15} /> تقارير الافتقاد</button></div> : null}

    {followUpMode && <FollowUpDashboard mode={mode} state={state} selectedDate={selectedDate} setSelectedDate={setSelectedDate} rotationStart={rotationStart} setRotationStart={setRotationStart} servantsText={servantsText} setServantsText={setServantsText} busy={busy} saveFollowUp={saveFollowUp} load={load} checkedCount={checkedCount} percent={percent} />}
    {mode === "people" && <PeopleManager state={state} rows={rows} query={query} setQuery={setQuery} busy={busy} editingPerson={editingPerson} personDraft={personDraft} setPersonDraft={setPersonDraft} savePerson={savePerson} editPerson={editPerson} archivePerson={archivePerson} cancelEdit={() => { setEditingPerson(null); setPersonDraft(emptyPerson); }} />}
    {mode === "attendance" && <AttendanceManager state={state} rows={rows} attendanceType={attendanceType} setAttendanceType={(type) => { setAttendanceType(type); load("attendance", attendanceDate); }} attendanceDate={attendanceDate} setAttendanceDate={(date) => { setAttendanceDate(date); load("attendance", date); }} checks={attendanceChecks} setChecks={setAttendanceChecks} save={saveAttendance} busy={busy} query={query} setQuery={setQuery} />}
    {mode === "home" && <HomeDashboard dashboard={dashboard} dashboardDate={dashboardDate} setDashboardDate={(date) => { setDashboardDate(date); load("home", date); }} trendMonth={trendMonth} setTrendMonth={(month) => { setTrendMonth(month); load("home", dashboardDate, password, month); }} openReport={openReport} />}
    {mode === "stray" && <StraySheepPage people={dashboard.people || []} openReport={openReport} />}
    {(mode === "visit" || mode === "call") && <PeopleTable mode={mode} rows={mode === "visit" ? visitRows : rows} query={query} setQuery={setQuery} busy={busy} saveFollowUp={saveFollowUp} updateCheck={updateCheck} openReport={openReport} loading={loading} includeVisitedThisMonth={includeVisitedThisMonth} setIncludeVisitedThisMonth={setIncludeVisitedThisMonth} />}
    {mode === "reports" && <VisitReportsPage reports={visitReports} exportCsv={exportCsv} month={reportMonth} setMonth={(month) => { setReportMonth(month); load("reports", undefined, password, month); }} />}
    {mode === "activity" && <ActivityPage activity={activity} />}
    {mode === "history" && <MembersDirectoryByRole rows={rows} query={query} setQuery={setQuery} openReport={openReport} loading={loading} />}
    {(error || notice) && <div className={`toast visible ${error ? "error" : ""}`} role="status">{error || notice}</div>}
    {report && <ReportModal report={report} close={() => setReport(null)} />}
    </section></main>;
}

function StraySheepPage({ people, openReport }) {
  const rows = people.filter((person) => person.role !== "servant").map((person) => {
    const attendance = (person.choirCount || 0) + (person.massCount || 0);
    const followUp = (person.visitCount || 0) + (person.callCount || 0);
    const activity = attendance * 2 + followUp;
    return { ...person, attendance, followUp, activity, need: Math.max(0, 100 - Math.min(100, activity * 10)) };
  }).sort((a, b) => a.activity - b.activity || a.attendance - b.attendance || a.name.localeCompare(b.name, "ar"));
  return <section className="stray-page"><section className="stray-hero"><div><p className="section-kicker">متابعة الرعاية</p><h2>الخروف الضال</h2><p>الأسماء الأكثر احتياجًا للمتابعة حسب الحضور والافتقاد.</p></div><CircleAlert size={30} /></section><section className="stray-note"><strong>طريقة الترتيب</strong><span>الأعلى في القائمة هو الأقل حضورًا في الخورس والقداس، والأقل افتقادًا بالزيارة والاتصال.</span></section><section className="table-section stray-table"><div className="section-title-row table-title-row"><div><p className="section-kicker">أولوية المتابعة</p><h2>{rows.length} مخدوم</h2></div><span className="date-label">من الأكثر احتياجًا إلى الأقل</span></div><div className="stray-list">{rows.map((row, index) => <button className={`stray-person group-tone-${groupTone(row.group)}`} key={row.id} onClick={() => openReport(row)}><span className="stray-rank">{index + 1}</span><span className="stray-person-info"><strong>{row.name}</strong><small>{row.phone1 || "بدون رقم"}</small></span><span className="stray-stats"><b>{row.need}%</b><small>احتياج متابعة</small></span><span className="stray-counts"><span>خورس {row.choirCount || 0}</span><span>قداس {row.massCount || 0}</span><span>زيارة {row.visitCount || 0}</span><span>اتصال {row.callCount || 0}</span></span></button>)}</div>{!rows.length && <p className="empty-row">لا توجد بيانات مخدومين</p>}</section></section>;
}

function VisitReportsPage({ reports, exportCsv, month, setMonth }) {
  const [period, setPeriod] = useState("day");
  const totalPeople = reports.totalPeople || 0;
  const chart = (title, icon, daily, monthly, yearly, empty) => {
    const data = period === "day" ? (daily || []) : period === "month" ? (monthly || []) : (yearly || []);
    const max = Math.max(1, ...data.map((item) => item.count || 0));
    return <section className="table-section report-chart-card"><div className="section-title-row table-title-row"><div><p className="section-kicker">{icon} {title}</p><h2>{period === "day" ? `أيام شهر ${reports.month}` : period === "month" ? `شهور سنة ${reports.year}` : "السنوات"}</h2></div><span className="date-label">{data.reduce((sum, item) => sum + (item.count || 0), 0)} شخص</span></div><div className="report-bar-chart">{data.map((item) => { const label = period === "day" ? dateLabel(item.date) : period === "month" ? item.month : item.year; return <div className="report-bar-column" key={String(label)}><strong>{item.count}</strong><i style={{ height: `${Math.max(8, (item.count || 0) * 100 / max)}%` }} /><span>{label}</span></div>; })}{!data.length && <p className="empty-row">{empty}</p>}</div></section>;
  };
  return <section className="visit-reports-page"><section className="reports-hero"><div><p className="section-kicker">تقارير الافتقاد</p><h2>الزيارات والاتصالات</h2><p>اختار الفترة وشوف التقدم في جراف واضح.</p></div><div className="reports-hero-actions"><label className="report-month-picker">الشهر<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label><div className="report-period-switch"><button className={period === "day" ? "active" : ""} onClick={() => setPeriod("day")}>يومي</button><button className={period === "month" ? "active" : ""} onClick={() => setPeriod("month")}>شهري</button><button className={period === "year" ? "active" : ""} onClick={() => setPeriod("year")}>سنوي</button></div><button className="secondary-button" onClick={exportCsv}><Copy size={15} /> تصدير</button><BarChart3 size={30} /></div></section>{chart("الزيارات", "زيارة", reports.daily, reports.monthly, reports.yearly, "لا توجد زيارات في الفترة المختارة")}{chart("الاتصالات", "اتصال", reports.callDaily, reports.callMonthly, reports.callYearly, "لا توجد اتصالات في الفترة المختارة")}</section>;
}

function CopyPhone({ value, name }) {
  if (!value) return <span>—</span>;
  return <span className="phone-copy-cell"><span dir="ltr">{value}</span><button type="button" className="copy-phone" title="نسخ الرقم" aria-label={`نسخ رقم ${name}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); navigator.clipboard?.writeText(value); }}><Copy size={13} /></button></span>;
}

function ActivityPage({ activity }) {
  return <section className="table-section activity-page"><div className="section-title-row table-title-row"><div><p className="section-kicker">أمان ومتابعة</p><h2>سجل النشاط</h2></div><span className="date-label">آخر 200 عملية</span></div><div className="table-wrap"><table><thead><tr><th>التاريخ</th><th>المستخدم</th><th>العملية</th><th>التفاصيل</th></tr></thead><tbody>{activity.map((item) => <tr key={item.id}><td className="history-date">{item.createdAt}</td><td>{item.role === "admin" ? "مدير" : "خادم"}</td><td>{item.action}</td><td>{item.details}</td></tr>)}</tbody></table>{!activity.length && <p className="empty-row">لا يوجد نشاط مسجل</p>}</div></section>;
}

function HomeDashboard({ dashboard, dashboardDate, setDashboardDate, trendMonth, setTrendMonth, openReport }) {
  const summary = dashboard.summary || {};
  const people = dashboard.people || [];
  const daily = dashboard.dailySummary || { total: 0, choirPresent: 0, massPresent: 0 };
  const dailyPeople = dashboard.dailyPeople || [];
  const choirAbsent = Math.max(0, daily.total - daily.choirPresent);
  const massAbsent = Math.max(0, daily.total - daily.massPresent);
  const attendancePercent = daily.total ? Math.round(((daily.choirPresent + daily.massPresent) / (daily.total * 2)) * 100) : 0;
  return <section className="home-dashboard"><div className="dashboard-hero"><div><p className="section-kicker">لوحة حضور اليوم</p><h2>اجتماع خورس القديس أبانوب</h2><p>اختر التاريخ لمراجعة حضور الخورس والقداس.</p></div><div className="hero-date"><label>التاريخ<input type="date" value={dashboardDate} onChange={(event) => setDashboardDate(event.target.value)} /></label><img src="/saint-abanoub.png" alt="القديس أبانوب" /></div></div><div className="dashboard-metrics"><Metric label="إجمالي الخورس" value={daily.total} /><Metric label="حضور الخورس" value={daily.choirPresent} detail={`${daily.total ? Math.round(daily.choirPresent * 100 / daily.total) : 0}%`} tone="teal" /><Metric label="غياب الخورس" value={choirAbsent} detail={`${daily.total ? Math.round(choirAbsent * 100 / daily.total) : 0}%`} tone="amber" /><Metric label="حضور القداس" value={daily.massPresent} detail={`${daily.total ? Math.round(daily.massPresent * 100 / daily.total) : 0}%`} tone="blue" /><Metric label="غياب القداس" value={massAbsent} detail={`${daily.total ? Math.round(massAbsent * 100 / daily.total) : 0}%`} tone="red" /><Metric label="نسبة الحضور العامة" value={`${attendancePercent}%`} detail="خورس + قداس" tone="navy" /></div><div className="dashboard-main-grid"><DailyAttendanceChart people={dailyPeople} total={daily.total} /></div><WeeklyTrendChart trend={dashboard.weeklyTrend || []} total={daily.total} month={trendMonth} setMonth={setTrendMonth} /><div className="dashboard-attendance-columns"><DailyList title="الأكثر حضورًا للقداس" people={dailyPeople.filter((person) => person.massPresent)} openReport={openReport} /><DailyList title="الأكثر حضورًا للخورس" people={dailyPeople.filter((person) => person.choirPresent)} openReport={openReport} /><DailyList title="الأقل حضورًا للقداس" people={dailyPeople.filter((person) => !person.massPresent)} openReport={openReport} /><DailyList title="الأقل حضورًا للخورس" people={dailyPeople.filter((person) => !person.choirPresent)} openReport={openReport} /></div></section>;
}

function Metric({ label, value, detail, tone }) { return <article className={`dashboard-metric ${tone || ""}`}><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</article>; }
function Coverage({ label, value, total, tone }) { const percent = total ? Math.round(value * 100 / total) : 0; return <div className="coverage-item"><div><span>{label}</span><strong>{value} / {total || 0}</strong></div><div className="coverage-track"><span className={`coverage-fill ${tone}`} style={{ width: `${percent}%` }} /></div></div>; }
function AttendanceList({ title, people, openReport, metric }) { return <section className="table-section attendance-list-panel"><div className="section-title-row table-title-row"><h2>{title}</h2><span className="date-label">حسب عدد المرات</span></div><div className="absent-list">{people.slice(0, 8).map((person) => <button className="absent-person" key={person.id} onClick={() => openReport({ id: person.id, name: person.name, group: person.group, phone1: "" })}><span className="absent-avatar">{person.name.slice(0, 1)}</span><span><strong>{person.name}</strong><small>{person.role === "servant" ? "خادم" : "مخدوم"}</small></span><b className="attendance-count">{person[metric]}</b></button>)}</div></section>; }
function DailyList({ title, people, openReport }) { return <section className="table-section attendance-list-panel"><div className="section-title-row table-title-row"><h2>{title}</h2><span className="date-label">اليوم</span></div><div className="absent-list">{people.slice(0, 5).map((person) => <button className="absent-person" key={person.id} onClick={() => openReport({ id: person.id, name: person.name, group: person.group, phone1: "" })}><span className="absent-avatar">{person.name.slice(0, 1)}</span><span><strong>{person.name}</strong><small>{person.role === "servant" ? "خادم" : "مخدوم"}</small></span><b className="attendance-count">حاضر</b></button>)}</div></section>; }
function DailyAttendanceChart({ people, total }) {
  const choir = people.filter((person) => person.choirPresent).length;
  const mass = people.filter((person) => person.massPresent).length;
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const filtered = people.filter((person) => {
    const matches = person.name.toLocaleLowerCase("ar").includes(query.trim().toLocaleLowerCase("ar"));
    const status = filter === "choir" ? person.choirPresent : filter === "mass" ? person.massPresent : filter === "absent" ? !person.choirPresent && !person.massPresent : true;
    return matches && status;
  });
  return <div className="dashboard-attendance-split"><section className="daily-chart"><div className="chart-heading"><div><p className="section-kicker">حضور اليوم</p><h2>توزيع الحضور والغياب</h2></div><span className="chart-badge">{total ? Math.round(((choir + mass) / (total * 2)) * 100) : 0}%</span></div><AttendanceDonut choir={choir} mass={mass} total={total} /><div className="attendance-bars"><AttendanceBar label="حضور الخورس" value={choir} total={total} tone="teal" /><AttendanceBar label="غياب الخورس" value={Math.max(0, total - choir)} total={total} tone="amber" /><AttendanceBar label="حضور القداس" value={mass} total={total} tone="blue" /><AttendanceBar label="غياب القداس" value={Math.max(0, total - mass)} total={total} tone="red" /></div><div className="chart-total">إجمالي اليوم: <strong>{total}</strong> شخص</div></section><section className="dashboard-attendance-table table-section"><div className="table-title-row"><div><p className="section-kicker">آخر تسجيلات الحضور</p><h2>متابعة الحضور</h2></div><input className="dashboard-table-search" type="search" placeholder="ابحث بالاسم" value={query} onChange={(event) => setQuery(event.target.value)} /></div><div className="dashboard-filter-tabs"><button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>الكل</button><button className={filter === "choir" ? "active" : ""} onClick={() => setFilter("choir")}>حاضر خورس</button><button className={filter === "mass" ? "active" : ""} onClick={() => setFilter("mass")}>حاضر قداس</button><button className={filter === "absent" ? "active" : ""} onClick={() => setFilter("absent")}>غائب</button></div><div className="table-wrap"><table><thead><tr><th>المخدوم</th><th>المجموعة</th><th>الحالة</th></tr></thead><tbody>{filtered.slice(0, 8).map((person) => <tr key={person.id}><td className="name-cell">{person.name}</td><td>{person.group || "—"}</td><td><span className={`attendance-status ${person.choirPresent || person.massPresent ? "present" : "absent"}`}>{person.choirPresent || person.massPresent ? "حاضر" : "غائب"}</span></td></tr>)}</tbody></table></div></section></div>;
}
function WeeklyTrendChart({ trend, total, month, setMonth }) {
  const totals = trend.map((item) => item.choir + item.mass);
  const max = Math.max(total || 1, ...totals, 1);
  const first = totals[0] || 0; const last = totals[totals.length - 1] || 0;
  const change = first ? Math.round(((last - first) / first) * 100) : 0;
  return <section className="weekly-trend"><div className="trend-heading"><div><p className="section-kicker">اتجاه الحضور</p><h2>جمعات الشهر المختار</h2><span>هل العدد يزيد أم يقل؟</span></div><div className="trend-controls"><label>الشهر<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label><span className={`trend-change ${change >= 0 ? "up" : "down"}`}>{change >= 0 ? "+" : ""}{change}%</span></div></div><div className="trend-chart">{trend.map((item) => { const totalCount = item.choir + item.mass; return <div className="trend-column" key={item.date}><div className="trend-value">{totalCount}</div><div className="trend-bar-wrap"><i className="trend-bar" style={{ height: `${Math.max(5, totalCount * 100 / max)}%` }} /></div><small>{new Intl.DateTimeFormat("ar-EG", { day: "numeric", month: "short" }).format(new Date(`${item.date}T12:00:00`))}</small></div>; })}</div><div className="trend-legend"><span><i /> إجمالي الحضور في الخورس والقداس</span><span>الأعلى: {Math.max(...totals, 0)} · الأحدث: {last}</span></div></section>;
}
function DashboardCalendar({ entries }) {
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const key = (date) => date.toISOString().slice(0, 10);
  const entryMap = new Map(entries.map((entry) => [entry.date, entry]));
  const firstDay = (month.getDay() + 1) % 7;
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = [...Array(firstDay).fill(null), ...Array.from({ length: daysInMonth }, (_, index) => new Date(month.getFullYear(), month.getMonth(), index + 1))];
  return <section className="dashboard-calendar"><div className="calendar-heading"><div><p className="section-kicker">التقويم</p><h2>متابعة الأيام</h2></div><div className="calendar-nav"><button aria-label="الشهر السابق" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronRight size={16} /></button><strong>{new Intl.DateTimeFormat("ar-EG", { month: "long", year: "numeric" }).format(month)}</strong><button aria-label="الشهر التالي" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronLeft size={16} /></button></div></div><div className="calendar-weekdays">{["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"].map((day) => <span key={day}>{day}</span>)}</div><div className="calendar-grid">{cells.map((date, index) => { const entry = date ? entryMap.get(key(date)) : null; return <div className={`calendar-day ${date && key(date) === today() ? "today" : ""} ${date ? "" : "empty"}`} key={date ? key(date) : `empty-${index}`}>{date && <><b>{date.getDate()}</b>{entry && <div className="calendar-dots"><i className={entry.choir ? "choir" : ""} /><i className={entry.mass ? "mass" : ""} /><i className={entry.visits ? "visit" : ""} /><small>{entry.choir + entry.mass + entry.visits + entry.calls}</small></div>}</>}</div>; })}</div><div className="calendar-legend"><span><i className="choir" /> خورس</span><span><i className="mass" /> قداس</span><span><i className="visit" /> افتقاد</span></div></section>;
}

function FollowUpDashboard({ mode, state, selectedDate, setSelectedDate, rotationStart, setRotationStart, servantsText, setServantsText, busy, saveFollowUp, load, checkedCount, percent }) {
  const monthVisited = mode === "visit" ? (state.monthVisitedCount || 0) : checkedCount;
  const monthTotal = mode === "visit" ? (state.monthTotal || state.rows.length) : state.rows.length;
  const monthPercent = monthTotal ? Math.round(monthVisited * 100 / monthTotal) : 0;
  return <><section className="control-grid">
    {mode === "call" && <article className="panel servants-panel"><div className="panel-heading"><div><p className="section-kicker">قائمة التوزيع</p><h2>مسؤولو الاتصال</h2></div><span className="count-badge">{servantsText.split(/\r?\n/).filter((name) => name.trim()).length}</span></div><textarea rows="5" placeholder="اكتب اسم كل خادم في سطر" value={servantsText} onChange={(event) => setServantsText(event.target.value)} /><div className="field-hint">كل سطر خادم واحد. التوزيع يتناوب أسبوعيًا على الجروبات.</div></article>}
    <article className="panel settings-panel"><div className="panel-heading"><div><p className="section-kicker">{mode === "visit" ? "التاريخ" : "دورة التوزيع"}</p><h2>{mode === "visit" ? "تاريخ الزيارة" : state.distributionNotStarted ? "أول أسبوع قادم" : "الأسبوع الحالي"}</h2></div><span className="week-mark"><CalendarDays size={17} /></span></div>{mode === "visit" ? <><label htmlFor="period-date">تاريخ تسجيل الزيارة</label><input id="period-date" type="date" value={selectedDate} onChange={(event) => { setSelectedDate(event.target.value); load(mode, event.target.value); }} /><div className="period-range">{dateLabel(selectedDate)}</div><label htmlFor="visit-month">شهر متابعة الافتقاد</label><input id="visit-month" type="month" value={selectedDate.slice(0, 7)} onChange={(event) => { const date = `${event.target.value}-01`; setSelectedDate(date); load(mode, date); }} /></> : <><div className="period-range">من {dateLabel(state.selectedWeek)} إلى {dateLabel(state.weekEnd)}<br />{state.distributionNotStarted ? "لم يبدأ التوزيع بعد." : "يتغير تلقائيًا كل 7 أيام."}</div><label htmlFor="rotation-date">بداية أول أسبوع للتوزيع</label><input id="rotation-date" type="date" value={rotationStart} onChange={(event) => setRotationStart(event.target.value)} /><div className="field-hint">اضبطه مرة واحدة. التطبيق يحدد أسبوع اليوم والمسؤولين تلقائيًا.</div><button className="primary-button" disabled={busy} onClick={() => saveFollowUp(true)}>↻ حفظ بداية التوزيع</button></>}</article>
    <article className="panel overview-panel"><div className="panel-heading"><div><p className="section-kicker">ملخص الشهر</p><h2>حالة الافتقاد</h2></div></div><div className="metrics"><div className="metric"><strong>{state.groups.length}</strong><span>جروب</span></div><div className="metric"><strong>{monthTotal}</strong><span>مخدوم</span></div><div className="metric"><strong>{mode === "visit" ? monthVisited : checkedCount}</strong><span>{mode === "visit" ? "تمت زيارتهم هذا الشهر" : "تم الاتصال بهم"}</span></div></div><div className="progress-track"><div className="progress-fill" style={{ width: `${mode === "visit" ? monthPercent : percent}%` }} /></div><div className="progress-label">{mode === "visit" ? `${monthVisited} من ${monthTotal} · متبقي ${Math.max(0, monthTotal - monthVisited)}` : `${checkedCount} من ${state.rows.length} · متبقي ${state.rows.length - checkedCount}`}</div><div className="rotation-label">{mode === "visit" ? "إجمالي الزيارات المسجلة خلال الشهر المختار" : "مسؤول اتصال واحد لكل جروب خلال الأسبوع"}</div></article>
  </section>{mode === "call" && <section className="group-strip"><div className="section-title-row"><div><p className="section-kicker">المتابعة الحالية</p><h2>مسؤولو الاتصال الأسبوعي</h2></div><span className="date-label">{dateLabel(state.selectedWeek)}</span></div><div className="group-cards">{state.groups.map((group) => { const members = state.rows.filter((row) => row.group === group.number); const checked = members.filter((row) => row.called).length; return <article className={`group-card ${group.servant ? "has-servant" : ""}`} key={group.number}><div className={`group-number tone-${groupTone(group.number)}`}>{group.number}</div><div className="group-info"><span>جروب</span><strong>{group.servant || "لم يُحدد"}</strong><small>{group.members} أفراد · اتصالات {checked}</small></div></article>; })}</div></section>}</>;
}

function PeopleManager({ state, rows, query, setQuery, busy, editingPerson, personDraft, setPersonDraft, savePerson, editPerson, archivePerson, cancelEdit }) {
  const [scope, setScope] = useState("boy");
  const field = (key) => (event) => setPersonDraft({ ...personDraft, [key]: event.target.value });
  const scopedRows = rows.filter((person) => (person.role || "boy") === scope);
  return <section className="people-layout"><article className="panel person-form-panel"><div className="panel-heading"><div><p className="section-kicker">قاعدة بيانات الخورس</p><h2>{editingPerson ? "تعديل بيانات الاسم" : "إضافة ولد أو خادم"}</h2></div><Plus size={19} /></div><form className="person-form" onSubmit={savePerson}><label>الاسم<input value={personDraft.name} onChange={field("name")} required /></label><label>النوع<select value={personDraft.role || "boy"} onChange={field("role")}><option value="boy">ولد</option><option value="servant">خادم</option></select></label><label>رقم الهاتف الأول<input dir="ltr" value={personDraft.phone1} onChange={field("phone1")} /></label><label>رقم الهاتف الثاني<input dir="ltr" value={personDraft.phone2} onChange={field("phone2")} /></label><label className="form-wide">العنوان<input value={personDraft.address} onChange={field("address")} /></label><label className="form-wide">ملاحظات<textarea rows="3" value={personDraft.note} onChange={field("note")} /></label><div className="form-actions"><button className="primary-button" disabled={busy}>{editingPerson ? "حفظ التعديل" : "إضافة الاسم"}</button>{editingPerson && <button type="button" className="cancel-button" onClick={cancelEdit}>إلغاء</button>}</div></form></article><article className="table-section people-table"><div className="section-title-row table-title-row"><div><p className="section-kicker">السجل الحالي</p><div className="segmented-control"><button className={scope === "boy" ? "active" : ""} onClick={() => setScope("boy")}>المخدومين</button><button className={scope === "servant" ? "active" : ""} onClick={() => setScope("servant")}>الخدام</button></div><h2>{scopedRows.length} اسم مسجل</h2></div><label className="search-box"><Search size={17} /><input type="search" placeholder="ابحث بالاسم أو الرقم أو العنوان" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div><div className="table-wrap"><table><thead><tr><th>الاسم</th><th>الجروب</th><th>رقم 1</th><th>رقم 2</th><th>العنوان</th><th>إجراء</th></tr></thead><tbody>{scopedRows.map((person) => <tr className={`group-tone-${groupTone(person.group)}`} key={person.id}><td className="name-cell">{person.name}</td><td><span className="group-pill">{person.group || "—"}</span></td><td dir="ltr">{person.phone1 || "—"}</td><td dir="ltr">{person.phone2 || "—"}</td><td className="address-cell">{person.address || "—"}</td><td className="people-actions"><button className="row-action edit" title="تعديل" onClick={() => editPerson(person)}><Pencil size={15} /></button><button className="row-action delete" title="حذف من المتابعة" onClick={() => archivePerson(person)} disabled={busy}><Trash2 size={15} /></button></td></tr>)}</tbody></table>{!scopedRows.length && <p className="empty-row">لا توجد نتائج</p>}</div></article></section>;
}

function AttendanceManager({ state, rows, attendanceType, setAttendanceType, attendanceDate, setAttendanceDate, checks, setChecks, save, busy, query, setQuery }) {
  const checked = rows.filter((row) => checks[row.id]).length;
  const sortedRows = [...rows].sort((a, b) => normalizeArabic(a.name).localeCompare(normalizeArabic(b.name), "ar"));
  const visibleQuery = normalizeArabic(query).trim().toLocaleLowerCase("ar");
  const visibleRows = sortedRows.filter((row) => normalizeArabic([row.name, row.phone1, row.phone2].filter(Boolean).join(" ")).toLocaleLowerCase("ar").includes(visibleQuery));
  const toggle = (id) => setChecks((current) => ({ ...current, [id]: !current[id] }));
  return <section className="attendance-page"><div className="attendance-controls"><label className="search-box attendance-search"><Search size={17} /><input type="search" placeholder="ابحث بالاسم" value={query} onChange={(event) => setQuery(event.target.value)} /></label><div className="segmented-control"><button className={attendanceType === "choir" ? "active" : ""} onClick={() => setAttendanceType("choir")}><Church size={16} /> حضور الخورس</button><button className={attendanceType === "mass" ? "active" : ""} onClick={() => setAttendanceType("mass")}><UserCheck size={16} /> حضور القداس</button></div><label>تاريخ الحضور<input type="date" value={attendanceDate} onChange={(event) => setAttendanceDate(event.target.value)} /></label><button className="primary-button attendance-save" disabled={busy} onClick={save}><Check size={16} /> حفظ حضور اليوم</button></div><section className="table-section"><div className="section-title-row table-title-row"><div><p className="section-kicker">خورس واحد</p><h2>{attendanceType === "choir" ? "حضور الخورس" : "حضور القداس"}</h2></div><span className="count-badge">{checked} من {rows.length}</span></div><div className="attendance-grid">{visibleRows.map((row, index) => <Fragment key={row.id}>{(() => { const letter = normalizeArabic(row.name).trim().slice(0, 1); const previousLetter = normalizeArabic(visibleRows[index - 1]?.name?.trim() || "").slice(0, 1); return <>{letter !== previousLetter && <div className="attendance-letter">{letter}</div>}<button className={`attendance-person ${checks[row.id] ? "present" : ""}`} key={row.id} onClick={() => toggle(row.id)}><span className="attendance-check">{checks[row.id] ? <Check size={18} /> : null}</span><span className="attendance-name">{row.name}</span><span className="attendance-meta">{row.role === "servant" ? "خادم" : "مخدوم"}</span></button></>})()}</Fragment>)}</div></section></section>;
}

function MembersDirectoryByRole({ rows, query, setQuery, openReport, loading }) {
  const [scope, setScope] = useState("boy");
  const scopedRows = rows.filter((row) => (row.role || "boy") === scope);
  return <section className="table-section members-directory"><div className="section-title-row table-title-row"><div><p className="section-kicker">سجل أفراد الخورس</p><div className="segmented-control"><button className={scope === "boy" ? "active" : ""} onClick={() => setScope("boy")}>المخدومين</button><button className={scope === "servant" ? "active" : ""} onClick={() => setScope("servant")}>الخدام</button></div><h2>{scope === "boy" ? "تقارير المخدومين" : "تقارير الخدام"}</h2></div><label className="search-box"><Search size={17} /><input type="search" placeholder="ابحث بالاسم أو الرقم" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div><div className="table-wrap"><table><thead><tr><th>الاسم</th><th>آخر حضور خورس</th><th>آخر حضور قداس</th><th>آخر زيارة</th><th>آخر اتصال</th></tr></thead><tbody>{scopedRows.map((row) => <tr key={row.id}><td className="name-cell"><button className="person-link" onClick={() => openReport(row)}>{row.name}</button></td><td className="history-date">{dateLabel(row.lastChoirDate)}</td><td className="history-date">{dateLabel(row.lastMassDate)}</td><td className="history-date">{dateLabel(row.lastVisitedDate)}</td><td className="history-date">{dateLabel(row.lastCalledWeek)}</td></tr>)}</tbody></table>{!scopedRows.length && <p className="empty-row">{loading ? "جاري تحميل البيانات" : "لا توجد أسماء"}</p>}</div></section>;
}

function MembersDirectory({ rows, query, setQuery, openReport, loading }) {
  return <section className="table-section members-directory"><div className="section-title-row table-title-row"><div><p className="section-kicker">سجل أفراد الخورس</p><h2>اضغط على الاسم لفتح التقرير</h2></div><label className="search-box"><Search size={17} /><input type="search" placeholder="ابحث بالاسم أو الرقم" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div><div className="table-wrap"><table><thead><tr><th>الاسم</th><th>النوع</th><th>آخر حضور خورس</th><th>آخر حضور قداس</th><th>آخر زيارة</th><th>آخر اتصال</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td className="name-cell"><button className="person-link" onClick={() => openReport(row)}>{row.name}</button></td><td>{row.role === "servant" ? "خادم" : "مخدوم"}</td><td className="history-date">{dateLabel(row.lastChoirDate)}</td><td className="history-date">{dateLabel(row.lastMassDate)}</td><td className="history-date">{dateLabel(row.lastVisitedDate)}</td><td className="history-date">{dateLabel(row.lastCalledWeek)}</td></tr>)}</tbody></table>{!rows.length && <p className="empty-row">{loading ? "جاري تحميل البيانات" : "لا توجد أسماء"}</p>}</div></section>;
}

function CallGroupsTable({ rows, query, setQuery, busy, saveFollowUp, updateCheck, loading }) {
  const filtered = rows.filter((row) => normalizeArabic(`${row.name} ${row.group || ""} ${row.servant || ""}`).includes(normalizeArabic(query)));
  const groups = Object.entries(filtered.reduce((result, row) => {
    const key = row.group || "غير موزع";
    (result[key] ||= []).push(row);
    return result;
  }, {})).sort(([a], [b]) => {
    if (a === "غير موزع") return 1;
    if (b === "غير موزع") return -1;
    return Number(a) - Number(b);
  });
  return <section className="table-section call-groups-section"><div className="section-title-row table-title-row"><div><p className="section-kicker">بيانات الافتقاد</p><h2>الاتصال الأسبوعي حسب الجروب</h2></div><div className="table-actions"><label className="search-box"><Search size={17} /><input type="search" placeholder="ابحث بالاسم أو الجروب أو الخادم" value={query} onChange={(event) => setQuery(event.target.value)} /></label><button className="secondary-button" disabled={busy} onClick={() => saveFollowUp()}><Check size={16} /> احفظ الاتصالات</button></div></div><div className="call-groups-list">{groups.map(([group, members]) => <section className="call-group" key={group}><header className={`call-group-heading group-tone-${group}`}><div><span>الجروب</span><strong>{group}</strong></div><div><span>مسؤول الاتصال</span><b>{members[0]?.servant || "غير موزع"}</b></div><small>{members.length} أفراد · تم الاتصال بـ {members.filter((row) => row.called).length}</small></header><div className="call-group-members">{members.map((row) => <label className="call-member" key={row.id}><span className="call-member-info"><strong>{row.name}</strong><span className="phone-copy-row"><small dir="ltr">{row.phone1 || "بدون رقم"}</small>{row.phone1 && <button type="button" className="copy-phone" title="نسخ الرقم" aria-label={`نسخ رقم ${row.name}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); navigator.clipboard?.writeText(row.phone1); }}><Copy size={13} /></button>}</span></span><input className="status-check" type="checkbox" checked={row.called} onChange={(event) => updateCheck(row.recordKey, "called", event.target.checked)} aria-label={`تم الاتصال بـ ${row.name}`} /></label>)}</div></section>)}{!groups.length && <p className="empty-row">{loading ? "جاري تحميل البيانات" : "لا توجد نتائج"}</p>}</div></section>;
}

function PeopleTable({ mode, rows, query, setQuery, busy, saveFollowUp, updateCheck, openReport, loading, includeVisitedThisMonth, setIncludeVisitedThisMonth }) {
  if (mode === "call") return <CallGroupsTable rows={rows} query={query} setQuery={setQuery} busy={busy} saveFollowUp={saveFollowUp} updateCheck={updateCheck} loading={loading} />;
  return <section className="table-section"><div className="section-title-row table-title-row"><div><p className="section-kicker">بيانات الافتقاد</p><h2>{mode === "visit" ? "زيارة البيت" : mode === "call" ? "الاتصال الأسبوعي" : "آخر متابعة لكل ولد"}</h2></div><div className="table-actions"><label className="search-box"><Search size={17} /><input type="search" placeholder="ابحث بالاسم أو الجروب أو الخادم" value={query} onChange={(event) => setQuery(event.target.value)} /></label>{mode === "visit" && <button className="secondary-button month-filter-button" onClick={() => setIncludeVisitedThisMonth(!includeVisitedThisMonth)}>{includeVisitedThisMonth ? "إخفاء من تمت زيارتهم هذا الشهر" : "إظهار كل من تمت زيارتهم"}</button>}{mode !== "history" && <button className="secondary-button" disabled={busy} onClick={() => saveFollowUp()}><Check size={16} /> احفظ {mode === "visit" ? "الزيارات" : "الاتصالات"}</button>}</div></div><div className="table-wrap"><table><thead><tr>{mode === "visit" ? <><th>الجروب</th><th>الاسم</th><th>رقم 1</th><th>العنوان</th><th>تمت الزيارة</th><th>آخر زيارة</th></> : mode === "call" ? <><th>الجروب</th><th>الاسم</th><th>رقم 1</th><th>مسؤول الاتصال</th><th>تم الاتصال</th></> : <><th>الجروب</th><th>الاسم</th><th>رقم 1</th><th>آخر زيارة</th><th>آخر اتصال</th><th>آخر خادم اتصل</th></>}</tr></thead><tbody>{rows.map((row) => <tr className={`group-tone-${groupTone(row.group)}`} key={row.id}><td><span className="group-pill">{row.group}</span></td><td className="name-cell">{mode === "history" ? <button className="person-link" onClick={() => openReport(row)}>{row.name}</button> : row.name}</td><td className="phone-cell">{mode === "visit" ? <CopyPhone value={row.phone1} name={row.name} /> : row.phone1 || "—"}</td>{mode === "visit" ? <><td className="address-cell">{row.address || "—"}</td><td className="check-cell"><input className="status-check" type="checkbox" checked={row.visited} onChange={(event) => updateCheck(row.recordKey, "visited", event.target.checked)} aria-label={`تمت زيارة ${row.name}`} /></td><td className="history-date">{dateLabel(row.lastVisitedDate)}</td></> : mode === "call" ? <><td><span className={`servant-cell ${row.servant ? "" : "muted"}`}>{row.servant || "غير موزع"}</span></td><td className="check-cell"><input className="status-check" type="checkbox" checked={row.called} onChange={(event) => updateCheck(row.recordKey, "called", event.target.checked)} aria-label={`تم الاتصال بـ ${row.name}`} /></td></> : <><td className="history-date">{dateLabel(row.lastVisitedDate)}</td><td className="history-date">{dateLabel(row.lastCalledWeek)}</td><td><span className="servant-cell">{row.lastCaller || "غير مسجل"}</span></td></>}</tr>)}</tbody></table>{!rows.length && <p className="empty-row">{loading ? "جاري تحميل البيانات" : "لا توجد نتائج"}</p>}</div></section>;
}

function ReportModal({ report, close }) {
  return <div className="modal"><button className="modal-backdrop" aria-label="إغلاق التقرير" onClick={close} /><section className="report-dialog" role="dialog" aria-modal="true"><button className="modal-close" aria-label="إغلاق" onClick={close}><X size={18} /></button><p className="section-kicker">التقرير التفصيلي للفرد</p><h2>{report.person.name}</h2><div className="report-meta">الجروب {report.person.group || "غير مرتبط"} · {report.person.phone1 || "بدون رقم"}</div><div className="report-summary"><span>زيارات: <strong>{report.events.filter((event) => event.visited).length}</strong></span><span>اتصالات: <strong>{report.events.filter((event) => event.called).length}</strong></span><span>خورس: <strong>{report.events.filter((event) => event.choir).length}</strong></span><span>قداس: <strong>{report.events.filter((event) => event.mass).length}</strong></span></div><div className="report-table-wrap"><table className="report-table"><thead><tr><th>التاريخ</th><th>زيارة</th><th>اتصال</th><th>خورس</th><th>قداس</th><th>الخادم</th></tr></thead><tbody>{report.events.length ? report.events.map((event) => <tr key={`${event.date}-${event.caller}-${event.choir}-${event.mass}`}><td>{dateLabel(event.date)}</td><td>{event.visited ? "تمت" : "—"}</td><td>{event.called ? "تم" : "—"}</td><td>{event.choir ? "حضر" : "—"}</td><td>{event.mass ? "حضر" : "—"}</td><td>{event.caller || "—"}</td></tr>) : <tr><td colSpan="6">لا يوجد سجل محفوظ لهذا الفرد</td></tr>}</tbody></table></div></section></div>;
}
function AttendanceBar({ label, value, total, tone }) { const width = total ? Math.max(3, value * 100 / total) : 0; return <div className="attendance-bar-item"><div><span>{label}</span><strong>{value}</strong></div><div className="attendance-bar-track"><i className={tone} style={{ width: width + "%" }} /></div></div>; }
function AttendanceDonut({ choir, mass, total }) { const values = [choir, Math.max(0, total - choir), mass, Math.max(0, total - mass)]; const sum = Math.max(1, values.reduce((a, b) => a + b, 0)); const stops = values.map((value, index) => `${["#078b59", "#d28700", "#6989cf", "#e58c8c"][index]} ${values.slice(0, index).reduce((a, b) => a + b, 0) * 100 / sum}% ${values.slice(0, index + 1).reduce((a, b) => a + b, 0) * 100 / sum}%`).join(", "); return <div className="four-donut-wrap"><div className="four-donut" style={{ background: `conic-gradient(${stops})` }}><strong>{Math.round((choir + mass) * 100 / Math.max(1, total * 2))}%</strong></div><div className="donut-legend"><span><i className="green" /> حضور الخورس <b>{choir}</b></span><span><i className="orange" /> غياب الخورس <b>{Math.max(0, total - choir)}</b></span><span><i className="blue" /> حضور القداس <b>{mass}</b></span><span><i className="red" /> غياب القداس <b>{Math.max(0, total - mass)}</b></span></div></div>; }
