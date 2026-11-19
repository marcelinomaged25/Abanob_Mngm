import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  Bell,
  BookOpen,
  CalendarDays,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Church,
  Copy,
  Download,
  ExternalLink,
  Home,
  Languages,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  MapPin,
  Medal,
  Menu,
  MessageCircle,
  Moon,
  Music2,
  Pencil,
  Phone,
  Play,
  Plus,
  QrCode,
  Search,
  Star,
  Sun,
  Trash2,
  Trophy,
  UserCheck,
  Users,
  X,
} from "lucide-react";

const apiUrl = (import.meta.env.VITE_API_URL || "https://abanob-mngm.onrender.com").replace(/\/$/, "");
const apiCacheKey = (path) => `choir-api-cache:${apiUrl}${path}`;
const cacheableApiPath = (path) =>
  /\/api\/(dashboard|analytics|learning-items|books|bible-videos|mass-schedules|followup-notes|followup-requests|whatsapp-template)/.test(
    path,
  );
const readApiCache = (path) => {
  try {
    const saved = JSON.parse(localStorage.getItem(apiCacheKey(path)) || "null");
    return saved && Date.now() - saved.time < 5 * 60 * 1000 ? saved.value : null;
  } catch {
    return null;
  }
};
const writeApiCache = (path, value) => {
  try {
    localStorage.setItem(apiCacheKey(path), JSON.stringify({ time: Date.now(), value }));
  } catch {
    /* storage is optional */
  }
};
const forecastUrl = (import.meta.env.VITE_FORECAST_URL || "").replace(/\/$/, "");
const today = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
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
const followUpNeedPercent = (person) => {
  const attendance = (person.choirCount || 0) + (person.massCount || 0);
  const followUp = (person.visitCount || 0) + (person.callCount || 0);
  const activity = attendance * 2 + followUp;
  return Math.max(0, 100 - Math.min(100, activity * 10));
};
const dateLabel = (value) =>
  value
    ? new Intl.DateTimeFormat("ar-EG", { day: "numeric", month: "long", year: "numeric" }).format(
        new Date(`${value}T12:00:00`),
      )
    : "—";
const weekdayLabel = (value) =>
  value ? new Intl.DateTimeFormat("ar-EG", { weekday: "long" }).format(new Date(`${value}T12:00:00`)) : "";
const isGoogleMapsUrl = (value) => {
  try {
    const url = new URL(String(value || "").trim());
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      (host === "maps.app.goo.gl" ||
        host === "goo.gl" ||
        host === "maps.google.com" ||
        ((host === "google.com" || host.endsWith(".google.com")) && url.pathname.startsWith("/maps")))
    );
  } catch {
    return false;
  }
};
const mapsSearchUrl = (address) => {
  const value = String(address || "").trim();
  return isGoogleMapsUrl(value)
    ? value
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(value)}`;
};
const learningImageUrl = (value) => {
  const source = String(value || "").trim();
  try {
    const url = new URL(source);
    if (url.hostname === "drive.google.com") {
      const fileId = url.pathname.match(/\/file\/d\/([^/]+)/)?.[1] || url.searchParams.get("id");
      if (fileId) return `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w1600`;
    }
  } catch {
    return source;
  }
  return source;
};
const bookDownloadUrl = (value) => {
  const source = String(value || "").trim();
  try {
    const url = new URL(source);
    if (url.hostname === "drive.google.com") {
      const fileId = url.pathname.match(/\/file\/d\/([^/]+)/)?.[1] || url.searchParams.get("id");
      if (fileId) return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
    }
  } catch {
    /* The standard resource link remains the fallback. */
  }
  return source;
};
const normalizeArabic = (value) => String(value || "").replace(/[إأآ]/g, "ا");
const normalizeSearchText = (value) =>
  normalizeArabic(value)
    .replace(/[ىي]/g, "ي")
    .replace(/[ةه]/g, "ه")
    .replace(/[\u064B-\u065F\u0670ـ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("ar");
const canonicalServantName = (value) => {
  const name = String(value || "")
    .trim()
    .replace(/^[أإآا]\s*[/.]\s*/, "");
  const normalized = normalizeArabic(name).replace(/\s+/g, "");
  return ["ميلاد", "ميلد", "ميلادعدلي"].includes(normalized) ? "ميلاد عدلي" : name;
};
const splitServants = (value = "") => [
  ...new Set(String(value).split(/\r?\n/).map(canonicalServantName).filter(Boolean)),
];
const emptyState = { rows: [], groups: [], servants: [], historySummary: [] };
const emptyVisitReports = {
  totalPeople: 0,
  year: new Date().getFullYear(),
  daily: [],
  monthly: [],
  yearly: [],
  totals: { daily: 0, monthly: 0, yearly: 0 },
};
const emptyServiceAnalytics = {
  summary: {},
  monthly: [],
  groups: [],
  servants: [],
  needsAttention: [],
  forecast: null,
};
const defaultWhatsAppTemplate = "أهلاً {{name}}، بنطمن عليك. يا رب تكون بخير.";
const emptyPerson = {
  name: "",
  group: "",
  phone1: "",
  phone2: "",
  address: "",
  note: "",
  role: "boy",
  photoUrl: "",
};
const stored = (key, fallback) => sessionStorage.getItem(key) || fallback;
const storedMap = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key) || "{}");
  } catch {
    return {};
  }
};
function PersonAvatar({ person, name, size = "small" }) {
  const label = name || person?.name || "";
  const [open, setOpen] = useState(false);
  const photoUrl = person?.photoUrl;
  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);
  return (
    <>
      <button
        type="button"
        className={`person-avatar person-avatar-${size} ${photoUrl ? "is-clickable" : ""}`}
        onClick={() => photoUrl && setOpen(true)}
        aria-label={photoUrl ? `تكبير صورة ${label}` : label}
      >
        {photoUrl ? <img src={photoUrl} alt={label} /> : label.slice(0, 1)}
      </button>
      {open && photoUrl && (
        <div
          className="person-photo-lightbox"
          role="dialog"
          aria-label={`صورة ${label}`}
          onClick={() => setOpen(false)}
        >
          <button
            type="button"
            className="person-photo-lightbox-close"
            onClick={() => setOpen(false)}
            aria-label="إغلاق"
          >
            ×
          </button>
          <img src={photoUrl} alt={label} onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </>
  );
}
const publicQrToken = window.location.pathname.match(/^\/qr\/([^/]+)\/?$/)?.[1] || "";
const isAdminPage = window.location.pathname === "/admin" || window.location.pathname.startsWith("/admin/");
const isLearningPage = window.location.pathname === "/learning" || window.location.pathname === "/learning/";
const isBooksPage = window.location.pathname === "/books" || window.location.pathname === "/books/";
const isBiblePage = window.location.pathname === "/bible" || window.location.pathname === "/bible/";
const isMassSchedulePage =
  window.location.pathname === "/mass-schedule" || window.location.pathname === "/mass-schedule/";

function groupTone(group) {
  const number = Number.parseInt(String(group).replace(/\D/g, ""), 10);
  return Number.isFinite(number) ? ((number - 1) % 9) + 1 : 1;
}

function nameKey(value) {
  return normalizeArabic(value).trim().replace(/\s+/g, " ").toLocaleLowerCase("ar");
}

function searchableRowText(row) {
  return normalizeArabic(
    [row.name, row.group, row.phone1, row.phone2, row.address, row.note, row.servant, row.lastCaller]
      .filter(Boolean)
      .join(" "),
  ).toLocaleLowerCase("ar");
}

function searchMatches(text, term) {
  const normalizedText = normalizeSearchText(text);
  const normalizedTerm = normalizeSearchText(term);
  return !normalizedTerm || normalizedText.includes(normalizedTerm);
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
  return [...groups.values()]
    .filter((list) => list.length > 1)
    .sort((a, b) => b.length - a.length || a[0].name.localeCompare(b[0].name, "ar"));
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
  // Older sessions were saved before the username header was required by the API.
  // Keep those sessions compatible with the backend's default username.
  const [username, setUsername] = useState(() => sessionStorage.getItem("choir-username") || "admin");
  const [password, setPassword] = useState(() => sessionStorage.getItem("choir-password") || "");
  const [usernameDraft, setUsernameDraft] = useState("");
  const [passwordDraft, setPasswordDraft] = useState("");
  const [mode, setMode] = useState(() => {
    const savedMode = stored("choir-mode", "home");
    return savedMode === "qr" ? "qr-print" : savedMode;
  });
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
  const [whatsappTemplate, setWhatsappTemplate] = useState(defaultWhatsAppTemplate);
  const [learningItems, setLearningItems] = useState([]);
  const [books, setBooks] = useState([]);
  const [bibleVideos, setBibleVideos] = useState([]);
  const [massSchedules, setMassSchedules] = useState([]);
  const [visitReports, setVisitReports] = useState(emptyVisitReports);
  const [serviceAnalytics, setServiceAnalytics] = useState(emptyServiceAnalytics);
  const [followUpNotes, setFollowUpNotes] = useState([]);
  const [followUpRequests, setFollowUpRequests] = useState([]);
  const [notificationItems, setNotificationItems] = useState([]);
  const [notificationReadMap, setNotificationReadMap] = useState({});
  const [notificationDismissedMap, setNotificationDismissedMap] = useState(() =>
    storedMap(`choir-notification-dismissed-${sessionStorage.getItem("choir-username") || ""}`),
  );
  const [notificationPermission, setNotificationPermission] = useState(() =>
    "Notification" in window ? Notification.permission : "unsupported",
  );
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

  const request = useCallback(
    async (path, options = {}, auth = password, user = username) => {
      const isGet = !options.method || options.method.toUpperCase() === "GET";
      const cached = isGet && cacheableApiPath(path) ? readApiCache(path) : null;
      if (cached !== null) return cached;
      const requestOptions = {
        ...options,
        headers: {
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(auth ? { "X-App-Password": auth } : {}),
          ...(user || "admin" ? { "X-App-Username": user || "admin" } : {}),
          ...options.headers,
        },
      };
      let response;
      let lastNetworkError;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          response = await fetch(`${apiUrl}${path}`, requestOptions);
          break;
        } catch (fetchError) {
          lastNetworkError = fetchError;
          if (attempt === 2) {
            throw new Error(
              `تعذر الاتصال بالخادم أثناء تحميل ${path} (${fetchError?.message || "Network error"})`,
            );
          }
          await new Promise((resolve) => window.setTimeout(resolve, 700 * (attempt + 1)));
        }
      }
      if (!response) throw lastNetworkError || new Error("تعذر الاتصال بالخادم");
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message =
          response.status === 401
            ? "اسم المستخدم أو كلمة المرور غير صحيحة"
            : response.status === 400
              ? "البيانات المدخلة غير صحيحة، راجعها وحاول مرة أخرى"
              : response.status === 403
                ? "ليس لديك صلاحية لتنفيذ هذا الطلب"
                : body.error || "تعذر إكمال الطلب، حاول مرة أخرى";
        throw new Error(message);
      }
      if (isGet && cacheableApiPath(path)) writeApiCache(path, body);
      if (!isGet && path.startsWith("/api/followup-notes"))
        localStorage.removeItem(apiCacheKey("/api/followup-notes"));
      if (!isGet) {
        ["/api/learning-items", "/api/books", "/api/bible-videos", "/api/mass-schedules"].forEach((cachePath) => {
          if (path.startsWith(cachePath)) localStorage.removeItem(apiCacheKey(cachePath));
        });
      }
      return body;
    },
    [password, username],
  );

  const load = useCallback(
    async (
      nextMode = mode,
      date = selectedDate,
      auth = password,
      monthOverride = trendMonth,
      attendanceTypeOverride = attendanceType,
    ) => {
      if (!auth) return;
      setLoading(true);
      setError("");
      try {
        if (nextMode === "home") {
          const result = await request(
            `/api/dashboard?date=${date || today()}&month=${monthOverride}`,
            {},
            auth,
          );
          setDashboard(result);
          setDashboardDate(result.selectedDate);
          setTrendMonth(result.trendMonth || monthOverride);
          return;
        }
        if (nextMode === "stray") {
          const [result, template] = await Promise.all([
            request(`/api/dashboard?date=${date || today()}&month=${monthOverride}`, {}, auth),
            request("/api/whatsapp-template", {}, auth),
          ]);
          setDashboard(result);
          setDashboardDate(result.selectedDate);
          setTrendMonth(result.trendMonth || monthOverride);
          setWhatsappTemplate(template.message || defaultWhatsAppTemplate);
          return;
        }
        if (nextMode === "reports") {
          const selectedMonth = monthOverride || reportMonth;
          const selectedYear = selectedMonth.slice(0, 4);
          setVisitReports(
            await request(`/api/visit-reports?year=${selectedYear}&month=${selectedMonth}`, {}, auth),
          );
          return;
        }
        if (nextMode === "analytics") {
          try {
            setServiceAnalytics(await request("/api/analytics", {}, auth));
          } catch {
            // Keep analytics usable with legacy deployments: dashboard already
            // contains the historical totals and per-person activity.
            const legacy = await request(
              `/api/dashboard?date=${date || today()}&month=${monthOverride}`,
              {},
              auth,
            );
            const people = legacy.people || [];
            const boys = people.filter((person) => person.role !== "servant");
            const servants = people.filter((person) => person.role === "servant");
            const groupMap = new Map();
            boys.forEach((person) => {
              const group = person.group || "غير محدد";
              const row = groupMap.get(group) || { group, boys: 0, choir: 0, mass: 0, followUp: 0 };
              row.boys += 1;
              row.choir += person.choirCount || 0;
              row.mass += person.massCount || 0;
              row.followUp += person.visitCount || 0;
              groupMap.set(group, row);
            });
            const totalSessions = Math.max(
              1,
              ...boys.map((person) => person.choirCount || 0),
              ...boys.map((person) => person.massCount || 0),
            );
            const monthlyMap = new Map();
            (legacy.calendar || []).forEach((item) => {
              const month = String(item.date || "").slice(0, 7);
              if (!month) return;
              const row = monthlyMap.get(month) || { month, choir: 0, mass: 0, visits: 0, calls: 0 };
              row.choir += item.choir || 0;
              row.mass += item.mass || 0;
              row.visits += item.visits || 0;
              row.calls += item.calls || 0;
              monthlyMap.set(month, row);
            });
            const needsAttention = boys
              .map((person) => ({
                recordKey: person.recordKey,
                name: person.name,
                group: person.group || "",
                photoUrl: person.photoUrl || "",
                choirRate: Math.round(((person.choirCount || 0) * 100) / totalSessions),
                massRate: Math.round(((person.massCount || 0) * 100) / totalSessions),
                followUpRate: Math.min(
                  100,
                  Math.round(
                    (((person.visitCount || 0) + (person.callCount || 0)) * 100) / Math.max(1, totalSessions),
                  ),
                ),
                activity:
                  (person.choirCount || 0) +
                  (person.massCount || 0) +
                  (person.visitCount || 0) +
                  (person.callCount || 0),
              }))
              .sort((a, b) => a.activity - b.activity || a.name.localeCompare(b.name, "ar"))
              .slice(0, 12)
              .map(({ activity, ...person }) => person);
            setServiceAnalytics({
              summary: {
                startedAt: legacy.calendar?.at(-1)?.date || "",
                boys: boys.length,
                servants: servants.length,
                choirAttendance: legacy.summary?.choirAttendance || 0,
                massAttendance: legacy.summary?.massAttendance || 0,
                visits: legacy.summary?.visits || 0,
                calls: legacy.summary?.calls || 0,
                choirRate: Math.round(
                  ((legacy.summary?.choirAttendance || 0) * 100) / Math.max(1, boys.length * totalSessions),
                ),
                massRate: Math.round(
                  ((legacy.summary?.massAttendance || 0) * 100) / Math.max(1, boys.length * totalSessions),
                ),
              },
              monthly: [...monthlyMap.values()].sort((a, b) => a.month.localeCompare(b.month)),
              groups: [...groupMap.values()].map((row) => ({
                group: row.group,
                boys: row.boys,
                choirRate: Math.round((row.choir * 100) / Math.max(1, row.boys * totalSessions)),
                massRate: Math.round((row.mass * 100) / Math.max(1, row.boys * totalSessions)),
                followUpRate: Math.round((row.followUp * 100) / Math.max(1, row.boys)),
              })),
              servants: servants.map((person) => ({
                name: person.name,
                calls: person.callCount || 0,
                choir: person.choirCount || 0,
                mass: person.massCount || 0,
              })),
              needsAttention,
            });
          }
          if (forecastUrl) {
            try {
              const forecastResponse = await fetch(`${forecastUrl}/predict`);
              if (forecastResponse.ok) {
                const forecast = await forecastResponse.json();
                setServiceAnalytics((current) => ({ ...current, forecast }));
              }
            } catch {
              // Forecasting is optional; historical analytics must remain available.
            }
          }
          return;
        }
        if (nextMode === "notes") {
          setFollowUpNotes(await request("/api/followup-notes", {}, auth));
          return;
        }
        if (nextMode === "requests") {
          setFollowUpRequests(await request("/api/followup-requests", {}, auth));
          return;
        }
        if (nextMode === "learning-admin") {
          setLearningItems(await request("/api/learning-items", {}, auth));
          return;
        }
        if (nextMode === "books-admin") {
          setBooks(await request("/api/books", {}, auth));
          return;
        }
        if (nextMode === "bible-admin") {
          setBibleVideos(await request("/api/bible-videos", {}, auth));
          return;
        }
        if (nextMode === "mass-admin") {
          setMassSchedules(await request("/api/mass-schedules", {}, auth));
          return;
        }
        if (nextMode === "content-admin") return;
        if (nextMode === "notifications") return;
        if (nextMode === "attendance") {
          const result = await request(
            `/api/attendance?type=${attendanceTypeOverride}&date=${date || today()}`,
            {},
            auth,
          );
          const directory = await request("/api/state?mode=visit", {}, auth);
          const attendedKeys = new Set((result.attended || []).map(String));
          setState(directory);
          setAttendanceDate(result.date);
          setAttendanceChecks(
            Object.fromEntries(
              (directory.rows || [])
                .filter((row) => attendedKeys.has(String(row.recordKey)))
                .map((row) => [String(row.recordKey), true]),
            ),
          );
          return;
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
        if (loadError.message.includes("401")) {
          sessionStorage.removeItem("choir-password");
          sessionStorage.removeItem("choir-username");
          setPassword("");
          setUsername("");
        }
      } finally {
        setLoading(false);
      }
    },
    [attendanceType, mode, password, reportMonth, request, selectedDate],
  );

  useEffect(() => {
    if (password && username && mode !== "evaluation") {
      load(mode, mode === "attendance" ? attendanceDate : selectedDate, password);
    }
  }, [password, username]);

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
    } catch {
      /* Ignore invalid notification state and establish a fresh baseline. */
    }

    const pollRequests = async () => {
      try {
        const [requests, serviceNotifications] = await Promise.all([
          request("/api/followup-requests"),
          request("/api/notifications"),
        ]);
        if (stopped) return;
        setFollowUpRequests(requests);
        const notifications = [...parentRequestNotifications(requests), ...serviceNotifications].sort(
          (a, b) => String(b.date || "").localeCompare(String(a.date || "")),
        );
        setNotificationItems(notifications);
        try {
          const savedState = localStorage.getItem(storageKey);
          if (savedState !== null) readMap = JSON.parse(savedState);
        } catch {
          /* Keep the last valid notification state. */
        }
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
              alert.onclick = () => {
                window.focus();
                openNotification(item);
                alert.close();
              };
            });
          } else {
            setNotice(
              incoming.length === 1
                ? `${newest.title}: ${newest.body}`
                : `وصلت ${incoming.length} تنبيهات جديدة`,
            );
          }
        }
        readMap = nextReadMap;
        setNotificationReadMap(readMap);
        localStorage.setItem(storageKey, JSON.stringify(readMap));
        initialized = true;
      } catch {
        /* Keep the last badge count; retry on the next poll. */
      }
    };

    pollRequests();
    const interval = window.setInterval(pollRequests, 5000);
    const onVisibilityChange = () => {
      if (!document.hidden) pollRequests();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [password, request, username]);

  const searchIndex = useMemo(
    () => state.rows.map((row) => ({ row, text: searchableRowText(row) })),
    [state.rows],
  );
  const searchTerm = useMemo(() => normalizeSearchText(query), [query]);
  const rows = useMemo(
    () => searchIndex.filter(({ text }) => searchMatches(text, searchTerm)).map(({ row }) => row),
    [searchIndex, searchTerm],
  );
  const visitRows = useMemo(
    () =>
      searchIndex
        .filter(
          ({ row, text }) =>
            (includeVisitedThisMonth ? row.visitedThisMonth : !row.visitedThisMonth) &&
            searchMatches(text, searchTerm),
        )
        .map(({ row }) => row),
    [includeVisitedThisMonth, searchIndex, searchTerm],
  );
  const followUpRows = state.rows.filter((row) => row.role !== "servant");
  const checkedCount = followUpRows.filter((row) => (mode === "visit" ? row.visited : row.called)).length;
  const percent = followUpRows.length ? Math.round((checkedCount * 100) / followUpRows.length) : 0;
  const followUpMode = mode === "visit" || mode === "call";
  const visibleNotificationItems = notificationItems.filter((item) => !notificationDismissedMap[item.id]);
  const unreadNotificationCount = visibleNotificationItems.filter(
    (item) => !notificationReadMap[item.id],
  ).length;

  async function login(event) {
    event.preventDefault();
    const candidateUsername = usernameDraft.trim();
    const candidate = passwordDraft.trim();
    if (!candidateUsername || !candidate) return;
    setBusy(true);
    setError("");
    sessionStorage.setItem("choir-username", candidateUsername);
    sessionStorage.setItem("choir-password", candidate);
    setUsername(candidateUsername);
    setPassword(candidate);
    setNotificationDismissedMap(storedMap(`choir-notification-dismissed-${candidateUsername}`));
    try {
      await request("/api/session", {}, candidate, candidateUsername);
      const result = await request(
        `/api/dashboard?date=${today()}&month=${today().slice(0, 7)}`,
        {},
        candidate,
        candidateUsername,
      );
      setDashboard(result);
      setDashboardDate(result.selectedDate);
      setTrendMonth(result.trendMonth || today().slice(0, 7));
      const followUp = await request(
        `/api/state?mode=visit&date=${today()}`,
        {},
        candidate,
        candidateUsername,
      );
      setState(followUp);
      setSelectedDate(followUp.selectedDate);
      setRotationStart(followUp.rotationStart || "");
      setServantsText((followUp.servants || []).join("\n"));
    } catch (loginError) {
      sessionStorage.removeItem("choir-password");
      sessionStorage.removeItem("choir-username");
      setPassword("");
      setUsername("");
      setError(loginError.message);
    } finally {
      setBusy(false);
    }
  }

  function switchMode(nextMode) {
    setMode(nextMode);
    sessionStorage.setItem("choir-mode", nextMode);
    setQuery("");
    setReport(null);
    if (nextMode === "people") {
      setEditingPerson(null);
      setPersonDraft(emptyPerson);
    }
    if (nextMode === "notifications" || nextMode === "evaluation" || nextMode === "content-admin") return;
    if (nextMode === "attendance") load(nextMode, attendanceDate);
    else if (nextMode === "home" || nextMode === "stray") load(nextMode, dashboardDate);
    else if (
      nextMode === "reports" ||
      nextMode === "analytics" ||
      nextMode === "learning-admin" ||
      nextMode === "books-admin" ||
      nextMode === "bible-admin" ||
      nextMode === "mass-admin"
    )
      load(nextMode);
    else if (nextMode === "qr") {
      /* scanner saves attendance incrementally */
    } else if (nextMode === "qr-print") load("people");
    else load(nextMode, nextMode === "visit" ? selectedDate : undefined);
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
    const nextReadMap = {
      ...notificationReadMap,
      ...Object.fromEntries(notificationItems.map((item) => [item.id, true])),
    };
    setNotificationReadMap(nextReadMap);
    localStorage.setItem(`choir-notification-read-state-${username}`, JSON.stringify(nextReadMap));
  }

  function clearNotifications() {
    const nextDismissedMap = {
      ...notificationDismissedMap,
      ...Object.fromEntries(notificationItems.map((item) => [item.id, true])),
    };
    const nextReadMap = {
      ...notificationReadMap,
      ...Object.fromEntries(notificationItems.map((item) => [item.id, true])),
    };
    setNotificationDismissedMap(nextDismissedMap);
    setNotificationReadMap(nextReadMap);
    localStorage.setItem(`choir-notification-dismissed-${username}`, JSON.stringify(nextDismissedMap));
    localStorage.setItem(`choir-notification-read-state-${username}`, JSON.stringify(nextReadMap));
  }

  async function markAttendance(recordKey, present, type = attendanceType, date = attendanceDate) {
    try {
      await request("/api/attendance", {
        method: "POST",
        body: JSON.stringify({ type, date, checks: { [recordKey]: present } }),
      });
    } catch (saveError) {
      setError(saveError.message);
    }
  }

  async function exportCsv() {
    try {
      const response = await fetch(`${apiUrl}/api/export/visits`, {
        headers: { "X-App-Password": password, "X-App-Username": username },
      });
      if (!response.ok) throw new Error("تعذر تصدير التقرير");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `follow-up-visits-${today()}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      setNotice("تم تصدير التقرير");
    } catch (exportError) {
      setError(exportError.message);
    }
  }

  async function exportFullReports() {
    try {
      const response = await fetch(`${apiUrl}/api/export/full-reports.xlsx`, {
        headers: { "X-App-Password": password, "X-App-Username": username },
      });
      if (!response.ok) throw new Error("تعذر تجهيز التقرير الكامل");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `choir-reports-${today()}.xlsx`;
      link.click();
      URL.revokeObjectURL(url);
      setNotice("تم تنزيل ملف Excel الكامل");
    } catch (exportError) {
      setError(exportError.message || "تعذر تنزيل التقرير الكامل");
    }
  }

  function updateCheck(recordKey, field, checked) {
    setState((current) => ({
      ...current,
      rows: current.rows.map((row) => (row.recordKey === recordKey ? { ...row, [field]: checked } : row)),
    }));
  }

  async function saveFollowUp(assign = false, groupFilter = "") {
    if (typeof assign === "string") {
      groupFilter = assign;
      assign = false;
    }
    setBusy(true);
    setNotice("");
    setError("");
    try {
      let result;
      if (mode === "visit") {
        const checks = Object.fromEntries(
          state.rows
            .filter((row) => row.role !== "servant")
            .map((row) => [row.recordKey, row.visited === true]),
        );
        result = await request("/api/visits", {
          method: "POST",
          body: JSON.stringify({ date: selectedDate, checks }),
        });
      } else {
        const checks = Object.fromEntries(
          state.rows
            .filter((row) => row.role !== "servant" && (!groupFilter || row.group === groupFilter))
            .map((row) => [row.recordKey, row.called === true]),
        );
        const servants = servantsText
          .split(/\r?\n/)
          .map((name) => name.trim())
          .filter(Boolean);
        result = await request("/api/calls", {
          method: "POST",
          body: JSON.stringify({ rotationStart, servants, checks, redistribute: assign }),
        });
      }
      setState(result);
      setRotationStart(result.rotationStart || rotationStart);
      setServantsText((result.servants || []).join("\n"));
      if (mode === "call") await load("history");
      setNotice(assign ? "تم حفظ دورة التوزيع" : "تم حفظ العلامات");
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setBusy(false);
    }
  }

  async function savePerson(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request(editingPerson ? `/api/people/${editingPerson.id}` : "/api/people", {
        method: editingPerson ? "PUT" : "POST",
        body: JSON.stringify(personDraft),
      });
      setNotice(editingPerson ? "تم تعديل بيانات الاسم" : "تمت إضافة الاسم");
      setEditingPerson(null);
      setPersonDraft(emptyPerson);
      await load("people");
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setBusy(false);
    }
  }

  async function uploadPersonPhoto(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("upload_preset", "abanob_uploads");
      const response = await fetch("https://api.cloudinary.com/v1_1/jtzr0bnj/image/upload", {
        method: "POST",
        body,
      });
      const result = await response.json();
      if (!response.ok || !result.secure_url) throw new Error(result.error?.message || "تعذر رفع الصورة");
      setPersonDraft((current) => ({ ...current, photoUrl: result.secure_url }));
      if (editingPerson?.id) {
        await request(`/api/people/${editingPerson.id}/photo`, {
          method: "PATCH",
          body: JSON.stringify({ photoUrl: result.secure_url }),
        });
        await load("people");
      }
      setNotice("تم رفع الصورة، اضغط حفظ لإتمام البيانات");
    } catch (uploadError) {
      setError(uploadError.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveAttendance(checksToSave = attendanceChecks, refresh = true) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request("/api/attendance", {
        method: "POST",
        body: JSON.stringify({ type: attendanceType, date: attendanceDate, checks: checksToSave }),
      });
      setNotice("تم حفظ الحضور");
      if (refresh) {
        await load("attendance", attendanceDate);
        await load("home", dashboardDate, password, trendMonth);
      }
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setBusy(false);
    }
  }

  async function archivePerson(person) {
    if (!window.confirm(`سيتم إخفاء ${person.name} من المتابعة مع الاحتفاظ بسجله. هل تريد المتابعة؟`)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request(`/api/people/${person.id}`, { method: "DELETE" });
      if (editingPerson?.id === person.id) {
        setEditingPerson(null);
        setPersonDraft(emptyPerson);
      }
      setNotice("تم حذف الاسم من المتابعة");
      await load("people");
    } catch (deleteError) {
      setError(deleteError.message);
    } finally {
      setBusy(false);
    }
  }

  function editPerson(person) {
    setEditingPerson(person);
    setPersonDraft({
      name: person.name || "",
      group: person.group || "",
      phone1: person.phone1 || "",
      phone2: person.phone2 || "",
      address: person.address || "",
      note: person.note || "",
      role: person.role || "boy",
      photoUrl: person.photoUrl || "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function openReport(person) {
    try {
      setReport(await request(`/api/history/${person.id}`));
    } catch (reportError) {
      setError(reportError.message);
    }
  }

  if (publicQrToken) return <PublicAttendancePage token={publicQrToken} />;
  if (isLearningPage) return <PublicLearningPage />;
  if (isBooksPage) return <PublicBooksPage />;
  if (isBiblePage) return <PublicBiblePage />;
  if (isMassSchedulePage) return <PublicMassSchedulePage />;
  if (window.location.pathname === "/life-of-saint-abanoub") return <SaintAbanoubStoryPage />;
  if (window.location.pathname === "/league") return <PublicLeaguePage />;
  if (!isAdminPage) return <PublicParentHome />;
  if (!password || !username)
    return (
      <main className="login-screen">
        <PublicNavigation subtitle="دخول الخدام" />
        <form className="login-panel" onSubmit={login}>
          <div className="login-brand">
            <img src="/saint-abanoub.png" alt="القديس أبانوب" />
          </div>
          <p className="eyebrow">خورس القديس أبانوب</p>
          <h1>خورس القديس أبانوب</h1>
          <label htmlFor="app-username">اسم المستخدم</label>
          <input
            id="app-username"
            type="text"
            autoComplete="username"
            value={usernameDraft}
            onChange={(event) => setUsernameDraft(event.target.value)}
            required
            autoFocus
            placeholder="admin"
          />
          <label htmlFor="app-password">كلمة المرور</label>
          <input
            id="app-password"
            type="password"
            autoComplete="current-password"
            value={passwordDraft}
            onChange={(event) => setPasswordDraft(event.target.value)}
            required
          />
          <button className="primary-button" disabled={busy}>
            {busy ? <LoaderCircle size={17} className="spin" /> : null} دخول
          </button>
          {error && <p className="login-error">{error}</p>}
          <a className="login-back-link" href="/">
            العودة إلى بحث الأهالي
          </a>
        </form>
      </main>
    );

  const navItem = (nextMode, icon, label) => (
    <button
      className={`sidebar-item ${
        mode === nextMode ||
        (nextMode === "content-admin" &&
          ["learning-admin", "books-admin", "bible-admin", "mass-admin"].includes(mode)) ||
        (nextMode === "visit" && ["visit", "call", "reports", "notes", "requests"].includes(mode))
          ? "active"
          : ""
      }`}
      onClick={() => {
        setMobileNavOpen(false);
        switchMode(nextMode);
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
  return (
    <main className={`app-shell mode-${mode} ${darkMode ? "dark-mode" : ""}`}>
      {mobileNavOpen && (
        <button
          className="mobile-sidebar-backdrop"
          type="button"
          aria-label="إغلاق القائمة"
          onClick={() => setMobileNavOpen(false)}
        />
      )}
      <aside
        id="mobile-app-sidebar"
        className={`app-sidebar ${mobileNavOpen ? "mobile-open" : ""}`}
        aria-label="قائمة صفحات الإدارة"
      >
        <div className="sidebar-brand">
          <img src="/saint-abanoub.png" alt="القديس أبانوب" />
          <div>
            <strong>خورس القديس أبانوب</strong>
            <span>إدارة الخدمة</span>
          </div>
          <button
            className="mobile-sidebar-close"
            type="button"
            aria-label="إغلاق القائمة"
            onClick={() => setMobileNavOpen(false)}
          >
            <X size={19} />
          </button>
        </div>
        <p className="sidebar-label">أقسام لوحة الإدارة</p>
        <nav className="sidebar-nav">
          {navItem("home", <LayoutDashboard size={17} />, "نظرة عامة")}
          {navItem("attendance", <UserCheck size={17} />, "الحضور والغياب")}
          {navItem("visit", <Home size={17} />, "الافتقاد")}
          {navItem("stray", <img className="sheep-icon" src="/sheep-icon.svg" alt="" />, "الخروف الضال")}
          {navItem("history", <Users size={17} />, "أفراد الخورس")}
          {navItem("people", <Pencil size={17} />, "إدارة الخورس")}
          {navItem("content-admin", <BookOpen size={17} />, "إدارة المناهج والقداسات")}
          {navItem("evaluation", <Star size={17} />, "تقييم الأولاد")}
          {navItem("qr-print", <QrCode size={17} />, "QR الأولاد")}
          <button
            className={`sidebar-item notification-item ${mode === "notifications" ? "active" : ""}`}
            type="button"
            onClick={() => {
              setMobileNavOpen(false);
              openNotifications();
            }}
            title={
              notificationPermission === "granted"
                ? "مركز التنبيهات · إشعارات المتصفح مفعّلة"
                : "مركز التنبيهات · تفعيل إشعارات المتصفح"
            }
          >
            <Bell size={17} />
            <span>التنبيهات</span>
            {unreadNotificationCount > 0 && (
              <b className="notification-count">
                {Math.min(99, unreadNotificationCount)}
                {unreadNotificationCount > 99 ? "+" : ""}
              </b>
            )}
          </button>
          {navItem("analytics", <BarChart3 size={17} />, "تحليلات الخدمة")}
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-footer-actions">
            <button className="theme-toggle" type="button" onClick={() => setDarkMode((value) => !value)}>
              <span>{darkMode ? "الوضع الفاتح" : "الوضع الداكن"}</span>
              {darkMode ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <a
              className="logout-button"
              href="/"
              title="تسجيل الخروج والعودة للرئيسية"
              aria-label="تسجيل الخروج والعودة للرئيسية"
              onClick={() => {
                sessionStorage.removeItem("choir-password");
                sessionStorage.removeItem("choir-username");
              }}
            >
              <LogOut size={15} />
              <span>خروج</span>
            </a>
          </div>
        </div>
      </aside>
      <section className="app-content">
        <div className="mobile-app-header">
          <div className="mobile-brand">
            <img src="/saint-abanoub.png" alt="القديس أبانوب" />
            <div>
              <strong>خورس القديس أبانوب</strong>
              <span>إدارة الخدمة</span>
            </div>
          </div>
          <div className="global-header-actions">
            <a className="global-home-link" href="/" aria-label="العودة للصفحة الرئيسية">
              <Home size={17} />
              <span>الرئيسية</span>
            </a>
            <button
              className="global-menu-button"
              type="button"
              aria-label="فتح القائمة"
              aria-controls="mobile-app-sidebar"
              aria-expanded={mobileNavOpen}
              onClick={() => setMobileNavOpen(true)}
            >
              <Menu size={22} />
            </button>
          </div>
        </div>
        <header className="topbar">
          <div className="topbar-verse">
            <span>«اذْهَبِ انْظُرْ سَلاَمَةَ إِخْوَتِكَ، وَسَلاَمَةَ الْغَنَمِ وَرُدَّ لِي خَبَرًا»</span>
          </div>
          <div className="top-actions">
            {mode === "reports" && (
              <button className="copy-phone" title="تصدير التقرير" onClick={exportCsv}>
                <Copy size={14} />
              </button>
            )}
            <span className="save-state">
              {loading ? "جاري التحميل" : busy ? "جاري الحفظ" : notice || "جاهز"}
            </span>
          </div>
        </header>
        {mode === "visit" && state.verse && (
          <section className="verse-band">
            <p>{state.verse}</p>
          </section>
        )}
        {mode === "visit" ||
        mode === "call" ||
        mode === "reports" ||
        mode === "notes" ||
        mode === "requests" ? (
          <div className="sub-tabs">
            <button className={mode === "visit" ? "active" : ""} onClick={() => switchMode("visit")}>
              <Home size={15} /> زيارة البيت
            </button>
            <button className={mode === "call" ? "active" : ""} onClick={() => switchMode("call")}>
              <Phone size={15} /> الاتصال الأسبوعي
            </button>
            <button className={mode === "reports" ? "active" : ""} onClick={() => switchMode("reports")}>
              <BarChart3 size={15} /> تقارير الافتقاد
            </button>
            <button className={mode === "notes" ? "active" : ""} onClick={() => switchMode("notes")}>
              <Pencil size={15} /> ملاحظات الافتقاد
            </button>
            <button className={mode === "requests" ? "active" : ""} onClick={() => switchMode("requests")}>
              <Phone size={15} /> طلبات الأهالي
            </button>
          </div>
        ) : null}

        {followUpMode && (
          <FollowUpDashboard
            mode={mode}
            state={state}
            selectedDate={selectedDate}
            setSelectedDate={(date) => {
              setSelectedDate(date);
              sessionStorage.setItem("choir-selected-date", date);
            }}
            rotationStart={rotationStart}
            setRotationStart={setRotationStart}
            servantsText={servantsText}
            setServantsText={setServantsText}
            busy={busy}
            saveFollowUp={saveFollowUp}
            load={load}
            checkedCount={checkedCount}
            percent={percent}
          />
        )}
        {mode === "people" && (
          <PeopleManager
            state={state}
            rows={rows}
            query={query}
            setQuery={setQuery}
            busy={busy}
            editingPerson={editingPerson}
            personDraft={personDraft}
            setPersonDraft={setPersonDraft}
            savePerson={savePerson}
            uploadPersonPhoto={uploadPersonPhoto}
            editPerson={editPerson}
            archivePerson={archivePerson}
            cancelEdit={() => {
              setEditingPerson(null);
              setPersonDraft(emptyPerson);
            }}
          />
        )}
        {mode === "attendance" && (
          <AttendanceManager
            state={state}
            rows={rows}
            attendanceType={attendanceType}
            setAttendanceType={(type) => {
              setAttendanceType(type);
              load("attendance", attendanceDate, password, trendMonth, type);
            }}
            attendanceRole={attendanceRole}
            setAttendanceRole={(role) => {
              setAttendanceRole(role);
              setAttendanceChecks({});
            }}
            attendanceDate={attendanceDate}
            setAttendanceDate={(date) => {
              setAttendanceDate(date);
              sessionStorage.setItem("choir-attendance-date", date);
              load("attendance", date);
            }}
            checks={attendanceChecks}
            setChecks={setAttendanceChecks}
            save={(checks) =>
              saveAttendance(
                Object.fromEntries(
                  Object.entries(checks).filter(
                    ([key]) => rows.find((row) => String(row.recordKey) === key)?.role === attendanceRole,
                  ),
                ),
              )
            }
            markAttendance={markAttendance}
            onComment={async (recordKey, comment) => {
              await request(
                "/api/attendance-comment",
                {
                  method: "POST",
                  body: JSON.stringify({
                    type: attendanceType,
                    date: attendanceDate,
                    recordKey: Number(recordKey),
                    comment,
                  }),
                },
                password,
              );
              setNotice("تم حفظ تعليق الحضور");
            }}
            onDeleteComment={async (recordKey) => {
              await request(
                `/api/attendance-comment?type=${attendanceType}&date=${attendanceDate}&recordKey=${Number(recordKey)}`,
                { method: "DELETE" },
                password,
              );
              setNotice("تم مسح التعليق");
            }}
            busy={busy}
            query={query}
            setQuery={setQuery}
          />
        )}
        {mode === "evaluation" && <ServantBoyEvaluationPage request={request} />}
        {(mode === "qr" || mode === "qr-print") && (
          <QrManagementPage
            rows={state.rows}
            request={request}
            scanType={scanType}
            setScanType={(type) => {
              setScanType(type);
              sessionStorage.setItem("choir-scan-type", type);
            }}
            scanDate={scanDate}
            setScanDate={setScanDate}
          />
        )}
        {mode === "home" && (
          <HomeDashboard
            dashboard={dashboard}
            dashboardDate={dashboardDate}
            setDashboardDate={(date) => {
              setDashboardDate(date);
              sessionStorage.setItem("choir-dashboard-date", date);
              load("home", date);
            }}
            trendMonth={trendMonth}
            setTrendMonth={(month) => {
              setTrendMonth(month);
              sessionStorage.setItem("choir-trend-month", month);
              load("home", dashboardDate, password, month);
            }}
            openReport={openReport}
          />
        )}
        {mode === "stray" && (
          <StraySheepPage
            people={dashboard.people || []}
            openReport={openReport}
            template={whatsappTemplate}
            saveTemplate={async (message) => {
              const saved = await request("/api/whatsapp-template", {
                method: "PUT",
                body: JSON.stringify({ message }),
              });
              setWhatsappTemplate(saved.message);
              setNotice("تم حفظ رسالة واتساب");
            }}
          />
        )}
        {mode === "content-admin" && <ContentManagementChooser onChoose={switchMode} />}
        {mode === "learning-admin" && (
          <LearningManagementPage
            items={learningItems}
            request={request}
            reload={() => load("learning-admin")}
            onBack={() => switchMode("content-admin")}
          />
        )}
        {mode === "books-admin" && (
          <BooksManagementPage
            items={books}
            request={request}
            reload={() => load("books-admin")}
            onBack={() => switchMode("content-admin")}
          />
        )}
        {mode === "bible-admin" && (
          <BibleVideoManagementPage
            items={bibleVideos}
            request={request}
            reload={() => load("bible-admin")}
            onBack={() => switchMode("content-admin")}
          />
        )}
        {mode === "mass-admin" && (
          <MassScheduleManagementPage
            items={massSchedules}
            request={request}
            reload={() => load("mass-admin")}
            onBack={() => switchMode("content-admin")}
          />
        )}
        {(mode === "visit" || mode === "call") && (
          <PeopleTable
            mode={mode}
            rows={(mode === "visit" ? visitRows : rows).filter((row) => row.role !== "servant")}
            query={query}
            setQuery={setQuery}
            busy={busy}
            saveFollowUp={saveFollowUp}
            updateCheck={updateCheck}
            openReport={openReport}
            loading={loading}
            notes={followUpNotes}
            request={request}
            password={password}
            reloadNotes={() => load("notes")}
            includeVisitedThisMonth={includeVisitedThisMonth}
            setIncludeVisitedThisMonth={setIncludeVisitedThisMonth}
          />
        )}
        {mode === "reports" && (
          <VisitReportsPage
            reports={visitReports}
            exportCsv={exportCsv}
            month={reportMonth}
            setMonth={(month) => {
              setReportMonth(month);
              load("reports", undefined, password, month);
            }}
          />
        )}
        {mode === "analytics" && (
          <ServiceAnalyticsPage analytics={serviceAnalytics} exportFull={exportFullReports} />
        )}
        {mode === "notes" && (
          <FollowUpNotesPage
            notes={followUpNotes}
            rows={rows}
            request={request}
            password={password}
            reload={() => load("notes")}
          />
        )}
        {mode === "notifications" && (
          <NotificationsPage
            notifications={visibleNotificationItems}
            readMap={notificationReadMap}
            onOpen={openNotification}
            onMarkAllRead={markAllNotificationsRead}
            onClear={clearNotifications}
          />
        )}
        {mode === "requests" && (
          <FollowUpRequestsPage
            requests={followUpRequests}
            request={request}
            password={password}
            reload={() => load("requests")}
          />
        )}
        {mode === "history" && (
          <MembersDirectoryByRole
            rows={rows}
            query={query}
            setQuery={setQuery}
            openReport={openReport}
            loading={loading}
            request={request}
          />
        )}
        {(error || notice) && (
          <div className={`toast visible ${error ? "error" : ""}`} role="status">
            {error || notice}
          </div>
        )}
        {report && <ReportModal report={report} close={() => setReport(null)} />}
      </section>
    </main>
  );
}

function PublicLeaguePage() {
  const [month, setMonth] = useState(today().slice(0, 7));
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const initialPersonName = useRef(new URLSearchParams(window.location.search).get("name") || "");
  const [searchQuery, setSearchQuery] = useState(initialPersonName.current);
  const initialSearchApplied = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    fetch(`${apiUrl}/api/public/league?month=${encodeURIComponent(month)}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "تعذر تحميل ترتيب الأولاد");
        return body;
      })
      .then(setData)
      .catch((loadError) => {
        if (loadError.name !== "AbortError") setError(loadError.message);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [month]);
  useEffect(() => {
    if (!data || !initialPersonName.current || initialSearchApplied.current) return undefined;
    const target =
      data.rows?.find(
        (row) => normalizeSearchText(row.name) === normalizeSearchText(initialPersonName.current),
      ) || data.rows?.find((row) => searchMatches(row.name, initialPersonName.current));
    initialSearchApplied.current = true;
    if (!target) return undefined;
    const frame = window.requestAnimationFrame(() =>
      document
        .getElementById(`league-row-${target.recordKey}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [data]);
  const leader = data?.monthlyLeader;
  const visibleRows = (data?.rows || []).filter((row) => searchMatches(row.name, searchQuery));
  const medalFor = (rank) =>
    rank === 1 ? (
      <Trophy size={18} />
    ) : rank === 2 ? (
      <Medal size={18} />
    ) : rank === 3 ? (
      <Medal size={18} />
    ) : (
      <span>{rank}</span>
    );
  return (
    <main className="league-page" dir="rtl">
      <PublicNavigation subtitle="دوري أبانوب" />
      <header className="league-header">
        <div className="league-page-title">
          <span className="league-kicker">خورس القديس أبانوب</span>
          <h1>دوري أبانوب</h1>
          <p>ترتيب شهري حسب الحضور والتقييم</p>
        </div>
        <label className="league-month">
          الشهر
          <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
        </label>
      </header>
      <div className="league-content">
        <section className={`monthly-champion ${data?.isFinalized ? "final" : "provisional"}`}>
          <div className="monthly-champion-icon">
            <Star size={23} fill="currentColor" />
          </div>
          <div>
            <span className="league-kicker">شماس الشهر</span>
            <h2>{leader?.name || "لم يتحدد المتصدر بعد"}</h2>
            <p>
              {leader
                ? data?.isFinalized
                  ? `شماس خورس شهر ${dateLabel(`${month}-01`).split(" ").slice(1, 3).join(" ")}`
                  : `المتصدر المؤقت · يُحسم بعد الجمعة ${data?.lastFriday ? dateLabel(data.lastFriday) : "الأخيرة"}`
                : "لا توجد نقاط مسجلة في هذا الشهر بعد"}
            </p>
          </div>
          <strong className="monthly-points">{leader ? `${leader.points} نقطة` : "—"}</strong>
        </section>
        {error && <p className="league-message error">{error}</p>}
        {loading && <p className="league-message">جاري تحميل الترتيب...</p>}
        <section className="league-table-section">
          <div className="league-table-heading">
            <div>
              <span className="league-kicker">الشهر المختار</span>
              <h2>ترتيب دوري أبانوب</h2>
            </div>
            <label className="league-search">
              <Search size={17} />
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="ابحث باسم الولد"
                aria-label="ابحث باسم الولد في دوري أبانوب"
              />
            </label>
            <span className="league-row-count">
              {visibleRows.length} من {data?.rows?.length || 0} ولد
            </span>
          </div>
          <div className="league-table-wrap">
            <table className="league-table">
              <thead>
                <tr>
                  <th>المركز</th>
                  <th>الاسم</th>
                  <th>النقاط</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <tr
                    id={`league-row-${row.recordKey}`}
                    key={row.recordKey}
                    className={`league-rank-${Math.min(row.rank, 3)} ${searchQuery && searchMatches(row.name, searchQuery) ? "league-row-matched" : ""}`}
                  >
                    <td>
                      <span className={`league-rank-badge rank-${Math.min(row.rank, 3)}`}>
                        {medalFor(row.rank)}
                      </span>
                    </td>
                    <td>
                      <span className="person-name-with-avatar">
                        <PersonAvatar person={row} name={row.name} /> <strong>{row.name}</strong>
                      </span>
                    </td>
                    <td>
                      <strong className="league-score">{row.points}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!loading && !error && !visibleRows.length && (
              <p className="league-message">لا يوجد ولد بهذا الاسم في ترتيب هذا الشهر</p>
            )}
          </div>
        </section>
        <footer className="league-footnote">
          نقاط الشهر تجمع حضور القداس والخورس والتقييمات المسجلة خلال الشهر المختار.
        </footer>
      </div>
    </main>
  );
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
    setLoading(true);
    setError("");
    setSaveStates({});
    try {
      const result = await request(`/api/evaluations?date=${encodeURIComponent(date)}`);
      setPeople(result.people || []);
      setScores(
        Object.fromEntries(
          (result.people || []).map((person) => [String(person.recordKey), person.points ?? 0]),
        ),
      );
    } catch (loadError) {
      setPeople([]);
      setScores({});
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }, [date, request]);
  useEffect(() => {
    reload();
  }, [reload]);
  function updateScore(recordKey, value) {
    const key = String(recordKey);
    const version = (saveVersion.current[key] || 0) + 1;
    saveVersion.current[key] = version;
    setScores((current) => ({ ...current, [key]: value }));
    setSaveStates((current) => ({ ...current, [key]: "saving" }));
    setError("");
    const previous = saveQueue.current[key] || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() =>
        request("/api/evaluations", {
          method: "POST",
          body: JSON.stringify({ date, scores: { [key]: value } }),
        }),
      );
    saveQueue.current[key] = next;
    next
      .then(() => {
        if (saveVersion.current[key] === version)
          setSaveStates((current) => ({ ...current, [key]: "saved" }));
      })
      .catch((saveError) => {
        if (saveVersion.current[key] === version) {
          setError(saveError.message);
          setSaveStates((current) => ({ ...current, [key]: "error" }));
        }
      });
  }
  const filteredPeople = people.filter((person) => searchMatches(person.name, query));
  return (
    <main className="evaluation-page" dir="rtl">
      <header className="evaluation-heading">
        <div>
          <span className="section-kicker">متابعة أداء الأبناء</span>
          <h1>تقييم الخورس</h1>
          <p>يظهر هنا من سُجل حضوره في الخورس في التاريخ المختار.</p>
        </div>
        <label>
          تاريخ الحضور
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </label>
      </header>
      {error && <p className="evaluation-alert error">{error}</p>}
      <section className="evaluation-panel">
        <div className="evaluation-panel-heading">
          <div>
            <h2>تقييم الحاضرين</h2>
            <span>{loading ? "جاري التحميل..." : `${filteredPeople.length} من ${people.length} ولد`}</span>
          </div>
          <label className="evaluation-search">
            <Search size={17} />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="ابحث باسم الولد"
              aria-label="ابحث باسم الولد"
            />
          </label>
        </div>
        {!loading && people.length === 0 ? (
          <div className="evaluation-empty">
            <Users size={25} />
            <strong>لا يوجد حضور خورس مسجل لهذا اليوم</strong>
            <span>اختر تاريخًا سُجل فيه حضور الخورس لبدء التقييم.</span>
          </div>
        ) : filteredPeople.length === 0 ? (
          <p className="evaluation-no-results">لا يوجد ولد بهذا الاسم</p>
        ) : (
          <div className="evaluation-list">
            {filteredPeople.map((person) => {
              const key = String(person.recordKey);
              const score = scores[key] ?? 0;
              const saveState = saveStates[key];
              return (
                <label className="evaluation-row" key={person.recordKey}>
                  <span className="evaluation-person">
                    <span className="person-name-with-avatar">
                      <PersonAvatar person={person} name={person.name} /> <strong>{person.name}</strong>
                    </span>
                    <small className={saveState || "idle"}>
                      {saveState === "saving"
                        ? "جارٍ الحفظ..."
                        : saveState === "saved"
                          ? "تم الحفظ تلقائيًا"
                          : saveState === "error"
                            ? "تعذر الحفظ"
                            : person.points === null
                              ? "لم يُقيّم بعد"
                              : "تقييم محفوظ"}
                    </small>
                  </span>
                  <input
                    aria-label={`تقييم ${person.name}`}
                    type="range"
                    min="0"
                    max="10"
                    step="1"
                    value={score}
                    onChange={(event) => updateScore(person.recordKey, Number(event.target.value))}
                  />
                  <output className="evaluation-score">
                    {score}
                    <small>/ 10</small>
                  </output>
                </label>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}

function PublicLearningPage() {
  const [items, setItems] = useState([]);
  const [selectedDate, setSelectedDate] = useState(
    () => new URLSearchParams(window.location.search).get("date") || "",
  );
  const [selectedCategory, setSelectedCategory] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch(`${apiUrl}/api/public/learning-items`)
      .then(async (response) => {
        const body = await response.json().catch(() => []);
        if (!response.ok) throw new Error(body.error || "تعذر تحميل المناهج");
        setItems(body);
      })
      .catch((loadError) => setError(loadError.message))
      .finally(() => setLoading(false));
  }, []);
  const dates = [...new Set(items.map((item) => item.date))];
  const dateItems = items.filter((item) => item.date === selectedDate);
  const categories = [...new Set(dateItems.map((item) => item.category))];
  const visibleItems = dateItems.filter((item) => !selectedCategory || item.category === selectedCategory);
  const selectDate = (date) => {
    setSelectedDate((current) => (current === date ? "" : date));
    setSelectedCategory("");
  };
  return (
    <main className="learning-public-page" dir="rtl">
      <PublicNavigation subtitle="مناهج الخورس" />
      <section className="learning-public-content">
        <div className="learning-public-hero">
          <BookOpen size={30} />
          <p className="section-kicker">مناهج الخورس</p>
          <h1>إحنا اتعلمنا إيه؟</h1>
          <p>اضغط على يوم الجمعة لعرض المواد اللي اتاخدت فيه.</p>
        </div>
        {loading ? (
          <p className="learning-empty">جاري تحميل اللقاءات…</p>
        ) : error ? (
          <p className="learning-empty error">{error}</p>
        ) : !items.length ? (
          <section className="learning-empty-card">
            <CalendarDays size={30} />
            <strong>لسه مفيش لقاءات مضافة</strong>
            <span>هنعرض المناهج هنا أول ما الخدام يضيفوها.</span>
          </section>
        ) : (
          <section className="learning-day-list" aria-label="أيام اللقاءات">
            {dates.map((date) => {
              const count = items.filter((item) => item.date === date).length;
              const expanded = selectedDate === date;
              const currentDateItems = items.filter((item) => item.date === date);
              const currentCategories = [...new Set(currentDateItems.map((item) => item.category))];
              const currentVisibleItems = currentDateItems.filter(
                (item) => !selectedCategory || item.category === selectedCategory,
              );
              return (
                <div className={`learning-day-accordion ${expanded ? "expanded" : ""}`} key={date}>
                  <button
                    type="button"
                    className={`learning-day-button ${expanded ? "active" : ""}`}
                    aria-expanded={expanded}
                    onClick={() => selectDate(date)}
                  >
                    <CalendarDays size={19} />
                    <span>
                      <strong>الجمعة {dateLabel(date)}</strong>
                      <small>
                        {count} {count === 1 ? "مادة" : "مواد"}
                      </small>
                    </span>
                    <ChevronLeft size={19} />
                  </button>
                  {expanded && (
                    <section className="learning-day-panel">
                      <div className="learning-category-tabs">
                        <button
                          type="button"
                          className={!selectedCategory ? "active" : ""}
                          onClick={() => setSelectedCategory("")}
                        >
                          الكل
                        </button>
                        {currentCategories.map((category) => (
                          <button
                            type="button"
                            className={selectedCategory === category ? "active" : ""}
                            key={category}
                            onClick={() => setSelectedCategory(category)}
                          >
                            {category}
                          </button>
                        ))}
                      </div>
                      <section className="learning-material-grid">
                        {currentVisibleItems.map((item) => {
                          const links = item.links?.length
                            ? item.links
                            : [{ label: "فتح المادة", url: item.url }];
                          return (
                            <article
                              className={`learning-material-card ${item.backgroundUrl ? "has-background" : ""}`}
                              key={item.id}
                              style={
                                item.backgroundUrl
                                  ? {
                                      "--learning-card-image": `url("${learningImageUrl(item.backgroundUrl).replace(/["\\]/g, "")}")`,
                                    }
                                  : undefined
                              }
                            >
                              <span className="learning-category-badge">{item.category}</span>
                              <h2>{item.title}</h2>
                              {item.description && <p>{item.description}</p>}
                              <div className="learning-resource-links">
                                {links.map((link, index) => (
                                  <a
                                    href={link.url}
                                    key={`${item.id}-${index}`}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    <ExternalLink size={15} /> {link.label}
                                  </a>
                                ))}
                              </div>
                            </article>
                          );
                        })}
                      </section>
                    </section>
                  )}
                </div>
              );
            })}
          </section>
        )}
      </section>
    </main>
  );
}

function googleDriveFileId(value) {
  const match = String(value || "").match(/(?:\/d\/|id=)([a-zA-Z0-9_-]+)/);
  return match?.[1] || "";
}
function cloudinaryEmbed(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.hostname !== "player.cloudinary.com") return null;
    const cloudName = url.searchParams.get("cloud_name");
    const publicId = url.searchParams.get("public_id");
    return cloudName && publicId ? { cloudName, publicId } : null;
  } catch {
    return null;
  }
}
function cloudinaryVideoUrl(value) {
  const data = cloudinaryEmbed(value);
  return data
    ? `https://res.cloudinary.com/${data.cloudName}/video/upload/q_auto,f_auto/${encodeURI(data.publicId)}.mp4`
    : "";
}

function BibleVideoThumbnail({ url, title, thumbnailUrl = "" }) {
  const [preview, setPreview] = useState("");
  const captureFirstFrame = (event) => {
    const video = event.currentTarget;
    try {
      if (!video.videoWidth || !video.videoHeight) return;
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      setPreview(canvas.toDataURL("image/jpeg", 0.82));
    } catch {
      // بعض روابط Drive لا تسمح بالقراءة من canvas؛ في هذه الحالة نُبقي معاينة الفيديو الأصلية.
    }
  };
  return (
    <div className="bible-video-thumb">
      {thumbnailUrl ? (
        <img src={learningImageUrl(thumbnailUrl)} alt="" />
      ) : preview ? (
        <img src={preview} alt="" />
      ) : cloudinaryEmbed(url) ? (
        <img
          src={`https://res.cloudinary.com/${cloudinaryEmbed(url).cloudName}/video/upload/so_0,q_auto,f_auto/${encodeURI(cloudinaryEmbed(url).publicId)}.jpg`}
          alt=""
        />
      ) : googleDriveFileId(url) ? (
        <img src={`https://drive.google.com/thumbnail?id=${googleDriveFileId(url)}&sz=w1200`} alt="" />
      ) : (
        <video
          src={url}
          title={title}
          muted
          playsInline
          controls
          preload="metadata"
          onLoadedData={captureFirstFrame}
        />
      )}
    </div>
  );
}

function PublicBiblePage() {
  const [items, setItems] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState("");
  const [activeVideo, setActiveVideo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch(`${apiUrl}/api/public/bible-videos`)
      .then(async (response) => {
        const body = await response.json().catch(() => []);
        if (!response.ok) throw new Error(body.error || "تعذر تحميل فيديوهات الكتاب المقدس");
        setItems(body);
      })
      .catch((loadError) => setError(loadError.message))
      .finally(() => setLoading(false));
  }, []);
  const categories = [...new Set(items.map((item) => item.category).filter(Boolean))];
  const videos = items.filter((item) => item.category === selectedCategory);
  return (
    <main className="learning-public-page bible-public-page" dir="rtl">
      <PublicNavigation subtitle="الكتاب المقدس" />
      <section className="learning-public-content">
        <div className="learning-public-hero">
          <BookOpen size={32} />
          <p className="section-kicker">محتوى روحي</p>
          <h1>الكتاب المقدس</h1>
          <p>{selectedCategory ? "اختار السفر اللي تحب تسمعه." : "اختار القسم اللي تحب تفتحه."}</p>
        </div>
        {loading ? (
          <p className="learning-empty">جاري التحميل…</p>
        ) : error ? (
          <p className="learning-empty error">{error}</p>
        ) : !selectedCategory ? (
          <section className="bible-category-grid" aria-label="أقسام الكتاب المقدس">
            {categories.length ? (
              categories.map((category) => (
                <button
                  type="button"
                  className="bible-category-card"
                  key={category}
                  onClick={() => setSelectedCategory(category)}
                >
                  <BookOpen size={28} />
                  <strong>{category}</strong>
                  <span>{items.filter((item) => item.category === category).length} فيديو</span>
                  <ChevronLeft size={19} />
                </button>
              ))
            ) : (
              <section className="learning-empty-card">
                <BookOpen size={30} />
                <strong>لسه مفيش أقسام مضافة</strong>
                <span>هتظهر هنا أول ما الخدام يضيفوا فيديوهات.</span>
              </section>
            )}
          </section>
        ) : (
          <section>
            <button
              type="button"
              className="secondary-button bible-back-button"
              onClick={() => setSelectedCategory("")}
            >
              <ChevronRight size={16} /> الأقسام
            </button>
            <div className="bible-video-grid">
              {videos.map((item) => (
                <article className="bible-video-card" key={item.id}>
                  <BibleVideoThumbnail url={item.url} title={item.title} thumbnailUrl={item.thumbnailUrl} />
                  <div>
                    <span className="content-category-pill">{item.category}</span>
                    <h2>{item.title}</h2>
                    {item.description && <p>{item.description}</p>}
                    <button className="bible-watch-button" type="button" onClick={() => setActiveVideo(item)}>
                      <Play size={15} fill="currentColor" /> تشغيل الفيديو
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
      </section>
      {activeVideo && (
        <div
          className="bible-video-modal"
          role="dialog"
          aria-modal="true"
          aria-label={activeVideo.title}
          onClick={() => setActiveVideo(null)}
        >
          <div className="bible-video-modal-card" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="bible-video-modal-close"
              aria-label="إغلاق الفيديو"
              onClick={() => setActiveVideo(null)}
            >
              ×
            </button>
            <div className="bible-video-modal-player">
              {cloudinaryEmbed(activeVideo.url) ? (
                <iframe
                  title={activeVideo.title}
                  src={activeVideo.url}
                  allow="autoplay; fullscreen"
                  allowFullScreen
                />
              ) : googleDriveFileId(activeVideo.url) ? (
                <iframe
                  title={activeVideo.title}
                  src={`https://drive.google.com/file/d/${googleDriveFileId(activeVideo.url)}/preview`}
                  allow="autoplay; fullscreen"
                  allowFullScreen
                />
              ) : (
                <video src={activeVideo.url} controls autoPlay playsInline />
              )}
            </div>
            <h2>{activeVideo.title}</h2>
          </div>
        </div>
      )}
    </main>
  );
}

function BibleVideoManagementPage({ items, request, reload, onBack }) {
  const emptyDraft = () => ({
    category: "الكتاب المقدس في فتفوتة",
    title: "",
    url: "",
    thumbnailUrl: "",
    description: "",
  });
  const [draft, setDraft] = useState(emptyDraft);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await request(editingId ? `/api/bible-videos/${editingId}` : "/api/bible-videos", {
        method: editingId ? "PUT" : "POST",
        body: JSON.stringify(draft),
      });
      await reload();
      setDraft(emptyDraft());
      setEditingId(null);
      setNotice("تم حفظ الفيديو");
    } catch (saveError) {
      setError(saveError.message || "تعذر الحفظ");
    } finally {
      setSaving(false);
    }
  };
  const remove = async (item) => {
    if (!window.confirm(`حذف فيديو «${item.title}»؟`)) return;
    await request(`/api/bible-videos/${item.id}`, { method: "DELETE" });
    await reload();
  };
  const move = async (item, direction) => {
    await request(`/api/bible-videos/${item.id}/move`, {
      method: "POST",
      body: JSON.stringify({ direction }),
    });
    await reload();
  };
  return (
    <section className="learning-admin-page bible-admin-page">
      <header className="section-title-row learning-admin-heading">
        <div>
          <p className="section-kicker">إدارة الخدمة</p>
          <h1>إدارة فيديوهات الكتاب المقدس</h1>
          <p>أضف القسم واسم الفيديو ورابط Google Drive. لا تحتاج لإضافة غلاف.</p>
        </div>
        <button type="button" className="secondary-button" onClick={onBack}>
          <ChevronLeft size={16} /> إدارة المحتوى
        </button>
      </header>
      <form className="table-section learning-admin-form" onSubmit={save}>
        <div className="learning-admin-form-title">
          <BookOpen size={21} />
          <div>
            <strong>{editingId ? "تعديل فيديو" : "إضافة فيديو"}</strong>
            <span>سيحاول الموقع استخدام أول فريم من الفيديو كصورة معاينة.</span>
          </div>
        </div>
        <label>
          اسم القسم
          <input
            required
            maxLength={120}
            value={draft.category}
            onChange={(e) => setDraft({ ...draft, category: e.target.value })}
          />
        </label>
        <label>
          اسم الفيديو
          <input
            required
            maxLength={180}
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="مثال: سفر التكوين"
          />
        </label>
        <label className="learning-form-wide">
          رابط الفيديو
          <input
            required
            type="url"
            dir="ltr"
            value={draft.url}
            onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            placeholder="https://drive.google.com/..."
          />
        </label>
        <label className="learning-form-wide">
          خلفية الفيديو <small>(اختياري — صورة ثابتة أجمل وأسرع، ولو فاضية سنحاول إظهار أول فريم)</small>
          <input
            type="url"
            dir="ltr"
            value={draft.thumbnailUrl}
            onChange={(e) => setDraft({ ...draft, thumbnailUrl: e.target.value })}
            placeholder="https://.../thumbnail.jpg"
          />
        </label>
        <label className="learning-form-wide">
          وصف مختصر <small>(اختياري)</small>
          <textarea
            maxLength={1200}
            rows="2"
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </label>
        {error && <p className="learning-form-error">{error}</p>}
        {notice && <p className="learning-form-notice">{notice}</p>}
        <div className="learning-form-actions">
          <button className="primary-button" type="submit" disabled={saving}>
            {saving ? "جارٍ الحفظ…" : editingId ? "حفظ التعديل" : "إضافة الفيديو"}
          </button>
          {editingId && (
            <button
              className="cancel-button"
              type="button"
              onClick={() => {
                setEditingId(null);
                setDraft(emptyDraft());
              }}
            >
              إلغاء
            </button>
          )}
        </div>
      </form>
      <section className="learning-admin-list">
        <div className="section-title-row">
          <div>
            <p className="section-kicker">الفيديوهات المضافة</p>
            <h2>{items.length} فيديو</h2>
          </div>
          <a href="/bible" target="_blank" rel="noreferrer">
            معاينة صفحة الأولاد <ExternalLink size={15} />
          </a>
        </div>
        {items.length ? (
          <div className="bible-admin-list">
            {items.map((item, index) => (
              <article className="bible-admin-item" key={item.id}>
                <BibleVideoThumbnail url={item.url} title={item.title} thumbnailUrl={item.thumbnailUrl} />
                <div>
                  <span className="content-category-pill">{item.category}</span>
                  <strong>
                    {index + 1}. {item.title}
                  </strong>
                  {item.description && <span>{item.description}</span>}
                </div>
                <div className="bible-order-buttons">
                  <button
                    type="button"
                    disabled={index === 0}
                    onClick={() => move(item, "up")}
                    aria-label="تقديم"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    disabled={index === items.length - 1}
                    onClick={() => move(item, "down")}
                    aria-label="تأخير"
                  >
                    ▼
                  </button>
                </div>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => {
                    setEditingId(item.id);
                    setDraft({
                      category: item.category,
                      title: item.title,
                      url: item.url,
                      thumbnailUrl: item.thumbnailUrl || "",
                      description: item.description || "",
                    });
                  }}
                >
                  تعديل
                </button>
                <button className="cancel-button" type="button" onClick={() => remove(item)}>
                  حذف
                </button>
              </article>
            ))}
          </div>
        ) : (
          <p className="learning-empty">لم تتم إضافة فيديوهات بعد.</p>
        )}
      </section>
    </section>
  );
}

function PublicBooksPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch(`${apiUrl}/api/public/books`)
      .then(async (response) => {
        const body = await response.json().catch(() => []);
        if (!response.ok) throw new Error(body.error || "تعذر تحميل الكتب");
        setItems(body);
      })
      .catch((loadError) => setError(loadError.message))
      .finally(() => setLoading(false));
  }, []);
  return (
    <main className="learning-public-page books-public-page" dir="rtl">
      <PublicNavigation subtitle="مكتبة الخورس" />
      <section className="learning-public-content">
        <div className="learning-public-hero books-public-hero">
          <BookOpen size={32} />
          <p className="section-kicker">مكتبة الخورس</p>
          <h1>كتب</h1>
          <p>اختار الكتاب اللي تحب تقراه أو تراجعه.</p>
        </div>
        {loading ? (
          <p className="learning-empty">جاري تحميل الكتب…</p>
        ) : error ? (
          <p className="learning-empty error">{error}</p>
        ) : !items.length ? (
          <section className="learning-empty-card">
            <BookOpen size={30} />
            <strong>لسه مفيش كتب مضافة</strong>
            <span>هتظهر الكتب هنا أول ما الخدام يضيفوها.</span>
          </section>
        ) : (
          <section className="books-public-grid" aria-label="كتب الخورس">
            {items.map((item) => (
              <article className="book-public-card" key={item.id}>
                <div className="book-cover-wrap">
                  {item.coverUrl || item.url ? (
                    <img
                      src={learningImageUrl(item.coverUrl || item.url)}
                      alt={`غلاف ${item.title}`}
                      onError={(event) => {
                        event.currentTarget.style.display = "none";
                      }}
                    />
                  ) : (
                    <BookOpen size={48} aria-hidden="true" />
                  )}
                </div>
                <div className="book-public-card-content">
                  <h2>{item.title}</h2>
                  {item.description && <p>{item.description}</p>}
                  <div className="book-public-actions">
                    <a href={item.url} target="_blank" rel="noreferrer">
                      فتح الكتاب <ExternalLink size={15} />
                    </a>
                    <a href={bookDownloadUrl(item.url)} download>
                      تحميل <Download size={15} />
                    </a>
                  </div>
                </div>
              </article>
            ))}
          </section>
        )}
      </section>
    </main>
  );
}

function PublicMassSchedulePage() {
  const [items, setItems] = useState([]);
  const [selectedMonth, setSelectedMonth] = useState(
    () => new URLSearchParams(window.location.search).get("month") || "",
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch(`${apiUrl}/api/public/mass-schedules`)
      .then(async (response) => {
        const body = await response.json().catch(() => []);
        if (!response.ok) throw new Error(body.error || "تعذر تحميل مواعيد القداسات");
        setItems(body);
      })
      .catch((loadError) => setError(loadError.message))
      .finally(() => setLoading(false));
  }, []);
  const months = [...new Set(items.map((item) => item.date.slice(0, 7)))].sort().reverse();
  const monthName = (month) =>
    new Intl.DateTimeFormat("ar-EG", { month: "long", year: "numeric" }).format(
      new Date(`${month}-01T12:00:00`),
    );
  return (
    <main className="learning-public-page mass-public-page" dir="rtl">
      <PublicNavigation subtitle="مواعيد القداسات" />
      <section className="learning-public-content">
        <div className="learning-public-hero">
          <Church size={30} />
          <p className="section-kicker">مواعيد الخورس</p>
          <h1>اعرف قداسك إمتى</h1>
          <p>اختار الشهر عشان تشوف مواعيد القداسات وأماكنها.</p>
        </div>
        {loading ? (
          <p className="learning-empty">جاري تحميل المواعيد…</p>
        ) : error ? (
          <p className="learning-empty error">{error}</p>
        ) : !months.length ? (
          <section className="learning-empty-card">
            <CalendarDays size={30} />
            <strong>لسه مفيش مواعيد قداسات مضافة</strong>
            <span>هنعرض المواعيد هنا أول ما الخدام يضيفوها.</span>
          </section>
        ) : (
          <section className="learning-day-list mass-month-list" aria-label="مواعيد القداسات حسب الشهر">
            {months.map((month) => {
              const monthItems = items
                .filter((item) => item.date.startsWith(month))
                .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
              const expanded = selectedMonth === month;
              return (
                <div className={`learning-day-accordion ${expanded ? "expanded" : ""}`} key={month}>
                  <button
                    type="button"
                    className={`learning-day-button mass-month-button ${expanded ? "active" : ""}`}
                    aria-expanded={expanded}
                    onClick={() => setSelectedMonth((current) => (current === month ? "" : month))}
                  >
                    <CalendarDays size={20} />
                    <span>
                      <strong>{monthName(month)}</strong>
                      <small>{monthItems.length} قداس</small>
                    </span>
                    <ChevronLeft size={20} />
                  </button>
                  {expanded && (
                    <div className="learning-day-panel mass-month-panel">
                      <div className="mass-schedule-table-wrap">
                        <table className="mass-schedule-table">
                          <thead>
                            <tr>
                              <th scope="col">التاريخ</th>
                              <th scope="col">الساعة</th>
                              <th scope="col">المكان</th>
                            </tr>
                          </thead>
                          <tbody>
                            {monthItems.map((item) => (
                              <tr key={item.id}>
                                <td>{dateLabel(item.date)}</td>
                                <td dir="ltr">{item.time}</td>
                                <td>{item.location}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        )}
      </section>
    </main>
  );
}

function ContentManagementChooser({ onChoose }) {
  return (
    <section className="content-management-page">
      <header className="section-title-row content-management-heading">
        <div>
          <p className="section-kicker">إدارة الخدمة</p>
          <h1>إدارة المحتوى</h1>
          <p>اختار القسم اللي عايز تديره.</p>
        </div>
      </header>
      <div className="content-management-options">
        <button
          type="button"
          className="content-management-option"
          onClick={() => onChoose("learning-admin")}
        >
          <BookOpen size={27} />
          <strong>إدارة المناهج</strong>
          <span>إضافة مواد وروابط لقاءات الجمعة.</span>
          <ChevronLeft size={19} />
        </button>
        <button type="button" className="content-management-option" onClick={() => onChoose("mass-admin")}>
          <Church size={27} />
          <strong>إدارة القداسات</strong>
          <span>إضافة مواعيد القداسات وأماكنها لكل شهر.</span>
          <ChevronLeft size={19} />
        </button>
        <button type="button" className="content-management-option" onClick={() => onChoose("books-admin")}>
          <BookOpen size={27} />
          <strong>إدارة الكتب</strong>
          <span>إضافة الكتب وأغلفتها وروابطها للأولاد.</span>
          <ChevronLeft size={19} />
        </button>
        <button type="button" className="content-management-option" onClick={() => onChoose("bible-admin")}>
          <BookOpen size={27} />
          <strong>إدارة فيديوهات الكتاب المقدس</strong>
          <span>أضف التصنيفات وفيديوهات الكتاب المقدس بروابطها.</span>
          <ChevronLeft size={19} />
        </button>
      </div>
    </section>
  );
}

function MassScheduleManagementPage({ items, request, reload, onBack }) {
  const initialMonth = today().slice(0, 7);
  const [selectedMonth, setSelectedMonth] = useState(initialMonth);
  const [draft, setDraft] = useState({ date: `${initialMonth}-01`, time: "09:00", location: "" });
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const monthItems = items.filter((item) => item.date.startsWith(selectedMonth));
  const resetForm = () => {
    setDraft({ date: `${selectedMonth}-01`, time: "09:00", location: "" });
    setEditingId(null);
  };
  const changeMonth = (month) => {
    setSelectedMonth(month);
    setDraft((current) => ({
      ...current,
      date: current.date.startsWith(month) ? current.date : `${month}-01`,
    }));
    setEditingId(null);
    setError("");
    setNotice("");
  };
  const save = async (event) => {
    event.preventDefault();
    setError("");
    setNotice("");
    if (!draft.date.startsWith(selectedMonth)) {
      setError("تاريخ القداس لازم يكون داخل الشهر المختار.");
      return;
    }
    setSaving(true);
    try {
      await request(editingId ? `/api/mass-schedules/${editingId}` : "/api/mass-schedules", {
        method: editingId ? "PUT" : "POST",
        body: JSON.stringify(draft),
      });
      setNotice(editingId ? "تم تعديل موعد القداس" : "تمت إضافة موعد القداس");
      resetForm();
      await reload();
    } catch (saveError) {
      setError(saveError.message || "تعذر حفظ موعد القداس");
    } finally {
      setSaving(false);
    }
  };
  const edit = (item) => {
    setSelectedMonth(item.date.slice(0, 7));
    setDraft({ date: item.date, time: item.time, location: item.location });
    setEditingId(item.id);
    setError("");
    setNotice("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const remove = async (item) => {
    if (!window.confirm(`حذف موعد قداس ${dateLabel(item.date)}؟`)) return;
    setError("");
    try {
      await request(`/api/mass-schedules/${item.id}`, { method: "DELETE" });
      if (editingId === item.id) resetForm();
      await reload();
    } catch (removeError) {
      setError(removeError.message || "تعذر حذف الموعد");
    }
  };
  return (
    <section className="learning-admin-page mass-admin-page">
      <header className="section-title-row learning-admin-heading">
        <div>
          <p className="section-kicker">إدارة الخدمة</p>
          <h1>إدارة القداسات</h1>
          <p>أضف كل موعد في الشهر، وحدد اليوم والساعة والمكان.</p>
        </div>
        <button type="button" className="secondary-button" onClick={onBack}>
          <ChevronLeft size={16} /> إدارة المحتوى
        </button>
      </header>
      <form className="table-section learning-admin-form" onSubmit={save}>
        <div className="learning-admin-form-title">
          <Church size={21} />
          <div>
            <strong>{editingId ? "تعديل موعد قداس" : "إضافة موعد قداس"}</strong>
            <span>المواعيد المسجلة ستظهر للأولاد في صفحة «اعرف قداسك إمتى».</span>
          </div>
        </div>
        <label>
          الشهر
          <input
            type="month"
            value={selectedMonth}
            onChange={(event) => changeMonth(event.target.value)}
            required
          />
        </label>
        <label>
          التاريخ
          <input
            type="date"
            value={draft.date}
            min={`${selectedMonth}-01`}
            max={`${selectedMonth}-${new Date(Number(selectedMonth.slice(0, 4)), Number(selectedMonth.slice(5, 7)), 0).getDate()}`}
            onChange={(event) => setDraft({ ...draft, date: event.target.value })}
            required
          />
        </label>
        <label>
          الساعة
          <input
            type="time"
            value={draft.time}
            onChange={(event) => setDraft({ ...draft, time: event.target.value })}
            required
          />
        </label>
        <label>
          المكان
          <input
            type="text"
            maxLength={250}
            value={draft.location}
            onChange={(event) => setDraft({ ...draft, location: event.target.value })}
            placeholder="مثال: كنيسة مارجرجس — قاعة القديس أبانوب"
            required
          />
        </label>
        {error && <p className="learning-form-error">{error}</p>}
        {notice && <p className="learning-form-notice">{notice}</p>}
        <div className="learning-form-actions">
          <button className="primary-button" type="submit" disabled={saving}>
            {saving ? "جارٍ الحفظ…" : editingId ? "حفظ التعديل" : "إضافة القداس"}
          </button>
          {editingId && (
            <button className="cancel-button" type="button" onClick={resetForm}>
              إلغاء التعديل
            </button>
          )}
        </div>
      </form>
      <section className="learning-admin-list">
        <div className="section-title-row">
          <div>
            <p className="section-kicker">مواعيد الشهر</p>
            <h2>{monthItems.length} قداس</h2>
          </div>
          <a href="/mass-schedule" target="_blank" rel="noreferrer">
            معاينة صفحة الأولاد <ExternalLink size={15} />
          </a>
        </div>
        {monthItems.length ? (
          <div className="mass-admin-schedule-list">
            {[...monthItems]
              .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time))
              .map((item) => (
                <article className="mass-admin-schedule-item" key={item.id}>
                  <CalendarDays size={19} />
                  <div>
                    <strong>
                      {dateLabel(item.date)} · <span dir="ltr">{item.time}</span>
                    </strong>
                    <span>
                      <MapPin size={14} /> {item.location}
                    </span>
                  </div>
                  <button className="secondary-button" type="button" onClick={() => edit(item)}>
                    تعديل
                  </button>
                  <button className="cancel-button" type="button" onClick={() => remove(item)}>
                    حذف
                  </button>
                </article>
              ))}
          </div>
        ) : (
          <p className="learning-empty">لا توجد مواعيد مسجلة لهذا الشهر.</p>
        )}
      </section>
    </section>
  );
}

function LearningManagementPage({ items, request, reload, onBack }) {
  const emptyDraft = () => ({
    date: today(),
    category: "",
    title: "",
    url: "",
    description: "",
    backgroundUrl: "",
    links: [{ label: "فتح المادة", url: "" }],
  });
  const [draft, setDraft] = useState(emptyDraft);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const links = draft.links.filter((link) => link.label.trim() || link.url.trim());
      await request(editingId ? `/api/learning-items/${editingId}` : "/api/learning-items", {
        method: editingId ? "PUT" : "POST",
        body: JSON.stringify({ ...draft, links, url: links[0]?.url || "" }),
      });
      setDraft(emptyDraft());
      setEditingId(null);
      setNotice(editingId ? "تم تعديل المادة" : "تمت إضافة المادة");
      await reload();
    } catch (saveError) {
      setError(saveError.message || "تعذر حفظ المادة");
    } finally {
      setSaving(false);
    }
  };
  const edit = (item) => {
    setDraft({
      date: item.date,
      category: item.category,
      title: item.title,
      url: item.url,
      description: item.description || "",
      backgroundUrl: item.backgroundUrl || "",
      links: item.links?.length
        ? item.links.map((link) => ({ label: link.label, url: link.url }))
        : [{ label: "فتح المادة", url: item.url }],
    });
    setEditingId(item.id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const updateLink = (index, key, value) =>
    setDraft((current) => ({
      ...current,
      links: current.links.map((link, currentIndex) =>
        currentIndex === index ? { ...link, [key]: value } : link,
      ),
    }));
  const addLink = () =>
    setDraft((current) =>
      current.links.length >= 10
        ? current
        : { ...current, links: [...current.links, { label: "شاهد الفيديو", url: "" }] },
    );
  const removeLink = (index) =>
    setDraft((current) =>
      current.links.length <= 1
        ? current
        : { ...current, links: current.links.filter((_, currentIndex) => currentIndex !== index) },
    );
  const remove = async (item) => {
    if (!window.confirm(`حذف مادة «${item.title}»؟`)) return;
    try {
      await request(`/api/learning-items/${item.id}`, { method: "DELETE" });
      await reload();
    } catch (removeError) {
      setError(removeError.message);
    }
  };
  const grouped = items.reduce((map, item) => ((map[item.date] ||= []).push(item), map), {});
  return (
    <section className="learning-admin-page">
      <header className="section-title-row learning-admin-heading">
        <div>
          <p className="section-kicker">إدارة الخدمة</p>
          <h1>إدارة المناهج</h1>
          <p>أضف روابط متعددة للمادة، مثل رابط السلايدز والفيديو.</p>
        </div>
        <button type="button" className="secondary-button" onClick={onBack}>
          <ChevronLeft size={16} /> إدارة المحتوى
        </button>
        <span className="learning-storage-note">الملفات تظل على Drive</span>
      </header>
      <form className="table-section learning-admin-form" onSubmit={save}>
        <div className="learning-admin-form-title">
          <BookOpen size={21} />
          <div>
            <strong>{editingId ? "تعديل مادة" : "إضافة مادة للقاء"}</strong>
            <span>التصنيف مرن؛ اكتب مثلًا: ألحان، قبطي، IPT أو توكس.</span>
          </div>
        </div>
        <label>
          تاريخ اللقاء
          <input
            type="date"
            required
            value={draft.date}
            onChange={(event) => setDraft({ ...draft, date: event.target.value })}
          />
        </label>
        <label>
          التصنيف
          <input
            required
            maxLength={100}
            value={draft.category}
            onChange={(event) => setDraft({ ...draft, category: event.target.value })}
            placeholder="ألحان"
          />
        </label>
        <label>
          اسم المادة
          <input
            required
            maxLength={180}
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            placeholder="اسم اللحن أو الدرس"
          />
        </label>
        <div className="learning-form-wide learning-links-editor">
          <div className="learning-links-editor-heading">
            <strong>روابط المادة</strong>
            <span>اكتب اسم الزر والرابط؛ مثال: السلايدز، شاهد الفيديو.</span>
          </div>
          {draft.links.map((link, index) => (
            <div className="learning-link-row" key={index}>
              <label>
                اسم الزر
                <input
                  required
                  maxLength={80}
                  value={link.label}
                  onChange={(event) => updateLink(index, "label", event.target.value)}
                  placeholder={index === 0 ? "السلايدز" : "شاهد الفيديو"}
                />
              </label>
              <label>
                الرابط
                <input
                  type="url"
                  required
                  value={link.url}
                  onChange={(event) => updateLink(index, "url", event.target.value)}
                  placeholder="https://..."
                  dir="ltr"
                />
              </label>
              {draft.links.length > 1 && (
                <button
                  type="button"
                  className="cancel-button learning-remove-link"
                  onClick={() => removeLink(index)}
                >
                  حذف الرابط
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            className="secondary-button learning-add-link"
            onClick={addLink}
            disabled={draft.links.length >= 10}
          >
            <Plus size={15} /> إضافة رابط آخر
          </button>
        </div>
        <label className="learning-form-wide">
          رابط صورة خلفية للمربع <small>(اختياري — يقبل رابط صورة أو Google Drive)</small>
          <input
            type="url"
            value={draft.backgroundUrl}
            onChange={(event) => setDraft({ ...draft, backgroundUrl: event.target.value })}
            placeholder="https://.../image.jpg"
            dir="ltr"
          />
          <small className="learning-image-hint">
            تأكد أن مشاركة ملف Drive تسمح بالعرض لأي شخص لديه الرابط.
          </small>
        </label>
        <label className="learning-form-wide">
          وصف مختصر <small>(اختياري)</small>
          <textarea
            maxLength={1200}
            rows="2"
            value={draft.description}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          />
        </label>
        {error && <p className="learning-form-error">{error}</p>}
        {notice && <p className="learning-form-notice">{notice}</p>}
        <div className="learning-form-actions">
          <button className="primary-button" type="submit" disabled={saving}>
            {saving ? "جارٍ الحفظ…" : editingId ? "حفظ التعديل" : "إضافة المادة"}
          </button>
          {editingId && (
            <button
              className="cancel-button"
              type="button"
              onClick={() => {
                setEditingId(null);
                setDraft(emptyDraft());
              }}
            >
              إلغاء التعديل
            </button>
          )}
        </div>
      </form>
      <section className="learning-admin-list">
        <div className="section-title-row">
          <div>
            <p className="section-kicker">المحتوى المضاف</p>
            <h2>{items.length} مادة</h2>
          </div>
          <a href="/learning" target="_blank" rel="noreferrer">
            معاينة صفحة الأولاد <ExternalLink size={15} />
          </a>
        </div>
        {Object.entries(grouped).map(([date, dayItems]) => (
          <section className="learning-admin-day" key={date}>
            <h3>
              <CalendarDays size={17} /> الجمعة {dateLabel(date)}
            </h3>
            <div>
              {dayItems.map((item) => (
                <article className="learning-admin-item" key={item.id}>
                  <span className="learning-category-badge">{item.category}</span>
                  <div>
                    <strong>{item.title}</strong>
                    <div className="learning-admin-link-list">
                      {(item.links?.length ? item.links : [{ label: "فتح المادة", url: item.url }]).map(
                        (link, index) => (
                          <a key={index} href={link.url} target="_blank" rel="noreferrer">
                            {link.label}
                          </a>
                        ),
                      )}
                    </div>
                  </div>
                  <button className="secondary-button" type="button" onClick={() => edit(item)}>
                    تعديل
                  </button>
                  <button className="cancel-button" type="button" onClick={() => remove(item)}>
                    حذف
                  </button>
                </article>
              ))}
            </div>
          </section>
        ))}
        {!items.length && <p className="learning-empty">لم تتم إضافة مواد بعد.</p>}
      </section>
    </section>
  );
}

function BooksManagementPage({ items, request, reload, onBack }) {
  const emptyDraft = () => ({ title: "", url: "", coverUrl: "", description: "" });
  const [draft, setDraft] = useState(emptyDraft);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await request(editingId ? `/api/books/${editingId}` : "/api/books", {
        method: editingId ? "PUT" : "POST",
        body: JSON.stringify(draft),
      });
      setDraft(emptyDraft());
      setEditingId(null);
      setNotice(editingId ? "تم تعديل الكتاب" : "تمت إضافة الكتاب");
      await reload();
    } catch (saveError) {
      setError(saveError.message || "تعذر حفظ الكتاب");
    } finally {
      setSaving(false);
    }
  };
  const edit = (item) => {
    setDraft({
      title: item.title,
      url: item.url,
      coverUrl: item.coverUrl || "",
      description: item.description || "",
    });
    setEditingId(item.id);
    setError("");
    setNotice("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const remove = async (item) => {
    if (!window.confirm(`حذف كتاب «${item.title}»؟`)) return;
    setError("");
    try {
      await request(`/api/books/${item.id}`, { method: "DELETE" });
      if (editingId === item.id) {
        setEditingId(null);
        setDraft(emptyDraft());
      }
      await reload();
    } catch (removeError) {
      setError(removeError.message || "تعذر حذف الكتاب");
    }
  };
  return (
    <section className="learning-admin-page books-admin-page">
      <header className="section-title-row learning-admin-heading">
        <div>
          <p className="section-kicker">إدارة الخدمة</p>
          <h1>إدارة الكتب</h1>
          <p>أضف اسم الكتاب وغلافه ورابطه، وهيظهر للأولاد في مكتبة الخورس.</p>
        </div>
        <button type="button" className="secondary-button" onClick={onBack}>
          <ChevronLeft size={16} /> إدارة المحتوى
        </button>
        <span className="learning-storage-note">الكتب تظل على Drive</span>
      </header>
      <form className="table-section learning-admin-form" onSubmit={save}>
        <div className="learning-admin-form-title">
          <BookOpen size={21} />
          <div>
            <strong>{editingId ? "تعديل كتاب" : "إضافة كتاب"}</strong>
            <span>رابط الكتاب والغلاف يقبلان روابط Google Drive أو أي رابط https مباشر.</span>
          </div>
        </div>
        <label>
          اسم الكتاب
          <input
            required
            maxLength={180}
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            placeholder="مثال: قصة القديس أبانوب"
          />
        </label>
        <label>
          رابط الكتاب
          <input
            required
            type="url"
            value={draft.url}
            onChange={(event) => setDraft({ ...draft, url: event.target.value })}
            placeholder="https://drive.google.com/..."
            dir="ltr"
          />
        </label>
        <label className="learning-form-wide">
          رابط صورة الغلاف <small>(اختياري — لو فاضي هنحاول نستخدم معاينة Drive تلقائيًا)</small>
          <input
            type="url"
            value={draft.coverUrl}
            onChange={(event) => setDraft({ ...draft, coverUrl: event.target.value })}
            placeholder="https://.../cover.jpg"
            dir="ltr"
          />
        </label>
        <label className="learning-form-wide">
          وصف مختصر <small>(اختياري)</small>
          <textarea
            maxLength={1200}
            rows="2"
            value={draft.description}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          />
        </label>
        {error && <p className="learning-form-error">{error}</p>}
        {notice && <p className="learning-form-notice">{notice}</p>}
        <div className="learning-form-actions">
          <button className="primary-button" type="submit" disabled={saving}>
            {saving ? "جارٍ الحفظ…" : editingId ? "حفظ التعديل" : "إضافة الكتاب"}
          </button>
          {editingId && (
            <button
              className="cancel-button"
              type="button"
              onClick={() => {
                setEditingId(null);
                setDraft(emptyDraft());
              }}
            >
              إلغاء التعديل
            </button>
          )}
        </div>
      </form>
      <section className="learning-admin-list">
        <div className="section-title-row">
          <div>
            <p className="section-kicker">الكتب المضافة</p>
            <h2>{items.length} كتاب</h2>
          </div>
          <a href="/books" target="_blank" rel="noreferrer">
            معاينة صفحة الأولاد <ExternalLink size={15} />
          </a>
        </div>
        {items.length ? (
          <div className="books-admin-grid">
            {items.map((item) => (
              <article className="book-admin-item" key={item.id}>
                <div className="book-admin-thumb">
                  {item.coverUrl || item.url ? (
                    <img
                      src={learningImageUrl(item.coverUrl || item.url)}
                      alt=""
                      onError={(event) => {
                        event.currentTarget.style.display = "none";
                      }}
                    />
                  ) : (
                    <BookOpen size={26} />
                  )}
                </div>
                <div>
                  <strong>{item.title}</strong>
                  {item.description && <span>{item.description}</span>}
                  <a href={item.url} target="_blank" rel="noreferrer">
                    فتح الرابط <ExternalLink size={14} />
                  </a>
                </div>
                <button className="secondary-button" type="button" onClick={() => edit(item)}>
                  تعديل
                </button>
                <button className="cancel-button" type="button" onClick={() => remove(item)}>
                  حذف
                </button>
              </article>
            ))}
          </div>
        ) : (
          <p className="learning-empty">لم تتم إضافة كتب بعد.</p>
        )}
      </section>
    </section>
  );
}

function PublicNavigation({ subtitle, homeActions }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const isHome = window.location.pathname === "/";

  useEffect(() => {
    if (!menuOpen) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [menuOpen]);

  return (
    <>
      {menuOpen && (
        <button
          className="public-menu-backdrop"
          type="button"
          aria-label="إغلاق القائمة"
          onClick={() => setMenuOpen(false)}
        />
      )}
      <aside
        id="public-main-menu"
        className={`public-menu-drawer ${menuOpen ? "open" : ""}`}
        aria-label="القائمة الرئيسية"
        aria-hidden={!menuOpen}
      >
        <div className="public-menu-heading">
          <strong>القائمة الرئيسية</strong>
          <button type="button" aria-label="إغلاق القائمة" onClick={() => setMenuOpen(false)}>
            <X size={19} />
          </button>
        </div>
        <section className="public-menu-section">
          <p>الخدام</p>
          <a href="/admin">
            <UserCheck size={18} />
            <span>دخول الخدام</span>
            <ChevronLeft size={17} />
          </a>
        </section>
        <section className="public-menu-section">
          <p>المخدومين</p>
          <a href="/league">
            <Trophy size={18} />
            <span>دوري أبانوب</span>
            <ChevronLeft size={17} />
          </a>
          <a href="/life-of-saint-abanoub">
            <img className="public-saint-menu-icon" src="/saint-abanoub-menu-icon.png" alt="" />
            <span>حياة القديس أبانوب</span>
            <ChevronLeft size={17} />
          </a>
          <a href="/learning">
            <BookOpen size={18} />
            <span>إحنا اتعلمنا إيه؟</span>
            <ChevronLeft size={17} />
          </a>
          <a href="/mass-schedule">
            <Church size={18} />
            <span>اعرف قداسك إمتى</span>
            <ChevronLeft size={17} />
          </a>
          <a href="/bible">
            <BookOpen size={18} />
            <span>الكتاب المقدس</span>
            <ChevronLeft size={17} />
          </a>
        </section>
        <section className="public-menu-section">
          <p>التعليم</p>
          <a href="https://stgeorgesaman.com/coptic/" target="_blank" rel="noreferrer">
            <Languages size={18} />
            <span>اللغة القبطية</span>
            <ExternalLink size={15} />
          </a>
          <a href="https://stgeorgesaman.com/libraries/hymns-library/" target="_blank" rel="noreferrer">
            <Music2 size={18} />
            <span>الألحان</span>
            <ExternalLink size={15} />
          </a>
          <a
            href="https://drive.google.com/file/d/1KINWJOvsqfj-I8X7k6cOu1toDTW-SXSu/view?usp=drive_link"
            target="_blank"
            rel="noreferrer"
          >
            <Church size={18} />
            <span>الطقس</span>
            <ExternalLink size={15} />
          </a>
          <a href="/books">
            <BookOpen size={18} />
            <span>كتب</span>
            <ChevronLeft size={17} />
          </a>
        </section>
      </aside>
      <header className="global-brand-header public-site-header">
        <a className="global-brand" href="/" aria-label="العودة للصفحة الرئيسية">
          <img src="/saint-abanoub.png" alt="" />
          <span>
            <strong>خورس القديس أبانوب</strong>
            <small>{subtitle}</small>
          </span>
        </a>
        <div className="global-header-actions">
          {homeActions}
          {!isHome && (
            <a className="global-home-link" href="/">
              <Home size={17} />
              <span>الصفحة الرئيسية</span>
            </a>
          )}
          <button
            type="button"
            className="global-menu-button"
            aria-label="فتح القائمة"
            aria-controls="public-main-menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
          >
            <Menu size={22} />
          </button>
        </div>
      </header>
    </>
  );
}

function PublicParentHome() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showScanner, setShowScanner] = useState(false);
  const [childToken, setChildToken] = useState(
    () => sessionStorage.getItem("parent-notification-child-token") || "",
  );
  useEffect(() => {
    const search = query.trim();
    if (search.length < 2) {
      setResults([]);
      setError("");
      return undefined;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(`${apiUrl}/api/public/people?query=${encodeURIComponent(search)}`, {
          signal: controller.signal,
        });
        const body = await response.json().catch(() => []);
        if (!response.ok) throw new Error(body.error || "تعذر البحث الآن");
        setResults(body);
      } catch (searchError) {
        if (searchError.name !== "AbortError") {
          setResults([]);
          setError(searchError.message);
        }
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  return (
    <main className="public-parent-home">
      <div className="public-home-glow" />
      <PublicNavigation
        subtitle="متابعة حضور الأبناء"
        homeActions={<ParentNotificationCenter childToken={childToken} header />}
      />
      <section className="public-home-content">
        <img className="public-home-saint" src="/saint-abanoub.png" alt="القديس أبانوب" />
        <p className="section-kicker">أهلًا بكم</p>
        <h1>تابع حضور ابنك</h1>
        <p className="public-home-copy">اكتب اسم الابن للوصول إلى تقرير حضور الخورس والقداس.</p>
        <div className="public-home-search">
          <Search size={22} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="ابحث باسم الابن"
            aria-label="البحث باسم الابن"
            autoComplete="off"
          />
          <button
            type="button"
            className="public-scan-button"
            onClick={() => setShowScanner(true)}
            title="مسح QR"
            aria-label="مسح QR"
          >
            <QrCode size={23} />
          </button>
        </div>
        {showScanner && <PublicParentScanner onClose={() => setShowScanner(false)} />}
        {loading && <p className="public-home-status">جاري البحث...</p>}
        {error && <p className="public-home-error">{error}</p>}
        {!loading && query.trim().length >= 2 && !results.length && !error && (
          <p className="public-home-status">لا يوجد ابن بهذا الاسم</p>
        )}
        {results.length > 0 && (
          <div className="public-home-results">
            {results.map((person) => (
              <a
                key={person.token}
                href={`/qr/${person.token}`}
                onClick={() => {
                  sessionStorage.setItem("parent-notification-child-token", person.token);
                  setChildToken(person.token);
                }}
              >
                <span>{person.name}</span>
                <ChevronLeft size={19} />
              </a>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function ParentNotificationCenter({ childToken, header = false }) {
  const [items, setItems] = useState([]);
  const [readMap, setReadMap] = useState(() => storedMap("parent-notification-read-map"));
  const [dismissedMap, setDismissedMap] = useState(() => storedMap("parent-notification-dismissed-map"));
  const [open, setOpen] = useState(false);
  const [permission, setPermission] = useState(() =>
    "Notification" in window ? Notification.permission : "unsupported",
  );
  const knownIds = useRef(null);
  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      try {
        const query = childToken ? `?token=${encodeURIComponent(childToken)}` : "";
        const response = await fetch(`${apiUrl}/api/public/notifications${query}`);
        const body = await response.json().catch(() => []);
        if (!response.ok) throw new Error("تعذر تحميل التنبيهات");
        if (stopped) return;
        const incoming = knownIds.current
          ? body.filter((item) => !knownIds.current.has(String(item.id)))
          : [];
        knownIds.current = new Set(body.map((item) => String(item.id)));
        setItems(body);
        if (document.hidden && permission === "granted") {
          incoming.forEach((item) => {
            const alert = new Notification(item.title, {
              body: item.body,
              icon: "/saint-abanoub.png",
              tag: `parent-${item.id}`,
            });
            alert.onclick = () => {
              window.focus();
              window.location.assign(item.targetUrl);
              alert.close();
            };
          });
        }
      } catch {
        /* The in-page feed remains available and retries on the next poll. */
      }
    };
    refresh();
    const interval = window.setInterval(refresh, 30000);
    const onVisibilityChange = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [childToken, permission]);
  const visibleItems = items.filter((item) => !dismissedMap[item.id]);
  const unreadCount = visibleItems.filter((item) => !readMap[item.id]).length;
  const openItem = (item) => {
    const next = { ...readMap, [item.id]: true };
    setReadMap(next);
    localStorage.setItem("parent-notification-read-map", JSON.stringify(next));
    window.location.assign(item.targetUrl);
  };
  const clearNotifications = () => {
    const nextDismissedMap = {
      ...dismissedMap,
      ...Object.fromEntries(visibleItems.map((item) => [item.id, true])),
    };
    const nextReadMap = { ...readMap, ...Object.fromEntries(visibleItems.map((item) => [item.id, true])) };
    setDismissedMap(nextDismissedMap);
    setReadMap(nextReadMap);
    localStorage.setItem("parent-notification-dismissed-map", JSON.stringify(nextDismissedMap));
    localStorage.setItem("parent-notification-read-map", JSON.stringify(nextReadMap));
  };
  const enableBrowserNotifications = async () => {
    if (!("Notification" in window)) return;
    const nextPermission = await Notification.requestPermission();
    setPermission(nextPermission);
  };
  return (
    <section
      className={`parent-notification-center ${header ? "header-parent-notification-center" : ""}`}
      aria-label="تنبيهات الخورس"
    >
      <button
        type="button"
        className="parent-notification-toggle"
        aria-label={`تنبيهات الخورس${unreadCount ? `، ${unreadCount} غير مقروءة` : ""}`}
        title="تنبيهات الخورس"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Bell size={19} />
        {unreadCount > 0 && <b>{unreadCount}</b>}
        {!header && <span>تنبيهات الخورس</span>}
        {!header && <small>{open ? "إخفاء" : "عرض الجديد"}</small>}
      </button>
      {open && (
        <div className="parent-notification-feed">
          <header>
            <strong>آخر التحديثات</strong>
            <div className="parent-notification-actions">
              {permission !== "unsupported" && permission !== "granted" && (
                <button type="button" onClick={enableBrowserNotifications}>
                  تفعيل إشعارات المتصفح
                </button>
              )}
              <button type="button" onClick={clearNotifications} disabled={!visibleItems.length}>
                مسح الكل
              </button>
            </div>
          </header>
          {visibleItems.map((item) => (
            <button
              type="button"
              className={`parent-notification-item ${readMap[item.id] ? "read" : "unread"}`}
              key={item.id}
              onClick={() => openItem(item)}
            >
              <span className="parent-notification-icon">
                <Bell size={16} />
              </span>
              <span className="parent-notification-copy">
                <strong>{item.title}</strong>
                <small>{item.body}</small>
                <time>{dateLabel(item.date)}</time>
              </span>
              <ChevronLeft size={17} />
            </button>
          ))}
          {!visibleItems.length && <p className="parent-notification-empty">لا توجد تحديثات جديدة حاليًا.</p>}
          {!childToken && visibleItems.length > 0 && (
            <p className="parent-notification-hint">افتح تقرير ابنك مرة واحدة لتصلك تنبيهات درجاته هنا.</p>
          )}
        </div>
      )}
    </section>
  );
}

function SaintAbanoubStoryPage() {
  return (
    <main className="saint-story-page">
      <PublicNavigation subtitle="سيرة القديس" />
      <article className="saint-story-article">
        <p className="saint-story-kicker">قصة من تاريخ الكنيسة</p>
        <h1>حياة القديس أبانوب</h1>
        <p className="saint-story-intro">
          الشهيد أبانوب النهيسي، طفل ارتبطت سيرته بالشجاعة والثبات في الإيمان، وصار اسمه حاضرًا في ذاكرة
          الكنيسة.
        </p>
        <img
          className="saint-story-illustration"
          src="/saint-abanoub-story.png"
          alt="القديس أبانوب في الصلاة تحت السماء"
        />
        <section>
          <h2>نشأته</h2>
          <p>
            وُلد أبانوب في قرية نهيسة، التابعة لمركز طلخا، في القرن الرابع الميلادي. كان والداه مقارة ومريم،
            وقد نشأ في بيت تقي محب لله. وتذكر سيرته أن اسمه يرتبط بكلمة «الذهب». فقد أبانوب والديه وهو في
            الثانية عشرة من عمره، وحزن عليهما أيامًا كثيرة.
          </p>
          <p>
            وفي أحد الأعياد دخل الكنيسة، فسمع الكاهن يشجع الشعب على احتمال الضيق والاضطهاد بفرح، في وقت اشتد
            فيه اضطهاد المسيحيين في عهد دقلديانوس. عاد الفتى إلى بيته بعد التناول، وظلت كلمات العظة تتردد في
            نفسه. صلى طالبًا معونة الله، ثم خرج متجهًا إلى سمنود، عازمًا على إعلان إيمانه.
          </p>
        </section>
        <section>
          <h2>في سمنود</h2>
          <p>
            وجد أبانوب في سمنود كنائس مهدمة وأناسًا يسيئون إلى المسيحية. وبينما كان يطلب معونة الله، تروي
            السيرة أن رئيس الملائكة ميخائيل ظهر له وعزاه، وأرشده أن يذهب في الصباح إلى الوالي ليشهد لإيمانه،
            ووعده بالقوة والعون في العذابات.
          </p>
        </section>
        <section>
          <h2>أمام الوالي والسجن</h2>
          <p>
            ذهب أبانوب إلى الوالي مبكرًا وتحدث بجرأة عن إيمانه. حاول الوالي استمالته بالوعود، لكن الفتى تمسك
            بما يؤمن به، فأمر الوالي بضربه بعنف. وتذكر الرواية أن رئيس الملائكة ميخائيل جاء لمعونته وشفائه. ثم
            أُلقي أبانوب في السجن، ففرح به المسيحيون المسجونون وتعزوا بوجوده بينهم.
          </p>
          <p>
            وفي اليوم التالي، بحسب السيرة، قُتل عدد كبير من المسجونين ونالوا إكليل الشهادة. وأمر الوالي بربط
            أبانوب من قدميه في سارية مركب متجه إلى أتريب، ساخرًا منه ومتحديًا أن يأتي المسيح ليخلصه.
          </p>
        </section>
        <section>
          <h2>من سمنود إلى أتريب</h2>
          <p>
            أبحرت السفينة حتى المساء. وتروي السيرة أن الوالي أصابه المرض، وأن أبانوب رأى الملاك يقترب منه
            ويمسح الدم عنه، ثم أنزله إلى مقدمة المركب. طلب الوالي من الفتى أن يصلي من أجل شفائه، واعدًا أن
            يؤمن هو وجنده إن شُفي. صلى أبانوب، وتذكر الرواية أن الوالي نال الشفاء في أتريب، وأن عددًا من أهلها
            آمنوا.
          </p>
        </section>
        <section>
          <h2>ثباته في أتريب</h2>
          <p>
            تعرض أبانوب في أتريب لألوان من التعذيب، منها الجلد والإلقاء في الزيت المغلي والتعريض للنار
            والكبريت. وتذكر سيرته أن السيد المسيح وملائكته ظهروا له وشجعوه وشفوه. كما تروي تعرضه للأذى في
            عينيه، ثم صدور أوامر ببتر يديه ورجليه، لكنه ظل متمسكًا بإيمانه.
          </p>
          <p>
            وكان ثباته سببًا في تأثر كثيرين وقبولهم الإيمان، بينما استمرت الملائكة، وفق الرواية، في تعزيته
            خلال آلامه.
          </p>
        </section>
        <section>
          <h2>رحلته إلى الإسكندرية</h2>
          <p>
            لما رأى الوالي أن أناسًا كثيرين يؤمنون بسبب أبانوب، أرسله مقيدًا بالسلاسل إلى الإسكندرية. وفي
            الطريق قابل امرأة بها روح نجس، وتذكر السيرة أنه خلصها منه رغم قيود يديه، فآمنت بالمسيح، لكن أحد
            الجنود قتلها.
          </p>
          <p>
            وأمام أرمانيوس والي الإسكندرية أعلن أبانوب إيمانه من جديد، فتعرض لعذابات أخرى، وأُلقي في جب فيه
            حيات وثعابين جائعة. وتقول الرواية إن الله حفظه بملاك، وإن الثعابين خرجت معه، ثم التف أحدها حول عنق
            أرمانيوس. أنقذ أبانوب الوالي، فتعجب كثيرون وآمنوا.
          </p>
        </section>
        <section>
          <h2>استشهاده وذكراه</h2>
          <p>
            بعد عذابات أخرى، قُطعت رأس أبانوب خارج المدينة على صخرة عالية. وتصف سيرته أنه وقف يصلي طالبًا
            المغفرة وقبول روحه. ثم تقدم القديس يوليوس الأقفهصي وحمل جسده وكفنه، وأرسلهما إلى نهيسة، موطن
            ميلاده، حيث دُفن وكتبت سيرته.
          </p>
          <p>
            نُقل جسده من نهيسة إلى سمنود، ويُحتفل بعيد استشهاده في{" "}
            <a
              href="https://st-takla.org/Full-Free-Coptic-Books/Synaxarium-or-Synaxarion/11-Abeeb/24-Abeeb.html"
              target="_blank"
              rel="noreferrer"
            >
              24 من شهر أبيب
            </a>
            .
          </p>
        </section>
        <a
          className="saint-story-video"
          href="https://youtu.be/1Q_tiSr1lRc?si=odnN5pI9y3V14ICb"
          target="_blank"
          rel="noreferrer"
        >
          <span className="saint-story-play" aria-hidden="true">
            ▶
          </span>{" "}
          لمشاهدة القصة
        </a>
      </article>
    </main>
  );
}

function PublicParentScanner({ onClose }) {
  const [scannerError, setScannerError] = useState("");
  useEffect(() => {
    let disposed = false;
    let scanner;
    const stop = async () => {
      if (scanner?.isScanning) await scanner.stop().catch(() => {});
    };
    const start = async () => {
      try {
        const { Html5Qrcode } = await import("html5-qrcode");
        if (disposed) return;
        scanner = new Html5Qrcode("public-qr-reader");
        await scanner.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 230, height: 230 } },
          async (decoded) => {
            const value = String(decoded || "").trim();
            const token = value.includes("/qr/") ? value.split("/qr/").pop().split(/[?#]/)[0] : value;
            if (!token) {
              setScannerError("تعذر قراءة QR");
              return;
            }
            await stop();
            window.location.href = `/qr/${encodeURIComponent(token)}`;
          },
          () => {},
        );
        if (disposed) await stop();
      } catch {
        if (!disposed) setScannerError("اسمح للمتصفح باستخدام الكاميرا");
      }
    };
    void start();
    return () => {
      disposed = true;
      void stop();
    };
  }, []);
  return (
    <div className="public-scanner-panel">
      <div className="public-scanner-heading">
        <strong>امسح QR الخاص بالابن</strong>
      </div>
      <div id="public-qr-reader" className="public-qr-reader" />
      <button className="scanner-close-button" type="button" onClick={onClose}>
        <X size={16} /> إغلاق الكاميرا
      </button>
      {scannerError && <p className="public-home-error">{scannerError}</p>}
    </div>
  );
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
    sessionStorage.setItem("parent-notification-child-token", token);
  }, [token]);
  useEffect(() => {
    fetch(`${apiUrl}/api/public/qr/${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          const detail =
            response.status === 404
              ? "مسار تقرير الـQR غير منشور على الخادم حاليًا. بعد نشر تحديث الباك إند سيظهر التقرير تلقائيًا."
              : body.error || `تعذر تحميل التقرير (${response.status})`;
          throw new Error(detail);
        }
        return body;
      })
      .then((body) => {
        if (!body || !body.person || !Array.isArray(body.attendance)) {
          throw new Error("بيانات التقرير غير مكتملة من الخادم. جرّب إعادة التحميل بعد قليل.");
        }
        setData(body);
      })
      .catch((loadError) => setError(loadError.message || "تعذر الاتصال بالخادم"));
  }, [token]);
  if (error)
    return (
      <main className="public-report-page">
        <PublicNavigation subtitle="تقرير حضور الخورس والقداس" />
        <section className="public-report-error">
          <h1>تعذر فتح التقرير</h1>
          <p>{error}</p>
        </section>
      </main>
    );
  if (!data)
    return (
      <main className="public-report-page">
        <PublicNavigation subtitle="تقرير حضور الخورس والقداس" />
        <section className="public-report-loading">جاري تحميل تقرير الحضور...</section>
      </main>
    );
  const choir = data.attendance.filter((item) => item.type === "choir");
  const mass = data.attendance.filter((item) => item.type === "mass");
  async function sendRequest(event) {
    event.preventDefault();
    setRequestBusy(true);
    setRequestNotice("");
    try {
      const response = await fetch(`${apiUrl}/api/public/qr/${encodeURIComponent(token)}/followup-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: requestType, message: requestMessage }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "تعذر إرسال الطلب");
      setRequestNotice("تم إرسال طلب المتابعة بنجاح");
      setRequestMessage("");
    } catch (sendError) {
      setRequestNotice(sendError.message);
    } finally {
      setRequestBusy(false);
    }
  }
  return (
    <main className="public-report-page">
      <PublicNavigation subtitle="تقرير حضور الخورس والقداس" />
      <section className="public-student-heading">
        <div>
          <p className="section-kicker">تقرير حضور المخدوم</p>
          <h1 className="report-person-heading">
            <PersonAvatar person={data.person} name={data.person.name} size="large" />
            {data.person.name}
          </h1>
          {data.person.address && (
            <a
              className="map-address-link"
              href={mapsSearchUrl(data.person.address)}
              target="_blank"
              rel="noreferrer"
            >
              <MapPin size={16} />
              <span>{data.person.address}</span>
            </a>
          )}
        </div>
        <div className="public-report-actions">
          <button
            type="button"
            className="public-call-button"
            onClick={() => setShowServants(true)}
            aria-haspopup="dialog"
          >
            <Phone size={18} /> اتصل بخادم الخورس
          </button>
          <button
            type="button"
            className="public-followup-button"
            onClick={() => {
              setRequestNotice("");
              setShowFollowUp(true);
            }}
          >
            <MessageCircle size={18} /> طلب متابعة
          </button>
          <a className="public-rank-button" href={`/league?name=${encodeURIComponent(data.person.name)}`}>
            <Trophy size={18} /> اعرف ترتيبي
          </a>
        </div>
      </section>
      {showServants && (
        <div
          className="public-servant-picker-backdrop"
          role="presentation"
          onClick={() => setShowServants(false)}
        >
          <section
            className="public-servant-picker"
            role="dialog"
            aria-modal="true"
            aria-labelledby="servant-picker-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="public-servant-picker-heading">
              <div>
                <p className="section-kicker">الاتصال المباشر</p>
                <h2 id="servant-picker-title">اختر خادمًا للاتصال</h2>
              </div>
              <button
                type="button"
                className="public-picker-close"
                onClick={() => setShowServants(false)}
                aria-label="إغلاق"
              >
                ×
              </button>
            </div>
            <div className="public-servant-list">
              {(data.servants || []).map((servant) => {
                const phone = servant.phone1 || servant.phone2;
                return (
                  <a
                    className="public-servant-contact"
                    key={servant.id}
                    href={phone ? `tel:${phoneHref(phone)}` : undefined}
                    aria-disabled={!phone}
                    onClick={(event) => {
                      if (!phone) event.preventDefault();
                    }}
                  >
                    <span className={`servant-presence-dot ${servant.choirStatus}`} aria-hidden="true" />
                    <span className="public-servant-contact-info">
                      <strong>{servant.name}</strong>
                      <small>
                        {servant.choirStatus === "present"
                          ? "موجود في الخورس"
                          : servant.choirStatus === "absent"
                            ? "غير موجود في خورس اليوم"
                            : "متاح للاتصال"}
                      </small>
                    </span>
                    <span className="public-servant-contact-action">
                      {phone ? <Phone size={17} /> : "بدون رقم"}
                    </span>
                  </a>
                );
              })}
              {!(data.servants || []).length && <p className="empty-row">لا يوجد خدام مسجلون للاتصال</p>}
            </div>
            <p className="public-picker-note">
              الحالة الخضراء أو الحمراء تظهر يوم الجمعة فقط، وفي باقي الأيام الخادم متاح للاتصال.
            </p>
          </section>
        </div>
      )}
      {showFollowUp && (
        <div className="public-followup-backdrop" role="presentation" onClick={() => setShowFollowUp(false)}>
          <section
            className="public-followup-request public-followup-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="followup-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="public-followup-heading">
              <div>
                <p className="section-kicker">مساعدة ومتابعة</p>
                <h2 id="followup-title">اطلب متابعة من الخادم</h2>
              </div>
              <button
                type="button"
                className="public-picker-close"
                onClick={() => setShowFollowUp(false)}
                aria-label="إغلاق"
              >
                ×
              </button>
            </div>
            <p className="public-followup-copy">
              اختر نوع المتابعة التي تحتاجها، وسيصل طلبك إلى خدام الخورس.
            </p>
            <form onSubmit={sendRequest}>
              <label>
                نوع المتابعة
                <select value={requestType} onChange={(event) => setRequestType(event.target.value)}>
                  <option value="call">طلب اتصال</option>
                  <option value="visit">طلب زيارة</option>
                </select>
              </label>
              <label>
                رسالة اختيارية
                <textarea
                  rows="3"
                  value={requestMessage}
                  onChange={(event) => setRequestMessage(event.target.value)}
                  placeholder="اكتب تفاصيل تساعد الخادم على متابعتك"
                />
              </label>
              <button className="public-call-button" disabled={requestBusy}>
                {requestBusy ? "جاري الإرسال" : "إرسال طلب المتابعة"}
              </button>
              {requestNotice && (
                <p role="status" className={requestNotice.startsWith("تم") ? "success" : "error"}>
                  {requestNotice}
                </p>
              )}
            </form>
          </section>
        </div>
      )}
      <section className="public-attendance-summary">
        <PublicMetric
          label="حضور الخورس"
          value={data.person.choirCount}
          absent={data.person.choirAbsent}
          rate={data.person.choirRate}
        />
        <PublicMetric
          label="حضور القداس"
          value={data.person.massCount}
          absent={data.person.massAbsent}
          rate={data.person.massRate}
        />
        <PublicMetric label="عدد الجمعات" value={data.person.fridaySessions} />
      </section>
      <section className="public-monthly-report">
        <div className="public-section-heading">
          <div>
            <p className="section-kicker">ملخص المتابعة</p>
            <h2>الحضور والغياب حسب الشهر</h2>
          </div>
          <span>من ٢ أكتوبر ٢٠٢٦</span>
        </div>
        <div className="public-month-list">
          {data.monthly.map((month) => (
            <article key={month.month}>
              <strong>{month.month}</strong>
              <span>
                خورس <b>{month.choir}</b>
                <small>
                  غياب {month.choirAbsent} · {month.choirRate}%
                </small>
              </span>
              <span>
                قداس <b>{month.mass}</b>
                <small>
                  غياب {month.massAbsent} · {month.massRate}%
                </small>
              </span>
            </article>
          ))}
          {!data.monthly.length && <p className="empty-row">لا توجد تسجيلات حضور حتى الآن</p>}
        </div>
      </section>
      <section className="public-history">
        <div className="public-section-heading">
          <div>
            <p className="section-kicker">السجل التفصيلي</p>
            <h2>مواعيد الحضور</h2>
          </div>
          <span>التاريخ والساعة</span>
        </div>
        <div className="public-history-list">
          {data.attendance.map((item) => (
            <article key={`${item.type}-${item.date}-${item.recordedAt}`}>
              <span className={`public-type ${item.type === "choir" ? "choir" : "mass"}`}>
                {item.type === "choir" ? "خورس" : "قداس"}
              </span>
              <div>
                <strong>{dateLabel(item.date)}</strong>
                <small>{publicTimeLabel(item.recordedAt)}</small>
              </div>
            </article>
          ))}
          {!data.attendance.length && <p className="empty-row">لا توجد تسجيلات حضور حتى الآن</p>}
        </div>
      </section>
    </main>
  );
}

function PublicMetric({ label, value, absent, rate }) {
  return (
    <article>
      <span>{label}</span>
      <strong>{value}</strong>
      {absent !== undefined && (
        <small className="public-rate">
          غياب {absent} · حضور {rate}%
        </small>
      )}
    </article>
  );
}
function publicTimeLabel(value) {
  const [stamp, comment = ""] = String(value || "").split("|");
  const [date, time] = stamp.split("T");
  if (!time) return comment ? <span className="public-attendance-comment">ملاحظة: {comment}</span> : "—";
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const formatted = new Intl.DateTimeFormat("ar-EG", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(year, month - 1, day, hour, minute));
  return comment ? (
    <>
      <span>{formatted}</span>
      <em className="public-attendance-comment">ملاحظة: {comment}</em>
    </>
  ) : (
    formatted
  );
}

function StraySheepPage({ people, openReport, template, saveTemplate }) {
  const [draft, setDraft] = useState(template || defaultWhatsAppTemplate);
  const [saving, setSaving] = useState(false);
  const [templateError, setTemplateError] = useState("");
  useEffect(() => setDraft(template || defaultWhatsAppTemplate), [template]);
  const rows = people
    .filter((person) => person.role !== "servant")
    .map((person) => {
      const attendance = (person.choirCount || 0) + (person.massCount || 0);
      const followUp = (person.visitCount || 0) + (person.callCount || 0);
      const activity = attendance * 2 + followUp;
      return { ...person, attendance, followUp, activity, need: followUpNeedPercent(person) };
    })
    .sort(
      (a, b) => a.activity - b.activity || a.attendance - b.attendance || a.name.localeCompare(b.name, "ar"),
    );
  const phoneFor = (row) =>
    String(row.phone1 || row.phone2 || "")
      .replace(/\D/g, "")
      .replace(/^0/, "20");
  const makeMessage = (row) => {
    const firstName =
      String(row.name || "")
        .trim()
        .split(/\s+/)[0] || "";
    return (draft || defaultWhatsAppTemplate)
      .replace(/\{\{\s*name\s*\}\}/gi, firstName)
      .replace(/\{\{\s*group\s*\}\}/gi, row.group || "");
  };
  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setTemplateError("");
    try {
      await saveTemplate(draft);
    } catch (error) {
      setTemplateError(error.message || "تعذر حفظ الرسالة");
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="stray-page">
      <section className="stray-hero">
        <div>
          <p className="section-kicker">متابعة الرعاية</p>
          <h2>الخروف الضال</h2>
          <p>الأسماء الأكثر احتياجًا للمتابعة حسب الحضور والافتقاد.</p>
        </div>
        <img className="sheep-hero-icon" src="/sheep-icon.svg" alt="خروف" />
      </section>
      <section className="stray-note">
        <strong>طريقة الترتيب</strong>
        <span>الأعلى في القائمة هو الأقل حضورًا في الخورس والقداس، والأقل افتقادًا بالزيارة والاتصال.</span>
      </section>
      <form className="table-section stray-whatsapp-template" onSubmit={save}>
        <div>
          <p className="section-kicker">رسالة واتساب جاهزة</p>
          <h2>اكتب الرسالة واحفظها لاستخدامها مع الأولاد</h2>
          <small>
            استخدم {"{{name}}"} للاسم و{"{{group}}"} للجروب.
          </small>
        </div>
        <textarea
          rows="3"
          maxLength={2000}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="نص رسالة واتساب"
        />
        {templateError && <p className="inline-error">{templateError}</p>}
        <button className="secondary-button" type="submit" disabled={saving}>
          {saving ? "جاري الحفظ…" : "حفظ الرسالة"}
        </button>
      </form>
      <section className="table-section stray-table">
        <div className="section-title-row table-title-row">
          <div>
            <p className="section-kicker">أولوية المتابعة</p>
            <h2>{rows.length} مخدوم</h2>
          </div>
          <span className="date-label">من الأكثر احتياجًا إلى الأقل</span>
        </div>
        <div className="stray-list">
          {rows.map((row, index) => {
            const phone = phoneFor(row);
            const href = phone ? `https://wa.me/${phone}?text=${encodeURIComponent(makeMessage(row))}` : "";
            return (
              <article className={`stray-person group-tone-${groupTone(row.group)}`} key={row.id}>
                <button
                  type="button"
                  className="stray-open-report"
                  onClick={() => openReport(row)}
                  aria-label={`فتح تقرير ${row.name}`}
                >
                  <span className="stray-rank">{index + 1}</span>
                  <span className="stray-person-info">
                    <span className="person-name-with-avatar">
                      <PersonAvatar person={row} name={row.name} /> <strong>{row.name}</strong>
                    </span>
                    <small>{row.phone1 || row.phone2 || "بدون رقم"}</small>
                  </span>
                </button>
                <span className="stray-stats">
                  <b>{row.need}%</b>
                  <small>احتياج متابعة</small>
                </span>
                <span className="stray-counts">
                  <span>خورس {row.choirCount || 0}</span>
                  <span>قداس {row.massCount || 0}</span>
                  <span>زيارة {row.visitCount || 0}</span>
                  <span>اتصال {row.callCount || 0}</span>
                </span>
                {href ? (
                  <a className="stray-whatsapp-button" href={href} target="_blank" rel="noreferrer">
                    <MessageCircle size={16} /> واتساب
                  </a>
                ) : (
                  <span className="stray-whatsapp-unavailable">لا يوجد رقم</span>
                )}
              </article>
            );
          })}
        </div>
        {!rows.length && <p className="empty-row">لا توجد بيانات مخدومين</p>}
      </section>
    </section>
  );
}

function FollowUpNotesPage({ notes, rows, request, password, reload }) {
  const [personId, setPersonId] = useState("");
  const [servant, setServant] = useState("");
  const [type, setType] = useState("visit");
  const [date, setDate] = useState(today());
  const [note, setNote] = useState("");
  const save = async (event) => {
    event.preventDefault();
    await request(
      "/api/followup-notes",
      { method: "POST", body: JSON.stringify({ personId: Number(personId), servant, type, date, note }) },
      password,
    );
    setNote("");
    await reload();
  };
  return (
    <section className="visit-reports-page">
      <section className="reports-hero">
        <div>
          <p className="section-kicker">ملاحظات الافتقاد</p>
          <h2>سجل ملاحظات الخدام</h2>
          <p>اكتب ملاحظة لباقي الخدام مرتبطة بولد وتاريخ واضح.</p>
        </div>
      </section>
      <form className="panel followup-note-form" onSubmit={save}>
        <label>
          الولد
          <select required value={personId} onChange={(event) => setPersonId(event.target.value)}>
            <option value="">اختر الاسم</option>
            {rows
              .filter((row) => row.role !== "servant")
              .map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          اسم الخادم
          <select required value={servant} onChange={(event) => setServant(event.target.value)}>
            <option value="">اختر الخادم</option>
            {rows
              .filter((row) => row.role === "servant")
              .map((row) => (
                <option key={row.id} value={row.name}>
                  {row.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          النوع
          <select value={type} onChange={(event) => setType(event.target.value)}>
            <option value="visit">زيارة</option>
            <option value="call">اتصال</option>
          </select>
        </label>
        <label>
          التاريخ
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </label>
        <label className="form-wide">
          الملاحظة
          <textarea required rows="3" value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
        <button className="primary-button" type="submit">
          حفظ الملاحظة
        </button>
      </form>
      <section className="table-section">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>التاريخ</th>
                <th>الولد</th>
                <th>الخادم</th>
                <th>النوع</th>
                <th>الملاحظة</th>
                <th>إجراء</th>
              </tr>
            </thead>
            <tbody>
              {notes.map((item) => (
                <tr key={item.id}>
                  <td>{dateLabel(item.date)}</td>
                  <td className="name-cell">{item.name}</td>
                  <td>{item.servant}</td>
                  <td>{item.type === "visit" ? "زيارة" : "اتصال"}</td>
                  <td>{item.note}</td>
                  <td>
                    <button
                      className="cancel-button"
                      type="button"
                      onClick={async () => {
                        await request(`/api/followup-notes/${item.id}`, { method: "DELETE" }, password);
                        await reload();
                      }}
                    >
                      حذف
                    </button>
                  </td>
                </tr>
              ))}
              {!notes.length && (
                <tr>
                  <td colSpan="6">لا توجد ملاحظات حتى الآن</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}

function FollowUpRequestsPage({ requests, request, password, reload }) {
  const statusLabel = { new: "جديد", in_progress: "قيد المتابعة", done: "تم التنفيذ" };
  return (
    <section className="visit-reports-page">
      <section className="reports-hero">
        <div>
          <p className="section-kicker">طلبات الأهالي</p>
          <h2>طلبات المتابعة</h2>
          <p>راجع طلبات الاتصال والزيارة وحدث حالتها.</p>
        </div>
      </section>
      <section className="table-section">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>التاريخ</th>
                <th>الولد</th>
                <th>النوع</th>
                <th>الرسالة</th>
                <th>الحالة</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((item) => (
                <tr key={item.id}>
                  <td>{dateLabel(item.createdAt.slice(0, 10))}</td>
                  <td className="name-cell">{item.name}</td>
                  <td>{item.type === "call" ? "اتصال" : "زيارة"}</td>
                  <td>{item.message || "بدون رسالة"}</td>
                  <td>
                    <select
                      value={item.status}
                      onChange={async (event) => {
                        await request(
                          `/api/followup-requests/${item.id}`,
                          { method: "PATCH", body: JSON.stringify({ status: event.target.value }) },
                          password,
                        );
                        await reload();
                      }}
                    >
                      {Object.entries(statusLabel).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
              {!requests.length && (
                <tr>
                  <td colSpan="5">لا توجد طلبات متابعة حتى الآن</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}

function NotificationsPage({ notifications, readMap, onOpen, onMarkAllRead, onClear }) {
  const unreadCount = notifications.filter((item) => !readMap[item.id]).length;
  return (
    <section className="notification-center">
      <div className="section-title-row notification-center-heading">
        <div>
          <p className="section-kicker">مركز التنبيهات</p>
          <h1>التنبيهات</h1>
        </div>
        <div className="notification-center-actions">
          <button className="secondary-button" type="button" onClick={onMarkAllRead} disabled={!unreadCount}>
            تحديد الكل كمقروء
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={onClear}
            disabled={!notifications.length}
          >
            مسح الكل
          </button>
        </div>
      </div>
      <div className="notification-feed">
        {notifications.map((item) => (
          <article className={`notification-entry ${readMap[item.id] ? "read" : "unread"}`} key={item.id}>
            <span className="notification-entry-mark" aria-hidden="true">
              <Bell size={17} />
            </span>
            <div className="notification-entry-content">
              <div className="notification-entry-meta">
                <span>{item.sourceLabel}</span>
                <time>{dateLabel(String(item.createdAt || item.date || "").slice(0, 10))}</time>
              </div>
              <h2>{item.title}</h2>
              <p>{item.body}</p>
            </div>
            <button className="notification-open-button" type="button" onClick={() => onOpen(item)}>
              فتح {item.sourceLabel}
            </button>
          </article>
        ))}
        {!notifications.length && <p className="empty-row">لا توجد تنبيهات حتى الآن</p>}
      </div>
    </section>
  );
}

function ServiceAnalyticsPage({ analytics, exportFull }) {
  const summary = analytics.summary || {};
  const monthly = analytics.monthly || [];
  const maxMonthly = Math.max(
    1,
    ...monthly.flatMap((item) => [item.choir || 0, item.mass || 0, item.visits || 0, item.calls || 0]),
  );
  const monthName = (month) =>
    new Intl.DateTimeFormat("ar-EG", { month: "short", year: "numeric" }).format(
      new Date(`${month}-01T12:00:00`),
    );
  return (
    <section className="service-analytics-page">
      <section className="analytics-hero">
        <div>
          <p className="section-kicker">لوحة تحليل الخدمة</p>
          <h1>صورة شاملة للخدمة</h1>
          <p>
            البيانات من {summary.startedAt ? dateLabel(summary.startedAt) : "بداية التسجيل"} حتى{" "}
            {dateLabel(today())}.
          </p>
        </div>
        <button className="primary-button analytics-export-button" type="button" onClick={exportFull}>
          <Download size={17} /> تنزيل ملف Excel
        </button>
      </section>
      <section
        className={`table-section analytics-forecast-card ${analytics.forecast ? "is-ready" : "is-pending"}`}
      >
        <div>
          <p className="section-kicker">توقع مبدئي</p>
          <h2>التوقع للجمعة القادمة</h2>
          <p>
            {analytics.forecast
              ? `مبني على ${analytics.forecast.basedOnSessions || 0} جلسات مسجلة، ويزيد تحسنه مع استمرار التسجيل.`
              : "خدمة التنبؤ غير مربوطة بعد. أضف رابط خدمة ML في VITE_FORECAST_URL ثم أعد النشر."}
          </p>
        </div>
        {analytics.forecast ? (
          <div className="analytics-forecast-values">
            <strong>
              {analytics.forecast.nextChoirAttendance || 0}
              <span> حضور خورس متوقع</span>
            </strong>
            <strong>
              {analytics.forecast.nextMassAttendance || 0}
              <span> حضور قداس متوقع</span>
            </strong>
            <strong>
              {analytics.forecast.nextVisits || 0}
              <span> زيارة متوقعة</span>
            </strong>
            <strong>
              {analytics.forecast.nextCalls || 0}
              <span> اتصال متوقع</span>
            </strong>
          </div>
        ) : (
          <span className="analytics-forecast-status">في انتظار الربط</span>
        )}
      </section>
      <section className="analytics-kpi-grid">
        <AnalyticsMetric
          label="الأولاد المسجلون"
          value={summary.boys || 0}
          note="أفراد الخورس النشطون"
          tone="blue"
        />
        <AnalyticsMetric label="الخدام" value={summary.servants || 0} note="الخدام النشطون" tone="gold" />
        <AnalyticsMetric
          label="حضور الخورس"
          value={`${summary.choirRate || 0}%`}
          note={`${summary.choirAttendance || 0} حضور مسجل`}
          tone="green"
        />
        <AnalyticsMetric
          label="حضور القداس"
          value={`${summary.massRate || 0}%`}
          note={`${summary.massAttendance || 0} حضور مسجل`}
          tone="violet"
        />
        <AnalyticsMetric label="الزيارات" value={summary.visits || 0} note="من بداية الخدمة" tone="teal" />
        <AnalyticsMetric label="الاتصالات" value={summary.calls || 0} note="من بداية الخدمة" tone="amber" />
      </section>
      <section className="table-section analytics-trend-card">
        <div className="section-title-row">
          <div>
            <p className="section-kicker">اتجاه النشاط</p>
            <h2>الحضور والافتقاد حسب الشهر</h2>
          </div>
          <div className="analytics-legend">
            <span className="choir">خورس</span>
            <span className="mass">قداس</span>
            <span className="visits">زيارة</span>
            <span className="calls">اتصال</span>
          </div>
        </div>
        {monthly.length ? (
          <div className={`analytics-month-bars ${monthly.length > 6 ? "has-many" : ""}`}>
            {monthly.map((item) => (
              <div className="analytics-month-column" key={item.month}>
                <div className="analytics-bars">
                  {[
                    ["choir", item.choir],
                    ["mass", item.mass],
                    ["visits", item.visits],
                    ["calls", item.calls],
                  ].map(([kind, value]) => (
                    <i
                      className={kind}
                      key={kind}
                      title={`${kind}: ${value}`}
                      style={{ height: `${Math.max(5, ((Number(value) || 0) * 100) / maxMonthly)}%` }}
                    />
                  ))}
                </div>
                <strong>{monthName(item.month)}</strong>
                <small>
                  {(item.choir || 0) + (item.mass || 0) + (item.visits || 0) + (item.calls || 0)} حركة
                </small>
              </div>
            ))}
          </div>
        ) : (
          <p className="learning-empty">لا توجد سجلات كافية لعرض الاتجاه بعد.</p>
        )}
      </section>
      <section className="analytics-detail-grid">
        <section className="table-section analytics-table-card">
          <div className="section-title-row">
            <div>
              <p className="section-kicker">الخدام</p>
              <h2>نشاط الخدام</h2>
            </div>
          </div>
          <div className="table-scroll-wrap">
            <table className="analytics-table">
              <thead>
                <tr>
                  <th>الخادم</th>
                  <th>اتصالات</th>
                  <th>خورس</th>
                  <th>قداس</th>
                </tr>
              </thead>
              <tbody>
                {(analytics.servants || []).map((item) => (
                  <tr key={item.name}>
                    <td>
                      <span className="person-name-with-avatar">
                        <PersonAvatar name={item.name} />
                        {item.name}
                      </span>
                    </td>
                    <td>{item.calls}</td>
                    <td>{item.choir}</td>
                    <td>{item.mass}</td>
                  </tr>
                ))}
                {!analytics.servants?.length && (
                  <tr>
                    <td colSpan="4">لا توجد بيانات خدام بعد.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </section>
      <section className="table-section analytics-needs-card">
        <div className="section-title-row">
          <div>
            <p className="section-kicker">أولوية المتابعة</p>
            <h2>أولاد يحتاجون اهتمامًا أكثر</h2>
            <p>مرتبة حسب انخفاض الحضور والافتقاد المسجلين.</p>
          </div>
        </div>
        <div className="analytics-needs-list">
          {(analytics.needsAttention || []).map((person) => (
            <article key={person.recordKey}>
              <div>
                <span className="person-name-with-avatar">
                  <PersonAvatar person={person} name={person.name} />
                  <strong>{person.name}</strong>
                </span>
                <small>مجموعة {person.group || "—"}</small>
              </div>
              <span>خورس {person.choirRate}%</span>
              <span>قداس {person.massRate}%</span>
              <span>افتقاد {person.followUpRate}%</span>
            </article>
          ))}
          {!analytics.needsAttention?.length && (
            <p className="learning-empty">لا توجد بيانات كافية لتحديد الأولوية.</p>
          )}
        </div>
      </section>
    </section>
  );
}

function AnalyticsMetric({ label, value, note, tone }) {
  return (
    <article className={`analytics-metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  );
}

function VisitReportsPage({ reports, exportCsv, month, setMonth }) {
  const [period, setPeriod] = useState("day");
  const [selectedDetail, setSelectedDetail] = useState(null);
  useEffect(() => {
    if (!selectedDetail) return undefined;
    const dismiss = (event) => {
      if (!event.target.closest(".report-bar-column")) setSelectedDetail(null);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [selectedDetail]);
  const weeksFromDaily = (daily = [], detailsMap = {}) => {
    const weeks = new Map();
    daily.forEach((item) => {
      if (!item.date) return;
      const date = new Date(`${item.date}T12:00:00`);
      if (Number.isNaN(date.getTime())) return;
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - ((date.getDay() + 2) % 7));
      const key = `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, "0")}-${String(weekStart.getDate()).padStart(2, "0")}`;
      const week = weeks.get(key) || { key, start: weekStart, count: 0, details: [] };
      week.count += Number(item.count) || 0;
      week.details.push(...(detailsMap[item.date] || []));
      weeks.set(key, week);
    });
    const weekNames = ["الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس"];
    return [...weeks.values()]
      .sort((a, b) => a.start - b.start)
      .map((week, index) => {
        const end = new Date(week.start);
        end.setDate(end.getDate() + 6);
        const endKey = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;
        return {
          ...week,
          label: `الأسبوع ${weekNames[index] || index + 1}`,
          dateRange: `${dateLabel(week.key)} – ${dateLabel(endKey)}`,
        };
      });
  };
  const chart = (title, icon, daily, monthly, yearly, empty) => {
    const detailSources =
      title === "الزيارات"
        ? {
            day: reports.visitDetails || {},
            month: reports.visitMonthlyDetails || {},
            year: reports.visitYearlyDetails || {},
          }
        : {
            day: reports.callDetails || {},
            month: reports.callMonthlyDetails || {},
            year: reports.callYearlyDetails || {},
          };
    const dailyDetails = detailSources.day;
    const data =
      period === "day"
        ? daily || []
        : period === "week"
          ? weeksFromDaily(daily, dailyDetails)
          : period === "month"
            ? monthly || []
            : yearly || [];
    const detailsMap = detailSources[period];
    const max = Math.max(1, ...data.map((item) => item.count || 0));
    return (
      <section className="table-section report-chart-card">
        <div className="section-title-row table-title-row">
          <div>
            <p className="section-kicker">
              {icon} {title}
            </p>
            <h2>
              {period === "day"
                ? `أيام شهر ${reports.month}`
                : period === "week"
                  ? `أسابيع شهر ${reports.month}`
                  : period === "month"
                    ? `شهور سنة ${reports.year}`
                    : "السنوات"}
            </h2>
          </div>
          <span className="date-label">{data.reduce((sum, item) => sum + (item.count || 0), 0)} شخص</span>
        </div>
        <div className={`report-bar-chart ${data.length > 6 ? "has-many" : ""}`}>
          {data.map((item) => {
            const label =
              period === "week"
                ? item.label
                : period === "day"
                  ? dateLabel(item.date)
                  : period === "month"
                    ? item.month
                    : item.year;
            const detailKey = period === "week" ? item.key : period === "day" ? item.date : String(label);
            const details = period === "week" ? item.details : detailsMap[detailKey] || [];
            const selected = selectedDetail?.title === title && selectedDetail.key === detailKey;
            return (
              <div
                className={`report-bar-column ${selected ? "selected" : ""}`}
                key={String(label)}
                onClick={(event) => {
                  event.stopPropagation();
                  setSelectedDetail(selected ? null : { title, key: detailKey, label, details });
                }}
              >
                <strong>{item.count}</strong>
                <i style={{ height: `${Math.max(8, ((item.count || 0) * 100) / max)}%` }} />
                <span>{label}</span>
                {selected && (
                  <div className="report-detail-popover">
                    <b>
                      {title} {label}
                    </b>
                    {period === "week" && <small>{item.dateRange}</small>}
                    {details.length ? (
                      <ul>
                        {details.map((detail) => (
                          <li key={`${detailKey}-${detail.recordKey}`}>
                            {detail.name}
                            {title === "الاتصالات" && <small> بواسطة {detail.servant || "غير مسجل"}</small>}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <small>لا توجد أسماء مسجلة في هذه الفترة</small>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {!data.length && <p className="empty-row">{empty}</p>}
        </div>
      </section>
    );
  };
  return (
    <section className="visit-reports-page">
      <section className="reports-hero">
        <div>
          <p className="section-kicker">تقارير الافتقاد</p>
          <h2>الزيارات والاتصالات</h2>
          <p>اختار الفترة وشوف التقدم في جراف واضح.</p>
        </div>
        <div className="reports-hero-actions">
          <label className="report-month-picker">
            الشهر
            <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
          </label>
          <div className="report-period-switch">
            <button className={period === "day" ? "active" : ""} onClick={() => setPeriod("day")}>
              يومي
            </button>
            <button className={period === "week" ? "active" : ""} onClick={() => setPeriod("week")}>
              أسبوعي
            </button>
            <button className={period === "month" ? "active" : ""} onClick={() => setPeriod("month")}>
              شهري
            </button>
            <button className={period === "year" ? "active" : ""} onClick={() => setPeriod("year")}>
              سنوي
            </button>
          </div>
          <button className="secondary-button" onClick={exportCsv}>
            <Copy size={15} /> تصدير
          </button>
          <BarChart3 size={30} />
        </div>
      </section>
      {chart(
        "الزيارات",
        "زيارة",
        reports.daily,
        reports.monthly,
        reports.yearly,
        "لا توجد زيارات في الفترة المختارة",
      )}
      {chart(
        "الاتصالات",
        "اتصال",
        reports.callDaily,
        reports.callMonthly,
        reports.callYearly,
        "لا توجد اتصالات في الفترة المختارة",
      )}
    </section>
  );
}

function phoneHref(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("20")) return `+${digits}`;
  if (digits.startsWith("0")) return `+20${digits.slice(1)}`;
  return `+20${digits}`;
}
function CopyPhone({ value, secondary = "", name, label }) {
  const numbers = (
    label
      ? [[value, label]]
      : [
          [value, "رقم 1"],
          [secondary, "رقم 2"],
        ]
  ).filter(([number]) => number);
  if (!numbers.length) return <span>—</span>;
  return (
    <span className="phone-copy-cell phone-actions">
      {numbers.map(([number, numberLabel]) => (
        <a
          className="call-phone"
          href={`tel:${phoneHref(number)}`}
          title={`${numberLabel} - الاتصال بـ ${name}`}
          aria-label={`${numberLabel} - الاتصال بـ ${name}`}
          key={numberLabel}
        >
          <Phone size={13} /> {numberLabel}
        </a>
      ))}
    </span>
  );
}

function HomeDashboard({
  dashboard,
  dashboardDate,
  setDashboardDate,
  trendMonth,
  setTrendMonth,
  openReport,
}) {
  const [selectedMetric, setSelectedMetric] = useState(null);
  const daily = dashboard.dailySummary || { total: 0, choirPresent: 0, massPresent: 0 };
  const dailyPeople = (dashboard.dailyPeople || []).filter((person) => person.role !== "servant");
  const allPeople = (dashboard.people || []).filter((person) => person.role !== "servant");
  const choirAbsent = Math.max(0, daily.total - daily.choirPresent);
  const massAbsent = Math.max(0, daily.total - daily.massPresent);
  const attendancePercent = daily.total
    ? Math.round(((daily.choirPresent + daily.massPresent) / (daily.total * 2)) * 100)
    : 0;
  const metrics = [
    { label: "إجمالي الخورس", value: daily.total, people: dailyPeople },
    {
      label: "حضور الخورس",
      value: daily.choirPresent,
      detail: `${daily.total ? Math.round((daily.choirPresent * 100) / daily.total) : 0}%`,
      tone: "teal",
      people: dailyPeople.filter((person) => person.choirPresent),
    },
    {
      label: "غياب الخورس",
      value: choirAbsent,
      detail: `${daily.total ? Math.round((choirAbsent * 100) / daily.total) : 0}%`,
      tone: "amber",
      people: dailyPeople.filter((person) => !person.choirPresent),
    },
    {
      label: "حضور القداس",
      value: daily.massPresent,
      detail: `${daily.total ? Math.round((daily.massPresent * 100) / daily.total) : 0}%`,
      tone: "blue",
      people: dailyPeople.filter((person) => person.massPresent),
    },
    {
      label: "غياب القداس",
      value: massAbsent,
      detail: `${daily.total ? Math.round((massAbsent * 100) / daily.total) : 0}%`,
      tone: "red",
      people: dailyPeople.filter((person) => !person.massPresent),
    },
    {
      label: "نسبة الحضور العامة",
      value: `${attendancePercent}%`,
      detail: "خورس + قداس",
      tone: "navy",
      people: dailyPeople.filter((person) => person.choirPresent || person.massPresent),
    },
  ];
  return (
    <section className="home-dashboard">
      <div className="dashboard-hero">
        <div>
          <p className="section-kicker">لوحة حضور اليوم</p>
          <h2>اجتماع خورس القديس أبانوب</h2>
          <p>اختر التاريخ لمراجعة حضور الخورس والقداس.</p>
        </div>
        <div className="hero-date">
          <label>
            التاريخ
            <input
              type="date"
              value={dashboardDate}
              onChange={(event) => setDashboardDate(event.target.value)}
            />
          </label>
          <img src="/saint-abanoub.png" alt="القديس أبانوب" />
        </div>
      </div>
      <div className="dashboard-metrics">
        {metrics.map((metric) => (
          <Metric key={metric.label} {...metric} onClick={() => setSelectedMetric(metric)} />
        ))}
      </div>
      <div className="dashboard-main-grid">
        <DailyAttendanceChart people={dailyPeople} total={daily.total} />
      </div>
      <WeeklyTrendChart
        trend={dashboard.weeklyTrend || []}
        total={daily.total}
        month={trendMonth}
        setMonth={setTrendMonth}
      />
      <div className="dashboard-attendance-columns">
        <DailyList
          title="الأكثر حضورًا للقداس"
          metric="massCount"
          allPeople={allPeople}
          openReport={openReport}
        />
        <DailyList
          title="الأكثر حضورًا للخورس"
          metric="choirCount"
          allPeople={allPeople}
          openReport={openReport}
        />
        <DailyList
          title="الأقل حضورًا للقداس"
          metric="massCount"
          order="asc"
          allPeople={allPeople}
          openReport={openReport}
        />
        <DailyList
          title="الأقل حضورًا للخورس"
          metric="choirCount"
          order="asc"
          allPeople={allPeople}
          openReport={openReport}
        />
      </div>
      {selectedMetric && (
        <DashboardPeopleModal metric={selectedMetric} close={() => setSelectedMetric(null)} />
      )}
    </section>
  );
}

function Metric({ label, value, detail, tone, onClick }) {
  return (
    <button type="button" className={`dashboard-metric metric-button ${tone || ""}`} onClick={onClick}>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </button>
  );
}
function DashboardPeopleModal({ metric, close }) {
  return (
    <div className="modal">
      <button className="modal-backdrop" aria-label="إغلاق القائمة" onClick={close} />
      <section className="report-dialog dashboard-people-dialog" role="dialog" aria-modal="true">
        <button className="modal-close" aria-label="إغلاق" onClick={close}>
          <X size={18} />
        </button>
        <p className="section-kicker">تفاصيل حضور اليوم</p>
        <h2>{metric.label}</h2>
        <div className="report-meta">{metric.people.length} اسم</div>
        <div className="dashboard-people-list">
          {metric.people.map((person) => (
            <article key={person.id}>
              <strong>{person.name}</strong>
              <span>جروب {person.group || "—"}</span>
            </article>
          ))}
          {!metric.people.length && <p className="empty-row">لا توجد أسماء في هذه القائمة</p>}
        </div>
      </section>
    </div>
  );
}
function DailyList({ title, metric, order = "desc", allPeople, openReport }) {
  const direction = order === "asc" ? 1 : -1;
  const ranked = [...allPeople].sort(
    (a, b) => direction * ((a[metric] || 0) - (b[metric] || 0)) || a.name.localeCompare(b.name, "ar"),
  );
  return (
    <section className="table-section attendance-list-panel">
      <div className="section-title-row table-title-row">
        <h2>{title}</h2>
        <span className="date-label">من بداية التسجيل</span>
      </div>
      <div className="absent-list">
        {ranked.slice(0, 5).map((person) => (
          <button
            className="absent-person"
            key={person.id}
            onClick={() => openReport({ id: person.id, name: person.name, group: person.group, phone1: "" })}
          >
            <span className="absent-avatar">{person.name.slice(0, 1)}</span>
            <span>
              <strong>{person.name}</strong>
              <small>مخدوم</small>
            </span>
            <b className="attendance-count">{person[metric] || 0} مرة</b>
          </button>
        ))}
      </div>
    </section>
  );
}
function DailyAttendanceChart({ people, total }) {
  const choir = people.filter((person) => person.choirPresent).length;
  const mass = people.filter((person) => person.massPresent).length;
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const filtered = people.filter((person) => {
    const matches = person.name.toLocaleLowerCase("ar").includes(query.trim().toLocaleLowerCase("ar"));
    const status =
      filter === "choir"
        ? person.choirPresent
        : filter === "mass"
          ? person.massPresent
          : filter === "absent"
            ? !person.choirPresent && !person.massPresent
            : true;
    return matches && status;
  });
  return (
    <div className="dashboard-attendance-split">
      <section className="daily-chart">
        <div className="chart-heading">
          <div>
            <p className="section-kicker">حضور اليوم</p>
            <h2>توزيع الحضور والغياب</h2>
          </div>
          <span className="chart-badge">{total ? Math.round(((choir + mass) / (total * 2)) * 100) : 0}%</span>
        </div>
        <AttendanceDonut choir={choir} mass={mass} total={total} />
        <div className="attendance-bars">
          <AttendanceBar label="حضور الخورس" value={choir} total={total} tone="teal" />
          <AttendanceBar label="غياب الخورس" value={Math.max(0, total - choir)} total={total} tone="amber" />
          <AttendanceBar label="حضور القداس" value={mass} total={total} tone="blue" />
          <AttendanceBar label="غياب القداس" value={Math.max(0, total - mass)} total={total} tone="red" />
        </div>
        <div className="chart-total">
          إجمالي اليوم: <strong>{total}</strong> شخص
        </div>
      </section>
      <section className="dashboard-attendance-table table-section">
        <div className="table-title-row">
          <div>
            <p className="section-kicker">آخر تسجيلات الحضور</p>
            <h2>متابعة الحضور</h2>
          </div>
          <input
            className="dashboard-table-search"
            type="search"
            placeholder="ابحث بالاسم"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="dashboard-filter-tabs">
          <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>
            الكل
          </button>
          <button className={filter === "choir" ? "active" : ""} onClick={() => setFilter("choir")}>
            حاضر خورس
          </button>
          <button className={filter === "mass" ? "active" : ""} onClick={() => setFilter("mass")}>
            حاضر قداس
          </button>
          <button className={filter === "absent" ? "active" : ""} onClick={() => setFilter("absent")}>
            غائب
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>المخدوم</th>
                <th>المجموعة</th>
                <th>الحالة</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 8).map((person) => (
                <tr key={person.id}>
                  <td className="name-cell">{person.name}</td>
                  <td>{person.group || "—"}</td>
                  <td>
                    <span
                      className={`attendance-status ${person.choirPresent || person.massPresent ? "present" : "absent"}`}
                    >
                      {person.choirPresent || person.massPresent ? "حاضر" : "غائب"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
function WeeklyTrendChart({ trend, total, month, setMonth }) {
  const [scope, setScope] = useState("both");
  const countFor = (item) =>
    scope === "choir" ? item.choir : scope === "mass" ? item.mass : item.choir + item.mass;
  const observed = trend.filter((item) => countFor(item) > 0);
  const values = trend.map(countFor);
  const latest = observed.at(-1);
  const reference = observed.at(-2);
  const latestCount = latest ? countFor(latest) : 0;
  const referenceCount = reference ? countFor(reference) : 0;
  const change = !reference
    ? 0
    : referenceCount === 0
      ? latestCount > 0
        ? 100
        : 0
      : Math.round(((latestCount - referenceCount) / referenceCount) * 100);
  const max = Math.max(...values, 1);
  const scopeLabel =
    scope === "choir" ? "حضور الخورس" : scope === "mass" ? "حضور القداس" : "إجمالي الحضور في الخورس والقداس";
  return (
    <section className="weekly-trend">
      <div className="trend-heading">
        <div>
          <p className="section-kicker">اتجاه الحضور</p>
          <h2>جمعات الشهر المختار</h2>
          <span>
            {reference ? `مقارنة بجمعة ${dateLabel(reference.date)}` : "أول جمعة مسجلة هي نقطة البداية"}
          </span>
        </div>
        <div className="trend-controls">
          <label>
            الشهر
            <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
          </label>
          <div className="trend-scope-switch">
            <button
              type="button"
              className={scope === "both" ? "active" : ""}
              onClick={() => setScope("both")}
            >
              الإجمالي
            </button>
            <button
              type="button"
              className={scope === "choir" ? "active" : ""}
              onClick={() => setScope("choir")}
            >
              خورس
            </button>
            <button
              type="button"
              className={scope === "mass" ? "active" : ""}
              onClick={() => setScope("mass")}
            >
              قداس
            </button>
          </div>
          <span className={`trend-change ${change >= 0 ? "up" : "down"}`}>
            {reference ? `${change >= 0 ? "+" : ""}${change}%` : "0%"}
          </span>
        </div>
      </div>
      <div className="trend-chart">
        {trend.map((item, index) => {
          const count = countFor(item);
          const previousObserved = observed.filter((entry) => entry.date < item.date).at(-1);
          const previous = previousObserved ? countFor(previousObserved) : count;
          const tone = !count ? "empty" : !previousObserved || count >= previous ? "positive" : "negative";
          return (
            <div className="trend-column" key={item.date}>
              <div className="trend-value">{count}</div>
              <div className="trend-bar-wrap">
                <i
                  className={`trend-bar ${tone}`}
                  style={{ height: `${count ? Math.max(7, (count * 100) / max) : 0}%` }}
                />
              </div>
              <small>
                {new Intl.DateTimeFormat("ar-EG", { day: "numeric", month: "short" }).format(
                  new Date(`${item.date}T12:00:00`),
                )}
              </small>
            </div>
          );
        })}
      </div>
      <div className="trend-legend">
        <span>
          <i /> {scopeLabel}
        </span>
        <span>
          الأعلى: {Math.max(...values, 0)} · الأحدث: {latestCount}
        </span>
      </div>
    </section>
  );
}
function FollowUpDashboard({
  mode,
  state,
  selectedDate,
  setSelectedDate,
  rotationStart,
  setRotationStart,
  servantsText,
  setServantsText,
  busy,
  saveFollowUp,
  load,
  checkedCount,
  percent,
}) {
  const [selectedServant, setSelectedServant] = useState("");
  const [openCallPanel, setOpenCallPanel] = useState(null);
  const monthVisited = mode === "visit" ? state.monthVisitedCount || 0 : checkedCount;
  const monthTotal =
    mode === "visit"
      ? state.monthTotal || state.rows.length
      : state.rows.filter((row) => row.role !== "servant").length;
  const monthPercent = monthTotal ? Math.round((monthVisited * 100) / monthTotal) : 0;
  const jumpToCallGroup = (groupNumber) =>
    document
      .getElementById(`call-group-${groupNumber}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  const servantList = useMemo(() => splitServants(servantsText), [servantsText]);
  const servantOptions = useMemo(
    () => [
      ...new Set(
        [
          ...(state.servants || []),
          ...(state.rows || []).filter((row) => (row.role || "boy") === "servant").map((row) => row.name),
        ]
          .map(canonicalServantName)
          .filter(Boolean),
      ),
    ],
    [state.rows, state.servants],
  );
  const addServant = (name) => {
    const next = canonicalServantName(name);
    if (!next) return;
    const current = servantList;
    if (!current.includes(next)) setServantsText(splitServants([...current, next].join("\n")).join("\n"));
  };
  const removeServant = (name) =>
    setServantsText(splitServants(servantList.filter((item) => item !== name).join("\n")).join("\n"));
  return (
    <>
      {mode === "call" && (
        <div className="call-settings-tabs" role="group" aria-label="إعدادات الاتصال الأسبوعي">
          <button
            type="button"
            aria-expanded={openCallPanel === "servants"}
            aria-controls="call-servants-panel"
            className={openCallPanel === "servants" ? "active" : ""}
            onClick={() => setOpenCallPanel((current) => (current === "servants" ? null : "servants"))}
          >
            <Users size={17} />
            <span>
              <strong>قائمة التوزيع</strong>
              <small>مسؤولو الاتصال</small>
            </span>
            <b>{servantList.length}</b>
            <ChevronDown size={16} />
          </button>
          <button
            type="button"
            aria-expanded={openCallPanel === "rotation"}
            aria-controls="call-rotation-panel"
            className={openCallPanel === "rotation" ? "active" : ""}
            onClick={() => setOpenCallPanel((current) => (current === "rotation" ? null : "rotation"))}
          >
            <CalendarDays size={17} />
            <span>
              <strong>دورة التوزيع</strong>
              <small>{state.distributionNotStarted ? "لم يبدأ التوزيع" : "الأسبوع الحالي"}</small>
            </span>
            <ChevronDown size={16} />
          </button>
        </div>
      )}
      <section
        className={`control-grid ${mode === "call" ? `call-control-grid${openCallPanel ? " has-expanded-panel" : ""}` : ""}`}
      >
        {mode === "call" && openCallPanel === "servants" && (
          <article className="panel servants-panel" id="call-servants-panel">
            <div className="panel-heading">
              <div>
                <p className="section-kicker">قائمة التوزيع</p>
                <h2>مسؤولو الاتصال</h2>
              </div>
              <span className="count-badge">{servantList.length}</span>
            </div>
            <div className="servants-picker">
              <label>
                اختر من الخدام الموجودين
                <select
                  value={selectedServant}
                  onChange={(event) => {
                    const value = event.target.value;
                    setSelectedServant("");
                    if (value) addServant(value);
                  }}
                >
                  <option value="">اختر خادمًا</option>
                  {servantOptions.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="servant-chips">
              {servantList.length ? (
                servantList.map((name) => (
                  <span key={name} className="servant-chip">
                    <span>{name}</span>
                    <button type="button" aria-label={`حذف ${name}`} onClick={() => removeServant(name)}>
                      ×
                    </button>
                  </span>
                ))
              ) : (
                <span className="servant-chip empty">لا توجد أسماء</span>
              )}
            </div>
            <div className="field-hint">
              إضافة الخادم تتم من إدارة الخورس فقط، ثم يظهر هنا للاختيار. لا يتكرر الاسم في القائمة.
            </div>
          </article>
        )}
        {(mode === "visit" || (mode === "call" && openCallPanel === "rotation")) && (
          <article className="panel settings-panel" id={mode === "call" ? "call-rotation-panel" : undefined}>
            <div className="panel-heading">
              <div>
                <p className="section-kicker">{mode === "visit" ? "التاريخ" : "دورة التوزيع"}</p>
                <h2>
                  {mode === "visit"
                    ? "تاريخ الزيارة"
                    : state.distributionNotStarted
                      ? "أول أسبوع قادم"
                      : "الأسبوع الحالي"}
                </h2>
              </div>
              <span className="week-mark">
                <CalendarDays size={17} />
              </span>
            </div>
            {mode === "visit" ? (
              <>
                <label htmlFor="period-date">تاريخ تسجيل الزيارة</label>
                <input
                  id="period-date"
                  type="date"
                  value={selectedDate}
                  onChange={(event) => {
                    setSelectedDate(event.target.value);
                    load(mode, event.target.value);
                  }}
                />
                <div className="period-range">{dateLabel(selectedDate)}</div>
                <label htmlFor="visit-month">شهر متابعة الافتقاد</label>
                <input
                  id="visit-month"
                  type="month"
                  value={selectedDate.slice(0, 7)}
                  onChange={(event) => {
                    const date = `${event.target.value}-01`;
                    setSelectedDate(date);
                    load(mode, date);
                  }}
                />
              </>
            ) : (
              <>
                <div className="period-range">
                  من {dateLabel(state.selectedWeek)} إلى {dateLabel(state.weekEnd)}
                  <br />
                  {state.distributionNotStarted ? "لم يبدأ التوزيع بعد." : "يتغير تلقائيًا كل 7 أيام."}
                </div>
                <label htmlFor="rotation-date">بداية أول أسبوع للتوزيع</label>
                <input
                  id="rotation-date"
                  type="date"
                  value={rotationStart}
                  onChange={(event) => setRotationStart(event.target.value)}
                />
                <div className="field-hint">
                  اضبطه مرة واحدة. التطبيق يحدد أسبوع اليوم والمسؤولين تلقائيًا.
                </div>
                <button className="primary-button" disabled={busy} onClick={() => saveFollowUp(true)}>
                  ↻ حفظ بداية التوزيع
                </button>
              </>
            )}
          </article>
        )}
        <article className="panel overview-panel">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">ملخص الشهر</p>
              <h2>حالة الافتقاد</h2>
            </div>
          </div>
          <div className="metrics">
            <div className="metric">
              <strong>{state.groups.length}</strong>
              <span>جروب</span>
            </div>
            <div className="metric">
              <strong>{monthTotal}</strong>
              <span>مخدوم</span>
            </div>
            <div className="metric">
              <strong>{mode === "visit" ? monthVisited : checkedCount}</strong>
              <span>{mode === "visit" ? "تمت زيارتهم هذا الشهر" : "تم الاتصال بهم"}</span>
            </div>
          </div>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: `${mode === "visit" ? monthPercent : percent}%` }}
            />
          </div>
          <div className="progress-label">
            {mode === "visit"
              ? `${monthVisited} من ${monthTotal} · متبقي ${Math.max(0, monthTotal - monthVisited)}`
              : `${checkedCount} من ${monthTotal} · متبقي ${Math.max(0, monthTotal - checkedCount)}`}
          </div>
          <div className="rotation-label">
            {mode === "visit"
              ? "إجمالي الزيارات المسجلة خلال الشهر المختار"
              : "مسؤول اتصال واحد لكل جروب خلال الأسبوع"}
          </div>
        </article>
      </section>
      {mode === "call" && (
        <section className="group-strip">
          <div className="section-title-row">
            <div>
              <p className="section-kicker">المتابعة الحالية</p>
              <h2>مسؤولو الاتصال الأسبوعي</h2>
            </div>
            <span className="date-label">{dateLabel(state.selectedWeek)}</span>
          </div>
          <div className="group-cards">
            {state.groups.map((group) => {
              const members = state.rows.filter(
                (row) => row.role !== "servant" && row.group === group.number,
              );
              const checked = members.filter((row) => row.called).length;
              return (
                <article
                  className={`group-card ${group.servant ? "has-servant" : ""}`}
                  key={group.number}
                  role="button"
                  tabIndex="0"
                  onClick={() => jumpToCallGroup(group.number)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      jumpToCallGroup(group.number);
                    }
                  }}
                >
                  <div className={`group-number tone-${groupTone(group.number)}`}>{group.number}</div>
                  <div className="group-info">
                    <span>جروب</span>
                    <strong>{group.servant || "لم يُحدد"}</strong>
                    <small>
                      {members.length} مخدوم · اتصالات {checked}
                    </small>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}

function PeopleManager({
  state,
  rows,
  query,
  setQuery,
  busy,
  editingPerson,
  personDraft,
  setPersonDraft,
  savePerson,
  uploadPersonPhoto,
  editPerson,
  archivePerson,
  cancelEdit,
}) {
  const [scope, setScope] = useState("boy");
  const field = (key) => (event) => setPersonDraft({ ...personDraft, [key]: event.target.value });
  const scopedRows = rows.filter((person) => (person.role || "boy") === scope);
  const duplicates = findDuplicateNames(state.rows || []);
  return (
    <section className="people-layout">
      {duplicates.length > 0 && (
        <article className="panel duplicate-names-panel">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">أسماء متكررة</p>
              <h2>{duplicates.length} اسم متكرر في السجل</h2>
            </div>
          </div>
          <div className="duplicate-names-list">
            {duplicates.map((group) => (
              <p key={nameKey(group[0].name)}>
                <strong>{group[0].name}</strong> متكرر {group.length} مرات
                {group.map((person) => ` · ${person.phone1 || "بدون رقم"}`).join("")}
              </p>
            ))}
          </div>
        </article>
      )}
      <article className="panel person-form-panel">
        <div className="panel-heading">
          <div>
            <p className="section-kicker">قاعدة بيانات الخورس</p>
            <h2>{editingPerson ? "تعديل بيانات الاسم" : "إضافة ولد أو خادم"}</h2>
          </div>
          <Plus size={19} />
        </div>
        <form className="person-form" onSubmit={savePerson}>
          <label>
            الاسم
            <input value={personDraft.name} onChange={field("name")} required />
          </label>
          <label>
            النوع
            <select value={personDraft.role || "boy"} onChange={field("role")}>
              <option value="boy">ولد</option>
              <option value="servant">خادم</option>
            </select>
          </label>
          <label>
            رقم الهاتف الأول
            <input dir="ltr" value={personDraft.phone1} onChange={field("phone1")} />
          </label>
          <label>
            رقم الهاتف الثاني
            <input dir="ltr" value={personDraft.phone2} onChange={field("phone2")} />
          </label>
          <label className="form-wide">
            العنوان
            <input value={personDraft.address} onChange={field("address")} />
          </label>
          <label className="form-wide">
            صورة الولد أو الخادم
            <input type="file" accept="image/*" onChange={uploadPersonPhoto} disabled={busy} />
            {personDraft.photoUrl && (
              <img className="person-photo-preview" src={personDraft.photoUrl} alt="معاينة الصورة" />
            )}
          </label>
          <label className="form-wide">
            ملاحظات
            <textarea rows="3" value={personDraft.note} onChange={field("note")} />
          </label>
          <div className="form-actions">
            <button className="primary-button" disabled={busy}>
              {editingPerson ? "حفظ التعديل" : "إضافة الاسم"}
            </button>
            {editingPerson && (
              <button type="button" className="cancel-button" onClick={cancelEdit}>
                إلغاء
              </button>
            )}
          </div>
        </form>
      </article>
      <article className="table-section people-table">
        <div className="section-title-row table-title-row">
          <div>
            <p className="section-kicker">السجل الحالي</p>
            <div className="segmented-control">
              <button className={scope === "boy" ? "active" : ""} onClick={() => setScope("boy")}>
                المخدومين
              </button>
              <button className={scope === "servant" ? "active" : ""} onClick={() => setScope("servant")}>
                الخدام
              </button>
            </div>
            <h2>{scopedRows.length} اسم مسجل</h2>
          </div>
          <label className="search-box">
            <Search size={17} />
            <input
              type="search"
              placeholder="ابحث بالاسم أو الرقم أو العنوان"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>الاسم</th>
                <th>الجروب</th>
                <th>رقم 1</th>
                <th>رقم 2</th>
                <th>العنوان</th>
                <th>إجراء</th>
              </tr>
            </thead>
            <tbody>
              {scopedRows.map((person) => (
                <tr className={`group-tone-${groupTone(person.group)}`} key={person.id}>
                  <td className="name-cell">{person.name}</td>
                  <td>
                    <span className="group-pill">{person.group || "—"}</span>
                  </td>
                  <td dir="ltr">{person.phone1 || "—"}</td>
                  <td dir="ltr">{person.phone2 || "—"}</td>
                  <td className="address-cell">
                    {person.address ? (
                      <a
                        className="map-address-link compact"
                        href={mapsSearchUrl(person.address)}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`فتح عنوان ${person.name} في خرائط جوجل`}
                      >
                        <MapPin size={14} />
                        <span>{person.address}</span>
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="people-actions">
                    <button className="row-action edit" title="تعديل" onClick={() => editPerson(person)}>
                      <Pencil size={15} />
                    </button>
                    <button
                      className="row-action delete"
                      title="حذف من المتابعة"
                      onClick={() => archivePerson(person)}
                      disabled={busy}
                    >
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!scopedRows.length && <p className="empty-row">لا توجد نتائج</p>}
        </div>
      </article>
    </section>
  );
}

function QrCard({ person, onPrint, printTarget }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let active = true;
    import("qrcode")
      .then(({ default: QRCode }) =>
        QRCode.toDataURL(`${window.location.origin}/qr/${person.qrToken}`, {
          margin: 1,
          width: 180,
          errorCorrectionLevel: "M",
        }),
      )
      .then((dataUrl) => {
        if (active) setSrc(dataUrl);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [person.qrToken]);
  return (
    <article className={`qr-print-card ${printTarget === person.id ? "print-target" : ""}`}>
      <button
        type="button"
        className="qr-card-preview"
        onClick={() => onPrint(person.id)}
        title={`طباعة QR الخاص بـ ${person.name}`}
      >
        <div>
          {src ? (
            <img src={src} alt={`QR ${person.name}`} />
          ) : (
            <span className="qr-loading">جاري إنشاء QR</span>
          )}
        </div>
        <strong>{person.name}</strong>
      </button>
      <button type="button" className="secondary-button qr-single-print" onClick={() => onPrint(person.id)}>
        طباعة هذا الكود
      </button>
    </article>
  );
}
function QrCardsPage({ rows }) {
  const people = rows.filter((row) => row.role === "boy");
  const [query, setQuery] = useState("");
  const filteredPeople = people.filter((person) =>
    searchMatches(`${person.name} ${person.phone1 || ""} ${person.phone2 || ""}`, query),
  );
  const [printTarget, setPrintTarget] = useState(null);
  const printCards = (target = null) => {
    setPrintTarget(target);
    window.setTimeout(() => {
      window.print();
      setPrintTarget(null);
    }, 80);
  };
  return (
    <section className="qr-page">
      <div className="section-title-row table-title-row">
        <div>
          <p className="section-kicker">بطاقات الحضور</p>
          <h2>QR لكل مخدوم</h2>
          <span className="date-label">اطبع الكل أو اختار كارت واحد واحفظه PDF</span>
        </div>
        <div className="qr-page-actions">
          <label className="search-box qr-search">
            <Search size={17} />
            <input
              type="search"
              placeholder="ابحث بالاسم أو الرقم"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button className="primary-button qr-print-button" onClick={() => printCards()}>
            <Copy size={15} /> طباعة الكل / PDF
          </button>
        </div>
      </div>
      <div className="qr-print-grid">
        {filteredPeople.map((person) => (
          <QrCard person={person} printTarget={printTarget} onPrint={printCards} key={person.id} />
        ))}
        {!filteredPeople.length && <p className="empty-row">لا يوجد شخص بهذا البحث</p>}
      </div>
    </section>
  );
}
function QrManagementPage({ rows, request, scanType, setScanType, scanDate, setScanDate }) {
  const [view, setView] = useState("cards");
  return (
    <section className="qr-management-page">
      <div className="segmented-control qr-management-tabs" role="tablist" aria-label="إدارة أكواد QR">
        <button
          type="button"
          role="tab"
          aria-selected={view === "cards"}
          className={view === "cards" ? "active" : ""}
          onClick={() => setView("cards")}
        >
          <QrCode size={16} /> أكواد الأولاد
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "scan"}
          className={view === "scan" ? "active" : ""}
          onClick={() => setView("scan")}
        >
          <Camera size={16} /> Scan QR
        </button>
      </div>
      {view === "cards" ? (
        <QrCardsPage rows={rows} />
      ) : (
        <QrScannerPage
          request={request}
          scanType={scanType}
          setScanType={setScanType}
          scanDate={scanDate}
          setScanDate={setScanDate}
        />
      )}
    </section>
  );
}
function QrScannerPage({ request, scanType, setScanType, scanDate, setScanDate }) {
  const [scannerError, setScannerError] = useState("");
  const [status, setStatus] = useState("");
  const [recent, setRecent] = useState([]);
  const settingsRef = useRef({ scanType, scanDate });
  settingsRef.current = { scanType, scanDate };
  useEffect(() => {
    let disposed = false;
    let scanner;
    const inflight = new Set();
    const lastSaved = new Map();
    const stopScanner = () => (scanner?.isScanning ? scanner.stop().catch(() => {}) : Promise.resolve());
    const startScanner = async () => {
      try {
        const { Html5Qrcode } = await import("html5-qrcode");
        if (disposed) return;
        scanner = new Html5Qrcode("qr-reader");
        await scanner.start(
          { facingMode: "environment" },
          { fps: 8, qrbox: { width: 230, height: 230 } },
          async (decoded) => {
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
                await request("/api/attendance", {
                  method: "POST",
                  body: JSON.stringify({ type: attendanceType, date, checks: { [person.recordKey]: true } }),
                });
              }
              lastSaved.set(token, Date.now());
              const label = type === "choir" ? "خورس" : type === "mass" ? "قداس" : "خورس وقداس";
              setStatus(`تم تسجيل حضور ${person.name} في ${label}`);
              setScannerError("");
              setRecent((current) =>
                [{ key: `${person.recordKey}-${Date.now()}`, name: person.name, label }, ...current].slice(
                  0,
                  8,
                ),
              );
            } catch (error) {
              setScannerError(error?.message || "تعذر قراءة QR");
            } finally {
              inflight.delete(token);
            }
          },
          () => {},
        );
        if (disposed) await stopScanner();
      } catch (error) {
        if (!disposed) setScannerError(error?.message || "اسمح للمتصفح باستخدام الكاميرا");
      }
    };
    void startScanner();
    return () => {
      disposed = true;
      void stopScanner();
    };
  }, [request]);
  return (
    <section className="qr-scan-page">
      <div className="qr-scan-panel">
        <p className="section-kicker">تسجيل حضور سريع</p>
        <h2>اختار النوع ثم امسح QR</h2>
        <div className="segmented-control qr-scan-type">
          <button className={scanType === "choir" ? "active" : ""} onClick={() => setScanType("choir")}>
            خورس
          </button>
          <button className={scanType === "mass" ? "active" : ""} onClick={() => setScanType("mass")}>
            قداس
          </button>
          <button className={scanType === "both" ? "active" : ""} onClick={() => setScanType("both")}>
            الاتنين
          </button>
        </div>
        <label className="qr-scan-date">
          تاريخ الحضور
          <input type="date" value={scanDate} onChange={(event) => setScanDate(event.target.value)} />
        </label>
        <p className="qr-scan-hint">
          أي كود هتمسحه هيتسجل فورًا في{" "}
          {scanType === "choir" ? "الخورس" : scanType === "mass" ? "القداس" : "الخورس والقداس"}، والكاميرا
          تفضل شغالة عشان تكمل باقي الأسماء.
        </p>
        <div id="qr-reader" className="qr-reader" />
        {status && <p className="qr-scan-status">{status}</p>}
        {scannerError && <p className="login-error">{scannerError}</p>}
        {recent.length > 0 && (
          <div className="scanned-person qr-recent">
            <strong>آخر التسجيلات</strong>
            {recent.map((item) => (
              <small key={item.key}>
                {item.name} · {item.label}
              </small>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function AttendanceManager({
  state,
  rows,
  attendanceType,
  setAttendanceType,
  attendanceRole,
  setAttendanceRole,
  attendanceDate,
  setAttendanceDate,
  checks,
  setChecks,
  save,
  markAttendance,
  onComment,
  onDeleteComment,
  busy,
  query,
  setQuery,
}) {
  const [commentKey, setCommentKey] = useState("");
  const [commentText, setCommentText] = useState("");
  const scopedRows = rows.filter((row) => (row.role || "boy") === attendanceRole);
  const checked = scopedRows.filter((row) => checks[String(row.recordKey)]).length;
  const sortedRows = [...scopedRows].sort((a, b) =>
    normalizeArabic(a.name).localeCompare(normalizeArabic(b.name), "ar"),
  );
  const visibleRows = sortedRows.filter((row) =>
    searchMatches([row.name, row.phone1, row.phone2].filter(Boolean).join(" "), query),
  );
  const toggle = (recordKey) => {
    const nextValue = !checks[recordKey];
    setChecks({ ...checks, [recordKey]: nextValue });
    markAttendance(recordKey, nextValue, attendanceType, attendanceDate);
  };
  return (
    <section className="attendance-page">
      <AttendanceCommentPanel
        rows={sortedRows}
        checks={checks}
        date={attendanceDate}
        type={attendanceType}
        save={onComment}
        remove={onDeleteComment}
        busy={busy}
      />
      <div className="attendance-controls">
        <label className="search-box attendance-search">
          <Search size={17} />
          <input
            type="search"
            placeholder="ابحث بالاسم"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="segmented-control">
          <button
            className={attendanceRole === "boy" ? "active" : ""}
            onClick={() => setAttendanceRole("boy")}
          >
            حضور المخدومين
          </button>
          <button
            className={attendanceRole === "servant" ? "active" : ""}
            onClick={() => setAttendanceRole("servant")}
          >
            حضور الخدام
          </button>
        </div>
        <div className="segmented-control">
          <button
            className={attendanceType === "choir" ? "active" : ""}
            onClick={() => setAttendanceType("choir")}
          >
            <Church size={16} /> حضور الخورس
          </button>
          <button
            className={attendanceType === "mass" ? "active" : ""}
            onClick={() => setAttendanceType("mass")}
          >
            <UserCheck size={16} /> حضور القداس
          </button>
        </div>
        <label>
          تاريخ الحضور
          <input
            type="date"
            value={attendanceDate}
            onChange={(event) => setAttendanceDate(event.target.value)}
          />
        </label>
        <button className="primary-button attendance-save" disabled={busy} onClick={() => save(checks)}>
          <Check size={16} /> حفظ حضور اليوم
        </button>
      </div>
      <section className="table-section">
        <div className="section-title-row table-title-row">
          <div>
            <p className="section-kicker">{attendanceRole === "servant" ? "الخدام فقط" : "المخدومين فقط"}</p>
            <h2>{attendanceType === "choir" ? "حضور الخورس" : "حضور القداس"}</h2>
          </div>
          <span className="count-badge">
            {checked} من {scopedRows.length}
          </span>
        </div>
        <div className="attendance-grid">
          {visibleRows.map((row, index) => (
            <Fragment key={row.id}>
              {(() => {
                const letter = normalizeArabic(row.name).trim().slice(0, 1);
                const previousLetter = normalizeArabic(visibleRows[index - 1]?.name?.trim() || "").slice(
                  0,
                  1,
                );
                const key = String(row.recordKey);
                return (
                  <>
                    {letter !== previousLetter && <div className="attendance-letter">{letter}</div>}
                    <button
                      className={`attendance-person ${checks[key] ? "present" : ""}`}
                      key={row.id}
                      onClick={() => toggle(key)}
                    >
                      <span className="attendance-check">{checks[key] ? <Check size={18} /> : null}</span>
                      <span className="attendance-name">{row.name}</span>
                      <span className="attendance-meta">
                        {attendanceRole === "servant" ? "خادم" : "مخدوم"}
                      </span>
                    </button>
                  </>
                );
              })()}
            </Fragment>
          ))}
        </div>
      </section>
    </section>
  );
}

function AttendanceCommentPanel({ rows, checks, date, type, save, remove, busy }) {
  const presentRows = rows.filter((row) => checks[String(row.recordKey)]);
  const [personKey, setPersonKey] = useState("");
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const person = presentRows.find((row) => String(row.recordKey) === personKey);
  const phone = phoneHref(person?.phone1 || person?.phone2).replace(/\D/g, "");
  const whatsappUrl = phone ? `https://wa.me/${phone}?text=${encodeURIComponent(text.trim())}` : "";
  return (
    <div className="attendance-comment-wrap">
      <button
        type="button"
        className="attendance-comment-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MessageCircle size={16} /> تعليق الحضور
        <ChevronDown size={15} className={open ? "expanded" : ""} />
      </button>
      {open && (
        <section className="attendance-comment-panel">
          <div>
            <p className="section-kicker">تعليق على الحضور</p>
            <strong>أضف تعليقًا لولد في هذا اليوم</strong>
            <small>
              {dateLabel(date)} · {type === "choir" ? "حضور الخورس" : "حضور القداس"}
            </small>
          </div>
          <select value={personKey} onChange={(event) => setPersonKey(event.target.value)}>
            <option value="">اختر اسم الولد</option>
            {presentRows.map((row) => (
              <option key={row.recordKey} value={row.recordKey}>
                {row.name}
              </option>
            ))}
          </select>
          <textarea
            rows="2"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="اكتب التعليق هنا"
          />
          <div className="form-actions">
            <button
              type="button"
              className="primary-button"
              disabled={!personKey || !text.trim() || busy}
              onClick={async () => {
                await save(personKey, text);
                setText("");
              }}
            >
              إرسال التعليق
            </button>
            <button
              type="button"
              className="attendance-whatsapp-button"
              aria-disabled={!whatsappUrl}
              onClick={() => whatsappUrl && window.open(whatsappUrl, "_blank", "noopener,noreferrer")}
            >
              <MessageCircle size={15} /> واتساب
            </button>
            <button
              type="button"
              className="cancel-button"
              disabled={!personKey || busy}
              onClick={async () => {
                await remove(personKey);
                setText("");
              }}
            >
              مسح التعليق
            </button>
          </div>
          {person && !phone && (
            <small className="attendance-whatsapp-hint">لا يوجد رقم هاتف مسجل لهذا الاسم.</small>
          )}
        </section>
      )}
    </div>
  );
}

function MembersDirectoryByRole({ rows, query, setQuery, openReport, loading }) {
  const [scope, setScope] = useState("boy");
  const [showStats, setShowStats] = useState(false);
  const [servantPassword, setServantPassword] = useState("");
  const [servantUnlocked, setServantUnlocked] = useState(false);
  const [servantPasswordError, setServantPasswordError] = useState(false);
  const scopedRows = rows.filter((row) => (row.role || "boy") === scope);
  const attendanceSessions = fridaySessionsSinceStart(scope === "servant" ? "2026-10-16" : "2026-10-02");
  const statRows =
    scope === "servant"
      ? scopedRows.map((row) => ({
          ...row,
          calls: row.callCount || 0,
          choir: row.choirCount || 0,
          mass: row.massCount || 0,
        }))
      : [];
  const loadStats = () => setShowStats(true);
  const max = (key) => Math.max(1, ...statRows.map((row) => row[key] || 0));
  const totalCalls = statRows.reduce((sum, row) => sum + row.calls, 0);
  const totalChoir = statRows.reduce((sum, row) => sum + row.choir, 0);
  const totalMass = statRows.reduce((sum, row) => sum + row.mass, 0);
  const activityFor = (row) => row.calls + row.choir + row.mass;
  const averageActivity = statRows.length
    ? statRows.reduce((sum, row) => sum + activityFor(row), 0) / statRows.length
    : 0;
  const maxActivity = Math.max(1, ...statRows.map(activityFor));
  const activityCount = (row) => (row.callCount || 0) + (row.choirCount || 0) + (row.massCount || 0);
  const activityAverage = scopedRows.length
    ? scopedRows.reduce((sum, row) => sum + activityCount(row), 0) / scopedRows.length
    : 0;
  const activityLabel = (row) => {
    const value = activityCount(row);
    if (activityAverage === 0) return "غير ملتزم";
    if (value >= activityAverage) return "نشط";
    if (value >= activityAverage * 0.5) return "متوسط";
    return "غير ملتزم";
  };
  const openServantReports = () => {
    if (servantUnlocked) {
      setScope("servant");
      return;
    }
    setServantPassword("");
    setServantPasswordError(false);
    setScope("servant-lock");
  };
  const submitServantPassword = (event) => {
    event.preventDefault();
    if (servantPassword !== "2004") {
      setServantPasswordError(true);
      return;
    }
    setServantUnlocked(true);
    setServantPasswordError(false);
    setScope("servant");
  };
  return (
    <section className="table-section members-directory">
      <div className="section-title-row table-title-row">
        <div>
          <p className="section-kicker">سجل أفراد الخورس</p>
          <div className="segmented-control">
            <button className={scope === "boy" ? "active" : ""} onClick={() => setScope("boy")}>
              المخدومين
            </button>
            <button
              className={scope === "servant" || scope === "servant-lock" ? "active" : ""}
              onClick={openServantReports}
            >
              الخدام
            </button>
          </div>
          <h2>{scope === "boy" ? "تقارير المخدومين" : "تقارير الخدام"}</h2>
        </div>
        {scope !== "servant-lock" && (
          <div className="table-actions">
            <label className="search-box">
              <Search size={17} />
              <input
                type="search"
                placeholder="ابحث بالاسم أو الرقم"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            {scope === "servant" && (
              <button
                className="secondary-button"
                onClick={() => (showStats ? setShowStats(false) : loadStats())}
              >
                {showStats ? "إخفاء إحصائيات الخدام" : "إحصائيات الخدام"}
              </button>
            )}
          </div>
        )}
      </div>
      {scope === "servant-lock" ? (
        <form className="servant-report-lock" onSubmit={submitServantPassword}>
          <label htmlFor="servant-report-password">أدخل كلمة مرور صفحة الخدام</label>
          <input
            id="servant-report-password"
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            value={servantPassword}
            onChange={(event) => setServantPassword(event.target.value)}
            autoFocus
          />
          <button className="primary-button" type="submit">
            فتح تقارير الخدام
          </button>
          {servantPasswordError && <p role="alert">كلمة المرور غير صحيحة</p>}
        </form>
      ) : (
        <>
          {scope === "servant" && showStats && (
            <section className="servant-dashboard">
              <div className="servant-stats">
                <div>
                  <strong>{statRows.length}</strong>
                  <span>الخدام الظاهرون</span>
                </div>
                <div>
                  <strong>{totalCalls}</strong>
                  <span>إجمالي الاتصالات</span>
                </div>
                <div>
                  <strong>{totalChoir}</strong>
                  <span>حضور الخورس</span>
                </div>
                <div>
                  <strong>{totalMass}</strong>
                  <span>حضور القداس</span>
                </div>
              </div>
              {statRows.length ? (
                <div className="servant-chart-grid">
                  <article>
                    <h3>الاتصالات حسب الخادم</h3>
                    {statRows.map((row) => (
                      <div className="servant-bar" key={`call-${row.id}`}>
                        <span>{row.name}</span>
                        <i>
                          <b style={{ width: `${(row.calls * 100) / max("calls")}%` }} />
                        </i>
                        <strong>{row.calls}</strong>
                      </div>
                    ))}
                  </article>
                  <article>
                    <h3>حضور الخورس والقداس</h3>
                    {statRows.map((row) => (
                      <div className="servant-attendance-chart-row" key={`attendance-${row.id}`}>
                        <span>{row.name}</span>
                        <div>
                          <i>
                            <b style={{ width: `${(row.choir * 100) / max("choir")}%` }} />
                          </i>
                          <small>خورس {row.choir}</small>
                          <i>
                            <b
                              className="attendance"
                              style={{ width: `${(row.mass * 100) / max("mass")}%` }}
                            />
                          </i>
                          <small>قداس {row.mass}</small>
                        </div>
                      </div>
                    ))}
                  </article>
                  <article>
                    <h3>مؤشر النشاط مقارنة بمتوسط الخدام</h3>
                    <p className="servant-chart-caption">متوسط النشاط: {averageActivity.toFixed(1)} نقطة</p>
                    {statRows.map((row) => (
                      <div className="servant-bar" key={`activity-${row.id}`}>
                        <span>{row.name}</span>
                        <i>
                          <b
                            className="activity"
                            style={{ width: `${(activityFor(row) * 100) / maxActivity}%` }}
                          />
                        </i>
                        <strong>{activityFor(row)}</strong>
                      </div>
                    ))}
                  </article>
                </div>
              ) : (
                <p className="empty-row">لا توجد بيانات خدام مطابقة للبحث</p>
              )}
            </section>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>الاسم</th>
                  <th>آخر حضور خورس</th>
                  <th>عدد حضور الخورس</th>
                  <th>آخر حضور قداس</th>
                  <th>عدد حضور القداس</th>
                  {scope === "servant" ? (
                    <>
                      <th>عدد الاتصالات</th>
                      <th>إجمالي النشاط</th>
                      <th>الالتزام</th>
                    </>
                  ) : (
                    <>
                      <th>آخر زيارة</th>
                      <th>آخر اتصال</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {scopedRows.map((row) => {
                  const attendanceLabel =
                    scope === "servant"
                      ? `${row.choirCount || 0} من ${attendanceSessions}`
                      : `${row.choirCount || 0} من ${attendanceSessions}`;
                  return (
                    <tr key={row.id}>
                      <td className="name-cell">
                        {scope === "servant" ? (
                          <strong>{row.name}</strong>
                        ) : (
                          <button className="person-link" onClick={() => openReport(row)}>
                            {row.name}
                          </button>
                        )}
                      </td>
                      <td className="history-date">{dateLabel(row.lastChoirDate)}</td>
                      <td className="attendance-fraction">{attendanceLabel}</td>
                      <td className="history-date">{dateLabel(row.lastMassDate)}</td>
                      <td className="attendance-fraction">
                        {row.massCount || 0} من {attendanceSessions}
                      </td>
                      {scope === "servant" ? (
                        <>
                          <td>{row.callCount || 0}</td>
                          <td>
                            <strong>{activityCount(row)}</strong>
                          </td>
                          <td>
                            <span
                              className={`servant-activity-badge ${activityLabel(row) === "نشط" ? "active" : activityLabel(row) === "متوسط" ? "medium" : "inactive"}`}
                            >
                              {activityLabel(row)}
                            </span>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="history-date">{dateLabel(row.lastVisitedDate)}</td>
                          <td className="history-date">{dateLabel(row.lastCalledWeek)}</td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!scopedRows.length && (
              <p className="empty-row">{loading ? "جاري تحميل البيانات" : "لا توجد أسماء"}</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
function CallGroupsTable({
  rows,
  query,
  setQuery,
  busy,
  saveFollowUp,
  updateCheck,
  openReport,
  loading,
  notes = [],
  request,
  password,
  reloadNotes,
}) {
  const [selectedNotes, setSelectedNotes] = useState(null);
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteError, setNoteError] = useState("");
  const [noteSuccess, setNoteSuccess] = useState("");
  const filtered = rows.filter(
    (row) =>
      row.role !== "servant" && searchMatches(`${row.name} ${row.group || ""} ${row.servant || ""}`, query),
  );
  const groups = Object.entries(
    filtered.reduce((result, row) => {
      const key = row.group || "غير موزع";
      (result[key] ||= []).push(row);
      return result;
    }, {}),
  ).sort(([a], [b]) => {
    if (a === "غير موزع") return 1;
    if (b === "غير موزع") return -1;
    return Number(a) - Number(b);
  });
  return (
    <section className="table-section call-groups-section">
      <div className="section-title-row table-title-row">
        <div>
          <p className="section-kicker">بيانات الافتقاد</p>
          <h2>الاتصال الأسبوعي حسب الجروب</h2>
        </div>
        <div className="table-actions">
          <label className="search-box">
            <Search size={17} />
            <input
              type="search"
              placeholder="ابحث بالاسم أو الجروب أو الخادم"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button className="secondary-button" disabled={busy} onClick={() => saveFollowUp()}>
            <Check size={16} /> احفظ الكل
          </button>
        </div>
      </div>
      <div className="call-groups-list">
        {groups.map(([group, members]) => (
          <section className="call-group" id={`call-group-${group}`} key={group}>
            <header className={`call-group-heading group-tone-${group}`}>
              <div>
                <span>الجروب</span>
                <strong>{group}</strong>
              </div>
              <div>
                <span>مسؤول الاتصال</span>
                <b>{members[0]?.servant || "غير موزع"}</b>
              </div>
              <small>
                {members.length} أفراد · تم الاتصال بـ {members.filter((row) => row.called).length}
              </small>
              <button
                type="button"
                className="group-save-button"
                disabled={busy}
                onClick={() => saveFollowUp(group)}
              >
                <Check size={14} /> حفظ المجموعة
              </button>
            </header>
            <div className="call-group-members">
              {members.map((row) => {
                const need = followUpNeedPercent(row);
                return (
                  <div className="call-member" key={row.id}>
                    <span className="call-member-info">
                      <span className="call-member-name-line">
                        <button type="button" className="person-link" onClick={() => openReport(row)}>
                          {row.name}
                        </button>
                        <span className="call-attendance-rate" title="احتياج متابعة حسب الحضور والافتقاد">
                          احتياج متابعة {need}%
                        </span>
                        <button
                          type="button"
                          className="call-notes-link"
                          onClick={() =>
                            setSelectedNotes({
                              name: row.name,
                              personId: row.id,
                              servant: row.servant || members[0]?.servant || "",
                              entries: notes.filter((item) => Number(item.personId) === Number(row.id)),
                            })
                          }
                        >
                          ملاحظاتي
                        </button>
                      </span>
                      <span className="phone-copy-row">
                        <small dir="ltr">رقم 1: {row.phone1 || "بدون رقم"}</small>
                        {row.phone1 && (
                          <a className="call-phone" href={`tel:${phoneHref(row.phone1)}`}>
                            <Phone size={13} /> اتصل
                          </a>
                        )}
                      </span>
                      {row.phone2 && (
                        <span className="phone-copy-row">
                          <small dir="ltr">رقم 2: {row.phone2}</small>
                          <a className="call-phone" href={`tel:${phoneHref(row.phone2)}`}>
                            <Phone size={13} /> اتصل
                          </a>
                        </span>
                      )}
                    </span>
                    <input
                      className="status-check"
                      type="checkbox"
                      checked={row.called}
                      onChange={(event) => updateCheck(row.recordKey, "called", event.target.checked)}
                      aria-label={`تم الاتصال بـ ${row.name}`}
                    />
                  </div>
                );
              })}
            </div>
          </section>
        ))}
        {!groups.length && <p className="empty-row">{loading ? "جاري تحميل البيانات" : "لا توجد نتائج"}</p>}
      </div>
      {selectedNotes && (
        <div className="call-notes-backdrop" onClick={() => setSelectedNotes(null)}>
          <section
            className="call-notes-dialog"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <h3>ملاحظات {selectedNotes.name}</h3>
              <button
                type="button"
                className="call-notes-close"
                aria-label="إغلاق الملاحظات"
                onClick={() => setSelectedNotes(null)}
              >
                <X size={18} />
              </button>
            </header>
            {selectedNotes.entries.length ? (
              selectedNotes.entries.map((item) => (
                <article key={item.id}>
                  <small>
                    {dateLabel(item.date)} · {item.servant} · {item.type === "call" ? "اتصال" : "زيارة"}
                  </small>
                  <p>{item.note}</p>
                </article>
              ))
            ) : (
              <p>لا توجد ملاحظات مسجلة لهذا الولد.</p>
            )}
            <form
              className="quick-note-form"
              onSubmit={async (event) => {
                event.preventDefault();
                const formElement = event.currentTarget;
                const form = new FormData(formElement);
                const note = String(form.get("note") || "").trim();
                if (!note || noteSaving) return;
                setNoteSaving(true);
                setNoteError("");
                setNoteSuccess("");
                try {
                  await request(
                    "/api/followup-notes",
                    {
                      method: "POST",
                      body: JSON.stringify({
                        personId: selectedNotes.personId,
                        servant: selectedNotes.servant,
                        type: "call",
                        date: today(),
                        note,
                      }),
                    },
                    password,
                  );
                  formElement?.reset?.();
                  await reloadNotes();
                  setSelectedNotes((current) => ({
                    ...current,
                    entries: [
                      ...current.entries,
                      { id: Date.now(), date: today(), servant: current.servant, type: "call", note },
                    ],
                  }));
                  setNoteSuccess("تم حفظ الملاحظة وإرسال التنبيه");
                } catch (error) {
                  setNoteError(error.message || "تعذر حفظ الملاحظة");
                } finally {
                  setNoteSaving(false);
                }
              }}
            >
              <textarea name="note" rows="3" placeholder="اكتب ملاحظة الافتقاد لهذا الولد…" required />
              <button className="primary-button" type="submit" disabled={noteSaving}>
                <Plus size={15} /> {noteSaving ? "جارٍ الحفظ…" : "حفظ الملاحظة"}
              </button>
              {noteError && <span className="quick-note-error">{noteError}</span>}
              {noteSuccess && <span className="quick-note-success">{noteSuccess}</span>}
            </form>
          </section>
        </div>
      )}
    </section>
  );
}

function PeopleTable({
  mode,
  rows,
  query,
  setQuery,
  busy,
  saveFollowUp,
  updateCheck,
  openReport,
  loading,
  notes = [],
  request,
  password,
  reloadNotes,
  includeVisitedThisMonth,
  setIncludeVisitedThisMonth,
}) {
  if (mode === "call")
    return (
      <CallGroupsTable
        rows={rows}
        query={query}
        setQuery={setQuery}
        busy={busy}
        saveFollowUp={saveFollowUp}
        updateCheck={updateCheck}
        openReport={openReport}
        loading={loading}
        notes={notes}
        request={request}
        password={password}
        reloadNotes={reloadNotes}
      />
    );
  return (
    <section className="table-section">
      <div className="section-title-row table-title-row">
        <div>
          <p className="section-kicker">بيانات الافتقاد</p>
          <h2>{mode === "visit" ? "زيارة البيت" : mode === "call" ? "الاتصال الأسبوعي" : "آخر متابعة"}</h2>
        </div>
        <div className="table-actions">
          <label className="search-box">
            <Search size={17} />
            <input
              type="search"
              placeholder="ابحث بالاسم أو الجروب أو الخادم"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {mode === "visit" && (
            <button
              className="secondary-button month-filter-button"
              onClick={() => setIncludeVisitedThisMonth(!includeVisitedThisMonth)}
            >
              {includeVisitedThisMonth ? "إخفاء من تمت زيارتهم هذا الشهر" : "إظهار من تمت زيارتهم هذا الشهر"}
            </button>
          )}
          {mode !== "history" && (
            <button className="secondary-button" disabled={busy} onClick={() => saveFollowUp()}>
              <Check size={16} /> احفظ {mode === "visit" ? "الزيارات" : "الاتصالات"}
            </button>
          )}
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {mode === "visit" ? (
                <>
                  <th>الجروب</th>
                  <th>الاسم</th>
                  <th>رقم 1</th>
                  <th>العنوان</th>
                  <th>تمت الزيارة</th>
                  <th>آخر زيارة</th>
                </>
              ) : mode === "call" ? (
                <>
                  <th>الجروب</th>
                  <th>الاسم</th>
                  <th>رقم 1</th>
                  <th>رقم 2</th>
                  <th>مسؤول الاتصال</th>
                  <th>تم الاتصال</th>
                </>
              ) : scope === "servant" ? (
                <>
                  <th>الاسم</th>
                  <th>حضور الخورس</th>
                  <th>حضور القداس</th>
                  <th>عدد الاتصالات</th>
                  <th>النشاط</th>
                </>
              ) : (
                <>
                  <th>الجروب</th>
                  <th>الاسم</th>
                  <th>رقم 1</th>
                  <th>آخر زيارة</th>
                  <th>آخر اتصال</th>
                  <th>آخر خادم اتصل</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className={`group-tone-${groupTone(row.group)}`} key={row.id}>
                {mode === "history" && scope === "servant" ? (
                  <>
                    <td className="name-cell">
                      <strong>{row.name}</strong>
                    </td>
                    <td className="history-date">{dateLabel(row.lastChoirDate)}</td>
                    <td className="history-date">{dateLabel(row.lastMassDate)}</td>
                    <td>{row.callCount || 0}</td>
                    <td>
                      <span
                        className={`servant-activity-badge ${row.callCount >= 3 ? "active" : row.callCount > 0 ? "medium" : "inactive"}`}
                      >
                        {row.callCount >= 3 ? "نشط" : row.callCount > 0 ? "متوسط" : "غير ملتزم"}
                      </span>
                    </td>
                  </>
                ) : (
                  <>
                    <td>
                      <span className="group-pill">{row.group}</span>
                    </td>
                    <td className="name-cell">
                      {mode === "history" || mode === "visit" ? (
                        <button className="person-link" onClick={() => openReport(row)}>
                          {row.name}
                        </button>
                      ) : (
                        row.name
                      )}
                    </td>
                    <td className="phone-cell">
                      {mode === "visit" ? (
                        <CopyPhone value={row.phone1} secondary={row.phone2} name={row.name} />
                      ) : (
                        row.phone1 || "—"
                      )}
                    </td>
                    {mode === "call" ? (
                      <td className="phone-cell">
                        <CopyPhone value={row.phone2} name={row.name} label="رقم 2" />
                      </td>
                    ) : null}
                    {mode === "visit" ? (
                      <>
                        <td className="address-cell">
                          {row.address ? (
                            <a
                              className="visit-map-link"
                              href={mapsSearchUrl(row.address)}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`فتح عنوان ${row.name} في خرائط جوجل`}
                              title="فتح العنوان في خرائط جوجل"
                            >
                              <MapPin size={16} />
                              <span>{row.address}</span>
                            </a>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="check-cell">
                          <input
                            className="status-check"
                            type="checkbox"
                            checked={row.visited}
                            onChange={(event) => updateCheck(row.recordKey, "visited", event.target.checked)}
                            aria-label={`تمت زيارة ${row.name}`}
                          />
                        </td>
                        <td className="history-date">{dateLabel(row.lastVisitedDate)}</td>
                      </>
                    ) : mode === "call" ? (
                      <>
                        <td>
                          <span className={`servant-cell ${row.servant ? "" : "muted"}`}>
                            {row.servant || "غير موزع"}
                          </span>
                        </td>
                        <td className="check-cell">
                          <input
                            className="status-check"
                            type="checkbox"
                            checked={row.called}
                            onChange={(event) => updateCheck(row.recordKey, "called", event.target.checked)}
                            aria-label={`تم الاتصال بـ ${row.name}`}
                          />
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="history-date">{dateLabel(row.lastVisitedDate)}</td>
                        <td className="history-date">{dateLabel(row.lastCalledWeek)}</td>
                        <td>
                          <span className="servant-cell">{row.lastCaller || "غير مسجل"}</span>
                        </td>
                      </>
                    )}
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="empty-row">{loading ? "جاري تحميل البيانات" : "لا توجد نتائج"}</p>}
      </div>
    </section>
  );
}

function ReportModal({ report, close }) {
  const summary = report.attendanceSummary;
  const eventByDate = useMemo(
    () => new Map(report.events.map((event) => [event.date, event])),
    [report.events],
  );
  const reportDates = useMemo(() => {
    if (!summary?.start) return report.events.map((event) => event.date);
    const dates = [];
    const start = new Date(`${summary.start}T12:00:00`);
    const end = new Date(`${today()}T12:00:00`);
    for (const date = start; date <= end; date.setDate(date.getDate() + 7)) {
      dates.push(date.toISOString().slice(0, 10));
    }
    const allDates = new Set(dates);
    report.events.forEach((event) => allDates.add(event.date));
    return [...allDates].sort((a, b) => a.localeCompare(b));
  }, [report.events, summary?.start]);
  const statusBadge = (present, label) => (
    <span className={`report-status ${present ? "is-present" : "is-absent"}`}>
      <span className="report-status-dot" />
      {present ? label : "غائب"}
    </span>
  );
  return (
    <div className="modal">
      <button className="modal-backdrop" aria-label="إغلاق التقرير" onClick={close} />
      <section className="report-dialog" role="dialog" aria-modal="true">
        <button className="modal-close" aria-label="إغلاق" onClick={close}>
          <X size={18} />
        </button>
        <p className="section-kicker">التقرير التفصيلي للمخدوم</p>
        <h2 className="report-person-heading">
          <PersonAvatar person={report.person} name={report.person.name} size="large" />
          {report.person.name}
        </h2>
        <div className="report-meta">
          الجروب {report.person.group || "غير مرتبط"} · {report.person.phone1 || "بدون رقم"}
        </div>
        {report.person.address && (
          <a
            className="map-address-link"
            href={mapsSearchUrl(report.person.address)}
            target="_blank"
            rel="noreferrer"
          >
            <MapPin size={16} />
            <span>{report.person.address}</span>
          </a>
        )}
        {summary && (
          <>
            <p className="report-period">الحضور والغياب من ٢ أكتوبر ٢٠٢٦ · {summary.expectedFridays} جمعات</p>
            <div className="report-summary attendance-report-summary">
              <span>
                حضور الخورس: <strong>{summary.choirPresent}</strong>
                <small>
                  غياب {summary.choirAbsent} · نسبة الحضور {summary.choirRate}%
                </small>
              </span>
              <span>
                حضور القداس: <strong>{summary.massPresent}</strong>
                <small>
                  غياب {summary.massAbsent} · نسبة الحضور {summary.massRate}%
                </small>
              </span>
            </div>
          </>
        )}
        <div className="report-summary">
          <span>
            زيارات: <strong>{report.events.filter((event) => event.visited).length}</strong>
          </span>
          <span>
            اتصالات: <strong>{report.events.filter((event) => event.called).length}</strong>
          </span>
        </div>
        <div className="report-table-wrap">
          <table className="report-table">
            <thead>
              <tr>
                <th>التاريخ</th>
                <th>زيارة</th>
                <th>اتصال</th>
                <th>خورس</th>
                <th>قداس</th>
                <th>الخادم</th>
              </tr>
            </thead>
            <tbody>
              {reportDates.length ? (
                reportDates.map((date) => {
                  const event = eventByDate.get(date) || {
                    visited: false,
                    called: false,
                    choir: false,
                    mass: false,
                    caller: "",
                  };
                  return (
                    <tr key={date} className={event.visited || event.called ? "report-followup-row" : ""}>
                      <td>
                        <strong className="report-date-value">{dateLabel(date)}</strong>
                        <small className="report-friday-label">{weekdayLabel(date)}</small>
                      </td>
                      <td>
                        <span className={`report-mini-status ${event.visited ? "done" : "muted"}`}>
                          {event.visited ? "تمت" : "—"}
                        </span>
                      </td>
                      <td>
                        <span className={`report-mini-status ${event.called ? "done" : "muted"}`}>
                          {event.called ? "تم" : "—"}
                        </span>
                      </td>
                      <td>{statusBadge(event.choir, "حضر")}</td>
                      <td>{statusBadge(event.mass, "حضر")}</td>
                      <td>{event.caller || "—"}</td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan="6">لا يوجد سجل محفوظ لهذا الفرد</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
function AttendanceBar({ label, value, total, tone }) {
  const width = total ? Math.max(3, (value * 100) / total) : 0;
  return (
    <div className="attendance-bar-item">
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <div className="attendance-bar-track">
        <i className={tone} style={{ width: width + "%" }} />
      </div>
    </div>
  );
}
function AttendanceDonut({ choir, mass, total }) {
  const values = [choir, Math.max(0, total - choir), mass, Math.max(0, total - mass)];
  const sum = Math.max(
    1,
    values.reduce((a, b) => a + b, 0),
  );
  const stops = values
    .map(
      (value, index) =>
        `${["#078b59", "#d28700", "#6989cf", "#e58c8c"][index]} ${(values.slice(0, index).reduce((a, b) => a + b, 0) * 100) / sum}% ${(values.slice(0, index + 1).reduce((a, b) => a + b, 0) * 100) / sum}%`,
    )
    .join(", ");
  return (
    <div className="four-donut-wrap">
      <div className="four-donut" style={{ background: `conic-gradient(${stops})` }}>
        <strong>{Math.round(((choir + mass) * 100) / Math.max(1, total * 2))}%</strong>
      </div>
      <div className="donut-legend">
        <span>
          <i className="green" /> حضور الخورس <b>{choir}</b>
        </span>
        <span>
          <i className="orange" /> غياب الخورس <b>{Math.max(0, total - choir)}</b>
        </span>
        <span>
          <i className="blue" /> حضور القداس <b>{mass}</b>
        </span>
        <span>
          <i className="red" /> غياب القداس <b>{Math.max(0, total - mass)}</b>
        </span>
      </div>
    </div>
  );
}
