import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const api = process.env.TEST_API_URL || "http://127.0.0.1:5089";
const url = new URL(api);
assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "Integration tests require a local API, never production.");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const book = process.env.TEST_BOOK_PATH || path.join(root, "output", "كنيستي-الأرثوذكسية-ما-أجملك-ocr.txt");
const original = fs.readFileSync(book, "utf8");
const pageParts = original.split(/=====\s*صفحة\s+(\d+)\s*=====/);
const pages = new Map();
for (let i = 1; i < pageParts.length; i += 2) pages.set(Number(pageParts[i]), pageParts[i + 1]);
const normalize = (text) => text.normalize("NFKC").replace(/\s+/gu, " ").trim();
const arabic = (text) => normalize(text).replace(/[\u064b-\u065f\u0670]/g, "").replace(/[إأآ]/g, "ا").replace(/ى/g, "ي");
const auth = { "X-App-Username": process.env.TEST_APP_USERNAME || "admin", "X-App-Password": process.env.TEST_APP_PASSWORD || "chat-preview-only" };
const request = async (route, options = {}) => {
  const response = await fetch(`${api}${route}`, { ...options, redirect: "error", signal: AbortSignal.timeout(100000) });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};
assert.equal((await request("/health")).status, 200);
assert.equal((await request("/api/chat/health")).status, 200);
assert.equal((await request("/api/knowledge/sources")).status, 401);
const sources = await request("/api/knowledge/sources", { headers: auth });
assert.equal(sources.status, 200);
assert.ok(sources.body.some((source) => source.status === "ready" && source.chunkCount > 0), "The actual book must be ingested before running these checks.");
const session = await request("/api/chat/session", { method: "POST" });
assert.equal(session.status, 200);
const headers = { "Content-Type": "application/json", "X-Chat-Session": session.body.sessionToken };
const ask = (question) => request("/api/chat/ask", { method: "POST", headers, body: JSON.stringify({ question }) });
for (const question of ["", "<script>alert(1)</script>", "س".repeat(1001)]) assert.equal((await ask(question)).status, 400);
assert.equal((await request("/api/chat/ask", { method: "POST", headers: { "Content-Type": "application/json", "X-Chat-Session": "invalid" }, body: JSON.stringify({ question: "ما معنى الإبصالتس؟" }) })).status, 401);

const cases = [
  ["ما هي رتب الشمامسة؟", [/ابصالتس/, /اناغنوستيس|اغنسطس/, /ايبوذياكون/, /ذياكون/, /ارشي ذياكون/]],
  ["ما معنى الإبصالتس؟", [/مرتل|منشد/]],
  ["ما الزيوت المستخدمة في المعمودية؟", [/ميرون/, /غاليلاون/, /ابو\s*غالمسيس|ابو\s*غلمسيس/]],
  ["ما وظيفة الإيبوذياكون؟", [/مساعد شماس|تنظيم الجلوس|حراسة|ايقاد|تجفيف/]],
];
for (const [question, expected] of cases) {
  const result = await ask(question);
  assert.equal(result.status, 200, `${question}: ${JSON.stringify(result.body)}`);
  assert.ok(result.body.sources.length > 0, `Expected source evidence for ${question}`);
  for (const source of result.body.sources) {
    assert.ok(pages.has(source.page), `Missing original page ${source.page}`);
    assert.ok(normalize(pages.get(source.page)).includes(normalize(source.snippet)), `Quote not in original page ${source.page}`);
    assert.ok(result.body.answer.includes(source.snippet));
  }
  for (const pattern of expected) assert.match(arabic(result.body.answer), pattern, question);
  console.log(JSON.stringify({ question, status: result.status, sources: result.body.sources, confidence: result.body.confidence }));
}
const absent = await ask("كم عدد أقمار كوكب المشتري في عام 2026؟");
assert.equal(absent.status, 200);
assert.equal(absent.body.answer, "المعلومة غير موجودة في المصادر المتاحة حاليًا.");
assert.equal(absent.body.sources.length, 0);
console.log("PASS live book ingestion, four real questions, original-page citations, abstention, boundaries and admin isolation.");
