import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const loopbackUrl = (value, name) => {
  const url = new URL(value);
  assert.ok(["http:", "https:"].includes(url.protocol), `${name} requires HTTP(S).`);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), `${name} must be loopback, never production.`);
  assert.ok(!url.username && !url.password && !url.search && !url.hash && url.pathname === "/", `${name} must be a bare local API origin.`);
  return url.origin;
};
const api = loopbackUrl(process.env.TEST_API_URL || "http://127.0.0.1:5089", "TEST_API_URL");
const failureApi = process.env.TEST_FAILURE_API_URL
  ? loopbackUrl(process.env.TEST_FAILURE_API_URL, "TEST_FAILURE_API_URL")
  : null;
const auth = {
  "X-App-Username": process.env.TEST_APP_USERNAME || "admin",
  "X-App-Password": process.env.TEST_APP_PASSWORD || "chat-preview-only",
};
const request = async (route, options = {}, base = api) => {
  const target = new URL(route, base);
  assert.ok(target.origin === base && ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "Every request must remain on the selected loopback API.");
  const response = await fetch(target, {
    ...options,
    redirect: "error", // Never follow a local redirect to production.
    signal: AbortSignal.timeout(route === "/api/chat/ask" ? 100000 : 15000),
  });
  const body = await response.json().catch((error) => {
    if (error instanceof SyntaxError) return null;
    throw error;
  });
  return { status: response.status, body, headers: response.headers };
};
const mint = async (base = api) => {
  const result = await request("/api/chat/session", { method: "POST" }, base);
  assert.equal(result.status, 200, "Session minting must succeed.");
  assert.ok(typeof result.body?.sessionToken === "string" && result.body.sessionToken.length > 0 && result.body.sessionToken.length <= 160, "Expected a session token.");
  return result.body.sessionToken; // Never print or include tokens in assertions.
};
const ask = (session, payload, base = api) => request("/api/chat/ask", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Chat-Session": session },
  body: JSON.stringify(payload),
}, base);
const question = "ما معنى الإبصالتس؟";
const absent = "المعلومة غير موجودة في المصادر المتاحة حاليًا.";
const title = "كنيستي الأرثوذكسية... ما أجملك";
const normalize = (text) => text.normalize("NFKC").replace(/\s+/gu, " ").trim();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bookPath = process.env.TEST_BOOK_PATH || path.join(root, "output", "كنيستي-الأرثوذكسية-ما-أجملك-ocr.txt");
const pageParts = fs.readFileSync(bookPath, "utf8").split(/=====\s*صفحة\s+(\d+)\s*=====/);
const pages = new Map();
for (let i = 1; i < pageParts.length; i += 2) pages.set(Number(pageParts[i]), pageParts[i + 1]);
assert.ok(pages.size > 0, "The original book must contain numbered pages.");

const getSources = async (base = api) => {
  const result = await request("/api/knowledge/sources", { headers: auth }, base);
  assert.equal(result.status, 200, "Admin source listing must succeed.");
  assert.ok(Array.isArray(result.body), "Expected a source list.");
  return result.body;
};
const selectBook = (sources) => {
  const matches = sources.filter((source) => source.title === title);
  assert.equal(matches.length, 1, "Expected exactly one source with the actual book title.");
  const book = matches[0];
  assert.equal(book.isActive, true, "The book must initially be active.");
  assert.equal(book.status, "ready", "The actual book must already be ready.");
  assert.ok(book.chunkCount > 0 && book.pageCount > 0, "The ready book must have indexed content.");
  assert.ok(sources.every((source) => source.sourceId === book.sourceId || source.isActive === false), "Other active sources exist; stop before toggling anything.");
  return book;
};
const metadata = (source, isActive = source.isActive) => ({
  title: source.title,
  category: source.category,
  author: source.author,
  permissionNote: source.permissionNote,
  isActive,
});
const snapshot = (sources) => sources.map((source) => ({ sourceId: source.sourceId, ...metadata(source) }))
  .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
const assertAbsent = (result) => {
  assert.equal(result.status, 200);
  assert.equal(result.body?.answer, absent);
  assert.deepEqual(result.body?.sources, []);
};
const assertEvidence = (result) => {
  assert.equal(result.status, 200, "The known book question must succeed.");
  assert.equal(typeof result.body?.answer, "string");
  assert.notEqual(result.body.answer, absent);
  assert.ok(Array.isArray(result.body.sources) && result.body.sources.length > 0, "Expected source evidence, not abstention.");
  for (const source of result.body.sources) {
    assert.equal(source.title, title);
    assert.ok(Number.isInteger(source.page) && pages.has(source.page), "Citation must identify an original book page.");
    assert.ok(typeof source.snippet === "string" && source.snippet.length >= 15 && source.snippet.length <= 1000, "Citation must contain a bounded quotation.");
    assert.ok(normalize(pages.get(source.page)).includes(normalize(source.snippet)), "Citation must be verbatim evidence from the original page.");
    assert.ok(result.body.answer.includes(source.snippet), "The answer must include its evidence.");
  }
};

assert.equal((await request("/health")).status, 200);
const health = await request("/api/chat/health");
assert.equal(health.status, 200);
assert.equal(health.body?.providerConfigured, true, "A real local provider must be configured.");
const sources = await getSources();
const selected = selectBook(sources);
const originalResponse = await request(`/api/knowledge/sources/${selected.sourceId}`, { headers: auth });
assert.equal(originalResponse.status, 200);
assert.deepEqual(originalResponse.body, selected, "Read the original book metadata before any update.");
const original = originalResponse.body;
const originalMetadata = metadata(original);
const originalSnapshot = snapshot(sources);
const sourceRoute = `/api/knowledge/sources/${original.sourceId}`;

// Use a nonexistent ID for unauthorized destructive probes so an auth regression
// cannot delete, re-ingest, or modify the real book (or any other existing source).
const probeId = "00000000-0000-0000-0000-000000000000";
assert.ok(sources.every((source) => source.sourceId !== probeId));
for (const [method, route, payload] of [
  ["GET", "/api/knowledge/sources"],
  ["GET", sourceRoute],
  ["POST", "/api/knowledge/sources", {}],
  ["PUT", `/api/knowledge/sources/${probeId}`, { ...originalMetadata, isActive: false }],
  ["DELETE", `/api/knowledge/sources/${probeId}`],
  ["POST", `/api/knowledge/sources/${probeId}/ingest`],
  ["GET", `/api/knowledge/chunks/${original.sourceId}`],
]) {
  const options = { method };
  if (payload !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(payload);
  }
  assert.equal((await request(route, options)).status, 401, `Unauthenticated ${method} ${route} must be denied.`);
}

const session = await mint();
for (const token of ["", "invalid", "x".repeat(161)]) {
  const denied = await ask(token, { question });
  assert.equal(denied.status, 401);
  assert.equal(denied.body?.code, "session_required");
}
for (const invalidQuestion of [null, "", "س", "سس", "   ", "<script>alert(1)</script>", "س<س", "س>س", "س\u0000س", "س".repeat(1001)]) {
  const invalid = await ask(session, { question: invalidQuestion });
  assert.equal(invalid.status, 400, "Invalid HTML, control characters, or question length must be rejected.");
  assert.equal(invalid.body?.code, "invalid_question");
}
const malformed = await ask(session, { question, conversationId: "not-a-guid" });
assert.equal(malformed.status, 400);
assert.equal(malformed.body?.code, "invalid_conversation");
assert.equal((await ask(session, { question, conversationId: {} })).status, 400);

const warm = await ask(session, { question });
assertEvidence(warm);
const cached = await ask(session, { question, conversationId: warm.body.conversationId });
assertEvidence(cached);
assert.equal(cached.body.conversationId, warm.body.conversationId);
assert.equal(cached.body.answer, warm.body.answer);
assert.deepEqual(cached.body.sources, warm.body.sources);

const beforeToggle = await getSources();
selectBook(beforeToggle); // Fail before any PUT if another source has become active.
assert.deepEqual(snapshot(beforeToggle), originalSnapshot, "Source metadata must not change before the toggle.");
const updateBook = (isActive) => request(sourceRoute, {
  method: "PUT",
  headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({ ...originalMetadata, isActive }),
});
try {
  const disabled = await updateBook(false);
  assert.equal(disabled.status, 200);
  assert.deepEqual(metadata(disabled.body), { ...originalMetadata, isActive: false });
  assertAbsent(await ask(session, { question })); // Previously cached evidence must disappear.
  // Valid inclusive length boundaries are checked while no source is active.
  for (const boundary of ["رتب", question.padEnd(1000, " ")]) {
    assertAbsent(await ask(session, { question: boundary }));
  }
} finally {
  // Attempt restoration even when the disabling request times out or an assertion fails.
  const restored = await updateBook(true);
  assert.equal(restored.status, 200, "Always restore the original active book.");
  assert.deepEqual(metadata(restored.body), originalMetadata, "Restore all original writable metadata.");
}
assert.deepEqual(snapshot(await getSources()), originalSnapshot, "Other sources must remain inactive and unmodified.");
const restoredAnswer = await ask(session, { question });
assertEvidence(restoredAnswer); // Cached abstention must disappear after restoration.

const limitedSession = await mint();
assert.ok(limitedSession !== session, "Rate-limit checks require their own freshly minted session.");
for (let i = 1; i <= 12; i++) {
  const success = await ask(limitedSession, { question });
  assert.equal(success.status, 200, `Cached ask ${i}/12 must succeed; use API runtime CHAT_IP_HOURLY_LIMIT=100.`);
  assertEvidence(success);
  assert.equal(success.body.answer, restoredAnswer.body.answer);
  assert.deepEqual(success.body.sources, restoredAnswer.body.sources);
}
const limited = await ask(limitedSession, { question });
assert.equal(limited.status, 429, "The 13th cached ask must exhaust the default session hourly limit of 12.");
assert.equal(limited.body?.code, "chat_rate_limit");
assert.equal(limited.headers.get("Retry-After"), "60");

if (failureApi) {
  const failureHealth = await request("/api/chat/health", {}, failureApi);
  assert.equal(failureHealth.status, 200);
  assert.equal(failureHealth.body?.providerConfigured, true, "Failure API must have a real key, not a missing provider.");
  assert.equal(failureHealth.body?.embeddingProfile, health.body.embeddingProfile);
  const failureBook = selectBook(await getSources(failureApi));
  assert.equal(failureBook.sourceId, original.sourceId, "Failure API must use the same ready book/database.");
  const failureSession = await mint(failureApi);
  const failed = await ask(failureSession, { question }, failureApi);
  assert.equal(failed.status, 503, "Invalid chat model must produce a provider failure, not abstention.");
  assert.match(failed.body?.code || "", /^provider_http_(?:400|404)$/, "Expected an upstream invalid-model error, not missing credentials, storage failure, or a timeout.");
  assert.notEqual(failed.body?.answer, absent);
  assert.notEqual(failed.body?.message, absent);
  assert.equal(failed.body?.sources, undefined);
}
console.log(`PASS chat security: admin/session isolation, validation, book evidence, reversible cache invalidation, 12/13 session limit${failureApi ? ", provider failure" : " (provider-failure check skipped)"}.`);
