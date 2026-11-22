from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import hashlib
import hmac
import json
import math
import multiprocessing as mp
from multiprocessing.connection import Connection
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import JSONResponse

MAX_UPLOAD_BYTES = 20 * 1024 * 1024
MAX_BODY_BYTES = MAX_UPLOAD_BYTES + 64 * 1024  # Bounded multipart overhead.
MAX_PAGES = 500
PAGE_TIMEOUT = 20.0
EXTRACTION_TIMEOUT = 120.0
UPLOAD_TIMEOUT = 30.0
MAX_OUTPUT_BYTES = 2 * 1024 * 1024
MAX_PAGE_TEXT = 15_000
TEXT_BUDGET = MAX_OUTPUT_BYTES - 32 * 1024  # Reserve metadata/failed page numbers.
MAX_MESSAGE_BYTES = 4096
CHUNK_CHARS = 256  # Frames remain below PIPE_BUF, including JSON escaping.
DPI = 150
MAX_RENDER_PIXELS = 12_000_000
PROCESS_MEMORY_BYTES = 512 * 1024 * 1024
JOB_MEMORY_BYTES = 768 * 1024 * 1024


def _tesseract_env() -> dict[str, str]:
    # Do not forward application secrets to the OCR executable.
    env = {
        "PATH": os.environ.get("PATH", ""),
        "LANG": "C.UTF-8",
        "OMP_THREAD_LIMIT": "1",
        "OMP_NUM_THREADS": "1",
        "OPENBLAS_NUM_THREADS": "1",
    }
    for key in ("SystemRoot", "WINDIR", "TEMP", "TMP"):
        if key in os.environ:
            env[key] = os.environ[key]
    return env


@asynccontextmanager
async def lifespan(app: FastAPI):
    secret = os.environ.get("KNOWLEDGE_OCR_SECRET", "")
    if not secret.strip():
        raise RuntimeError("KNOWLEDGE_OCR_SECRET must be configured")
    setting = os.environ.get("KNOWLEDGE_OCR_ENABLED", "false").strip().lower()
    if setting not in {"true", "false"}:
        raise RuntimeError("KNOWLEDGE_OCR_ENABLED must be true or false")
    enabled = setting == "true"
    executable = shutil.which("tesseract") if enabled else None
    if enabled:
        if not executable:
            raise RuntimeError("OCR requires Tesseract with ara and eng data")
        try:
            check = subprocess.run(
                [executable, "--list-langs"],
                capture_output=True,
                timeout=5,
                check=True,
                shell=False,
                env=_tesseract_env(),
            )
            languages = set(check.stdout.decode("utf-8", errors="replace").splitlines())
            if not {"ara", "eng"}.issubset(languages):
                raise RuntimeError("OCR requires Tesseract with ara and eng data")
        except (OSError, subprocess.SubprocessError) as exc:
            raise RuntimeError("Cannot verify the OCR installation") from exc
    app.state.secret_digest = hashlib.sha256(secret.encode("utf-8")).digest()
    app.state.ocr_enabled = enabled
    app.state.tesseract = executable
    try:
        yield
    finally:
        app.state.secret_digest = None


class UploadGuard:
    def __init__(self, app: Any, owner: FastAPI):
        self.app = app
        self.owner = owner
        self.busy = threading.Lock()

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] != "http" or scope["path"].rstrip("/") != "/extract":
            await self.app(scope, receive, send)
            return
        expected = getattr(self.owner.state, "secret_digest", None)
        if expected is None:
            await JSONResponse({"detail": "Worker not configured"}, status_code=503)(
                scope, receive, send
            )
            return
        values = [v for k, v in scope["headers"] if k.lower() == b"x-worker-secret"]
        candidate = values[0] if len(values) == 1 else b""
        authenticated = hmac.compare_digest(hashlib.sha256(candidate).digest(), expected)
        if not authenticated or len(values) != 1:
            await JSONResponse({"detail": "Unauthorized"}, status_code=401)(scope, receive, send)
            return
        if not self.busy.acquire(blocking=False):
            await JSONResponse(
                {"detail": "Worker busy"}, status_code=429, headers={"Retry-After": "2"}
            )(scope, receive, send)
            return
        try:
            headers = [v for k, v in scope["headers"] if k.lower() == b"content-length"]
            if headers:
                try:
                    length = int(headers[0])
                    if len(headers) != 1 or length < 0:
                        raise ValueError
                except ValueError:
                    await JSONResponse({"detail": "Invalid content length"}, status_code=400)(
                        scope, receive, send
                    )
                    return
                if length > MAX_BODY_BYTES:
                    await JSONResponse({"detail": "Upload too large"}, status_code=413)(
                        scope, receive, send
                    )
                    return
            with tempfile.SpooledTemporaryFile(max_size=1024 * 1024, mode="w+b") as body:
                size = 0
                try:
                    async with asyncio.timeout(UPLOAD_TIMEOUT):
                        while True:
                            event = await receive()
                            if event["type"] == "http.disconnect":
                                return
                            if event["type"] != "http.request":
                                continue
                            chunk = event.get("body", b"")
                            size += len(chunk)
                            if size > MAX_BODY_BYTES:
                                await JSONResponse({"detail": "Upload too large"}, status_code=413)(
                                    scope, receive, send
                                )
                                return
                            body.write(chunk)
                            if not event.get("more_body", False):
                                break
                except TimeoutError:
                    await JSONResponse({"detail": "Upload timed out"}, status_code=408)(
                        scope, receive, send
                    )
                    return
                body.seek(0)
                replayed = 0

                async def bounded_receive() -> dict:
                    nonlocal replayed
                    if replayed < size:
                        data = body.read(64 * 1024)
                        replayed += len(data)
                        return {"type": "http.request", "body": data, "more_body": replayed < size}
                    if size == 0 and replayed == 0:
                        replayed = 1
                        return {"type": "http.request", "body": b"", "more_body": False}
                    return await receive()

                await self.app(scope, bounded_receive, send)
        finally:
            self.busy.release()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(UploadGuard, owner=app)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


def _linux_limits() -> None:
    import resource

    os.setsid()  # Parent can kill the worker and Tesseract as one process group.
    resource.setrlimit(resource.RLIMIT_AS, (PROCESS_MEMORY_BYTES, PROCESS_MEMORY_BYTES))
    resource.setrlimit(resource.RLIMIT_CPU, (int(EXTRACTION_TIMEOUT), int(EXTRACTION_TIMEOUT) + 1))
    resource.setrlimit(resource.RLIMIT_FSIZE, (32 * 1024 * 1024, 32 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    limit = min(64, hard) if hard != resource.RLIM_INFINITY else 64
    soft_limit = limit if soft == resource.RLIM_INFINITY else min(soft, limit)
    resource.setrlimit(resource.RLIMIT_NOFILE, (soft_limit, limit))
    if hasattr(os, "sched_getaffinity"):
        os.sched_setaffinity(0, {min(os.sched_getaffinity(0))})


class _WindowsJob:
    # Isolate the child before GO so Tesseract inherits its kill-on-close job.

    def __init__(self) -> None:
        import ctypes
        from ctypes import wintypes

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in (
                "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                "ReadTransferCount", "WriteTransferCount", "OtherTransferCount",
            )]

        class BASIC_LIMITS(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class EXTENDED_LIMITS(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", BASIC_LIMITS),
                ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        class CPU_LIMIT(ctypes.Structure):
            _fields_ = [("ControlFlags", wintypes.DWORD), ("CpuRate", wintypes.DWORD)]

        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        signatures = {
            "CreateJobObjectW": ([ctypes.c_void_p, wintypes.LPCWSTR], wintypes.HANDLE),
            "SetInformationJobObject": ([wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD], wintypes.BOOL),
            "OpenProcess": ([wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE),
            "AssignProcessToJobObject": ([wintypes.HANDLE, wintypes.HANDLE], wintypes.BOOL),
            "TerminateJobObject": ([wintypes.HANDLE, wintypes.UINT], wintypes.BOOL),
            "CloseHandle": ([wintypes.HANDLE], wintypes.BOOL),
        }
        for name, (args, result) in signatures.items():
            function = getattr(self.kernel, name)
            function.argtypes = args
            function.restype = result
        self.handle = self.kernel.CreateJobObjectW(None, None)
        if not self.handle:
            raise OSError("Cannot create worker job")
        try:
            limits = EXTENDED_LIMITS()
            # JOB_TIME | ACTIVE_PROCESS | PROCESS_MEMORY | JOB_MEMORY |
            # DIE_ON_UNHANDLED_EXCEPTION | KILL_ON_JOB_CLOSE.
            limits.BasicLimitInformation.LimitFlags = 0x4 | 0x8 | 0x100 | 0x200 | 0x400 | 0x2000
            limits.BasicLimitInformation.PerJobUserTimeLimit = int(EXTRACTION_TIMEOUT * 10_000_000)
            limits.BasicLimitInformation.ActiveProcessLimit = 2
            limits.ProcessMemoryLimit = PROCESS_MEMORY_BYTES
            limits.JobMemoryLimit = JOB_MEMORY_BYTES
            if not self.kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
                raise OSError("Cannot set worker memory/CPU limits")
            cpu = CPU_LIMIT(0x1 | 0x4, max(1, 10000 // (os.cpu_count() or 1)))
            if not self.kernel.SetInformationJobObject(self.handle, 15, ctypes.byref(cpu), ctypes.sizeof(cpu)):
                raise OSError("Cannot cap worker CPU rate")
        except BaseException:
            self.close()
            raise

    def assign(self, pid: int) -> None:
        handle = self.kernel.OpenProcess(0x0100 | 0x0001, False, pid)
        if not handle:
            raise OSError("Cannot open worker process")
        try:
            if not self.kernel.AssignProcessToJobObject(self.handle, handle):
                raise OSError("Cannot isolate worker process")
        finally:
            self.kernel.CloseHandle(handle)

    def close(self) -> None:
        if self.handle:
            self.kernel.TerminateJobObject(self.handle, 1)
            self.kernel.CloseHandle(self.handle)
            self.handle = None


def _send(pipe: Connection, event: dict) -> None:
    payload = json.dumps(event, ensure_ascii=True, separators=(",", ":")).encode("ascii")
    if len(payload) > MAX_MESSAGE_BYTES:
        raise ValueError("Worker protocol frame too large")
    pipe.send_bytes(payload)


def _json_page_size(number: int, text: str) -> int:
    return len(json.dumps(
        {"pageNumber": number, "text": text}, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")) + 1


def _fit_text(number: int, text: str, budget: int, already_truncated: bool = False) -> tuple[str, bool, int]:
    text = text.replace("\x00", "").strip()
    truncated = already_truncated or len(text) > MAX_PAGE_TEXT
    text = text[:MAX_PAGE_TEXT]
    if _json_page_size(number, text) > budget:
        lo, hi = 0, len(text)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if _json_page_size(number, text[:mid]) <= budget:
                lo = mid
            else:
                hi = mid - 1
        text = text[:lo]
        truncated = True
    used = _json_page_size(number, text) if text else 0
    return text, truncated, max(0, budget - used)


def _emit_page(pipe: Connection, number: int, text: str, needs_ocr: bool, truncated: bool) -> None:
    for start in range(0, len(text), CHUNK_CHARS):
        _send(pipe, {"type": "text", "pageNumber": number, "text": text[start:start + CHUNK_CHARS]})
    _send(pipe, {
        "type": "page_done", "pageNumber": number,
        "requiresOcr": needs_ocr, "truncated": truncated,
    })


def _extract_job(pipe: Connection, pdf_path: str, directory: str, ocr: bool, tesseract: str | None, start_page: int | None, end_page: int | None) -> None:
    """No threads/queues: bounded progress frames are drained before joining."""
    started = time.monotonic()
    try:
        if os.name == "posix":
            _linux_limits()
        elif os.name != "nt":
            raise OSError("Unsupported isolation platform")
        _send(pipe, {"type": "ready"})
        if not pipe.poll(10) or pipe.recv_bytes(MAX_MESSAGE_BYTES) != b"go":
            return
        import pymupdf as fitz

        fitz.TOOLS.mupdf_display_errors(False)
        fitz.TOOLS.mupdf_display_warnings(False)
        try:
            doc = fitz.open(pdf_path)
            if not doc.is_pdf or doc.needs_pass or doc.is_encrypted or doc.metadata.get("encryption"):
                doc.close()
                _send(pipe, {"type": "error", "status": 400, "detail": "Invalid or encrypted PDF"})
                return
            count = doc.page_count
            if count < 1:
                doc.close()
                _send(pipe, {"type": "error", "status": 400, "detail": "PDF has no pages"})
                return
            if count > MAX_PAGES:
                doc.close()
                _send(pipe, {"type": "error", "status": 413, "detail": "PDF exceeds 500 pages"})
                return
            start = start_page or 1
            end = min(end_page or count, count)
            if start < 1 or start > count or end < start:
                doc.close()
                _send(pipe, {"type": "error", "status": 400, "detail": "Invalid page range"})
                return
        except Exception:
            _send(pipe, {"type": "error", "status": 400, "detail": "Invalid or encrypted PDF"})
            return
        _send(pipe, {"type": "opened", "pageCount": count, "startPage": start, "endPage": end})
        budget = TEXT_BUDGET
        pending = []
        with doc:
            # Native pass completes before any expensive OCR: preserve later native
            # pages even when an early scanned page times out during Tesseract.
            for index in range(start - 1, end):
                if time.monotonic() - started >= EXTRACTION_TIMEOUT:
                    break
                number = index + 1
                _send(pipe, {"type": "page_started", "pageNumber": number, "phase": "native"})
                try:
                    text = doc.load_page(index).get_text("text", sort=True).replace("\x00", "").strip()
                except Exception:
                    text = ""
                if text:
                    text, truncated, budget = _fit_text(number, text, budget)
                    _emit_page(pipe, number, text, False, truncated)
                else:
                    pending.append(index)
                    _emit_page(pipe, number, "", True, False)
            if ocr and tesseract:
                for index in pending:
                    remaining = EXTRACTION_TIMEOUT - (time.monotonic() - started)
                    if remaining <= 0 or budget <= _json_page_size(index + 1, ""):
                        break
                    number = index + 1
                    _send(pipe, {"type": "page_started", "pageNumber": number, "phase": "ocr"})
                    page_started = time.monotonic()
                    image = Path(directory) / f"page-{number}.png"
                    output = Path(directory) / f"page-{number}"
                    text_file = output.with_suffix(".txt")
                    text = ""
                    truncated = False
                    try:
                        page = doc.load_page(index)
                        width = math.ceil(page.rect.width * DPI / 72)
                        height = math.ceil(page.rect.height * DPI / 72)
                        if width <= 0 or height <= 0 or width * height > MAX_RENDER_PIXELS:
                            raise ValueError("Raster exceeds pixel limit")
                        pixmap = page.get_pixmap(matrix=fitz.Matrix(DPI / 72, DPI / 72), colorspace=fitz.csGRAY, alpha=False)
                        pixmap.save(str(image))
                        del pixmap
                        timeout = min(
                            PAGE_TIMEOUT - (time.monotonic() - page_started),
                            EXTRACTION_TIMEOUT - (time.monotonic() - started),
                        )
                        if timeout <= 0:
                            raise TimeoutError
                        subprocess.run(
                            [tesseract, str(image), str(output), "-l", "ara+eng", "--dpi", str(DPI), "--psm", "3"],
                            stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL,
                            timeout=timeout,
                            check=True,
                            shell=False,
                            close_fds=True,
                            env=_tesseract_env(),
                        )
                        with text_file.open("rb") as stream:
                            raw = stream.read(MAX_PAGE_TEXT * 4 + 1)
                        truncated = len(raw) > MAX_PAGE_TEXT * 4
                        text = raw[:MAX_PAGE_TEXT * 4].decode("utf-8", errors="replace").replace("\x00", "").strip()
                    except Exception:
                        text = ""
                    finally:
                        image.unlink(missing_ok=True)
                        text_file.unlink(missing_ok=True)
                    recognized = bool(text)
                    text, truncated, budget = _fit_text(number, text, budget, truncated)
                    _emit_page(pipe, number, text, not recognized, truncated)
        _send(pipe, {"type": "done"})
    except (BrokenPipeError, EOFError):
        pass  # Client cancelled or parent enforced a deadline.
    except Exception:
        try:
            _send(pipe, {"type": "error", "status": 503, "detail": "Extraction job unavailable"})
        except (OSError, EOFError):
            pass
    finally:
        pipe.close()


class _Progress:
    def __init__(self) -> None:
        self.count: int | None = None
        self.start = 1
        self.end = 0
        self.pages: dict[int, str] = {}
        self.failed: set[int] = set()
        self.needs_ocr: set[int] = set()
        self.number: int | None = None
        self.phase: str | None = None
        self.page_started: float | None = None
        self.parts: list[str] = []
        self.chars = 0
        self.used = 0

    def flush_partial(self) -> None:
        if self.number is not None and self.parts:
            text = "".join(self.parts)
            text, _, _ = _fit_text(self.number, text, TEXT_BUDGET - self.used, True)
            if text:
                self.pages[self.number] = text
                self.used += _json_page_size(self.number, text)
                self.needs_ocr.discard(self.number)
        self.parts = []
        self.chars = 0

    def accept(self, event: dict, now: float) -> None:
        kind = event["type"]
        if kind == "opened":
            count = event["pageCount"]
            start = event.get("startPage", 1)
            end = event.get("endPage", count)
            if (
                not isinstance(count, int) or not 1 <= count <= MAX_PAGES
                or not isinstance(start, int) or not isinstance(end, int)
                or not 1 <= start <= end <= count or self.count is not None
            ):
                raise ValueError("Invalid worker page range")
            self.count, self.start, self.end = count, start, end
            self.failed = set(range(start, end + 1))
            return
        number = event.get("pageNumber")
        if self.count is None or not isinstance(number, int) or not self.start <= number <= self.end:
            raise ValueError("Invalid worker page number")
        if kind == "page_started":
            if self.number is not None or event.get("phase") not in {"native", "ocr"}:
                raise ValueError("Invalid worker page transition")
            self.number, self.phase, self.page_started = number, event["phase"], now
            self.parts, self.chars = [], 0
        elif kind == "text":
            text = event.get("text")
            if number != self.number or not isinstance(text, str) or len(text) > CHUNK_CHARS:
                raise ValueError("Invalid worker text frame")
            self.chars += len(text)
            if self.chars > MAX_PAGE_TEXT:
                raise ValueError("Worker page text limit exceeded")
            self.parts.append(text)
        elif kind == "page_done":
            if number != self.number:
                raise ValueError("Invalid worker completion")
            text = "".join(self.parts)
            text, capped, _ = _fit_text(number, text, TEXT_BUDGET - self.used)
            if text:
                self.pages[number] = text
                self.used += _json_page_size(number, text)
            if event["requiresOcr"]:
                self.needs_ocr.add(number)
            else:
                self.needs_ocr.discard(number)
            if text and not event["truncated"] and not capped:
                self.failed.discard(number)
            self.number, self.phase, self.page_started = None, None, None
            self.parts, self.chars = [], 0
        else:
            raise ValueError("Invalid worker protocol event")

    def response(self) -> JSONResponse:
        self.flush_partial()
        if self.count is None:
            raise HTTPException(504, "Extraction interrupted before PDF validation completed")
        payload = {
            "pages": [{"pageNumber": number, "text": text} for number, text in sorted(self.pages.items())],
            "failedPages": sorted(self.failed),
            "requiresOcr": bool(self.needs_ocr),
            "pageCount": self.count,
        }
        response = JSONResponse(payload)
        if len(response.body) > MAX_OUTPUT_BYTES:
            raise HTTPException(503, "Extraction output limit exceeded")
        return response


async def _disconnect(request: Request) -> None:
    while True:
        event = await request.receive()
        if event["type"] == "http.disconnect":
            return


async def _run_job(request: Request, path: Path, directory: str, start_page: int | None, end_page: int | None) -> JSONResponse:
    context = mp.get_context("spawn")
    parent, child = context.Pipe(duplex=True)
    process = context.Process(
        target=_extract_job,
        args=(child, str(path), directory, request.app.state.ocr_enabled, request.app.state.tesseract, start_page, end_page),
        daemon=False,
    )
    progress = _Progress()
    windows_job = None
    spawned = False
    isolated_group = False
    disconnect = None
    deadline = time.monotonic() + EXTRACTION_TIMEOUT
    try:
        if os.name == "nt":
            windows_job = _WindowsJob()
        process.start()
        spawned = True
        child.close()  # Essential: EOF is observable if the child crashes mid-job.
        if windows_job:
            windows_job.assign(process.pid)
        disconnect = asyncio.create_task(_disconnect(request))
        done = False
        while not done:
            now = time.monotonic()
            if disconnect.done():
                raise HTTPException(499, "Client disconnected")
            if now >= deadline or (
                progress.page_started is not None and now - progress.page_started >= PAGE_TIMEOUT
            ):
                break
            # Drain before join, with small frames and bounded work per event-loop
            # turn. No blocked queue feeder, unkillable OCR thread, or giant recv.
            for _ in range(128):
                if not parent.poll():
                    break
                try:
                    event = json.loads(parent.recv_bytes(MAX_MESSAGE_BYTES))
                except (EOFError, OSError):
                    done = True
                    break
                kind = event.get("type")
                if kind == "ready":
                    isolated_group = os.name == "posix"
                    parent.send_bytes(b"go")
                elif kind == "error":
                    if event.get("status") == 503 and progress.count is not None:
                        done = True
                        break
                    status = event.get("status")
                    if status not in {400, 413, 503}:
                        raise ValueError("Invalid worker error")
                    raise HTTPException(status, event["detail"])
                elif kind == "done":
                    done = True
                    break
                else:
                    progress.accept(event, time.monotonic())
                if time.monotonic() >= deadline:
                    break
            if not process.is_alive() and not parent.poll():
                break
            if not done:
                await asyncio.sleep(0.02)
        return progress.response()
    except HTTPException:
        raise
    except (OSError, ValueError, RuntimeError) as exc:
        raise HTTPException(503, "Extraction isolation unavailable") from exc
    finally:
        if disconnect:
            disconnect.cancel()
            try:
                await disconnect
            except (asyncio.CancelledError, Exception):
                pass  # A broken receive must not skip process-tree cleanup.
        # Kill descendants *before* removing parent-owned temporary files. This
        # also runs on cancellation, crashes and every deadline/validation error.
        if windows_job:
            windows_job.close()
        if spawned:
            if isolated_group:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if process.is_alive():
                process.kill()
            process.join(timeout=3)
            if not process.is_alive():
                process.close()
        parent.close()
        child.close()


def _page_field(fields: list[tuple[str, Any]], name: str) -> int | None:
    values = [value for field, value in fields if field == name]
    if not values:
        return None
    if len(values) != 1 or not isinstance(values[0], str) or not values[0].isascii() or not values[0].isdigit():
        raise HTTPException(400, f"Invalid {name}")
    number = int(values[0])
    if not 1 <= number <= MAX_PAGES:
        raise HTTPException(400, f"Invalid {name}")
    return number


@app.post("/extract")
async def extract(request: Request) -> JSONResponse:
    if request.query_params:
        raise HTTPException(400, "Only a multipart PDF file is accepted; no query parameters")
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != "multipart/form-data":
        raise HTTPException(415, "Expected multipart/form-data with one PDF file")
    try:
        async with request.form(max_files=1, max_fields=2, max_part_size=MAX_UPLOAD_BYTES) as form:
            fields = list(form.multi_items())
            if any(field not in {"file", "startPage", "endPage"} for field, _ in fields):
                raise HTTPException(400, "Unknown multipart field")
            uploads = [value for field, value in fields if field == "file"]
            if len(uploads) != 1 or not isinstance(uploads[0], UploadFile):
                raise HTTPException(400, "Supply exactly one multipart file named file")
            start_page = _page_field(fields, "startPage")
            end_page = _page_field(fields, "endPage")
            if start_page is not None and end_page is not None and end_page < start_page:
                raise HTTPException(400, "Invalid page range")
            upload = uploads[0]
            mime = (upload.content_type or "").split(";", 1)[0].strip().lower()
            if mime != "application/pdf":
                raise HTTPException(415, "File MIME type must be application/pdf")
            with tempfile.TemporaryDirectory(prefix="knowledge-ocr-") as directory:
                path = Path(directory) / "input.pdf"  # Ignore user filenames completely.
                size = 0
                with path.open("wb") as output:
                    while chunk := await upload.read(64 * 1024):
                        if size == 0 and not chunk.startswith(b"%PDF-"):
                            raise HTTPException(400, "Invalid PDF signature")
                        size += len(chunk)
                        if size > MAX_UPLOAD_BYTES:
                            raise HTTPException(413, "PDF exceeds 20 MiB")
                        output.write(chunk)
                if size == 0:
                    raise HTTPException(400, "Empty PDF upload")
                return await _run_job(request, path, directory, start_page, end_page)
    except HTTPException:
        raise
    except StarletteHTTPException as exc:
        raise HTTPException(400, "Invalid multipart upload") from exc
    except (OSError, ValueError) as exc:
        raise HTTPException(400, "Invalid multipart upload") from exc
