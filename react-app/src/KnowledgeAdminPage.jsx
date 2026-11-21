import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileText,
  LoaderCircle,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import "./knowledge.css";

const CATEGORIES = ["الكتاب المقدس", "الطقوس", "العقيدة", "التفاسير", "الألحان", "اللغة القبطية", "كتب أخرى"];
const PROCESSING = new Set(["queued", "extracting", "embedding"]);
const STATUS_LABELS = {
  pending: "لم تتم الفهرسة",
  queued: "في قائمة الانتظار",
  extracting: "استخراج الصفحات",
  embedding: "فهرسة المقاطع",
  ready: "جاهز",
  needs_ocr: "يحتاج إلى OCR",
  failed: "فشلت الفهرسة",
  partial: "استخراج غير مكتمل — غير متاح للإجابات",
  awaiting_embedding: "بانتظار إعداد خدمة التضمينات",
};
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const CHUNK_LIMIT = 10;
const asText = (value) => (typeof value === "string" || typeof value === "number" ? String(value) : "");
const countText = (value) => (Number.isInteger(value) && value >= 0 ? value.toLocaleString("ar-EG") : "—");
const sourceStatus = (source) => asText(source.status).toLowerCase();
const emptyDraft = () => ({ title: "", category: "الطقوس", author: "", permissionNote: "", isActive: true });
const metadataOf = (source) => ({
  title: asText(source.title),
  category: asText(source.category) || "كتب أخرى",
  author: asText(source.author),
  permissionNote: asText(source.permissionNote),
  isActive: Boolean(source.isActive),
});
const isSource = (value) =>
  value &&
  typeof value === "object" &&
  (typeof value.sourceId === "string" || typeof value.sourceId === "number");
function dateText(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString("ar-EG", { year: "numeric", month: "short", day: "numeric" });
}
function errorText(error) {
  if (error.status === 401 || error.status === 403)
    return `لا تملك صلاحية إدارة المصادر، أو انتهت جلسة الدخول. ${error.backendMessage || "راجع تسجيل دخولك كخادم ثم أعد المحاولة."}`;
  return error.message || "تعذر إتمام الطلب. حاول مرة أخرى.";
}

function DeleteConfirmation({ title, busy, onCancel, onConfirm }) {
  const cancelRef = useRef(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  return (
    <div className="knowledge-delete-confirm" role="group" aria-label={`تأكيد حذف ${title}`}>
      <strong>حذف «{title}» نهائيًا؟</strong>
      <p>سيُحذف المصدر ومحتواه المفهرس من قاعدة المعرفة. لا يمكن التراجع عن هذا الإجراء.</p>
      <div className="knowledge-actions">
        <button
          className="knowledge-button knowledge-button--secondary"
          type="button"
          ref={cancelRef}
          onClick={onCancel}
          disabled={busy}
        >
          إلغاء
        </button>
        <button
          className="knowledge-button knowledge-button--danger"
          type="button"
          onClick={onConfirm}
          disabled={busy}
        >
          <Trash2 size={15} aria-hidden="true" /> تأكيد الحذف
        </button>
      </div>
    </div>
  );
}

function SourceCard({
  source,
  busy,
  editing,
  deleting,
  onEdit,
  onToggle,
  onDeleteStart,
  onDeleteCancel,
  onDeleteConfirm,
  onIngest,
  onInspect,
  inspecting,
  chunks,
  onChunksPage,
  onCloseChunks,
}) {
  const status = sourceStatus(source);
  const processing = PROCESSING.has(status);
  const failedPages = Array.isArray(source.failedPages)
    ? source.failedPages.filter((page) => Number.isInteger(page) && page >= 0)
    : [];
  const title = asText(source.title) || "مصدر دون عنوان";
  const deleteRef = useRef(null);
  const statusClass =
    status === "ready" && failedPages.length
      ? "partial"
      : Object.hasOwn(STATUS_LABELS, status)
        ? status
        : "unknown";
  return (
    <article className={`knowledge-source-card${editing ? " knowledge-source-card--editing" : ""}`}>
      <div className="knowledge-source-heading">
        <span className="knowledge-file-icon">
          <FileText size={22} aria-hidden="true" />
        </span>
        <div className="knowledge-source-title">
          <h3>{title}</h3>
          <p>
            <bdi>{asText(source.fileName) || "اسم الملف غير متاح"}</bdi>
          </p>
        </div>
        <span className={`knowledge-status knowledge-status--${statusClass}`}>
          {processing && <LoaderCircle className="knowledge-spin" size={13} aria-hidden="true" />}
          {status === "ready" && failedPages.length
            ? "جاهز جزئيًا — صفحات فاشلة"
            : STATUS_LABELS[status] || `حالة غير معروفة${status ? `: ${status}` : ""}`}
        </span>
      </div>
      <div className="knowledge-source-tags">
        <span>{asText(source.category) || "دون تصنيف"}</span>
        {asText(source.author) && <span>المؤلف: {asText(source.author)}</span>}
      </div>
      <dl className="knowledge-source-counts">
        <div>
          <dt>الصفحات</dt>
          <dd>{countText(source.pageCount)}</dd>
        </div>
        <div>
          <dt>المقاطع</dt>
          <dd>{countText(source.chunkCount)}</dd>
        </div>
        <div>
          <dt>أُضيف في</dt>
          <dd>{dateText(source.createdAt)}</dd>
        </div>
        <div>
          <dt>آخر فهرسة</dt>
          <dd>{dateText(source.indexedAt)}</dd>
        </div>
      </dl>
      <details className="knowledge-permission-details">
        <summary>
          <ShieldCheck size={15} aria-hidden="true" /> ملاحظة الإذن
        </summary>
        <p className="knowledge-plain-text">
          {asText(source.permissionNote) || "لم تُسجَّل ملاحظة إذن لهذا المصدر."}
        </p>
      </details>
      {(status === "needs_ocr" || failedPages.length > 0) && (
        <div className="knowledge-warning" role="note">
          <AlertCircle size={17} aria-hidden="true" />
          <div>
            {status === "needs_ocr" && <strong>يلزم التعرف الضوئي على الحروف (OCR).</strong>}
            {failedPages.length > 0 && (
              <p>
                صفحات تعذر استخراجها: <bdi>{failedPages.join("، ")}</bdi>
              </p>
            )}
            <p>
              {status === "needs_ocr"
                ? "تعذر استخراج كل الصفحات. راجع إعداد عامل PDF وخدمة OCR ثم أعد الفهرسة، أو ارفع نسخة نصية."
                : "المصدر غير مكتمل. راجع هذه الصفحات قبل الاعتماد على محتواه."}
            </p>
          </div>
        </div>
      )}
      {asText(source.errorMessage) && (
        <p className="knowledge-source-error">
          <AlertCircle size={16} aria-hidden="true" />
          <span className="knowledge-plain-text">{asText(source.errorMessage)}</span>
        </p>
      )}
      {status === "failed" && !asText(source.errorMessage) && (
        <p className="knowledge-source-error">
          فشلت الفهرسة دون تفاصيل من الخادم. يمكنك إعادة المحاولة بعد مراجعة الملف.
        </p>
      )}
      <div className="knowledge-source-footer">
        <button
          className={`knowledge-toggle${source.isActive ? " knowledge-toggle--active" : ""}`}
          type="button"
          role="switch"
          aria-checked={Boolean(source.isActive)}
          aria-label={`تفعيل المصدر: ${title}`}
          onClick={onToggle}
          disabled={busy}
        >
          <span aria-hidden="true" />
          {source.isActive ? "مفعّل" : "غير مفعّل"}
        </button>
        <div className="knowledge-actions">
          <button
            className="knowledge-icon-button"
            type="button"
            onClick={onEdit}
            disabled={busy}
            aria-label={`تعديل بيانات ${title}`}
          >
            <Pencil size={16} aria-hidden="true" /> تعديل
          </button>
          <button
            className="knowledge-icon-button"
            type="button"
            onClick={onIngest}
            disabled={busy || processing}
            aria-label={`فهرسة أو إعادة فهرسة ${title}`}
          >
            <RefreshCw size={16} aria-hidden="true" />
            {processing ? "قيد المعالجة" : status === "pending" ? "فهرسة" : "إعادة الفهرسة"}
          </button>
          <button
            className="knowledge-icon-button knowledge-icon-button--danger"
            type="button"
            ref={deleteRef}
            onClick={onDeleteStart}
            disabled={busy}
            aria-label={`طلب حذف ${title}`}
          >
            <Trash2 size={16} aria-hidden="true" /> حذف
          </button>
        </div>
      </div>
      {source.isActive && status !== "ready" && (
        <p className="knowledge-small-note">تفعيل المصدر لا يعني اكتمال فهرسته.</p>
      )}
      {deleting && (
        <DeleteConfirmation
          title={title}
          busy={busy}
          onCancel={() => {
            onDeleteCancel();
            deleteRef.current?.focus();
          }}
          onConfirm={onDeleteConfirm}
        />
      )}
      {Number.isInteger(source.chunkCount) && source.chunkCount > 0 && !inspecting && (
        <button className="knowledge-inspect-button" type="button" onClick={onInspect} disabled={busy}>
          <BookOpen size={15} aria-hidden="true" /> عرض النص المفهرس
        </button>
      )}
      {inspecting && chunks && (
        <section className="knowledge-chunks" aria-label={`النص المفهرس للمصدر ${title}`}>
          <header>
            <strong>المحتوى المخزّن · {countText(chunks.total)} مقطع</strong>
            <button
              className="knowledge-icon-button"
              type="button"
              onClick={onCloseChunks}
              aria-label="إغلاق معاينة المقاطع"
            >
              <X size={17} aria-hidden="true" />
            </button>
          </header>
          {chunks.loading ? (
            <p className="knowledge-loading" role="status">
              <LoaderCircle className="knowledge-spin" size={17} aria-hidden="true" /> جارٍ تحميل المقاطع…
            </p>
          ) : chunks.error ? (
            <div className="knowledge-inline-error" role="alert">
              <p>{chunks.error}</p>
              <button
                className="knowledge-button knowledge-button--secondary"
                type="button"
                onClick={() => onChunksPage(chunks.offset)}
                disabled={busy}
              >
                إعادة المحاولة
              </button>
            </div>
          ) : !chunks.chunks.length ? (
            <p className="knowledge-small-note">لا توجد مقاطع نصية مخزّنة للعرض.</p>
          ) : (
            <ol className="knowledge-chunk-list" start={chunks.offset + 1}>
              {chunks.chunks.map((chunk, index) => {
                const page = asText(chunk?.page ?? chunk?.pageNumber);
                const content = typeof chunk === "string" ? chunk : asText(chunk?.text ?? chunk?.content);
                return (
                  <li key={asText(chunk?.chunkId) || `${chunks.offset}-${index}`}>
                    <strong>
                      المقطع {countText(chunks.offset + index + 1)}
                      {page ? ` · الصفحة ${page}` : ""}
                    </strong>
                    <p className="knowledge-plain-text">
                      {content || "لا يوجد نص قابل للعرض في هذا المقطع."}
                    </p>
                  </li>
                );
              })}
            </ol>
          )}
          {!chunks.loading && !chunks.error && chunks.total > CHUNK_LIMIT && (
            <nav className="knowledge-chunk-pagination" aria-label="صفحات المقاطع">
              <button
                className="knowledge-icon-button"
                type="button"
                disabled={busy || chunks.offset === 0}
                onClick={() => onChunksPage(Math.max(0, chunks.offset - CHUNK_LIMIT))}
              >
                <ChevronRight size={16} aria-hidden="true" /> السابق
              </button>
              <span>
                {countText(chunks.offset + 1)}–{countText(chunks.offset + chunks.chunks.length)} /{" "}
                {countText(chunks.total)}
              </span>
              <button
                className="knowledge-icon-button"
                type="button"
                disabled={
                  busy || !chunks.chunks.length || chunks.offset + chunks.chunks.length >= chunks.total
                }
                onClick={() => onChunksPage(chunks.offset + CHUNK_LIMIT)}
              >
                التالي <ChevronLeft size={16} aria-hidden="true" />
              </button>
            </nav>
          )}
        </section>
      )}
    </article>
  );
}

export default function KnowledgeAdminPage({ apiUrl, username, password }) {
  const baseUrl = (apiUrl || "").replace(/\/+$/, "");
  const hasCredentials = Boolean(username && password);
  const formId = useId();
  const [sources, setSources] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [authFailure, setAuthFailure] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [draft, setDraft] = useState(emptyDraft);
  const [file, setFile] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [chunksView, setChunksView] = useState(null);
  const controllers = useRef(new Set());
  const epoch = useRef(0);
  const listVersion = useRef(0);
  const listController = useRef(null);
  const chunkVersion = useRef(0);
  const chunkController = useRef(null);
  const actionLock = useRef(false);
  const fileRef = useRef(null);
  const titleRef = useRef(null);
  const formRef = useRef(null);

  const request = useCallback(
    async (path, options = {}) => {
      if (!username || !password) throw new Error("يلزم تسجيل دخول خادم لإدارة المصادر.");
      const controller = new AbortController();
      controllers.current.add(controller);
      const forwardAbort = () => controller.abort();
      if (options.signal?.aborted) controller.abort();
      else options.signal?.addEventListener("abort", forwardAbort, { once: true });
      let timedOut = false;
      const isUpload = typeof FormData !== "undefined" && options.body instanceof FormData;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, isUpload ? 300000 : 90000);
      try {
        const response = await fetch(`${baseUrl}${path}`, {
          method: options.method || "GET",
          signal: controller.signal,
          credentials: "omit",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            "X-App-Username": username,
            "X-App-Password": password,
            ...(typeof options.body === "string" ? { "Content-Type": "application/json" } : {}),
          },
          ...(options.body !== undefined ? { body: options.body } : {}),
        });
        const data = response.status === 204 ? null : await response.json().catch(() => null);
        if (!response.ok) {
          const error = new Error(asText(data?.error) || `تعذر إتمام الطلب (HTTP ${response.status}).`);
          error.status = response.status;
          error.backendMessage = asText(data?.error);
          throw error;
        }
        return { data, status: response.status };
      } catch (error) {
        if (timedOut)
          throw new Error(
            isUpload
              ? "انتهت مهلة رفع الملف. الملفات الكبيرة تفشل على شبكات الهاتف؛ جرّب واي فاي أو ارفع نسخة TXT أو JSONL."
              : "انتهت مهلة الاتصال بالخادم. تحقق من الحالة قبل إعادة إجراء تغيير.",
          );
        if (error.name === "AbortError") throw error;
        if (error instanceof TypeError)
          throw new Error(
            isUpload
              ? "انقطع الاتصال أثناء رفع الملف. راجع قائمة المصادر أولًا حتى لا يتكرر الرفع، ثم أعد المحاولة على واي فاي أو ارفع نسخة TXT أو JSONL الأصغر."
              : "تعذر الاتصال بالخادم. تحقق من الإنترنت ثم أعد المحاولة.",
          );
        throw error;
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", forwardAbort);
        controllers.current.delete(controller);
      }
    },
    [baseUrl, username, password],
  );

  const loadSources = useCallback(
    async (quiet = false) => {
      if (!hasCredentials) return;
      listController.current?.abort();
      const controller = new AbortController();
      listController.current = controller;
      const version = ++listVersion.current;
      const currentEpoch = epoch.current;
      if (!quiet) setLoading(true);
      try {
        const { data } = await request("/api/knowledge/sources", { signal: controller.signal });
        if (!Array.isArray(data) || !data.every(isSource))
          throw new Error("وصلت قائمة مصادر غير صالحة من الخادم.");
        if (version !== listVersion.current || currentEpoch !== epoch.current || controller.signal.aborted)
          return;
        setSources(data);
        setLoaded(true);
        setListError("");
        setAuthFailure(false);
      } catch (error) {
        if (version !== listVersion.current || currentEpoch !== epoch.current || controller.signal.aborted)
          return;
        setListError(errorText(error));
        if (error.status === 401 || error.status === 403) {
          setAuthFailure(true);
          setSources([]);
          setLoaded(false);
        }
      } finally {
        if (listController.current === controller) listController.current = null;
        if (version === listVersion.current && currentEpoch === epoch.current) setLoading(false);
      }
    },
    [hasCredentials, request],
  );

  useEffect(() => {
    epoch.current += 1;
    actionLock.current = false;
    setSources([]);
    setLoaded(false);
    setLoading(false);
    setListError("");
    setActionError("");
    setNotice("");
    setAuthFailure(false);
    setBusyAction("");
    setDraft(emptyDraft());
    setFile(null);
    if (fileRef.current) fileRef.current.value = "";
    setEditingId(null);
    setDeletingId(null);
    setChunksView(null);
    loadSources();
    return () => {
      epoch.current += 1;
      listVersion.current += 1;
      chunkVersion.current += 1;
      listController.current?.abort();
      chunkController.current?.abort();
      controllers.current.forEach((controller) => controller.abort());
    };
  }, [loadSources]);

  const processingCount = sources.filter((source) => PROCESSING.has(sourceStatus(source))).length;
  useEffect(() => {
    if (!hasCredentials || !loaded || authFailure || listError || busyAction || !processingCount) return;
    const interval = setInterval(() => {
      // A slow request must not overlap with the next poll.
      if (!listController.current && !actionLock.current) loadSources(true);
    }, 4000);
    return () => clearInterval(interval);
  }, [hasCredentials, loaded, authFailure, listError, busyAction, processingCount, loadSources]);

  const closeChunks = () => {
    chunkVersion.current += 1;
    chunkController.current?.abort();
    setChunksView(null);
  };
  const resetForm = () => {
    setEditingId(null);
    setDraft(emptyDraft());
    setFile(null);
    if (fileRef.current) fileRef.current.value = "";
  };
  const disabled = !hasCredentials || authFailure || Boolean(busyAction);

  const mutate = async (key, path, options, successMessage, onSuccess) => {
    if (actionLock.current || !hasCredentials || authFailure) return;
    actionLock.current = true;
    const currentEpoch = epoch.current;
    listController.current?.abort();
    listVersion.current += 1;
    setLoading(false);
    setBusyAction(key);
    setActionError("");
    setNotice("");
    try {
      const result = await request(path, options);
      if (currentEpoch !== epoch.current) return;
      onSuccess?.(result);
      setNotice(successMessage);
      await loadSources(true);
    } catch (error) {
      if (currentEpoch !== epoch.current || error.name === "AbortError") return;
      setActionError(errorText(error));
      if (error.status === 401 || error.status === 403) {
        setAuthFailure(true);
        setSources([]);
        closeChunks();
      }
    } finally {
      if (currentEpoch === epoch.current) {
        actionLock.current = false;
        setBusyAction("");
      }
    }
  };

  const saveSource = (event) => {
    event.preventDefault();
    if (disabled) return;
    const metadata = {
      ...draft,
      title: draft.title.trim(),
      author: draft.author.trim(),
      permissionNote: draft.permissionNote.trim(),
    };
    if (!CATEGORIES.includes(metadata.category)) {
      setActionError("اختر تصنيف المصدر قبل الحفظ.");
      return;
    }
    if (editingId !== null) {
      mutate(
        "save",
        `/api/knowledge/sources/${encodeURIComponent(editingId)}`,
        { method: "PUT", body: JSON.stringify(metadata) },
        "تم تحديث بيانات المصدر.",
        ({ data }) => {
          setSources((current) =>
            current.map((source) =>
              source.sourceId === editingId ? (isSource(data) ? data : { ...source, ...metadata }) : source,
            ),
          );
          resetForm();
        },
      );
      return;
    }
    if (!file || file.size === 0) {
      setActionError("الملف فارغ. اختر ملفًا آخر.");
      fileRef.current?.focus();
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setActionError(
        `حجم الملف ${Math.round(file.size / (1024 * 1024))} ميجابايت، والحد الأقصى ٢٠ ميجابايت. ارفع نسخة TXT أو JSONL من الكتاب.`,
      );
      fileRef.current?.focus();
      return;
    }
    const body = new FormData();
    body.append("file", file);
    Object.entries(metadata).forEach(([key, value]) => body.append(key, String(value)));
    mutate(
      "upload",
      "/api/knowledge/sources",
      { method: "POST", body },
      "تم رفع المصدر وإضافته إلى قائمة الفهرسة.",
      ({ data }) => {
        if (!isSource(data))
          throw new Error("لم يُرجع الخادم بيانات المصدر المرفوع. حدّث القائمة للتحقق قبل إعادة رفع الملف.");
        setSources((current) => [...current.filter((source) => source.sourceId !== data.sourceId), data]);
        resetForm();
      },
    );
  };

  const editSource = (source) => {
    setEditingId(source.sourceId);
    setDraft(metadataOf(source));
    setActionError("");
    setNotice("");
    setFile(null);
    if (fileRef.current) fileRef.current.value = "";
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    titleRef.current?.focus({ preventScroll: true });
  };
  const ingestSource = (source) => {
    mutate(
      `ingest:${source.sourceId}`,
      `/api/knowledge/sources/${encodeURIComponent(source.sourceId)}/ingest`,
      { method: "POST" },
      "تم قبول طلب الفهرسة. ستتحدث الحالة تلقائيًا أثناء المعالجة.",
      ({ status }) => {
        if (status !== 202)
          throw new Error(
            "لم يؤكد الخادم وضع طلب الفهرسة في قائمة الانتظار. حدّث القائمة للتحقق من الحالة قبل تكرار الطلب.",
          );
        setSources((current) =>
          current.map((item) => (item.sourceId === source.sourceId ? { ...item, status: "queued" } : item)),
        );
        if (chunksView?.sourceId === source.sourceId) closeChunks();
      },
    );
  };
  const removeSource = (source) => {
    mutate(
      `delete:${source.sourceId}`,
      `/api/knowledge/sources/${encodeURIComponent(source.sourceId)}`,
      { method: "DELETE" },
      "تم حذف المصدر.",
      () => {
        setSources((current) => current.filter((item) => item.sourceId !== source.sourceId));
        setDeletingId(null);
        if (editingId === source.sourceId) resetForm();
        if (chunksView?.sourceId === source.sourceId) closeChunks();
      },
    );
  };
  const toggleSource = (source) => {
    const metadata = { ...metadataOf(source), isActive: !source.isActive };
    mutate(
      `toggle:${source.sourceId}`,
      `/api/knowledge/sources/${encodeURIComponent(source.sourceId)}`,
      { method: "PUT", body: JSON.stringify(metadata) },
      metadata.isActive ? "تم تفعيل المصدر." : "تم إيقاف المصدر.",
      ({ data }) => {
        setSources((current) =>
          current.map((item) =>
            item.sourceId === source.sourceId ? (isSource(data) ? data : { ...item, ...metadata }) : item,
          ),
        );
        if (editingId === source.sourceId)
          setDraft((current) => ({ ...current, isActive: metadata.isActive }));
      },
    );
  };

  const inspectChunks = async (sourceId, offset = 0) => {
    if (disabled) return;
    chunkController.current?.abort();
    const controller = new AbortController();
    chunkController.current = controller;
    const version = ++chunkVersion.current;
    const currentEpoch = epoch.current;
    setChunksView({ sourceId, offset, total: null, chunks: [], loading: true, error: "" });
    try {
      const { data } = await request(
        `/api/knowledge/chunks/${encodeURIComponent(sourceId)}?offset=${offset}&limit=${CHUNK_LIMIT}`,
        { signal: controller.signal },
      );
      if (!data || !Array.isArray(data.chunks) || !Number.isInteger(data.total) || data.total < 0)
        throw new Error("وصل رد غير صالح لعرض المقاطع.");
      if (version !== chunkVersion.current || currentEpoch !== epoch.current || controller.signal.aborted)
        return;
      setChunksView({ sourceId, offset, total: data.total, chunks: data.chunks, loading: false, error: "" });
    } catch (error) {
      if (version !== chunkVersion.current || currentEpoch !== epoch.current || controller.signal.aborted)
        return;
      setChunksView({
        sourceId,
        offset,
        total: null,
        chunks: [],
        loading: false,
        error: error.status === 404 ? "عرض المقاطع غير متاح لهذا المصدر على الخادم." : errorText(error),
      });
      if (error.status === 401 || error.status === 403) {
        setAuthFailure(true);
        setActionError(errorText(error));
        setSources([]);
      }
    }
  };

  const readyCount = sources.filter(
    (source) =>
      sourceStatus(source) === "ready" && !(Array.isArray(source.failedPages) && source.failedPages.length),
  ).length;
  return (
    <section className="knowledge-admin-page" dir="rtl" lang="ar" aria-label="إدارة مصادر المعرفة">
      <header className="knowledge-heading">
        <div className="knowledge-heading-icon">
          <BookOpen size={27} aria-hidden="true" />
        </div>
        <div>
          <p className="knowledge-kicker">إدارة المحتوى · للخدام فقط</p>
          <h1>مصادر المعرفة</h1>
          <p>أضف مصادرك التعليمية وراجع جاهزيتها قبل الاستناد إليها في «اسأل عن الطقس».</p>
        </div>
      </header>
      <aside className="knowledge-rights-note">
        <ShieldCheck size={19} aria-hidden="true" />
        <p>
          المحتوى المرفوع مملوك لك، ولذلك تلزمك ملاحظة الإذن فقط إن أردت توضيح حدود الاستخدام.
        </p>
      </aside>
      {!hasCredentials && (
        <div className="knowledge-inline-error" role="alert">
          يلزم تسجيل دخول خادم لإدارة المصادر. لا يمكن عرض البيانات أو رفع ملفات دون صلاحية يتحقق منها الخادم.
        </div>
      )}
      {authFailure && (
        <div className="knowledge-inline-error" role="alert">
          تعذر التحقق من صلاحية إدارة المصادر. راجع تسجيل الدخول؛ لا توجد محاولة دخول بديلة تلقائية.
        </div>
      )}
      {actionError && (
        <div className="knowledge-inline-error" role="alert">
          <AlertCircle size={18} aria-hidden="true" />
          <p>{actionError}</p>
        </div>
      )}
      {notice && (
        <div className="knowledge-success" role="status">
          <CheckCircle2 size={18} aria-hidden="true" />
          <p>{notice}</p>
        </div>
      )}
      <div className="knowledge-stats" aria-label="ملخص المصادر">
        <div>
          <span>كل المصادر</span>
          <strong>{loaded && !authFailure ? countText(sources.length) : "—"}</strong>
        </div>
        <div>
          <span>جاهزة بالكامل</span>
          <strong>{loaded && !authFailure ? countText(readyCount) : "—"}</strong>
        </div>
        <div>
          <span>قيد المعالجة</span>
          <strong>{loaded && !authFailure ? countText(processingCount) : "—"}</strong>
        </div>
      </div>
      <div className="knowledge-layout">
        <form
          className="knowledge-form"
          onSubmit={saveSource}
          ref={formRef}
          aria-labelledby={`${formId}-heading`}
        >
          <div className="knowledge-form-heading">
            <Upload size={21} aria-hidden="true" />
            <div>
              <h2 id={`${formId}-heading`}>{editingId !== null ? "تعديل بيانات المصدر" : "إضافة مصدر"}</h2>
              <p>
                {editingId !== null
                  ? "تعديل البيانات لا يستبدل الملف. إعادة الفهرسة إجراء مستقل."
                  : "TXT · JSONL · PDF — حتى ٢٠ ميجابايت"}
              </p>
            </div>
          </div>
          <fieldset disabled={disabled} className="knowledge-fields">
            {editingId === null && (
              <label htmlFor={`${formId}-file`}>
                الملف <span className="knowledge-required">(مطلوب)</span>
                <input
                  id={`${formId}-file`}
                  ref={fileRef}
                  type="file"
                  accept=".txt,.jsonl,.pdf,text/plain,text/*,application/pdf,application/json,application/x-ndjson"
                  required
                  onChange={(event) => {
                    setFile(event.target.files?.[0] || null);
                    setActionError("");
                  }}
                />
                {file && (
                  <span className="knowledge-field-help">
                    الحجم المختار: {(file.size / (1024 * 1024)).toFixed(2)} ميجابايت
                    {file.size > 5 * 1024 * 1024 &&
                      " — الملفات الكبيرة تُبطئ الرفع على بيانات الهاتف؛ نسخة TXT أو JSONL أسرع."}
                  </span>
                )}
                <span className="knowledge-field-help">
                  النوع يُحدَّد من محتوى الملف نفسه، فلا يحتاج اسمًا ينتهي بامتداد. ملفات PDF المصوّرة قد
                  تحتاج إلى OCR؛ لا تُعد جاهزة بمجرد رفعها.
                </span>
              </label>
            )}
            <label htmlFor={`${formId}-title`}>
              عنوان المصدر <span className="knowledge-optional">(اختياري)</span>
              <input
                id={`${formId}-title`}
                ref={titleRef}
                maxLength={200}
                value={draft.title}
                placeholder="اتركه فارغًا لاستخدام اسم الملف"
                onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
              />
            </label>
            <label htmlFor={`${formId}-category`}>
              التصنيف
              <select
                id={`${formId}-category`}
                required
                value={draft.category}
                onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value }))}
              >
                {!CATEGORIES.includes(draft.category) && (
                  <option value={draft.category}>اختر تصنيفًا معتمدًا</option>
                )}
                {CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor={`${formId}-author`}>
              المؤلف <span className="knowledge-optional">(اختياري)</span>
              <input
                id={`${formId}-author`}
                maxLength={200}
                value={draft.author}
                onChange={(event) => setDraft((current) => ({ ...current, author: event.target.value }))}
              />
            </label>
            <label htmlFor={`${formId}-permission`}>
              ملاحظة إذن الاستخدام <span className="knowledge-optional">(اختياري)</span>
              <textarea
                id={`${formId}-permission`}
                maxLength={2000}
                rows={4}
                value={draft.permissionNote}
                aria-describedby={`${formId}-rights`}
                placeholder="اتركها فارغة إن كان المحتوى مملوكًا لك بالكامل."
                onChange={(event) =>
                  setDraft((current) => ({ ...current, permissionNote: event.target.value }))
                }
              />
              <span id={`${formId}-rights`} className="knowledge-field-help">
                عند تركها فارغة يُسجَّل تلقائيًا أن المحتوى مملوك لك.
              </span>
            </label>
            <label className="knowledge-checkbox" htmlFor={`${formId}-active`}>
              <input
                id={`${formId}-active`}
                type="checkbox"
                checked={draft.isActive}
                onChange={(event) => setDraft((current) => ({ ...current, isActive: event.target.checked }))}
              />
              <span>تفعيل المصدر للاستخدام بعد اكتمال فهرسته</span>
            </label>
            <div className="knowledge-form-actions">
              <button className="knowledge-button" type="submit">
                {busyAction === "upload" || busyAction === "save" ? (
                  <LoaderCircle className="knowledge-spin" size={17} aria-hidden="true" />
                ) : (
                  <Upload size={17} aria-hidden="true" />
                )}
                {busyAction === "upload"
                  ? "جارٍ الرفع…"
                  : busyAction === "save"
                    ? "جارٍ الحفظ…"
                    : editingId !== null
                      ? "حفظ التعديلات"
                      : "رفع المصدر"}
              </button>
              {editingId !== null && (
                <button
                  className="knowledge-button knowledge-button--secondary"
                  type="button"
                  onClick={resetForm}
                >
                  إلغاء التعديل
                </button>
              )}
            </div>
          </fieldset>
        </form>
        <section className="knowledge-source-section" aria-labelledby={`${formId}-sources`}>
          <header className="knowledge-list-heading">
            <div>
              <h2 id={`${formId}-sources`}>المصادر المرفوعة</h2>
              <p>
                {processingCount > 0 && !listError && !authFailure
                  ? "تتحدث الحالات تلقائيًا أثناء المعالجة."
                  : "التفعيل والفهرسة حالتان مستقلتان."}
              </p>
            </div>
            <button
              className="knowledge-icon-button"
              type="button"
              onClick={() => loadSources()}
              disabled={!hasCredentials || loading || Boolean(busyAction)}
              aria-label="تحديث قائمة مصادر المعرفة"
            >
              <RefreshCw className={loading ? "knowledge-spin" : undefined} size={17} aria-hidden="true" />{" "}
              تحديث
            </button>
          </header>
          {listError && (
            <div className="knowledge-inline-error" role="alert">
              <p>{listError}</p>
              {loaded && <p>القائمة الظاهرة من آخر تحميل ناجح، وقد لا تعكس أحدث حالة.</p>}
              <button
                className="knowledge-button knowledge-button--secondary"
                type="button"
                onClick={() => loadSources()}
                disabled={!hasCredentials || loading || Boolean(busyAction)}
              >
                إعادة تحميل المصادر
              </button>
            </div>
          )}
          {loading && !loaded && (
            <div className="knowledge-empty" role="status">
              <LoaderCircle className="knowledge-spin" size={28} aria-hidden="true" />
              <p>جارٍ تحميل المصادر…</p>
            </div>
          )}
          {loaded && !loading && !listError && !sources.length && (
            <div className="knowledge-empty">
              <BookOpen size={34} aria-hidden="true" />
              <h3>لا توجد مصادر بعد</h3>
              <p>ارفع أول مصدر ثم ابدأ فهرسته.</p>
            </div>
          )}
          <div className="knowledge-source-list">
            {hasCredentials &&
              !authFailure &&
              sources.map((source) => (
                <SourceCard
                  key={source.sourceId}
                  source={source}
                  busy={disabled}
                  editing={editingId === source.sourceId}
                  deleting={deletingId === source.sourceId}
                  onEdit={() => editSource(source)}
                  onToggle={() => toggleSource(source)}
                  onDeleteStart={() => setDeletingId(source.sourceId)}
                  onDeleteCancel={() => setDeletingId(null)}
                  onDeleteConfirm={() => removeSource(source)}
                  onIngest={() => ingestSource(source)}
                  onInspect={() => inspectChunks(source.sourceId)}
                  inspecting={chunksView?.sourceId === source.sourceId}
                  chunks={chunksView?.sourceId === source.sourceId ? chunksView : null}
                  onChunksPage={(offset) => inspectChunks(source.sourceId, offset)}
                  onCloseChunks={closeChunks}
                />
              ))}
          </div>
        </section>
      </div>
    </section>
  );
}
