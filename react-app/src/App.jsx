import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, Bell, BookOpen, CalendarDays, Camera, Check, ChevronLeft, ChevronRight, Church, CircleAlert, Copy, Home, LayoutDashboard, LoaderCircle, LogOut, MapPin, Medal, Menu, MessageCircle, Moon, Pencil, Phone, Plus, QrCode, Search, Star, Sun, Trash2, Trophy, UserCheck, Users, X } from "lucide-react";
import QRCode from "qrcode";
import { Html5Qrcode } from "html5-qrcode";

const apiUrl = (import.meta.env.VITE_API_URL || "https://abanob-mngm.onrender.com").replace(/\/$/, "");
const today = () => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};
const fridaySessionsSinceStart = (startDate = "2026-10-16") => {
  const start = new Date(`${startDate}T12:00:00`);
  const end = new Date(`${today()}T12:00:00`);
  let sessions = 0;
  for (let date = start; date <= end; date.setDate(date.getDate() + 7)) sessions += 1;
  return sessions;
};
const dateLabel = (value) => value ? new Intl.DateTimeFormat("ar-EG", { day: "numeric", month: "long", year: "numeric" }).format(new Date(`${value}T12:00:00`)) : "—";
const isGoogleMapsUrl = (value) => {
  try {
    const url = new URL(String(value || "").trim());
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && (host === "maps.app.goo.gl" || host === "goo.gl" || host === "maps.google.com" || (host === "google.com" || host.endsWith(".google.com")) && url.pathname.startsWith("/maps"));
  } catch {
    return false;
  }
};
const mapsSearchUrl = (address) => {
  const value = String(address || "").trim();
  return isGoogleMapsUrl(value) ? value : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(value)}`;
};
const normalizeArabic = (value) => String(value || "").replace(/[إأآ]/g, "ا");
const canonicalServantName = (value) => {
  const name = String(value || "").trim().replace(/^[أإآا]\s*[/.]\s*/, "");
  const normalized = normalizeArabic(name).replace(/\s+/g, "");
  return ["ميلاد", "ميلد", "ميلادعدلي"].includes(normalized) ? "ميلاد عدلي" : name;
};
const splitServants = (value = "") => [...new Set(String(value).split(/\r?\n/).map(canonicalServantName).filter(Boolean))];
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

function nameKey(value) {
  return normalizeArabic(value).trim().replace(/\s+/g, " ").toLocaleLowerCase("ar");
}

function searchableRowText(row) {
  return normalizeArabic([row.name, row.group, row.phone1, row.phone2, row.address, row.note, row.servant, row.lastCaller]
    .filter(Boolean)
    .join(" "))
    .toLocaleLowerCase("ar");
}

function searchMatches(text, term) {
  if (!term) return true;
  if (text.includes(term)) return true;
  const compactText = text.replace(/[\s،,.\-_/]/g, "");
  const compactTerm = term.replace(/[\s،,.\-_/]/g, "");
  if (compactTerm.length < 3) return false;
  let index = 0;
  for (const character of compactText) {
    if (character === compactTerm[index]) index += 1;
    if (index === compactTerm.length) return true;
  }
  return false;
}

function findDuplicateNames(people) {
  const groups = new Map();
  for (const person of people || []) {
    const key = nameKey(person.name);
    if (!key) continue;
    const list = groups.get(key) || [];
    list.push(person);
    groups.set(key, list);
  }
  return [...groups.values()].filter((list) => list.length > 1).sort((a, b) => b.length - a.length || a[0].name.localeCompare(b[0].name, "ar"));
}

function parentRequestNotifications(requests = []) {
  return requests.map((item) => ({
    id: `parent-request-${item.id}`,
    eventType: "parent_followup_request",
    title: "طلب متابعة جديد من ولي أمر",
    body: `${item.name} طلب ${item.type === "call" ? "اتصالًا" : "زيارة"}${item.message ? `: ${item.message}` : ""}`,
    createdAt: item.createdAt,
    sourceLabel: "طلبات الأهالي",
    targetMode: "requests",
    sourceId: item.id,
  }));
}

export default function App() {
  const [username, setUsername] = useState(() => sessionStorage.getItem("choir-username") || "");
  const [password, setPassword] = useState(() => sessionStorage.getItem("choir-password") || "");
  const [usernameDraft, setUsernameDraft] = useState("");
  const [passwordDraft, setPasswordDraft] = useState("");
  const [mode, setMode] = useState(() => { const savedMode = stored("choir-mode", "home"); return savedMode === "qr" ? "qr-print" : savedMode; });
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
  const [attendanceRole, setAttendanceRole] = useState("boy");
  const [attendanceDate, setAttendanceDate] = useState(() => stored("choir-attendance-date", today()));
  const [attendanceChecks, setAttendanceChecks] = useState({});
  const [dashboard, setDashboard] = useState({ summary: {}, people: [] });
  const [visitReports, setVisitReports] = useState(emptyVisitReports);
  const [followUpNotes, setFollowUpNotes] = useState([]);
  const [followUpRequests, setFollowUpRequests] = useState([]);
  const [notificationItems, setNotificationItems] = useState([]);
  const [notificationReadMap, setNotificationReadMap] = useState({});
  const [notificationPermission, setNotificationPermission] = useState(() => "Notification" in window ? Notification.permission : "unsupported");
  const [reportMonth, setReportMonth] = useState(today().slice(0, 7));
  const [includeVisitedThisMonth, setIncludeVisitedThisMonth] = useState(false);
  const [dashboardDate, setDashboardDate] = useState(() => stored("choir-dashboard-date", today()));
  const [trendMonth, setTrendMonth] = useState(() => stored("choir-trend-month", today().slice(0, 7)));
  const [scanType, setScanType] = useState(() => stored("choir-scan-type", "choir"));
  const [scanDate, setScanDate] = useState(today());
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem("choir-dark-mode") === "true");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    if (!mobileNavOpen) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileNavOpen]);

  useEffect(() => {
    localStorage.setItem("choir-dark-mode", String(darkMode));
  }, [darkMode]);

  useEffect(() => {
    if (!notice) return undefined;
    const timeout = window.setTimeout(() => setNotice(""), 2200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const request = useCallback(async (path, options = {}, auth = password, user = username) => {
    const response = await fetch(`${apiUrl}${path}`, { ...options, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(auth ? { "X-App-Password": auth } : {}), ...(user ? { "X-App-Username": user } : {}), ...options.headers } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = response.status === 401
        ? "اسم المستخدم أو كلمة المرور غير صحيحة"
        : response.status === 400
          ? "البيانات المدخلة غير صحيحة، راجعها وحاول مرة أخرى"
          : response.status === 403
            ? "ليس لديك صلاحية لتنفيذ هذا الطلب"
            : body.error || "تعذر إكمال الطلب، حاول مرة أخرى";
      throw new Error(message);
    }
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
      if (nextMode === "notifications") return;
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

  useEffect(() => { if (password && username && mode !== "evaluation") { load(mode, mode === "attendance" ? attendanceDate : selectedDate, password); } }, [password, username]);

  useEffect(() => {
    if (!password || !username) return undefined;
    let stopped = false;
    const storageKey = `choir-notification-read-state-${username}`;
    let readMap = {};
    let initialized = false;
    try {
      const savedState = localStorage.getItem(storageKey);
      if (savedState !== null) {
        readMap = JSON.parse(savedState);
        initialized = true;
      }
    } catch { /* Ignore invalid notification state and establish a fresh baseline. */ }

    const pollRequests = async () => {
      try {
        const requests = await request("/api/followup-requests");
        if (stopped) return;
        setFollowUpRequests(requests);
        const notifications = parentRequestNotifications(requests);
        setNotificationItems(notifications);
        try {
          const savedState = localStorage.getItem(storageKey);
          if (savedState !== null) readMap = JSON.parse(savedState);
        } catch { /* Keep the last valid notification state. */ }
        const incoming = initialized ? notifications.filter((item) => !(item.id in readMap)) : [];
        const nextReadMap = { ...readMap };
        notifications.forEach((item) => {
          if (!(item.id in nextReadMap)) nextReadMap[item.id] = !initialized;
        });
        if (incoming.length) {
          const newest = incoming[0];
          if (document.hidden && "Notification" in window && Notification.permission === "granted") {
            incoming.forEach((item) => {
              const alert = new Notification(item.title, {
                body: item.body,
                icon: "/saint-abanoub.png",
                tag: item.id,
              });
              alert.onclick = () => { window.focus(); openNotification(item); alert.close(); };
            });
          } else {
            setNotice(incoming.length === 1
              ? `${newest.title}: ${newest.body}`
              : `وصلت ${incoming.length} تنبيهات جديدة`);
          }
        }
        readMap = nextReadMap;
        setNotificationReadMap(readMap);
        localStorage.setItem(storageKey, JSON.stringify(readMap));
        initialized = true;
      } catch { /* Keep the last badge count; retry on the next poll. */ }
    };

    pollRequests();
    const interval = window.setInterval(pollRequests, 30000);
    const onVisibilityChange = () => { if (!document.hidden) pollRequests(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [password, request, username]);

  const searchIndex = useMemo(() => state.rows.map((row) => ({ row, text: searchableRowText(row) })), [state.rows]);
  const searchTerm = useMemo(() => normalizeArabic(query).trim().toLocaleLowerCase("ar"), [query]);
  const rows = useMemo(() => searchIndex.filter(({ text }) => searchMatches(text, searchTerm)).map(({ row }) => row), [searchIndex, searchTerm]);
  const visitRows = useMemo(() => searchIndex
    .filter(({ row, text }) => (includeVisitedThisMonth ? row.visitedThisMonth : !row.visitedThisMonth) && searchMatches(text, searchTerm))
    .map(({ row }) => row), [includeVisitedThisMonth, searchIndex, searchTerm]);
  const followUpRows = state.rows.filter((row) => row.role !== "servant");
  const checkedCount = followUpRows.filter((row) => mode === "visit" ? row.visited : row.called).length;
  const percent = followUpRows.length ? Math.round(checkedCount * 100 / followUpRows.length) : 0;
  const followUpMode = mode === "visit" || mode === "call";
  const unreadNotificationCount = notificationItems.filter((item) => !notificationReadMap[item.id]).length;

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
    if (nextMode === "notifications" || nextMode === "evaluation") return;
    if (nextMode === "attendance") load(nextMode, attendanceDate); else if (nextMode === "home" || nextMode === "stray") load(nextMode, dashboardDate); else if (nextMode === "reports") load(nextMode); else if (nextMode === "qr") { /* scanner saves attendance incrementally */ } else if (nextMode === "qr-print") load("people"); else load(nextMode, nextMode === "visit" ? selectedDate : undefined);
  }

  function openNotifications() {
    switchMode("notifications");
    if (!("Notification" in window)) {
      setNotice("الإشعارات غير مدعومة في هذا المتصفح؛ التنبيهات ستظهر داخل الصفحة");
      return;
    }
    if (Notification.permission === "default") {
      Notification.requestPermission().then((permission) => {
        setNotificationPermission(permission);
        if (permission === "granted") setNotice("تم تفعيل إشعارات النظام");
        else if (permission === "denied") setNotice("السماح بالإشعارات مرفوض من إعدادات المتصفح");
      });
    } else if (Notification.permission === "denied") {
      setNotice("فعّل إشعارات الموقع من إعدادات المتصفح لتصلك التنبيهات بالخلفية");
    }
  }

  function markNotificationRead(notificationId) {
    const nextReadMap = { ...notificationReadMap, [notificationId]: true };
    setNotificationReadMap(nextReadMap);
    localStorage.setItem(`choir-notification-read-state-${username}`, JSON.stringify(nextReadMap));
  }

  function openNotification(item) {
    markNotificationRead(item.id);
    switchMode(item.targetMode);
  }

  function markAllNotificationsRead() {
    const nextReadMap = { ...notificationReadMap, ...Object.fromEntries(notificationItems.map((item) => [item.id, true])) };
    setNotificationReadMap(nextReadMap);
    localStorage.setItem(`choir-notification-read-state-${username}`, JSON.stringify(nextReadMap));
  }

  async function markAttendance(recordKey, present, type = attendanceType, date = attendanceDate) {
    try {
      await request("/api/attendance", { method: "POST", body: JSON.stringify({ type, date, checks: { [recordKey]: present } }) });
    } catch (saveError) { setError(saveError.message); }
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
        const checks = Object.fromEntries(state.rows.filter((row) => row.role !== "servant").map((row) => [row.recordKey, row.visited === true]));
        result = await request("/api/visits", { method: "POST", body: JSON.stringify({ date: selectedDate, checks }) });
      } else {
        const checks = Object.fromEntries(state.rows.filter((row) => row.role !== "servant" && (!groupFilter || row.group === groupFilter)).map((row) => [row.recordKey, row.called === true]));
        const servants = servantsText.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
        result = await request("/api/calls", { method: "POST", body: JSON.stringify({ rotationStart, servants, checks, redistribute: assign }) });
      }
      setState(result); setRotationStart(result.rotationStart || rotationStart); setServantsText((result.servants || []).join("\n"));
      if (mode === "call") await load("history");
      if (mode === "call") await load("history");
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
  if (window.location.pathname === "/life-of-saint-abanoub") return <SaintAbanoubStoryPage />;
  if (window.location.pathname === "/league") return <PublicLeaguePage />;
  if (!isAdminPage) return <PublicParentHome />;
  if (!password || !username) return <main className="login-screen"><form className="login-panel" onSubmit={login}><div className="login-brand"><img src="/saint-abanoub.png" alt="القديس أبانوب" /></div><p className="eyebrow">خورس القديس أبانوب</p><h1>إدارة خورس القديس أبانوب</h1><label htmlFor="app-username">اسم المستخدم</label><input id="app-username" type="text" autoComplete="username" value={usernameDraft} onChange={(event) => setUsernameDraft(event.target.value)} required autoFocus placeholder="admin" /><label htmlFor="app-password">كلمة المرور</label><input id="app-password" type="password" autoComplete="current-password" value={passwordDraft} onChange={(event) => setPasswordDraft(event.target.value)} required /><button className="primary-button" disabled={busy}>{busy ? <LoaderCircle size={17} className="spin" /> : null} دخول</button>{error && <p className="login-error">{error}</p>}<a className="login-back-link" href="/">العودة إلى بحث الأهالي</a></form></main>;

  const navItem = (nextMode, icon, label) => <button className={`sidebar-item ${mode === nextMode ? "active" : ""}`} onClick={() => { setMobileNavOpen(false); switchMode(nextMode); }}>{icon}<span>{label}</span></button>;
  return <main className={`app-shell mode-${mode} ${darkMode ? "dark-mode" : ""}`}>
    {mobileNavOpen && <button className="mobile-sidebar-backdrop" type="button" aria-label="إغلاق القائمة" onClick={() => setMobileNavOpen(false)} />}
    <aside id="mobile-app-sidebar" className={`app-sidebar ${mobileNavOpen ? "mobile-open" : ""}`} aria-label="قائمة صفحات الإدارة">
      <div className="sidebar-brand"><img src="/saint-abanoub.png" alt="القديس أبانوب" /><div><strong>خورس القديس أبانوب</strong><span>إدارة الخدمة</span></div><button className="mobile-sidebar-close" type="button" aria-label="إغلاق القائمة" onClick={() => setMobileNavOpen(false)}><X size={19} /></button></div>
      <p className="sidebar-label">أقسام لوحة الإدارة</p>
      <nav className="sidebar-nav">
        {navItem("home", <LayoutDashboard size={17} />, "نظرة عامة")}{navItem("attendance", <UserCheck size={17} />, "الحضور والغياب")}{navItem("visit", <Home size={17} />, "الافتقاد")}{navItem("stray", <img className="sheep-icon" src="/sheep-icon.svg" alt="" />, "الخروف الضال")}{navItem("history", <Users size={17} />, "أفراد الخورس")}{navItem("people", <Pencil size={17} />, "إدارة الخورس")}{navItem("evaluation", <Star size={17} />, "تقييم الأولاد")}{navItem("qr-print", <QrCode size={17} />, "QR الأولاد")}
        <button className={`sidebar-item notification-item ${mode === "notifications" ? "active" : ""}`} type="button" onClick={() => { setMobileNavOpen(false); openNotifications(); }} title={notificationPermission === "granted" ? "مركز التنبيهات · إشعارات المتصفح مفعّلة" : "مركز التنبيهات · تفعيل إشعارات المتصفح"}><Bell size={17} /><span>التنبيهات</span>{unreadNotificationCount > 0 && <b className="notification-count">{Math.min(99, unreadNotificationCount)}{unreadNotificationCount > 99 ? "+" : ""}</b>}</button>
      </nav>
      <div className="sidebar-footer"><div className="sidebar-footer-actions"><button className="theme-toggle" type="button" onClick={() => setDarkMode((value) => !value)}><span>{darkMode ? "الوضع الفاتح" : "الوضع الداكن"}</span>{darkMode ? <Sun size={16} /> : <Moon size={16} />}</button><a className="logout-button" href="/" title="تسجيل الخروج والعودة للرئيسية" aria-label="تسجيل الخروج والعودة للرئيسية" onClick={() => { sessionStorage.removeItem("choir-password"); sessionStorage.removeItem("choir-username"); }}><LogOut size={15} /><span>خروج</span></a></div></div>
    </aside>
    <section className="app-content"><div className="mobile-app-header"><div className="mobile-brand"><img src="/saint-abanoub.png" alt="القديس أبانوب" /><div><strong>خورس القديس أبانوب</strong><span>إدارة الخدمة</span></div></div><button className="mobile-menu-button" type="button" aria-label="فتح القائمة" aria-controls="mobile-app-sidebar" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen(true)}><Menu size={23} /></button></div><header className="topbar"><div className="topbar-verse"><span>«اذْهَبِ انْظُرْ سَلاَمَةَ إِخْوَتِكَ، وَسَلاَمَةَ الْغَنَمِ وَرُدَّ لِي خَبَرًا»</span></div><div className="top-actions">{mode === "reports" && <button className="copy-phone" title="تصدير التقرير" onClick={exportCsv}><Copy size={14} /></button>}<span className="save-state">{loading ? "جاري التحميل" : busy ? "جاري الحفظ" : notice || "جاهز"}</span></div></header>
    {mode === "visit" && state.verse && <section className="verse-band"><p>{state.verse}</p></section>}
    {mode === "visit" || mode === "call" || mode === "reports" || mode === "notes" || mode === "requests" ? <div className="sub-tabs"><button className={mode === "visit" ? "active" : ""} onClick={() => switchMode("visit")}><Home size={15} /> زيارة البيت</button><button className={mode === "call" ? "active" : ""} onClick={() => switchMode("call")}><Phone size={15} /> الاتصال الأسبوعي</button><button className={mode === "reports" ? "active" : ""} onClick={() => switchMode("reports")}><BarChart3 size={15} /> تقارير الافتقاد</button><button className={mode === "notes" ? "active" : ""} onClick={() => switchMode("notes")}><Pencil size={15} /> ملاحظات الافتقاد</button><button className={mode === "requests" ? "active" : ""} onClick={() => switchMode("requests")}><Phone size={15} /> طلبات الأهالي</button></div> : null}

    {followUpMode && <FollowUpDashboard mode={mode} state={state} selectedDate={selectedDate} setSelectedDate={(date) => { setSelectedDate(date); sessionStorage.setItem("choir-selected-date", date); }} rotationStart={rotationStart} setRotationStart={setRotationStart} servantsText={servantsText} setServantsText={setServantsText} busy={busy} saveFollowUp={saveFollowUp} load={load} checkedCount={checkedCount} percent={percent} />}
    {mode === "people" && <PeopleManager state={state} rows={rows} query={query} setQuery={setQuery} busy={busy} editingPerson={editingPerson} personDraft={personDraft} setPersonDraft={setPersonDraft} savePerson={savePerson} editPerson={editPerson} archivePerson={archivePerson} cancelEdit={() => { setEditingPerson(null); setPersonDraft(emptyPerson); }} />}
    {mode === "attendance" && <AttendanceManager state={state} rows={rows} attendanceType={attendanceType} setAttendanceType={(type) => { setAttendanceType(type); load("attendance", attendanceDate, password, trendMonth, type); }} attendanceRole={attendanceRole} setAttendanceRole={(role) => { setAttendanceRole(role); setAttendanceChecks({}); }} attendanceDate={attendanceDate} setAttendanceDate={(date) => { setAttendanceDate(date); sessionStorage.setItem("choir-attendance-date", date); load("attendance", date); }} checks={attendanceChecks} setChecks={setAttendanceChecks} save={(checks) => saveAttendance(Object.fromEntries(Object.entries(checks).filter(([key]) => rows.find((row) => String(row.recordKey) === key)?.role === attendanceRole)))} markAttendance={markAttendance} onComment={async (recordKey, comment) => { await request("/api/attendance-comment", { method: "POST", body: JSON.stringify({ type: attendanceType, date: attendanceDate, recordKey: Number(recordKey), comment }) }, password); setNotice("تم حفظ تعليق الحضور"); }} onDeleteComment={async (recordKey) => { await request(`/api/attendance-comment?type=${attendanceType}&date=${attendanceDate}&recordKey=${Number(recordKey)}`, { method: "DELETE" }, password); setNotice("تم مسح التعليق"); }} busy={busy} query={query} setQuery={setQuery} />}
    {mode === "evaluation" && <ServantBoyEvaluationPage request={request} />}
    {(mode === "qr" || mode === "qr-print") && <QrManagementPage rows={state.rows} request={request} scanType={scanType} setScanType={(type) => { setScanType(type); sessionStorage.setItem("choir-scan-type", type); }} scanDate={scanDate} setScanDate={setScanDate} />}
    {mode === "home" && <HomeDashboard dashboard={dashboard} dashboardDate={dashboardDate} setDashboardDate={(date) => { setDashboardDate(date); sessionStorage.setItem("choir-dashboard-date", date); load("home", date); }} trendMonth={trendMonth} setTrendMonth={(month) => { setTrendMonth(month); sessionStorage.setItem("choir-trend-month", month); load("home", dashboardDate, password, month); }} openReport={openReport} />}
    {mode === "stray" && <StraySheepPage people={dashboard.people || []} openReport={openReport} />}
    {(mode === "visit" || mode === "call") && <PeopleTable mode={mode} rows={(mode === "visit" ? visitRows : rows).filter((row) => row.role !== "servant")} query={query} setQuery={setQuery} busy={busy} saveFollowUp={saveFollowUp} updateCheck={updateCheck} openReport={openReport} loading={loading} includeVisitedThisMonth={includeVisitedThisMonth} setIncludeVisitedThisMonth={setIncludeVisitedThisMonth} />}
    {mode === "reports" && <VisitReportsPage reports={visitReports} exportCsv={exportCsv} month={reportMonth} setMonth={(month) => { setReportMonth(month); load("reports", undefined, password, month); }} />}
    {mode === "notes" && <FollowUpNotesPage notes={followUpNotes} rows={rows} request={request} password={password} reload={() => load("notes")} />}
    {mode === "notifications" && <NotificationsPage notifications={notificationItems} readMap={notificationReadMap} onOpen={openNotification} onMarkAllRead={markAllNotificationsRead} />}
    {mode === "requests" && <FollowUpRequestsPage requests={followUpRequests} request={request} password={password} reload={() => load("requests")} />}
    {mode === "history" && <MembersDirectoryByRole rows={rows} query={query} setQuery={setQuery} openReport={openReport} loading={loading} request={request} />}
    {(error || notice) && <div className={`toast visible ${error ? "error" : ""}`} role="status">{error || notice}</div>}
    {report && <ReportModal report={report} close={() => setReport(null)} />}
    </section></main>;
}

function PublicLeaguePage() {
  const [month, setMonth] = useState(today().slice(0, 7));
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    fetch(`${apiUrl}/api/public/league?month=${encodeURIComponent(month)}`, { signal: controller.signal })
      .then(async (response) => { const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || "تعذر تحميل ترتيب الأولاد"); return body; })
      .then(setData).catch((loadError) => { if (loadError.name !== "AbortError") setError(loadError.message); })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [month]);
  const leader = data?.monthlyLeader;
  const medalFor = (rank) => rank === 1 ? <Trophy size={18} /> : rank === 2 ? <Medal size={18} /> : rank === 3 ? <Medal size={18} /> : <span>{rank}</span>;
  return <main className="league-page" dir="rtl"><header className="league-header"><a href="/" className="league-back"><ChevronRight size={17} /> الصفحة الرئيسية</a><div><span className="league-kicker">خورس القديس أبانوب</span><h1>دوري أبانوب</h1><p>ترتيب شهري حسب الحضور والتقييم</p></div><label className="league-month">الشهر<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label></header><div className="league-content"><section className={`monthly-champion ${data?.isFinalized ? "final" : "provisional"}`}><div className="monthly-champion-icon"><Star size={23} fill="currentColor" /></div><div><span className="league-kicker">شماس الشهر</span><h2>{leader?.name || "لم يتحدد المتصدر بعد"}</h2><p>{leader ? (data?.isFinalized ? `شماس خورس شهر ${dateLabel(`${month}-01`).split(" ").slice(1, 3).join(" ")}` : `المتصدر المؤقت · يُحسم بعد الجمعة ${data?.lastFriday ? dateLabel(data.lastFriday) : "الأخيرة"}`) : "لا توجد نقاط مسجلة في هذا الشهر بعد"}</p></div><strong className="monthly-points">{leader ? `${leader.points} نقطة` : "—"}</strong></section>{error && <p className="league-message error">{error}</p>}{loading && <p className="league-message">جاري تحميل الترتيب...</p>}<section className="league-table-section"><div className="league-table-heading"><div><span className="league-kicker">الشهر المختار</span><h2>ترتيب دوري أبانوب</h2></div><span className="league-row-count">{data?.rows?.length || 0} ولد</span></div><div className="league-table-wrap"><table className="league-table"><thead><tr><th>المركز</th><th>الاسم</th><th>النقاط</th></tr></thead><tbody>{(data?.rows || []).map((row) => <tr key={row.recordKey} className={`league-rank-${Math.min(row.rank, 3)}`}><td><span className={`league-rank-badge rank-${Math.min(row.rank, 3)}`}>{medalFor(row.rank)}</span></td><td><strong>{row.name}</strong></td><td><strong className="league-score">{row.points}</strong></td></tr>)}</tbody></table>{!loading && !error && !data?.rows?.length && <p className="league-message">لا يوجد أولاد مسجلون في الترتيب حتى الآن</p>}</div></section><footer className="league-footnote">نقاط الشهر تجمع حضور القداس والخورس والتقييمات المسجلة خلال الشهر المختار.</footer></div></main>;
}

function ServantBoyEvaluationPage({ request }) {
  const [date, setDate] = useState(today());
  const [people, setPeople] = useState([]);
  const [scores, setScores] = useState({});
  const [query, setQuery] = useState("");
  const [saveStates, setSaveStates] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const saveQueue = useRef({});
  const saveVersion = useRef({});
  const reload = useCallback(async () => {
    setLoading(true); setError(""); setSaveStates({});
    try {
      const result = await request(`/api/evaluations?date=${encodeURIComponent(date)}`);
      setPeople(result.people || []);
      setScores(Object.fromEntries((result.people || []).map((person) => [String(person.recordKey), person.points ?? 0])));
    } catch (loadError) { setPeople([]); setScores({}); setError(loadError.message); }
    finally { setLoading(false); }
  }, [date, request]);
  useEffect(() => { reload(); }, [reload]);
  function updateScore(recordKey, value) {
    const key = String(recordKey);
    const version = (saveVersion.current[key] || 0) + 1;
    saveVersion.current[key] = version;
    setScores((current) => ({ ...current, [key]: value }));
    setSaveStates((current) => ({ ...current, [key]: "saving" }));
    setError("");
    const previous = saveQueue.current[key] || Promise.resolve();
    const next = previous.catch(() => {}).then(() => request("/api/evaluations", { method: "POST", body: JSON.stringify({ date, scores: { [key]: value } }) }));
    saveQueue.current[key] = next;
    next.then(() => { if (saveVersion.current[key] === version) setSaveStates((current) => ({ ...current, [key]: "saved" })); })
      .catch((saveError) => { if (saveVersion.current[key] === version) { setError(saveError.message); setSaveStates((current) => ({ ...current, [key]: "error" })); } });
  }
  const filteredPeople = people.filter((person) => normalizeArabic(person.name).toLocaleLowerCase("ar").includes(normalizeArabic(query).trim().toLocaleLowerCase("ar")));
  return <main className="evaluation-page" dir="rtl"><header className="evaluation-heading"><div><span className="section-kicker">متابعة أداء الأبناء</span><h1>تقييم الخورس</h1><p>يظهر هنا من سُجل حضوره في الخورس في التاريخ المختار.</p></div><label>تاريخ الحضور<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label></header>{error && <p className="evaluation-alert error">{error}</p>}<section className="evaluation-panel"><div className="evaluation-panel-heading"><div><h2>تقييم الحاضرين</h2><span>{loading ? "جاري التحميل..." : `${filteredPeople.length} من ${people.length} ولد`}</span></div><label className="evaluation-search"><Search size={17} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ابحث باسم الولد" aria-label="ابحث باسم الولد" /></label></div>{!loading && people.length === 0 ? <div className="evaluation-empty"><Users size={25} /><strong>لا يوجد حضور خورس مسجل لهذا اليوم</strong><span>اختر تاريخًا سُجل فيه حضور الخورس لبدء التقييم.</span></div> : filteredPeople.length === 0 ? <p className="evaluation-no-results">لا يوجد ولد بهذا الاسم</p> : <div className="evaluation-list">{filteredPeople.map((person) => { const key = String(person.recordKey); const score = scores[key] ?? 0; const saveState = saveStates[key]; return <label className="evaluation-row" key={person.recordKey}><span className="evaluation-person"><strong>{person.name}</strong><small className={saveState || "idle"}>{saveState === "saving" ? "جارٍ الحفظ..." : saveState === "saved" ? "تم الحفظ تلقائيًا" : saveState === "error" ? "تعذر الحفظ" : person.points === null ? "لم يُقيّم بعد" : "تقييم محفوظ"}</small></span><input aria-label={`تقييم ${person.name}`} type="range" min="0" max="10" step="1" value={score} onChange={(event) => updateScore(person.recordKey, Number(event.target.value))} /><output className="evaluation-score">{score}<small>/ 10</small></output></label>; })}</div>}</section></main>;
}

function PublicParentHome() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showScanner, setShowScanner] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!menuOpen) return undefined;
    const closeOnEscape = (event) => { if (event.key === "Escape") setMenuOpen(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [menuOpen]);
  useEffect(() => {
    const search = query.trim();
    if (search.length < 2) { setResults([]); setError(""); return undefined; }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true); setError("");
      try {
        const response = await fetch(`${apiUrl}/api/public/people?query=${encodeURIComponent(search)}`, { signal: controller.signal });
        const body = await response.json().catch(() => []);
        if (!response.ok) throw new Error(body.error || "تعذر البحث الآن");
        setResults(body);
      } catch (searchError) {
        if (searchError.name !== "AbortError") { setResults([]); setError(searchError.message); }
      }
      finally { setLoading(false); }
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query]);
  return <main className="public-parent-home"><div className="public-home-glow" />{menuOpen && <button className="public-menu-backdrop" type="button" aria-label="إغلاق القائمة" onClick={() => setMenuOpen(false)} />}<aside id="public-main-menu" className={`public-menu-drawer ${menuOpen ? "open" : ""}`} aria-label="القائمة الرئيسية" aria-hidden={!menuOpen}><div className="public-menu-heading"><strong>القائمة الرئيسية</strong><button type="button" aria-label="إغلاق القائمة" onClick={() => setMenuOpen(false)}><X size={19} /></button></div><section className="public-menu-section"><p>الخدام</p><a href="/admin"><UserCheck size={18} /><span>دخول الخدام</span><ChevronLeft size={17} /></a></section><section className="public-menu-section"><p>المخدومين</p><a href="/league"><Trophy size={18} /><span>دوري أبانوب</span><ChevronLeft size={17} /></a><a href="/life-of-saint-abanoub"><BookOpen size={18} /><span>حياة القديس أبانوب</span><ChevronLeft size={17} /></a></section></aside><header className="public-home-brand"><div className="public-home-identity"><img src="/saint-abanoub.png" alt="القديس أبانوب" /><div><strong>خورس القديس أبانوب</strong><span>متابعة حضور الأبناء</span></div></div><button type="button" className="public-menu-toggle" aria-label="فتح القائمة" aria-controls="public-main-menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><Menu size={22} /></button></header><section className="public-home-content"><img className="public-home-saint" src="/saint-abanoub.png" alt="القديس أبانوب" /><p className="section-kicker">أهلًا بكم</p><h1>تابع حضور ابنك</h1><p className="public-home-copy">اكتب اسم الابن للوصول إلى تقرير حضور الخورس والقداس.</p><div className="public-home-search"><Search size={22} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ابحث باسم الابن" aria-label="البحث باسم الابن" autoComplete="off" /><button type="button" className="public-scan-button" onClick={() => setShowScanner(true)} title="مسح QR" aria-label="مسح QR"><QrCode size={23} /></button></div>{showScanner && <PublicParentScanner onClose={() => setShowScanner(false)} />}{loading && <p className="public-home-status">جاري البحث...</p>}{error && <p className="public-home-error">{error}</p>}{!loading && query.trim().length >= 2 && !results.length && !error && <p className="public-home-status">لا يوجد ابن بهذا الاسم</p>}{results.length > 0 && <div className="public-home-results">{results.map((person) => <a key={person.token} href={`/qr/${person.token}`}><span>{person.name}</span><ChevronLeft size={19} /></a>)}</div>}</section></main>;
}

function SaintAbanoubStoryPage() {
  return <main className="saint-story-page"><header className="saint-story-header"><a href="/" className="saint-story-back"><ChevronRight size={17} /> العودة للصفحة الرئيسية</a><div><strong>خورس القديس أبانوب</strong><span>سيرة القديس</span></div></header><article className="saint-story-article"><p className="saint-story-kicker">قصة من تاريخ الكنيسة</p><h1>حياة القديس أبانوب</h1><p className="saint-story-intro">الشهيد أبانوب النهيسي، طفل ارتبطت سيرته بالشجاعة والثبات في الإيمان، وصار اسمه حاضرًا في ذاكرة الكنيسة.</p><img className="saint-story-illustration" src="/saint-abanoub-story.png" alt="القديس أبانوب في الصلاة تحت السماء" /><section><h2>نشأته</h2><p>وُلد أبانوب في قرية نهيسة، التابعة لمركز طلخا، في القرن الرابع الميلادي. كان والداه مقارة ومريم، وقد نشأ في بيت تقي محب لله. وتذكر سيرته أن اسمه يرتبط بكلمة «الذهب». فقد أبانوب والديه وهو في الثانية عشرة من عمره، وحزن عليهما أيامًا كثيرة.</p><p>وفي أحد الأعياد دخل الكنيسة، فسمع الكاهن يشجع الشعب على احتمال الضيق والاضطهاد بفرح، في وقت اشتد فيه اضطهاد المسيحيين في عهد دقلديانوس. عاد الفتى إلى بيته بعد التناول، وظلت كلمات العظة تتردد في نفسه. صلى طالبًا معونة الله، ثم خرج متجهًا إلى سمنود، عازمًا على إعلان إيمانه.</p></section><section><h2>في سمنود</h2><p>وجد أبانوب في سمنود كنائس مهدمة وأناسًا يسيئون إلى المسيحية. وبينما كان يطلب معونة الله، تروي السيرة أن رئيس الملائكة ميخائيل ظهر له وعزاه، وأرشده أن يذهب في الصباح إلى الوالي ليشهد لإيمانه، ووعده بالقوة والعون في العذابات.</p></section><section><h2>أمام الوالي والسجن</h2><p>ذهب أبانوب إلى الوالي مبكرًا وتحدث بجرأة عن إيمانه. حاول الوالي استمالته بالوعود، لكن الفتى تمسك بما يؤمن به، فأمر الوالي بضربه بعنف. وتذكر الرواية أن رئيس الملائكة ميخائيل جاء لمعونته وشفائه. ثم أُلقي أبانوب في السجن، ففرح به المسيحيون المسجونون وتعزوا بوجوده بينهم.</p><p>وفي اليوم التالي، بحسب السيرة، قُتل عدد كبير من المسجونين ونالوا إكليل الشهادة. وأمر الوالي بربط أبانوب من قدميه في سارية مركب متجه إلى أتريب، ساخرًا منه ومتحديًا أن يأتي المسيح ليخلصه.</p></section><section><h2>من سمنود إلى أتريب</h2><p>أبحرت السفينة حتى المساء. وتروي السيرة أن الوالي أصابه المرض، وأن أبانوب رأى الملاك يقترب منه ويمسح الدم عنه، ثم أنزله إلى مقدمة المركب. طلب الوالي من الفتى أن يصلي من أجل شفائه، واعدًا أن يؤمن هو وجنده إن شُفي. صلى أبانوب، وتذكر الرواية أن الوالي نال الشفاء في أتريب، وأن عددًا من أهلها آمنوا.</p></section><section><h2>ثباته في أتريب</h2><p>تعرض أبانوب في أتريب لألوان من التعذيب، منها الجلد والإلقاء في الزيت المغلي والتعريض للنار والكبريت. وتذكر سيرته أن السيد المسيح وملائكته ظهروا له وشجعوه وشفوه. كما تروي تعرضه للأذى في عينيه، ثم صدور أوامر ببتر يديه ورجليه، لكنه ظل متمسكًا بإيمانه.</p><p>وكان ثباته سببًا في تأثر كثيرين وقبولهم الإيمان، بينما استمرت الملائكة، وفق الرواية، في تعزيته خلال آلامه.</p></section><section><h2>رحلته إلى الإسكندرية</h2><p>لما رأى الوالي أن أناسًا كثيرين يؤمنون بسبب أبانوب، أرسله مقيدًا بالسلاسل إلى الإسكندرية. وفي الطريق قابل امرأة بها روح نجس، وتذكر السيرة أنه خلصها منه رغم قيود يديه، فآمنت بالمسيح، لكن أحد الجنود قتلها.</p><p>وأمام أرمانيوس والي الإسكندرية أعلن أبانوب إيمانه من جديد، فتعرض لعذابات أخرى، وأُلقي في جب فيه حيات وثعابين جائعة. وتقول الرواية إن الله حفظه بملاك، وإن الثعابين خرجت معه، ثم التف أحدها حول عنق أرمانيوس. أنقذ أبانوب الوالي، فتعجب كثيرون وآمنوا.</p></section><section><h2>استشهاده وذكراه</h2><p>بعد عذابات أخرى، قُطعت رأس أبانوب خارج المدينة على صخرة عالية. وتصف سيرته أنه وقف يصلي طالبًا المغفرة وقبول روحه. ثم تقدم القديس يوليوس الأقفهصي وحمل جسده وكفنه، وأرسلهما إلى نهيسة، موطن ميلاده، حيث دُفن وكتبت سيرته.</p><p>نُقل جسده من نهيسة إلى سمنود، ويُحتفل بعيد استشهاده في <a href="https://st-takla.org/Full-Free-Coptic-Books/Synaxarium-or-Synaxarion/11-Abeeb/24-Abeeb.html" target="_blank" rel="noreferrer">24 من شهر أبيب</a>.</p></section><a className="saint-story-video" href="https://youtu.be/1Q_tiSr1lRc?si=odnN5pI9y3V14ICb" target="_blank" rel="noreferrer"><span className="saint-story-play" aria-hidden="true">▶</span> لمشاهدة القصة</a></article></main>;
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
  const [showServants, setShowServants] = useState(false);
  const [showFollowUp, setShowFollowUp] = useState(false);
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
  return (
    <main className="public-report-page">
      <PublicBrand />
      <section className="public-student-heading">
        <div>
          <p className="section-kicker">تقرير حضور المخدوم</p>
          <h1>{data.person.name}</h1>
          {data.person.address && <a className="map-address-link" href={mapsSearchUrl(data.person.address)} target="_blank" rel="noreferrer"><MapPin size={16} /><span>{data.person.address}</span></a>}
        </div>
        <div className="public-report-actions">
          <button type="button" className="public-call-button" onClick={() => setShowServants(true)} aria-haspopup="dialog"><Phone size={18} /> اتصل بخادم الخورس</button>
          <button type="button" className="public-followup-button" onClick={() => { setRequestNotice(""); setShowFollowUp(true); }}><MessageCircle size={18} /> طلب متابعة</button>
        </div>
      </section>
      {showServants && <div className="public-servant-picker-backdrop" role="presentation" onClick={() => setShowServants(false)}><section className="public-servant-picker" role="dialog" aria-modal="true" aria-labelledby="servant-picker-title" onClick={(event) => event.stopPropagation()}><div className="public-servant-picker-heading"><div><p className="section-kicker">الاتصال المباشر</p><h2 id="servant-picker-title">اختر خادمًا للاتصال</h2></div><button type="button" className="public-picker-close" onClick={() => setShowServants(false)} aria-label="إغلاق">×</button></div><div className="public-servant-list">{(data.servants || []).map((servant) => { const phone = servant.phone1 || servant.phone2; return <a className="public-servant-contact" key={servant.id} href={phone ? `tel:${phoneHref(phone)}` : undefined} aria-disabled={!phone} onClick={(event) => { if (!phone) event.preventDefault(); }}><span className={`servant-presence-dot ${servant.choirStatus}`} aria-hidden="true" /><span className="public-servant-contact-info"><strong>{servant.name}</strong><small>{servant.choirStatus === "present" ? "موجود في الخورس" : servant.choirStatus === "absent" ? "غير موجود في خورس اليوم" : "متاح للاتصال"}</small></span><span className="public-servant-contact-action">{phone ? <Phone size={17} /> : "بدون رقم"}</span></a> })}{!(data.servants || []).length && <p className="empty-row">لا يوجد خدام مسجلون للاتصال</p>}</div><p className="public-picker-note">الحالة الخضراء أو الحمراء تظهر يوم الجمعة فقط، وفي باقي الأيام الخادم متاح للاتصال.</p></section></div>}
      {showFollowUp && <div className="public-followup-backdrop" role="presentation" onClick={() => setShowFollowUp(false)}><section className="public-followup-request public-followup-dialog" role="dialog" aria-modal="true" aria-labelledby="followup-title" onClick={(event) => event.stopPropagation()}><div className="public-followup-heading"><div><p className="section-kicker">مساعدة ومتابعة</p><h2 id="followup-title">اطلب متابعة من الخادم</h2></div><button type="button" className="public-picker-close" onClick={() => setShowFollowUp(false)} aria-label="إغلاق">×</button></div><p className="public-followup-copy">اختر نوع المتابعة التي تحتاجها، وسيصل طلبك إلى خدام الخورس.</p><form onSubmit={sendRequest}><label>نوع المتابعة<select value={requestType} onChange={(event) => setRequestType(event.target.value)}><option value="call">طلب اتصال</option><option value="visit">طلب زيارة</option></select></label><label>رسالة اختيارية<textarea rows="3" value={requestMessage} onChange={(event) => setRequestMessage(event.target.value)} placeholder="اكتب تفاصيل تساعد الخادم على متابعتك" /></label><button className="public-call-button" disabled={requestBusy}>{requestBusy ? "جاري الإرسال" : "إرسال طلب المتابعة"}</button>{requestNotice && <p role="status" className={requestNotice.startsWith("تم") ? "success" : "error"}>{requestNotice}</p>}</form></section></div>}
      <section className="public-attendance-summary"><PublicMetric label="حضور الخورس" value={data.person.choirCount} absent={data.person.choirAbsent} rate={data.person.choirRate} /><PublicMetric label="حضور القداس" value={data.person.massCount} absent={data.person.massAbsent} rate={data.person.massRate} /><PublicMetric label="عدد الجمعات" value={data.person.fridaySessions} /></section>
      <section className="public-monthly-report"><div className="public-section-heading"><div><p className="section-kicker">ملخص المتابعة</p><h2>الحضور والغياب حسب الشهر</h2></div><span>من ٢ أكتوبر ٢٠٢٦</span></div><div className="public-month-list">{data.monthly.map((month) => <article key={month.month}><strong>{month.month}</strong><span>خورس <b>{month.choir}</b><small>غياب {month.choirAbsent} · {month.choirRate}%</small></span><span>قداس <b>{month.mass}</b><small>غياب {month.massAbsent} · {month.massRate}%</small></span></article>)}{!data.monthly.length && <p className="empty-row">لا توجد تسجيلات حضور حتى الآن</p>}</div></section>
      <section className="public-history"><div className="public-section-heading"><div><p className="section-kicker">السجل التفصيلي</p><h2>مواعيد الحضور</h2></div><span>التاريخ والساعة</span></div><div className="public-history-list">{data.attendance.map((item) => <article key={`${item.type}-${item.date}-${item.recordedAt}`}><span className={`public-type ${item.type === "choir" ? "choir" : "mass"}`}>{item.type === "choir" ? "خورس" : "قداس"}</span><div><strong>{dateLabel(item.date)}</strong><small>{publicTimeLabel(item.recordedAt)}</small></div></article>)}{!data.attendance.length && <p className="empty-row">لا توجد تسجيلات حضور حتى الآن</p>}</div></section>
    </main>
  );
}

function PublicBrand() { return <header className="public-brand"><img src="/app-icon.png" alt="القديس أبانوب" /><div><strong>خورس القديس أبانوب</strong><span>تقرير حضور الخورس والقداس</span></div></header>; }
function PublicMetric({ label, value, absent, rate }) { return <article><span>{label}</span><strong>{value}</strong>{absent !== undefined && <small className="public-rate">غياب {absent} · حضور {rate}%</small>}</article>; }
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
  return <section className="visit-reports-page"><section className="reports-hero"><div><p className="section-kicker">ملاحظات الافتقاد</p><h2>سجل ملاحظات الخدام</h2><p>اكتب ملاحظة لباقي الخدام مرتبطة بولد وتاريخ واضح.</p></div></section><form className="panel followup-note-form" onSubmit={save}><label>الولد<select required value={personId} onChange={(event) => setPersonId(event.target.value)}><option value="">اختر الاسم</option>{rows.filter((row) => row.role !== "servant").map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><label>اسم الخادم<select required value={servant} onChange={(event) => setServant(event.target.value)}><option value="">اختر الخادم</option>{rows.filter((row) => row.role === "servant").map((row) => <option key={row.id} value={row.name}>{row.name}</option>)}</select></label><label>النوع<select value={type} onChange={(event) => setType(event.target.value)}><option value="visit">زيارة</option><option value="call">اتصال</option></select></label><label>التاريخ<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label><label className="form-wide">الملاحظة<textarea required rows="3" value={note} onChange={(event) => setNote(event.target.value)} /></label><button className="primary-button" type="submit">حفظ الملاحظة</button></form><section className="table-section"><div className="table-wrap"><table><thead><tr><th>التاريخ</th><th>الولد</th><th>الخادم</th><th>النوع</th><th>الملاحظة</th><th>إجراء</th></tr></thead><tbody>{notes.map((item) => <tr key={item.id}><td>{dateLabel(item.date)}</td><td className="name-cell">{item.name}</td><td>{item.servant}</td><td>{item.type === "visit" ? "زيارة" : "اتصال"}</td><td>{item.note}</td><td><button className="cancel-button" type="button" onClick={async () => { await request(`/api/followup-notes/${item.id}`, { method: "DELETE" }, password); await reload(); }}>حذف</button></td></tr>)}{!notes.length && <tr><td colSpan="6">لا توجد ملاحظات حتى الآن</td></tr>}</tbody></table></div></section></section>;
}

function FollowUpRequestsPage({ requests, request, password, reload }) {
  const statusLabel = { new: "جديد", in_progress: "قيد المتابعة", done: "تم التنفيذ" };
  return <section className="visit-reports-page"><section className="reports-hero"><div><p className="section-kicker">طلبات الأهالي</p><h2>طلبات المتابعة</h2><p>راجع طلبات الاتصال والزيارة وحدث حالتها.</p></div></section><section className="table-section"><div className="table-wrap"><table><thead><tr><th>التاريخ</th><th>الولد</th><th>النوع</th><th>الرسالة</th><th>الحالة</th></tr></thead><tbody>{requests.map((item) => <tr key={item.id}><td>{dateLabel(item.createdAt.slice(0, 10))}</td><td className="name-cell">{item.name}</td><td>{item.type === "call" ? "اتصال" : "زيارة"}</td><td>{item.message || "بدون رسالة"}</td><td><select value={item.status} onChange={async (event) => { await request(`/api/followup-requests/${item.id}`, { method: "PATCH", body: JSON.stringify({ status: event.target.value }) }, password); await reload(); }}>{Object.entries(statusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td></tr>)}{!requests.length && <tr><td colSpan="5">لا توجد طلبات متابعة حتى الآن</td></tr>}</tbody></table></div></section></section>;
}

function NotificationsPage({ notifications, readMap, onOpen, onMarkAllRead }) {
  const unreadCount = notifications.filter((item) => !readMap[item.id]).length;
  return <section className="notification-center">
    <div className="section-title-row notification-center-heading">
      <div><p className="section-kicker">مركز التنبيهات</p><h1>التنبيهات</h1></div>
      <button className="secondary-button" type="button" onClick={onMarkAllRead} disabled={!unreadCount}>تحديد الكل كمقروء</button>
    </div>
    <div className="notification-feed">
      {notifications.map((item) => <article className={`notification-entry ${readMap[item.id] ? "read" : "unread"}`} key={item.id}>
        <span className="notification-entry-mark" aria-hidden="true"><Bell size={17} /></span>
        <div className="notification-entry-content">
          <div className="notification-entry-meta"><span>{item.sourceLabel}</span><time>{dateLabel(item.createdAt.slice(0, 10))}</time></div>
          <h2>{item.title}</h2>
          <p>{item.body}</p>
        </div>
        <button className="notification-open-button" type="button" onClick={() => onOpen(item)}>فتح {item.sourceLabel}</button>
      </article>)}
      {!notifications.length && <p className="empty-row">لا توجد تنبيهات حتى الآن</p>}
    </div>
  </section>;
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
  const [selectedServant, setSelectedServant] = useState("");
  const monthVisited = mode === "visit" ? (state.monthVisitedCount || 0) : checkedCount;
  const monthTotal = mode === "visit" ? (state.monthTotal || state.rows.length) : state.rows.filter((row) => row.role !== "servant").length;
  const monthPercent = monthTotal ? Math.round(monthVisited * 100 / monthTotal) : 0;
  const jumpToCallGroup = (groupNumber) => document.getElementById(`call-group-${groupNumber}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const servantList = useMemo(() => splitServants(servantsText), [servantsText]);
  const servantOptions = useMemo(() => [...new Set([
    ...(state.servants || []),
    ...(state.rows || []).filter((row) => (row.role || "boy") === "servant").map((row) => row.name)
  ].map(canonicalServantName).filter(Boolean))], [state.rows, state.servants]);
  const addServant = (name) => {
    const next = canonicalServantName(name);
    if (!next) return;
    const current = servantList;
    if (!current.includes(next)) setServantsText(splitServants([...current, next].join("\n")).join("\n"));
  };
  const removeServant = (name) => setServantsText(splitServants(servantList.filter((item) => item !== name).join("\n")).join("\n"));
  return <><section className="control-grid">
    {mode === "call" && <article className="panel servants-panel"><div className="panel-heading"><div><p className="section-kicker">قائمة التوزيع</p><h2>مسؤولو الاتصال</h2></div><span className="count-badge">{servantList.length}</span></div>
      <div className="servants-picker"><label>اختر من الخدام الموجودين<select value={selectedServant} onChange={(event) => { const value = event.target.value; setSelectedServant(""); if (value) addServant(value); }}><option value="">اختر خادمًا</option>{servantOptions.map((name) => <option key={name} value={name}>{name}</option>)}</select></label></div>
      <div className="servant-chips">{servantList.length ? servantList.map((name) => <span key={name} className="servant-chip"><span>{name}</span><button type="button" aria-label={`حذف ${name}`} onClick={() => removeServant(name)}>×</button></span>) : <span className="servant-chip empty">لا توجد أسماء</span>}</div>
      <div className="field-hint">إضافة الخادم تتم من إدارة الخورس فقط، ثم يظهر هنا للاختيار. لا يتكرر الاسم في القائمة.</div>
    </article>}
    <article className="panel settings-panel"><div className="panel-heading"><div><p className="section-kicker">{mode === "visit" ? "التاريخ" : "دورة التوزيع"}</p><h2>{mode === "visit" ? "تاريخ الزيارة" : state.distributionNotStarted ? "أول أسبوع قادم" : "الأسبوع الحالي"}</h2></div><span className="week-mark"><CalendarDays size={17} /></span></div>{mode === "visit" ? <><label htmlFor="period-date">تاريخ تسجيل الزيارة</label><input id="period-date" type="date" value={selectedDate} onChange={(event) => { setSelectedDate(event.target.value); load(mode, event.target.value); }} /><div className="period-range">{dateLabel(selectedDate)}</div><label htmlFor="visit-month">شهر متابعة الافتقاد</label><input id="visit-month" type="month" value={selectedDate.slice(0, 7)} onChange={(event) => { const date = `${event.target.value}-01`; setSelectedDate(date); load(mode, date); }} /></> : <><div className="period-range">من {dateLabel(state.selectedWeek)} إلى {dateLabel(state.weekEnd)}<br />{state.distributionNotStarted ? "لم يبدأ التوزيع بعد." : "يتغير تلقائيًا كل 7 أيام."}</div><label htmlFor="rotation-date">بداية أول أسبوع للتوزيع</label><input id="rotation-date" type="date" value={rotationStart} onChange={(event) => setRotationStart(event.target.value)} /><div className="field-hint">اضبطه مرة واحدة. التطبيق يحدد أسبوع اليوم والمسؤولين تلقائيًا.</div><button className="primary-button" disabled={busy} onClick={() => saveFollowUp(true)}>↻ حفظ بداية التوزيع</button></>}</article>
    <article className="panel overview-panel"><div className="panel-heading"><div><p className="section-kicker">ملخص الشهر</p><h2>حالة الافتقاد</h2></div></div><div className="metrics"><div className="metric"><strong>{state.groups.length}</strong><span>جروب</span></div><div className="metric"><strong>{monthTotal}</strong><span>مخدوم</span></div><div className="metric"><strong>{mode === "visit" ? monthVisited : checkedCount}</strong><span>{mode === "visit" ? "تمت زيارتهم هذا الشهر" : "تم الاتصال بهم"}</span></div></div><div className="progress-track"><div className="progress-fill" style={{ width: `${mode === "visit" ? monthPercent : percent}%` }} /></div><div className="progress-label">{mode === "visit" ? `${monthVisited} من ${monthTotal} · متبقي ${Math.max(0, monthTotal - monthVisited)}` : `${checkedCount} من ${monthTotal} · متبقي ${Math.max(0, monthTotal - checkedCount)}`}</div><div className="rotation-label">{mode === "visit" ? "إجمالي الزيارات المسجلة خلال الشهر المختار" : "مسؤول اتصال واحد لكل جروب خلال الأسبوع"}</div></article>
  </section>{mode === "call" && <section className="group-strip"><div className="section-title-row"><div><p className="section-kicker">المتابعة الحالية</p><h2>مسؤولو الاتصال الأسبوعي</h2></div><span className="date-label">{dateLabel(state.selectedWeek)}</span></div><div className="group-cards">{state.groups.map((group) => { const members = state.rows.filter((row) => row.role !== "servant" && row.group === group.number); const checked = members.filter((row) => row.called).length; return <article className={`group-card ${group.servant ? "has-servant" : ""}`} key={group.number} role="button" tabIndex="0" onClick={() => jumpToCallGroup(group.number)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); jumpToCallGroup(group.number); } }}><div className={`group-number tone-${groupTone(group.number)}`}>{group.number}</div><div className="group-info"><span>جروب</span><strong>{group.servant || "لم يُحدد"}</strong><small>{members.length} مخدوم · اتصالات {checked}</small></div></article>; })}</div></section>}</>;
}

function PeopleManager({ state, rows, query, setQuery, busy, editingPerson, personDraft, setPersonDraft, savePerson, editPerson, archivePerson, cancelEdit }) {
  const [scope, setScope] = useState("boy");
  const field = (key) => (event) => setPersonDraft({ ...personDraft, [key]: event.target.value });
  const scopedRows = rows.filter((person) => (person.role || "boy") === scope);
  const duplicates = findDuplicateNames(state.rows || []);
  return <section className="people-layout">{duplicates.length > 0 && <article className="panel duplicate-names-panel"><div className="panel-heading"><div><p className="section-kicker">أسماء متكررة</p><h2>{duplicates.length} اسم متكرر في السجل</h2></div></div><div className="duplicate-names-list">{duplicates.map((group) => <p key={nameKey(group[0].name)}><strong>{group[0].name}</strong> متكرر {group.length} مرات{group.map((person) => ` · ${person.phone1 || "بدون رقم"}`).join("")}</p>)}</div></article>}<article className="panel person-form-panel"><div className="panel-heading"><div><p className="section-kicker">قاعدة بيانات الخورس</p><h2>{editingPerson ? "تعديل بيانات الاسم" : "إضافة ولد أو خادم"}</h2></div><Plus size={19} /></div><form className="person-form" onSubmit={savePerson}><label>الاسم<input value={personDraft.name} onChange={field("name")} required /></label><label>النوع<select value={personDraft.role || "boy"} onChange={field("role")}><option value="boy">ولد</option><option value="servant">خادم</option></select></label><label>رقم الهاتف الأول<input dir="ltr" value={personDraft.phone1} onChange={field("phone1")} /></label><label>رقم الهاتف الثاني<input dir="ltr" value={personDraft.phone2} onChange={field("phone2")} /></label><label className="form-wide">العنوان<input value={personDraft.address} onChange={field("address")} /></label><label className="form-wide">ملاحظات<textarea rows="3" value={personDraft.note} onChange={field("note")} /></label><div className="form-actions"><button className="primary-button" disabled={busy}>{editingPerson ? "حفظ التعديل" : "إضافة الاسم"}</button>{editingPerson && <button type="button" className="cancel-button" onClick={cancelEdit}>إلغاء</button>}</div></form></article><article className="table-section people-table"><div className="section-title-row table-title-row"><div><p className="section-kicker">السجل الحالي</p><div className="segmented-control"><button className={scope === "boy" ? "active" : ""} onClick={() => setScope("boy")}>المخدومين</button><button className={scope === "servant" ? "active" : ""} onClick={() => setScope("servant")}>الخدام</button></div><h2>{scopedRows.length} اسم مسجل</h2></div><label className="search-box"><Search size={17} /><input type="search" placeholder="ابحث بالاسم أو الرقم أو العنوان" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div><div className="table-wrap"><table><thead><tr><th>الاسم</th><th>الجروب</th><th>رقم 1</th><th>رقم 2</th><th>العنوان</th><th>إجراء</th></tr></thead><tbody>{scopedRows.map((person) => <tr className={`group-tone-${groupTone(person.group)}`} key={person.id}><td className="name-cell">{person.name}</td><td><span className="group-pill">{person.group || "—"}</span></td><td dir="ltr">{person.phone1 || "—"}</td><td dir="ltr">{person.phone2 || "—"}</td><td className="address-cell">{person.address ? <a className="map-address-link compact" href={mapsSearchUrl(person.address)} target="_blank" rel="noreferrer" aria-label={`فتح عنوان ${person.name} في خرائط جوجل`}><MapPin size={14} /><span>{person.address}</span></a> : "—"}</td><td className="people-actions"><button className="row-action edit" title="تعديل" onClick={() => editPerson(person)}><Pencil size={15} /></button><button className="row-action delete" title="حذف من المتابعة" onClick={() => archivePerson(person)} disabled={busy}><Trash2 size={15} /></button></td></tr>)}</tbody></table>{!scopedRows.length && <p className="empty-row">لا توجد نتائج</p>}</div></article></section>;
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
function QrManagementPage({ rows, request, scanType, setScanType, scanDate, setScanDate }) {
  const [view, setView] = useState("cards");
  return <section className="qr-management-page"><div className="segmented-control qr-management-tabs" role="tablist" aria-label="إدارة أكواد QR"><button type="button" role="tab" aria-selected={view === "cards"} className={view === "cards" ? "active" : ""} onClick={() => setView("cards")}><QrCode size={16} /> أكواد الأولاد</button><button type="button" role="tab" aria-selected={view === "scan"} className={view === "scan" ? "active" : ""} onClick={() => setView("scan")}><Camera size={16} /> Scan QR</button></div>{view === "cards" ? <QrCardsPage rows={rows} /> : <QrScannerPage request={request} scanType={scanType} setScanType={setScanType} scanDate={scanDate} setScanDate={setScanDate} />}</section>;
}
function QrScannerPage({ request, scanType, setScanType, scanDate, setScanDate }) {
  const [scannerError, setScannerError] = useState("");
  const [status, setStatus] = useState("");
  const [recent, setRecent] = useState([]);
  const settingsRef = useRef({ scanType, scanDate });
  settingsRef.current = { scanType, scanDate };
  useEffect(() => {
    const scanner = new Html5Qrcode("qr-reader");
    const inflight = new Set();
    const lastSaved = new Map();
    const stopScanner = () => scanner.isScanning ? scanner.stop().catch(() => {}) : Promise.resolve();
    scanner.start({ facingMode: "environment" }, { fps: 8, qrbox: { width: 230, height: 230 } }, async (decoded) => {
      const value = String(decoded || "").trim();
      const token = value.includes("/qr/") ? value.split("/qr/").pop().split(/[?#]/)[0] : value;
      if (!token || inflight.has(token)) return;
      const previous = lastSaved.get(token) || 0;
      if (Date.now() - previous < 4000) return;
      inflight.add(token);
      try {
        const result = await request(`/api/qr/${encodeURIComponent(token)}`);
        const person = result?.person || result;
        if (!person?.recordKey) throw new Error("تعذر قراءة QR");
        const { scanType: type, scanDate: date } = settingsRef.current;
        const types = type === "both" ? ["choir", "mass"] : [type];
        for (const attendanceType of types) {
          await request("/api/attendance", { method: "POST", body: JSON.stringify({ type: attendanceType, date, checks: { [person.recordKey]: true } }) });
        }
        lastSaved.set(token, Date.now());
        const label = type === "choir" ? "خورس" : type === "mass" ? "قداس" : "خورس وقداس";
        setStatus(`تم تسجيل حضور ${person.name} في ${label}`);
        setScannerError("");
        setRecent((current) => [{ key: `${person.recordKey}-${Date.now()}`, name: person.name, label }, ...current].slice(0, 8));
      } catch (error) {
        setScannerError(error?.message || "تعذر قراءة QR");
      } finally {
        inflight.delete(token);
      }
    }, () => {}).catch((error) => setScannerError(error?.message || "اسمح للمتصفح باستخدام الكاميرا"));
    return () => { void stopScanner(); };
  }, [request]);
  return <section className="qr-scan-page"><div className="qr-scan-panel"><p className="section-kicker">تسجيل حضور سريع</p><h2>اختار النوع ثم امسح QR</h2><div className="segmented-control qr-scan-type"><button className={scanType === "choir" ? "active" : ""} onClick={() => setScanType("choir")}>خورس</button><button className={scanType === "mass" ? "active" : ""} onClick={() => setScanType("mass")}>قداس</button><button className={scanType === "both" ? "active" : ""} onClick={() => setScanType("both")}>الاتنين</button></div><label className="qr-scan-date">تاريخ الحضور<input type="date" value={scanDate} onChange={(event) => setScanDate(event.target.value)} /></label><p className="qr-scan-hint">أي كود هتمسحه هيتسجل فورًا في {scanType === "choir" ? "الخورس" : scanType === "mass" ? "القداس" : "الخورس والقداس"}، والكاميرا تفضل شغالة عشان تكمل باقي الأسماء.</p><div id="qr-reader" className="qr-reader" />{status && <p className="qr-scan-status">{status}</p>}{scannerError && <p className="login-error">{scannerError}</p>}{recent.length > 0 && <div className="scanned-person qr-recent"><strong>آخر التسجيلات</strong>{recent.map((item) => <small key={item.key}>{item.name} · {item.label}</small>)}</div>}</div></section>;
}

function AttendanceManager({ state, rows, attendanceType, setAttendanceType, attendanceRole, setAttendanceRole, attendanceDate, setAttendanceDate, checks, setChecks, save, markAttendance, onComment, onDeleteComment, busy, query, setQuery }) {
  attendanceChecksForComments = checks;
  const [commentKey, setCommentKey] = useState("");
  const [commentText, setCommentText] = useState("");
  const scopedRows = rows.filter((row) => (row.role || "boy") === attendanceRole);
  const checked = scopedRows.filter((row) => checks[String(row.recordKey)]).length;
  const sortedRows = [...scopedRows].sort((a, b) => normalizeArabic(a.name).localeCompare(normalizeArabic(b.name), "ar"));
  const visibleQuery = normalizeArabic(query).trim().toLocaleLowerCase("ar");
  const visibleRows = sortedRows.filter((row) => normalizeArabic([row.name, row.phone1, row.phone2].filter(Boolean).join(" ")).toLocaleLowerCase("ar").includes(visibleQuery));
  const toggle = (recordKey) => {
    const nextValue = !checks[recordKey];
    setChecks({ ...checks, [recordKey]: nextValue });
    markAttendance(recordKey, nextValue, attendanceType, attendanceDate);
  };
  return <section className="attendance-page"><AttendanceCommentPanel rows={sortedRows} date={attendanceDate} type={attendanceType} save={onComment} remove={onDeleteComment} busy={busy} /><div className="attendance-controls"><label className="search-box attendance-search"><Search size={17} /><input type="search" placeholder="ابحث بالاسم" value={query} onChange={(event) => setQuery(event.target.value)} /></label><div className="segmented-control"><button className={attendanceRole === "boy" ? "active" : ""} onClick={() => setAttendanceRole("boy")}>حضور المخدومين</button><button className={attendanceRole === "servant" ? "active" : ""} onClick={() => setAttendanceRole("servant")}>حضور الخدام</button></div><div className="segmented-control"><button className={attendanceType === "choir" ? "active" : ""} onClick={() => setAttendanceType("choir")}><Church size={16} /> حضور الخورس</button><button className={attendanceType === "mass" ? "active" : ""} onClick={() => setAttendanceType("mass")}><UserCheck size={16} /> حضور القداس</button></div><label>تاريخ الحضور<input type="date" value={attendanceDate} onChange={(event) => setAttendanceDate(event.target.value)} /></label><button className="primary-button attendance-save" disabled={busy} onClick={() => save(checks)}><Check size={16} /> حفظ حضور اليوم</button></div><section className="table-section"><div className="section-title-row table-title-row"><div><p className="section-kicker">{attendanceRole === "servant" ? "الخدام فقط" : "المخدومين فقط"}</p><h2>{attendanceType === "choir" ? "حضور الخورس" : "حضور القداس"}</h2></div><span className="count-badge">{checked} من {scopedRows.length}</span></div><div className="attendance-grid">{visibleRows.map((row, index) => <Fragment key={row.id}>{(() => { const letter = normalizeArabic(row.name).trim().slice(0, 1); const previousLetter = normalizeArabic(visibleRows[index - 1]?.name?.trim() || "").slice(0, 1); const key = String(row.recordKey); return <>{letter !== previousLetter && <div className="attendance-letter">{letter}</div>}<button className={`attendance-person ${checks[key] ? "present" : ""}`} key={row.id} onClick={() => toggle(key)}><span className="attendance-check">{checks[key] ? <Check size={18} /> : null}</span><span className="attendance-name">{row.name}</span><span className="attendance-meta">{attendanceRole === "servant" ? "خادم" : "مخدوم"}</span></button></>})()}</Fragment>)}</div></section></section>;
}

function AttendanceCommentPanel({ rows, date, type, save, remove, busy }) {
  const presentRows = rows.filter((row) => attendanceChecksForComments[String(row.recordKey)]);
  const [personKey, setPersonKey] = useState("");
  const [text, setText] = useState("");
  return <section className="attendance-comment-panel"><div><p className="section-kicker">تعليق على الحضور</p><strong>أضف تعليقًا لولد في هذا اليوم</strong><small>{dateLabel(date)} · {type === "choir" ? "حضور الخورس" : "حضور القداس"}</small></div><select value={personKey} onChange={(event) => setPersonKey(event.target.value)}><option value="">اختر اسم الولد</option>{presentRows.map((row) => <option key={row.recordKey} value={row.recordKey}>{row.name}</option>)}</select><textarea rows="2" value={text} onChange={(event) => setText(event.target.value)} placeholder="اكتب التعليق هنا" /><div className="form-actions"><button type="button" className="primary-button" disabled={!personKey || !text.trim() || busy} onClick={async () => { await save(personKey, text); setText(""); }}>إرسال التعليق</button><button type="button" className="cancel-button" disabled={!personKey || busy} onClick={async () => { await remove(personKey); setText(""); }}>مسح التعليق</button></div></section>;
}

function MembersDirectoryByRole({ rows, query, setQuery, openReport, loading }) {
  const [scope, setScope] = useState("boy");
  const [showStats, setShowStats] = useState(false);
  const [servantPassword, setServantPassword] = useState("");
  const [servantUnlocked, setServantUnlocked] = useState(false);
  const [servantPasswordError, setServantPasswordError] = useState(false);
  const scopedRows = rows.filter((row) => (row.role || "boy") === scope);
  const attendanceSessions = fridaySessionsSinceStart(scope === "servant" ? "2026-10-16" : "2026-10-02");
  const statRows = scope === "servant" ? scopedRows.map((row) => ({ ...row, calls: row.callCount || 0, choir: row.choirCount || 0, mass: row.massCount || 0 })) : [];
  const loadStats = () => setShowStats(true);
  const max = (key) => Math.max(1, ...statRows.map((row) => row[key] || 0));
  const totalCalls = statRows.reduce((sum, row) => sum + row.calls, 0);
  const totalChoir = statRows.reduce((sum, row) => sum + row.choir, 0);
  const totalMass = statRows.reduce((sum, row) => sum + row.mass, 0);
  const activityFor = (row) => row.calls + row.choir + row.mass;
  const averageActivity = statRows.length ? statRows.reduce((sum, row) => sum + activityFor(row), 0) / statRows.length : 0;
  const maxActivity = Math.max(1, ...statRows.map(activityFor));
  const activityCount = (row) => (row.callCount || 0) + (row.choirCount || 0) + (row.massCount || 0);
  const activityAverage = scopedRows.length ? scopedRows.reduce((sum, row) => sum + activityCount(row), 0) / scopedRows.length : 0;
  const activityLabel = (row) => {
    const value = activityCount(row);
    if (activityAverage === 0) return "غير ملتزم";
    if (value >= activityAverage) return "نشط";
    if (value >= activityAverage * 0.5) return "متوسط";
    return "غير ملتزم";
  };
  const openServantReports = () => {
    if (servantUnlocked) { setScope("servant"); return; }
    setServantPassword(""); setServantPasswordError(false); setScope("servant-lock");
  };
  const submitServantPassword = (event) => {
    event.preventDefault();
    if (servantPassword !== "2004") { setServantPasswordError(true); return; }
    setServantUnlocked(true); setServantPasswordError(false); setScope("servant");
  };
  return <section className="table-section members-directory"><div className="section-title-row table-title-row"><div><p className="section-kicker">سجل أفراد الخورس</p><div className="segmented-control"><button className={scope === "boy" ? "active" : ""} onClick={() => setScope("boy")}>المخدومين</button><button className={scope === "servant" || scope === "servant-lock" ? "active" : ""} onClick={openServantReports}>الخدام</button></div><h2>{scope === "boy" ? "تقارير المخدومين" : "تقارير الخدام"}</h2></div>{scope !== "servant-lock" && <div className="table-actions"><label className="search-box"><Search size={17} /><input type="search" placeholder="ابحث بالاسم أو الرقم" value={query} onChange={(event) => setQuery(event.target.value)} /></label>{scope === "servant" && <button className="secondary-button" onClick={() => showStats ? setShowStats(false) : loadStats()}>{showStats ? "إخفاء إحصائيات الخدام" : "إحصائيات الخدام"}</button>}</div>}</div>{scope === "servant-lock" ? <form className="servant-report-lock" onSubmit={submitServantPassword}><label htmlFor="servant-report-password">أدخل كلمة مرور صفحة الخدام</label><input id="servant-report-password" type="password" inputMode="numeric" autoComplete="current-password" value={servantPassword} onChange={(event) => setServantPassword(event.target.value)} autoFocus /><button className="primary-button" type="submit">فتح تقارير الخدام</button>{servantPasswordError && <p role="alert">كلمة المرور غير صحيحة</p>}</form> : <>{scope === "servant" && showStats && <section className="servant-dashboard"><div className="servant-stats"><div><strong>{statRows.length}</strong><span>الخدام الظاهرون</span></div><div><strong>{totalCalls}</strong><span>إجمالي الاتصالات</span></div><div><strong>{totalChoir}</strong><span>حضور الخورس</span></div><div><strong>{totalMass}</strong><span>حضور القداس</span></div></div>{statRows.length ? <div className="servant-chart-grid"><article><h3>الاتصالات حسب الخادم</h3>{statRows.map((row) => <div className="servant-bar" key={`call-${row.id}`}><span>{row.name}</span><i><b style={{ width: `${row.calls * 100 / max("calls")}%` }} /></i><strong>{row.calls}</strong></div>)}</article><article><h3>حضور الخورس والقداس</h3>{statRows.map((row) => <div className="servant-attendance-chart-row" key={`attendance-${row.id}`}><span>{row.name}</span><div><i><b style={{ width: `${row.choir * 100 / max("choir")}%` }} /></i><small>خورس {row.choir}</small><i><b className="attendance" style={{ width: `${row.mass * 100 / max("mass")}%` }} /></i><small>قداس {row.mass}</small></div></div>)}</article><article><h3>مؤشر النشاط مقارنة بمتوسط الخدام</h3><p className="servant-chart-caption">متوسط النشاط: {averageActivity.toFixed(1)} نقطة</p>{statRows.map((row) => <div className="servant-bar" key={`activity-${row.id}`}><span>{row.name}</span><i><b className="activity" style={{ width: `${activityFor(row) * 100 / maxActivity}%` }} /></i><strong>{activityFor(row)}</strong></div>)}</article></div> : <p className="empty-row">لا توجد بيانات خدام مطابقة للبحث</p>}</section>}<div className="table-wrap"><table><thead><tr><th>الاسم</th><th>آخر حضور خورس</th><th>عدد حضور الخورس</th><th>آخر حضور قداس</th><th>عدد حضور القداس</th>{scope === "servant" ? <><th>عدد الاتصالات</th><th>إجمالي النشاط</th><th>الالتزام</th></> : <><th>آخر زيارة</th><th>آخر اتصال</th></>}</tr></thead><tbody>{scopedRows.map((row) => { const attendanceLabel = scope === "servant" ? `${row.choirCount || 0} من ${attendanceSessions}` : `${row.choirCount || 0} من ${attendanceSessions}`; return <tr key={row.id}><td className="name-cell">{scope === "servant" ? <strong>{row.name}</strong> : <button className="person-link" onClick={() => openReport(row)}>{row.name}</button>}</td><td className="history-date">{dateLabel(row.lastChoirDate)}</td><td className="attendance-fraction">{attendanceLabel}</td><td className="history-date">{dateLabel(row.lastMassDate)}</td><td className="attendance-fraction">{row.massCount || 0} من {attendanceSessions}</td>{scope === "servant" ? <><td>{row.callCount || 0}</td><td><strong>{activityCount(row)}</strong></td><td><span className={`servant-activity-badge ${activityLabel(row) === "نشط" ? "active" : activityLabel(row) === "متوسط" ? "medium" : "inactive"}`}>{activityLabel(row)}</span></td></> : <><td className="history-date">{dateLabel(row.lastVisitedDate)}</td><td className="history-date">{dateLabel(row.lastCalledWeek)}</td></>}</tr>; })}</tbody></table>{!scopedRows.length && <p className="empty-row">{loading ? "جاري تحميل البيانات" : "لا توجد أسماء"}</p>}</div></>}</section>;
}

function MembersDirectory({ rows, query, setQuery, openReport, loading }) {
  return <section className="table-section members-directory"><div className="section-title-row table-title-row"><div><p className="section-kicker">سجل أفراد الخورس</p><h2>اضغط على الاسم لفتح التقرير</h2></div><label className="search-box"><Search size={17} /><input type="search" placeholder="ابحث بالاسم أو الرقم" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div><div className="table-wrap"><table><thead><tr><th>الاسم</th><th>النوع</th><th>آخر حضور خورس</th><th>آخر حضور قداس</th><th>آخر زيارة</th>{scope === "servant" ? <><th>عدد الاتصالات</th><th>النشاط</th></> : <th>آخر اتصال</th>}</tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td className="name-cell"><button className="person-link" onClick={() => openReport(row)}>{row.name}</button></td><td>{row.role === "servant" ? "خادم" : "مخدوم"}</td><td className="history-date">{dateLabel(row.lastChoirDate)}</td><td className="history-date">{dateLabel(row.lastMassDate)}</td><td className="history-date">{dateLabel(row.lastVisitedDate)}</td>{scope === "servant" ? <><td>{row.callCount || 0}</td><td><span className={`servant-activity-badge ${row.callCount >= 3 ? "active" : row.callCount > 0 ? "medium" : "inactive"}`}>{row.callCount >= 3 ? "نشط" : row.callCount > 0 ? "متوسط" : "غير ملتزم"}</span></td></> : <td className="history-date">{dateLabel(row.lastCalledWeek)}</td>}</tr>)}</tbody></table>{!rows.length && <p className="empty-row">{loading ? "جاري تحميل البيانات" : "لا توجد أسماء"}</p>}</div></section>;
}

function CallGroupsTable({ rows, query, setQuery, busy, saveFollowUp, updateCheck, openReport, loading }) {
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
  return <section className="table-section call-groups-section"><div className="section-title-row table-title-row"><div><p className="section-kicker">بيانات الافتقاد</p><h2>الاتصال الأسبوعي حسب الجروب</h2></div><div className="table-actions"><label className="search-box"><Search size={17} /><input type="search" placeholder="ابحث بالاسم أو الجروب أو الخادم" value={query} onChange={(event) => setQuery(event.target.value)} /></label><button className="secondary-button" disabled={busy} onClick={() => saveFollowUp()}><Check size={16} /> احفظ الكل</button></div></div><div className="call-groups-list">{groups.map(([group, members]) => <section className="call-group" id={`call-group-${group}`} key={group}><header className={`call-group-heading group-tone-${group}`}><div><span>الجروب</span><strong>{group}</strong></div><div><span>مسؤول الاتصال</span><b>{members[0]?.servant || "غير موزع"}</b></div><small>{members.length} أفراد · تم الاتصال بـ {members.filter((row) => row.called).length}</small><button type="button" className="group-save-button" disabled={busy} onClick={() => saveFollowUp(group)}><Check size={14} /> حفظ المجموعة</button></header><div className="call-group-members">{members.map((row) => <div className="call-member" key={row.id}><span className="call-member-info"><button type="button" className="person-link" onClick={() => openReport(row)}>{row.name}</button><span className="phone-copy-row"><small dir="ltr">رقم 1: {row.phone1 || "بدون رقم"}</small>{row.phone1 && <a className="call-phone" href={`tel:${phoneHref(row.phone1)}`}><Phone size={13} /> اتصل</a>}</span>{row.phone2 && <span className="phone-copy-row"><small dir="ltr">رقم 2: {row.phone2}</small><a className="call-phone" href={`tel:${phoneHref(row.phone2)}`}><Phone size={13} /> اتصل</a></span>}</span><input className="status-check" type="checkbox" checked={row.called} onChange={(event) => updateCheck(row.recordKey, "called", event.target.checked)} aria-label={`تم الاتصال بـ ${row.name}`} /></div>)}</div></section>)}{!groups.length && <p className="empty-row">{loading ? "جاري تحميل البيانات" : "لا توجد نتائج"}</p>}</div></section>;
}

function PeopleTable({ mode, rows, query, setQuery, busy, saveFollowUp, updateCheck, openReport, loading, includeVisitedThisMonth, setIncludeVisitedThisMonth }) {
  phoneDirectory = Object.fromEntries(rows.map((row) => [row.name, row]));
  if (mode === "call") return <CallGroupsTable rows={rows} query={query} setQuery={setQuery} busy={busy} saveFollowUp={saveFollowUp} updateCheck={updateCheck} openReport={openReport} loading={loading} />;
  return <section className="table-section"><div className="section-title-row table-title-row"><div><p className="section-kicker">بيانات الافتقاد</p><h2>{mode === "visit" ? "زيارة البيت" : mode === "call" ? "الاتصال الأسبوعي" : "آخر متابعة"}</h2></div><div className="table-actions"><label className="search-box"><Search size={17} /><input type="search" placeholder="ابحث بالاسم أو الجروب أو الخادم" value={query} onChange={(event) => setQuery(event.target.value)} /></label>{mode === "visit" && <button className="secondary-button month-filter-button" onClick={() => setIncludeVisitedThisMonth(!includeVisitedThisMonth)}>{includeVisitedThisMonth ? "إخفاء من تمت زيارتهم هذا الشهر" : "إظهار من تمت زيارتهم هذا الشهر"}</button>}{mode !== "history" && <button className="secondary-button" disabled={busy} onClick={() => saveFollowUp()}><Check size={16} /> احفظ {mode === "visit" ? "الزيارات" : "الاتصالات"}</button>}</div></div><div className="table-wrap"><table><thead><tr>{mode === "visit" ? <><th>الجروب</th><th>الاسم</th><th>رقم 1</th><th>العنوان</th><th>تمت الزيارة</th><th>آخر زيارة</th></> : mode === "call" ? <><th>الجروب</th><th>الاسم</th><th>رقم 1</th><th>رقم 2</th><th>مسؤول الاتصال</th><th>تم الاتصال</th></> : scope === "servant" ? <><th>الاسم</th><th>حضور الخورس</th><th>حضور القداس</th><th>عدد الاتصالات</th><th>النشاط</th></> : <><th>الجروب</th><th>الاسم</th><th>رقم 1</th><th>آخر زيارة</th><th>آخر اتصال</th><th>آخر خادم اتصل</th></>}</tr></thead><tbody>{rows.map((row) => <tr className={`group-tone-${groupTone(row.group)}`} key={row.id}>{mode === "history" && scope === "servant" ? <><td className="name-cell"><strong>{row.name}</strong></td><td className="history-date">{dateLabel(row.lastChoirDate)}</td><td className="history-date">{dateLabel(row.lastMassDate)}</td><td>{row.callCount || 0}</td><td><span className={`servant-activity-badge ${row.callCount >= 3 ? "active" : row.callCount > 0 ? "medium" : "inactive"}`}>{row.callCount >= 3 ? "نشط" : row.callCount > 0 ? "متوسط" : "غير ملتزم"}</span></td></> : <><td><span className="group-pill">{row.group}</span></td><td className="name-cell">{mode === "history" || mode === "visit" ? <button className="person-link" onClick={() => openReport(row)}>{row.name}</button> : row.name}</td><td className="phone-cell">{mode === "visit" ? <CopyPhone value={row.phone1} name={row.name} /> : row.phone1 || "—"}</td>{mode === "call" ? <td className="phone-cell"><CopyPhone value={row.phone2} name={`${row.name} - رقم 2`} /></td> : null}{mode === "visit" ? <><td className="address-cell">{row.address ? <a className="visit-map-link" href={mapsSearchUrl(row.address)} target="_blank" rel="noreferrer" aria-label={`فتح عنوان ${row.name} في خرائط جوجل`} title="فتح العنوان في خرائط جوجل"><MapPin size={16} /><span>{row.address}</span></a> : "—"}</td><td className="check-cell"><input className="status-check" type="checkbox" checked={row.visited} onChange={(event) => updateCheck(row.recordKey, "visited", event.target.checked)} aria-label={`تمت زيارة ${row.name}`} /></td><td className="history-date">{dateLabel(row.lastVisitedDate)}</td></> : mode === "call" ? <><td><span className={`servant-cell ${row.servant ? "" : "muted"}`}>{row.servant || "غير موزع"}</span></td><td className="check-cell"><input className="status-check" type="checkbox" checked={row.called} onChange={(event) => updateCheck(row.recordKey, "called", event.target.checked)} aria-label={`تم الاتصال بـ ${row.name}`} /></td></> : <><td className="history-date">{dateLabel(row.lastVisitedDate)}</td><td className="history-date">{dateLabel(row.lastCalledWeek)}</td><td><span className="servant-cell">{row.lastCaller || "غير مسجل"}</span></td></>}</>}</tr>)}</tbody></table>{!rows.length && <p className="empty-row">{loading ? "جاري تحميل البيانات" : "لا توجد نتائج"}</p>}</div></section>;
}

function ReportModal({ report, close }) {
  const summary = report.attendanceSummary;
  return <div className="modal"><button className="modal-backdrop" aria-label="إغلاق التقرير" onClick={close} /><section className="report-dialog" role="dialog" aria-modal="true"><button className="modal-close" aria-label="إغلاق" onClick={close}><X size={18} /></button><p className="section-kicker">التقرير التفصيلي للمخدوم</p><h2>{report.person.name}</h2><div className="report-meta">الجروب {report.person.group || "غير مرتبط"} · {report.person.phone1 || "بدون رقم"}</div>{report.person.address && <a className="map-address-link" href={mapsSearchUrl(report.person.address)} target="_blank" rel="noreferrer"><MapPin size={16} /><span>{report.person.address}</span></a>}{summary && <><p className="report-period">الحضور والغياب من ٢ أكتوبر ٢٠٢٦ · {summary.expectedFridays} جمعات</p><div className="report-summary attendance-report-summary"><span>حضور الخورس: <strong>{summary.choirPresent}</strong><small>غياب {summary.choirAbsent} · نسبة الحضور {summary.choirRate}%</small></span><span>حضور القداس: <strong>{summary.massPresent}</strong><small>غياب {summary.massAbsent} · نسبة الحضور {summary.massRate}%</small></span></div></>}<div className="report-summary"><span>زيارات: <strong>{report.events.filter((event) => event.visited).length}</strong></span><span>اتصالات: <strong>{report.events.filter((event) => event.called).length}</strong></span></div><div className="report-table-wrap"><table className="report-table"><thead><tr><th>التاريخ</th><th>زيارة</th><th>اتصال</th><th>خورس</th><th>قداس</th><th>الخادم</th></tr></thead><tbody>{report.events.length ? report.events.map((event) => <tr key={`${event.date}-${event.caller}-${event.choir}-${event.mass}`}><td>{dateLabel(event.date)}</td><td>{event.visited ? "تمت" : "—"}</td><td>{event.called ? "تم" : "—"}</td><td>{event.choir ? "حضر" : "—"}</td><td>{event.mass ? "حضر" : "—"}</td><td>{event.caller || "—"}</td></tr>) : <tr><td colSpan="6">لا يوجد سجل محفوظ لهذا الفرد</td></tr>}</tbody></table></div></section></div>;
}
function AttendanceBar({ label, value, total, tone }) { const width = total ? Math.max(3, value * 100 / total) : 0; return <div className="attendance-bar-item"><div><span>{label}</span><strong>{value}</strong></div><div className="attendance-bar-track"><i className={tone} style={{ width: width + "%" }} /></div></div>; }
function AttendanceDonut({ choir, mass, total }) { const values = [choir, Math.max(0, total - choir), mass, Math.max(0, total - mass)]; const sum = Math.max(1, values.reduce((a, b) => a + b, 0)); const stops = values.map((value, index) => `${["#078b59", "#d28700", "#6989cf", "#e58c8c"][index]} ${values.slice(0, index).reduce((a, b) => a + b, 0) * 100 / sum}% ${values.slice(0, index + 1).reduce((a, b) => a + b, 0) * 100 / sum}%`).join(", "); return <div className="four-donut-wrap"><div className="four-donut" style={{ background: `conic-gradient(${stops})` }}><strong>{Math.round((choir + mass) * 100 / Math.max(1, total * 2))}%</strong></div><div className="donut-legend"><span><i className="green" /> حضور الخورس <b>{choir}</b></span><span><i className="orange" /> غياب الخورس <b>{Math.max(0, total - choir)}</b></span><span><i className="blue" /> حضور القداس <b>{mass}</b></span><span><i className="red" /> غياب القداس <b>{Math.max(0, total - mass)}</b></span></div></div>; }
