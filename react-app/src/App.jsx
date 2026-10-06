import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, CalendarDays, Check, ChevronLeft, ChevronRight, Church, CircleAlert, Copy, Home, LayoutDashboard, LoaderCircle, LogOut, Moon, Pencil, Phone, Plus, QrCode, Search, Sun, Trash2, UserCheck, Users, X } from "lucide-react";
import QRCode from "qrcode";
import { Html5Qrcode } from "html5-qrcode";

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
let attendanceChecksForComments = {};
let dashboardHistoryPeople = [];
let phoneDirectory = {};
let publicAttendanceRates = { choir: 0, mass: 0 };
const stored = (key, fallback) => sessionStorage.getItem(key) || fallback;
const publicQrToken = window.location.pathname.match(/^\/qr\/([^/]+)\/?$/)?.[1] || "";
const isAdminPage = window.location.pathname === "/admin" || window.location.pathname.startsWith("/admin/");

function groupTone(group) {
  const number = Number.parseInt(String(group).replace(/\D/g, ""), 10);
  return Number.isFinite(number) ? ((number - 1) % 9) + 1 : 1;
}

export default function App() {
  const [username, setUsername] = useState(() => sessionStorage.getItem("choir-username") || "");
  const [password, setPassword] = useState(() => sessionStorage.getItem("choir-password") || "");
  const [usernameDraft, setUsernameDraft] = useState("");
  const [passwordDraft, setPasswordDraft] = useState("");
  const [mode, setMode] = useState(() => stored("choir-mode", "home"));
  const [state, setState] = useState(emptyState);
  const [selectedDate, setSelectedDate] = useState(() => stored("choir-selected-date", today()));
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
  const [attendanceDate, setAttendanceDate] = useState(() => stored("choir-attendance-date", today()));
  const [attendanceChecks, setAttendanceChecks] = useState({});
  const [dashboard, setDashboard] = useState({ summary: {}, people: [] });
  const [visitReports, setVisitReports] = useState(emptyVisitReports);
  const [followUpNotes, setFollowUpNotes] = useState([]);
  const [followUpRequests, setFollowUpRequests] = useState([]);
  const [reportMonth, setReportMonth] = useState(today().slice(0, 7));
  const [includeVisitedThisMonth, setIncludeVisitedThisMonth] = useState(false);
  const [dashboardDate, setDashboardDate] = useState(() => stored("choir-dashboard-date", today()));
  const [trendMonth, setTrendMonth] = useState(() => stored("choir-trend-month", today().slice(0, 7)));
  const [scanPerson, setScanPerson] = useState(null);
  const [scanType, setScanType] = useState("both");
  const [scanDate, setScanDate] = useState(today());
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem("choir-dark-mode") === "true");

  useEffect(() => {
    localStorage.setItem("choir-dark-mode", String(darkMode));
  }, [darkMode]);

  const request = useCallback(async (path, options = {}, auth = password, user = username) => {
    const response = await fetch(`${apiUrl}${path}`, { ...options, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(auth ? { "X-App-Password": auth } : {}), ...(user ? { "X-App-Username": user } : {}), ...options.headers } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `تعذر إكمال الطلب (${response.status})`);
    return body;
  }, [password, username]);

  const load = useCallback(async (nextMode = mode, date = selectedDate, auth = password, monthOverride = trendMonth, attendanceTypeOverride = attendanceType) => {
    if (!auth) return;
    setLoading(true); setError("");
    try {
      if (nextMode === "home") {
        const result = await request(`/api/dashboard?date=${date || today()}&month=${monthOverride}`, {}, auth); setDashboard(result); setDashboardDate(result.selectedDate); setTrendMonth(result.trendMonth || monthOverride); return;
      }
      if (nextMode === "stray") {
        const result = await request(`/api/dashboard?date=${date || today()}&month=${monthOverride}`, {}, auth); setDashboard(result); setDashboardDate(result.selectedDate); setTrendMonth(result.trendMonth || monthOverride); return;
      }
      if (nextMode === "reports") { const selectedMonth = monthOverride || reportMonth; const selectedYear = selectedMonth.slice(0, 4); setVisitReports(await request(`/api/visit-reports?year=${selectedYear}&month=${selectedMonth}`, {}, auth)); return; }
      if (nextMode === "notes") { setFollowUpNotes(await request("/api/followup-notes", {}, auth)); return; }
      if (nextMode === "requests") { setFollowUpRequests(await request("/api/followup-requests", {}, auth)); return; }
      if (nextMode === "attendance") {
        const result = await request(`/api/attendance?type=${attendanceTypeOverride}&date=${date || today()}`, {}, auth);
        const directory = await request("/api/state?mode=visit", {}, auth);
        const attendedKeys = new Set((result.attended || []).map(String));
        setState(directory); setAttendanceDate(result.date); setAttendanceChecks(Object.fromEntries((directory.rows || []).filter((row) => attendedKeys.has(String(row.recordKey))).map((row) => [String(row.recordKey), true]))); return;
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
      if (loadError.message.includes("401")) { sessionStorage.removeItem("choir-password"); sessionStorage.removeItem("choir-username"); setPassword(""); setUsername(""); }
    } finally { setLoading(false); }
  }, [attendanceType, mode, password, reportMonth, request, selectedDate]);

  useEffect(() => { if (password && username) { load(mode, mode === "attendance" ? attendanceDate : selectedDate, password); } }, [password, username]);

  const rows = useMemo(() => {
    const term = normalizeArabic(query).trim().toLocaleLowerCase("ar");
    return state.rows.filter((row) => normalizeArabic([row.name, row.group, row.phone1, row.phone2, row.address, row.note, row.servant, row.lastCaller].filter(Boolean).join(" ")).toLocaleLowerCase("ar").includes(term));
  }, [query, state.rows]);
  const visitRows = useMemo(() => { const term = normalizeArabic(query).trim().toLocaleLowerCase("ar"); const base = state.rows.filter((row) => includeVisitedThisMonth ? row.visitedThisMonth : !row.visitedThisMonth); return base.filter((row) => normalizeArabic([row.name, row.group, row.phone1, row.phone2, row.address, row.note, row.servant, row.lastCaller].filter(Boolean).join(" ")).toLocaleLowerCase("ar").includes(term)); }, [includeVisitedThisMonth, query, state.rows]);
  const checkedCount = state.rows.filter((row) => mode === "visit" ? row.visited : row.called).length;
  const percent = state.rows.length ? Math.round(checkedCount * 100 / state.rows.length) : 0;
  const followUpMode = mode === "visit" || mode === "call";

  async function login(event) {
    event.preventDefault();
    const candidateUsername = usernameDraft.trim();
    const candidate = passwordDraft.trim();
    if (!candidateUsername || !candidate) return;
    setBusy(true); setError(""); sessionStorage.setItem("choir-username", candidateUsername); sessionStorage.setItem("choir-password", candidate); setUsername(candidateUsername); setPassword(candidate);
    try {
      await request("/api/session", {}, candidate, candidateUsername);
      const result = await request(`/api/dashboard?date=${today()}&month=${today().slice(0, 7)}`, {}, candidate, candidateUsername);
      setDashboard(result);
      setDashboardDate(result.selectedDate);
      setTrendMonth(result.trendMonth || today().slice(0, 7));
      const followUp = await request(`/api/state?mode=visit&date=${today()}`, {}, candidate, candidateUsername);
      setState(followUp); setSelectedDate(followUp.selectedDate); setRotationStart(followUp.rotationStart || ""); setServantsText((followUp.servants || []).join("\n"));
    } catch (loginError) { sessionStorage.removeItem("choir-password"); sessionStorage.removeItem("choir-username"); setPassword(""); setUsername(""); setError(loginError.message); }
    finally { setBusy(false); }
  }

  function switchMode(nextMode) {
    setMode(nextMode); sessionStorage.setItem("choir-mode", nextMode); setQuery(""); setReport(null);
    if (nextMode === "people") { setEditingPerson(null); setPersonDraft(emptyPerson); }
    if (nextMode === "attendance") load(nextMode, attendanceDate); else if (nextMode === "home" || nextMode === "stray") load(nextMode, dashboardDate); else if (nextMode === "reports") load(nextMode); else if (nextMode === "qr") { setScanPerson(null); load("people"); } else if (nextMode === "qr-print") load("people"); else load(nextMode, nextMode === "visit" ? selectedDate : undefined);
  }

  async function saveScannedAttendance() {
    if (!scanPerson) return;
    setBusy(true); setError("");
    try {
      const types = scanType === "both" ? ["choir", "mass"] : [scanType];
      for (const type of types) await request("/api/attendance", { method: "POST", body: JSON.stringify({ type, date: scanDate, checks: { [scanPerson.recordKey]: true } }) });
      setAttendanceDate(scanDate);
      setDashboardDate(scanDate);
      setTrendMonth(scanDate.slice(0, 7));
      await load("home", scanDate, password, scanDate.slice(0, 7));
      setNotice(`تم تسجيل حضور ${scanPerson.name}`); setScanPerson(null);
    } catch (saveError) { setError(saveError.message); } finally { setBusy(false); }
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

  async function saveFollowUp(assign = false, groupFilter = "") {
    if (typeof assign === "string") { groupFilter = assign; assign = false; }
    setBusy(true); setNotice(""); setError("");
    try {
      let result;
      if (mode === "visit") {
        const checks = Object.fromEntries(state.rows.map((row) => [row.recordKey, row.visited === true]));
        result = await request("/api/visits", { method: "POST", body: JSON.stringify({ date: selectedDate, checks }) });
      } else {
        const checks = Object.fromEntries(state.rows.filter((row) => !groupFilter || row.group === groupFilter).map((row) => [row.recordKey, row.called === true]));
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

  async function saveAttendance(checksToSave = attendanceChecks, refresh = true) {
    setBusy(true); setError(""); setNotice("");
    try { await request("/api/attendance", { method: "POST", body: JSON.stringify({ type: attendanceType, date: attendanceDate, checks: checksToSave }) }); setNotice("تم حفظ الحضور"); if (refresh) { await load("attendance", attendanceDate); await load("home", dashboardDate, password, trendMonth); } }
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

  if (publicQrToken) return <PublicAttendancePage token={publicQrToken} />;
  if (!isAdminPage) return <PublicParentHome />;
  if (!password || !username) return <main className="login-screen"><form className="login-panel" onSubmit={login}><div className="login-brand"><img src="/saint-abanoub.png" alt="القديس أبانوب" /></div><p className="eyebrow">خورس القديس أبانوب</p><h1>إدارة خورس القديس أبانوب</h1><label htmlFor="app-username">اسم المستخدم</label><input id="app-username" type="text" autoComplete="username" value={usernameDraft} onChange={(event) => setUsernameDraft(event.target.value)} required autoFocus placeholder="admin" /><label htmlFor="app-password">كلمة المرور</label><input id="app-password" type="password" autoComplete="current-password" value={passwordDraft} onChange={(event) => setPasswordDraft(event.target.value)} required /><button className="primary-button" disabled={busy}>{busy ? <LoaderCircle size={17} className="spin" /> : null} دخول</button>{error && <p className="login-error">{error}</p>}<a className="login-back-link" href="/">العودة إلى بحث الأهالي</a></form></main>;

  const navItem = (nextMode, icon, label) => <button className={`sidebar-item ${mode === nextMode ? "active" : ""}`} onClick={() => switchMode(nextMode)}>{icon}<span>{label}</span></button>;
  return <main className={`app-shell mode-${mode} ${darkMode ? "dark-mode" : ""}`}>
    <aside className="app-sidebar"><div className="sidebar-brand"><img src="/saint-abanoub.png" alt="القديس أبانوب" /><div><strong>خورس القديس أبانوب</strong><span>إدارة الخدمة</span></div></div><p className="sidebar-label">أقسام لوحة الإدارة</p><nav className="sidebar-nav">{navItem("home", <LayoutDashboard size={17} />, "نظرة عامة")}{navItem("attendance", <UserCheck size={17} />, "الحضور والغياب")}{navItem("visit", <Home size={17} />, "الافتقاد")}{navItem("stray", <img className="sheep-icon" src="/sheep-icon.svg" alt="" />, "الخروف الضال")}{navItem("history", <Users size={17} />, "أفراد الخورس")}{navItem("people", <Pencil size={17} />, "إدارة الخورس")}{navItem("qr", <QrCode size={17} />, "مسح QR")}{navItem("qr-print", <QrCode size={17} />, "طباعة QR")}</nav><div className="sidebar-footer"><div className="sidebar-footer-actions"><button className="theme-toggle" type="button" onClick={() => setDarkMode((value) => !value)}><span>{darkMode ? "الوضع الفاتح" : "الوضع الداكن"}</span>{darkMode ? <Sun size={16} /> : <Moon size={16} />}</button><button className="logout-button" title="تسجيل الخروج" aria-label="تسجيل الخروج" onClick={() => { sessionStorage.removeItem("choir-password"); sessionStorage.removeItem("choir-username"); setPassword(""); setUsername(""); setPasswordDraft(""); setUsernameDraft(""); }}><LogOut size={15} /><span>خروج</span></button></div></div></aside>
    <section className="app-content"><header className="topbar"><div className="brand-lockup"><div><p className="eyebrow">خورس القديس أبانوب</p><h1>إدارة خورس القديس أبانوب</h1></div></div><div className="top-actions">{mode === "reports" && <button className="copy-phone" title="تصدير التقرير" onClick={exportCsv}><Copy size={14} /></button>}<span className="save-state">{loading ? "جاري التحميل" : busy ? "جاري الحفظ" : notice || "جاهز"}</span></div></header>
    {mode === "visit" && state.verse && <section className="verse-band"><p>{state.verse}</p></section>}
    {mode === "visit" || mode === "call" || mode === "reports" || mode === "notes" || mode === "requests" ? <div className="sub-tabs"><button className={mode === "visit" ? "active" : ""} onClick={() => switchMode("visit")}><Home size={15} /> زيارة البيت</button><button className={mode === "call" ? "active" : ""} onClick={() => switchMode("call")}><Phone size={15} /> الاتصال الأسبوعي</button><button className={mode === "reports" ? "active" : ""} onClick={() => switchMode("reports")}><BarChart3 size={15} /> تقارير الافتقاد</button><button className={mode === "notes" ? "active" : ""} onClick={() => switchMode("notes")}><Pencil size={15} /> ملاحظات الافتقاد</button><button className={mode === "requests" ? "active" : ""} onClick={() => switchMode("requests")}><Phone size={15} /> طلبات الأهالي</button></div> : null}

    {followUpMode && <FollowUpDashboard mode={mode} state={state} selectedDate={selectedDate} setSelectedDate={(date) => { setSelectedDate(date); sessionStorage.setItem("choir-selected-date", date); }} rotationStart={rotationStart} setRotationStart={setRotationStart} servantsText={servantsText} setServantsText={setServantsText} busy={busy} saveFollowUp={saveFollowUp} load={load} checkedCount={checkedCount} percent={percent} />}
    {mode === "people" && <PeopleManager state={state} rows={rows} query={query} setQuery={setQuery} busy={busy} editingPerson={editingPerson} personDraft={personDraft} setPersonDraft={setPersonDraft} savePerson={savePerson} editPerson={editPerson} archivePerson={archivePerson} cancelEdit={() => { setEditingPerson(null); setPersonDraft(emptyPerson); }} />}
    {mode === "attendance" && <AttendanceManager state={state} rows={rows} attendanceType={attendanceType} setAttendanceType={(type) => { setAttendanceType(type); load("attendance", attendanceDate, password, trendMonth, type); }} attendanceDate={attendanceDate} setAttendanceDate={(date) => { setAttendanceDate(date); sessionStorage.setItem("choir-attendance-date", date); load("attendance", date); }} checks={attendanceChecks} setChecks={setAttendanceChecks} save={saveAttendance} onComment={async (recordKey, comment) => { await request("/api/attendance-comment", { method: "POST", body: JSON.stringify({ type: attendanceType, date: attendanceDate, recordKey: Number(recordKey), comment }) }, password); setNotice("تم حفظ تعليق الحضور"); }} onDeleteComment={async (recordKey) => { await request(`/api/attendance-comment?type=${attendanceType}&date=${attendanceDate}&recordKey=${Number(recordKey)}`, { method: "DELETE" }, password); setNotice("تم مسح التعليق"); }} busy={busy} query={query} setQuery={setQuery} />}
    {mode === "qr" && <QrScannerPage request={request} person={scanPerson} setPerson={setScanPerson} scanType={scanType} setScanType={setScanType} scanDate={scanDate} setScanDate={setScanDate} save={saveScannedAttendance} busy={busy} />}
    {mode === "qr-print" && <QrCardsPage rows={state.rows} />}
    {mode === "home" && <HomeDashboard dashboard={dashboard} dashboardDate={dashboardDate} setDashboardDate={(date) => { setDashboardDate(date); sessionStorage.setItem("choir-dashboard-date", date); load("home", date); }} trendMonth={trendMonth} setTrendMonth={(month) => { setTrendMonth(month); sessionStorage.setItem("choir-trend-month", month); load("home", dashboardDate, password, month); }} openReport={openReport} />}
    {mode === "stray" && <StraySheepPage people={dashboard.people || []} openReport={openReport} />}
    {(mode === "visit" || mode === "call") && <PeopleTable mode={mode} rows={mode === "visit" ? visitRows : rows} query={query} setQuery={setQuery} busy={busy} saveFollowUp={saveFollowUp} updateCheck={updateCheck} openReport={openReport} loading={loading} includeVisitedThisMonth={includeVisitedThisMonth} setIncludeVisitedThisMonth={setIncludeVisitedThisMonth} />}
    {mode === "reports" && <VisitReportsPage reports={visitReports} exportCsv={exportCsv} month={reportMonth} setMonth={(month) => { setReportMonth(month); load("reports", undefined, password, month); }} />}
    {mode === "notes" && <FollowUpNotesPage notes={followUpNotes} rows={rows} request={request} password={password} reload={() => load("notes")} />}
    {mode === "requests" && <FollowUpRequestsPage requests={followUpRequests} request={request} password={password} reload={() => load("requests")} />}
    {mode === "history" && <MembersDirectoryByRole rows={rows} query={query} setQuery={setQuery} openReport={openReport} loading={loading} />}
    {(error || notice) && <div className={`toast visible ${error ? "error" : ""}`} role="status">{error || notice}</div>}
    {report && <ReportModal report={report} close={() => setReport(null)} />}
    </section></main>;
}

function PublicParentHome() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showScanner, setShowScanner] = useState(false);
  useEffect(() => {
    const search = query.trim();
    if (search.length < 2) { setResults([]); setError(""); return undefined; }
    const timer = window.setTimeout(async () => {
      setLoading(true); setError("");
      try {
        const response = await fetch(`${apiUrl}/api/public/people?query=${encodeURIComponent(search)}`);
        const body = await response.json().catch(() => []);
        if (!response.ok) throw new Error(body.error || "تعذر البحث الآن");
        setResults(body);
      } catch (searchError) { setResults([]); setError(searchError.message); }
      finally { setLoading(false); }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  return <main className="public-parent-home"><div className="public-home-glow" /><header className="public-home-brand"><img src="/saint-abanoub.png" alt="القديس أبانوب" /><div><strong>خورس القديس أبانوب</strong><span>متابعة حضور الأبناء</span></div></header><section className="public-home-content"><img className="public-home-saint" src="/saint-abanoub.png" alt="القديس أبانوب" /><p className="section-kicker">أهلًا بكم</p><h1>تابع حضور ابنك</h1><p className="public-home-copy">اكتب اسم الابن للوصول إلى تقرير حضور الخورس والقداس.</p><div className="public-home-search"><Search size={22} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ابحث باسم الابن" aria-label="البحث باسم الابن" autoComplete="off" /><button type="button" className="public-scan-button" onClick={() => setShowScanner(true)} title="مسح QR" aria-label="مسح QR"><QrCode size={23} /></button></div>{showScanner && <PublicParentScanner onClose={() => setShowScanner(false)} />}{loading && <p className="public-home-status">جاري البحث...</p>}{error && <p className="public-home-error">{error}</p>}{!loading && query.trim().length >= 2 && !results.length && !error && <p className="public-home-status">لا يوجد ابن بهذا الاسم</p>}{results.length > 0 && <div className="public-home-results">{results.map((person) => <a key={person.token} href={`/qr/${person.token}`}><span>{person.name}</span><ChevronLeft size={19} /></a>)}</div>}</section><a className="public-admin-link" href="/admin"><UserCheck size={16} /> دخول الخدام</a></main>;
}

function PublicParentScanner({ onClose }) {
  const [scannerError, setScannerError] = useState("");
  useEffect(() => {
    const scanner = new Html5Qrcode("public-qr-reader");
    let stopped = false;
    const stop = async () => { if (!stopped && scanner.isScanning) { stopped = true; await scanner.stop().catch(() => {}); } };
    scanner.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 230, height: 230 } }, async (decoded) => {
      const value = String(decoded || "").trim();
      const token = value.includes("/qr/") ? value.split("/qr/").pop().split(/[?#]/)[0] : value;
      if (!token) { setScannerError("تعذر قراءة QR"); return; }
      await stop();
      window.location.href = `/qr/${encodeURIComponent(token)}`;
    }, () => {}).catch(() => setScannerError("اسمح للمتصفح باستخدام الكاميرا"));
    return () => { void stop(); };
  }, []);
  return <div className="public-scanner-panel"><div className="public-scanner-heading"><strong>امسح QR الخاص بالابن</strong></div><div id="public-qr-reader" className="public-qr-reader" /><button className="scanner-close-button" type="button" onClick={onClose}><X size={16} /> إغلاق الكاميرا</button>{scannerError && <p className="public-home-error">{scannerError}</p>}</div>;
}

function PublicAttendancePage({ token }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [requestType, setRequestType] = useState("call");
  const [requestMessage, setRequestMessage] = useState("");
  const [requestNotice, setRequestNotice] = useState("");
  const [requestBusy, setRequestBusy] = useState(false);
  useEffect(() => {
    fetch(`${apiUrl}/api/public/qr/${encodeURIComponent(token)}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          const detail = response.status === 404
            ? "مسار تقرير الـQR غير منشور على الخادم حاليًا. بعد نشر تحديث الباك إند سيظهر التقرير تلقائيًا."
            : body.error || `تعذر تحميل التقرير (${response.status})`;
          throw new Error(detail);
        }
        return body;
      })
      .then(setData)
      .catch((loadError) => setError(loadError.message || "تعذر الاتصال بالخادم"));
  }, [token]);
  if (error) return <main className="public-report-page"><PublicBrand /><section className="public-report-error"><h1>تعذر فتح التقرير</h1><p>{error}</p></section></main>;
  if (!data) return <main className="public-report-page"><PublicBrand /><section className="public-report-loading">جاري تحميل تقرير الحضور...</section></main>;
  const choir = data.attendance.filter((item) => item.type === "choir");
  const mass = data.attendance.filter((item) => item.type === "mass");
  publicAttendanceRates = { choir: data.person.choirRate || 0, mass: data.person.massRate || 0 };
  async function sendRequest(event) { event.preventDefault(); setRequestBusy(true); setRequestNotice(""); try { const response = await fetch(`${apiUrl}/api/public/qr/${encodeURIComponent(token)}/followup-request`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: requestType, message: requestMessage }) }); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || "تعذر إرسال الطلب"); setRequestNotice("تم إرسال طلب المتابعة بنجاح"); setRequestMessage(""); } catch (sendError) { setRequestNotice(sendError.message); } finally { setRequestBusy(false); } }
  return <main className="public-report-page"><PublicBrand /><section className="public-student-heading"><div><p className="section-kicker">تقرير حضور المخدوم</p><h1>{data.person.name}</h1></div><a className="public-call-button" href="tel:+201206465486" aria-label="الاتصال بخادم الخورس"><Phone size={18} /> اتصل بخادم الخورس</a></section><section className="public-attendance-summary"><PublicMetric label="حضور الخورس" value={choir.length} /><PublicMetric label="حضور القداس" value={mass.length} /><PublicMetric label="إجمالي الحضور" value={data.attendance.length} /></section><section className="public-monthly-report"><div className="public-section-heading"><div><p className="section-kicker">ملخص المتابعة</p><h2>الحضور حسب الشهر</h2></div><span>من بداية التسجيل</span></div><div className="public-month-list">{data.monthly.map((month) => <article key={month.month}><strong>{month.month}</strong><span>خورس <b>{month.choir}</b><small>{month.choirRate}%</small></span><span>قداس <b>{month.mass}</b><small>{month.massRate}%</small></span></article>)}{!data.monthly.length && <p className="empty-row">لا توجد تسجيلات حضور حتى الآن</p>}</div></section><section className="public-followup-request"><div className="public-section-heading"><div><p className="section-kicker">مساعدة ومتابعة</p><h2>اطلب متابعة من الخادم</h2></div></div><form onSubmit={sendRequest}><select value={requestType} onChange={(event) => setRequestType(event.target.value)}><option value="call">طلب اتصال</option><option value="visit">طلب زيارة</option></select><textarea rows="3" value={requestMessage} onChange={(event) => setRequestMessage(event.target.value)} placeholder="اكتب رسالة اختيارية" /><button className="public-call-button" disabled={requestBusy}>{requestBusy ? "جاري الإرسال" : "إرسال طلب المتابعة"}</button>{requestNotice && <p>{requestNotice}</p>}</form></section><section className="public-history"><div className="public-section-heading"><div><p className="section-kicker">السجل التفصيلي</p><h2>مواعيد الحضور</h2></div><span>التاريخ والساعة</span></div><div className="public-history-list">{data.attendance.map((item) => <article key={`${item.type}-${item.date}-${item.recordedAt}`}><span className={`public-type ${item.type}`}>{item.type === "choir" ? "خورس" : "قداس"}</span><div><strong>{dateLabel(item.date)}</strong><small>{publicTimeLabel(item.recordedAt)}</small></div></article>)}{!data.attendance.length && <p className="empty-row">لا توجد تسجيلات حضور حتى الآن</p>}</div></section></main>;
}

function PublicBrand() { return <header className="public-brand"><img src="/app-icon.png" alt="القديس أبانوب" /><div><strong>خورس القديس أبانوب</strong><span>تقرير حضور الخورس والقداس</span></div></header>; }
function PublicMetric({ label, value }) { const rate = label === "حضور الخورس" ? publicAttendanceRates.choir : label === "حضور القداس" ? publicAttendanceRates.mass : null; return <article><span>{label}</span><strong>{value}</strong>{rate !== null && <small className="public-rate">{rate}% من الجمعات</small>}</article>; }
function publicTimeLabel(value) { const [stamp, comment = ""] = String(value || "").split("|"); const [date, time] = stamp.split("T"); if (!time) return comment ? <span className="public-attendance-comment">ملاحظة: {comment}</span> : "—"; const [year, month, day] = date.split("-").map(Number); const [hour, minute] = time.split(":").map(Number); const formatted = new Intl.DateTimeFormat("ar-EG", { hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(year, month - 1, day, hour, minute)); return comment ? <><span>{formatted}</span><em className="public-attendance-comment">ملاحظة: {comment}</em></> : formatted; }

function StraySheepPage({ people, openReport }) {
  const rows = people.filter((person) => person.role !== "servant").map((person) => {
    const attendance = (person.choirCount || 0) + (person.massCount || 0);
    const followUp = (person.visitCount || 0) + (person.callCount || 0);
    const activity = attendance * 2 + followUp;
    return { ...person, attendance, followUp, activity, need: Math.max(0, 100 - Math.min(100, activity * 10)) };
  }).sort((a, b) => a.activity - b.activity || a.attendance - b.attendance || a.name.localeCompare(b.name, "ar"));
  return <section className="stray-page"><section className="stray-hero"><div><p className="section-kicker">متابعة الرعاية</p><h2>الخروف الضال</h2><p>الأسماء الأكثر احتياجًا للمتابعة حسب الحضور والافتقاد.</p></div><img className="sheep-hero-icon" src="/sheep-icon.svg" alt="خروف" /></section><section className="stray-note"><strong>طريقة الترتيب</strong><span>الأعلى في القائمة هو الأقل حضورًا في الخورس والقداس، والأقل افتقادًا بالزيارة والاتصال.</span></section><section className="table-section stray-table"><div className="section-title-row table-title-row"><div><p className="section-kicker">أولوية المتابعة</p><h2>{rows.length} مخدوم</h2></div><span className="date-label">من الأكثر احتياجًا إلى الأقل</span></div><div className="stray-list">{rows.map((row, index) => <button className={`stray-person group-tone-${groupTone(row.group)}`} key={row.id} onClick={() => openReport(row)}><span className="stray-rank">{index + 1}</span><span className="stray-person-info"><strong>{row.name}</strong><small>{row.phone1 || "بدون رقم"}</small></span><span className="stray-stats"><b>{row.need}%</b><small>احتياج متابعة</small></span><span className="stray-counts"><span>خورس {row.choirCount || 0}</span><span>قداس {row.massCount || 0}</span><span>زيارة {row.visitCount || 0}</span><span>اتصال {row.callCount || 0}</span></span></button>)}</div>{!rows.length && <p className="empty-row">لا توجد بيانات مخدومين</p>}</section></section>;
}

function FollowUpNotesPage({ notes, rows, request, password, reload }) {
  const [personId, setPersonId] = useState("");
  const [servant, setServant] = useState("");
  const [type, setType] = useState("visit");
  const [date, setDate] = useState(today());
  const [note, setNote] = useState("");
  const save = async (event) => { event.preventDefault(); await request("/api/followup-notes", { method: "POST", body: JSON.stringify({ personId: Number(personId), servant, type, date, note }) }, password); setNote(""); await reload(); };
  return <section className="visit-reports-page"><section className="reports-hero"><div><p className="section-kicker">ملاحظات الافتقاد</p><h2>سجل ملاحظات الخدام</h2><p>اكتب ملاحظة لباقي الخدام مرتبطة بولد وتاريخ واضح.</p></div></section><form className="panel followup-note-form" onSubmit={save}><label>الولد<select required value={personId} onChange={(event) => setPersonId(event.target.value)}><option value="">اختر الاسم</option>{rows.filter((row) => row.role !== "servant").map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><label>اسم الخادم<input required value={servant} onChange={(event) => setServant(event.target.value)} /></label><label>النوع<select value={type} onChange={(event) => setType(event.target.value)}><option value="visit">زيارة</option><option value="call">اتصال</option></select></label><label>التاريخ<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label><label className="form-wide">الملاحظة<textarea required rows="3" value={note} onChange={(event) => setNote(event.target.value)} /></label><button className="primary-button" type="submit">حفظ الملاحظة</button></form><section className="table-section"><div className="table-wrap"><table><thead><tr><th>التاريخ</th><th>الولد</th><th>الخادم</th><th>النوع</th><th>الملاحظة</th><th>إجراء</th></tr></thead><tbody>{notes.map((item) => <tr key={item.id}><td>{dateLabel(item.date)}</td><td className="name-cell">{item.name}</td><td>{item.servant}</td><td>{item.type === "visit" ? "زيارة" : "اتصال"}</td><td>{item.note}</td><td><button className="cancel-button" type="button" onClick={async () => { await request(`/api/followup-notes/${item.id}`, { method: "DELETE" }, password); await reload(); }}>حذف</button></td></tr>)}{!notes.length && <tr><td colSpan="6">لا توجد ملاحظات حتى الآن</td></tr>}</tbody></table></div></section></section>;
}

function FollowUpRequestsPage({ requests, request, password, reload }) {
  const statusLabel = { new: "جديد", in_progress: "قيد المتابعة", done: "تم التنفيذ" };
  return <section className="visit-reports-page"><section className="reports-hero"><div><p className="section-kicker">طلبات الأهالي</p><h2>طلبات المتابعة</h2><p>راجع طلبات الاتصال والزيارة وحدث حالتها.</p></div></section><section className="table-section"><div className="table-wrap"><table><thead><tr><th>التاريخ</th><th>الولد</th><th>النوع</th><th>الرسالة</th><th>الحالة</th></tr></thead><tbody>{requests.map((item) => <tr key={item.id}><td>{dateLabel(item.createdAt.slice(0, 10))}</td><td className="name-cell">{item.name}</td><td>{item.type === "call" ? "اتصال" : "زيارة"}</td><td>{item.message || "بدون رسالة"}</td><td><select value={item.status} onChange={async (event) => { await request(`/api/followup-requests/${item.id}`, { method: "PATCH", body: JSON.stringify({ status: event.target.value }) }, password); await reload(); }}>{Object.entries(statusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td></tr>)}{!requests.length && <tr><td colSpan="5">لا توجد طلبات متابعة حتى الآن</td></tr>}</tbody></table></div></section></section>;
}

function VisitReportsPage({ reports, exportCsv, month, setMonth }) {
  const [period, setPeriod] = useState("day");
  const [selectedDetail, setSelectedDetail] = useState(null);
  useEffect(() => {
    if (!selectedDetail) return undefined;
    const dismiss = (event) => { if (!event.target.closest(".report-bar-column")) setSelectedDetail(null); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [selectedDetail]);
  const totalPeople = reports.totalPeople || 0;
  const chart = (title, icon, daily, monthly, yearly, empty) => {
    const data = period === "day" ? (daily || []) : period === "month" ? (monthly || []) : (yearly || []);
    const max = Math.max(1, ...data.map((item) => item.count || 0));
    const detailSources = title === "الزيارات" ? { day: reports.visitDetails || {}, month: reports.visitMonthlyDetails || {}, year: reports.visitYearlyDetails || {} } : { day: reports.callDetails || {}, month: reports.callMonthlyDetails || {}, year: reports.callYearlyDetails || {} };
    const detailsMap = detailSources[period];
    return <section className="table-section report-chart-card"><div className="section-title-row table-title-row"><div><p className="section-kicker">{icon} {title}</p><h2>{period === "day" ? `أيام شهر ${reports.month}` : period === "month" ? `شهور سنة ${reports.year}` : "السنوات"}</h2></div><span className="date-label">{data.reduce((sum, item) => sum + (item.count || 0), 0)} شخص</span></div><div className="report-bar-chart">{data.map((item) => { const label = period === "day" ? dateLabel(item.date) : period === "month" ? item.month : item.year; const detailKey = period === "day" ? item.date : String(label); const details = detailsMap[detailKey] || []; const selected = selectedDetail?.title === title && selectedDetail.key === detailKey; return <div className={`report-bar-column ${selected ? "selected" : ""}`} key={String(label)} onClick={(event) => { event.stopPropagation(); setSelectedDetail(selected ? null : { title, key: detailKey, label, details }); }}><strong>{item.count}</strong><i style={{ height: `${Math.max(8, (item.count || 0) * 100 / max)}%` }} /><span>{label}</span>{selected && <div className="report-detail-popover"><b>{title} {label}</b>{details.length ? <ul>{details.map((detail) => <li key={`${detailKey}-${detail.recordKey}`}>{detail.name}{title === "الاتصالات" && <small> بواسطة {detail.servant || "غير مسجل"}</small>}</li>)}</ul> : <small>لا توجد أسماء مسجلة في هذه الفترة</small>}</div>}</div>; })}{!data.length && <p className="empty-row">{empty}</p>}</div></section>;
  };
  return <section className="visit-reports-page"><section className="reports-hero"><div><p className="section-kicker">تقارير الافتقاد</p><h2>الزيارات والاتصالات</h2><p>اختار الفترة وشوف التقدم في جراف واضح.</p></div><div className="reports-hero-actions"><label className="report-month-picker">الشهر<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label><div className="report-period-switch"><button className={period === "day" ? "active" : ""} onClick={() => setPeriod("day")}>يومي</button><button className={period === "month" ? "active" : ""} onClick={() => setPeriod("month")}>شهري</button><button className={period === "year" ? "active" : ""} onClick={() => setPeriod("year")}>سنوي</button></div><button className="secondary-button" onClick={exportCsv}><Copy size={15} /> تصدير</button><BarChart3 size={30} /></div></section>{chart("الزيارات", "زيارة", reports.daily, reports.monthly, reports.yearly, "لا توجد زيارات في الفترة المختارة")}{chart("الاتصالات", "اتصال", reports.callDaily, reports.callMonthly, reports.callYearly, "لا توجد اتصالات في الفترة المختارة")}</section>;
}

function phoneHref(value) { const digits = String(value || "").replace(/\D/g, ""); if (!digits) return ""; if (digits.startsWith("20")) return `+${digits}`; if (digits.startsWith("0")) return `+20${digits.slice(1)}`; return `+20${digits}`; }
function CopyPhone({ value, name }) {
  if (!value) return <span>—</span>;
  const secondary = phoneDirectory[name]?.phone2 || "";
  const numbers = [[value, "رقم 1"], [secondary, "رقم 2"]].filter(([number]) => number);
  return <span className="phone-copy-cell phone-actions">{numbers.map(([number, label]) => <a className="call-phone" key={label} href={`tel:${phoneHref(number)}`} title={`${label} - الاتصال بـ ${name}`} aria-label={`${label} - الاتصال بـ ${name}`}><Phone size={13} /> {label}</a>)}</span>;
}

function HomeDashboard({ dashboard, dashboardDate, setDashboardDate, trendMonth, setTrendMonth, openReport }) {
  const [selectedMetric, setSelectedMetric] = useState(null);
  const daily = dashboard.dailySummary || { total: 0, choirPresent: 0, massPresent: 0 };
  const dailyPeople = (dashboard.dailyPeople || []).filter((person) => person.role !== "servant");
  dashboardHistoryPeople = (dashboard.people || []).filter((person) => person.role !== "servant");
  const choirAbsent = Math.max(0, daily.total - daily.choirPresent);
  const massAbsent = Math.max(0, daily.total - daily.massPresent);
  const attendancePercent = daily.total ? Math.round(((daily.choirPresent + daily.massPresent) / (daily.total * 2)) * 100) : 0;
  const metrics = [
    { label: "إجمالي الخورس", value: daily.total, people: dailyPeople },
    { label: "حضور الخورس", value: daily.choirPresent, detail: `${daily.total ? Math.round(daily.choirPresent * 100 / daily.total) : 0}%`, tone: "teal", people: dailyPeople.filter((person) => person.choirPresent) },
    { label: "غياب الخورس", value: choirAbsent, detail: `${daily.total ? Math.round(choirAbsent * 100 / daily.total) : 0}%`, tone: "amber", people: dailyPeople.filter((person) => !person.choirPresent) },
    { label: "حضور القداس", value: daily.massPresent, detail: `${daily.total ? Math.round(daily.massPresent * 100 / daily.total) : 0}%`, tone: "blue", people: dailyPeople.filter((person) => person.massPresent) },
    { label: "غياب القداس", value: massAbsent, detail: `${daily.total ? Math.round(massAbsent * 100 / daily.total) : 0}%`, tone: "red", people: dailyPeople.filter((person) => !person.massPresent) },
    { label: "نسبة الحضور العامة", value: `${attendancePercent}%`, detail: "خورس + قداس", tone: "navy", people: dailyPeople.filter((person) => person.choirPresent || person.massPresent) }
  ];
  return <section className="home-dashboard"><div className="dashboard-hero"><div><p className="section-kicker">لوحة حضور اليوم</p><h2>اجتماع خورس القديس أبانوب</h2><p>اختر التاريخ لمراجعة حضور الخورس والقداس.</p></div><div className="hero-date"><label>التاريخ<input type="date" value={dashboardDate} onChange={(event) => setDashboardDate(event.target.value)} /></label><img src="/saint-abanoub.png" alt="القديس أبانوب" /></div></div><div className="dashboard-metrics">{metrics.map((metric) => <Metric key={metric.label} {...metric} onClick={() => setSelectedMetric(metric)} />)}</div><div className="dashboard-main-grid"><DailyAttendanceChart people={dailyPeople} total={daily.total} /></div><WeeklyTrendChart trend={dashboard.weeklyTrend || []} total={daily.total} month={trendMonth} setMonth={setTrendMonth} /><div className="dashboard-attendance-columns"><DailyList title="الأكثر حضورًا للقداس" people={dailyPeople.filter((person) => person.massPresent)} openReport={openReport} /><DailyList title="الأكثر حضورًا للخورس" people={dailyPeople.filter((person) => person.choirPresent)} openReport={openReport} /><DailyList title="الأقل حضورًا للقداس" people={dailyPeople.filter((person) => !person.massPresent)} openReport={openReport} /><DailyList title="الأقل حضورًا للخورس" people={dailyPeople.filter((person) => !person.choirPresent)} openReport={openReport} /></div>{selectedMetric && <DashboardPeopleModal metric={selectedMetric} close={() => setSelectedMetric(null)} />}</section>;
}

function Metric({ label, value, detail, tone, onClick }) { return <button type="button" className={`dashboard-metric metric-button ${tone || ""}`} onClick={onClick}><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</button>; }
function DashboardPeopleModal({ metric, close }) { return <div className="modal"><button className="modal-backdrop" aria-label="إغلاق القائمة" onClick={close} /><section className="report-dialog dashboard-people-dialog" role="dialog" aria-modal="true"><button className="modal-close" aria-label="إغلاق" onClick={close}><X size={18} /></button><p className="section-kicker">تفاصيل حضور اليوم</p><h2>{metric.label}</h2><div className="report-meta">{metric.people.length} اسم</div><div className="dashboard-people-list">{metric.people.map((person) => <article key={person.id}><strong>{person.name}</strong><span>جروب {person.group || "—"}</span></article>)}{!metric.people.length && <p className="empty-row">لا توجد أسماء في هذه القائمة</p>}</div></section></div>; }
function Coverage({ label, value, total, tone }) { const percent = total ? Math.round(value * 100 / total) : 0; return <div className="coverage-item"><div><span>{label}</span><strong>{value} / {total || 0}</strong></div><div className="coverage-track"><span className={`coverage-fill ${tone}`} style={{ width: `${percent}%` }} /></div></div>; }
function AttendanceList({ title, people, openReport, metric }) { return <section className="table-section attendance-list-panel"><div className="section-title-row table-title-row"><h2>{title}</h2><span className="date-label">حسب عدد المرات</span></div><div className="absent-list">{people.slice(0, 8).map((person) => <button className="absent-person" key={person.id} onClick={() => openReport({ id: person.id, name: person.name, group: person.group, phone1: "" })}><span className="absent-avatar">{person.name.slice(0, 1)}</span><span><strong>{person.name}</strong><small>{person.role === "servant" ? "خادم" : "مخدوم"}</small></span><b className="attendance-count">{person[metric]}</b></button>)}</div></section>; }
function DailyList({ title, people, openReport }) { const isChoir = title.includes("للخورس"); const isLowest = title.includes("الأقل"); const metric = isChoir ? "choirCount" : "massCount"; const source = dashboardHistoryPeople.length ? dashboardHistoryPeople : people; const ranked = [...source].sort((a, b) => (isLowest ? 1 : -1) * ((a[metric] || 0) - (b[metric] || 0)) || a.name.localeCompare(b.name, "ar")); return <section className="table-section attendance-list-panel"><div className="section-title-row table-title-row"><h2>{title}</h2><span className="date-label">من بداية التسجيل</span></div><div className="absent-list">{ranked.slice(0, 5).map((person) => <button className="absent-person" key={person.id} onClick={() => openReport({ id: person.id, name: person.name, group: person.group, phone1: "" })}><span className="absent-avatar">{person.name.slice(0, 1)}</span><span><strong>{person.name}</strong><small>{person.role === "servant" ? "خادم" : "مخدوم"}</small></span><b className="attendance-count">{person[metric] || 0} مرة</b></button>)}</div></section>; }
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
  const [scope, setScope] = useState("both");
  const countFor = (item) => scope === "choir" ? item.choir : scope === "mass" ? item.mass : item.choir + item.mass;
  const observed = trend.filter((item) => countFor(item) > 0);
  const values = trend.map(countFor);
  const latest = observed.at(-1);
  const reference = observed.at(-2);
  const latestCount = latest ? countFor(latest) : 0;
  const referenceCount = reference ? countFor(reference) : 0;
  const change = !reference ? 0 : referenceCount === 0 ? (latestCount > 0 ? 100 : 0) : Math.round(((latestCount - referenceCount) / referenceCount) * 100);
  const max = Math.max(...values, 1);
  const scopeLabel = scope === "choir" ? "حضور الخورس" : scope === "mass" ? "حضور القداس" : "إجمالي الحضور في الخورس والقداس";
  return <section className="weekly-trend"><div className="trend-heading"><div><p className="section-kicker">اتجاه الحضور</p><h2>جمعات الشهر المختار</h2><span>{reference ? `مقارنة بجمعة ${dateLabel(reference.date)}` : "أول جمعة مسجلة هي نقطة البداية"}</span></div><div className="trend-controls"><label>الشهر<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label><div className="trend-scope-switch"><button type="button" className={scope === "both" ? "active" : ""} onClick={() => setScope("both")}>الإجمالي</button><button type="button" className={scope === "choir" ? "active" : ""} onClick={() => setScope("choir")}>خورس</button><button type="button" className={scope === "mass" ? "active" : ""} onClick={() => setScope("mass")}>قداس</button></div><span className={`trend-change ${change >= 0 ? "up" : "down"}`}>{reference ? `${change >= 0 ? "+" : ""}${change}%` : "0%"}</span></div></div><div className="trend-chart">{trend.map((item, index) => { const count = countFor(item); const previousObserved = observed.filter((entry) => entry.date < item.date).at(-1); const previous = previousObserved ? countFor(previousObserved) : count; const tone = !count ? "empty" : !previousObserved || count >= previous ? "positive" : "negative"; return <div className="trend-column" key={item.date}><div className="trend-value">{count}</div><div className="trend-bar-wrap"><i className={`trend-bar ${tone}`} style={{ height: `${count ? Math.max(7, count * 100 / max) : 0}%` }} /></div><small>{new Intl.DateTimeFormat("ar-EG", { day: "numeric", month: "short" }).format(new Date(`${item.date}T12:00:00`))}</small></div>; })}</div><div className="trend-legend"><span><i /> {scopeLabel}</span><span>الأعلى: {Math.max(...values, 0)} · الأحدث: {latestCount}</span></div></section>;
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
  const jumpToCallGroup = (groupNumber) => document.getElementById(`call-group-${groupNumber}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  return <><section className="control-grid">
    {mode === "call" && <article className="panel servants-panel"><div className="panel-heading"><div><p className="section-kicker">قائمة التوزيع</p><h2>مسؤولو الاتصال</h2></div><span className="count-badge">{servantsText.split(/\r?\n/).filter((name) => name.trim()).length}</span></div><textarea rows="5" placeholder="اكتب اسم كل خادم في سطر" value={servantsText} onChange={(event) => setServantsText(event.target.value)} /><div className="field-hint">كل سطر خادم واحد. التوزيع يتناوب أسبوعيًا على الجروبات.</div></article>}
    <article className="panel settings-panel"><div className="panel-heading"><div><p className="section-kicker">{mode === "visit" ? "التاريخ" : "دورة التوزيع"}</p><h2>{mode === "visit" ? "تاريخ الزيارة" : state.distributionNotStarted ? "أول أسبوع قادم" : "الأسبوع الحالي"}</h2></div><span className="week-mark"><CalendarDays size={17} /></span></div>{mode === "visit" ? <><label htmlFor="period-date">تاريخ تسجيل الزيارة</label><input id="period-date" type="date" value={selectedDate} onChange={(event) => { setSelectedDate(event.target.value); load(mode, event.target.value); }} /><div className="period-range">{dateLabel(selectedDate)}</div><label htmlFor="visit-month">شهر متابعة الافتقاد</label><input id="visit-month" type="month" value={selectedDate.slice(0, 7)} onChange={(event) => { const date = `${event.target.value}-01`; setSelectedDate(date); load(mode, date); }} /></> : <><div className="period-range">من {dateLabel(state.selectedWeek)} إلى {dateLabel(state.weekEnd)}<br />{state.distributionNotStarted ? "لم يبدأ التوزيع بعد." : "يتغير تلقائيًا كل 7 أيام."}</div><label htmlFor="rotation-date">بداية أول أسبوع للتوزيع</label><input id="rotation-date" type="date" value={rotationStart} onChange={(event) => setRotationStart(event.target.value)} /><div className="field-hint">اضبطه مرة واحدة. التطبيق يحدد أسبوع اليوم والمسؤولين تلقائيًا.</div><button className="primary-button" disabled={busy} onClick={() => saveFollowUp(true)}>↻ حفظ بداية التوزيع</button></>}</article>
    <article className="panel overview-panel"><div className="panel-heading"><div><p className="section-kicker">ملخص الشهر</p><h2>حالة الافتقاد</h2></div></div><div className="metrics"><div className="metric"><strong>{state.groups.length}</strong><span>جروب</span></div><div className="metric"><strong>{monthTotal}</strong><span>مخدوم</span></div><div className="metric"><strong>{mode === "visit" ? monthVisited : checkedCount}</strong><span>{mode === "visit" ? "تمت زيارتهم هذا الشهر" : "تم الاتصال بهم"}</span></div></div><div className="progress-track"><div className="progress-fill" style={{ width: `${mode === "visit" ? monthPercent : percent}%` }} /></div><div className="progress-label">{mode === "visit" ? `${monthVisited} من ${monthTotal} · متبقي ${Math.max(0, monthTotal - monthVisited)}` : `${checkedCount} من ${state.rows.length} · متبقي ${state.rows.length - checkedCount}`}</div><div className="rotation-label">{mode === "visit" ? "إجمالي الزيارات المسجلة خلال الشهر المختار" : "مسؤول اتصال واحد لكل جروب خلال الأسبوع"}</div></article>
  </section>{mode === "call" && <section className="group-strip"><div className="section-title-row"><div><p className="section-kicker">المتابعة الحالية</p><h2>مسؤولو الاتصال الأسبوعي</h2></div><span className="date-label">{dateLabel(state.selectedWeek)}</span></div><div className="group-cards">{state.groups.map((group) => { const members = state.rows.filter((row) => row.group === group.number); const checked = members.filter((row) => row.called).length; return <article className={`group-card ${group.servant ? "has-servant" : ""}`} key={group.number} role="button" tabIndex="0" onClick={() => jumpToCallGroup(group.number)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); jumpToCallGroup(group.number); } }}><div className={`group-number tone-${groupTone(group.number)}`}>{group.number}</div><div className="group-info"><span>جروب</span><strong>{group.servant || "لم يُحدد"}</strong><small>{group.members} أفراد · اتصالات {checked}</small></div></article>; })}</div></section>}</>;
}

function PeopleManager({ state, rows, query, setQuery, busy, editingPerson, personDraft, setPersonDraft, savePerson, editPerson, archivePerson, cancelEdit }) {
  const [scope, setScope] = useState("boy");
  const field = (key) => (event) => setPersonDraft({ ...personDraft, [key]: event.target.value });
  const scopedRows = rows.filter((person) => (person.role || "boy") === scope);
  return <section className="people-layout"><article className="panel person-form-panel"><div className="panel-heading"><div><p className="section-kicker">قاعدة بيانات الخورس</p><h2>{editingPerson ? "تعديل بيانات الاسم" : "إضافة ولد أو خادم"}</h2></div><Plus size={19} /></div><form className="person-form" onSubmit={savePerson}><label>الاسم<input value={personDraft.name} onChange={field("name")} required /></label><label>النوع<select value={personDraft.role || "boy"} onChange={field("role")}><option value="boy">ولد</option><option value="servant">خادم</option></select></label><label>رقم الهاتف الأول<input dir="ltr" value={personDraft.phone1} onChange={field("phone1")} /></label><label>رقم الهاتف الثاني<input dir="ltr" value={personDraft.phone2} onChange={field("phone2")} /></label><label className="form-wide">العنوان<input value={personDraft.address} onChange={field("address")} /></label><label className="form-wide">ملاحظات<textarea rows="3" value={personDraft.note} onChange={field("note")} /></label><div className="form-actions"><button className="primary-button" disabled={busy}>{editingPerson ? "حفظ التعديل" : "إضافة الاسم"}</button>{editingPerson && <button type="button" className="cancel-button" onClick={cancelEdit}>إلغاء</button>}</div></form></article><article className="table-section people-table"><div className="section-title-row table-title-row"><div><p className="section-kicker">السجل الحالي</p><div className="segmented-control"><button className={scope === "boy" ? "active" : ""} onClick={() => setScope("boy")}>المخدومين</button><button className={scope === "servant" ? "active" : ""} onClick={() => setScope("servant")}>الخدام</button></div><h2>{scopedRows.length} اسم مسجل</h2></div><label className="search-box"><Search size={17} /><input type="search" placeholder="ابحث بالاسم أو الرقم أو العنوان" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div><div className="table-wrap"><table><thead><tr><th>الاسم</th><th>الجروب</th><th>رقم 1</th><th>رقم 2</th><th>العنوان</th><th>إجراء</th></tr></thead><tbody>{scopedRows.map((person) => <tr className={`group-tone-${groupTone(person.group)}`} key={person.id}><td className="name-cell">{person.name}</td><td><span className="group-pill">{person.group || "—"}</span></td><td dir="ltr">{person.phone1 || "—"}</td><td dir="ltr">{person.phone2 || "—"}</td><td className="address-cell">{person.address || "—"}</td><td className="people-actions"><button className="row-action edit" title="تعديل" onClick={() => editPerson(person)}><Pencil size={15} /></button><button className="row-action delete" title="حذف من المتابعة" onClick={() => archivePerson(person)} disabled={busy}><Trash2 size={15} /></button></td></tr>)}</tbody></table>{!scopedRows.length && <p className="empty-row">لا توجد نتائج</p>}</div></article></section>;
}

function QrCard({ person, onPrint, printTarget }) {
  const [src, setSrc] = useState("");
  useEffect(() => { QRCode.toDataURL(`${window.location.origin}/qr/${person.qrToken}`, { margin: 1, width: 180, errorCorrectionLevel: "M" }).then(setSrc); }, [person.qrToken]);
  return <article className={`qr-print-card ${printTarget === person.id ? "print-target" : ""}`}><button type="button" className="qr-card-preview" onClick={() => onPrint(person.id)} title={`طباعة QR الخاص بـ ${person.name}`}><div>{src ? <img src={src} alt={`QR ${person.name}`} /> : <span className="qr-loading">جاري إنشاء QR</span>}</div><strong>{person.name}</strong></button><button type="button" className="secondary-button qr-single-print" onClick={() => onPrint(person.id)}>طباعة هذا الكود</button></article>;
}
function QrCardsPage({ rows }) {
  const people = rows.filter((row) => row.role === "boy");
  const [query, setQuery] = useState("");
  const filteredPeople = people.filter((person) => normalizeArabic(`${person.name} ${person.phone1 || ""} ${person.phone2 || ""}`).toLocaleLowerCase("ar").includes(normalizeArabic(query).toLocaleLowerCase("ar")));
  const [printTarget, setPrintTarget] = useState(null);
  const printCards = (target = null) => { setPrintTarget(target); window.setTimeout(() => { window.print(); setPrintTarget(null); }, 80); };
  return <section className="qr-page"><div className="section-title-row table-title-row"><div><p className="section-kicker">بطاقات الحضور</p><h2>QR لكل مخدوم</h2><span className="date-label">اطبع الكل أو اختار كارت واحد واحفظه PDF</span></div><div className="qr-page-actions"><label className="search-box qr-search"><Search size={17} /><input type="search" placeholder="ابحث بالاسم أو الرقم" value={query} onChange={(event) => setQuery(event.target.value)} /></label><button className="primary-button qr-print-button" onClick={() => printCards()}><Copy size={15} /> طباعة الكل / PDF</button></div></div><div className="qr-print-grid">{filteredPeople.map((person) => <QrCard person={person} printTarget={printTarget} onPrint={printCards} key={person.id} />)}{!filteredPeople.length && <p className="empty-row">لا يوجد شخص بهذا البحث</p>}</div></section>;
}
function QrScannerPage({ request, person, setPerson, scanType, setScanType, scanDate, setScanDate, save, busy }) {
  const [scannerError, setScannerError] = useState("");
  useEffect(() => { if (person) return undefined; const scanner = new Html5Qrcode("qr-reader"); const stopScanner = () => scanner.isScanning ? scanner.stop().catch(() => {}) : Promise.resolve(); scanner.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 230, height: 230 } }, async (decoded) => { try { await stopScanner(); const value = String(decoded || "").trim(); const token = value.includes("/qr/") ? value.split("/qr/").pop().split(/[?#]/)[0] : value; if (!token) throw new Error("تعذر قراءة QR"); const result = await request(`/api/qr/${encodeURIComponent(token)}`); setPerson(result?.person || result); } catch (error) { setScannerError(error?.message || "تعذر قراءة QR"); } }, () => {}).catch((error) => setScannerError(error?.message || "اسمح للمتصفح باستخدام الكاميرا")); return () => { void stopScanner(); }; }, [person, request, setPerson]);
  return <section className="qr-scan-page"><div className="qr-scan-panel"><p className="section-kicker">تسجيل حضور سريع</p><h2>امسح QR الخاص بالمخدوم</h2><label className="qr-scan-date">تاريخ الحضور<input type="date" value={scanDate} onChange={(event) => setScanDate(event.target.value)} /></label><div id="qr-reader" className="qr-reader" />{scannerError && <p className="login-error">{scannerError}</p>}{person && <div className="scanned-person"><strong>{person?.name || "مخدوم غير معروف"}</strong><small>{person?.phone1 || "بدون رقم"}</small><div className="segmented-control"><button className={scanType === "choir" ? "active" : ""} onClick={() => setScanType("choir")}>خورس</button><button className={scanType === "mass" ? "active" : ""} onClick={() => setScanType("mass")}>قداس</button><button className={scanType === "both" ? "active" : ""} onClick={() => setScanType("both")}>الاتنين</button></div><button className="primary-button" disabled={busy} onClick={save}>تأكيد تسجيل الحضور</button></div>}</div></section>;
}

function AttendanceManager({ state, rows, attendanceType, setAttendanceType, attendanceDate, setAttendanceDate, checks, setChecks, save, onComment, onDeleteComment, busy, query, setQuery }) {
  attendanceChecksForComments = checks;
  const [commentKey, setCommentKey] = useState("");
  const [commentText, setCommentText] = useState("");
  const checked = rows.filter((row) => checks[String(row.recordKey)]).length;
  const sortedRows = [...rows].sort((a, b) => normalizeArabic(a.name).localeCompare(normalizeArabic(b.name), "ar"));
  const visibleQuery = normalizeArabic(query).trim().toLocaleLowerCase("ar");
  const visibleRows = sortedRows.filter((row) => normalizeArabic([row.name, row.phone1, row.phone2].filter(Boolean).join(" ")).toLocaleLowerCase("ar").includes(visibleQuery));
  const toggle = (recordKey) => {
    const nextChecks = { ...checks, [recordKey]: !checks[recordKey] };
    setChecks(nextChecks);
    save(nextChecks, false);
  };
  return <section className="attendance-page"><AttendanceCommentPanel rows={sortedRows} date={attendanceDate} type={attendanceType} save={onComment} remove={onDeleteComment} busy={busy} /><div className="attendance-controls"><label className="search-box attendance-search"><Search size={17} /><input type="search" placeholder="ابحث بالاسم" value={query} onChange={(event) => setQuery(event.target.value)} /></label><div className="segmented-control"><button className={attendanceType === "choir" ? "active" : ""} onClick={() => setAttendanceType("choir")}><Church size={16} /> حضور الخورس</button><button className={attendanceType === "mass" ? "active" : ""} onClick={() => setAttendanceType("mass")}><UserCheck size={16} /> حضور القداس</button></div><label>تاريخ الحضور<input type="date" value={attendanceDate} onChange={(event) => setAttendanceDate(event.target.value)} /></label><button className="primary-button attendance-save" disabled={busy} onClick={() => save()}><Check size={16} /> حفظ حضور اليوم</button></div><section className="table-section"><div className="section-title-row table-title-row"><div><p className="section-kicker">خورس واحد</p><h2>{attendanceType === "choir" ? "حضور الخورس" : "حضور القداس"}</h2></div><span className="count-badge">{checked} من {rows.length}</span></div><div className="attendance-grid">{visibleRows.map((row, index) => <Fragment key={row.id}>{(() => { const letter = normalizeArabic(row.name).trim().slice(0, 1); const previousLetter = normalizeArabic(visibleRows[index - 1]?.name?.trim() || "").slice(0, 1); const key = String(row.recordKey); return <>{letter !== previousLetter && <div className="attendance-letter">{letter}</div>}<button className={`attendance-person ${checks[key] ? "present" : ""}`} key={row.id} onClick={() => toggle(key)}><span className="attendance-check">{checks[key] ? <Check size={18} /> : null}</span><span className="attendance-name">{row.name}</span><span className="attendance-meta">{row.role === "servant" ? "خادم" : "مخدوم"}</span></button></>})()}</Fragment>)}</div></section></section>;
}

function AttendanceCommentPanel({ rows, date, type, save, remove, busy }) {
  const presentRows = rows.filter((row) => attendanceChecksForComments[String(row.recordKey)]);
  const [personKey, setPersonKey] = useState("");
  const [text, setText] = useState("");
  return <section className="attendance-comment-panel"><div><p className="section-kicker">تعليق على الحضور</p><strong>أضف تعليقًا لولد في هذا اليوم</strong><small>{dateLabel(date)} · {type === "choir" ? "حضور الخورس" : "حضور القداس"}</small></div><select value={personKey} onChange={(event) => setPersonKey(event.target.value)}><option value="">اختر اسم الولد</option>{presentRows.map((row) => <option key={row.recordKey} value={row.recordKey}>{row.name}</option>)}</select><textarea rows="2" value={text} onChange={(event) => setText(event.target.value)} placeholder="اكتب التعليق هنا" /><div className="form-actions"><button type="button" className="primary-button" disabled={!personKey || !text.trim() || busy} onClick={async () => { await save(personKey, text); setText(""); }}>إرسال التعليق</button><button type="button" className="cancel-button" disabled={!personKey || busy} onClick={async () => { await remove(personKey); setText(""); }}>مسح التعليق</button></div></section>;
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
  return <section className="table-section call-groups-section"><div className="section-title-row table-title-row"><div><p className="section-kicker">بيانات الافتقاد</p><h2>الاتصال الأسبوعي حسب الجروب</h2></div><div className="table-actions"><label className="search-box"><Search size={17} /><input type="search" placeholder="ابحث بالاسم أو الجروب أو الخادم" value={query} onChange={(event) => setQuery(event.target.value)} /></label><button className="secondary-button" disabled={busy} onClick={() => saveFollowUp()}><Check size={16} /> احفظ الكل</button></div></div><div className="call-groups-list">{groups.map(([group, members]) => <section className="call-group" id={`call-group-${group}`} key={group}><header className={`call-group-heading group-tone-${group}`}><div><span>الجروب</span><strong>{group}</strong></div><div><span>مسؤول الاتصال</span><b>{members[0]?.servant || "غير موزع"}</b></div><small>{members.length} أفراد · تم الاتصال بـ {members.filter((row) => row.called).length}</small><button type="button" className="group-save-button" disabled={busy} onClick={() => saveFollowUp(group)}><Check size={14} /> حفظ المجموعة</button></header><div className="call-group-members">{members.map((row) => <label className="call-member" key={row.id}><span className="call-member-info"><strong>{row.name}</strong><span className="phone-copy-row"><small dir="ltr">{row.phone1 || "بدون رقم"}</small>{row.phone1 && <a className="call-phone" href={`tel:${phoneHref(row.phone1)}`} onClick={(event) => event.stopPropagation()}><Phone size={13} /> اتصل</a>}</span></span><input className="status-check" type="checkbox" checked={row.called} onChange={(event) => updateCheck(row.recordKey, "called", event.target.checked)} aria-label={`تم الاتصال بـ ${row.name}`} /></label>)}</div></section>)}{!groups.length && <p className="empty-row">{loading ? "جاري تحميل البيانات" : "لا توجد نتائج"}</p>}</div></section>;
}

function PeopleTable({ mode, rows, query, setQuery, busy, saveFollowUp, updateCheck, openReport, loading, includeVisitedThisMonth, setIncludeVisitedThisMonth }) {
  phoneDirectory = Object.fromEntries(rows.map((row) => [row.name, row]));
  if (mode === "call") return <CallGroupsTable rows={rows} query={query} setQuery={setQuery} busy={busy} saveFollowUp={saveFollowUp} updateCheck={updateCheck} loading={loading} />;
  return <section className="table-section"><div className="section-title-row table-title-row"><div><p className="section-kicker">بيانات الافتقاد</p><h2>{mode === "visit" ? "زيارة البيت" : mode === "call" ? "الاتصال الأسبوعي" : "آخر متابعة لكل ولد"}</h2></div><div className="table-actions"><label className="search-box"><Search size={17} /><input type="search" placeholder="ابحث بالاسم أو الجروب أو الخادم" value={query} onChange={(event) => setQuery(event.target.value)} /></label>{mode === "visit" && <button className="secondary-button month-filter-button" onClick={() => setIncludeVisitedThisMonth(!includeVisitedThisMonth)}>{includeVisitedThisMonth ? "إخفاء من تمت زيارتهم هذا الشهر" : "إظهار من تمت زيارتهم هذا الشهر"}</button>}{mode !== "history" && <button className="secondary-button" disabled={busy} onClick={() => saveFollowUp()}><Check size={16} /> احفظ {mode === "visit" ? "الزيارات" : "الاتصالات"}</button>}</div></div><div className="table-wrap"><table><thead><tr>{mode === "visit" ? <><th>الجروب</th><th>الاسم</th><th>رقم 1</th><th>العنوان</th><th>تمت الزيارة</th><th>آخر زيارة</th></> : mode === "call" ? <><th>الجروب</th><th>الاسم</th><th>رقم 1</th><th>مسؤول الاتصال</th><th>تم الاتصال</th></> : <><th>الجروب</th><th>الاسم</th><th>رقم 1</th><th>آخر زيارة</th><th>آخر اتصال</th><th>آخر خادم اتصل</th></>}</tr></thead><tbody>{rows.map((row) => <tr className={`group-tone-${groupTone(row.group)}`} key={row.id}><td><span className="group-pill">{row.group}</span></td><td className="name-cell">{mode === "history" ? <button className="person-link" onClick={() => openReport(row)}>{row.name}</button> : row.name}</td><td className="phone-cell">{mode === "visit" ? <CopyPhone value={row.phone1} name={row.name} /> : row.phone1 || "—"}</td>{mode === "visit" ? <><td className="address-cell">{row.address || "—"}</td><td className="check-cell"><input className="status-check" type="checkbox" checked={row.visited} onChange={(event) => updateCheck(row.recordKey, "visited", event.target.checked)} aria-label={`تمت زيارة ${row.name}`} /></td><td className="history-date">{dateLabel(row.lastVisitedDate)}</td></> : mode === "call" ? <><td><span className={`servant-cell ${row.servant ? "" : "muted"}`}>{row.servant || "غير موزع"}</span></td><td className="check-cell"><input className="status-check" type="checkbox" checked={row.called} onChange={(event) => updateCheck(row.recordKey, "called", event.target.checked)} aria-label={`تم الاتصال بـ ${row.name}`} /></td></> : <><td className="history-date">{dateLabel(row.lastVisitedDate)}</td><td className="history-date">{dateLabel(row.lastCalledWeek)}</td><td><span className="servant-cell">{row.lastCaller || "غير مسجل"}</span></td></>}</tr>)}</tbody></table>{!rows.length && <p className="empty-row">{loading ? "جاري تحميل البيانات" : "لا توجد نتائج"}</p>}</div></section>;
}

function ReportModal({ report, close }) {
  return <div className="modal"><button className="modal-backdrop" aria-label="إغلاق التقرير" onClick={close} /><section className="report-dialog" role="dialog" aria-modal="true"><button className="modal-close" aria-label="إغلاق" onClick={close}><X size={18} /></button><p className="section-kicker">التقرير التفصيلي للفرد</p><h2>{report.person.name}</h2><div className="report-meta">الجروب {report.person.group || "غير مرتبط"} · {report.person.phone1 || "بدون رقم"}</div><div className="report-summary"><span>زيارات: <strong>{report.events.filter((event) => event.visited).length}</strong></span><span>اتصالات: <strong>{report.events.filter((event) => event.called).length}</strong></span><span>خورس: <strong>{report.events.filter((event) => event.choir).length}</strong></span><span>قداس: <strong>{report.events.filter((event) => event.mass).length}</strong></span></div><div className="report-table-wrap"><table className="report-table"><thead><tr><th>التاريخ</th><th>زيارة</th><th>اتصال</th><th>خورس</th><th>قداس</th><th>الخادم</th></tr></thead><tbody>{report.events.length ? report.events.map((event) => <tr key={`${event.date}-${event.caller}-${event.choir}-${event.mass}`}><td>{dateLabel(event.date)}</td><td>{event.visited ? "تمت" : "—"}</td><td>{event.called ? "تم" : "—"}</td><td>{event.choir ? "حضر" : "—"}</td><td>{event.mass ? "حضر" : "—"}</td><td>{event.caller || "—"}</td></tr>) : <tr><td colSpan="6">لا يوجد سجل محفوظ لهذا الفرد</td></tr>}</tbody></table></div></section></div>;
}
function AttendanceBar({ label, value, total, tone }) { const width = total ? Math.max(3, value * 100 / total) : 0; return <div className="attendance-bar-item"><div><span>{label}</span><strong>{value}</strong></div><div className="attendance-bar-track"><i className={tone} style={{ width: width + "%" }} /></div></div>; }
function AttendanceDonut({ choir, mass, total }) { const values = [choir, Math.max(0, total - choir), mass, Math.max(0, total - mass)]; const sum = Math.max(1, values.reduce((a, b) => a + b, 0)); const stops = values.map((value, index) => `${["#078b59", "#d28700", "#6989cf", "#e58c8c"][index]} ${values.slice(0, index).reduce((a, b) => a + b, 0) * 100 / sum}% ${values.slice(0, index + 1).reduce((a, b) => a + b, 0) * 100 / sum}%`).join(", "); return <div className="four-donut-wrap"><div className="four-donut" style={{ background: `conic-gradient(${stops})` }}><strong>{Math.round((choir + mass) * 100 / Math.max(1, total * 2))}%</strong></div><div className="donut-legend"><span><i className="green" /> حضور الخورس <b>{choir}</b></span><span><i className="orange" /> غياب الخورس <b>{Math.max(0, total - choir)}</b></span><span><i className="blue" /> حضور القداس <b>{mass}</b></span><span><i className="red" /> غياب القداس <b>{Math.max(0, total - mass)}</b></span></div></div>; }
