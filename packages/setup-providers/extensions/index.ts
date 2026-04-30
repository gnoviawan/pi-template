/**
 * Setup Custom Providers Extension — Polished Overlay Edition
 *
 * Semua overlay popup (floating modal) di tengah layar.
 *
 * Command: /setup-custom-providers
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, visibleWidth } from "@mariozechner/pi-tui";
import { execSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ═══════════════════════════════════════════════════════════════
//  Config & Types
// ═══════════════════════════════════════════════════════════════

const MODELS_JSON = join(homedir(), ".pi", "agent", "models.json");
const MODELS_JSON_BAK = `${MODELS_JSON}.bak`;

let activePi: ExtensionAPI | undefined;
const dynamicallyRegisteredProviders = new Set<string>();

const API_OPTS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "mistral-conversations",
  "bedrock-converse-stream",
];

interface PModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
}

interface PConfig {
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  models?: PModel[];
}

interface PData {
  providers?: Record<string, PConfig>;
}

interface DiscoveredModel {
  id: string;
  name?: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
}

interface DiscoveryResult {
  endpoint: string;
  models: DiscoveredModel[];
}

interface ProviderHealth {
  discovery?: { ok: boolean; endpoint?: string; message: string; checkedAt: number };
  chat?: { ok: boolean; endpoint?: string; model?: string; message: string; checkedAt: number };
}

const providerHealth = new Map<string, ProviderHealth>();

function healthFor(providerName: string): ProviderHealth {
  const health = providerHealth.get(providerName) ?? {};
  providerHealth.set(providerName, health);
  return health;
}

// ═══════════════════════════════════════════════════════════════
//  Data Helpers
// ═══════════════════════════════════════════════════════════════

function load(): PData {
  try {
    if (!existsSync(MODELS_JSON)) return { providers: {} };
    return JSON.parse(readFileSync(MODELS_JSON, "utf-8")) as PData;
  } catch {
    return { providers: {} };
  }
}

function save(data: PData): void {
  try {
    if (existsSync(MODELS_JSON)) copyFileSync(MODELS_JSON, MODELS_JSON_BAK);
  } catch {
    // Best-effort backup only; do not block saving if backup fails.
  }
  writeFileSync(MODELS_JSON, JSON.stringify(data, null, 2));
}

function registerConfiguredProviders(data: PData): void {
  if (!activePi) return;
  const providers = data.providers ?? {};
  const names = new Set(Object.keys(providers));

  for (const name of dynamicallyRegisteredProviders) {
    if (!names.has(name)) {
      activePi.unregisterProvider(name);
      dynamicallyRegisteredProviders.delete(name);
    }
  }

  for (const [name, cfg] of Object.entries(providers)) {
    activePi.registerProvider(name, cfg as any);
    dynamicallyRegisteredProviders.add(name);
  }
}

function apiFmt(api: string): string {
  const m: Record<string, string> = {
    "openai-completions": "OpenAI Chat Completions",
    "openai-responses": "OpenAI Responses",
    "anthropic-messages": "Anthropic Messages",
    "google-generative-ai": "Google Generative AI",
    "mistral-conversations": "Mistral Conversations",
    "bedrock-converse-stream": "AWS Bedrock Stream",
  };
  return m[api] ?? api;
}

function inferApiFromBaseUrl(baseUrl?: string): string {
  const url = (baseUrl ?? "").toLowerCase();
  if (url.includes("anthropic") || url.includes("claude")) return "anthropic-messages";
  if (url.includes("google") || url.includes("generativelanguage") || url.includes("gemini")) return "google-generative-ai";
  if (url.includes("mistral")) return "mistral-conversations";
  if (url.includes("bedrock") || url.includes("amazonaws")) return "bedrock-converse-stream";
  if (url.includes("/responses")) return "openai-responses";
  return "openai-completions";
}

function cleanSecretInput(raw: string): string {
  let value = raw.trim();
  value = value.replace(/^export\s+/i, "").trim();

  const assignment = value.match(/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*([\s\S]+)$/);
  if (assignment) value = assignment[1]!.trim();

  let quoted = value.match(/^(["'`])([\s\S]*)\1;?$/);
  if (quoted) value = quoted[2]!.trim();

  value = value.replace(/^Authorization\s*:\s*/i, "").trim();
  value = value.replace(/^Bearer\s+/i, "").trim();

  quoted = value.match(/^(["'`])([\s\S]*)\1;?$/);
  if (quoted) value = quoted[2]!.trim();

  return value.replace(/;$/, "").trim();
}

function mFmt(m: PModel): string {
  const icon = m.input?.includes("image") ? "[IMG] " : "";
  const brain = m.reasoning ? "[R] " : "";
  return `${icon}${brain}${m.name ?? m.id}  (ctx ${m.contextWindow ?? "-"})`;
}

function resolveApiKey(apiKey?: string): string | undefined {
  if (!apiKey) return undefined;
  const key = apiKey.trim();
  if (!key) return undefined;

  // pi provider configs may use "!command" API keys, e.g. reading
  // ~/.codex/auth.json. Resolve the same shape for our discovery/chat tests;
  // otherwise the test sends the literal command as Bearer token and gets 401.
  if (key.startsWith("!")) {
    try {
      return execSync(key.slice(1), {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  if (key.startsWith("$")) return process.env[key.slice(1)] ?? key;
  return process.env[key] ?? key;
}

function sanitizeOverlayInputChunk(chunk: string, pendingRef: { value: string }): string {
  const source = pendingRef.value + chunk;
  pendingRef.value = "";

  let out = "";

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    const code = ch.charCodeAt(0);

    // Strip ANSI/terminal escape sequences, including bracketed paste
    // wrappers: ESC[200~ ... ESC[201~. If a sequence is split across
    // handleInput() calls, buffer it until the next chunk arrives.
    if (ch === "\x1b") {
      if (i + 1 >= source.length) {
        pendingRef.value = source.slice(i);
        break;
      }

      const next = source[i + 1]!;

      // CSI: ESC [ ... final-byte
      if (next === "[") {
        let j = i + 2;
        while (j < source.length) {
          const final = source.charCodeAt(j);
          if (final >= 0x40 && final <= 0x7e) break;
          j++;
        }
        if (j >= source.length) {
          pendingRef.value = source.slice(i);
          break;
        }
        i = j;
        continue;
      }

      // OSC: ESC ] ... BEL/ST
      if (next === "]") {
        let j = i + 2;
        let closed = false;
        while (j < source.length) {
          if (source[j] === "\x07") { closed = true; break; }
          if (source[j] === "\x1b" && source[j + 1] === "\\") { j++; closed = true; break; }
          j++;
        }
        if (!closed) {
          pendingRef.value = source.slice(i);
          break;
        }
        i = j;
        continue;
      }

      // DCS/PM/APC: ESC P/^/_ ... ST
      if (next === "P" || next === "^" || next === "_") {
        let j = i + 2;
        let closed = false;
        while (j < source.length) {
          if (source[j] === "\x1b" && source[j + 1] === "\\") { j++; closed = true; break; }
          j++;
        }
        if (!closed) {
          pendingRef.value = source.slice(i);
          break;
        }
        i = j;
        continue;
      }

      // Other 2-byte ESC sequence.
      i++;
      continue;
    }

    // Single-line inputs should not keep control chars from pasted text.
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue;

    out += ch;
  }

  // Extra guard for terminals that leak bracketed-paste markers as text.
  return out
    .replace(/^\[?200~/, "")
    .replace(/\[?201~$/, "");
}

function buildModelEndpointCandidates(baseUrl?: string): string[] {
  if (!baseUrl) return [];
  const trimmed = baseUrl.replace(/\/+$/, "");
  const candidates = new Set<string>();
  if (trimmed.endsWith("/v1")) {
    candidates.add(`${trimmed}/models`);
    candidates.add(trimmed.replace(/\/v1$/, "/models"));
  } else {
    candidates.add(`${trimmed}/v1/models`);
    candidates.add(`${trimmed}/models`);
  }
  return [...candidates];
}

function pickNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = parseInt(value, 10);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return undefined;
}

function pickBoolean(...values: unknown[]): boolean {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const v = value.trim().toLowerCase();
      if (["true", "yes", "1", "enabled", "supported"].includes(v)) return true;
      if (["false", "no", "0", "disabled", "unsupported"].includes(v)) return false;
    }
  }
  return false;
}

function parseDiscoveredModel(raw: Record<string, any>): DiscoveredModel | undefined {
  const id = String(raw.id ?? raw.name ?? "").trim();
  if (!id) return undefined;

  const modalities = [
    ...(Array.isArray(raw.input_modalities) ? raw.input_modalities : []),
    ...(Array.isArray(raw.modalities) ? raw.modalities : []),
    ...(Array.isArray(raw.inputTypes) ? raw.inputTypes : []),
    ...(Array.isArray(raw.input_types) ? raw.input_types : []),
    ...(Array.isArray(raw.capabilities?.input) ? raw.capabilities.input : []),
  ]
    .map((v) => String(v).toLowerCase());

  const supportsImage =
    modalities.some((v) => v.includes("image") || v.includes("vision")) ||
    pickBoolean(
      raw.supports_image,
      raw.supportsImage,
      raw.supports_vision,
      raw.supportsVision,
      raw.vision,
      raw.capabilities?.vision,
      raw.capabilities?.image,
    );

  const reasoning = pickBoolean(
    raw.reasoning,
    raw.supports_reasoning,
    raw.supportsReasoning,
    raw.capabilities?.reasoning,
    raw.features?.reasoning,
  );

  const contextWindow =
    pickNumber(
      raw.context_window,
      raw.contextWindow,
      raw.max_context_window,
      raw.maxContextWindow,
      raw.max_context_length,
      raw.maxContextLength,
      raw.capabilities?.context_window,
      raw.capabilities?.contextWindow,
    ) ?? 128000;

  const maxTokens =
    pickNumber(
      raw.max_output_tokens,
      raw.maxOutputTokens,
      raw.max_completion_tokens,
      raw.maxCompletionTokens,
      raw.max_tokens,
      raw.maxTokens,
      raw.capabilities?.max_output_tokens,
      raw.capabilities?.maxOutputTokens,
    ) ?? 16384;

  return {
    id,
    name: String(raw.name ?? id).trim() || id,
    reasoning,
    input: supportsImage ? ["text", "image"] : ["text"],
    contextWindow,
    maxTokens,
  };
}

async function discoverProviderModels(cfg: PConfig): Promise<DiscoveryResult> {
  const endpoints = buildModelEndpointCandidates(cfg.baseUrl);
  const apiKey = resolveApiKey(cfg.apiKey);
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let lastError = "No endpoints tried";

  for (const url of endpoints) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        lastError = `${res.status} ${res.statusText} @ ${url}`;
        continue;
      }
      const json = (await res.json()) as {
        data?: Array<Record<string, any>>;
        models?: Array<Record<string, any>>;
      };
      const raw = json.data ?? json.models ?? [];
      const models = raw
        .map((m) => parseDiscoveredModel(m))
        .filter((m): m is DiscoveredModel => Boolean(m));
      if (models.length > 0) {
        const unique = new Map<string, DiscoveredModel>();
        for (const model of models) unique.set(model.id, model);
        return { endpoint: url, models: [...unique.values()] };
      }
      lastError = `No models in response @ ${url}`;
    } catch (error) {
      lastError = `${error instanceof Error ? error.message : String(error)} @ ${url}`;
    }
  }

  throw new Error(lastError);
}

function addDiscoveredModel(cfg: PConfig, model: DiscoveredModel): boolean {
  cfg.models ??= [];
  const modelId = model.id.trim();
  if (cfg.models.some((m) => m.id.trim().toLowerCase() === modelId.toLowerCase())) return false;
  cfg.models.push({
    id: modelId,
    name: model.name || modelId,
    reasoning: model.reasoning,
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  return true;
}

async function overlayMultiSelectModels(
  ctx: any,
  title: string,
  models: DiscoveredModel[],
  existingIds: Set<string>,
): Promise<Set<string> | undefined> {
  return ctx.ui.custom<Set<string | undefined> | undefined>((tui, theme, _kb, done) => {
    let sel = 0;
    let scroll = 0;
    let query = "";
    let searching = false;
    const selectable = models.filter((m) => !existingIds.has(m.id.trim().toLowerCase()));
    const selected = new Set<string>(selectable.map((m) => m.id));
    const maxVisibleRows = 10;

    function filteredModels() {
      const q = query.trim().toLowerCase();
      if (!q) return models;
      return models.filter((m) => `${m.name ?? ""} ${m.id}`.toLowerCase().includes(q));
    }

    function clampScroll() {
      const filtered = filteredModels();
      sel = Math.max(0, Math.min(sel, Math.max(0, filtered.length - 1)));
      const maxScroll = Math.max(0, filtered.length - maxVisibleRows);
      scroll = Math.max(0, Math.min(scroll, maxScroll));
      if (sel < scroll) scroll = sel;
      if (sel >= scroll + maxVisibleRows) scroll = sel - maxVisibleRows + 1;
      return filtered;
    }

    function toggleCurrent() {
      const model = filteredModels()[sel];
      if (!model || existingIds.has(model.id.trim().toLowerCase())) return;
      if (selected.has(model.id)) selected.delete(model.id);
      else selected.add(model.id);
      tui.requestRender();
    }

    function toggleAll() {
      if (selected.size === selectable.length) selected.clear();
      else {
        selected.clear();
        for (const model of selectable) selected.add(model.id);
      }
      tui.requestRender();
    }

    function handleSearchInput(data: string): boolean {
      if (!searching) return false;
      if (matchesKey(data, "escape")) { searching = false; query = ""; sel = 0; scroll = 0; tui.requestRender(); return true; }
      if (matchesKey(data, "backspace")) { query = query.slice(0, -1); sel = 0; scroll = 0; tui.requestRender(); return true; }
      if (matchesKey(data, "return") || matchesKey(data, "enter")) { searching = false; tui.requestRender(); return true; }
      if (data.length === 1 && data >= " ") { query += data; sel = 0; scroll = 0; tui.requestRender(); return true; }
      return false;
    }

    function handleInput(data: string) {
      if (handleSearchInput(data)) return;
      const filtered = clampScroll();
      if (matchesKey(data, "escape")) { done(undefined); return; }
      if (data === "/") { searching = true; query = ""; sel = 0; scroll = 0; tui.requestRender(); return; }
      if (matchesKey(data, "up")) { sel = Math.max(0, sel - 1); clampScroll(); tui.requestRender(); return; }
      if (matchesKey(data, "down")) { sel = Math.min(filtered.length - 1, sel + 1); clampScroll(); tui.requestRender(); return; }
      if (matchesKey(data, "pageup")) { sel = Math.max(0, sel - maxVisibleRows); clampScroll(); tui.requestRender(); return; }
      if (matchesKey(data, "pagedown")) { sel = Math.min(filtered.length - 1, sel + maxVisibleRows); clampScroll(); tui.requestRender(); return; }
      if (matchesKey(data, "return") || matchesKey(data, "enter") || data === " ") { toggleCurrent(); return; }
      if (data.toLowerCase() === "a") { toggleAll(); return; }
      if (data.toLowerCase() === "s") { done(new Set(selected)); return; }
    }

    function render(width: number): string[] {
      const filtered = clampScroll();
      const addedCount = models.filter((m) => existingIds.has(m.id.trim().toLowerCase())).length;
      const visible = filtered.slice(scroll, scroll + maxVisibleRows);
      const hiddenAbove = scroll;
      const hiddenBelow = Math.max(0, filtered.length - (scroll + visible.length));
      const showStart = filtered.length ? scroll + 1 : 0;
      const showEnd = scroll + visible.length;

      const body = [
        theme.fg("dim", `Found ${models.length} models | ${addedCount} already added | ${selected.size} selected`),
        theme.fg("dim", query ? `Filter /${query}${searching ? "_" : ""} | Showing ${showStart}-${showEnd} of ${filtered.length}` : `Showing ${showStart}-${showEnd} of ${models.length}`),
        "",
      ];

      if (hiddenAbove > 0) {
        body.push(theme.fg("dim", `... ${hiddenAbove} more above ...`));
      }

      if (visible.length === 0) {
        body.push(theme.fg("warning", "No matches"));
      }

      body.push(
        ...visible.map((model, offset) => {
          const index = scroll + offset;
          const isCurrent = index === sel;
          const exists = existingIds.has(model.id.trim().toLowerCase());
          const isSelected = selected.has(model.id);
          const marker = exists ? "[+]" : isSelected ? "[x]" : "[ ]";
          const arrow = isCurrent ? theme.fg("accent", "▶  ") : "    ";
          const flags = [
            model.input.includes("image") ? "IMG" : null,
            model.reasoning ? "R" : null,
            `ctx ${model.contextWindow}`,
            `out ${model.maxTokens}`,
            exists ? "added" : null,
          ].filter(Boolean).join(" | ");
          const text = `${marker} ${model.name ?? model.id}${model.name && model.name !== model.id ? ` (${model.id})` : ""}`;
          const line = `${text}  ${theme.fg("dim", flags)}`;
          return arrow + (isCurrent ? theme.fg("accent", line) : theme.fg("text", line));
        }),
      );

      if (hiddenBelow > 0) {
        body.push(theme.fg("dim", `... ${hiddenBelow} more below ...`));
      }

      return boxLines(
        theme,
        Math.min(92, width - 4),
        title,
        body,
        searching ? "type filter  |  Enter keep  |  Esc clear" : "↑↓ move | / filter | Enter toggle | A all | S add | Esc cancel",
      );
    }

    return { render, invalidate: () => {}, handleInput };
  }, { overlay: true }) as Promise<Set<string> | undefined>;
}

async function testDiscovery(ctx: any, cfg: PConfig, providerName: string): Promise<void> {
  try {
    const result = await discoverProviderModels(cfg);
    healthFor(providerName).discovery = {
      ok: true,
      endpoint: result.endpoint,
      message: `${result.models.length} model(s) found`,
      checkedAt: Date.now(),
    };
    ctx.ui.notify(`Discovery OK: ${result.models.length} model(s) via ${result.endpoint}`, "success");
    await overlayInfo(ctx, `Discovery OK: ${providerName}`, [
      `Endpoint: ${result.endpoint}`,
      `Models: ${result.models.length}`,
      "",
      ...result.models.slice(0, 80).map((m) => `- ${m.name ?? m.id} (${m.id})`),
      result.models.length > 80 ? `... ${result.models.length - 80} more` : "",
    ].filter(Boolean));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    healthFor(providerName).discovery = { ok: false, message, checkedAt: Date.now() };
    ctx.ui.notify(`Discovery test failed for ${providerName}: ${message}`, "warning");
    await overlayInfo(ctx, `Discovery failed: ${providerName}`, [`Error: ${message}`]);
  }
}

function joinEndpoint(baseUrl: string | undefined, endpoint: string): string {
  const base = (baseUrl ?? "").replace(/\/+$/, "");
  if (!base) return endpoint;
  if (base.endsWith(endpoint)) return base;
  return `${base}${endpoint}`;
}

function extractResponsePreview(json: any): string {
  const text =
    json?.choices?.[0]?.message?.content ??
    json?.output_text ??
    json?.content?.[0]?.text ??
    json?.message?.content ??
    JSON.stringify(json).slice(0, 180);
  return String(text).replace(/\s+/g, " ").trim().slice(0, 180);
}

function prettyPayload(value: any): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}

class ChatTestError extends Error {
  constructor(
    message: string,
    public endpoint: string,
    public status?: number,
    public body?: string,
  ) {
    super(message);
  }
}

async function sendChatTest(cfg: PConfig, modelId: string): Promise<{ endpoint: string; preview: string; full: string }> {
  const api = cfg.api ?? inferApiFromBaseUrl(cfg.baseUrl);
  const apiKey = resolveApiKey(cfg.apiKey);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let endpoint = "";
  let body: any;

  if (api === "anthropic-messages") {
    endpoint = joinEndpoint(cfg.baseUrl?.replace(/\/v1$/, ""), "/v1/messages");
    if (apiKey) {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    }
    body = {
      model: modelId,
      max_tokens: 8,
      messages: [{ role: "user", content: "Reply with OK only." }],
    };
  } else if (api === "openai-responses") {
    endpoint = joinEndpoint(cfg.baseUrl, "/responses");
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    body = { model: modelId, input: "Reply with OK only.", max_output_tokens: 8, stream: false };
  } else if (api === "openai-completions" || api === "mistral-conversations") {
    endpoint = joinEndpoint(cfg.baseUrl, "/chat/completions");
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    body = {
      model: modelId,
      messages: [{ role: "user", content: "Reply with OK only." }],
      max_tokens: 8,
      stream: false,
    };
  } else {
    throw new ChatTestError(`Chat test not implemented for ${apiFmt(api)}`, endpoint || "-");
  }

  const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  const raw = await res.text();
  let json: any = raw;
  try { json = JSON.parse(raw); } catch {}

  if (!res.ok) {
    const detail = prettyPayload(json);
    throw new ChatTestError(`${res.status} ${res.statusText}: ${detail.slice(0, 300)}`, endpoint, res.status, detail);
  }

  return { endpoint, preview: extractResponsePreview(json), full: prettyPayload(json) };
}

async function testChatCompletion(ctx: any, cfg: PConfig, providerName: string): Promise<void> {
  const models = cfg.models ?? [];
  if (!models.length) {
    ctx.ui.notify("Add a model before testing chat", "warning");
    return;
  }

  const labels = models.map((m) => `${m.name ?? m.id} (${m.id})`);
  const picked = models.length === 1 ? labels[0] : await overlaySelect(ctx, `Test chat: ${providerName}`, labels);
  if (!picked) return;

  const model = models[labels.indexOf(picked)] ?? models[0];
  if (!model) return;

  try {
    const result = await sendChatTest(cfg, model.id);
    healthFor(providerName).chat = {
      ok: true,
      endpoint: result.endpoint,
      model: model.id,
      message: result.preview || "OK (empty response)",
      checkedAt: Date.now(),
    };
    ctx.ui.notify(`Chat OK via ${result.endpoint}: ${result.preview || "(empty response)"}`, "success");
    await overlayInfo(ctx, `Chat OK: ${providerName}`, [
      `Endpoint: ${result.endpoint}`,
      `Model: ${model.id}`,
      `Preview: ${result.preview || "(empty response)"}`,
      "",
      "Full response:",
      result.full,
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const endpoint = error instanceof ChatTestError ? error.endpoint : undefined;
    const body = error instanceof ChatTestError ? error.body : undefined;
    healthFor(providerName).chat = {
      ok: false,
      endpoint,
      model: model.id,
      message,
      checkedAt: Date.now(),
    };
    ctx.ui.notify(`Chat test failed: ${message}`, "warning");
    await overlayInfo(ctx, `Chat failed: ${providerName}`, [
      endpoint ? `Endpoint: ${endpoint}` : "Endpoint: -",
      `Model: ${model.id}`,
      `Error: ${message}`,
      "",
      body ? "Full response:" : "",
      body ?? "",
    ].filter(Boolean));
  }
}

async function discoverAndAddModels(ctx: any, cfg: PConfig, providerName: string): Promise<void> {
  try {
    const result = await discoverProviderModels(cfg);
    healthFor(providerName).discovery = {
      ok: true,
      endpoint: result.endpoint,
      message: `${result.models.length} model(s) found`,
      checkedAt: Date.now(),
    };
    if (result.models.length === 0) {
      ctx.ui.notify("No models discovered", "warning");
      return;
    }

    const existingIds = new Set((cfg.models ?? []).map((m) => m.id.trim().toLowerCase()));
    const selected = await overlayMultiSelectModels(
      ctx,
      `Discovered models: ${providerName}`,
      result.models,
      existingIds,
    );
    if (!selected || selected.size === 0) {
      ctx.ui.notify(`Discovery checked ${result.models.length} model(s) via ${result.endpoint}`, "info");
      return;
    }

    let added = 0;
    let skipped = 0;
    for (const model of result.models) {
      if (!selected.has(model.id)) continue;
      if (addDiscoveredModel(cfg, model)) added++;
      else skipped++;
    }
    ctx.ui.notify(
      `Added ${added} model(s), skipped ${skipped} existing | source ${result.endpoint}`,
      "success",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    healthFor(providerName).discovery = { ok: false, message, checkedAt: Date.now() };
    ctx.ui.notify(`Discover failed: ${message}`, "warning");
  }
}

// ═══════════════════════════════════════════════════════════════
//  Overlay Dialog Engine
// ═══════════════════════════════════════════════════════════════

function wrapPlainText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const rawLine of String(text).split("\n")) {
    if (rawLine.length === 0) { lines.push(""); continue; }
    let rest = rawLine;
    while (visibleWidth(rest) > width) {
      let cut = Math.max(1, width);
      while (cut > 1 && visibleWidth(rest.slice(0, cut)) > width) cut--;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    lines.push(rest);
  }
  return lines;
}

function boxLines(theme: any, width: number, title: string, body: string[], footer?: string): string[] {
  const pad = (s: string, len: number) => {
    const vw = visibleWidth(s);
    return s + " ".repeat(Math.max(0, len - vw));
  };

  const lines: string[] = [];

  lines.push(theme.fg("border", `╭${"─".repeat(width - 2)}╮`));

  const titlePad = Math.max(1, Math.floor((width - 2 - visibleWidth(title)) / 2));
  lines.push(
    theme.fg("border", "│") +
      pad(" ".repeat(titlePad) + theme.bold(theme.fg("accent", title)), width - 2) +
      theme.fg("border", "│"),
  );

  lines.push(theme.fg("border", `├${"─".repeat(width - 2)}┤`));

  // Blank spacer
  lines.push(theme.fg("border", "│") + pad("", width - 2) + theme.fg("border", "│"));

  // Body
  for (const row of body) {
    const content = row ? theme.fg("text", "  " + row) : "    ";
    lines.push(theme.fg("border", "│") + pad(content, width - 2) + theme.fg("border", "│"));
  }

  // Blank spacer
  lines.push(theme.fg("border", "│") + pad("", width - 2) + theme.fg("border", "│"));

  // Footer
  if (footer) {
    const fPad = Math.max(1, Math.floor((width - 2 - visibleWidth(footer)) / 2));
    lines.push(
      theme.fg("border", "│") +
        pad(" ".repeat(fPad) + theme.fg("dim", footer), width - 2) +
        theme.fg("border", "│"),
    );
  }

  lines.push(theme.fg("border", `╰${"─".repeat(width - 2)}╯`));

  return lines;
}

async function overlayInfo(ctx: any, title: string, content: string[] | string): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    let scroll = 0;
    const rawLines = Array.isArray(content) ? content : String(content).split("\n");
    const maxVisibleRows = 18;

    function handleInput(data: string) {
      const total = rawLines.length;
      if (matchesKey(data, "escape") || matchesKey(data, "return") || matchesKey(data, "enter") || data.toLowerCase() === "q") {
        done();
        return;
      }
      if (matchesKey(data, "up")) { scroll = Math.max(0, scroll - 1); tui.requestRender(); return; }
      if (matchesKey(data, "down")) { scroll = Math.min(Math.max(0, total - 1), scroll + 1); tui.requestRender(); return; }
      if (matchesKey(data, "pageup")) { scroll = Math.max(0, scroll - maxVisibleRows); tui.requestRender(); return; }
      if (matchesKey(data, "pagedown")) { scroll = Math.min(Math.max(0, total - 1), scroll + maxVisibleRows); tui.requestRender(); return; }
    }

    function render(width: number): string[] {
      const boxWidth = Math.min(100, width - 4);
      const textWidth = Math.max(20, boxWidth - 8);
      const wrapped = rawLines.flatMap((line) => wrapPlainText(line, textWidth));
      const maxScroll = Math.max(0, wrapped.length - maxVisibleRows);
      scroll = Math.max(0, Math.min(scroll, maxScroll));
      const visible = wrapped.slice(scroll, scroll + maxVisibleRows);
      const body = [
        theme.fg("dim", `Showing ${wrapped.length ? scroll + 1 : 0}-${scroll + visible.length} of ${wrapped.length}`),
        "",
        ...visible.map((line) => theme.fg("text", line)),
      ];
      return boxLines(theme, boxWidth, title, body, "↑↓ scroll  |  PgUp/PgDn  |  Enter/Q/Esc close");
    }

    return { render, invalidate: () => {}, handleInput };
  }, { overlay: true });
}

// ── Menu ──────────────────────────────────────────────

async function overlayMenu(
  ctx: any,
  title: string,
  items: { label: string; action: string }[],
  opts?: { initialIndex?: number },
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
    let sel = Math.max(0, Math.min(opts?.initialIndex ?? 0, items.length - 1));
    let query = "";
    let searching = false;

    function filteredItems() {
      const q = query.trim().toLowerCase();
      const mapped = items.map((item, index) => ({ ...item, index }));
      if (!q) return mapped;
      return mapped.filter((item) => item.label.toLowerCase().includes(q));
    }

    function clampSelection() {
      const filtered = filteredItems();
      sel = Math.max(0, Math.min(sel, Math.max(0, filtered.length - 1)));
      return filtered;
    }

    function handleSearchInput(data: string): boolean {
      if (!searching) return false;
      if (matchesKey(data, "escape")) {
        searching = false;
        query = "";
        sel = 0;
        tui.requestRender();
        return true;
      }
      if (matchesKey(data, "backspace")) {
        query = query.slice(0, -1);
        sel = 0;
        tui.requestRender();
        return true;
      }
      if (matchesKey(data, "return") || matchesKey(data, "enter")) {
        searching = false;
        tui.requestRender();
        return true;
      }
      if (data.length === 1 && data >= " ") {
        query += data;
        sel = 0;
        tui.requestRender();
        return true;
      }
      return false;
    }

    function handleInput(data: string) {
      if (handleSearchInput(data)) return;
      const filtered = clampSelection();

      if (matchesKey(data, "escape")) { done(undefined); return; }
      if (data === "/") { searching = true; query = ""; sel = 0; tui.requestRender(); return; }
      if (matchesKey(data, "return") || matchesKey(data, "enter")) {
        const item = filtered[sel];
        if (item) done(item.action);
        return;
      }
      if (matchesKey(data, "up")) { sel = Math.max(0, sel - 1); tui.requestRender(); }
      else if (matchesKey(data, "down")) { sel = Math.min(filtered.length - 1, sel + 1); tui.requestRender(); }
    }

    function render(width: number): string[] {
      const filtered = clampSelection();
      const body: string[] = [];
      if (searching || query) {
        body.push(theme.fg("dim", `Filter: /${query}${searching ? "_" : ""}  (${filtered.length}/${items.length})`));
        body.push("");
      }

      if (filtered.length === 0) {
        body.push(theme.fg("warning", "No matches"));
      } else {
        body.push(...filtered.map((it, i) => {
          const arrow = i === sel ? theme.fg("accent", "▶  ") : "    ";
          const label = i === sel ? theme.fg("accent", it.label) : theme.fg("text", it.label);
          return arrow + label;
        }));
      }

      return boxLines(
        theme,
        Math.min(68, width - 4),
        title,
        body,
        searching ? "type filter  |  Enter keep  |  Esc clear" : "↑↓ navigate  |  / filter  |  Enter select  |  Esc cancel",
      );
    }

    return { render, invalidate: () => {}, handleInput };
  }, { overlay: true });
}

// ── Input ─────────────────────────────────────────────

async function overlayInput(
  ctx: any,
  title: string,
  hint: string,
  opts?: { mask?: boolean; cleanSecret?: boolean },
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
    let text = "";
    let cursor = 0;
    let viewStart = 0;
    const mask = opts?.mask ?? false;
    const pendingInputEscape = { value: "" };

    function visibleText(value: string): string {
      return mask ? "•".repeat(value.length) : value;
    }

    function insertText(value: string) {
      if (!value) return;
      const clean = sanitizeOverlayInputChunk(value, pendingInputEscape);
      if (!clean) return;
      text = text.slice(0, cursor) + clean + text.slice(cursor);
      cursor += clean.length;
      tui.requestRender();
    }

    function deleteWordBackward() {
      if (cursor <= 0) return;
      let start = cursor;
      while (start > 0 && /\s/.test(text[start - 1]!)) start--;
      while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
      text = text.slice(0, start) + text.slice(cursor);
      cursor = start;
      tui.requestRender();
    }

    function deleteWordForward() {
      if (cursor >= text.length) return;
      let end = cursor;
      while (end < text.length && /\s/.test(text[end]!)) end++;
      while (end < text.length && !/\s/.test(text[end]!)) end++;
      text = text.slice(0, cursor) + text.slice(end);
      tui.requestRender();
    }

    function moveWordBackward() {
      let next = cursor;
      while (next > 0 && /\s/.test(text[next - 1]!)) next--;
      while (next > 0 && !/\s/.test(text[next - 1]!)) next--;
      cursor = next;
      tui.requestRender();
    }

    function moveWordForward() {
      let next = cursor;
      while (next < text.length && /\s/.test(text[next]!)) next++;
      while (next < text.length && !/\s/.test(text[next]!)) next++;
      cursor = next;
      tui.requestRender();
    }

    function finishInput() {
      const value = opts?.cleanSecret ? cleanSecretInput(text) : text.trim();
      done(value || undefined);
    }

    function handleInput(data: string) {
      if (matchesKey(data, "escape")) { done(undefined); return; }
      if (matchesKey(data, "return") || matchesKey(data, "enter")) { finishInput(); return; }
      if (matchesKey(data, "home") || matchesKey(data, "ctrl+a")) { cursor = 0; tui.requestRender(); }
      else if (matchesKey(data, "end") || matchesKey(data, "ctrl+e")) { cursor = text.length; tui.requestRender(); }
      else if (matchesKey(data, "alt+left")) { moveWordBackward(); }
      else if (matchesKey(data, "alt+right")) { moveWordForward(); }
      else if (matchesKey(data, "alt+backspace") || matchesKey(data, "ctrl+backspace") || matchesKey(data, "ctrl+w")) {
        deleteWordBackward();
      } else if (matchesKey(data, "alt+delete") || matchesKey(data, "alt+d")) {
        deleteWordForward();
      } else if (matchesKey(data, "backspace")) {
        if (cursor > 0) { text = text.slice(0, cursor - 1) + text.slice(cursor); cursor--; tui.requestRender(); }
      } else if (matchesKey(data, "left")) { cursor = Math.max(0, cursor - 1); tui.requestRender(); }
      else if (matchesKey(data, "right")) { cursor = Math.min(text.length, cursor + 1); tui.requestRender(); }
      else if (!matchesKey(data, "up") && !matchesKey(data, "down")) {
        insertText(data);
      }
    }

    function render(width: number): string[] {
      const boxWidth = Math.min(68, width - 4);
      const prefix = "  >  ";
      const fieldWidth = Math.max(8, boxWidth - 4 - visibleWidth(prefix));
      const body: string[] = [];

      if (text.length === 0) {
        const hintText = hint.slice(0, Math.max(0, fieldWidth - 1));
        body.push("");
        body.push(theme.fg("text", prefix) + "\x1b[7m \x1b[27m" + theme.fg("dim", hintText));
        body.push("");
      } else {
        const shown = visibleText(text);
        if (cursor < viewStart) viewStart = cursor;
        if (cursor >= viewStart + fieldWidth) viewStart = cursor - fieldWidth + 1;
        viewStart = Math.max(0, Math.min(viewStart, Math.max(0, shown.length - fieldWidth)));

        const cursorInView = cursor - viewStart;
        const view = shown.slice(viewStart, viewStart + fieldWidth);
        const before = view.slice(0, cursorInView);
        const curChar = cursor < shown.length ? shown[cursor]! : " ";
        const after = cursor < shown.length ? view.slice(cursorInView + 1) : "";
        const line = theme.fg("text", prefix + before + "\x1b[7m" + curChar + "\x1b[27m" + after);
        body.push("");
        body.push(line);
        body.push("");
      }
      return boxLines(
        theme,
        boxWidth,
        title,
        body,
        mask
          ? "Paste | Alt+←/→ move | Alt+Bksp del | Hidden | Enter"
          : "Paste | Alt+←/→ move | Alt+Bksp del | Enter | Esc",
      );
    }

    return { render, invalidate: () => {}, handleInput };
  }, { overlay: true });
}

// ── Confirm ───────────────────────────────────────────

async function overlayConfirm(ctx: any, title: string, message: string): Promise<boolean> {
  const result = await ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
    let sel = 0;

    function handleInput(data: string) {
      if (matchesKey(data, "escape")) { done(undefined); return; }
      if (matchesKey(data, "return") || matchesKey(data, "enter")) { done(sel === 0 ? "yes" : "no"); return; }
      if (matchesKey(data, "up") || matchesKey(data, "left")) { sel = Math.max(0, sel - 1); tui.requestRender(); }
      else if (matchesKey(data, "down") || matchesKey(data, "right")) { sel = Math.min(1, sel + 1); tui.requestRender(); }
    }

    function render(width: number): string[] {
      const yesText = " Yes  ";
      const noText  = " No   ";
      const body: string[] = [
        "",
        `  ${theme.fg("text", message)}`,
        "",
        (sel === 0 ? theme.fg("accent", "▶") : " ") + theme.fg("success", yesText),
        (sel === 1 ? theme.fg("accent", "▶") : " ") + theme.fg("error",  noText),
        "",
      ];
      return boxLines(theme, Math.min(56, width - 4), title, body, "←→ select  |  Enter confirm  |  Esc cancel");
    }

    return { render, invalidate: () => {}, handleInput };
  }, { overlay: true });

  return result === "yes";
}

// ── Select ────────────────────────────────────────────

async function overlaySelect(
  ctx: any,
  title: string,
  opts: string[],
  defaultValue?: string,
): Promise<string | undefined> {
  const items = opts.map((v) => ({ label: v, action: v }));
  const initialIndex = defaultValue ? Math.max(0, opts.indexOf(defaultValue)) : 0;
  return overlayMenu(ctx, title, items, { initialIndex });
}

function statusIcon(status?: { ok: boolean }): string {
  if (!status) return "?";
  return status.ok ? "✓" : "✗";
}

function formatProviderHealthLabel(name: string, cfg: PConfig): string {
  const h = providerHealth.get(name);
  const mc = cfg.models?.length ?? 0;
  return `Health: discovery ${statusIcon(h?.discovery)} | chat ${statusIcon(h?.chat)} | ${mc} model${mc !== 1 ? "s" : ""}`;
}

async function showProviderHealth(ctx: any, name: string, cfg: PConfig): Promise<void> {
  const h = providerHealth.get(name);
  const discovery = h?.discovery;
  const chat = h?.chat;
  await overlayInfo(ctx, `Provider health: ${name}`, [
    `Provider: ${name}`,
    `Base URL: ${cfg.baseUrl ?? "-"}`,
    `API: ${apiFmt(cfg.api ?? inferApiFromBaseUrl(cfg.baseUrl))}`,
    `Models configured: ${cfg.models?.length ?? 0}`,
    `API key: ${cfg.apiKey ? "set" : "not set"}`,
    "",
    `Discovery: ${statusIcon(discovery)} ${discovery?.message ?? "not checked"}`,
    discovery?.endpoint ? `Discovery endpoint: ${discovery.endpoint}` : "",
    discovery?.checkedAt ? `Discovery checked: ${new Date(discovery.checkedAt).toLocaleString()}` : "",
    "",
    `Chat: ${statusIcon(chat)} ${chat?.message ?? "not checked"}`,
    chat?.endpoint ? `Chat endpoint: ${chat.endpoint}` : "",
    chat?.model ? `Chat model: ${chat.model}` : "",
    chat?.checkedAt ? `Chat checked: ${new Date(chat.checkedAt).toLocaleString()}` : "",
  ].filter(Boolean));
}

// ═══════════════════════════════════════════════════════════════
//  Wizard Flows
// ═══════════════════════════════════════════════════════════════

async function mainLoop(ctx: any, data: PData): Promise<boolean> {
  const provs = data.providers ?? {};
  const names = Object.keys(provs);

  const items: { label: string; action: string }[] = [{ label: "Add new provider", action: "ADD" }];
  for (const n of names) {
    const mc = provs[n]?.models?.length ?? 0;
    items.push({ label: `  ${n}  (${mc} model${mc !== 1 ? "s" : ""})`, action: `EDIT:${n}` });
  }
  if (names.length > 0) items.push({ label: "Remove provider", action: "REMOVE" });
  items.push({ label: "Save changes", action: "SAVE" });
  items.push({ label: "Exit", action: "EXIT" });

  const choice = await overlayMenu(ctx, "Custom Providers Setup", items);
  if (!choice) return false;

  switch (choice) {
    case "EXIT": return false;
    case "SAVE": return false;
    case "ADD": await addProvider(ctx, data); return true;
    case "REMOVE": await removeProvider(ctx, data); return true;
    default:
      if (choice.startsWith("EDIT:")) { await provMenu(ctx, data, choice.slice(5)); }
      return true;
  }
}

async function provMenu(ctx: any, data: PData, name: string): Promise<void> {
  const cfg = data.providers?.[name];
  if (!cfg) return;

  const items = [
    { label: formatProviderHealthLabel(name, cfg), action: "HEALTH" },
    { label: "Add model", action: "ADD_MODEL" },
    { label: "Discover models from API", action: "DISCOVER" },
    { label: "Test discovery endpoint", action: "TEST_DISCOVER" },
    { label: "Test chat completion", action: "TEST_CHAT" },
    { label: "Manage models", action: "LIST" },
    { label: "Edit config", action: "EDIT_CFG" },
    { label: "Back", action: "BACK" },
  ];

  const choice = await overlayMenu(ctx, `Provider: ${name}`, items);
  if (!choice || choice === "BACK") return;

  switch (choice) {
    case "HEALTH":
      await showProviderHealth(ctx, name, cfg);
      await provMenu(ctx, data, name);
      break;
    case "ADD_MODEL":
      await addModel(ctx, cfg, name);
      await provMenu(ctx, data, name);
      break;
    case "DISCOVER":
      await discoverAndAddModels(ctx, cfg, name);
      await provMenu(ctx, data, name);
      break;
    case "TEST_DISCOVER":
      await testDiscovery(ctx, cfg, name);
      await provMenu(ctx, data, name);
      break;
    case "TEST_CHAT":
      await testChatCompletion(ctx, cfg, name);
      await provMenu(ctx, data, name);
      break;
    case "LIST":
      await manageModels(ctx, cfg, name);
      await provMenu(ctx, data, name);
      break;
    case "EDIT_CFG":
      await editCfg(ctx, cfg, name);
      await provMenu(ctx, data, name);
      break;
  }
}

async function addProvider(ctx: any, data: PData): Promise<void> {
  const name = await overlayInput(ctx, "Add Provider", "e.g. ollama");
  if (!name?.trim()) return ctx.ui.notify("Name required", "warning");
  if (data.providers?.[name]) return ctx.ui.notify(`"${name}" exists`, "warning");

  const url = await overlayInput(ctx, "Base URL", "http://localhost:11434/v1");
  if (!url?.trim()) return ctx.ui.notify("URL required", "warning");

  const suggestedApi = inferApiFromBaseUrl(url);
  const api = await overlaySelect(
    ctx,
    `Select API Type (suggested: ${apiFmt(suggestedApi)})`,
    API_OPTS.map(apiFmt),
    apiFmt(suggestedApi),
  );
  if (!api) return;

  const keyRaw = await overlayInput(ctx, "API Key", "MY_API_KEY", { mask: true, cleanSecret: true });
  const key = keyRaw?.trim() || undefined;

  data.providers = data.providers ?? {};
  data.providers[name] = {
    baseUrl: url.trim(),
    api: API_OPTS.find(a => apiFmt(a) === api) ?? api,
    apiKey: key,
    models: [],
  };
  ctx.ui.notify(`Provider "${name}" added`, "success");

  const discoverNow = await overlayConfirm(ctx, "Discover models?", `Try auto-discover models from "${name}" API now?`);
  if (discoverNow) {
    await discoverAndAddModels(ctx, data.providers[name]!, name);
    return;
  }

  const addNow = await overlayConfirm(ctx, "Add first model?", `Add model to "${name}" manually now?`);
  if (addNow) await addModel(ctx, data.providers[name]!, name);
}

async function removeProvider(ctx: any, data: PData): Promise<void> {
  const names = Object.keys(data.providers ?? {});
  if (!names.length) return;

  const name = await overlaySelect(ctx, "Remove Provider", names);
  if (!name) return;

  const ok = await overlayConfirm(ctx, "Delete provider?", `Remove "${name}" and all models?`);
  if (ok) {
    delete (data.providers ?? {})[name];
    providerHealth.delete(name);
    ctx.ui.notify(`"${name}" removed`, "info");
  }
}

async function editCfg(ctx: any, cfg: PConfig, name: string): Promise<void> {
  const fields = [
    `Base URL: ${cfg.baseUrl ?? "-"}`,
    `API:      ${apiFmt(cfg.api ?? "-")}`,
    `API Key:  ${cfg.apiKey ? "***" : "(none)"}`,
    "Back",
  ];

  const picked = await overlaySelect(ctx, `Edit ${name}`, fields);
  if (!picked || picked === "Back") return;

  const fieldName = picked.startsWith("Base URL") ? "baseUrl"
                  : picked.startsWith("API:")     ? "api"
                  : picked.startsWith("API Key")  ? "apiKey"
                  : null;
  if (!fieldName) return;

  if (fieldName === "api") {
    const api = await overlaySelect(ctx, "Select API", API_OPTS.map(apiFmt), apiFmt(cfg.api ?? inferApiFromBaseUrl(cfg.baseUrl)));
    if (api) cfg.api = API_OPTS.find(a => apiFmt(a) === api) ?? api;
    ctx.ui.notify(`${fieldName} updated`, "success");
  } else if (fieldName === "apiKey") {
    const action = await overlaySelect(
      ctx,
      "API Key",
      cfg.apiKey ? ["Keep current", "Replace", "Clear"] : ["Replace", "Clear"],
    );
    if (!action || action === "Keep current") return;
    if (action === "Clear") {
      cfg.apiKey = undefined;
      ctx.ui.notify("apiKey cleared", "success");
      return;
    }
    const val = await overlayInput(ctx, "API Key", cfg.apiKey ? "paste replacement" : "MY_API_KEY", { mask: true, cleanSecret: true });
    if (val !== undefined) {
      cfg.apiKey = val.trim() || undefined;
      ctx.ui.notify("apiKey updated", "success");
    }
  } else {
    const cur = String(cfg[fieldName as keyof PConfig] ?? "");
    const val = await overlayInput(ctx, "Base URL", cur);
    if (val !== undefined) {
      (cfg as any)[fieldName] = val.trim() || undefined;
      ctx.ui.notify(`${fieldName} updated`, "success");
    }
  }
}

async function manageModels(ctx: any, cfg: PConfig, pname: string): Promise<void> {
  const models = cfg.models ?? [];
  if (!models.length) { ctx.ui.notify("No models configured", "info"); return; }

  const labels = models.map(mFmt);
  labels.push("Back");

  const picked = await overlaySelect(ctx, `Models: ${pname}`, labels);
  if (!picked || picked === "Back") return;

  const idx = labels.indexOf(picked);
  if (idx < 0 || idx >= models.length) return;
  const model = models[idx];
  if (!model) return;

  const actions = ["Edit", "Remove", "Back"];
  const act = await overlaySelect(ctx, mFmt(model), actions);
  if (act === "Back") return await manageModels(ctx, cfg, pname);
  if (act === "Remove") {
    const ok = await overlayConfirm(ctx, "Remove?", `Delete "${model.name ?? model.id}"?`);
    if (ok) { cfg.models?.splice(idx, 1); ctx.ui.notify("Removed", "info"); }
    return await manageModels(ctx, cfg, pname);
  }
  // Edit
  await editModel(ctx, model);
  return await manageModels(ctx, cfg, pname);
}

async function addModel(ctx: any, cfg: PConfig, pname: string): Promise<void> {
  const id = await overlayInput(ctx, "Model ID (API name)", "llama3.1:8b");
  const modelId = id?.trim();
  if (!modelId) return ctx.ui.notify("ID required", "warning");
  if (cfg.models?.some(m => m.id.trim().toLowerCase() === modelId.toLowerCase())) {
    return ctx.ui.notify(`Model "${modelId}" already exists (case-insensitive match)`, "warning");
  }

  const name = await overlayInput(ctx, "Display name", modelId);
  const reasoning = await overlayConfirm(ctx, "Reasoning?", "Extended thinking support?");

  const inputOpts = ["Text only", "Text + Image"];
  const inPicked = await overlaySelect(ctx, "Input types", inputOpts);
  const input = inPicked?.includes("Image") ? ["text", "image"] as string[] : ["text"] as string[];

  const cwStr = await overlayInput(ctx, "Context window (tokens)", "128000");
  const mtStr = await overlayInput(ctx, "Max output tokens", "16384");
  const ctxWin = parseInt(cwStr ?? "128000", 10) || 128000;
  const maxT   = parseInt(mtStr ?? "16384", 10) || 16384;

  cfg.models ??= [];
  cfg.models.push({
    id: modelId,
    name: name?.trim() || modelId,
    reasoning: reasoning ?? false,
    input,
    contextWindow: ctxWin,
    maxTokens: maxT,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });

  ctx.ui.notify(`Model "${name?.trim() || modelId}" added`, "success");
}

async function editModel(ctx: any, model: PModel): Promise<void> {
  const fields = [
    `ID:          ${model.id}`,
    `Name:        ${model.name ?? ""}`,
    `Reasoning:   ${model.reasoning ? "enabled" : "disabled"}`,
    `Input:       ${model.input?.join(", ") ?? "text"}`,
    `Ctx Window:  ${model.contextWindow ?? ""}`,
    `Max Tokens:  ${model.maxTokens ?? ""}`,
    "Back",
  ];

  const picked = await overlaySelect(ctx, `Edit ${model.name ?? model.id}`, fields);
  if (!picked || picked.startsWith("Back")) return;

  if (picked.startsWith("ID")) {
    const v = await overlayInput(ctx, "New ID:", model.id);
    if (v?.trim()) model.id = v.trim();
  } else if (picked.startsWith("Name")) {
    const v = await overlayInput(ctx, "New name:", model.name ?? model.id);
    if (v?.trim()) model.name = v.trim();
  } else if (picked.startsWith("Reasoning")) {
    model.reasoning = !(model.reasoning ?? false);
    ctx.ui.notify(`Reasoning: ${model.reasoning ? "on" : "off"}`, "info");
  } else if (picked.startsWith("Input")) {
    const opts = ["Text only", "Text + Image"];
    const p = await overlaySelect(ctx, "Input:", opts);
    model.input = p?.includes("Image") ? ["text", "image"] : ["text"] as string[];
  } else if (picked.startsWith("Ctx Window")) {
    const v = await overlayInput(ctx, "Context window:", String(model.contextWindow ?? "128000"));
    if (v?.trim()) { const n = parseInt(v, 10); if (!isNaN(n)) model.contextWindow = n; }
  } else if (picked.startsWith("Max Tokens")) {
    const v = await overlayInput(ctx, "Max tokens:", String(model.maxTokens ?? "16384"));
    if (v?.trim()) { const n = parseInt(v, 10); if (!isNaN(n)) model.maxTokens = n; }
  }
}

// ═══════════════════════════════════════════════════════════════
//  Extension Entry
// ═══════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {
  activePi = pi;

  pi.registerCommand("setup-custom-providers", {
    description: "Interactive wizard to manage custom providers and models",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) { ctx.ui.notify("Requires interactive mode", "error"); return; }
      activePi = pi;
      const data = load();
      let running = true;
      while (running) running = await mainLoop(ctx, data);
      save(data);
      registerConfiguredProviders(data);
      ctx.ui.notify("Saved! providers registered — use /model", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.notify("setup-providers loaded — /setup-custom-providers", "info");
  });
}
