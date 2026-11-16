// DriveFlin v2 — autenticação compatível com o Jellyfin.
//
// O Jellyfin aceita o token de acesso por várias vias (todas suportadas aqui):
//   Authorization: MediaBrowser Client="..", Device="..", DeviceId="..", Version="..", Token=".."
//   X-Emby-Authorization: (mesmo formato, legado)
//   X-Emby-Token / X-MediaBrowser-Token: <token>          (legado)
//   ?api_key=<token> ou ?ApiKey=<token>                   (usado em URLs de mídia, imagens e websocket)
//
// Tokens são aleatórios (32 hex, como no Jellyfin), guardados na tabela Sessions do D1
// e invalidados no logout, na troca de senha e na exclusão do usuário.

export const LEGACY_ADMIN_ID = "ee09da3140518fedd8b0f27b8b59bafb";

export type AuthInfo = {
  token?: string;
  client?: string;
  device?: string;
  deviceId?: string;
  version?: string;
};

export type SessionUser = {
  token: string;
  userId: string; // Id como gravado no banco
  userUuid: string; // Id normalizado (32 hex) exposto aos clientes
  name: string;
  isAdmin: boolean;
  deviceId: string;
  deviceName: string;
  client: string;
  version: string;
};

/** Faz o parse de `MediaBrowser Key="Value", Key2="Value2"` (também aceita `Emby`). */
export function parseMediaBrowserHeader(value: string | null | undefined): AuthInfo {
  const out: AuthInfo = {};
  if (!value) return out;
  const v = value.trim();
  const m = v.match(/^(MediaBrowser|Emby)\s+(.*)$/i);
  if (!m) return out;
  const re = /([A-Za-z]+)\s*=\s*"([^"]*)"|([A-Za-z]+)\s*=\s*([^,\s]+)/g;
  let p: RegExpExecArray | null;
  while ((p = re.exec(m[2])) !== null) {
    const key = (p[1] || p[3] || "").toLowerCase();
    let val = p[2] ?? p[4] ?? "";
    try { val = decodeURIComponent(val); } catch (e) {}
    if (key === "token") out.token = val;
    else if (key === "client") out.client = val;
    else if (key === "device") out.device = val;
    else if (key === "deviceid") out.deviceId = val;
    else if (key === "version") out.version = val;
  }
  return out;
}

/** Extrai token e dados do dispositivo de qualquer forma aceita pelo Jellyfin. */
export function extractAuth(req: Request): AuthInfo {
  const h = req.headers;
  const fromAuth = parseMediaBrowserHeader(h.get("Authorization"));
  const fromEmby = parseMediaBrowserHeader(h.get("X-Emby-Authorization"));
  const info: AuthInfo = { ...fromEmby, ...stripEmpty(fromAuth) };

  const headerToken = h.get("X-Emby-Token") || h.get("X-MediaBrowser-Token");
  if (!info.token && headerToken) info.token = headerToken.trim();

  if (!info.token) {
    const url = new URL(req.url);
    for (const [k, val] of url.searchParams) {
      const lk = k.toLowerCase();
      if ((lk === "api_key" || lk === "apikey") && val) {
        info.token = val.trim();
        break;
      }
    }
  }
  info.client = info.client || h.get("X-Emby-Client") || undefined;
  info.device = info.device || h.get("X-Emby-Device-Name") || undefined;
  info.deviceId = info.deviceId || h.get("X-Emby-Device-Id") || undefined;
  info.version = info.version || h.get("X-Emby-Client-Version") || undefined;
  return info;
}

function stripEmpty(o: AuthInfo): AuthInfo {
  const r: any = {};
  for (const [k, v] of Object.entries(o)) if (v) r[k] = v;
  return r;
}

/** Credenciais HTTP Basic (usadas só pelas páginas HTML /setup e /sync). */
export function extractBasic(req: Request): { user: string; pass: string } | null {
  const v = req.headers.get("Authorization") || "";
  const m = v.match(/^Basic\s+(.+)$/i);
  if (!m) return null;
  try {
    const raw = atob(m[1].trim());
    const i = raw.indexOf(":");
    if (i < 0) return null;
    return { user: raw.slice(0, i), pass: raw.slice(i + 1) };
  } catch (e) {
    return null;
  }
}

export function randomHex(bytes = 16): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toB64(buf: ArrayBuffer | Uint8Array): string {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/** Comparação em tempo constante. */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

// Workers limita PBKDF2 a 100.000 iterações; 30.000 cabe no limite de CPU do plano grátis.
const DEFAULT_ITERATIONS = 30000;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

/** Gera `pbkdf2$<iter>$<salt>$<hash>`. Senha vazia continua vazia (usuário sem senha, como no Jellyfin). */
export async function hashPassword(password: string, iterations?: number): Promise<string> {
  if (!password) return "";
  const it = Math.min(Math.max(iterations || DEFAULT_ITERATIONS, 10000), 100000);
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await pbkdf2(password, salt, it);
  return `pbkdf2$${it}$${toB64(salt)}$${toB64(hash)}`;
}

export function isHashed(stored: string | null | undefined): boolean {
  return !!stored && stored.startsWith("pbkdf2$");
}

/**
 * Verifica a senha. Regras do Jellyfin: usuário sem senha só entra com senha vazia;
 * usuário com senha nunca entra com senha vazia. Senhas antigas em texto puro (v1)
 * são aceitas e devem ser regravadas com hash pelo chamador (needsRehash).
 */
export async function verifyPassword(stored: string | null | undefined, given: string): Promise<{ ok: boolean; needsRehash: boolean }> {
  const s = stored || "";
  const g = given || "";
  if (!s) return { ok: g === "", needsRehash: false };
  if (!g) return { ok: false, needsRehash: false };
  if (isHashed(s)) {
    try {
      const parts = s.split("$");
      if (parts.length !== 4) return { ok: false, needsRehash: false };
      const it = parseInt(parts[1], 10);
      if (!(it >= 1000 && it <= 100000)) return { ok: false, needsRehash: false };
      const salt = fromB64(parts[2]);
      const expected = parts[3];
      const got = toB64(await pbkdf2(g, salt, it));
      return { ok: safeEqual(got, expected), needsRehash: false };
    } catch (e) {
      return { ok: false, needsRehash: false };
    }
  }
  // Legado v1: texto puro
  return { ok: safeEqual(s, g), needsRehash: true };
}

/** Política efetiva do usuário. Só o admin original (ou Name=admin sem política salva) é admin por padrão. */
export function parsePolicy(user: any, defaultPolicy: any): any {
  const legacyAdmin = user && (user.Id === LEGACY_ADMIN_ID || (!user.Policy && String(user.Name || "").toLowerCase() === "admin"));
  let saved: any = {};
  try { if (user?.Policy) saved = JSON.parse(user.Policy) || {}; } catch (e) {}
  const p = { ...defaultPolicy, IsAdministrator: !!legacyAdmin, ...saved };
  if (user && user.Id === LEGACY_ADMIN_ID) p.IsAdministrator = true; // nunca trancar o admin principal
  if (p.IsDisabled === undefined) p.IsDisabled = false;
  return p;
}

export async function ensureAuthSchema(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS Sessions (
      Token TEXT PRIMARY KEY,
      UserId TEXT NOT NULL,
      DeviceId TEXT,
      DeviceName TEXT,
      Client TEXT,
      AppVersion TEXT,
      Created TEXT DEFAULT (datetime('now')),
      LastActivity TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_sessions_user ON Sessions(UserId)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS LoginAttempts (
      Ip TEXT NOT NULL,
      At INTEGER NOT NULL,
      Name TEXT
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_login_attempts ON LoginAttempts(Ip, At)"),
  ]);
  try { await db.prepare("ALTER TABLE LoginAttempts ADD COLUMN Name TEXT").run(); } catch (e) {}
  try { await db.prepare("CREATE INDEX IF NOT EXISTS idx_login_attempts_name ON LoginAttempts(Name, At)").run(); } catch (e) {}
}

// Cache curto por isolate para não consultar o D1 em toda requisição de mídia.
// Logout/troca de senha valem na hora neste isolate e em até 20 s nos demais.
const CACHE_TTL_MS = 20_000;
const sessionCache = new Map<string, { user: SessionUser; exp: number }>();

export function invalidateSessionCache(predicate?: (u: SessionUser) => boolean) {
  if (!predicate) { sessionCache.clear(); return; }
  for (const [k, v] of sessionCache) if (predicate(v.user)) sessionCache.delete(k);
}

export async function lookupSession(
  db: D1Database,
  token: string,
  defaultPolicy: any,
  toUuid: (s: string) => string,
): Promise<SessionUser | null> {
  if (!token || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null;
  const now = Date.now();
  const hit = sessionCache.get(token);
  if (hit && hit.exp > now) return hit.user;

  const row: any = await db
    .prepare(
      "SELECT s.Token, s.DeviceId, s.DeviceName, s.Client, s.AppVersion, u.Id AS UId, u.Name AS UName, u.Policy AS UPolicy FROM Sessions s JOIN Users u ON u.Id = s.UserId WHERE s.Token = ?",
    )
    .bind(token)
    .first();
  if (!row) { sessionCache.delete(token); return null; }
  const policy = parsePolicy({ Id: row.UId, Name: row.UName, Policy: row.UPolicy }, defaultPolicy);
  if (policy.IsDisabled) return null;
  const user: SessionUser = {
    token,
    userId: row.UId,
    userUuid: toUuid(row.UId),
    name: row.UName,
    isAdmin: !!policy.IsAdministrator,
    deviceId: row.DeviceId || "",
    deviceName: row.DeviceName || "",
    client: row.Client || "",
    version: row.AppVersion || "",
  };
  if (sessionCache.size > 500) sessionCache.clear();
  sessionCache.set(token, { user, exp: now + CACHE_TTL_MS });
  return user;
}

export async function createSession(db: D1Database, userId: string, info: AuthInfo): Promise<string> {
  const token = randomHex(16);
  // Um token por usuário+dispositivo, como o Jellyfin faz.
  if (info.deviceId) {
    await db.prepare("DELETE FROM Sessions WHERE UserId = ? AND DeviceId = ?").bind(userId, info.deviceId).run();
  }
  await db
    .prepare("INSERT INTO Sessions (Token, UserId, DeviceId, DeviceName, Client, AppVersion) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(token, userId, info.deviceId || null, info.device || null, info.client || null, info.version || null)
    .run();
  return token;
}

export async function deleteSession(db: D1Database, token: string) {
  sessionCache.delete(token);
  await db.prepare("DELETE FROM Sessions WHERE Token = ?").bind(token).run();
}

export async function deleteUserSessions(db: D1Database, userId: string, exceptToken?: string) {
  invalidateSessionCache((u) => u.userId === userId && u.token !== exceptToken);
  if (exceptToken) {
    await db.prepare("DELETE FROM Sessions WHERE UserId = ? AND Token <> ?").bind(userId, exceptToken).run();
  } else {
    await db.prepare("DELETE FROM Sessions WHERE UserId = ?").bind(userId).run();
  }
}

// Proteção contra força bruta, por nome de usuário e por IP (janela de 15 min).
// Um login bem-sucedido só limpa as falhas daquele usuário naquele IP, então ter uma
// conta válida não zera o contador de quem tenta adivinhar a senha de outra conta.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_NAME = 10;
const MAX_FAILURES_PER_IP = 30;

function normName(name: string | undefined | null): string {
  return String(name || "").trim().toLowerCase();
}

export async function tooManyFailures(db: D1Database, ip: string, name?: string): Promise<boolean> {
  const since = Date.now() - WINDOW_MS;
  const byIp: any = await db.prepare("SELECT COUNT(*) AS n FROM LoginAttempts WHERE Ip = ? AND At > ?").bind(ip, since).first();
  if ((byIp?.n || 0) >= MAX_FAILURES_PER_IP) return true;
  if (name) {
    const byName: any = await db.prepare("SELECT COUNT(*) AS n FROM LoginAttempts WHERE Name = ? AND At > ?").bind(normName(name), since).first();
    if ((byName?.n || 0) >= MAX_FAILURES_PER_NAME) return true;
  }
  return false;
}

export async function recordFailure(db: D1Database, ip: string, name?: string) {
  const stmts = [db.prepare("INSERT INTO LoginAttempts (Ip, At, Name) VALUES (?, ?, ?)").bind(ip, Date.now(), normName(name))];
  if (Math.random() < 0.05) stmts.push(db.prepare("DELETE FROM LoginAttempts WHERE At < ?").bind(Date.now() - 24 * 3600 * 1000));
  await db.batch(stmts);
}

export async function clearFailures(db: D1Database, ip: string, name?: string) {
  await db.prepare("DELETE FROM LoginAttempts WHERE Ip = ? AND Name = ?").bind(ip, normName(name)).run();
}
