import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  ChevronDown,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  WifiOff,
} from "lucide-react";
import "./knowledge.css";

const SAMPLE_QUESTIONS = [
  "ما هي رتب الشمامسة؟",
  "ما معنى الإبصالتس؟",
  "ما الزيوت المستخدمة في المعمودية؟",
  "ما وظيفة الإيبوذياكون؟",
];
const textValue = (value) => (typeof value === "string" || typeof value === "number" ? String(value) : "");
const normalizedCode = (value) =>
  textValue(value)
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toUpperCase();

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

function AnswerSources({ sources }) {
  if (!sources.length) return <p className="ritual-chat-source-note">لم تُرفق إحالات بهذه الإجابة.</p>;
  return (
    <details className="ritual-chat-sources">
      <summary>
        <BookOpen size={16} aria-hidden="true" /> المصادر والإحالات ({sources.length}){" "}
        <ChevronDown size={16} aria-hidden="true" />
      </summary>
      <ol className="ritual-chat-source-list">
        {sources.map((source, index) => (
          <li className="ritual-chat-source" key={index}>
            <strong>{textValue(source?.title) || "مصدر دون عنوان"}</strong>
            {textValue(source?.page) && (
              <span className="ritual-chat-source-page">الصفحة: {textValue(source.page)}</span>
            )}
            {textValue(source?.snippet) && (
              <p className="ritual-chat-plain-text">{textValue(source.snippet)}</p>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}

export default function ChatPage({ apiUrl }) {
  const baseUrl = (apiUrl || "").replace(/\/+$/, "");
  const storageKey = `ritual-chat-session:${baseUrl || "same-origin"}`;
  const questionId = useId();
  const helpId = useId();
  const validationId = useId();
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [validation, setValidation] = useState("");
  const [failedRequest, setFailedRequest] = useState(null);
  const [health, setHealth] = useState({ kind: "checking", message: "جارٍ التحقق من اتصال الخدمة…" });
  const sessionRef = useRef("");
  const askController = useRef(null);
  const healthController = useRef(null);
  const requestVersion = useRef(0);
  const busyRef = useRef(false);
  const nextMessageId = useRef(0);
  const logRef = useRef(null);
  const questionRef = useRef(null);

  const checkHealth = useCallback(async () => {
    healthController.current?.abort();
    const controller = new AbortController();
    healthController.current = controller;
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setHealth({ kind: "offline", message: "أنت غير متصل بالإنترنت. ستظل المحادثة الحالية ظاهرة هنا." });
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

  useEffect(() => {
    sessionRef.current = "";
    try {
      sessionRef.current = sessionStorage.getItem(storageKey) || "";
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
    setFailedRequest(null);
    checkHealth();
    const offline = () => {
      healthController.current?.abort();
      setHealth({ kind: "offline", message: "انقطع اتصال الإنترنت. احتفظنا بالمحادثة الحالية هنا." });
    };
    window.addEventListener("online", checkHealth);
    window.addEventListener("offline", offline);
    return () => {
      requestVersion.current += 1;
      askController.current?.abort();
      healthController.current?.abort();
      window.removeEventListener("online", checkHealth);
      window.removeEventListener("offline", offline);
    };
  }, [storageKey, checkHealth]);

  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    log.scrollTo({ top: messages.length || loading ? log.scrollHeight : 0, behavior: "auto" });
  }, [messages, loading]);

  const rememberSession = (token) => {
    sessionRef.current = token;
    try {
      if (token) sessionStorage.setItem(storageKey, token);
      else sessionStorage.removeItem(storageKey);
    } catch {
      /* The current mount still has an in-memory session. */
    }
  };

  const sendQuestion = async (rawQuestion, retry = null) => {
    if (busyRef.current) return;
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
      if (typeof data.conversationId === "string" && data.conversationId)
        setConversationId(data.conversationId);
      setMessages((current) => [
        ...current,
        {
          id: ++nextMessageId.current,
          role: "assistant",
          text: data.answer,
          sources: data.sources,
          confidence: textValue(data.confidence),
        },
      ]);
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

  const clearConversation = () => {
    requestVersion.current += 1;
    askController.current?.abort();
    busyRef.current = false;
    setLoading(false);
    setMessages([]);
    setConversationId(null);
    setFailedRequest(null);
    setQuestion("");
    setValidation("");
    questionRef.current?.focus();
    // Local reset only: the public page never deletes server-side conversations or sources.
  };

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
              <p className="ritual-chat-kicker">معرفة كنسية من المصادر المتاحة</p>
              <h1>اسأل عن الطقس</h1>
            </div>
          </div>
          <p className="ritual-chat-disclaimer">
            <ShieldCheck size={17} aria-hidden="true" /> الإجابات من المصادر المتاحة فقط، وليست إرشادًا شخصيًا
            أو بديلًا عن الرجوع إلى أب اعترافك.
          </p>
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

        <section className="ritual-chat-panel" aria-label="محادثة اسأل عن الطقس">
          <div className="ritual-chat-panel-heading">
            <span>
              <span className="ritual-chat-status-dot" aria-hidden="true" /> سؤال وجواب مع إحالات
            </span>
            <button
              className="ritual-chat-text-button"
              type="button"
              onClick={clearConversation}
              disabled={!messages.length && !loading}
              aria-label="مسح المحادثة الحالية محليًا"
            >
              <Trash2 size={16} aria-hidden="true" /> مسح المحادثة
            </button>
          </div>
          <div
            className="ritual-chat-log"
            ref={logRef}
            role="log"
            aria-label="رسائل المحادثة"
            aria-live="polite"
            aria-relevant="additions text"
            aria-busy={loading}
            tabIndex={0}
          >
            {!messages.length && !loading && (
              <div className="ritual-chat-welcome">
                <span className="ritual-chat-welcome-icon">
                  <BookOpen size={32} aria-hidden="true" />
                </span>
                <h2>ما الذي تريد أن تعرفه؟</h2>
                <p>اسأل عن الطقوس والخدمة، وراجع المصدر المرفق مع الإجابة.</p>
                <div className="ritual-chat-samples">
                  {SAMPLE_QUESTIONS.map((sample) => (
                    <button
                      className="ritual-chat-sample"
                      type="button"
                      key={sample}
                      onClick={() => sendQuestion(sample)}
                      disabled={loading}
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
                aria-label={message.role === "user" ? "سؤالك" : "رد الخدمة"}
              >
                <p className="ritual-chat-message-label">
                  {message.role === "user" ? "أنت" : "اسأل عن الطقس"}
                </p>
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
                        disabled={loading}
                        onClick={() => sendQuestion(failedRequest.question, failedRequest)}
                      >
                        <RefreshCw size={16} aria-hidden="true" /> إعادة إرسال السؤال نفسه
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    <p className="ritual-chat-plain-text">{message.text}</p>
                    {message.role === "assistant" && (
                      <>
                        <AnswerSources sources={message.sources} />
                        {message.confidence && (
                          <p className="ritual-chat-confidence">
                            مؤشر الثقة من الخدمة: <bdi>{message.confidence}</bdi>
                          </p>
                        )}
                      </>
                    )}
                  </>
                )}
              </article>
            ))}
            {loading && (
              <div className="ritual-chat-loading" role="status">
                <RefreshCw className="ritual-chat-spin" size={18} aria-hidden="true" /> جارٍ البحث في المصادر
                وإعداد الإجابة…
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
              readOnly={loading}
              aria-invalid={Boolean(validation)}
              aria-describedby={`${helpId}${validation ? ` ${validationId}` : ""}`}
              placeholder="اكتب سؤالك عن الطقس أو الخدمة…"
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
              <button className="ritual-chat-button" type="submit" disabled={loading || !question.trim()}>
                <Send size={17} aria-hidden="true" /> {loading ? "جارٍ الإرسال…" : "إرسال"}
              </button>
            </div>
          </form>
        </section>
        <p className="ritual-chat-local-note">مسح المحادثة يمسح عرضها هنا فقط، ولا يحذف بيانات من الخادم.</p>
      </div>
    </main>
  );
}
