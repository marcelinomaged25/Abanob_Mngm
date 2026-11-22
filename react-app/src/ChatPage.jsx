import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  History,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  WifiOff,
} from "lucide-react";
import "./knowledge.css";

const SAMPLE_QUESTIONS = [
  "من هو مارمرقس؟",
  "ما هي أسرار الكنيسة السبعة؟",
  "ما معنى الإبصالتس؟",
  "لماذا نصوم؟",
];
const textValue = (value) => (typeof value === "string" || typeof value === "number" ? String(value) : "");
const normalizedCode = (value) =>
  textValue(value)
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toUpperCase();
const formatDate = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ar-EG", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

async function readChatResponse(response) {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(textValue(data?.message) || "تعذر إتمام الطلب. حاول مرة أخرى.");
    error.status = response.status;
    error.code = normalizedCode(data?.code);
    throw error;
  }
  if (!data || typeof data !== "object") {
    throw new Error("وصل رد غير صالح من الخدمة. لم تُعرض أي إجابة.");
  }
  return data;
}

function describeChatError(error, timedOut) {
  const code = normalizedCode(error.code);
  if (timedOut) {
    return {
      kind: "outage",
      title: "انتهت مهلة الاتصال",
      message: "لم تصل إجابة من الخدمة. يمكنك إعادة إرسال السؤال نفسه.",
      retryable: true,
    };
  }
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return {
      kind: "outage",
      title: "لا يوجد اتصال بالإنترنت",
      message: "احتفظنا بسؤالك هنا. أعد المحاولة عند عودة الاتصال.",
      retryable: true,
    };
  }
  if (
    [429, 502, 503, 504].includes(error.status) ||
    /(?:PROVIDER|UPSTREAM|LLM|MODEL).*(?:UNAVAILABLE|ERROR|FAIL|TIMEOUT|LIMIT|DISABLED)/.test(code)
  ) {
    return {
      kind: "outage",
      title: "خدمة الإجابة غير متاحة مؤقتًا",
      message: error.message,
      retryable: true,
    };
  }
  return {
    kind: "error",
    title: "لم نتمكن من الحصول على إجابة",
    message: error.message || "تعذر الاتصال بالخدمة. حاول مرة أخرى.",
    retryable: true,
  };
}

export default function ChatPage({ apiUrl, autoFocus = false }) {
  const baseUrl = (apiUrl || "").replace(/\/+$/, "");
  const storageKey = `ritual-chat-session:${baseUrl || "same-origin"}`;
  const lastKey = `ritual-chat-last:${baseUrl || "same-origin"}`;
  const questionId = useId();
  const helpId = useId();
  const validationId = useId();
  const historyId = useId();
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [summary, setSummary] = useState("");
  const [conversations, setConversations] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [restoringId, setRestoringId] = useState("");
  const [loading, setLoading] = useState(false);
  const [validation, setValidation] = useState("");
  const [failedRequest, setFailedRequest] = useState(null);
  const [health, setHealth] = useState({ kind: "checking", message: "جارٍ التحقق من اتصال الخدمة…" });
  const sessionRef = useRef("");
  const askController = useRef(null);
  const healthController = useRef(null);
  const historyController = useRef(null);
  const requestVersion = useRef(0);
  const busyRef = useRef(false);
  const nextMessageId = useRef(0);
  const logRef = useRef(null);
  const questionRef = useRef(null);

  useEffect(() => {
    if (autoFocus) questionRef.current?.focus();
  }, [autoFocus]);

  const rememberSession = useCallback(
    (token) => {
      sessionRef.current = token;
      try {
        if (token) localStorage.setItem(storageKey, token);
        else localStorage.removeItem(storageKey);
      } catch {
        /* The current mount still has an in-memory session. */
      }
    },
    [storageKey],
  );

  const checkHealth = useCallback(async () => {
    healthController.current?.abort();
    const controller = new AbortController();
    healthController.current = controller;
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setHealth({ kind: "offline", message: "أنت غير متصل بالإنترنت. ستظل المحادثة المحفوظة ظاهرة هنا." });
      return;
    }
    setHealth({ kind: "checking", message: "جارٍ التحقق من اتصال الخدمة…" });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 10000);
    try {
      const response = await fetch(`${baseUrl}/api/chat/health`, {
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
      });
      const data = await response.json().catch(() => null);
      if (controller.signal.aborted || healthController.current !== controller) return;
      const unavailable = !response.ok || data?.ok !== true || data?.providerConfigured !== true;
      setHealth(
        unavailable
          ? {
              kind: "warning",
              message:
                textValue(data?.message) ||
                "الخدمة غير متاحة حاليًا. يمكنك التحقق مجددًا أو محاولة إرسال سؤالك.",
            }
          : { kind: "healthy", message: "اتصال الخدمة متاح" },
      );
    } catch {
      if (healthController.current === controller && (!controller.signal.aborted || timedOut)) {
        setHealth({
          kind: "warning",
          message: "تعذر التحقق من الخدمة. لن نعرض إجابة بديلة؛ يمكنك إعادة المحاولة.",
        });
      }
    } finally {
      clearTimeout(timeout);
    }
  }, [baseUrl]);

  const loadHistory = useCallback(
    async ({ silent = false } = {}) => {
      if (!sessionRef.current) return;
      historyController.current?.abort();
      const controller = new AbortController();
      historyController.current = controller;
      if (!silent) setHistoryLoading(true);
      try {
        const response = await fetch(`${baseUrl}/api/chat/conversations`, {
          credentials: "omit",
          cache: "no-store",
          signal: controller.signal,
          headers: { "X-Chat-Session": sessionRef.current },
        });
        const data = await readChatResponse(response);
        if (controller.signal.aborted) return;
        setConversations(
          Array.isArray(data.conversations)
            ? data.conversations.filter((item) => item && item.conversationId)
            : [],
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error.status === 401) rememberSession("");
      } finally {
        if (!controller.signal.aborted) setHistoryLoading(false);
      }
    },
    [baseUrl, rememberSession],
  );

  const startNewConversation = useCallback(() => {
    requestVersion.current += 1;
    askController.current?.abort();
    busyRef.current = false;
    setLoading(false);
    setMessages([]);
    setConversationId(null);
    setSummary("");
    setFailedRequest(null);
    setQuestion("");
    setValidation("");
    setHistoryOpen(false);
    setRestoringId("");
    try {
      localStorage.removeItem(lastKey);
    } catch {
      /* Last conversation id is optional. */
    }
    questionRef.current?.focus();
  }, [lastKey]);

  const openConversation = useCallback(
    async (id) => {
      if (!id || busyRef.current || !sessionRef.current) return;
      const version = ++requestVersion.current;
      askController.current?.abort();
      busyRef.current = false;
      setLoading(false);
      setFailedRequest(null);
      setValidation("");
      setQuestion("");
      setRestoringId(id);
      try {
        const response = await fetch(`${baseUrl}/api/chat/conversations/${encodeURIComponent(id)}`, {
          credentials: "omit",
          cache: "no-store",
          headers: { "X-Chat-Session": sessionRef.current },
        });
        if (response.status === 404) {
          try {
            localStorage.removeItem(lastKey);
          } catch {
            /* Stale id is harmless. */
          }
          return;
        }
        const data = await response.json().catch(() => null);
        if (response.status === 401) {
          rememberSession("");
          return;
        }
        if (!response.ok) throw new Error(textValue(data?.message) || "تعذر تحميل المحادثة.");
        const conversation = data?.conversation;
        if (!conversation || !Array.isArray(conversation.messages))
          throw new Error("وصلت محادثة غير مكتملة من الخدمة.");
        if (requestVersion.current !== version) return;
        const restoredId = textValue(conversation.conversationId) || id;
        setConversationId(restoredId);
        setSummary(textValue(conversation.summary));
        setMessages(
          conversation.messages
            .filter((message) => message && (message.role === "user" || message.role === "assistant"))
            .map((message) => ({
              id: ++nextMessageId.current,
              role: message.role,
              text: textValue(message.text),
              sources: Array.isArray(message.sources) ? message.sources : [],
              confidence: message.confidence,
            })),
        );
        try {
          localStorage.setItem(lastKey, restoredId);
        } catch {
          /* Restore still works for this mount. */
        }
        setHistoryOpen(false);
        questionRef.current?.focus();
      } catch (error) {
        if (requestVersion.current !== version) return;
        setHealth({ kind: "warning", message: error.message || "تعذر تحميل المحادثة. حاول مرة أخرى." });
      } finally {
        if (requestVersion.current === version) setRestoringId("");
      }
    },
    [baseUrl, lastKey, rememberSession],
  );

  const deleteConversation = async (id, event) => {
    event.stopPropagation();
    if (!id || loading) return;
    if (typeof window !== "undefined" && !window.confirm("تحذف المحادثة دي؟ لا يمكن الرجوع بعد الحذف."))
      return;
    try {
      const response = await fetch(`${baseUrl}/api/chat/conversations/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "omit",
        headers: { "X-Chat-Session": sessionRef.current },
      });
      if (response.status === 401) {
        rememberSession("");
        return;
      }
      if (!response.ok && response.status !== 404) {
        const data = await response.json().catch(() => null);
        throw new Error(textValue(data?.message) || "تعذر حذف المحادثة.");
      }
      setConversations((current) => current.filter((item) => item.conversationId !== id));
      if (conversationId === id) startNewConversation();
      try {
        if (localStorage.getItem(lastKey) === id) localStorage.removeItem(lastKey);
      } catch {
        /* No local id to clear. */
      }
    } catch (error) {
      setHealth({ kind: "warning", message: error.message || "تعذر حذف المحادثة. حاول مرة أخرى." });
    }
  };

  useEffect(() => {
    sessionRef.current = "";
    try {
      sessionRef.current = localStorage.getItem(storageKey) || sessionStorage.getItem(storageKey) || "";
      if (sessionRef.current && !localStorage.getItem(storageKey))
        localStorage.setItem(storageKey, sessionRef.current);
      sessionStorage.removeItem(storageKey);
    } catch {
      /* Storage may be unavailable; retain the token in memory. */
    }
    requestVersion.current += 1;
    busyRef.current = false;
    setLoading(false);
    setQuestion("");
    setValidation("");
    setMessages([]);
    setConversationId(null);
    setSummary("");
    setConversations([]);
    setHistoryOpen(false);
    setRestoringId("");
    setFailedRequest(null);
    checkHealth();
    let last = "";
    try {
      last = localStorage.getItem(lastKey) || "";
    } catch {
      /* No saved conversation id. */
    }
    if (sessionRef.current) {
      loadHistory();
      if (last) openConversation(last);
    }
    const offline = () => {
      healthController.current?.abort();
      setHealth({ kind: "offline", message: "انقطع اتصال الإنترنت. احتفظنا بالمحادثة المحفوظة هنا." });
    };
    window.addEventListener("online", checkHealth);
    window.addEventListener("offline", offline);
    return () => {
      requestVersion.current += 1;
      askController.current?.abort();
      healthController.current?.abort();
      historyController.current?.abort();
      window.removeEventListener("online", checkHealth);
      window.removeEventListener("offline", offline);
    };
  }, [storageKey, lastKey, checkHealth, openConversation, loadHistory]);

  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    log.scrollTo({ top: messages.length || loading || restoringId ? log.scrollHeight : 0, behavior: "auto" });
  }, [messages, loading, restoringId, summary]);

  const sendQuestion = async (rawQuestion, retry = null) => {
    if (busyRef.current || restoringId) return;
    const cleanQuestion = rawQuestion.trim();
    if (!cleanQuestion || rawQuestion.length > 1000 || /[<>]/.test(rawQuestion)) {
      setValidation(
        !cleanQuestion
          ? "اكتب سؤالًا أولًا."
          : rawQuestion.length > 1000
            ? "الحد الأقصى للسؤال ١٠٠٠ حرف."
            : "اكتب نصًا فقط، دون علامات < أو > أو وسوم HTML.",
      );
      questionRef.current?.focus();
      return;
    }
    busyRef.current = true;
    const version = ++requestVersion.current;
    const controller = new AbortController();
    askController.current = controller;
    const request = retry || { question: cleanQuestion, advanced: false, conversationId };
    setValidation("");
    setLoading(true);
    setFailedRequest(null);
    setQuestion("");
    if (retry) setMessages((current) => current.filter((message) => message.id !== retry.messageId));
    else
      setMessages((current) => [
        ...current,
        { id: ++nextMessageId.current, role: "user", text: cleanQuestion },
      ]);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 90000);
    try {
      const getSession = async () => {
        const response = await fetch(`${baseUrl}/api/chat/session`, {
          method: "POST",
          credentials: "omit",
          signal: controller.signal,
        });
        const data = await readChatResponse(response);
        if (typeof data.sessionToken !== "string" || !data.sessionToken.trim())
          throw new Error("تعذر إنشاء جلسة المحادثة. حاول مرة أخرى.");
        if (requestVersion.current !== version || controller.signal.aborted) return;
        rememberSession(data.sessionToken);
      };
      if (!sessionRef.current) await getSession();
      if (requestVersion.current !== version || controller.signal.aborted) return;
      const ask = async () => {
        const response = await fetch(`${baseUrl}/api/chat/ask`, {
          method: "POST",
          credentials: "omit",
          signal: controller.signal,
          headers: { "Content-Type": "application/json", "X-Chat-Session": sessionRef.current },
          body: JSON.stringify({
            question: request.question,
            advanced: request.advanced ?? false,
            ...(request.conversationId ? { conversationId: request.conversationId } : {}),
          }),
        });
        return readChatResponse(response);
      };
      let data;
      try {
        data = await ask();
      } catch (error) {
        if (error.status !== 401) throw error;
        if (controller.signal.aborted || requestVersion.current !== version) return;
        rememberSession("");
        await getSession();
        if (controller.signal.aborted || requestVersion.current !== version) return;
        data = await ask();
      }
      if (typeof data.answer !== "string" || !data.answer.trim() || !Array.isArray(data.sources))
        throw new Error("وصل رد غير مكتمل من الخدمة. لم تُعرض أي إجابة.");
      if (requestVersion.current !== version || controller.signal.aborted) return;
      if (typeof data.conversationId === "string" && data.conversationId) {
        setConversationId(data.conversationId);
        try {
          localStorage.setItem(lastKey, data.conversationId);
        } catch {
          /* Restore after reload is optional. */
        }
      }
      setSummary(typeof data.summary === "string" ? data.summary : "");
      setMessages((current) => [
        ...current,
        {
          id: ++nextMessageId.current,
          role: "assistant",
          text: data.answer,
          sources: data.sources,
          confidence: data.confidence,
        },
      ]);
      loadHistory({ silent: true });
      questionRef.current?.focus();
    } catch (error) {
      if (requestVersion.current !== version || (controller.signal.aborted && !timedOut)) return;
      const failure = describeChatError(error, timedOut);
      const messageId = ++nextMessageId.current;
      setMessages((current) => [...current, { id: messageId, role: "assistant", failure }]);
      setFailedRequest({ ...request, messageId });
      setQuestion(request.question);
    } finally {
      clearTimeout(timeout);
      if (requestVersion.current === version) {
        busyRef.current = false;
        setLoading(false);
        askController.current = null;
      }
    }
  };

  const hasConversation = Boolean(messages.length || summary || conversationId);
  const activeConversation = conversationId;
  const busy = loading || Boolean(restoringId);

  return (
    <main className="ritual-chat-page" dir="rtl" lang="ar">
      <div className="ritual-chat-shell">
        <header className="ritual-chat-heading">
          <a className="ritual-chat-home" href="/">
            <ArrowRight size={17} aria-hidden="true" /> الرئيسية
          </a>
          <div className="ritual-chat-title-row">
            <span className="ritual-chat-brand-icon">
              <BookOpen size={27} aria-hidden="true" />
            </span>
            <div>
              <p className="ritual-chat-kicker">شات مع خادم</p>
              <h1>اسأل عن الكنيسة</h1>
            </div>
          </div>
        </header>

        {health.kind !== "healthy" && (
          <aside className={`ritual-chat-health ritual-chat-health--${health.kind}`} role="status">
            {health.kind === "offline" ? (
              <WifiOff size={18} aria-hidden="true" />
            ) : (
              <AlertCircle size={18} aria-hidden="true" />
            )}
            <span>{health.message}</span>
            <button
              className="ritual-chat-text-button"
              type="button"
              onClick={checkHealth}
              disabled={health.kind === "checking"}
              aria-label="إعادة التحقق من اتصال خدمة المحادثة"
            >
              <RefreshCw size={15} aria-hidden="true" /> تحقق مجددًا
            </button>
          </aside>
        )}

        <section className="ritual-chat-panel" aria-label="محادثة اسأل عن الكنيسة">
          <div className="ritual-chat-panel-bar">
            <div className="ritual-chat-panel-heading">
              <span>
                <span className="ritual-chat-status-dot" aria-hidden="true" /> شات مع خادم
              </span>
              <div className="ritual-chat-panel-actions">
                <button
                  className={`ritual-chat-text-button${historyOpen ? " is-active" : ""}`}
                  type="button"
                  onClick={() => setHistoryOpen((open) => !open)}
                  aria-expanded={historyOpen}
                  aria-controls={historyId}
                >
                  <History size={16} aria-hidden="true" /> المحادثات
                </button>
                <button
                  className="ritual-chat-text-button"
                  type="button"
                  onClick={startNewConversation}
                  disabled={!hasConversation || busy}
                >
                  <Plus size={16} aria-hidden="true" /> جديدة
                </button>
              </div>
            </div>

            {historyOpen && (
              <div
                className="ritual-chat-history"
                id={historyId}
                role="region"
                aria-label="المحادثات المحفوظة"
              >
                {historyLoading ? (
                  <p className="ritual-chat-history-empty">جارٍ تحميل المحادثات…</p>
                ) : !conversations.length ? (
                  <p className="ritual-chat-history-empty">
                    لسه مفيش محادثات محفوظة. أول سؤال هيتحفظ هنا تلقائيًا لحد ما تمسحه.
                  </p>
                ) : (
                  <ul>
                    {conversations.map((conversation) => {
                      const id = textValue(conversation.conversationId);
                      const title = textValue(conversation.title) || "محادثة كنسية";
                      const preview = textValue(conversation.summary);
                      return (
                        <li className="ritual-chat-history-row" key={id}>
                          <button
                            className={`ritual-chat-history-item${id === activeConversation ? " is-active" : ""}`}
                            type="button"
                            onClick={() => openConversation(id)}
                            disabled={busy}
                          >
                            <strong>{title}</strong>
                            {preview && <span className="ritual-chat-history-preview">{preview}</span>}
                            <small>
                              {formatDate(conversation.updatedAt)}
                              {Number(conversation.messageCount) > 0
                                ? ` · ${conversation.messageCount} رسالة`
                                : ""}
                            </small>
                          </button>
                          <button
                            className="ritual-chat-history-delete"
                            type="button"
                            onClick={(event) => deleteConversation(id, event)}
                            disabled={busy}
                            aria-label={`حذف ${title}`}
                            title="حذف المحادثة"
                          >
                            <Trash2 size={14} aria-hidden="true" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </div>

          {summary && (
            <aside className="ritual-chat-summary" aria-label="ملخص المحادثة">
              <span className="ritual-chat-summary-title">
                <BookOpen size={15} aria-hidden="true" /> ملخص المحادثة
              </span>
              <p className="ritual-chat-plain-text">{summary}</p>
            </aside>
          )}

          <div
            className="ritual-chat-log"
            ref={logRef}
            role="log"
            aria-label="رسائل المحادثة"
            aria-live="polite"
            aria-relevant="additions text"
            aria-busy={busy}
            tabIndex={0}
          >
            {restoringId && !messages.length && (
              <div className="ritual-chat-loading" role="status">
                <RefreshCw className="ritual-chat-spin" size={18} aria-hidden="true" /> جارٍ تحميل المحادثة…
              </div>
            )}
            {!messages.length && !loading && !restoringId && (
              <div className="ritual-chat-welcome">
                <span className="ritual-chat-welcome-icon">
                  <BookOpen size={32} aria-hidden="true" />
                </span>
                <h2>تحب تعرف إيه النهارده؟</h2>
                <p>اسأل عن الكتاب المقدس، أو القديسين، أو الطقس، أو الألحان، أو أي موضوع في الكنيسة.</p>
                <div className="ritual-chat-samples">
                  {SAMPLE_QUESTIONS.map((sample) => (
                    <button
                      className="ritual-chat-sample"
                      type="button"
                      key={sample}
                      onClick={() => sendQuestion(sample)}
                      disabled={busy}
                    >
                      {sample}
                      <ArrowRight size={15} aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((message) => (
              <article
                className={`ritual-chat-message ritual-chat-message--${message.role}${message.failure ? " ritual-chat-message--failure" : ""}`}
                key={message.id}
                aria-label={message.role === "user" ? "سؤالك" : "رد الخادم"}
              >
                <p className="ritual-chat-message-label">{message.role === "user" ? "أنت" : "خادم"}</p>
                {message.failure ? (
                  <div className={`ritual-chat-failure ritual-chat-failure--${message.failure.kind}`}>
                    <strong>
                      <AlertCircle size={17} aria-hidden="true" />
                      {message.failure.title}
                    </strong>
                    <p className="ritual-chat-plain-text">{message.failure.message}</p>
                    {message.failure.retryable && failedRequest?.messageId === message.id && (
                      <button
                        className="ritual-chat-button ritual-chat-button--secondary"
                        type="button"
                        disabled={busy}
                        onClick={() => sendQuestion(failedRequest.question, failedRequest)}
                      >
                        <RefreshCw size={16} aria-hidden="true" /> إعادة إرسال السؤال نفسه
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="ritual-chat-plain-text">{message.text}</p>
                )}
              </article>
            ))}
            {loading && (
              <div className="ritual-chat-loading" role="status">
                <RefreshCw className="ritual-chat-spin" size={18} aria-hidden="true" /> بيكتب لك…
              </div>
            )}
          </div>
          <form
            className="ritual-chat-composer"
            onSubmit={(event) => {
              event.preventDefault();
              sendQuestion(question);
            }}
          >
            <label className="ritual-chat-input-label" htmlFor={questionId}>
              سؤالك
            </label>
            <textarea
              id={questionId}
              ref={questionRef}
              value={question}
              maxLength={1000}
              rows={3}
              required
              readOnly={busy}
              aria-invalid={Boolean(validation)}
              aria-describedby={`${helpId}${validation ? ` ${validationId}` : ""}`}
              placeholder="اكتب سؤالك في أي موضوع كنسي…"
              onChange={(event) => {
                setQuestion(event.target.value);
                setValidation("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  sendQuestion(question);
                }
              }}
            />
            {validation && (
              <p className="ritual-chat-validation" id={validationId} role="alert">
                {validation}
              </p>
            )}
            <div className="ritual-chat-composer-footer">
              <p id={helpId}>
                <span className="ritual-chat-enter-hint">Enter للإرسال · Shift + Enter لسطر جديد</span>
                <span className="ritual-chat-character-count">
                  <bdi>{question.length}/1000</bdi> حرف
                </span>
              </p>
              <button className="ritual-chat-button" type="submit" disabled={busy || !question.trim()}>
                <Send size={17} aria-hidden="true" /> {loading ? "جارٍ الإرسال…" : "إرسال"}
              </button>
            </div>
          </form>
        </section>
        <p className="ritual-chat-local-note">
          المحادثات بتتحفظ على الخادم وترجع لك من نفس المتصفح، وتقدر تحذف أي محادثة في أي وقت.
        </p>
      </div>
    </main>
  );
}
