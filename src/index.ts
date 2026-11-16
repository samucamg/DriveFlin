import { Hono } from "hono";
import { cors } from "hono/cors";
import { Cipher } from "@fyears/rclone-crypt";
import { GoogleDrive } from "./gdrive";
import { runSync } from "./sync";
import { cleanMediaTitle, cleanEpisodeTitle, searchTmdb, getTmdbDetails, getTvSeasonEpisodes, searchTmdbRemote, getTmdbImages } from "./tmdb";
import { createDatabaseBackup, listDatabaseBackups, restoreDatabaseBackup } from "./backup";

type Bindings = {
  RCLONE_PASS: string;
  RCLONE_SALT: string;
  GDRIVE_CLIENT_ID: string;
  GDRIVE_CLIENT_SECRET: string;
  GDRIVE_REFRESH_TOKEN: string;
  GDRIVE_TEAM_DRIVE_ID: string;
  TMDB_API_KEY: string;
  GDRIVE_MEDIA_FOLDER_ID?: string;
  DB: D1Database;
};

const app = new Hono<{ Bindings: Bindings }>();

// Ativar CORS para todos os apps web/mobile do Jellyfin
app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: [
      "X-Emby-Authorization",
      "Content-Type",
      "Authorization",
      "Accept",
      "Range",
      "Origin",
    ],
    allowMethods: ["POST", "GET", "OPTIONS", "HEAD", "DELETE", "PUT"],
    exposeHeaders: ["Content-Range", "Content-Length", "Accept-Ranges"],
  }),
);

// Logging de requisições em tempo real para diagnóstico
app.use("*", async (c, next) => {
  const p = c.req.path;
  if (!p.startsWith("/web/") && !p.includes("socket") && !p.includes("SyncPlay")) {
    const ua = c.req.header("user-agent") || "";
    console.log(`[REQ] ${c.req.method} ${c.req.url} | UA: ${ua.slice(0, 60)}`);
  }
  await next();
});

function getImageTag(fileId: string | null | undefined): string | undefined {
  if (!fileId) return undefined;
  let hash = 0;
  for (let i = 0; i < fileId.length; i++) {
    hash = (hash << 5) - hash + fileId.charCodeAt(i);
    hash |= 0;
  }
  return "img_" + Math.abs(hash).toString(36);
}


const SERVER_ID = "639b4876bbb8b346ea020612bfe01ba8";
const DEFAULT_ADMIN_ID = "ee09da3140518fedd8b0f27b8b59bafb";
const DEFAULT_SESSION_ID = "7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d";

export function toValidUuid(str: string | null | undefined): string {
  if (!str) return DEFAULT_ADMIN_ID;
  const s = str.trim();
  if (s === DEFAULT_ADMIN_ID || s === "admin" || s.toLowerCase() === "me" || s === DEFAULT_ADMIN_ID) {
    return DEFAULT_ADMIN_ID;
  }
  if (s === SERVER_ID || s === SERVER_ID) {
    return SERVER_ID;
  }
  const clean = s.replace(/-/g, "").toLowerCase();
  if (/^[0-9a-f]{32}$/.test(clean)) {
    return clean;
  }
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57, h3 = 0x61c88647, h4 = 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
    h3 = Math.imul(h3 ^ ch, 2246822507);
    h4 = Math.imul(h4 ^ ch, 3266489909);
  }
  const toHex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return (toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4)).toLowerCase();
}

async function resolveLibrary(db: D1Database, idOrUuid: string | null | undefined): Promise<any> {
  if (!idOrUuid) return null;
  const clean = idOrUuid.trim().replace(/-/g, "").toLowerCase();
  let row = await db.prepare("SELECT * FROM Libraries WHERE Id = ? OR Uuid = ?").bind(idOrUuid, clean).first();
  if (row) return row;
  const computed = toValidUuid(idOrUuid);
  if (computed !== clean) {
    row = await db.prepare("SELECT * FROM Libraries WHERE Uuid = ?").bind(computed).first();
    if (row) return row;
  }
  if (/^[0-9a-f]{32}$/.test(clean)) {
    const { results } = await db.prepare("SELECT * FROM Libraries").all();
    for (const lib of (results || [])) {
      if (toValidUuid((lib as any).Id) === clean) return lib;
    }
  }
  return null;
}

async function resolveItem(db: D1Database, idOrUuid: string | null | undefined): Promise<any> {
  if (!idOrUuid) return null;
  const clean = idOrUuid.trim().replace(/-/g, "").toLowerCase();
  let row = await db.prepare("SELECT * FROM Items WHERE Id = ? OR Uuid = ?").bind(idOrUuid, clean).first();
  if (row) return row;
  const computed = toValidUuid(idOrUuid);
  if (computed !== clean) {
    row = await db.prepare("SELECT * FROM Items WHERE Uuid = ?").bind(computed).first();
    if (row) return row;
  }
  return null;
}

import { injectScript } from "./inject";
import { oauthHtml } from "./oauth_page";

let schemaReady = false;
async function ensureSchema(db: D1Database, env?: any) {
  if (schemaReady) return;
  try {
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS Users (
        Id TEXT PRIMARY KEY,
        Name TEXT NOT NULL,
        Password TEXT NOT NULL,
        Policy TEXT,
        Configuration TEXT
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS Libraries (
        Id TEXT PRIMARY KEY,
        Name TEXT NOT NULL,
        FolderId TEXT NOT NULL,
        CollectionType TEXT,
        PrimaryImageFileId TEXT
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS Items (
        Id TEXT PRIMARY KEY,
        ParentId TEXT,
        LibraryId TEXT,
        Type TEXT NOT NULL,
        Name TEXT NOT NULL,
        Overview TEXT,
        IndexNumber INTEGER,
        ParentIndexNumber INTEGER,
        FolderId TEXT,
        FileId TEXT,
        EncryptedName TEXT,
        Size INTEGER,
        PrimaryImageFileId TEXT,
        BackdropImageFileId TEXT,
        TmdbId TEXT,
        MediaInfo TEXT,
        DateCreated DATETIME DEFAULT CURRENT_TIMESTAMP
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS PlaybackProgress (
        Id TEXT PRIMARY KEY,
        UserId TEXT,
        ItemId TEXT,
        PositionTicks INTEGER,
        IsPaused BOOLEAN,
        LastUpdated DATETIME DEFAULT CURRENT_TIMESTAMP
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS Backups (
        Id TEXT PRIMARY KEY,
        Timestamp TEXT NOT NULL,
        Filename TEXT NOT NULL,
        FileId TEXT,
        Size INTEGER,
        Data TEXT
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS DebugLogs (
        time TEXT,
        log TEXT
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS UserItemData (
        UserId TEXT NOT NULL,
        ItemId TEXT NOT NULL,
        PlaybackPositionTicks INTEGER DEFAULT 0,
        Played BOOLEAN DEFAULT 0,
        IsFavorite BOOLEAN DEFAULT 0,
        LastPlayedDate DATETIME,
        PRIMARY KEY (UserId, ItemId)
      )`)
    ]);

    try {
      await db.prepare("ALTER TABLE Items ADD COLUMN Uuid TEXT").run();
    } catch (e) {}
    try {
      await db.prepare("CREATE INDEX IF NOT EXISTS idx_items_uuid ON Items(Uuid)").run();
    } catch (e) {}
    try {
      await db.prepare("ALTER TABLE Libraries ADD COLUMN Uuid TEXT").run();
    } catch (e) {}
    try {
      await db.prepare("ALTER TABLE Libraries ADD COLUMN BackdropImageFileId TEXT").run();
    } catch (e) {}
    try {
      await db.prepare("CREATE INDEX IF NOT EXISTS idx_libraries_uuid ON Libraries(Uuid)").run();
    } catch (e) {}

    const defaultPassword = "admin";
    const user = await db.prepare("SELECT Id, Password FROM Users WHERE Name = 'admin' OR Id = ? LIMIT 1").bind(DEFAULT_ADMIN_ID).first();
    if (!user) {
      await db.prepare("INSERT INTO Users (Id, Name, Password) VALUES (?, ?, ?)")
        .bind(DEFAULT_ADMIN_ID, "admin", defaultPassword)
        .run();
    } else if (!user.Password || user.Password === "Filmes@2026") {
      await db.prepare("UPDATE Users SET Password = ? WHERE Id = ?")
        .bind(defaultPassword, user.Id)
        .run();
    }
    const confirmedAdmin = await db.prepare("SELECT Id FROM Users WHERE Name = 'admin' OR Id = ? LIMIT 1").bind(DEFAULT_ADMIN_ID).first();
    if (confirmedAdmin) {
      schemaReady = true;
    }
  } catch (e) {
    console.error("ensureSchema error:", e);
  }
}

app.use("*", async (c, next) => {
  if (c.env?.DB && !schemaReady) {
    await ensureSchema(c.env.DB, c.env);
  }
  await next();
});

// ROTAS DO GERADOR DE TOKEN OAUTH
app.get("/oauth", (c) => c.html(oauthHtml));
app.get("/token", (c) => c.html(oauthHtml));
app.get("/generator", (c) => c.html(oauthHtml));

app.post("/api/oauth/exchange", async (c) => {
  try {
    const { code, clientId, clientSecret } = await c.req.json();
    if (!code || !clientId || !clientSecret) {
      return c.json({ success: false, error: "Parâmetros incompletos: informe code, clientId e clientSecret." }, 400);
    }

    let authCode = code.trim();
    if (authCode.startsWith("http")) {
      try {
        const parsed = new URL(authCode);
        authCode = parsed.searchParams.get("code") || authCode;
      } catch (e) {}
    }

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: authCode,
        client_id: clientId.trim(),
        client_secret: clientSecret.trim(),
        redirect_uri: "http://localhost",
        grant_type: "authorization_code",
      }),
    });

    const data: any = await tokenRes.json();
    if (data.error) {
      return c.json({
        success: false,
        error: data.error_description || data.error || "Falha ao trocar código de autorização.",
      }, 400);
    }

    return c.json({
      success: true,
      refresh_token: data.refresh_token,
      access_token: data.access_token,
      expires_in: data.expires_in,
    });
  } catch (err: any) {
    return c.json({ success: false, error: err.message || err.toString() }, 500);
  }
});

// PROXY DA INTERFACE WEB DO JELLYFIN
app.get("/", (c) => c.redirect("/web/index.html"));


app.post("/debug_log", async (c) => {
  const body = await c.req.text();
  await c.env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS DebugLogs (time TEXT, log TEXT)",
  ).run();
  await c.env.DB.prepare(
    "INSERT INTO DebugLogs (time, log) VALUES (datetime('now'), ?)",
  )
    .bind(body)
    .run();
  return c.text("ok");
});

app.get("/debug_logs", async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM DebugLogs ORDER BY time DESC LIMIT 50",
    ).all();
    return c.json(results);
  } catch (e: any) {
    return c.json({ error: e.toString() });
  }
});

app.get("/web/ConfigurationPages", (c) => c.json([]));
app.get("/ConfigurationPages", (c) => c.json([]));

app.get("/fix-uuid", async (c) => {
  const items = await c.env.DB.prepare("SELECT Id FROM Items").all<{ Id: string }>();
  for (const item of items.results) {
    await c.env.DB.prepare("UPDATE Items SET Uuid = ? WHERE Id = ?").bind(toValidUuid(item.Id), item.Id).run();
  }
  const libs = await c.env.DB.prepare("SELECT Id FROM Libraries").all<{ Id: string }>();
  for (const lib of libs.results) {
    await c.env.DB.prepare("UPDATE Libraries SET Uuid = ? WHERE Id = ?").bind(toValidUuid(lib.Id), lib.Id).run();
  }
  return c.text("Fixed UUIDs");
});

app.get("/web/*", async (c) => {
  const url = new URL(c.req.url);
  const targetUrl = `https://demo.jellyfin.org/stable${url.pathname}${url.search}`;

  const newHeaders = new Headers(c.req.header());
  newHeaders.delete("accept-encoding");
  const response = await fetch(targetUrl, {
    headers: newHeaders,
  });

  if (url.pathname.endsWith("index.html")) {
    let html = await response.text();
    html = html.replace("</head>", `${injectScript}</head>`);
    return new Response(html, {
      headers: {
        "Content-Type": "text/html",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  const proxyResponse = new Response(response.body, response);
  proxyResponse.headers.set("Access-Control-Allow-Origin", "*");
  return proxyResponse;
});

// Rota para disparar o Sync manualmente
app.get("/sync", async (c) => {
  try {
    await runSync(c.env);
    return c.json({ message: "Sync completed successfully" });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Dashboard de Setup Simples
app.get("/setup", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM Libraries").all();
  let html = `<html><head><title>DriveFlin Setup</title><style>body{font-family:sans-serif;padding:20px;background:#141414;color:#fff;}table{width:100%;border-collapse:collapse;margin-bottom:20px;}th,td{border:1px solid #333;padding:10px;text-align:left;}input{padding:5px;}button{padding:8px 15px;background:#e50914;color:white;border:none;cursor:pointer;}</style></head><body>
    <h1>DriveFlin Library Setup</h1>
    <table>
      <tr><th>ID</th><th>Name</th><th>Google Drive Folder ID</th><th>Action</th></tr>`;

  results.forEach((lib: any) => {
    html += `<tr>
      <form method="POST" action="/setup/delete">
      <td>${lib.Id}</td><td>${lib.Name}</td><td>${lib.FolderId}</td>
      <td><input type="hidden" name="id" value="${lib.Id}"/><button type="submit">Delete</button></td>
      </form></tr>`;
  });

  html += `</table>
    <h2>Add New Library</h2>
    <form method="POST" action="/setup/add">
      <input type="text" name="id" placeholder="ID (e.g. view_filmes_acao)" required />
      <input type="text" name="name" placeholder="Name (e.g. Filmes de Ação)" required />
      <input type="text" name="folderId" placeholder="Google Drive Folder ID" required />
      <button type="submit">Add Library</button>
    </form>
    <br/><br/>
    <form method="GET" action="/sync"><button type="submit">Run Sync Now</button></form>
    </body></html>`;
  return c.html(html);
});

app.post("/setup/add", async (c) => {
  const body = await c.req.parseBody();
  const libId = body.id as string;
  await c.env.DB.prepare(
    "INSERT INTO Libraries (Id, Name, FolderId, Uuid) VALUES (?, ?, ?, ?)",
  )
    .bind(libId, body.name, body.folderId, toValidUuid(libId))
    .run();
  return c.redirect("/setup");
});

app.post("/setup/delete", async (c) => {
  const body = await c.req.parseBody();
  await c.env.DB.prepare("DELETE FROM Libraries WHERE Id = ?")
    .bind(body.id)
    .run();
  return c.redirect("/setup");
});

// JELLYFIN MOCK API

const getSystemInfo = (c: any) => {
  const url = new URL(c.req.url);
  const origin = `${url.protocol}//${url.host}`;
  const port = url.port ? parseInt(url.port) : (url.protocol === "https:" ? 443 : 80);
  return c.json({
    SystemUpdateLevel: "Release",
    OperatingSystemDisplayName: "Linux",
    PackageName: "jellyfin",
    HasPendingRestart: false,
    IsShuttingDown: false,
    OperatingSystem: "Linux",
    SupportsLibraryMonitor: false,
    WebSocketPortNumber: port,
    CompletedInstallations: [],
    CanSelfRestart: false,
    CanLaunchWebBrowser: false,
    ProgramDataPath: "/config",
    ItemsByNamePath: "/config/data/metadata/itemsbyname",
    CachePath: "/cache",
    LogPath: "/config/log",
    InternalMetadataPath: "/config/data/metadata",
    TranscodingTempPath: "/config/transcodes",
    HasUpdateAvailable: false,
    EncoderLocation: "NotFound",
    CastReceiverApplications: [
      {
        Id: "F007D354",
        Name: "Google Cast",
      },
    ],
    LocalAddress: origin,
    WanAddress: origin,
    ServerName: "DriveFlin",
    Version: "12.0.0",
    ProductName: "Jellyfin Server",
    Id: SERVER_ID,
    StartupWizardCompleted: true,
  });
};

// 1. System Info (Server Discovery)
app.get("/System/Info/Public", getSystemInfo);
app.get("/system/info/public", getSystemInfo);
app.get("/System/Info", getSystemInfo);
app.get("/system/info", getSystemInfo);
app.get("/System/Endpoint", (c) => c.json({ IsLocal: false, IsInNetwork: false }));
app.get("/system/endpoint", (c) => c.json({ IsLocal: false, IsInNetwork: false }));

// WebSocket support for Jellyfin live session updates
app.get("/socket", (c) => {
  const upgradeHeader = c.req.header("Upgrade") || c.req.header("upgrade");
  if (upgradeHeader === "websocket") {
    const pair = new (globalThis as any).WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    (server as any).accept();
    server.addEventListener("message", (event: any) => {
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) : {};
        if (data.MessageType === "KeepAlive") {
          server.send(JSON.stringify({ MessageType: "KeepAlive" }));
        }
      } catch (e) {}
    });
    return new Response(null, { status: 101, webSocket: client } as any);
  }
  return c.text("WebSocket upgrade expected", 426);
});
app.get("/socket/*", (c) => {
  const upgradeHeader = c.req.header("Upgrade") || c.req.header("upgrade");
  if (upgradeHeader === "websocket") {
    const pair = new (globalThis as any).WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    (server as any).accept();
    return new Response(null, { status: 101, webSocket: client } as any);
  }
  return c.text("WebSocket upgrade expected", 426);
});

// Web UI Requirements & Administration
const defaultBrandingConfig = {
  LoginDisclaimer: "",
  CustomCss: `@import url('https://cdn.jsdelivr.net/gh/prayag17/JellyFlix@latest/default.css');
@import url('https://cdn.jsdelivr.net/gh/prayag17/JellyFlix@latest/addons/Logo.css');

:root {
  --accent: #E50914 !important;
  --accent-hover: #b80710 !important;
  --theme-primary-color: #E50914 !important;
  --primary-accent-color: #E50914 !important;
}
.skinHeader, .mainDrawer {
  background-color: rgba(20, 20, 20, 0.95) !important;
}
.cardBox {
  border-radius: 4px;
  overflow: hidden;
  transition: transform 0.22s ease, box-shadow 0.22s ease;
}
.card:hover .cardBox {
  transform: scale(1.04);
  box-shadow: 0 8px 24px rgba(0,0,0,0.8);
  z-index: 10;
}
.badge-count {
  background: #E50914 !important;
}`,
};

app.get("/Branding/Configuration", async (c) => {
  try {
    const row: any = await c.env.DB.prepare("SELECT Value FROM Config WHERE Key = 'BrandingConfig'").first();
    if (row && row.Value) {
      return c.json({ ...defaultBrandingConfig, ...JSON.parse(row.Value) });
    }
  } catch (e) {}
  return c.json(defaultBrandingConfig);
});

app.post("/Branding/Configuration", async (c) => {
  try {
    const body = await c.req.json();
    await c.env.DB.prepare(
      "INSERT INTO Config (Key, Value) VALUES ('BrandingConfig', ?) ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value"
    ).bind(JSON.stringify(body)).run();
  } catch (e) {}
  return c.body(null, 204);
});

app.get("/Branding/Css", async (c) => {
  let css = defaultBrandingConfig.CustomCss;
  try {
    const row: any = await c.env.DB.prepare("SELECT Value FROM Config WHERE Key = 'BrandingConfig'").first();
    if (row && row.Value) {
      const parsed = JSON.parse(row.Value);
      if (parsed.CustomCss !== undefined) css = parsed.CustomCss;
    }
  } catch (e) {}
  return c.text(css, 200, { "Content-Type": "text/css" });
});

app.get("/Branding/Css.css", async (c) => {
  let css = defaultBrandingConfig.CustomCss;
  try {
    const row: any = await c.env.DB.prepare("SELECT Value FROM Config WHERE Key = 'BrandingConfig'").first();
    if (row && row.Value) {
      const parsed = JSON.parse(row.Value);
      if (parsed.CustomCss !== undefined) css = parsed.CustomCss;
    }
  } catch (e) {}
  return c.text(css, 200, { "Content-Type": "text/css" });
});

app.get("/Branding/Logo", (c) => c.redirect("/Items/branding_logo/Images/Primary", 302));
app.get("/Branding/Splashscreen", (c) => c.redirect("/Items/branding_logo/Images/Primary", 302));

const defaultSystemConfig = {
  ServerName: "Serverless Jellyfin",
  UICulture: "pt-BR",
  PreferredMetadataLanguage: "pt",
  MetadataCountryCode: "BR",
  IsStartupWizardCompleted: true,
  EnableMetrics: false,
  SaveMetadataHidden: false,
  EnableGroupingIntoCollections: true,
  DisplaySpecialsWithinSeasons: true,
  SortReplaceCharacters: [".", "+", "%"],
  SortRemoveCharacters: [",", "&", "-", "{", "}", "'"],
  SortRemoveWords: ["the", "a", "an", "o", "a", "os", "as"],
  LibraryMonitorDelay: 60,
  EnableDashboardResponseCaching: true,
  ImageSavingConvention: "Compatible",
  PublicPort: 443,
  PublicHttpsPort: 443,
  HttpServerPortNumber: 80,
  HttpsPortNumber: 443,
  EnableHttps: true,
  EnableNormalizedItemByNameIds: true,
  AutoRunExternalScripts: false,
  EnableSlowResponseWarning: false,
  SlowResponseThresholdMs: 500,
  CorsHosts: ["*"],
  ActivityLogRetentionDays: 30,
  LibraryScanFanoutConcurrency: 0,
  LibraryMetadataRefreshConcurrency: 0,
  Directories: [],
  QuickConnectAvailable: false,
  CastReceiverApplications: [
    {
      Id: "F007D354",
      Name: "Google Cast",
    },
  ],
};

app.get("/System/Configuration", async (c) => {
  try {
    const row: any = await c.env.DB.prepare("SELECT Value FROM Config WHERE Key = 'SystemConfig'").first();
    if (row && row.Value) {
      return c.json({ ...defaultSystemConfig, ...JSON.parse(row.Value) });
    }
  } catch (e) {}
  return c.json(defaultSystemConfig);
});

app.post("/System/Configuration", async (c) => {
  try {
    const body = await c.req.json();
    await c.env.DB.prepare(
      "INSERT INTO Config (Key, Value) VALUES ('SystemConfig', ?) ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value"
    ).bind(JSON.stringify(body)).run();
  } catch (e) {}
  return c.body(null, 204);
});

app.get("/System/Configuration/:key", async (c) => {
  const key = c.req.param("key");
  try {
    const row: any = await c.env.DB.prepare("SELECT Value FROM Config WHERE Key = ?").bind(`SystemConfig_${key}`).first();
    if (row && row.Value) {
      return c.json(JSON.parse(row.Value));
    }
  } catch (e) {}
  return c.json({});
});

app.post("/System/Configuration/:key", async (c) => {
  const key = c.req.param("key");
  try {
    const body = await c.req.json();
    await c.env.DB.prepare(
      "INSERT INTO Config (Key, Value) VALUES (?, ?) ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value"
    ).bind(`SystemConfig_${key}`, JSON.stringify(body)).run();
  } catch (e) {}
  return c.body(null, 204);
});

app.get("/Localization/Options", (c) =>
  c.json([
    { Name: "Português (Brasil)", Value: "pt-BR" },
    { Name: "English (United States)", Value: "en-US" },
  ]),
);

app.get("/Localization/Cultures", (c) =>
  c.json([
    {
      Name: "pt-BR",
      DisplayName: "Português (Brasil)",
      TwoLetterISOLanguageName: "pt",
      ThreeLetterISOLanguageName: "por",
    },
    {
      Name: "en-US",
      DisplayName: "English (United States)",
      TwoLetterISOLanguageName: "en",
      ThreeLetterISOLanguageName: "eng",
    },
  ]),
);

app.get("/Localization/Countries", (c) =>
  c.json([
    {
      Name: "Brazil",
      DisplayName: "Brasil",
      TwoLetterISORegionName: "BR",
      ThreeLetterISORegionName: "BRA",
    },
    {
      Name: "United States",
      DisplayName: "Estados Unidos",
      TwoLetterISORegionName: "US",
      ThreeLetterISORegionName: "USA",
    },
  ]),
);

app.get("/Localization/ParentalRatings", (c) =>
  c.json([
    { Name: "Livre", Value: 0 },
    { Name: "10", Value: 10 },
    { Name: "12", Value: 12 },
    { Name: "14", Value: 14 },
    { Name: "16", Value: 16 },
    { Name: "18", Value: 18 },
  ]),
);

app.get("/Items/Counts", async (c) => {
  const movieCount: any = await c.env.DB.prepare("SELECT COUNT(*) as c FROM Items WHERE Type = 'Movie'").first();
  const seriesCount: any = await c.env.DB.prepare("SELECT COUNT(*) as c FROM Items WHERE Type = 'Series'").first();
  const episodeCount: any = await c.env.DB.prepare("SELECT COUNT(*) as c FROM Items WHERE Type = 'Episode'").first();
  const songCount: any = await c.env.DB.prepare("SELECT COUNT(*) as c FROM Items WHERE Type = 'Audio'").first();
  const m = movieCount?.c || 0;
  const s = seriesCount?.c || 0;
  const e = episodeCount?.c || 0;
  const a = songCount?.c || 0;
  return c.json({
    MovieCount: m,
    SeriesCount: s,
    EpisodeCount: e,
    SongCount: a,
    MusicVideoCount: 0,
    BoxSetCount: 0,
    BookCount: 0,
    ItemCount: m + s + e + a,
  });
});

app.get("/Sessions", (c) => c.json([]));

app.get("/Devices", (c) => c.json({ Items: [], TotalRecordCount: 0 }));
app.get("/Devices/Info", (c) => c.json({}));
app.get("/Devices/Options", (c) => c.json({}));
app.delete("/Devices", (c) => c.body(null, 204));

app.get("/System/ActivityLog/Entries", (c) =>
  c.json({ Items: [], TotalRecordCount: 0, StartIndex: 0 }),
);

app.get("/System/Info/Storage", (c) =>
  c.json({
    CacheFolder: {
      Path: "/cache",
      DeviceId: "Google Drive (Cloud)",
      StorageType: "Network",
      UsedSpace: 120000000,
      FreeSpace: 8500000000000,
    },
    ImageCacheFolder: {
      Path: "/config/data/metadata/itemsbyname",
      DeviceId: "Google Drive (Cloud)",
      StorageType: "Network",
      UsedSpace: 350000000,
      FreeSpace: 8500000000000,
    },
    ProgramDataFolder: {
      Path: "/config",
      DeviceId: "Cloudflare D1",
      StorageType: "Fixed",
      UsedSpace: 25000000,
      FreeSpace: 10000000000,
    },
    LogFolder: {
      Path: "/config/log",
      DeviceId: "Cloudflare Workers",
      StorageType: "Ram",
      UsedSpace: 5000000,
      FreeSpace: 128000000,
    },
    InternalMetadataFolder: {
      Path: "/config/data/metadata",
      DeviceId: "Cloudflare D1",
      StorageType: "Fixed",
      UsedSpace: 80000000,
      FreeSpace: 10000000000,
    },
    TranscodingTempFolder: {
      Path: "/config/transcodes",
      DeviceId: "RAM Edge",
      StorageType: "Ram",
      UsedSpace: 0,
      FreeSpace: 128000000,
    },
    WebFolder: {
      Path: "/jellyfin-web",
      DeviceId: "Cloudflare Pages",
      StorageType: "Fixed",
      UsedSpace: 45000000,
      FreeSpace: 10000000000,
    },
  })
);

// Volatile in-memory task state (resets on cold start — perfectly acceptable for serverless)
let scanTaskState: "Idle" | "Running" = "Idle";
let scanTaskLastRun = new Date().toISOString();
let backupTaskState: "Idle" | "Running" = "Idle";
let backupTaskLastRun = new Date().toISOString();

const getScheduledTasksList = () => {
  return [
    {
      Name: "Escanear Bibliotecas",
      State: scanTaskState,
      CurrentProgressPercentage: scanTaskState === "Running" ? 50 : 0,
      Id: toValidUuid("task_scan_library"),
      Description: "Escaneia o Google Drive em busca de novos filmes, séries e músicas",
      Category: "Library",
      IsHidden: false,
      Key: "RefreshLibrary",
      Triggers: [{ Type: "HourlyTrigger" }],
      LastExecutionResult: {
        StartTimeUtc: scanTaskLastRun,
        EndTimeUtc: scanTaskLastRun,
        Status: "Completed",
        Name: "Escanear Bibliotecas",
        Key: "RefreshLibrary",
        Id: toValidUuid("task_scan_library"),
      },
    },
    {
      Name: "Backup do Banco de Dados",
      State: backupTaskState,
      CurrentProgressPercentage: backupTaskState === "Running" ? 50 : 0,
      Id: toValidUuid("task_backup_database"),
      Description: "Exporta backup completo do DriveFlin para a pasta DriveFlin_Backups no Google Drive",
      Category: "Maintenance",
      IsHidden: false,
      Key: "BackupDatabase",
      Triggers: [{ Type: "DailyTrigger", TimeOfDayTicks: 0 }],
      LastExecutionResult: {
        StartTimeUtc: backupTaskLastRun,
        EndTimeUtc: backupTaskLastRun,
        Status: "Completed",
        Name: "Backup do Banco de Dados",
        Key: "BackupDatabase",
        Id: toValidUuid("task_backup_database"),
      },
    },
  ];
};

app.get("/ScheduledTasks", (c) => {
  return c.json(getScheduledTasksList());
});

app.get("/ScheduledTasks/:taskId", (c) => {
  const tasks = getScheduledTasksList();
  const task = tasks.find((t) => t.Id === c.req.param("taskId")) || tasks[0];
  return c.json(task);
});

app.post("/ScheduledTasks/Running/:taskId", async (c) => {
  const taskId = c.req.param("taskId");
  if (taskId === "task_backup_database") {
    backupTaskState = "Running";
    const backupPromise = createDatabaseBackup(c.env).then(() => {
      backupTaskState = "Idle";
      backupTaskLastRun = new Date().toISOString();
    }).catch(() => { backupTaskState = "Idle"; });
    try { c.executionCtx?.waitUntil(backupPromise); } catch (e) {}
  } else {
    scanTaskState = "Running";
    const syncPromise = runSync(c.env).then(() => {
      scanTaskState = "Idle";
      scanTaskLastRun = new Date().toISOString();
    }).catch(() => { scanTaskState = "Idle"; });
    try { c.executionCtx?.waitUntil(syncPromise); } catch (e) {}
  }
  return c.body(null, 204);
});

app.delete("/ScheduledTasks/Running/:taskId", (c) => {
  return c.body(null, 204);
});


app.get("/System/Logs", (c) => c.json([]));
app.get("/Plugins", (c) => c.json([]));
app.get("/Plugins/Configuration", (c) => c.json({}));
const handleMediaFolders = async (c: any) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM Libraries").all();
  return c.json({
    Items: results.map((r: any) => ({
      Name: r.Name,
      Id: r.Id,
      Path: r.FolderId,
      Type: "CollectionFolder",
      IsFolder: true,
      CollectionType: r.CollectionType || (r.Name.toLowerCase().includes("filme") ? "movies" : "tvshows"),
      PrimaryImageItemId: r.Id,
      PrimaryImageTag: getImageTag(r.PrimaryImageFileId) || "cached",
      ImageTags: { Primary: getImageTag(r.PrimaryImageFileId) || "cached" },
      SubFolders: [],
    })),
    TotalRecordCount: results.length,
  });
};
app.get("/Library/MediaFolders", handleMediaFolders);
app.get("/library/mediafolders", handleMediaFolders);

app.get("/Encoding/CustomPath", (c) => c.json({}));
app.get("/Encoding/CodecCapabilities", (c) => c.json([]));
app.get("/Encoding/CodecInformation", (c) => c.json([]));

app.get("/QuickConnect/Enabled", (c) => c.text("false"));
app.get("/Channels", (c) => c.json({ Items: [], TotalRecordCount: 0 }));
app.get("/Channels/Features", (c) => c.json({ Items: [] }));

const defaultUserConfig = {
  CastReceiverId: "F007D354",
  PlayDefaultAudioTrack: true,
  SubtitleLanguagePreference: "por",
  DisplayMissingEpisodes: false,
  EnableNextEpisodeAutoPlay: true,
  RememberAudioSelections: true,
  RememberSubtitleSelections: true,
};

const defaultPolicy = {
  IsAdministrator: true,
  IsHidden: false,
  EnableCollectionManagement: true,
  EnableSubtitleManagement: true,
  EnableLyricManagement: true,
  IsDisabled: false,
  EnableUserPreferenceAccess: true,
  EnableRemoteControlOfOtherUsers: true,
  EnableSharedDeviceControl: true,
  EnableRemoteAccess: true,
  EnableLiveTvManagement: true,
  EnableLiveTvAccess: true,
  EnableMediaPlayback: true,
  EnableAudioPlaybackTranscoding: true,
  EnableVideoPlaybackTranscoding: true,
  EnablePlaybackRemuxing: true,
  ForceRemoteSourceTranscoding: false,
  EnableContentDeletion: false,
  EnableContentDownloading: true,
  EnableSyncTranscoding: true,
  EnableMediaConversion: true,
  EnableAllDevices: true,
  EnableAllChannels: true,
  EnableAllFolders: true,
  EnabledFolders: [],
  BlockedMediaFolders: [],
  BlockedChannels: [],
  AuthenticationProviderId: "Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider",
  PasswordResetProviderId: "Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider",
  SyncPlayAccess: "CreateAndJoinGroups",
};

app.get("/users/public", async (c) => {
  try {
    const { results } = await c.env.DB.prepare("SELECT Id, Name FROM Users").all();
    return c.json(
      results.map((u: any) => ({
        Name: u.Name,
        Id: toValidUuid(u.Id),
        ServerId: SERVER_ID,
        HasPassword: true,
        HasConfiguredPassword: true,
      }))
    );
  } catch (e) {
    return c.json([
      {
        Name: "admin",
        Id: DEFAULT_ADMIN_ID,
        ServerId: SERVER_ID,
        HasPassword: true,
        HasConfiguredPassword: true,
      },
    ]);
  }
});
app.get("/Users/Public", async (c) => c.redirect("/users/public", 307));

// 2. Authentication and User Management
app.get("/Users", async (c) => {
  try {
    try { await c.env.DB.prepare("ALTER TABLE Users ADD COLUMN Policy TEXT").run(); } catch (e) {}
    try { await c.env.DB.prepare("ALTER TABLE Users ADD COLUMN Configuration TEXT").run(); } catch (e) {}

    const { results } = await c.env.DB.prepare("SELECT * FROM Users").all();
    return c.json(
      results.map((u: any) => {
        let policy = defaultPolicy;
        try { if (u.Policy) policy = { ...defaultPolicy, ...JSON.parse(u.Policy) }; } catch (e) {}
        let config = defaultUserConfig;
        try { if (u.Configuration) config = { ...defaultUserConfig, ...JSON.parse(u.Configuration) }; } catch (e) {}
        return {
          Name: u.Name,
          Id: toValidUuid(u.Id),
          ServerId: SERVER_ID,
          HasPassword: true,
          HasConfiguredPassword: true,
          Policy: policy,
          Configuration: config,
        };
      })
    );
  } catch (e) {
    return c.json([
      {
        Name: "admin",
        Id: DEFAULT_ADMIN_ID,
        ServerId: SERVER_ID,
        HasPassword: true,
        HasConfiguredPassword: true,
        Policy: defaultPolicy,
        Configuration: defaultUserConfig,
      },
    ]);
  }
});
app.get("/users", async (c) => c.redirect("/Users", 307));

app.post("/Users/New", async (c) => {
  let body: any = {};
  try { body = await c.req.json(); } catch (e) {}
  const name = body.Name || "Novo Usuario";
  const password = body.Password || "";
  const id = crypto.randomUUID().replace(/-/g, "").toLowerCase();

  try { await c.env.DB.prepare("ALTER TABLE Users ADD COLUMN Policy TEXT").run(); } catch (e) {}
  try { await c.env.DB.prepare("ALTER TABLE Users ADD COLUMN Configuration TEXT").run(); } catch (e) {}

  const userPolicy = {
    ...defaultPolicy,
    IsAdministrator: false,
    EnableAllFolders: true,
    EnabledFolders: [],
  };

  await c.env.DB.prepare(
    "INSERT INTO Users (Id, Name, Password, Policy, Configuration) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, name, password, JSON.stringify(userPolicy), JSON.stringify(defaultUserConfig)).run();

  return c.json({
    Name: name,
    Id: id,
    ServerId: SERVER_ID,
    HasPassword: !!password,
    HasConfiguredPassword: !!password,
    Policy: userPolicy,
    Configuration: defaultUserConfig,
  });
});
app.post("/users/new", async (c) => c.redirect("/Users/New", 307));

app.post("/Users/AuthenticateByName", handleAuth);
app.post("/Users/authenticatebyname", handleAuth);
app.post("/users/authenticatebyname", handleAuth);
app.post("/users/AuthenticateByName", handleAuth);

async function handleAuth(c: any) {
  let body: any = {};
  try {
    body = await c.req.json();
  } catch (e) {
    try {
      body = await c.req.parseBody();
    } catch (e2) {}
  }
  const Username = body.Username || body.username || c.req.query("Username") || c.req.query("username") || "admin";
  const Pw = body.Pw || body.pw || body.Password || body.password || "";

  let user: any = null;
  try {
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM Users WHERE LOWER(Name) = LOWER(?)"
    )
      .bind(Username)
      .all();
    if (results && results.length) {
      user = results[0];
    }
  } catch (e) {}

  if (!user && (Username.toLowerCase() === "admin" || !Username)) {
    try {
      await ensureSchema(c.env.DB, c.env);
      user = await c.env.DB.prepare("SELECT * FROM Users WHERE Name = 'admin' OR Id = ? LIMIT 1").bind(DEFAULT_ADMIN_ID).first();
      if (!user) {
        await c.env.DB.prepare("INSERT INTO Users (Id, Name, Password) VALUES (?, ?, ?)")
          .bind(DEFAULT_ADMIN_ID, "admin", "admin")
          .run();
        user = { Id: DEFAULT_ADMIN_ID, Name: "admin", Password: "admin" };
      }
    } catch (e) {}
  }

  if (!user) {
    return c.json({ error: "Invalid username" }, 401);
  }
  if (user.Password && Pw && user.Password !== Pw) {
    return c.json({ error: "Invalid password" }, 401);
  }

  const userId = toValidUuid(user.Id);

  let policy = defaultPolicy;
  try { if (user.Policy) policy = { ...defaultPolicy, ...JSON.parse(user.Policy) }; } catch (e) {}
  let config = defaultUserConfig;
  try { if (user.Configuration) config = { ...defaultUserConfig, ...JSON.parse(user.Configuration) }; } catch (e) {}

  const clientName = c.req.header("X-Emby-Client") || "Jellyfin Client";
  const deviceName = c.req.header("X-Emby-Device-Name") || "Device";
  const deviceId = c.req.header("X-Emby-Device-Id") || "device_123";
  const clientVersion = c.req.header("X-Emby-Client-Version") || "12.0.0";

  return c.json({
    User: {
      Name: user.Name,
      ServerId: SERVER_ID,
      Id: userId,
      HasPassword: true,
      HasConfiguredPassword: true,
      HasConfiguredEasyPassword: false,
      EnableAutoLogin: false,
      LastLoginDate: new Date().toISOString(),
      LastActivityDate: new Date().toISOString(),
      Configuration: config,
      Policy: policy,
    },
    SessionInfo: {
      PlayState: {
        CanSeek: true,
        IsPaused: false,
        IsMuted: false,
        RepeatMode: "RepeatNone",
      },
      AdditionalUsers: [],
      Capabilities: {
        PlayableMediaTypes: ["Audio", "Video"],
        SupportedCommands: [],
        SupportsMediaControl: true,
        SupportsPersistentIdentifier: true,
      },
      RemoteEndPoint: "127.0.0.1",
      PlayableMediaTypes: ["Audio", "Video"],
      Id: DEFAULT_SESSION_ID,
      UserId: userId,
      UserName: user.Name,
      Client: clientName,
      LastActivityDate: new Date().toISOString(),
      DeviceName: deviceName,
      DeviceId: deviceId,
      ApplicationVersion: clientVersion,
      IsActive: true,
      SupportsMediaControl: true,
      ServerId: SERVER_ID,
    },
    AccessToken: "fake_jwt_token_12345",
    ServerId: SERVER_ID,
  });
}

const handleCurrentUser = async (c: any) => {
  let user: any = null;
  try {
    user = await c.env.DB.prepare("SELECT * FROM Users WHERE Id = ? OR Name = 'admin' LIMIT 1").bind(DEFAULT_ADMIN_ID).first();
  } catch (e) {}

  let policy = defaultPolicy;
  let config = defaultUserConfig;
  let name = user?.Name || "admin";
  let id = user?.Id ? toValidUuid(user.Id) : DEFAULT_ADMIN_ID;

  if (user) {
    try { if (user.Policy) policy = { ...defaultPolicy, ...JSON.parse(user.Policy) }; } catch (e) {}
    try { if (user.Configuration) config = { ...defaultUserConfig, ...JSON.parse(user.Configuration) }; } catch (e) {}
  }

  return c.json({
    Name: name,
    Id: id,
    ServerId: SERVER_ID,
    ServerName: "DriveFlin",
    HasPassword: true,
    HasConfiguredPassword: true,
    HasConfiguredEasyPassword: false,
    EnableAutoLogin: true,
    Configuration: config,
    Policy: policy,
  });
};

app.get("/Users/Me", handleCurrentUser);
app.get("/users/me", handleCurrentUser);
app.get("/Users/me", handleCurrentUser);
app.get("/users/Me", handleCurrentUser);

const handleGetUserById = async (c: any) => {
  const rawId = c.req.param("userId");
  if (!rawId || rawId.toLowerCase() === "me") {
    return handleCurrentUser(c);
  }

  const validId = toValidUuid(rawId);
  let user: any = null;
  try {
    user = await c.env.DB.prepare("SELECT * FROM Users WHERE Id = ? OR Id = ?").bind(rawId, validId).first();
  } catch (e) {}

  if (!user && (rawId === DEFAULT_ADMIN_ID || rawId === DEFAULT_ADMIN_ID || rawId.toLowerCase() === "admin")) {
    try {
      user = await c.env.DB.prepare("SELECT * FROM Users WHERE Name = 'admin' LIMIT 1").first();
    } catch (e) {}
  }

  let policy = defaultPolicy;
  let config = defaultUserConfig;
  let name = user?.Name || "admin";
  const id = user?.Id ? toValidUuid(user.Id) : validId;

  if (user) {
    try { if (user.Policy) policy = { ...defaultPolicy, ...JSON.parse(user.Policy) }; } catch (e) {}
    try { if (user.Configuration) config = { ...defaultUserConfig, ...JSON.parse(user.Configuration) }; } catch (e) {}
  }

  return c.json({
    Name: name,
    Id: id,
    ServerId: SERVER_ID,
    HasPassword: true,
    HasConfiguredPassword: true,
    Configuration: config,
    Policy: policy,
  });
};


app.post("/Users/:userId", async (c) => {
  try {
    const rawId = c.req.param("userId");
    const userId = toValidUuid(rawId);
    const body = await c.req.json();
    
    await c.env.DB.prepare("UPDATE Users SET Name = ? WHERE Id = ? OR Id = ?")
      .bind(body.Name, rawId, userId)
      .run();
    
    return c.body(null, 204);
  } catch (e) {
    console.error(e);
    return c.body(null, 500);
  }
});
app.post("/users/:userId", async (c) => {
  try {
    const rawId = c.req.param("userId");
    const userId = toValidUuid(rawId);
    const body = await c.req.json();
    
    await c.env.DB.prepare("UPDATE Users SET Name = ? WHERE Id = ? OR Id = ?")
      .bind(body.Name, rawId, userId)
      .run();
    
    return c.body(null, 204);
  } catch (e) {
    console.error(e);
    return c.body(null, 500);
  }
});


app.post("/Users", async (c) => {
  try {
    const userId = c.req.query("userId");
    const validId = toValidUuid(userId);
    const body = await c.req.json();
    
    await c.env.DB.prepare("UPDATE Users SET Name = ? WHERE Id = ? OR Id = ?")
      .bind(body.Name, userId, validId)
      .run();
    
    return c.body(null, 204);
  } catch (e) {
    console.error(e);
    return c.body(null, 500);
  }
});

app.post("/Users/:userId", async (c) => {
  try {
    const rawId = c.req.param("userId");
    const userId = toValidUuid(rawId);
    const body = await c.req.json();
    
    await c.env.DB.prepare("UPDATE Users SET Name = ? WHERE Id = ? OR Id = ?")
      .bind(body.Name, rawId, userId)
      .run();
    
    return c.body(null, 204);
  } catch (e) {
    console.error(e);
    return c.body(null, 500);
  }
});
app.post("/users/:userId", async (c) => {
  try {
    const rawId = c.req.param("userId");
    const userId = toValidUuid(rawId);
    const body = await c.req.json();
    
    await c.env.DB.prepare("UPDATE Users SET Name = ? WHERE Id = ? OR Id = ?")
      .bind(body.Name, rawId, userId)
      .run();
    
    return c.body(null, 204);
  } catch (e) {
    console.error(e);
    return c.body(null, 500);
  }
});

app.get("/Users/:userId", handleGetUserById);
app.get("/users/:userId", handleGetUserById);

app.post("/Users/:userId/Policy", async (c) => {
  const rawId = c.req.param("userId");
  const userId = toValidUuid(rawId);
  const body = await c.req.json().catch(() => ({}));
  try {
    await c.env.DB.prepare("UPDATE Users SET Policy = ? WHERE Id = ? OR Id = ?").bind(JSON.stringify(body), rawId, userId).run();
  } catch (e) {}
  return c.body(null, 204);
});
app.post("/users/:userId/policy", async (c) => {
  const rawId = c.req.param("userId");
  const userId = toValidUuid(rawId);
  const body = await c.req.json().catch(() => ({}));
  try {
    await c.env.DB.prepare("UPDATE Users SET Policy = ? WHERE Id = ? OR Id = ?").bind(JSON.stringify(body), rawId, userId).run();
  } catch (e) {}
  return c.body(null, 204);
});

app.post("/Users/:userId/Configuration", async (c) => {
  const rawId = c.req.param("userId");
  const userId = toValidUuid(rawId);
  const body = await c.req.json().catch(() => ({}));
  try {
    await c.env.DB.prepare("UPDATE Users SET Configuration = ? WHERE Id = ? OR Id = ?").bind(JSON.stringify(body), rawId, userId).run();
  } catch (e) {}
  return c.body(null, 204);
});
app.post("/users/:userId/configuration", async (c) => {
  const rawId = c.req.param("userId");
  const userId = toValidUuid(rawId);
  const body = await c.req.json().catch(() => ({}));
  try {
    await c.env.DB.prepare("UPDATE Users SET Configuration = ? WHERE Id = ? OR Id = ?").bind(JSON.stringify(body), rawId, userId).run();
  } catch (e) {}
  return c.body(null, 204);
});

app.post("/Users/:userId/Password", async (c) => {
  const rawId = c.req.param("userId");
  const userId = toValidUuid(rawId);
  let body: any = {};
  try { body = await c.req.json(); } catch (e) {}
  const newPw = body.NewPw || body.NewPassword || "";
  if (newPw) {
    await c.env.DB.prepare("UPDATE Users SET Password = ? WHERE Id = ? OR Id = ?").bind(newPw, rawId, userId).run();
  }
  return c.body(null, 204);
});
app.post("/users/:userId/password", async (c) => {
  const rawId = c.req.param("userId");
  const userId = toValidUuid(rawId);
  let body: any = {};
  try { body = await c.req.json(); } catch (e) {}
  const newPw = body.NewPw || body.NewPassword || "";
  if (newPw) {
    await c.env.DB.prepare("UPDATE Users SET Password = ? WHERE Id = ? OR Id = ?").bind(newPw, rawId, userId).run();
  }
  return c.body(null, 204);
});

app.delete("/Users/:userId", async (c) => {
  const rawId = c.req.param("userId");
  const userId = toValidUuid(rawId);
  if (userId !== DEFAULT_ADMIN_ID && rawId !== DEFAULT_ADMIN_ID && rawId.toLowerCase() !== "admin") {
    await c.env.DB.prepare("DELETE FROM Users WHERE Id = ? OR Id = ?").bind(rawId, userId).run();
  }
  return c.body(null, 204);
});
app.delete("/users/:userId", async (c) => {
  const rawId = c.req.param("userId");
  const userId = toValidUuid(rawId);
  if (userId !== DEFAULT_ADMIN_ID && rawId !== DEFAULT_ADMIN_ID && rawId.toLowerCase() !== "admin") {
    await c.env.DB.prepare("DELETE FROM Users WHERE Id = ? OR Id = ?").bind(rawId, userId).run();
  }
  return c.body(null, 204);
});


// Post-login UI Requirements
app.post("/Sessions/Capabilities", (c) => new Response(null, { status: 204 }));
app.post("/sessions/capabilities", (c) => new Response(null, { status: 204 }));
app.post("/Sessions/Capabilities/Full", (c) => new Response(null, { status: 204 }));
app.post("/sessions/capabilities/full", (c) => new Response(null, { status: 204 }));
app.post("/Sessions/Logout", (c) => new Response(null, { status: 204 }));
app.post("/sessions/logout", (c) => new Response(null, { status: 204 }));
const handlePlayingProgress = async (c: any) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const rawItemId = body.ItemId || body.itemId || c.req.query("ItemId") || c.req.query("itemId");
    const positionTicks = body.PositionTicks ?? body.positionTicks ?? parseInt(c.req.query("PositionTicks") || c.req.query("positionTicks") || "0");
    const userId = toValidUuid(body.UserId || body.userId || c.req.query("UserId") || c.req.query("userId"));
    if (rawItemId && positionTicks > 0) {
      const item = await resolveItem(c.env.DB, rawItemId);
      const dbId = item ? item.Id : rawItemId;
      await c.env.DB.prepare(
        "INSERT INTO UserItemData (UserId, ItemId, PlaybackPositionTicks, Played, LastPlayedDate) VALUES (?, ?, ?, 0, datetime('now')) ON CONFLICT(UserId, ItemId) DO UPDATE SET PlaybackPositionTicks = excluded.PlaybackPositionTicks, LastPlayedDate = excluded.LastPlayedDate"
      ).bind(userId, dbId, positionTicks).run();
    }
  } catch (e) {}
  return new Response(null, { status: 204 });
};

const handlePlayingStopped = async (c: any) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const rawItemId = body.ItemId || body.itemId || c.req.query("ItemId") || c.req.query("itemId");
    const positionTicks = body.PositionTicks ?? body.positionTicks ?? parseInt(c.req.query("PositionTicks") || c.req.query("positionTicks") || "0");
    const userId = toValidUuid(body.UserId || body.userId || c.req.query("UserId") || c.req.query("userId"));
    let played = 0;
    if (rawItemId) {
      const item: any = await resolveItem(c.env.DB, rawItemId);
      if (item && item.MediaInfo) {
        try {
          const info = JSON.parse(item.MediaInfo);
          const dur = info.format?.duration ? parseFloat(info.format.duration) * 10000000 : 0;
          if (dur > 0 && positionTicks / dur > 0.9) played = 1;
        } catch (e) {}
      }
      const dbId = item ? item.Id : rawItemId;
      await c.env.DB.prepare(
        "INSERT INTO UserItemData (UserId, ItemId, PlaybackPositionTicks, Played, LastPlayedDate) VALUES (?, ?, ?, ?, datetime('now')) ON CONFLICT(UserId, ItemId) DO UPDATE SET PlaybackPositionTicks = excluded.PlaybackPositionTicks, Played = excluded.Played, LastPlayedDate = excluded.LastPlayedDate"
      ).bind(userId, dbId, played ? 0 : positionTicks, played).run();
    }
  } catch (e) {}
  return new Response(null, { status: 204 });
};

app.post("/Sessions/Playing", (c) => new Response(null, { status: 204 }));
app.post("/sessions/playing", (c) => new Response(null, { status: 204 }));
app.post("/Sessions/Playing/Ping", (c) => new Response(null, { status: 204 }));
app.post("/sessions/playing/ping", (c) => new Response(null, { status: 204 }));
app.post("/Sessions/Playing/Progress", handlePlayingProgress);
app.post("/sessions/playing/progress", handlePlayingProgress);
app.post("/Sessions/Playing/Stopped", handlePlayingStopped);
app.post("/sessions/playing/stopped", handlePlayingStopped);


app.post("/Users/:userId/PlayingItems/:itemId", (c) => new Response(null, { status: 204 }));
app.post("/users/:userId/playingitems/:itemId", (c) => new Response(null, { status: 204 }));
app.post("/Users/:userId/PlayingItems/:itemId/Progress", async (c) => {
  try {
    const userId = toValidUuid(c.req.param("userId"));
    const rawItemId = c.req.param("itemId");
    const pos = parseInt(c.req.query("positionTicks") || c.req.query("PositionTicks") || "0");
    if (rawItemId && pos > 0) {
      const item = await resolveItem(c.env.DB, rawItemId);
      const dbId = item ? item.Id : rawItemId;
      await c.env.DB.prepare(
        "INSERT INTO UserItemData (UserId, ItemId, PlaybackPositionTicks, Played, LastPlayedDate) VALUES (?, ?, ?, 0, datetime('now')) ON CONFLICT(UserId, ItemId) DO UPDATE SET PlaybackPositionTicks = excluded.PlaybackPositionTicks, LastPlayedDate = excluded.LastPlayedDate"
      ).bind(userId, dbId, pos).run();
    }
  } catch (e) {}
  return new Response(null, { status: 204 });
});
app.delete("/Users/:userId/PlayingItems/:itemId", (c) => new Response(null, { status: 204 }));
app.delete("/users/:userId/playingitems/:itemId", (c) => new Response(null, { status: 204 }));

const handlePlayedItem = async (c: any) => {
  const userId = toValidUuid(c.req.param("userId"));
  const rawItemId = c.req.param("itemId");
  const item = await resolveItem(c.env.DB, rawItemId);
  const dbId = item ? item.Id : rawItemId;
  const uuidId = item ? (item.Uuid || toValidUuid(item.Id)) : toValidUuid(rawItemId);
  try {
    await c.env.DB.prepare(
      "INSERT INTO UserItemData (UserId, ItemId, PlaybackPositionTicks, Played, LastPlayedDate) VALUES (?, ?, 0, 1, datetime('now')) ON CONFLICT(UserId, ItemId) DO UPDATE SET PlaybackPositionTicks = 0, Played = 1, LastPlayedDate = excluded.LastPlayedDate"
    ).bind(userId, dbId).run();
  } catch (e) {}
  return c.json({
    PlaybackPositionTicks: 0,
    PlayCount: 1,
    IsFavorite: false,
    Played: true,
    PlayedPercentage: 100,
    Key: uuidId,
    ItemId: uuidId,
  });
};
app.post("/Users/:userId/PlayedItems/:itemId", handlePlayedItem);
app.post("/users/:userId/playeditems/:itemId", handlePlayedItem);

const handleUnplayedItem = async (c: any) => {
  const userId = toValidUuid(c.req.param("userId"));
  const rawItemId = c.req.param("itemId");
  const item = await resolveItem(c.env.DB, rawItemId);
  const dbId = item ? item.Id : rawItemId;
  const uuidId = item ? (item.Uuid || toValidUuid(item.Id)) : toValidUuid(rawItemId);
  try {
    await c.env.DB.prepare(
      "INSERT INTO UserItemData (UserId, ItemId, PlaybackPositionTicks, Played, LastPlayedDate) VALUES (?, ?, 0, 0, datetime('now')) ON CONFLICT(UserId, ItemId) DO UPDATE SET PlaybackPositionTicks = 0, Played = 0, LastPlayedDate = excluded.LastPlayedDate"
    ).bind(userId, dbId).run();
  } catch (e) {}
  return c.json({
    PlaybackPositionTicks: 0,
    PlayCount: 0,
    IsFavorite: false,
    Played: false,
    PlayedPercentage: 0,
    Key: uuidId,
    ItemId: uuidId,
  });
};
app.delete("/Users/:userId/PlayedItems/:itemId", handleUnplayedItem);
app.delete("/users/:userId/playeditems/:itemId", handleUnplayedItem);

const handleFavoriteItem = async (c: any) => {
  const userId = toValidUuid(c.req.param("userId"));
  const rawItemId = c.req.param("itemId");
  const item = await resolveItem(c.env.DB, rawItemId);
  const dbId = item ? item.Id : rawItemId;
  const uuidId = item ? (item.Uuid || toValidUuid(item.Id)) : toValidUuid(rawItemId);
  try {
    await c.env.DB.prepare(
      "INSERT INTO UserItemData (UserId, ItemId, PlaybackPositionTicks, Played, IsFavorite, LastPlayedDate) VALUES (?, ?, 0, 0, 1, datetime('now')) ON CONFLICT(UserId, ItemId) DO UPDATE SET IsFavorite = 1"
    ).bind(userId, dbId).run();
  } catch (e) {}
  return c.json({
    PlaybackPositionTicks: 0,
    PlayCount: 0,
    IsFavorite: true,
    Played: false,
    Key: uuidId,
    ItemId: uuidId,
  });
};
app.post("/Users/:userId/FavoriteItems/:itemId", handleFavoriteItem);
app.post("/users/:userId/favoriteitems/:itemId", handleFavoriteItem);

const handleUnfavoriteItem = async (c: any) => {
  const userId = toValidUuid(c.req.param("userId"));
  const rawItemId = c.req.param("itemId");
  const item = await resolveItem(c.env.DB, rawItemId);
  const dbId = item ? item.Id : rawItemId;
  const uuidId = item ? (item.Uuid || toValidUuid(item.Id)) : toValidUuid(rawItemId);
  try {
    await c.env.DB.prepare(
      "INSERT INTO UserItemData (UserId, ItemId, PlaybackPositionTicks, Played, IsFavorite, LastPlayedDate) VALUES (?, ?, 0, 0, 0, datetime('now')) ON CONFLICT(UserId, ItemId) DO UPDATE SET IsFavorite = 0"
    ).bind(userId, dbId).run();
  } catch (e) {}
  return c.json({
    PlaybackPositionTicks: 0,
    PlayCount: 0,
    IsFavorite: false,
    Played: false,
    Key: uuidId,
    ItemId: uuidId,
  });
};
app.delete("/Users/:userId/FavoriteItems/:itemId", handleUnfavoriteItem);
app.delete("/users/:userId/favoriteitems/:itemId", handleUnfavoriteItem);
app.post("/Sessions/Viewing", (c) => new Response(null, { status: 204 }));
app.post("/sessions/viewing", (c) => new Response(null, { status: 204 }));
const handleDisplayPrefs = (c: any) => {
  const id = c.req.param("id") || "usersettings";
  return c.json({
    Id: id,
    ViewType: "Poster",
    SortBy: "SortName",
    IndexBy: "None",
    RememberIndexing: false,
    PrimaryImageHeight: 250,
    PrimaryImageWidth: 250,
    CustomPrefs: {},
    ScrollDirection: "Vertical",
    ShowBackdrop: true,
    RememberSorting: false,
    SortOrder: "Ascending",
    ShowSidebar: false,
    Client: "Jellyfin",
  });
};
app.get("/DisplayPreferences/:id", handleDisplayPrefs);
app.post("/DisplayPreferences/:id", (c) => c.body(null, 204));
app.get("/displaypreferences/:id", handleDisplayPrefs);
app.post("/displaypreferences/:id", (c) => c.body(null, 204));

app.get("/Notifications/Summary", (c) => c.json({ UnreadCount: 0, MaxUnreadNotificationLevel: "Normal" }));
app.get("/notifications/summary", (c) => c.json({ UnreadCount: 0, MaxUnreadNotificationLevel: "Normal" }));
app.get("/GroupingOptions", (c) => c.json([]));
app.get("/groupingoptions", (c) => c.json([]));
app.get("/Users/:userId/GroupingOptions", (c) => c.json([]));
app.get("/users/:userId/groupingoptions", (c) => c.json([]));

app.get("/QuickConnect/Status", (c) => c.json({ Authenticated: false }));
app.get("/quickconnect/status", (c) => c.json({ Authenticated: false }));

const handleBitrateTest = (c: any) => {
  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      },
    });
  }
  const rawSize = parseInt(c.req.query("Size") || c.req.query("size") || "102400");
  const size = Math.min(Math.max(isNaN(rawSize) ? 102400 : rawSize, 1024), 5000000);
  if (c.req.method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": size.toString(),
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      },
    });
  }
  const buffer = new Uint8Array(size);
  return new Response(buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": size.toString(),
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    },
  });
};
app.all("/Playback/BitrateTest*", handleBitrateTest);
app.all("/playback/bitratetest*", handleBitrateTest);

// Endpoints de Intros e ActiveEncodings para compatibilidade com Android e clientes móveis
const handleEmptyIntros = (c: any) => c.json({ Items: [], TotalRecordCount: 0 });
app.all("/Items/:itemId/Intros*", handleEmptyIntros);
app.all("/items/:itemId/intros*", handleEmptyIntros);
app.all("/Users/:userId/Items/:itemId/Intros*", handleEmptyIntros);
app.all("/users/:userId/items/:itemId/intros*", handleEmptyIntros);

const handleActiveEncodings = (c: any) => c.json([]);
app.all("/Videos/ActiveEncodings*", handleActiveEncodings);
app.all("/videos/activeencodings*", handleActiveEncodings);

// 3. Views (Bibliotecas: Series-Dub, etc)
const handleVirtualFolders = async (c: any) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM Libraries").all();
  return c.json(
    results.map((row: any) => {
      const uuid = row.Uuid || toValidUuid(row.Id);
      return {
        Name: row.Name,
        Locations: [row.FolderId],
        CollectionType: row.CollectionType || (row.Name.toLowerCase().includes("filme") ? "movies" : "tvshows"),
        ItemId: uuid,
        PrimaryImageItemId: uuid,
        PrimaryImageTag: getImageTag(row.PrimaryImageFileId) || "cached",
        RefreshProgress: 0,
        RefreshStatus: "Idle",
        ImageTags: { Primary: getImageTag(row.PrimaryImageFileId) || "cached" },
        BackdropImageTags: row.PrimaryImageFileId ? [getImageTag(row.PrimaryImageFileId) || "cached"] : undefined,
      };
    })
  );
};
app.get("/Library/VirtualFolders", handleVirtualFolders);
app.get("/library/virtualfolders", handleVirtualFolders);

app.post("/Library/VirtualFolders", async (c) => {
  let body: any = {};
  try {
    if (c.req.header("Content-Type")?.includes("json")) {
      body = await c.req.json();
    }
  } catch (e) {}

  const name = c.req.query("name") || body.Name || "New Library";
  const rawType = c.req.query("collectionType") || body.CollectionType || "movies";

  let type = "movies";
  const lower = rawType.toLowerCase();
  if (lower.includes("serie") || lower.includes("tv")) type = "tvshows";
  else if (lower.includes("music")) type = "music";
  else if (lower.includes("book")) type = "books";

  let paths = c.req.queries("paths");
  if (!paths && body.Paths) paths = body.Paths;
  if (!paths && body.LibraryOptions && body.LibraryOptions.PathInfos && body.LibraryOptions.PathInfos.length > 0) {
    paths = body.LibraryOptions.PathInfos.map((p: any) => p.Path);
  }
  
  let folderId = extractDriveFolderId(paths && paths.length > 0 ? paths[0] : "root") || "root";

  try {
    if (folderId !== "root") {
      const gdrive = new GoogleDrive(c.env);
      const file = await gdrive.getFile(folderId);
      if (file && file.mimeType === "application/vnd.google-apps.shortcut" && file.shortcutDetails?.targetId) {
        folderId = file.shortcutDetails.targetId;
      }
    }
  } catch (e) {}

  try {
    // O Jellyfin Web envia em LibraryOptions.ItemId o Id da view que ele acabou de criar
    // (via POST /Library/VirtualFolders). Antes o DriveFlin derivava o Id de um slug do
    // nome ("view_" + nome), o que fazia o INSERT OR REPLACE sobrescrever uma biblioteca
    // já existente com o mesmo nome — origem das "bibliotecas zumbis" ao recriar/renomear.
    const requestedId: string | undefined =
      body.LibraryOptions?.ItemId || body.ItemId || c.req.query("itemId") || undefined;

    let id = requestedId || ("view_" + name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "_"));

    // Evita colidir com uma biblioteca diferente que já ocupe esse Id (nome duplicado).
    const clash: any = await c.env.DB.prepare("SELECT Id, Name FROM Libraries WHERE Id = ?").bind(id).first();
    if (clash && clash.Name !== name) {
      id = id + "_" + Date.now().toString(36);
    }

    try {
      await c.env.DB.prepare("ALTER TABLE Libraries ADD COLUMN CollectionType TEXT").run();
    } catch (e) {}

    await c.env.DB.prepare(
      "INSERT OR REPLACE INTO Libraries (Id, Name, FolderId, CollectionType, Uuid) VALUES (?, ?, ?, ?, ?)"
    ).bind(id, name, folderId, type, toValidUuid(id)).run();

    // Trigger background sync for the new library
    try {
      c.executionCtx?.waitUntil(runSync(c.env));
    } catch (e) {
      runSync(c.env);
    }

    return c.body(null, 204);
  } catch (e: any) {
    return c.text(e.message + " " + e.stack, 500);
  }
});

app.post("/Library/VirtualFolders/Name", async (c) => {
  const name = c.req.query("name") || "";
  const newName = c.req.query("newName") || "";
  if (name && newName) {
    await c.env.DB.prepare("UPDATE Libraries SET Name = ? WHERE Name = ?").bind(newName, name).run();
  }
  return c.body(null, 204);
});

// Remove o prefixo "/" que o DirectoryBrowser adiciona e extrai o ID do Google Drive
// de variações como "/17uE...", "17uE...", "\\17uE..." ou de um caminho completo.
function extractDriveFolderId(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value || value === "/" || value === "root" || value === "/root") return "root";
  // Caminhos UNC do Jellyfin: "\\host\share" não têm ID do Drive.
  if (value.startsWith("\\\\")) return null;
  const idMatch = value.match(/[-\w]{25,}/);
  return idMatch ? idMatch[0] : null;
}

// Adiciona um caminho de mídia a uma biblioteca existente.
// O Jellyfin Web chama esta rota em POST /Library/VirtualFolders/Paths com
// { Name, Path, PathInfo } — o corpo pode trazer tanto Path quanto PathInfo.Path,
// e a query pode trazer ?name=. Lemos todas as variações para não perder o caminho.
app.post("/Library/VirtualFolders/Paths", async (c) => {
  let body: any = {};
  try { body = await c.req.json(); } catch (e) {}

  const name = c.req.query("name") || body.Name || "";
  const rawPath =
    c.req.query("path") ||
    body.Path ||
    body.PathInfo?.Path ||
    (body.LibraryOptions?.PathInfos?.[0]?.Path) ||
    "";

  const folderId = extractDriveFolderId(rawPath);

  if (name && folderId) {
    // Se a biblioteca não existe, cria — o Jellyfin Web também usa esta rota para
    // vincular o caminho logo após criar a biblioteca.
    const existing: any = await c.env.DB.prepare("SELECT Id FROM Libraries WHERE Name = ?").bind(name).first();
    if (existing) {
      await c.env.DB.prepare("UPDATE Libraries SET FolderId = ? WHERE Name = ?").bind(folderId, name).run();
    } else {
      const id = "view_" + name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "_");
      const type = body.LibraryOptions?.CollectionType === "tvshows" ? "tvshows" : "movies";
      await c.env.DB.prepare(
        "INSERT OR REPLACE INTO Libraries (Id, Name, FolderId, CollectionType, Uuid) VALUES (?, ?, ?, ?, ?)"
      ).bind(id, name, folderId, type, toValidUuid(id)).run();
    }
    try { c.executionCtx?.waitUntil(runSync(c.env)); } catch (e) { runSync(c.env); }
  }
  return c.body(null, 204);
});

app.delete("/Library/VirtualFolders/Paths", async (c) => {
  return c.body(null, 204);
});

app.delete("/Library/VirtualFolders", async (c) => {
  const name = c.req.query("name") || "";
  const lib: any = await c.env.DB.prepare("SELECT Id FROM Libraries WHERE Name = ?").bind(name).first();
  if (lib) {
    await c.env.DB.prepare("DELETE FROM Items WHERE LibraryId = ?").bind(lib.Id).run();
    await c.env.DB.prepare("DELETE FROM Libraries WHERE Id = ?").bind(lib.Id).run();
  }
  return c.body(null, 204);
});

app.post("/Library/Refresh", async (c) => {
  try { c.executionCtx?.waitUntil(runSync(c.env)); } catch (e) { runSync(c.env); }
  return c.body(null, 204);
});

app.post("/Items/Root/Refresh", async (c) => {
  try { c.executionCtx?.waitUntil(runSync(c.env)); } catch (e) { runSync(c.env); }
  return c.body(null, 204);
});

app.post("/Items/:id/Refresh", async (c) => {
  try { c.executionCtx?.waitUntil(runSync(c.env)); } catch (e) { runSync(c.env); }
  return c.body(null, 204);
});

app.get("/Environment/Drives", async (c) => {
  const drives: any[] = [
    {
      Name: "Google Drive (Principal)",
      Path: "root",
      Type: "NetworkShare",
    },
  ];
  // List Shared Drives (if any) so the user can select them explicitly
  try {
    const gdrive = new GoogleDrive(c.env);
    const token = await gdrive.getAccessToken();
    const sdRes = await fetch("https://www.googleapis.com/drive/v3/drives?pageSize=50&fields=drives(id,name)", {
      headers: { Authorization: "Bearer " + token }
    });
    if (sdRes.ok) {
      const sdData: any = await sdRes.json();
      if (sdData.drives) {
        for (const sd of sdData.drives) {
          drives.push({
            Name: "🚀 " + sd.name + " (Shared Drive)",
            Path: sd.id,
            Type: "NetworkShare",
          });
        }
      }
    }
  } catch (e) {}
  try {
    const { results: libs } = await c.env.DB.prepare("SELECT Name, FolderId FROM Libraries").all();
    if (libs && libs.length > 0) {
      for (const lib of libs) {
        if (lib.FolderId && lib.FolderId !== "root") {
          drives.push({
            Name: `📁 ${lib.Name}`,
            Path: lib.FolderId,
            Type: "Directory",
          });
        }
      }
    }
  } catch (e) {}
  return c.json(drives);
});


app.get("/Environment/DefaultDirectoryBrowser", (c) => {
  return c.json({ Path: "root" });
});

// O cliente Web (directorybrowser.js) só envia includeFiles / includeDirectories quando
// o chamador define explicitamente; caso contrário os parâmetros são OMITIDOS da query.
// O backend oficial em C# usa default = false para ambos, e por isso devolveria [] no
// seletor de pastas. Como o DriveFlin funciona também como navegador de arquivos do Drive,
// adotamos default = true quando o parâmetro está ausente, e seguimos o cliente quando ele
// envia o valor explicitamente (inclusive "false").
// "undefined"/"" são tratados como ausentes para não devolver lista vazia por engano.
function parseBoolQuery(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === null) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return defaultValue;
}

app.get("/Environment/DirectoryContents", async (c) => {
  let path = c.req.query("path") || "root";
  const idMatch = path.match(/[-\w]{25,}/);
  if (idMatch) path = idMatch[0];

  const includeDirectories = parseBoolQuery(c.req.query("includeDirectories"), true);
  const includeFiles = parseBoolQuery(c.req.query("includeFiles"), true);

  if (!includeDirectories && !includeFiles) return c.json([]);

  try {
    const gdrive = new GoogleDrive(c.env);
    const targetFolderId = !path || path === "/" || path === "" || path === "root" || path === "/root" ? "root" : path;
    const data = await gdrive.listFolder(targetFolderId);

    const items: any[] = [];
    if (data && data.files) {
      for (const file of data.files) {
        const targetMime = file.shortcutDetails?.targetMimeType || file.mimeType;
        const isFolder = targetMime === "application/vnd.google-apps.folder";
        
        let pathId = file.id;
        if (file.mimeType === "application/vnd.google-apps.shortcut") {
          pathId = file.shortcutDetails?.targetId || file.id;
        }

        if (isFolder && includeDirectories) {
          items.push({
            Name: file.name,
            Path: "/" + pathId,
            Type: "Directory",
          });
        } else if (!isFolder && includeFiles) {
          items.push({
            Name: file.name,
            Path: "/" + pathId,
            Type: "File",
          });
        }
      }
    }
    items.sort((a, b) => a.Name.localeCompare(b.Name));
    return c.json(items);
  } catch (err: any) {
    console.error("DirectoryContents error:", err);
    return c.json([]);
  }
});

app.get("/DebugDrive", async (c) => {
  try {
    const gdrive = new GoogleDrive(c.env);
    const token = await gdrive.getAccessToken();
    let urlBase = `https://www.googleapis.com/drive/v3/files?pageSize=1000&fields=nextPageToken,files(id,name,mimeType,size,createdTime,shortcutDetails)&includeItemsFromAllDrives=true&supportsAllDrives=true`;
    if (gdrive.teamDriveId && gdrive.teamDriveId.trim() !== '') {
      urlBase += `&q='${gdrive.teamDriveId}'%20in%20parents%20and%20trashed=false&corpora=drive&driveId=${gdrive.teamDriveId}`;
    } else {
      urlBase += `&q='root'%20in%20parents%20and%20trashed=false`;
    }
    const res = await fetch(urlBase, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const text = await res.text();
    return c.json({ status: res.status, url: urlBase, response: text });
  } catch (e: any) {
    return c.json({ error: e.message });
  }
});

app.get("/Environment/ParentPath", async (c) => {
  let path = c.req.query("path");
  const idMatch = path?.match(/[-\w]{25,}/);
  if (idMatch) path = idMatch[0];

  if (!path || path === "root" || path === "/") {
    return c.json("");
  }
  try {
    const gdrive = new GoogleDrive(c.env);
    const file = await gdrive.getFile(path);
    if (file && file.parents && file.parents.length > 0) {
      return c.json("/" + file.parents[0]);
    }
  } catch (e) {}
  return c.json("root");
});

app.post("/Environment/ValidatePath", async (c) => {
  let path = c.req.query("path");
  if (!path) {
    try {
      const body = await c.req.json();
      path = body?.Path || body?.path;
    } catch (e) {}
  }
  const idMatch = path?.match(/[-\w]{25,}/);
  if (idMatch) path = idMatch[0];

  if (!path || path === "root" || path === "/") {
    return c.body(null, 204);
  }
  try {
    const gdrive = new GoogleDrive(c.env);
    const file = await gdrive.getFile(path);
    if (file && !file.trashed) {
      return c.body(null, 204);
    }
  } catch (e) {}
  if (/^[a-zA-Z0-9_-]{15,}$/.test(path)) {
    return c.body(null, 204);
  }
  return c.text("Path not found", 404);
});

app.get("/Libraries/AvailableOptions", (c) => {
  return c.json({
    MetadataSavers: [],
    MetadataReaders: [],
    SubtitleFetchers: [],
    LyricsFetchers: [],
    TypeOptions: [
      {
        Type: "Movie",
        MetadataFetchers: [{ Name: "TheMovieDb", DefaultEnabled: true }],
        ImageFetchers: [{ Name: "TheMovieDb", DefaultEnabled: true }],
        SupportedImageTypes: ["Primary", "Backdrop"],
      },
      {
        Type: "Series",
        MetadataFetchers: [{ Name: "TheMovieDb", DefaultEnabled: true }],
        ImageFetchers: [{ Name: "TheMovieDb", DefaultEnabled: true }],
        SupportedImageTypes: ["Primary", "Backdrop"],
      },
    ],
  });
});

app.get("/Localization/cultures", (c) => {
  return c.json([
    { Name: "pt-BR", DisplayName: "Português (Brasil)", TwoLetterISOLanguageName: "pt", ThreeLetterISOLanguageName: "por" },
    { Name: "en-US", DisplayName: "English (United States)", TwoLetterISOLanguageName: "en", ThreeLetterISOLanguageName: "eng" },
    { Name: "es-ES", DisplayName: "Español", TwoLetterISOLanguageName: "es", ThreeLetterISOLanguageName: "spa" },
  ]);
});

app.get("/Localization/countries", (c) => {
  return c.json([
    { Name: "Brazil", DisplayName: "Brasil", TwoLetterISORegionName: "BR", ThreeLetterISORegionName: "BRA" },
    { Name: "United States", DisplayName: "Estados Unidos", TwoLetterISORegionName: "US", ThreeLetterISORegionName: "USA" },
  ]);
});

// BACKUP ENDPOINTS (Google Drive + D1)
app.get("/Backup", async (c) => {
  try {
    const backups = await listDatabaseBackups(c.env);
    return c.json(backups);
  } catch (e: any) {
    return c.json([]);
  }
});

const handleCreateBackup = async (c: any) => {
  try {
    const backup = await createDatabaseBackup(c.env);
    return c.json(backup);
  } catch (e: any) {
    return c.text("Backup failed: " + e.message, 500);
  }
};

app.post("/Backup/Create", handleCreateBackup);
app.post("/Backup", handleCreateBackup);

app.get("/Backup/Manifest", async (c) => {
  const path = c.req.query("path");
  return c.json({
    Path: path,
    Name: path,
    DateCreated: new Date().toISOString(),
    DatabaseVersion: 1,
    Version: "12.0.0",
    Metadata: true,
    Subtitles: true,
    Database: true,
  });
});

app.post("/Backup/Restore", async (c) => {
  try {
    let body: any = {};
    try { body = await c.req.json(); } catch (e) {}
    const fileId = body?.ArchiveFileName || body?.path || body?.Path || c.req.query("fileId");
    if (!fileId) {
      return c.text("Missing fileId or ArchiveFileName", 400);
    }
    const result = await restoreDatabaseBackup(c.env, fileId);
    return c.json(result);
  } catch (e: any) {
    return c.text("Restore failed: " + e.message, 500);
  }
});


app.get("/Backup/:fileId/Download", async (c) => {
  const fileId = c.req.param("fileId");
  try {
    const gdrive = new GoogleDrive(c.env);
    const token = await gdrive.getAccessToken();
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return c.text("File not found", 404);
    return new Response(res.body, {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="DriveFlin_Backup_${fileId}.json"`,
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e: any) {
    return c.text(e.message, 500);
  }
});

app.get("/Backup/:fileId", async (c) => {
  const fileId = c.req.param("fileId");
  try {
    const gdrive = new GoogleDrive(c.env);
    const file = await gdrive.getFile(fileId);
    if (!file) return c.notFound();
    return c.json({
      Path: file.id,
      Name: file.name,
      DateCreated: file.createdTime || new Date().toISOString(),
      Size: parseInt(file.size || "1024"),
    });
  } catch (e) {
    return c.notFound();
  }
});


// 3.1. Views (Bibliotecas: Series-Dub, etc)
const handleUserViews = async (c: any) => {
  const rawUserId = c.req.param("userId") || c.req.query("userId") || c.req.query("UserId");
  const userId = toValidUuid(rawUserId);
  let enabledFolders: string[] | null = null;
  try {
    const user: any = await c.env.DB.prepare("SELECT Policy FROM Users WHERE Id = ? OR Id = ?").bind(rawUserId, userId).first();
    if (user && user.Policy) {
      const pol = JSON.parse(user.Policy);
      if (pol.EnableAllFolders === false && Array.isArray(pol.EnabledFolders)) {
        enabledFolders = pol.EnabledFolders;
      }
    }
  } catch (e) {}

  let { results } = await c.env.DB.prepare("SELECT * FROM Libraries").all();
  if (enabledFolders) {
    results = results.filter((row: any) => enabledFolders!.includes(row.Id) || (row.Uuid && enabledFolders!.includes(row.Uuid)));
  }
  const items = results.map((row: any) => {
    const uuid = row.Uuid || toValidUuid(row.Id);
    return {
      Name: row.Name,
      ServerId: SERVER_ID,
      Id: uuid,
      IsFolder: true,
      Type: "CollectionFolder",
      CollectionType: row.CollectionType || (row.Name.toLowerCase().includes("filme") ? "movies" : "tvshows"),
      ImageTags: { Primary: getImageTag(row.PrimaryImageFileId) || "cached" },
      PrimaryImageTag: getImageTag(row.PrimaryImageFileId) || "cached",
      PrimaryImageItemId: uuid,
      BackdropImageTags: row.PrimaryImageFileId ? [getImageTag(row.PrimaryImageFileId) || "cached"] : undefined,
      UserData: { Played: false, PlayCount: 0, IsFavorite: false, PlaybackPositionTicks: 0 },
      ChildCount: 0,
      RecursiveItemCount: 0,
      DateCreated: "2023-01-01T00:00:00Z",
      PrimaryImageAspectRatio: 1.7777777777777777,
    };
  });
  return c.json({ Items: items, TotalRecordCount: items.length });
};

app.get("/Users/:userId/Views", handleUserViews);
app.get("/users/:userId/views", handleUserViews);
app.get("/Users/:userId/views", handleUserViews);
app.get("/users/:userId/Views", handleUserViews);

const handleUserViewsGeneral = async (c: any) => {
  const rawUserId = c.req.query("userId") || c.req.query("UserId");
  const userId = rawUserId ? toValidUuid(rawUserId) : null;
  let enabledFolders: string[] | null = null;
  if (userId) {
    try {
      const user: any = await c.env.DB.prepare("SELECT Policy FROM Users WHERE Id = ? OR Id = ?").bind(rawUserId, userId).first();
      if (user && user.Policy) {
        const pol = JSON.parse(user.Policy);
        if (pol.EnableAllFolders === false && Array.isArray(pol.EnabledFolders)) {
          enabledFolders = pol.EnabledFolders;
        }
      }
    } catch (e) {}
  }

  let { results } = await c.env.DB.prepare("SELECT * FROM Libraries").all();
  if (enabledFolders) {
    results = results.filter((row: any) => enabledFolders!.includes(row.Id) || (row.Uuid && enabledFolders!.includes(row.Uuid)));
  }
  const items = results.map((row: any) => {
    const uuid = row.Uuid || toValidUuid(row.Id);
    return {
      Name: row.Name,
      ServerId: SERVER_ID,
      Id: uuid,
      IsFolder: true,
      Type: "CollectionFolder",
      CollectionType: row.CollectionType || (row.Name.toLowerCase().includes("filme") ? "movies" : "tvshows"),
      ImageTags: { Primary: getImageTag(row.PrimaryImageFileId) || "cached" },
      PrimaryImageTag: getImageTag(row.PrimaryImageFileId) || "cached",
      PrimaryImageItemId: uuid,
      BackdropImageTags: row.PrimaryImageFileId ? [getImageTag(row.PrimaryImageFileId) || "cached"] : undefined,
      UserData: { Played: false, PlayCount: 0, IsFavorite: false, PlaybackPositionTicks: 0 },
      ChildCount: 0,
      RecursiveItemCount: 0,
      DateCreated: "2023-01-01T00:00:00Z",
      PrimaryImageAspectRatio: 1.7777777777777777,
    };
  });
  return c.json({ Items: items, TotalRecordCount: items.length });
};

app.get("/UserViews", handleUserViewsGeneral);
app.get("/userviews", handleUserViewsGeneral);
app.get("/userViews", handleUserViewsGeneral);

app.get("/SyncPlay/List", (c) => c.json([]));

// 4. Items (Filmes/Séries dentro das bibliotecas)
app.get("/Items/Filters", (c) =>
  c.json({ Genres: [], Tags: [], Years: [], OfficialRatings: [] }),
);
app.get("/Items/Filters2", (c) =>
  c.json({ Genres: [], Tags: [], Years: [], OfficialRatings: [] }),
);

app.get("/Items/:itemId/Ancestors", (c) => c.json([]));
app.get("/Items/:itemId/ThemeMedia", (c) => {
  const itemId = c.req.param("itemId");
  return c.json({
    ThemeVideosResult: {
      OwnerId: itemId,
      Items: [],
      TotalRecordCount: 0,
      StartIndex: 0,
    },
    ThemeSongsResult: {
      OwnerId: itemId,
      Items: [],
      TotalRecordCount: 0,
      StartIndex: 0,
    },
    SoundtrackSongsResult: {
      OwnerId: "00000000000000000000000000000000",
      Items: [],
      TotalRecordCount: 0,
      StartIndex: 0,
    },
  });
});
app.get("/Items/:itemId/Similar", (c) =>
  c.json({ Items: [], TotalRecordCount: 0 }),
);
app.get("/items/:itemId/similar", (c) =>
  c.json({ Items: [], TotalRecordCount: 0 }),
);
app.get("/Items/:itemId/Collections", (c) =>
  c.json({ Items: [], TotalRecordCount: 0 }),
);
app.get("/items/:itemId/collections", (c) =>
  c.json({ Items: [], TotalRecordCount: 0 }),
);
app.get("/Users/:userId/Items/:itemId/Intros", (c) =>
  c.json({ Items: [], TotalRecordCount: 0, StartIndex: 0 }),
);
app.get("/users/:userId/items/:itemId/intros", (c) =>
  c.json({ Items: [], TotalRecordCount: 0, StartIndex: 0 }),
);

async function fetchUserItemDataMap(db: any, userId: string, itemIds: string[]): Promise<Map<string, any>> {
  const map = new Map<string, any>();
  if (!itemIds || itemIds.length === 0) return map;
  for (let i = 0; i < itemIds.length; i += 50) {
    const chunk = itemIds.slice(i, i + 50);
    const placeholders = chunk.map(() => "?").join(",");
    try {
      const { results } = await db.prepare(
        `SELECT ItemId, PlaybackPositionTicks, Played, IsFavorite, LastPlayedDate FROM UserItemData WHERE UserId = ? AND ItemId IN (${placeholders})`
      ).bind(userId, ...chunk).all();
      for (const r of (results || [])) {
        map.set(r.ItemId, r);
      }
    } catch (e) {
      console.error("fetchUserItemDataMap error:", e);
    }
  }
  return map;
}

function buildUserData(itemId: string, dataRow: any, runTimeTicks?: number) {
  const ticks = dataRow?.PlaybackPositionTicks || 0;
  const played = !!dataRow?.Played;
  const playedPct = (runTimeTicks && runTimeTicks > 0)
    ? Math.min(100, Math.round((ticks / runTimeTicks) * 1000) / 10)
    : (played ? 100 : 0);

  return {
    PlaybackPositionTicks: ticks,
    PlayCount: played ? 1 : 0,
    IsFavorite: !!dataRow?.IsFavorite,
    Played: played,
    PlayedPercentage: playedPct,
    LastPlayedDate: dataRow?.LastPlayedDate || undefined,
    Key: itemId,
    ItemId: itemId,
  };
}

function getQueryArray(c: any, param: string): string[] {
  const direct = c.req.queries(param) || [];
  const directUpper = c.req.queries(param.charAt(0).toUpperCase() + param.slice(1)) || [];
  const all = [...direct, ...directUpper];
  if (all.length === 0) {
    const single = c.req.query(param) || c.req.query(param.charAt(0).toUpperCase() + param.slice(1));
    if (single) all.push(single);
  }
  const result: string[] = [];
  for (const item of all) {
    for (const part of item.split(",")) {
      const trimmed = part.trim();
      if (trimmed && !result.includes(trimmed)) {
        result.push(trimmed);
      }
    }
  }
  return result;
}

const parseMediaInfo = (row: any) => {
  const isVideo = row.Type === "Movie" || row.Type === "Episode";
  const isAudio = row.Type === "Audio";
  let RunTimeTicks = isAudio ? 1800000000 : 30000000000;
  let Width = isAudio ? 0 : 1920;
  let Height = isAudio ? 0 : 1080;
  let MediaStreams: any[] = [];
  let Bitrate = isAudio ? 320000 : 5000000;

  let tmdb: any = null;

  const isLegendado = (row.LibraryId === "view_filmes_legendados" || row.LibraryId === "view_series_legendadas" || /\.leg\./i.test(row.Name || "") || /- leg/i.test(row.Name || ""));
  const isDublado = (row.LibraryId === "view_filmes_dublados" || row.LibraryId === "view_series_dubladas" || /dublado/i.test(row.Name || ""));

  if (row.MediaInfo) {
    try {
      const info = JSON.parse(row.MediaInfo);
      if (info.tmdb) {
        tmdb = info.tmdb;
      }
      if (info.format && info.format.duration) {
        RunTimeTicks = Math.round(parseFloat(info.format.duration) * 10000000);
      }
      if (info.format && info.format.bit_rate) {
        Bitrate = parseInt(info.format.bit_rate);
      }
      if (info.streams && Array.isArray(info.streams)) {
        MediaStreams = info.streams
          .map((s: any) => {
            if (s.codec_type === "video") {
              Width = s.width || Width;
              Height = s.height || Height;
              const resolutionText = Height >= 2160 ? "4K" : Height >= 1080 ? "1080p" : Height >= 720 ? "720p" : (Height >= 480 ? "480p" : `${Height}p`);
              const isHdr = !!(s.color_space?.includes("bt2020") || s.color_transfer?.includes("smpte2084") || s.color_transfer?.includes("arib"));
              const codecName = s.codec_name || "h264";
              const displayTitle = `${resolutionText} ${codecName.toUpperCase()}${isHdr ? " HDR" : " SDR"}`;
              const avgFrameRate = s.avg_frame_rate && s.avg_frame_rate !== "0/0"
                ? s.avg_frame_rate.includes("/")
                  ? s.avg_frame_rate.split("/").map(Number).reduce((a: number, b: number) => a / b)
                  : parseFloat(s.avg_frame_rate)
                : 23.976;

              return {
                Codec: codecName,
                CodecTag: s.codec_tag_string || (codecName === "hevc" ? "hvc1" : "avc1"),
                Language: s.tags?.language || "und",
                TimeBase: s.time_base || "1/1000",
                VideoRange: isHdr ? "HDR" : "SDR",
                VideoRangeType: isHdr ? "HDR10" : "SDR",
                AudioSpatialFormat: "None",
                DisplayTitle: displayTitle,
                NalLengthSize: s.nal_length_size || "4",
                IsInterlaced: false,
                IsAVC: codecName === "h264",
                BitRate: s.bit_rate ? parseInt(s.bit_rate) : (Bitrate || 5000000),
                BitDepth: s.bits_per_raw_sample ? parseInt(s.bits_per_raw_sample) : 8,
                RefFrames: s.refs || 1,
                IsDefault: s.disposition?.default === 1 || s.index === 0,
                IsForced: s.disposition?.forced === 1,
                IsHearingImpaired: s.disposition?.hearing_impaired === 1,
                IsOriginal: s.disposition?.original === 1,
                Height: s.height || Height,
                Width: s.width || Width,
                AverageFrameRate: avgFrameRate,
                RealFrameRate: avgFrameRate,
                ReferenceFrameRate: avgFrameRate,
                Profile: s.profile || "High",
                Type: "Video",
                AspectRatio: s.display_aspect_ratio || (Width && Height ? `${Width}:${Height}` : "16:9"),
                Index: s.index ?? 0,
                IsExternal: false,
                IsTextSubtitleStream: false,
                SupportsExternalStream: false,
                PixelFormat: s.pix_fmt || "yuv420p",
                Level: s.level || 31,
                IsAnamorphic: false,
              };
            } else if (s.codec_type === "audio") {
              let lang = s.tags?.language || "und";
              if (isDublado && (lang === "und" || !lang)) lang = "por";
              if (isLegendado && (lang === "und" || !lang)) lang = "eng";
              const langName = lang === "por" ? "Português" : lang === "eng" ? "Inglês" : (lang === "und" ? "Áudio Principal" : lang);
              const ch = s.channels || 2;
              const chLayout = s.channel_layout || (ch === 6 ? "5.1" : (ch === 1 ? "mono" : "stereo"));
              const chName = ch === 6 ? " 5.1" : (ch === 2 ? " Stereo" : "");
              const codecName = s.codec_name || "aac";
              const isDefaultAudio = s.disposition?.default === 1 || s.index === 1 || s.index === 0;

              return {
                Codec: codecName,
                CodecTag: s.codec_tag_string || (codecName === "mp3" ? "mp3" : "mp4a"),
                Language: lang,
                TimeBase: s.time_base || "1/44100",
                VideoRange: "Unknown",
                VideoRangeType: "Unknown",
                AudioSpatialFormat: "None",
                LocalizedDefault: "Padrão",
                LocalizedExternal: "Externo",
                LocalizedLanguage: langName,
                LocalizedOriginal: "Original",
                DisplayTitle: `${langName}${chName} (${codecName.toUpperCase()})`,
                Title: s.tags?.title || (isDublado ? "Português (Dublado)" : (isLegendado ? "Inglês (Original)" : langName)),
                IsInterlaced: false,
                IsAVC: false,
                ChannelLayout: chLayout,
                BitRate: s.bit_rate ? parseInt(s.bit_rate) : 128000,
                Channels: ch,
                SampleRate: s.sample_rate ? parseInt(s.sample_rate) : 48000,
                IsDefault: isDefaultAudio,
                IsForced: s.disposition?.forced === 1,
                IsHearingImpaired: s.disposition?.hearing_impaired === 1,
                IsOriginal: s.disposition?.original === 1,
                Profile: s.profile || "LC",
                Type: "Audio",
                Index: s.index ?? 1,
                IsExternal: false,
                IsTextSubtitleStream: false,
                SupportsExternalStream: false,
                Level: 0,
              };
            } else if (s.codec_type === "subtitle") {
              const lang = s.tags?.language || "und";
              const langName = lang === "por" ? "Português" : lang === "eng" ? "Inglês" : (lang === "und" ? "Legenda" : lang);
              const isForced = s.disposition?.forced === 1;
              const codecName = s.codec_name || "subrip";

              return {
                Codec: codecName,
                CodecTag: s.codec_tag_string || "srt",
                Language: lang,
                TimeBase: s.time_base || "1/1000",
                VideoRange: "Unknown",
                VideoRangeType: "Unknown",
                AudioSpatialFormat: "None",
                LocalizedDefault: "Padrão",
                LocalizedExternal: "Externo",
                LocalizedForced: "Forçada",
                LocalizedHearingImpaired: "Deficiente auditivo",
                LocalizedLanguage: langName,
                LocalizedOriginal: "Original",
                DisplayTitle: `${langName}${isForced ? " (Forçada)" : ""}`,
                Title: s.tags?.title || langName,
                IsInterlaced: false,
                IsAVC: false,
                IsDefault: s.disposition?.default === 1,
                IsForced: isForced,
                IsHearingImpaired: s.disposition?.hearing_impaired === 1,
                IsOriginal: false,
                Type: "Subtitle",
                Index: s.index ?? 2,
                IsExternal: false,
                IsTextSubtitleStream: true,
                SupportsExternalStream: true,
                DeliveryMethod: "Embed",
                Level: 0,
              };
            }
            return null;
          })
          .filter(Boolean);
      }
    } catch (e) {
      console.error("Failed to parse MediaInfo for", row.Id);
    }
  }

  // Fallback streams if empty
  if (isAudio && MediaStreams.length === 0) {
    MediaStreams = [
      {
        Codec: "mp3",
        CodecTag: "mp3",
        Type: "Audio",
        Index: 0,
        IsDefault: true,
        IsForced: false,
        IsHearingImpaired: false,
        IsOriginal: false,
        IsExternal: false,
        IsTextSubtitleStream: false,
        SupportsExternalStream: false,
        IsInterlaced: false,
        IsAVC: false,
        AudioSpatialFormat: "None",
        VideoRange: "Unknown",
        VideoRangeType: "Unknown",
        LocalizedDefault: "Padrão",
        LocalizedExternal: "Externo",
        LocalizedLanguage: "Português",
        LocalizedOriginal: "Original",
        Channels: 2,
        ChannelLayout: "stereo",
        SampleRate: 44100,
        BitRate: 320000,
        Language: "por",
        DisplayTitle: "Português - MP3 320kbps",
        Title: "Português",
        Level: 0,
      },
    ];
  } else if (isVideo) {
    if (MediaStreams.length === 0) {
      MediaStreams = [
        {
          Codec: "h264",
          CodecTag: "avc1",
          Type: "Video",
          Index: 0,
          IsDefault: true,
          IsForced: false,
          IsHearingImpaired: false,
          IsOriginal: false,
          IsExternal: false,
          IsTextSubtitleStream: false,
          SupportsExternalStream: false,
          IsInterlaced: false,
          IsAVC: true,
          AudioSpatialFormat: "None",
          VideoRange: "SDR",
          VideoRangeType: "SDR",
          Profile: "High",
          Level: 41,
          BitRate: 5000000,
          BitDepth: 8,
          RefFrames: 1,
          Width: 1920,
          Height: 1080,
          AverageFrameRate: 23.976,
          RealFrameRate: 23.976,
          ReferenceFrameRate: 23.976,
          AspectRatio: "16:9",
          PixelFormat: "yuv420p",
          TimeBase: "1/1000",
          NalLengthSize: "4",
          IsAnamorphic: false,
          DisplayTitle: "1080p H264 SDR",
        },
        {
          Codec: "aac",
          CodecTag: "mp4a",
          Type: "Audio",
          Index: 1,
          IsDefault: true,
          IsForced: false,
          IsHearingImpaired: false,
          IsOriginal: false,
          IsExternal: false,
          IsTextSubtitleStream: false,
          SupportsExternalStream: false,
          IsInterlaced: false,
          IsAVC: false,
          AudioSpatialFormat: "None",
          VideoRange: "Unknown",
          VideoRangeType: "Unknown",
          LocalizedDefault: "Padrão",
          LocalizedExternal: "Externo",
          LocalizedLanguage: isDublado ? "Português" : "Inglês",
          LocalizedOriginal: "Original",
          Channels: 2,
          ChannelLayout: "stereo",
          SampleRate: 48000,
          BitRate: 128000,
          Language: isDublado ? "por" : "eng",
          Title: isDublado ? "Português (Dublado)" : "Inglês (Original)",
          DisplayTitle: isDublado ? "Português - AAC" : "Inglês - AAC",
          Profile: "LC",
          Level: 0,
        },
      ];
    }

    // If legendado and has no subtitle stream, add subtitle stream
    const hasSub = MediaStreams.some((s: any) => s.Type === "Subtitle");
    if (isLegendado && !hasSub) {
      MediaStreams.push({
        Type: "Subtitle",
        Index: MediaStreams.length,
        Codec: "subrip",
        CodecTag: "srt",
        Language: "por",
        DisplayTitle: "Português (Embutida no Vídeo)",
        Title: "Português",
        LocalizedDefault: "Padrão",
        LocalizedExternal: "Externo",
        LocalizedForced: "Forçada",
        LocalizedHearingImpaired: "Deficiente auditivo",
        LocalizedLanguage: "Português",
        LocalizedOriginal: "Original",
        IsInterlaced: false,
        IsAVC: false,
        IsDefault: true,
        IsForced: false,
        IsHearingImpaired: false,
        IsOriginal: false,
        IsExternal: false,
        IsTextSubtitleStream: true,
        SupportsExternalStream: true,
        AudioSpatialFormat: "None",
        VideoRange: "Unknown",
        VideoRangeType: "Unknown",
        DeliveryMethod: "Embed",
        Level: 0,
      });
    }
  }

  return { RunTimeTicks, Width, Height, MediaStreams, Bitrate, tmdb };
};

// Home Screen & Latest & Search Handlers
const handleResume = async (c: any) => {
  try {
    const userId = c.req.param("userId") || c.req.query("userId") || DEFAULT_ADMIN_ID;
    const mediaTypes = c.req.query("mediaTypes") || c.req.query("MediaTypes");
    let typeFilter = "AND i.Type IN ('Movie', 'Episode')";
    if (mediaTypes) {
      if (mediaTypes.toLowerCase().includes("audio")) {
        typeFilter = "AND i.Type = 'Audio'";
      } else if (mediaTypes.toLowerCase().includes("video")) {
        typeFilter = "AND i.Type IN ('Movie', 'Episode')";
      } else if (mediaTypes.toLowerCase().includes("book")) {
        typeFilter = "AND i.Type = 'Book'";
      }
    }

    const { results } = await c.env.DB.prepare(`
      SELECT MAX(u.PlaybackPositionTicks) as PlaybackPositionTicks, 
             MAX(u.Played) as Played, 
             MAX(u.IsFavorite) as IsFavorite, 
             MAX(u.LastPlayedDate) as LastPlayedDate, 
             i.* 
      FROM UserItemData u 
      JOIN Items i ON (u.ItemId = i.Id OR u.ItemId = i.Uuid)
      WHERE u.UserId = ? AND u.Played = 0 AND u.PlaybackPositionTicks > 0 ${typeFilter}
      GROUP BY i.Id
      ORDER BY MAX(u.LastPlayedDate) DESC LIMIT 16
    `).bind(userId).all();

    if (!results.length) return c.json({ Items: [], TotalRecordCount: 0 });

    const items = await Promise.all(results.map(async (row: any) => {
      const isVideo = row.Type === "Movie" || row.Type === "Episode";
      const isAudio = row.Type === "Audio";
      const parsed = parseMediaInfo(row);
      const container = isAudio ? "mp3" : (row.Name.endsWith(".mkv") ? "mkv" : "mp4");
      const itemUuid = row.Uuid || toValidUuid(row.Id);

      let sId = undefined;
      let sName = undefined;
      let sPoster = undefined;
      let sBackdrop = undefined;
      let epName = row.Name;
      let epOverview = row.Overview || "";
      let epImage = row.PrimaryImageFileId;

      if (row.Type === "Episode") {
        const season = await resolveItem(c.env.DB, row.ParentId);
        const series = season ? await resolveItem(c.env.DB, season.ParentId) : null;
        if (series) {
          sId = series.Uuid || toValidUuid(series.Id);
          sName = series.Name;
          sPoster = series.PrimaryImageFileId;
          sBackdrop = series.BackdropImageFileId;
          if (series.TmdbId) {
            const seasonNum = row.ParentIndexNumber || (season ? season.IndexNumber : 1) || 1;
            const epMap = await getTvSeasonEpisodes(c.env.TMDB_API_KEY, parseInt(series.TmdbId), seasonNum);
            const tmdbEp = epMap.get(row.IndexNumber || 1);
            if (tmdbEp) {
              if (tmdbEp.name) epName = `${row.IndexNumber || 1}. ${tmdbEp.name}`;
              if (!epOverview && tmdbEp.overview) epOverview = tmdbEp.overview;
              if (tmdbEp.stillPath && !epImage) epImage = tmdbEp.stillPath;
            }
          }
        }
        if (!sName) {
          epName = cleanEpisodeTitle(row.Name, row.IndexNumber);
        }
      }

      const userData = buildUserData(itemUuid, row, parsed.RunTimeTicks);

      return {
        Name: epName,
        ServerId: SERVER_ID,
        Id: itemUuid,
        Container: container,
        IsFolder: false,
        Type: row.Type,
        ParentId: row.ParentId ? toValidUuid(row.ParentId) : (row.LibraryId ? toValidUuid(row.LibraryId) : undefined),
        SeriesId: sId,
        SeriesName: sName,
        SeasonId: row.Type === "Episode" ? toValidUuid(row.ParentId) : undefined,
        SeasonName: row.Type === "Episode" ? `Temporada ${row.ParentIndexNumber || 1}` : undefined,
        IndexNumber: row.IndexNumber,
        ParentIndexNumber: row.ParentIndexNumber,
        LocationType: "FileSystem",
        MediaType: isVideo ? "Video" : (isAudio ? "Audio" : "Unknown"),
        RunTimeTicks: parsed.RunTimeTicks,
        IsPlayable: true,
        PlayAccess: "Full",
        Overview: epOverview,
        PrimaryImageTag: "cached",
        ImageTags: { Primary: "cached" },
        SeriesPrimaryImageTag: sPoster ? "cached" : undefined,
        ParentPrimaryImageItemId: sId,
        ParentPrimaryImageTag: sPoster ? "cached" : undefined,
        ParentBackdropItemId: sId,
        ParentBackdropImageTags: sBackdrop ? ["cached"] : undefined,
        UserData: userData,
        DisplayPreferencesId: toValidUuid("displaypref_" + row.Id),
      };
    }));

    return c.json({ Items: items, TotalRecordCount: items.length });
  } catch (e) {
    return c.json({ Items: [], TotalRecordCount: 0 });
  }
};
app.get("/UserItems/Resume", handleResume);
app.get("/useritems/resume", handleResume);
app.get("/Users/:userId/Items/Resume", handleResume);
app.get("/users/:userId/items/resume", handleResume);

const handleLatestItems = async (c: any) => {
  const userId = c.req.param("userId") || c.req.query("userId") || DEFAULT_ADMIN_ID;
  let parentId = c.req.query("parentId") || c.req.query("ParentId");
  const limit = parseInt(c.req.query("limit") || c.req.query("Limit") || "16");
  const types = getQueryArray(c, "includeItemTypes");

  if (parentId) {
    const lib = await resolveLibrary(c.env.DB, parentId);
    if (lib) {
      parentId = lib.Id;
    } else {
      const parentItem = await resolveItem(c.env.DB, parentId);
      if (parentItem) parentId = parentItem.Id;
    }
  }

  let sql = "SELECT * FROM Items WHERE 1=1";
  const params: any[] = [];

  if (parentId && parentId.startsWith("view_")) {
    sql += " AND LibraryId = ?";
    params.push(parentId);
  } else if (parentId) {
    sql += " AND (ParentId = ? OR LibraryId = ?)";
    params.push(parentId, parentId);
  }

  if (types.length > 0) {
    const placeholders = types.map(() => "?").join(",");
    sql += ` AND Type IN (${placeholders})`;
    params.push(...types);
  } else {
    sql += " AND Type IN ('Movie', 'Series', 'Audio')";
  }

  sql += " ORDER BY ROWID DESC LIMIT ?";
  params.push(limit);

  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  const itemIds = results.map((r: any) => r.Id);
  const userDataMap = await fetchUserItemDataMap(c.env.DB, userId, itemIds);

  const items = results.map((row: any) => {
    const isVideo = row.Type === "Movie" || row.Type === "Episode";
    const isAudio = row.Type === "Audio";
    const isSeries = row.Type === "Series";
    const parsed = parseMediaInfo(row);
    const container = isAudio ? "mp3" : (row.Name.endsWith(".mkv") ? "mkv" : "mp4");
    const yearMatch = row.Name.match(/\((\d{4})\)/);
    const productionYear = yearMatch ? parseInt(yearMatch[1]) : 2024;
    const itemUuid = row.Uuid || toValidUuid(row.Id);
    const userData = buildUserData(itemUuid, userDataMap.get(row.Id) || userDataMap.get(itemUuid), parsed.RunTimeTicks);

    return {
      Name: row.Name,
      ServerId: SERVER_ID,
      Id: itemUuid,
      Container: container,
      IsFolder: isSeries,
      Type: row.Type,
      ParentId: row.LibraryId ? toValidUuid(row.LibraryId) : undefined,
      LocationType: "FileSystem",
      MediaType: isVideo ? "Video" : (isAudio ? "Audio" : "Unknown"),
      RunTimeTicks: parsed.RunTimeTicks,
      ProductionYear: productionYear,
      IsPlayable: isVideo || isAudio,
      PlayAccess: "Full",
      Artists: isAudio ? ["Vários Artistas"] : undefined,
      ArtistItems: isAudio ? [{ Name: "Vários Artistas", Id: toValidUuid("artist_varios"), Type: "MusicArtist" }] : undefined,
      Album: isAudio ? "Músicas" : undefined,
      AlbumId: isAudio ? toValidUuid("album_view_musicas") : undefined,
      AlbumArtist: isAudio ? "Vários Artistas" : undefined,
      AlbumArtists: isAudio ? [{ Name: "Vários Artistas", Id: toValidUuid("artist_varios"), Type: "MusicArtist" }] : undefined,
      PrimaryImageTag: row.PrimaryImageFileId ? (getImageTag(row.PrimaryImageFileId) || "cached") : "cached",
      ImageTags: { Primary: row.PrimaryImageFileId ? (getImageTag(row.PrimaryImageFileId) || "cached") : "cached" },
      BackdropImageTags: row.BackdropImageFileId ? [getImageTag(row.BackdropImageFileId) || "cached"] : ["cached"],
      UserData: userData,
      DisplayPreferencesId: toValidUuid("displaypref_" + row.Id),
    };
  });

  return c.json(items);
};

app.get("/Items/Latest", handleLatestItems);
app.get("/items/latest", handleLatestItems);
app.get("/Users/:userId/Items/Latest", handleLatestItems);
app.get("/users/:userId/items/latest", handleLatestItems);

function getSearchPatterns(word: string): string[] {
  const s = new Set<string>();
  const clean = word.trim();
  if (!clean) return [];
  s.add(`%${clean}%`);
  const unacc = clean.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  s.add(`%${unacc}%`);
  if (clean !== unacc) {
    s.add(`%${clean.replace(/[áàãâéêíóõôúüçÁÀÃÂÉÊÍÓÕÔÚÜÇ]/g, "_")}%`);
  }
  return Array.from(s);
}

app.get("/Search/Hints", async (c) => {
  const searchTerm = (c.req.query("searchTerm") || c.req.query("SearchTerm") || "").trim();
  const limit = parseInt(c.req.query("limit") || c.req.query("Limit") || "24");
  const includeItemTypes = getQueryArray(c, "includeItemTypes");

  if (!searchTerm) {
    return c.json({ SearchHints: [], TotalRecordCount: 0 });
  }

  const words = searchTerm.split(/\s+/).filter(Boolean);
  let sql = "SELECT * FROM Items WHERE ";
  const params: any[] = [];
  const wordClauses = words.map((w) => {
    const patterns = getSearchPatterns(w);
    for (const p of patterns) {
      params.push(p, p);
    }
    return `(${patterns.map(() => "(Name LIKE ? OR Overview LIKE ?)").join(" OR ")})`;
  });
  sql += `(${wordClauses.join(" AND ")})`;

  if (includeItemTypes.length > 0) {
    const placeholders = includeItemTypes.map(() => "?").join(",");
    sql += ` AND Type IN (${placeholders})`;
    params.push(...includeItemTypes);
  } else {
    sql += " AND Type != 'Season'";
  }

  sql += " ORDER BY Name ASC LIMIT ?";
  params.push(limit * 2);

  const { results } = await c.env.DB.prepare(sql).bind(...params).all();

  // Relevance ranking: exact name > startsWith > contains in Name > Overview
  const lowerSearch = searchTerm.toLowerCase();
  const ranked = [...results].sort((a: any, b: any) => {
    const aName = (a.Name || "").toLowerCase();
    const bName = (b.Name || "").toLowerCase();
    const aExact = aName === lowerSearch ? 0 : (aName.startsWith(lowerSearch) ? 1 : (aName.includes(lowerSearch) ? 2 : 3));
    const bExact = bName === lowerSearch ? 0 : (bName.startsWith(lowerSearch) ? 1 : (bName.includes(lowerSearch) ? 2 : 3));
    if (aExact !== bExact) return aExact - bExact;
    return aName.localeCompare(bName);
  }).slice(0, limit);

  const hints = ranked.map((row: any) => {
    const parsed = parseMediaInfo(row);
    const isVideo = row.Type === "Movie" || row.Type === "Episode";
    const isAudio = row.Type === "Audio";
    const yearMatch = row.Name.match(/\((\d{4})\)/);
    const productionYear = yearMatch ? parseInt(yearMatch[1]) : 2024;
    const itemUuid = row.Uuid || toValidUuid(row.Id);

    return {
      ItemId: itemUuid,
      Id: itemUuid,
      Name: row.Name,
      Type: row.Type,
      IsFolder: row.Type === "Series",
      RunTimeTicks: parsed.RunTimeTicks,
      MediaType: isVideo ? "Video" : (isAudio ? "Audio" : "Unknown"),
      ProductionYear: productionYear,
      PrimaryImageTag: (row.PrimaryImageFileId || row.BackdropImageFileId) ? "cached" : "poster",
      BackdropImageTag: row.BackdropImageFileId ? "cached" : "backdrop",
    };
  });

  return c.json({
    SearchHints: hints,
    TotalRecordCount: hints.length,
  });
});

function buildMediaSource(row: any, parsed: any, isVideo: boolean, isAudio: boolean, container: string, requestedId?: string) {
  const audioStream = parsed.MediaStreams.find((s: any) => s.Type === "Audio");
  const defaultAudioIdx = audioStream ? audioStream.Index : (isVideo ? 1 : 0);
  const mediaId = requestedId || row.Uuid || toValidUuid(row.Id);
  const directUrl = isAudio
    ? `/Audio/${mediaId}/stream.${container}`
    : `/Videos/${mediaId}/stream.${container}?Static=true&mediaSourceId=${mediaId}`;

  return {
    Protocol: "File",
    Id: mediaId,
    Path: `/media/${row.Name}`,
    Type: "Default",
    Container: container,
    Size: row.Size || 100000000,
    Name: row.Name,
    IsRemote: false,
    ETag: getImageTag(row.Id) || "etag_123",
    RunTimeTicks: parsed.RunTimeTicks,
    ReadAtNativeFramerate: false,
    IgnoreDts: false,
    IgnoreIndex: false,
    GenPtsInput: false,
    SupportsTranscoding: true,
    SupportsDirectStream: true,
    SupportsDirectPlay: true,
    IsInfiniteStream: false,
    UseMostCompatibleTranscodingProfile: false,
    RequiresOpening: false,
    RequiresClosing: false,
    RequiresLooping: false,
    SupportsProbing: true,
    VideoType: isVideo ? "VideoFile" : undefined,
    MediaStreams: parsed.MediaStreams,
    MediaAttachments: [],
    Formats: [],
    Bitrate: parsed.Bitrate,
    RequiredHttpHeaders: {},
    TranscodingSubProtocol: "http",
    DefaultAudioStreamIndex: defaultAudioIdx,
    DefaultSubtitleStreamIndex: -1,
    HasSegments: false,
    DirectStreamUrl: directUrl,
    TranscodingUrl: directUrl,
  };
}

// Helper to get Item by Id from DB
const getItemById = async (c: any, itemId: string) => {
  const userId = c.req.param("userId") || c.req.query("userId") || DEFAULT_ADMIN_ID;
  
  // 1. Check if Library (by Id or Uuid)
  const lib = await resolveLibrary(c.env.DB, itemId);
  if (lib) {
    const hasImage = !!lib.PrimaryImageFileId;
    const libUuid = lib.Uuid || toValidUuid(lib.Id);
    const imgTag = getImageTag(lib.PrimaryImageFileId);
    return {
      Name: lib.Name,
      ServerId: SERVER_ID,
      Id: libUuid,
      IsFolder: true,
      Type: "CollectionFolder",
      CollectionType: lib.CollectionType || (lib.Name.toLowerCase().includes("filme") ? "movies" : "tvshows"),
      LocationType: "FileSystem",
      PrimaryImageTag: imgTag || "cached",
      ImageTags: { Primary: imgTag || "cached" },
      BackdropImageTags: hasImage ? [imgTag || "cached"] : undefined,
      PrimaryImageAspectRatio: 1.7777777777777777,
    };
  }

  if (itemId.startsWith("album_")) {
    const countRes: any = await c.env.DB.prepare("SELECT COUNT(*) as c FROM Items WHERE Type = 'Audio'").first();
    const childCount = countRes?.c || 1;
    return {
      Name: "Músicas",
      ServerId: SERVER_ID,
      Id: itemId,
      IsFolder: true,
      Type: "MusicAlbum",
      LocationType: "FileSystem",
      MediaType: "Unknown",
      PlayAccess: "Full",
      IsPlayable: true,
      ChildCount: childCount,
      RecursiveItemCount: childCount,
      Overview: "Álbum de músicas da biblioteca.",
      Artists: ["Vários Artistas"],
      ArtistItems: [{ Name: "Vários Artistas", Id: toValidUuid("artist_varios"), Type: "MusicArtist" }],
      AlbumArtist: "Vários Artistas",
      AlbumArtists: [{ Name: "Vários Artistas", Id: toValidUuid("artist_varios"), Type: "MusicArtist" }],
      ImageTags: { Primary: "cached" },
      BackdropImageTags: ["cached"],
      UserData: {
        Played: false,
        PlaybackPositionTicks: 0,
        PlayCount: 0,
        IsFavorite: false,
        Key: itemId,
        ItemId: itemId,
      }
    };
  }

  const row = await resolveItem(c.env.DB, itemId);
  if (!row) return null;

  const itemUuid = row.Uuid || toValidUuid(row.Id);
  const isVideo = row.Type === "Movie" || row.Type === "Episode";
  const isAudio = row.Type === "Audio";
  const isSeries = row.Type === "Series";
  const isSeason = row.Type === "Season";

  const parsed = parseMediaInfo(row);
  const container = isAudio ? "mp3" : (row.Name.endsWith(".mkv") ? "mkv" : "mp4");

  let childCount: number | undefined = undefined;
  let recursiveCount: number | undefined = undefined;
  let seriesName: string | undefined = undefined;
  let seriesId: string | undefined = undefined;
  let seasonName: string | undefined = undefined;
  let seasonId: string | undefined = undefined;
  let seasonRow: any = null;

  if (isSeries) {
    const sCounts: any = await c.env.DB.prepare(
      "SELECT COUNT(*) as seasons, (SELECT COUNT(*) FROM Items WHERE Type IN ('Episode', 'Audio') AND ParentId IN (SELECT Id FROM Items WHERE ParentId = ?)) as episodes FROM Items WHERE ParentId = ? AND Type = 'Season'"
    ).bind(row.Id, row.Id).first();
    if (sCounts) {
      childCount = sCounts.seasons || 1;
      recursiveCount = sCounts.episodes || 0;
    }
  } else if (isSeason) {
    const sRow = await resolveItem(c.env.DB, row.ParentId);
    if (sRow) {
      seriesName = sRow.Name;
      seriesId = sRow.Uuid || toValidUuid(sRow.Id);
    }
  } else if (row.Type === "Episode") {
    seasonRow = await resolveItem(c.env.DB, row.ParentId);
    if (seasonRow) {
      seasonId = seasonRow.Uuid || toValidUuid(seasonRow.Id);
      seasonName = seasonRow.Name;
      const sRow = await resolveItem(c.env.DB, seasonRow.ParentId);
      if (sRow) {
        seriesName = sRow.Name;
        seriesId = sRow.Uuid || toValidUuid(sRow.Id);
      }
    }
  }

  // TMDB enrichment for Movies and Series
  let tmdbDet: any = null;
  if (isSeries || row.Type === "Movie") {
    let tmdbId = row.TmdbId;
    if (!tmdbId) {
      const searchRes = await searchTmdb(c.env.TMDB_API_KEY, row.Name, row.Type);
      if (searchRes) {
        tmdbId = searchRes.id;
      }
    }
    if (tmdbId) {
      tmdbDet = await getTmdbDetails(c.env.TMDB_API_KEY, tmdbId, row.Type);
      if (tmdbDet && (!row.Overview || !row.TmdbId || !row.PrimaryImageFileId)) {
        c.executionCtx?.waitUntil(
          c.env.DB.prepare(`
            UPDATE Items SET 
              Overview = COALESCE(Overview, ?), 
              TmdbId = ?, 
              PrimaryImageFileId = COALESCE(PrimaryImageFileId, ?), 
              BackdropImageFileId = COALESCE(BackdropImageFileId, ?) 
            WHERE Id = ?
          `).bind(tmdbDet.overview, tmdbDet.id, tmdbDet.posterPath, tmdbDet.backdropPath, row.Id).run()
        );
      }
    }
  }

  const cleanName = (isSeries || row.Type === "Movie") && tmdbDet?.title ? tmdbDet.title : row.Name;
  const yearMatch = row.Name.match(/\((\d{4})\)/);
  let productionYear = yearMatch ? parseInt(yearMatch[1]) : 2024;
  if (tmdbDet?.releaseDate) {
    const y = parseInt(tmdbDet.releaseDate.split("-")[0]);
    if (!isNaN(y)) productionYear = y;
  }
  const premiereDate = tmdbDet?.releaseDate ? `${tmdbDet.releaseDate}T00:00:00.0000000Z` : `${productionYear}-01-01T00:00:00.0000000Z`;
  const overview = row.Overview || tmdbDet?.overview || "Sinopse do item gerada pelo servidor.";
  const communityRating = tmdbDet?.voteAverage || (isVideo || isSeries ? 7.0 : undefined);
  const genres = tmdbDet?.genres || [];
  const genreItems = genres.map((g: string) => ({ Name: g, Id: toValidUuid("genre_" + g) }));
  const people = (tmdbDet?.people || []).map((p: any) => ({
    Name: p.Name,
    Id: toValidUuid(p.Id || p.Name),
    Role: p.Role,
    Type: p.Type,
    PrimaryImageTag: p.PrimaryImageTag ? (getImageTag(p.PrimaryImageTag) || "cached") : undefined,
  }));
  const studios = (tmdbDet?.studios || []).map((s: any) => ({
    Name: s.Name,
    Id: toValidUuid(s.Id || s.Name),
  }));
  const tagline = tmdbDet?.tagline || "";

  const parentId = isSeason 
    ? seriesId 
    : (row.Type === "Episode" ? (seasonId || toValidUuid(row.ParentId)) : (row.LibraryId ? toValidUuid(row.LibraryId) : undefined));

  let userItemData: any = null;
  try {
    userItemData = await c.env.DB.prepare(
      "SELECT PlaybackPositionTicks, Played, IsFavorite, LastPlayedDate FROM UserItemData WHERE UserId = ? AND (ItemId = ? OR ItemId = ?)"
    ).bind(userId, row.Id, itemUuid).first();
  } catch (e) {}

  const userData = buildUserData(itemUuid, userItemData, parsed.RunTimeTicks);

  return {
    Name: cleanName,
    ServerId: SERVER_ID,
    Id: itemUuid,
    ParentId: parentId,
    IsFolder: isSeries || isSeason,
    Type: row.Type,
    MediaType: isVideo ? "Video" : (isAudio ? "Audio" : "Unknown"),
    VideoType: isVideo ? "VideoFile" : undefined,
    Container: container,
    LocationType: "FileSystem",
    PlayAccess: "Full",
    IsPlayable: isVideo || isAudio,
    IndexNumber: row.IndexNumber != null ? row.IndexNumber : undefined,
    ParentIndexNumber: row.ParentIndexNumber != null ? row.ParentIndexNumber : undefined,
    RunTimeTicks: parsed.RunTimeTicks,
    ProductionYear: productionYear,
    PremiereDate: premiereDate,
    CommunityRating: communityRating,
    SeriesName: seriesName,
    SeriesId: seriesId,
    SeasonName: seasonName || (row.Type === "Episode" ? `Temporada ${row.ParentIndexNumber || 1}` : undefined),
    SeasonId: isSeason ? itemUuid : (row.Type === "Episode" ? (seasonId || toValidUuid(row.ParentId)) : undefined),
    ParentPrimaryImageItemId: seriesId,
    ParentPrimaryImageTag: seriesId ? "cached" : undefined,
    SeriesPrimaryImageTag: seriesId ? "cached" : undefined,
    ParentBackdropItemId: seriesId,
    ParentBackdropImageTags: seriesId ? ["cached"] : undefined,
    ChildCount: childCount,
    RecursiveItemCount: recursiveCount,
    UserData: userData,
    Width: parsed.Width,
    Height: parsed.Height,
    PrimaryImageTag: row.PrimaryImageFileId ? (getImageTag(row.PrimaryImageFileId) || "cached") : "poster",
    ImageTags: { Primary: row.PrimaryImageFileId ? (getImageTag(row.PrimaryImageFileId) || "cached") : "poster" },
    BackdropImageTags: row.BackdropImageFileId ? [getImageTag(row.BackdropImageFileId) || "cached"] : ["backdrop"],
    Path: row.FileId ? `/media/${row.Name}` : undefined,
    Overview: overview,
    Taglines: tagline ? [tagline] : [],
    People: people,
    Studios: studios,
    Genres: genres,
    GenreItems: genreItems,
    Tags: genres,
    ProviderIds: { Tmdb: row.TmdbId || (tmdbDet?.id ? String(tmdbDet.id) : undefined) },
    Artists: isAudio ? ["Vários Artistas"] : undefined,
    ArtistItems: isAudio ? [{ Name: "Vários Artistas", Id: toValidUuid("artist_varios"), Type: "MusicArtist" }] : undefined,
    Album: isAudio ? "Músicas" : undefined,
    AlbumId: isAudio ? toValidUuid("album_view_musicas") : undefined,
    AlbumArtist: isAudio ? "Vários Artistas" : undefined,
    AlbumArtists: isAudio ? [{ Name: "Vários Artistas", Id: toValidUuid("artist_varios"), Type: "MusicArtist" }] : undefined,
    CanDownload: false,
    CanDelete: false,
    Chapters: [],
    Trickplay: {},
    DateCreated: row.DateCreated ? `${String(row.DateCreated).replace(" ", "T")}.0000000Z` : "2024-01-01T00:00:00.0000000Z",
    SortName: (cleanMediaTitle(cleanName).query || cleanName).toLowerCase(),
    OriginalTitle: cleanName,
    ChannelId: undefined,
    EnableMediaSourceDisplay: true,
    DisplayPreferencesId: toValidUuid("displaypref_" + row.Id),
    PrimaryImageAspectRatio: isVideo ? 1.7777778 : 0.6666667,
    LocalTrailerCount: 0,
    SpecialFeatureCount: 0,
    LockData: false,
    LockedFields: [],
    ExternalUrls: [],
    ProductionLocations: [],
    RemoteTrailers: [],
    Etag: getImageTag(row.Id) || "etag_123",
    ImageBlurHashes: {},
    MediaSources: (isVideo || isAudio)
      ? [buildMediaSource(row, parsed, isVideo, isAudio, container, itemUuid)]
      : undefined,
    MediaStreams: parsed.MediaStreams,
  };
};

app.get("/users/:userId/items/:itemId", async (c) => {
  const item = await getItemById(c, c.req.param("itemId"));
  if (item) return c.json(item);
  return c.notFound();
});
app.get("/items/:itemId", async (c) => {
  const item = await getItemById(c, c.req.param("itemId"));
  if (item) return c.json(item);
  return c.notFound();
});
app.get("/Users/:userId/Items/:itemId", async (c) => {
  const item = await getItemById(c, c.req.param("itemId"));
  if (item) return c.json(item);
  return c.notFound();
});

app.get("/Items/:itemId", async (c) => {
  const item = await getItemById(c, c.req.param("itemId"));
  if (item) return c.json(item);
  return c.notFound();
});

async function serveImageOrProxy(c: any, fileId: string | null | undefined, fallbackText?: string, isBackdrop?: boolean): Promise<Response> {
  const fallbackDims = isBackdrop ? "1280x720" : "400x600";
  const text = encodeURIComponent(fallbackText || "Image");
  const fallbackUrl = `https://placehold.co/${fallbackDims}/141414/e50914.png?text=${text}`;

  const serveFallback = async () => {
    try {
      const resp = await fetch(fallbackUrl);
      if (resp.ok) {
        const headers = new Headers();
        headers.set("Content-Type", "image/png");
        headers.set("Cache-Control", "public, max-age=86400");
        headers.set("Access-Control-Allow-Origin", "*");
        return new Response(resp.body, { headers });
      }
    } catch (e) {}
    return c.redirect(fallbackUrl, 302);
  };

  if (!fileId) {
    return serveFallback();
  }

  // 1. Data URL (Base64)
  if (fileId.startsWith("data:")) {
    try {
      const parts = fileId.split(",");
      const mime = parts[0].split(":")[1]?.split(";")[0] || "image/jpeg";
      const binary = atob(parts[1]);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const headers = new Headers();
      headers.set("Content-Type", mime);
      headers.set("Cache-Control", "public, max-age=31536000");
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(bytes.buffer, { headers });
    } catch (e) {
      console.error("Failed to decode data URL image:", e);
    }
  }

  // 2. HTTP/HTTPS URL (e.g. TMDB, external poster) -> Proxy with full CORS headers
  if (fileId.startsWith("http://") || fileId.startsWith("https://")) {
    try {
      const resp = await fetch(fileId);
      if (resp.ok) {
        const headers = new Headers();
        headers.set("Content-Type", resp.headers.get("Content-Type") || "image/jpeg");
        headers.set("Cache-Control", "public, max-age=31536000");
        headers.set("Access-Control-Allow-Origin", "*");
        return new Response(resp.body, { headers });
      }
    } catch (e) {
      console.error("Failed to proxy image:", fileId, e);
    }
    return c.redirect(fileId, 302);
  }

  // 3. Google Drive file ID
  try {
    const gdrive = new GoogleDrive(c.env);
    const token = await gdrive.getAccessToken();
    const gdriveResponse = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (gdriveResponse.ok) {
      const headers = new Headers();
      headers.set("Content-Type", gdriveResponse.headers.get("Content-Type") || "image/jpeg");
      headers.set("Cache-Control", "public, max-age=31536000");
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(gdriveResponse.body, { headers });
    }
  } catch (e) {
    console.error("Failed to fetch image from Google Drive:", fileId, e);
  }

  return serveFallback();
}

const imageHandler = async (c: any) => {
  const itemId = c.req.param("itemId");
  const imageType = (c.req.param("imageType") || "primary").toLowerCase(); // primary, backdrop, thumb, logo
  const isPrimary = imageType.startsWith("primary") || imageType.startsWith("thumb");
  const isBackdrop = imageType.startsWith("backdrop");

  // 1. Branding Logo
  if (itemId === "branding_logo") {
    return serveImageOrProxy(c, "1uLeX5LtyVsmi9-M08ho7qEEwVcAUH7PC", "Jellyfin");
  }

  // 2. Library Cover
  const lib: any = await resolveLibrary(c.env.DB, itemId);
  if (lib) {
    // Respect the image type requested by Jellyfin Web. A backdrop may fall
    // back to the cover, but a Primary request must never return a backdrop.
    const libraryImage = isBackdrop
      ? (lib.BackdropImageFileId || lib.PrimaryImageFileId)
      : lib.PrimaryImageFileId;
    return serveImageOrProxy(c, libraryImage, lib.Name || itemId, isBackdrop);
  }

  // 2.1 Person Images
  if (itemId.startsWith("person_")) {
    const tag = c.req.query("tag") || c.req.query("Tag");
    if (tag && (tag.startsWith("http://") || tag.startsWith("https://"))) {
      return serveImageOrProxy(c, tag, itemId);
    }
    const tmdbPersonId = itemId.replace("person_", "");
    if (/^\d+$/.test(tmdbPersonId)) {
      try {
        const pRes = await fetch(`https://api.themoviedb.org/3/person/${tmdbPersonId}?api_key=844dba0bfd8f3a4f3799f6130ef9e335`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/json",
          }
        });
        if (pRes.ok) {
          const pData: any = await pRes.json();
          if (pData.profile_path) {
            return serveImageOrProxy(c, `https://image.tmdb.org/t/p/w185${pData.profile_path}`, pData.name);
          }
        }
      } catch (e) {}
    }
    return serveImageOrProxy(c, null, itemId);
  }

  const item: any = await resolveItem(c.env.DB, itemId);
  if (!item) {
    const tag = c.req.query("tag") || c.req.query("Tag");
    if (tag && (tag.startsWith("http://") || tag.startsWith("https://"))) {
      return serveImageOrProxy(c, tag, itemId, isBackdrop);
    }
    return c.notFound();
  }

  let fileId = isPrimary ? item.PrimaryImageFileId : item.BackdropImageFileId;
  if (!fileId && !isPrimary) {
    fileId = item.PrimaryImageFileId;
  }

  if (fileId) {
    return serveImageOrProxy(c, fileId, item.Name, isBackdrop);
  }

  // 2.1 Special handling for Episodes: Look up TMDB still, or fall back to Series image!
  if (item.Type === "Episode") {
    const season: any = await c.env.DB.prepare("SELECT * FROM Items WHERE Id = ?").bind(item.ParentId).first();
    let series: any = season ? await c.env.DB.prepare("SELECT * FROM Items WHERE Id = ?").bind(season.ParentId).first() : null;
    if (!series && season && season.Type === "Series") {
      series = season;
    }
    if (series) {
      let seriesTmdbId = series.TmdbId;
      if (!seriesTmdbId) {
        const sSearch = await searchTmdb(c.env.TMDB_API_KEY, series.Name, "Series");
        if (sSearch) {
          seriesTmdbId = sSearch.id;
          c.executionCtx?.waitUntil(
            c.env.DB.prepare("UPDATE Items SET TmdbId = ?, PrimaryImageFileId = COALESCE(PrimaryImageFileId, ?), BackdropImageFileId = COALESCE(BackdropImageFileId, ?) WHERE Id = ?")
              .bind(sSearch.id, sSearch.posterPath, sSearch.backdropPath, series.Id)
              .run()
          );
        }
      }
      if (seriesTmdbId) {
        const seasonNum = item.ParentIndexNumber || (season ? season.IndexNumber : 1) || 1;
        const epNum = item.IndexNumber || 1;
        const epMap = await getTvSeasonEpisodes(c.env.TMDB_API_KEY, parseInt(seriesTmdbId), seasonNum);
        const tmdbEp = epMap.get(epNum);
        if (tmdbEp && tmdbEp.stillPath) {
          c.executionCtx?.waitUntil(
            c.env.DB.prepare("UPDATE Items SET PrimaryImageFileId = ?, Overview = COALESCE(Overview, ?) WHERE Id = ?")
              .bind(tmdbEp.stillPath, tmdbEp.overview, itemId)
              .run()
          );
          return serveImageOrProxy(c, tmdbEp.stillPath, item.Name, isBackdrop);
        }
      }
      // Fall back to series image!
      const fallback = isBackdrop ? (series.BackdropImageFileId || series.PrimaryImageFileId) : (series.PrimaryImageFileId || series.BackdropImageFileId);
      if (fallback) {
        return serveImageOrProxy(c, fallback, series.Name, isBackdrop);
      }
    }
  }

  // 2.2 Special handling for Seasons: Fall back to Series image!
  if (item.Type === "Season") {
    const series: any = await c.env.DB.prepare("SELECT * FROM Items WHERE Id = ?").bind(item.ParentId).first();
    if (series) {
      const fallback = isBackdrop ? (series.BackdropImageFileId || series.PrimaryImageFileId) : (series.PrimaryImageFileId || series.BackdropImageFileId);
      if (fallback) {
        return serveImageOrProxy(c, fallback, series.Name, isBackdrop);
      }
    }
  }

  // 2.3 Movies or Series without an image: search TMDB
  const tmdbData = await searchTmdb(
    c.env.TMDB_API_KEY,
    item.Name as string,
    item.Type as any,
  );

  if (tmdbData) {
    const tmdbUrl = isPrimary ? tmdbData.posterPath : tmdbData.backdropPath;
    if (tmdbUrl) {
      c.executionCtx?.waitUntil(
        (async () => {
          try {
            if (isPrimary) {
              await c.env.DB.prepare("UPDATE Items SET PrimaryImageFileId = ?, TmdbId = ? WHERE Id = ?")
                .bind(tmdbUrl, tmdbData.id, itemId)
                .run();
            } else {
              await c.env.DB.prepare("UPDATE Items SET BackdropImageFileId = ?, TmdbId = ? WHERE Id = ?")
                .bind(tmdbUrl, tmdbData.id, itemId)
                .run();
            }
          } catch (e) {}
        })()
      );
      return serveImageOrProxy(c, tmdbUrl, item.Name, isBackdrop);
    }
  }

  const cleanLabel = cleanMediaTitle(item.Name as string).query || item.Name;
  return serveImageOrProxy(c, null, cleanLabel as string, isBackdrop);
};

app.get("/Items/:itemId/Images/:imageType", imageHandler);
app.get("/Items/:itemId/Images/:imageType/:index", imageHandler);
app.get("/items/:itemId/images/:imageType", imageHandler);
app.get("/items/:itemId/images/:imageType/:index", imageHandler);
app.get("/Items/:itemId/images/:imageType", imageHandler);
app.get("/Items/:itemId/images/:imageType/:index", imageHandler);
app.get("/items/:itemId/Images/:imageType", imageHandler);
app.get("/items/:itemId/Images/:imageType/:index", imageHandler);
app.get("/Users/:userId/Items/:itemId/Images/:imageType", imageHandler);
app.get("/Users/:userId/Items/:itemId/Images/:imageType/:index", imageHandler);
app.get("/users/:userId/items/:itemId/images/:imageType", imageHandler);
app.get("/users/:userId/items/:itemId/images/:imageType/:index", imageHandler);

const handleImageList = async (c: any) => {
  const itemId = c.req.param("itemId");
  const lib: any = await resolveLibrary(c.env.DB, itemId);
  if (lib) {
    const images: any[] = [];
    if (lib.PrimaryImageFileId) {
      images.push({
        ImageType: "Primary",
        ImageIndex: 0,
        ImageTag: getImageTag(lib.PrimaryImageFileId),
        Path: lib.PrimaryImageFileId,
        Height: 600,
        Width: 400,
        Size: 100000,
      });
    }
    if (lib.BackdropImageFileId) {
      images.push({
        ImageType: "Backdrop",
        ImageIndex: 0,
        ImageTag: getImageTag(lib.BackdropImageFileId),
        Path: lib.BackdropImageFileId,
        Height: 720,
        Width: 1280,
        Size: 100000,
      });
    }
    return c.json(images);
  }
  const item: any = await resolveItem(c.env.DB, itemId);
  if (!item) return c.json([]);
  const images: any[] = [];
  if (item.PrimaryImageFileId) {
    images.push({
      ImageType: "Primary",
      ImageIndex: 0,
      ImageTag: "cached",
      Path: item.PrimaryImageFileId,
      Height: 600,
      Width: 400,
      Size: 100000,
    });
  }
  return c.json(images);
};
app.get("/Items/:itemId/Images", handleImageList);
app.get("/items/:itemId/images", handleImageList);
app.get("/Users/:userId/Items/:itemId/Images", handleImageList);
app.get("/users/:userId/items/:itemId/images", handleImageList);


app.get("/Items/:itemId/RemoteImages/Providers", async (c) => {
  return c.json([
    {
      Name: "TheMovieDb",
      Order: 0
    }
  ]);
});

app.get("/Items/:itemId/RemoteImages", async (c) => {
  const itemId = c.req.param("itemId");
  const imageType = c.req.query("type") || c.req.query("Type");

  if (itemId.startsWith("view_")) {
    const { results } = await c.env.DB.prepare(
      "SELECT PrimaryImageFileId, BackdropImageFileId, Name FROM Items WHERE (LibraryId = ? OR ParentId = ?) AND PrimaryImageFileId IS NOT NULL LIMIT 20"
    ).bind(itemId, itemId).all();

    const images = results.map((r: any) => ({
      ProviderName: "TheMovieDb",
      Url: r.PrimaryImageFileId,
      ThumbnailUrl: r.PrimaryImageFileId,
      Height: 750,
      Width: 500,
      CommunityRating: 8.0,
      VoteCount: 100,
      Type: "Primary",
      RatingType: "Score"
    }));
    return c.json({ Images: images, TotalRecordCount: images.length, Providers: ["TheMovieDb"] });
  }

  const item: any = await c.env.DB.prepare("SELECT * FROM Items WHERE Id = ?").bind(itemId).first();
  if (!item) {
    return c.json({ Images: [], TotalRecordCount: 0, Providers: ["TheMovieDb"] });
  }

  let tmdbId: number | null = null;
  let type: "Movie" | "Series" = item.Type === "Series" ? "Series" : "Movie";

  if (item.TmdbId) {
    tmdbId = parseInt(item.TmdbId);
  } else {
    const s = await searchTmdb(c.env.TMDB_API_KEY, item.Name, item.Type);
    if (s) {
      tmdbId = s.id;
    }
  }

  if (tmdbId) {
    const images = await getTmdbImages(c.env.TMDB_API_KEY, tmdbId, type);
    const mapped = images
      .filter((img) => !imageType || img.type.toLowerCase() === imageType.toLowerCase())
      .map((img) => ({
        ProviderName: "TheMovieDb",
        Url: img.url,
        ThumbnailUrl: img.thumbnailUrl,
        Height: img.height,
        Width: img.width,
        CommunityRating: img.communityRating,
        VoteCount: 100,
        Language: img.language,
        Type: img.type,
        RatingType: "Score",
      }));
    return c.json({ Images: mapped, TotalRecordCount: mapped.length, Providers: ["TheMovieDb"] });
  }

  return c.json({ Images: [], TotalRecordCount: 0, Providers: ["TheMovieDb"] });
});

app.post("/Items/:itemId/RemoteImages/Download", async (c) => {
  const itemId = c.req.param("itemId");
  let type = c.req.query("type") || c.req.query("Type") || "Primary";
  let imageUrl = c.req.query("imageUrl") || c.req.query("ImageUrl");

  if (!imageUrl) {
    const body = await c.req.json().catch(() => ({}));
    imageUrl = body.ImageUrl || body.imageUrl || body.Url || body.url;
    if (body.Type || body.type) type = body.Type || body.type;
  }

  if (imageUrl) {
    if (itemId.startsWith("view_")) {
      await c.env.DB.prepare("UPDATE Libraries SET PrimaryImageFileId = ? WHERE Id = ?").bind(imageUrl, itemId).run();
    } else {
      if (type.toLowerCase().includes("backdrop")) {
        const item = await resolveItem(c.env.DB, itemId);
        if (item) {
          await c.env.DB.prepare("UPDATE Items SET BackdropImageFileId = ? WHERE Id = ?").bind(imageUrl, item.Id).run();
        }
      } else {
        const item = await resolveItem(c.env.DB, itemId);
        if (item) {
          await c.env.DB.prepare("UPDATE Items SET PrimaryImageFileId = ? WHERE Id = ?").bind(imageUrl, item.Id).run();
        }
      }
    }
  }

  return c.body(null, 204);
});

const itemsHandler = async (c: any) => {
  const userId = c.req.param("userId") || c.req.query("userId") || c.req.query("UserId") || DEFAULT_ADMIN_ID;
  let parentId = c.req.query("parentId") || c.req.query("ParentId");
  const ids = c.req.query("ids") || c.req.query("Ids");
  const includeItemTypes = getQueryArray(c, "includeItemTypes");
  const excludeItemTypes = getQueryArray(c, "excludeItemTypes");
  const searchTerm = (c.req.query("searchTerm") || c.req.query("SearchTerm") || "").trim();
  const limit = parseInt(c.req.query("limit") || c.req.query("Limit") || "100");
  const startIndex = parseInt(c.req.query("startIndex") || c.req.query("StartIndex") || "0");

  if (parentId) {
    const lib = await resolveLibrary(c.env.DB, parentId);
    if (lib) {
      parentId = lib.Id;
    } else {
      const parentItem = await resolveItem(c.env.DB, parentId);
      if (parentItem) {
        parentId = parentItem.Id;
      }
    }
  }

  let results: any[] = [];
  let totalRecordCount = 0;

  if (ids) {
    const idList = ids.split(",").map((s: string) => s.trim()).filter(Boolean);
    const placeholders = idList.map(() => "?").join(",");
    const query = await c.env.DB.prepare(`SELECT * FROM Items WHERE Id IN (${placeholders}) OR Uuid IN (${placeholders})`);
    const { results: res } = await query.bind(...idList, ...idList).all();
    results = res;
    totalRecordCount = res.length;
  } else if (searchTerm) {
    const words = searchTerm.split(/\s+/).filter(Boolean);
    let sql = "SELECT * FROM Items WHERE ";
    const bindParams: any[] = [];
    const wordClauses = words.map((w: string) => {
      const patterns = getSearchPatterns(w);
      const subClauses = patterns.map(p => {
        bindParams.push(`%${p}%`);
        return "Name LIKE ?";
      });
      return `(${subClauses.join(" OR ")})`;
    });
    sql += wordClauses.join(" AND ");

    if (includeItemTypes.length > 0) {
      const placeholders = includeItemTypes.map(() => "?").join(",");
      sql += ` AND Type IN (${placeholders})`;
      bindParams.push(...includeItemTypes);
    } else if (excludeItemTypes.length > 0) {
      const placeholders = excludeItemTypes.map(() => "?").join(",");
      sql += ` AND Type NOT IN (${placeholders})`;
      bindParams.push(...excludeItemTypes);
    } else {
      sql += " AND Type != 'Season'";
    }

    const countSql = sql.replace(/^SELECT \* FROM Items/i, "SELECT COUNT(*) as c FROM Items");
    const countRes: any = await c.env.DB.prepare(countSql).bind(...bindParams).first();
    totalRecordCount = countRes ? countRes.c : 0;

    sql += " ORDER BY Name ASC LIMIT ? OFFSET ?";
    bindParams.push(limit, startIndex);

    const { results: res } = await c.env.DB.prepare(sql).bind(...bindParams).all();

    // Rank relevance for search results
    const lowerSearch = searchTerm.toLowerCase();
    results = [...res].sort((a: any, b: any) => {
      const aName = (a.Name || "").toLowerCase();
      const bName = (b.Name || "").toLowerCase();
      const aExact = aName === lowerSearch ? 0 : (aName.startsWith(lowerSearch) ? 1 : (aName.includes(lowerSearch) ? 2 : 3));
      const bExact = bName === lowerSearch ? 0 : (bName.startsWith(lowerSearch) ? 1 : (bName.includes(lowerSearch) ? 2 : 3));
      if (aExact !== bExact) return aExact - bExact;
      return aName.localeCompare(bName);
    });
  } else if (parentId && parentId.startsWith("album_")) {
    const realParent = parentId.replace("album_", "");
    let sql = "SELECT * FROM Items WHERE Type = 'Audio'";
    const bindParams: any[] = [];
    if (realParent && realParent !== "default") {
      sql += " AND (ParentId = ? OR LibraryId = ?)";
      bindParams.push(realParent, realParent);
    }
    const countSql = sql.replace(/^SELECT \* FROM Items/i, "SELECT COUNT(*) as c FROM Items");
    const countRes: any = await c.env.DB.prepare(countSql).bind(...bindParams).first();
    totalRecordCount = countRes ? countRes.c : 0;

    sql += " ORDER BY Name ASC LIMIT ? OFFSET ?";
    bindParams.push(limit, startIndex);
    const { results: res } = await c.env.DB.prepare(sql).bind(...bindParams).all();
    results = res;
  } else if (parentId) {
    let realParentId = parentId;
    const parentLib = await resolveLibrary(c.env.DB, parentId);
    if (parentLib) {
      realParentId = parentLib.Id;
    } else {
      const parentItem = await resolveItem(c.env.DB, parentId);
      if (parentItem) {
        realParentId = parentItem.Id;
      }
    }
    let sql = "SELECT * FROM Items WHERE (ParentId = ? OR LibraryId = ? OR ParentId = ? OR LibraryId = ?)";
    const bindParams: any[] = [realParentId, realParentId, parentId, parentId];
    if (includeItemTypes.length > 0) {
      const placeholders = includeItemTypes.map(() => "?").join(",");
      sql += ` AND Type IN (${placeholders})`;
      bindParams.push(...includeItemTypes);
    } else if (excludeItemTypes.length > 0) {
      const placeholders = excludeItemTypes.map(() => "?").join(",");
      sql += ` AND Type NOT IN (${placeholders})`;
      bindParams.push(...excludeItemTypes);
    } else if (realParentId.startsWith("view_")) {
      // Library root: only show Movie, Series, Audio (never loose Season or Episode)
      sql += " AND Type IN ('Movie', 'Series', 'Audio')";
    }
    
    const countSql = sql.replace(/^SELECT \* FROM Items/i, "SELECT COUNT(*) as c FROM Items");
    const countRes: any = await c.env.DB.prepare(countSql).bind(...bindParams).first();
    totalRecordCount = countRes ? countRes.c : 0;

    sql += " ORDER BY Name ASC LIMIT ? OFFSET ?";
    bindParams.push(limit, startIndex);

    const { results: res } = await c.env.DB.prepare(sql).bind(...bindParams).all();
    results = res;
  } else {
    let sql = "SELECT * FROM Items WHERE ";
    const bindParams: any[] = [];
    if (includeItemTypes.length > 0) {
      const placeholders = includeItemTypes.map(() => "?").join(",");
      sql += `Type IN (${placeholders})`;
      bindParams.push(...includeItemTypes);
    } else if (excludeItemTypes.length > 0) {
      const placeholders = excludeItemTypes.map(() => "?").join(",");
      sql += `Type NOT IN (${placeholders})`;
      bindParams.push(...excludeItemTypes);
    } else {
      sql += "Type IN ('Movie', 'Series', 'Audio')";
    }
    
    const countSql = sql.replace(/^SELECT \* FROM Items/i, "SELECT COUNT(*) as c FROM Items");
    const countRes: any = await c.env.DB.prepare(countSql).bind(...bindParams).first();
    totalRecordCount = countRes ? countRes.c : 0;

    sql += " ORDER BY Name ASC LIMIT ? OFFSET ?";
    bindParams.push(limit, startIndex);

    const { results: res } = await c.env.DB.prepare(sql).bind(...bindParams).all();
    results = res;
  }

  // Handle MusicAlbum synthesis if requested and empty
  if (includeItemTypes.includes("MusicAlbum") && results.length === 0) {
    const audioQuery = parentId ? "SELECT COUNT(*) as c FROM Items WHERE (ParentId = ? OR LibraryId = ?) AND Type = 'Audio'" : "SELECT COUNT(*) as c FROM Items WHERE Type = 'Audio'";
    const audioRes: any = parentId 
      ? await c.env.DB.prepare(audioQuery).bind(parentId, parentId).first()
      : await c.env.DB.prepare(audioQuery).first();
    if (audioRes && audioRes.c > 0) {
      const album = {
        Name: "Músicas",
        ServerId: SERVER_ID,
        Id: toValidUuid(`album_${parentId || 'default'}`),
        Type: "MusicAlbum",
        IsFolder: true,
        LocationType: "FileSystem",
        MediaType: "Unknown",
        ChildCount: audioRes.c,
        RecursiveItemCount: audioRes.c,
        Artists: ["Vários Artistas"],
        ArtistItems: [{ Name: "Vários Artistas", Id: toValidUuid("artist_varios"), Type: "MusicArtist" }],
        AlbumArtist: "Vários Artistas",
        AlbumArtists: [{ Name: "Vários Artistas", Id: toValidUuid("artist_varios"), Type: "MusicArtist" }],
        ImageTags: { Primary: "cached" },
        BackdropImageTags: undefined,
        UserData: {
          PlaybackPositionTicks: 0,
          PlayCount: 0,
          IsFavorite: false,
          Played: false,
          Key: `album_${parentId || 'default'}`,
          ItemId: toValidUuid(`album_${parentId || 'default'}`),
        }
      };
      return c.json({ Items: [album], TotalRecordCount: 1, StartIndex: 0 });
    }
  }

  // --- FALLBACK GOOGLE DRIVE ---
  if (results.length === 0 && parentId && !parentId.startsWith("album_") && !parentId.startsWith("view_") && !parentId.startsWith("artist_") && !parentId.startsWith("genre_")) {
    try {
      let driveFolderId = parentId;
      const maybeLib = await resolveLibrary(c.env.DB, parentId);
      if (maybeLib && maybeLib.FolderId) {
        driveFolderId = maybeLib.FolderId;
      } else {
        const maybeItem = await resolveItem(c.env.DB, parentId);
        if (maybeItem && maybeItem.FolderId) {
          driveFolderId = maybeItem.FolderId;
        } else if (maybeItem && maybeItem.Id) {
          driveFolderId = maybeItem.Id;
        }
      }

      const gdrive = new GoogleDrive(c.env);
      const data = await gdrive.listFolder(driveFolderId);
      if (data && data.files) {
        let driveItems = data.files.map((file: any) => {
          const targetMime = file.shortcutDetails?.targetMimeType || file.mimeType;
          const isFolder = targetMime === "application/vnd.google-apps.folder";
          const isVideo = file.mimeType?.startsWith("video/") || targetMime?.startsWith("video/");
          const isAudio = file.mimeType?.startsWith("audio/") || targetMime?.startsWith("audio/");
          const type = isFolder ? "Folder" : (isVideo ? "Video" : (isAudio ? "Audio" : "Unknown"));
          
          let pathId = file.shortcutDetails?.targetId || file.id;
          const itemUuid = toValidUuid(pathId);

          return {
            Name: file.name,
            ServerId: SERVER_ID,
            Id: itemUuid,
            Path: `/media/${pathId}`,
            IsFolder: isFolder,
            Type: type,
            LocationType: "FileSystem",
            MediaType: isVideo ? "Video" : (isAudio ? "Audio" : "Unknown"),
            Size: file.size ? parseInt(file.size) : undefined,
            DateCreated: file.createdTime ? `${String(file.createdTime).replace(" ", "T")}.0000000Z` : "2024-01-01T00:00:00.0000000Z",
            ImageTags: {},
            UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: itemUuid, ItemId: itemUuid }
          };
        });
        
        if (includeItemTypes.length > 0) {
          driveItems = driveItems.filter((r: any) => includeItemTypes.includes(r.Type) || (r.Type === "Video" && includeItemTypes.includes("Movie")) || (r.Type === "Folder" && includeItemTypes.includes("Folder")));
        } else if (excludeItemTypes.length > 0) {
          driveItems = driveItems.filter((r: any) => !excludeItemTypes.includes(r.Type) && !(r.Type === "Video" && excludeItemTypes.includes("Movie")));
        }

        totalRecordCount = driveItems.length;
        const sliced = driveItems.slice(startIndex, startIndex + limit);
        return c.json({ Items: sliced, TotalRecordCount: totalRecordCount, StartIndex: startIndex });
      }
    } catch (e) {
      return c.json({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
    }
  }
  // -----------------------------

  const itemIds = results.map((r: any) => r.Id);
  const userDataMap = await fetchUserItemDataMap(c.env.DB, userId, itemIds);

  const jellyfinItems: any[] = [];
  const groupedItemsMap = new Map<string, any>();

  for (const row of results) {
    const isVideo = row.Type === "Movie" || row.Type === "Episode";
    const isAudio = row.Type === "Audio";
    const isSeries = row.Type === "Series";
    const parsed = parseMediaInfo(row);
    const tmdb = parsed.tmdb || {};
    const container = isAudio ? "mp3" : (row.Name.endsWith(".mkv") ? "mkv" : "mp4");
    
    let cleanName = row.Name;
    if (isSeries || row.Type === "Movie") {
      cleanName = tmdb.title || cleanMediaTitle(row.Name).query;
    } else if (row.Type === "Episode") {
      cleanName = tmdb.title || cleanEpisodeTitle(row.Name, row.IndexNumber);
    }
    
    const yearMatch = row.Name.match(/\((\d{4})\)/);
    const productionYear = tmdb.year || (yearMatch ? parseInt(yearMatch[1]) : 2024);
    const premiereDate = tmdb.releaseDate ? `${tmdb.releaseDate}T00:00:00.0000000Z` : `${productionYear}-01-01T00:00:00.0000000Z`;
    const overview = row.Overview || tmdb.overview || "";
    const communityRating = tmdb.rating || (isVideo || isSeries ? 7.0 : undefined);
    const genres = tmdb.genres || [];
    const itemUuid = row.Uuid || toValidUuid(row.Id);
    const parentUuid = row.ParentId ? toValidUuid(row.ParentId) : (row.LibraryId ? toValidUuid(row.LibraryId) : undefined);
    const userData = buildUserData(itemUuid, userDataMap.get(row.Id) || userDataMap.get(itemUuid), parsed.RunTimeTicks);
    const hasImage = !!(row.PrimaryImageFileId || row.BackdropImageFileId);

    const item = {
      Name: cleanName,
      ServerId: SERVER_ID,
      Id: itemUuid,
      ParentId: parentUuid,
      HasSubtitles: parsed.MediaStreams.some((s: any) => s.Type === "Subtitle"),
      Container: container,
      PremiereDate: premiereDate,
      ProductionYear: productionYear,
      CommunityRating: communityRating,
      Genres: genres,
      Overview: overview,
      IndexNumber: row.IndexNumber || 1,
      ParentIndexNumber: row.ParentIndexNumber || 1,
      IsFolder: row.Type === "Series" || row.Type === "Season",
      Type: row.Type,
      UserData: userData,
      PrimaryImageTag: row.PrimaryImageFileId ? (getImageTag(row.PrimaryImageFileId) || "cached") : "cached",
      ImageTags: { Primary: row.PrimaryImageFileId ? (getImageTag(row.PrimaryImageFileId) || "cached") : "cached" },
      BackdropImageTags: row.BackdropImageFileId ? [getImageTag(row.BackdropImageFileId) || "cached"] : ["cached"],
      LocationType: "FileSystem",
      MediaType: isVideo ? "Video" : (isAudio ? "Audio" : "Unknown"),
      RunTimeTicks: parsed.RunTimeTicks,
      IsPlayable: isVideo || isAudio,
      PlayAccess: "Full",
      Artists: isAudio ? ["Vários Artistas"] : undefined,
      ArtistItems: isAudio ? [{ Name: "Vários Artistas", Id: toValidUuid("artist_varios"), Type: "MusicArtist" }] : undefined,
      Album: isAudio ? "Músicas" : undefined,
      AlbumId: isAudio ? toValidUuid("album_view_musicas") : undefined,
      AlbumArtist: isAudio ? "Vários Artistas" : undefined,
      AlbumArtists: isAudio ? [{ Name: "Vários Artistas", Id: toValidUuid("artist_varios"), Type: "MusicArtist" }] : undefined,
      MediaSources: (isVideo || isAudio)
        ? [buildMediaSource(row, parsed, isVideo, isAudio, container, itemUuid)]
        : undefined,
    };

    if (row.Type === "Movie" || row.Type === "Episode") {
      const key = `${row.Type}_${cleanName}_${row.ParentId || row.LibraryId}`;
      if (groupedItemsMap.has(key)) {
        const existing = groupedItemsMap.get(key);
        if (item.MediaSources && existing.MediaSources) {
          existing.MediaSources.push(...item.MediaSources);
        }
        if (!existing.PrimaryImageTag || existing.PrimaryImageTag === "cached") {
          existing.PrimaryImageTag = item.PrimaryImageTag;
          existing.ImageTags.Primary = item.ImageTags.Primary;
        }
      } else {
        groupedItemsMap.set(key, item);
        jellyfinItems.push(item);
      }
    } else {
      jellyfinItems.push(item);
    }
  }

  return c.json({
    Items: jellyfinItems,
    TotalRecordCount: totalRecordCount,
    StartIndex: startIndex,
  });
};

app.post("/internal/syncLibrary", async (c) => {
  try {
    const { libId, folderId, isTvLib, isMovieLib, isMusicLib } = await c.req.json();
    const gdrive = new GoogleDrive(c.env);
    const rc = new Cipher('base32');
    rc.dirNameEncrypt = false;
    if (c.env.RCLONE_PASS) await rc.key(c.env.RCLONE_PASS, c.env.RCLONE_SALT || '');

    const topList: any = await gdrive.listFolder(folderId);
    if (!topList || !topList.files) return c.json({ success: true });

    if (isTvLib) {
      for (const seriesFolder of topList.files) {
        if (seriesFolder.mimeType !== 'application/vnd.google-apps.folder') continue;
        let seriesName = seriesFolder.name;
        try { seriesName = await rc.decryptFileName(seriesFolder.name); } catch(e) {}
        if (/^S\d+/i.test(seriesName) || /^Season/i.test(seriesName) || /^Temporada/i.test(seriesName)) continue;

        const seriesId = `series_${seriesFolder.id}`;
        await c.env.DB.prepare(`
          INSERT INTO Items (Id, ParentId, LibraryId, Type, Name, FolderId, Uuid)
          VALUES (?, ?, ?, 'Series', ?, ?, ?)
          ON CONFLICT(Id) DO UPDATE SET Name = CASE WHEN Items.TmdbId IS NULL THEN excluded.Name ELSE Items.Name END, FolderId = excluded.FolderId, Uuid = excluded.Uuid
        `).bind(seriesId, libId, libId, seriesName, seriesFolder.id, toValidUuid(seriesId)).run();

        const url = new URL(c.req.url);
        url.pathname = '/internal/syncSeries';
        const syncPromise = fetch(url.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ libraryId: libId, seriesId, seriesFolderId: seriesFolder.id })
        });
        c.executionCtx?.waitUntil(syncPromise);
      }
    } else if (isMovieLib) {
      for (const item of topList.files) {
        try {
          if (item.mimeType === 'application/vnd.google-apps.folder') {
            const subFiles: any = await gdrive.listFolder(item.id);
            for (const sub of (subFiles.files || [])) {
              let name = sub.name;
              try { name = await rc.decryptFileName(sub.name); } catch(e) {}
              if (name.match(/\.(mp4|mkv|avi|webm|m4v|mov|wmv)$/i)) {
                const rowId = `movie_${sub.id}`;
                await c.env.DB.prepare(`
                  INSERT INTO Items (Id, ParentId, LibraryId, Type, Name, FileId, EncryptedName, Size, Uuid)
                  VALUES (?, ?, ?, 'Movie', ?, ?, ?, ?, ?)
                  ON CONFLICT(Id) DO UPDATE SET Name = CASE WHEN Items.TmdbId IS NULL THEN excluded.Name ELSE Items.Name END, Size = excluded.Size, FileId = excluded.FileId, EncryptedName = excluded.EncryptedName, Uuid = excluded.Uuid
                `).bind(rowId, libId, libId, name, sub.id, sub.name, sub.size || 0, toValidUuid(rowId)).run();
              }
            }
          } else {
            let name = item.name;
            try { name = await rc.decryptFileName(item.name); } catch(e) {}
            if (name.match(/\.(mp4|mkv|avi|webm|m4v|mov|wmv)$/i)) {
              const rowId = `movie_${item.id}`;
              await c.env.DB.prepare(`
                INSERT INTO Items (Id, ParentId, LibraryId, Type, Name, FileId, EncryptedName, Size, Uuid)
                VALUES (?, ?, ?, 'Movie', ?, ?, ?, ?, ?)
                ON CONFLICT(Id) DO UPDATE SET Name = CASE WHEN Items.TmdbId IS NULL THEN excluded.Name ELSE Items.Name END, Size = excluded.Size, FileId = excluded.FileId, EncryptedName = excluded.EncryptedName, Uuid = excluded.Uuid
              `).bind(rowId, libId, libId, name, item.id, item.name, item.size || 0, toValidUuid(rowId)).run();
            }
          }
        } catch (err) {}
      }
    }
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message, stack: err.stack }, 500);
  }
});

app.post("/internal/syncSeries", async (c) => {
  try {
    const { libraryId, seriesId, seriesFolderId } = await c.req.json();
    const gdrive = new GoogleDrive(c.env);
    const rc = new Cipher('base32');
    rc.dirNameEncrypt = false;
    if (c.env.RCLONE_PASS) await rc.key(c.env.RCLONE_PASS, c.env.RCLONE_SALT || '');

    const seasonList: any = await gdrive.listFolder(seriesFolderId);
    for (const seasonItem of (seasonList.files || [])) {
      if (seasonItem.mimeType === 'application/vnd.google-apps.folder') {
        let seasonName = seasonItem.name;
        try { seasonName = await rc.decryptFileName(seasonItem.name); } catch(e) {}
        const sMatch = seasonName.match(/S(\d+)|Season\s*(\d+)|Temporada\s*(\d+)/i);
        const seasonNumber = sMatch ? parseInt(sMatch[1] || sMatch[2] || sMatch[3]) : 1;
        const seasonId = `season_${seasonItem.id}`;

        await c.env.DB.prepare(`
          INSERT INTO Items (Id, ParentId, LibraryId, Type, Name, IndexNumber, FolderId, Uuid)
          VALUES (?, ?, ?, 'Season', ?, ?, ?, ?)
          ON CONFLICT(Id) DO UPDATE SET Name = CASE WHEN Items.TmdbId IS NULL THEN excluded.Name ELSE Items.Name END, IndexNumber = excluded.IndexNumber, FolderId = excluded.FolderId, Uuid = excluded.Uuid
        `).bind(seasonId, seriesId, libraryId, seasonName, seasonNumber, seasonItem.id, toValidUuid(seasonId)).run();

        const epList: any = await gdrive.listFolder(seasonItem.id);
        for (const ep of (epList.files || [])) {
          if (ep.mimeType === 'application/vnd.google-apps.folder') continue;
          let epName = ep.name;
          try { epName = await rc.decryptFileName(ep.name); } catch(e) {}
          const rowEpId = `ep_${ep.id}`;
          if (epName.match(/\.(mp4|mkv|avi|webm|m4v|mov|wmv)$/i)) {
            const epMatch = epName.match(/(?:[Ss]\d+)?\s*[Ee](\d+)|\b\d+x(\d+)\b|\bEp[._\s]*(\d+)\b|(?:^|\D)(\d{1,3})\s*\./i);
            const epNumber = epMatch ? parseInt(epMatch[1] || epMatch[2] || epMatch[3] || epMatch[4]) : 1;
            await c.env.DB.prepare(`
              INSERT INTO Items (Id, ParentId, LibraryId, Type, Name, IndexNumber, ParentIndexNumber, FileId, EncryptedName, Size, Uuid)
              VALUES (?, ?, ?, 'Episode', ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(Id) DO UPDATE SET Name = CASE WHEN Items.TmdbId IS NULL THEN excluded.Name ELSE Items.Name END, IndexNumber = excluded.IndexNumber, ParentIndexNumber = excluded.ParentIndexNumber, FileId = excluded.FileId, EncryptedName = excluded.EncryptedName, Size = excluded.Size, Uuid = excluded.Uuid
            `).bind(rowEpId, seasonId, libraryId, epName, epNumber, seasonNumber, ep.id, ep.name, ep.size || 0, toValidUuid(rowEpId)).run();
          }
        }
      } else {
        let epName = seasonItem.name;
        try { epName = await rc.decryptFileName(seasonItem.name); } catch(e) {}
        if (epName.match(/\.(mp4|mkv|avi|webm|m4v|mov|wmv)$/i)) {
          const defaultSeasonId = `season_${seriesFolderId}_s1`;
          await c.env.DB.prepare(`
            INSERT INTO Items (Id, ParentId, LibraryId, Type, Name, IndexNumber, FolderId, Uuid)
            VALUES (?, ?, ?, 'Season', 'Season 1', 1, ?, ?)
            ON CONFLICT(Id) DO UPDATE SET Name = CASE WHEN Items.TmdbId IS NULL THEN excluded.Name ELSE Items.Name END, IndexNumber = excluded.IndexNumber, FolderId = excluded.FolderId, Uuid = excluded.Uuid
          `).bind(defaultSeasonId, seriesId, libraryId, seriesFolderId, toValidUuid(defaultSeasonId)).run();

          const rowEpId = `ep_${seasonItem.id}`;
          const epMatch = epName.match(/(?:[Ss]\d+)?\s*[Ee](\d+)|\b\d+x(\d+)\b|\bEp[._\s]*(\d+)\b|(?:^|\D)(\d{1,3})\s*\./i);
          const epNumber = epMatch ? parseInt(epMatch[1] || epMatch[2] || epMatch[3] || epMatch[4]) : 1;
          await c.env.DB.prepare(`
            INSERT INTO Items (Id, ParentId, LibraryId, Type, Name, IndexNumber, ParentIndexNumber, FileId, EncryptedName, Size, Uuid)
            VALUES (?, ?, ?, 'Episode', ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(Id) DO UPDATE SET Name = CASE WHEN Items.TmdbId IS NULL THEN excluded.Name ELSE Items.Name END, IndexNumber = excluded.IndexNumber, ParentIndexNumber = excluded.ParentIndexNumber, FileId = excluded.FileId, EncryptedName = excluded.EncryptedName, Size = excluded.Size, Uuid = excluded.Uuid
          `).bind(rowEpId, defaultSeasonId, libraryId, epName, epNumber, 1, seasonItem.id, seasonItem.name, seasonItem.size || 0, toValidUuid(rowEpId)).run();
        }
      }
    }
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message, stack: err.stack }, 500);
  }
});

app.get("/Items", itemsHandler);

app.get("/Debug/ListFolder/:id", async (c) => {
  const gdrive = new GoogleDrive(c.env);
  try {
    const res = await gdrive.listFolder(c.req.param("id"));
    return c.json(res);
  } catch (err: any) {
    return c.json({ error: err.message });
  }
});
app.get("/items", itemsHandler);
app.get("/Users/:userId/Items", itemsHandler);
app.get("/users/:userId/items", itemsHandler);

const handleShowsSeasons = async (c: any) => {
  const itemId = c.req.param("itemId");
  let item: any = await resolveItem(c.env.DB, itemId);
  let seriesId = item ? item.Id : itemId;
  let series: any = item;
  if (item && item.Type === "Season") {
    seriesId = item.ParentId;
    series = await resolveItem(c.env.DB, seriesId);
  }
  const seriesUuid = series ? (series.Uuid || toValidUuid(series.Id)) : toValidUuid(seriesId);
  const seriesName = series ? series.Name : "Series";
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM Items WHERE ParentId = ? AND Type = 'Season' ORDER BY IndexNumber ASC"
  ).bind(seriesId).all();

  const items = results.map((row: any) => {
    const seasonUuid = row.Uuid || toValidUuid(row.Id);
    return {
      Name: row.Name,
      ServerId: SERVER_ID,
      Id: seasonUuid,
      Type: "Season",
      IsFolder: true,
      IndexNumber: row.IndexNumber || 1,
      SeriesName: seriesName,
      SeriesId: seriesUuid,
      ParentId: seriesUuid,
      ParentBackdropItemId: seriesUuid,
      ParentBackdropImageTags: series?.BackdropImageFileId ? ["cached"] : ["backdrop"],
      ParentPrimaryImageItemId: seriesUuid,
      ParentPrimaryImageTag: series?.PrimaryImageFileId ? "cached" : "poster",
      SeriesPrimaryImageTag: series?.PrimaryImageFileId ? "cached" : "poster",
      PrimaryImageTag: row.PrimaryImageFileId ? (getImageTag(row.PrimaryImageFileId) || "cached") : "poster",
      ImageTags: { Primary: row.PrimaryImageFileId ? (getImageTag(row.PrimaryImageFileId) || "cached") : "poster" },
      BackdropImageTags: row.BackdropImageFileId ? [getImageTag(row.BackdropImageFileId) || "cached"] : (series?.BackdropImageFileId ? ["cached"] : ["backdrop"]),
      LocationType: "FileSystem",
      MediaType: "Unknown",
      DisplayPreferencesId: toValidUuid("displaypref_" + row.Id),
      UserData: {
        PlayedPercentage: 0,
        UnplayedItemCount: 10,
        PlaybackPositionTicks: 0,
        PlayCount: 0,
        IsFavorite: false,
        Played: false,
        Key: seasonUuid,
        ItemId: seasonUuid,
      },
    };
  });
  return c.json({ Items: items, TotalRecordCount: items.length, StartIndex: 0 });
};

app.get("/Shows/:itemId/Seasons", handleShowsSeasons);
app.get("/shows/:itemId/seasons", handleShowsSeasons);

const handleShowsEpisodes = async (c: any) => {
  const userId = c.req.param("userId") || c.req.query("userId") || c.req.query("UserId") || DEFAULT_ADMIN_ID;
  const itemId = c.req.param("itemId"); // series id or season id
  const rawSeasonId = c.req.query("seasonId") || c.req.query("SeasonId");

  let item: any = await resolveItem(c.env.DB, itemId);
  let seriesId = item ? item.Id : itemId;
  let series: any = item;
  if (item && item.Type === "Season") {
    seriesId = item.ParentId;
    series = await resolveItem(c.env.DB, seriesId);
  }
  const seriesUuid = series ? (series.Uuid || toValidUuid(series.Id)) : toValidUuid(seriesId);
  const seriesName = series ? series.Name : "Series";

  let results: any[] = [];
  let seasonMap = new Map<string, any>();
  let realSeasonId = rawSeasonId;
  if (rawSeasonId && rawSeasonId !== "undefined") {
    const sRow = await resolveItem(c.env.DB, rawSeasonId);
    if (sRow) {
      realSeasonId = sRow.Id;
      seasonMap.set(sRow.Id, sRow);
      seasonMap.set(rawSeasonId, sRow);
    }
    results = (
      await c.env.DB.prepare(
        "SELECT * FROM Items WHERE ParentId = ? AND Type IN ('Episode', 'Audio') ORDER BY IndexNumber ASC",
      )
        .bind(realSeasonId)
        .all()
    ).results;
  } else {
    results = (
      await c.env.DB.prepare(
        "SELECT * FROM Items WHERE Type IN ('Episode', 'Audio') AND ParentId IN (SELECT Id FROM Items WHERE ParentId = ?) ORDER BY ParentIndexNumber ASC, IndexNumber ASC",
      )
        .bind(seriesId)
        .all()
    ).results;
  }

  // TMDB season episodes enrichment if series has TmdbId
  let tmdbSeasonEpMap: Map<number, any> | null = null;
  if (series && series.TmdbId) {
    let seasonNum = 1;
    if (realSeasonId && realSeasonId !== "undefined") {
      const sRow = seasonMap.get(realSeasonId) || await resolveItem(c.env.DB, realSeasonId);
      if (sRow) seasonNum = sRow.IndexNumber || 1;
    }
    tmdbSeasonEpMap = await getTvSeasonEpisodes(c.env.TMDB_API_KEY, parseInt(series.TmdbId), seasonNum);
  }

  const totalRecordCount = results.length;

  // Tratar startItemId: cliente Android pede startItemId para iniciar lista no episódio clicado
  const startItemId = c.req.query("startItemId") || c.req.query("StartItemId");
  if (startItemId) {
    const sIdx = results.findIndex((r: any) => r.Id === startItemId || (r.Uuid && r.Uuid === startItemId) || toValidUuid(r.Id) === startItemId);
    if (sIdx >= 0) {
      results = results.slice(sIdx);
    }
  }

  // Tratar limit
  const limitParam = c.req.query("limit") || c.req.query("Limit");
  if (limitParam) {
    const lim = parseInt(limitParam);
    if (!isNaN(lim) && lim > 0) {
      results = results.slice(0, lim);
    }
  }

  const itemIds = results.map((r: any) => r.Id);
  const userDataMap = await fetchUserItemDataMap(c.env.DB, userId, itemIds);

  const seriesYear = series?.ProductionYear || 2024;
  const seriesPremiere = series?.PremiereDate || `${seriesYear}-01-01T00:00:00.0000000Z`;

  const items = results.map((row: any) => {
    const parsed = parseMediaInfo(row);
    const isAudio = row.Type === "Audio";
    const container = isAudio ? "mp3" : (row.Name.endsWith(".mkv") ? "mkv" : "mp4");
    const epUuid = row.Uuid || toValidUuid(row.Id);
    const seasonUuid = row.ParentId ? toValidUuid(row.ParentId) : undefined;

    let epName = cleanEpisodeTitle(row.Name, row.IndexNumber);
    let epOverview = row.Overview || "";
    let epImage = row.PrimaryImageFileId ? "cached" : undefined;

    if (tmdbSeasonEpMap && row.IndexNumber && tmdbSeasonEpMap.has(row.IndexNumber)) {
      const tmdbEp = tmdbSeasonEpMap.get(row.IndexNumber);
      if (tmdbEp) {
        epName = `${row.IndexNumber}. ${tmdbEp.name}`;
        if (!epOverview && tmdbEp.overview) epOverview = tmdbEp.overview;
        if (tmdbEp.stillPath && !row.PrimaryImageFileId) {
          epImage = "cached";
          c.executionCtx?.waitUntil(
            c.env.DB.prepare("UPDATE Items SET PrimaryImageFileId = ?, Overview = COALESCE(Overview, ?) WHERE Id = ?")
              .bind(tmdbEp.stillPath, tmdbEp.overview, row.Id)
              .run()
          );
        }
      }
    }

    const userData = buildUserData(epUuid, userDataMap.get(row.Id) || userDataMap.get(epUuid), parsed.RunTimeTicks);

    return {
      Name: epName,
      ServerId: SERVER_ID,
      Id: epUuid,
      ParentId: seasonUuid,
      SeriesId: seriesUuid,
      SeriesName: seriesName,
      SeasonId: seasonUuid,
      SeasonName: `Temporada ${row.ParentIndexNumber || 1}`,
      IsFolder: false,
      Type: row.Type,
      Container: container,
      VideoType: isAudio ? undefined : "VideoFile",
      IndexNumber: row.IndexNumber || 1,
      ParentIndexNumber: row.ParentIndexNumber || 1,
      MediaType: isAudio ? "Audio" : "Video",
      RunTimeTicks: parsed.RunTimeTicks,
      HasSubtitles: parsed.MediaStreams.some((s: any) => s.Type === "Subtitle"),
      Overview: epOverview,
      PrimaryImageTag: row.PrimaryImageFileId ? (getImageTag(row.PrimaryImageFileId) || "cached") : "cached",
      ImageTags: { Primary: row.PrimaryImageFileId ? (getImageTag(row.PrimaryImageFileId) || "cached") : "cached" },
      ParentPrimaryImageItemId: seriesUuid,
      ParentPrimaryImageTag: series?.PrimaryImageFileId ? "cached" : undefined,
      SeriesPrimaryImageTag: series?.PrimaryImageFileId ? "cached" : undefined,
      ParentBackdropItemId: seriesUuid,
      ParentBackdropImageTags: series?.BackdropImageFileId ? ["cached"] : undefined,
      LocationType: "FileSystem",
      UserData: userData,
      PlayAccess: "Full",
      IsPlayable: true,
      Artists: isAudio ? ["Vários Artistas"] : undefined,
      ArtistItems: isAudio ? [{ Name: "Vários Artistas", Id: toValidUuid("artist_varios"), Type: "MusicArtist" }] : undefined,
      Album: isAudio ? "Músicas" : undefined,
      AlbumId: isAudio ? toValidUuid("album_view_musicas") : undefined,
      AlbumArtist: isAudio ? "Vários Artistas" : undefined,
      CanDownload: false,
      CanDelete: false,
      Chapters: [],
      Trickplay: {},
      ChannelId: null,
      EnableMediaSourceDisplay: true,
      Etag: getImageTag(row.Id) || "etag_123",
      ImageBlurHashes: {},
      MediaSources: [buildMediaSource(row, parsed, !isAudio, isAudio, container, epUuid)],
      MediaStreams: parsed.MediaStreams,
      Width: parsed.Width,
      Height: parsed.Height,
      ProductionYear: seriesYear,
      PremiereDate: seriesPremiere,
      CommunityRating: 7.0,
      BackdropImageTags: undefined,
      SortName: (cleanMediaTitle(epName).query || epName).toLowerCase(),
      OriginalTitle: epName,
      DisplayPreferencesId: toValidUuid("displaypref_" + row.Id),
      DateCreated: row.DateCreated ? `${String(row.DateCreated).replace(" ", "T")}.0000000Z` : "2024-01-01T00:00:00.0000000Z",
      Path: row.FileId ? `/media/${row.Name}` : undefined,
      SeriesStudio: "",
    };
  });
  return c.json({ Items: items, TotalRecordCount: totalRecordCount, StartIndex: 0 });
};

app.get("/Shows/:itemId/Episodes", handleShowsEpisodes);
app.get("/shows/:itemId/episodes", handleShowsEpisodes);

// Studios endpoint
app.get("/Studios", async (c) => {
  const searchTerm = c.req.query("searchTerm") || c.req.query("SearchTerm") || "";
  const { results } = await c.env.DB.prepare("SELECT MediaInfo FROM Items WHERE MediaInfo IS NOT NULL").all();
  const studiosMap = new Map<string, any>();
  for (const r of results) {
    try {
      const info = JSON.parse(r.MediaInfo as string);
      if (info.tmdb?.studios) {
        for (const s of info.tmdb.studios) {
          if (!studiosMap.has(s.Name)) {
            studiosMap.set(s.Name, s);
          }
        }
      }
    } catch(e) {}
  }
  let items = Array.from(studiosMap.values()).map(s => ({
    Name: s.Name,
    Id: s.Id,
    Type: "Studio",
    ServerId: SERVER_ID
  }));
  if (searchTerm.trim()) {
    items = items.filter(s => s.Name.toLowerCase().includes(searchTerm.trim().toLowerCase()));
  }
  return c.json({ Items: items, TotalRecordCount: items.length, StartIndex: 0 });
});

// Genres endpoint
app.get("/Genres", async (c) => {
  const searchTerm = c.req.query("searchTerm") || c.req.query("SearchTerm") || "";
  const { results } = await c.env.DB.prepare("SELECT MediaInfo FROM Items WHERE MediaInfo IS NOT NULL").all();
  const genreSet = new Set<string>();
  for (const r of results) {
    try {
      const info = JSON.parse(r.MediaInfo as string);
      if (info.tmdb?.genres) {
        for (const g of info.tmdb.genres) {
          genreSet.add(g);
        }
      }
    } catch(e) {}
  }
  let items = Array.from(genreSet).map((g) => ({
    Name: g,
    Id: toValidUuid("genre_" + g),
    Type: "Genre",
    ServerId: SERVER_ID
  }));
  if (searchTerm.trim()) {
    items = items.filter(g => g.Name.toLowerCase().includes(searchTerm.trim().toLowerCase()));
  }
  return c.json({ Items: items, TotalRecordCount: items.length, StartIndex: 0 });
});

// MusicGenres endpoint
app.get("/MusicGenres", (c) => c.json({ Items: [], TotalRecordCount: 0, StartIndex: 0 }));

// Artists endpoint
app.get("/Artists", async (c) => {
  const searchTerm = (c.req.query("searchTerm") || c.req.query("SearchTerm") || "").toLowerCase();
  const artists = [
    {
      Name: "Vários Artistas",
      ServerId: SERVER_ID,
      Id: toValidUuid("artist_various"),
      Type: "MusicArtist",
      IsFolder: true,
      ImageTags: {},
      UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: toValidUuid("artist_various"), ItemId: toValidUuid("artist_various") }
    }
  ];
  const filtered = searchTerm ? artists.filter(a => a.Name.toLowerCase().includes(searchTerm)) : artists;
  return c.json({
    Items: filtered,
    TotalRecordCount: filtered.length,
    StartIndex: 0
  });
});

app.get("/Artists/AlbumArtists", async (c) => {
  const searchTerm = (c.req.query("searchTerm") || c.req.query("SearchTerm") || "").toLowerCase();
  const artists = [
    {
      Name: "Vários Artistas",
      ServerId: SERVER_ID,
      Id: toValidUuid("artist_various"),
      Type: "MusicArtist",
      IsFolder: true,
      ImageTags: {},
      UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: toValidUuid("artist_various"), ItemId: toValidUuid("artist_various") }
    }
  ];
  const filtered = searchTerm ? artists.filter(a => a.Name.toLowerCase().includes(searchTerm)) : artists;
  return c.json({
    Items: filtered,
    TotalRecordCount: filtered.length,
    StartIndex: 0
  });
});

// Persons endpoints
app.get("/Persons", async (c) => {
  const searchTerm = (c.req.query("searchTerm") || c.req.query("SearchTerm") || "").toLowerCase();
  const { results } = await c.env.DB.prepare("SELECT MediaInfo FROM Items WHERE MediaInfo IS NOT NULL").all();
  const personMap = new Map<string, any>();
  for (const r of results) {
    try {
      const info = JSON.parse(r.MediaInfo as string);
      if (info.tmdb?.people) {
        for (const p of info.tmdb.people) {
          if (!personMap.has(p.Name)) {
            personMap.set(p.Name, p);
          }
        }
      }
    } catch(e) {}
  }
  let items = Array.from(personMap.values()).map(p => ({
    Name: p.Name,
    Id: p.Id,
    Type: "Person",
    ServerId: SERVER_ID,
    Role: p.Role,
    PrimaryImageTag: p.PrimaryImageTag ? "cached" : undefined,
  }));
  if (searchTerm) {
    items = items.filter(p => p.Name.toLowerCase().includes(searchTerm));
  }
  return c.json({ Items: items, TotalRecordCount: items.length, StartIndex: 0 });
});

app.get("/Persons/:name", async (c) => {
  const name = decodeURIComponent(c.req.param("name"));
  return c.json({
    Name: name,
    Id: toValidUuid(`person_${encodeURIComponent(name)}`),
    Type: "Person",
    ServerId: SERVER_ID,
  });
});

// External ID Infos for Identify Modal
app.get("/Items/:itemId/ExternalIdInfos", async (c) => {
  const itemId = c.req.param("itemId");
  const item: any = await c.env.DB.prepare("SELECT * FROM Items WHERE Id = ?").bind(itemId).first();
  const isSeries = item?.Type === "Series";

  return c.json([
    {
      Name: "TheMovieDb",
      Key: "Tmdb",
      Type: isSeries ? "Series" : "Movie",
      UrlFormatString: isSeries ? "https://www.themoviedb.org/tv/{0}" : "https://www.themoviedb.org/movie/{0}",
    },
    {
      Name: isSeries ? "TheTVDB" : "TheMovieDb Collection",
      Key: isSeries ? "Tvdb" : "TmdbBoxSet",
      Type: isSeries ? "Series" : "BoxSet",
      UrlFormatString: isSeries ? "https://thetvdb.com/dereferrer/series/{0}" : "https://www.themoviedb.org/collection/{0}",
    },
    {
      Name: "IMDb",
      Key: "Imdb",
      Type: isSeries ? "Series" : "Movie",
      UrlFormatString: "https://www.imdb.com/title/{0}",
    },
  ]);
});

// Remote Search Handler for Movie, Series, BoxSet, Person, Trailer
const handleRemoteSearch = async (c: any, defaultType: "Movie" | "Series" | "Person" | "BoxSet") => {
  let body: any = {};
  try {
    body = await c.req.json();
  } catch (e) {}

  const searchInfo = body.SearchInfo || body.searchInfo || body;
  const query = searchInfo.Name || searchInfo.name || body.Name || body.name || c.req.query("SearchTerm") || c.req.query("searchTerm") || "";
  const year = searchInfo.Year || searchInfo.year || searchInfo.ProductionYear || searchInfo.productionYear;
  const tmdbId = searchInfo.ProviderIds?.Tmdb || searchInfo.ProviderIds?.tmdb || searchInfo.providerIds?.tmdb || searchInfo.providerIds?.Tmdb;
  const imdbId = searchInfo.ProviderIds?.Imdb || searchInfo.ProviderIds?.imdb || searchInfo.providerIds?.imdb || searchInfo.providerIds?.Imdb;

  const apiKey = c.env.TMDB_API_KEY || "844dba0bfd8f3a4f3799f6130ef9e335";
  console.log(`[RemoteSearch] type=${defaultType} query="${query}" year=${year} tmdbId=${tmdbId} imdbId=${imdbId}`);
  const results = await searchTmdbRemote(
    apiKey,
    query,
    defaultType,
    year ? parseInt(String(year)) : undefined,
    tmdbId,
    imdbId
  );
  console.log(`[RemoteSearch] found ${results.length} results`);

  return c.json(results);
};

app.post("/Items/RemoteSearch/Movie", (c) => handleRemoteSearch(c, "Movie"));
app.post("/items/remotesearch/movie", (c) => handleRemoteSearch(c, "Movie"));
app.post("/Items/RemoteSearch/Series", (c) => handleRemoteSearch(c, "Series"));
app.post("/items/remotesearch/series", (c) => handleRemoteSearch(c, "Series"));
app.post("/Items/RemoteSearch/BoxSet", (c) => handleRemoteSearch(c, "BoxSet"));
app.post("/items/remotesearch/boxset", (c) => handleRemoteSearch(c, "BoxSet"));
app.post("/Items/RemoteSearch/Person", (c) => handleRemoteSearch(c, "Person"));
app.post("/items/remotesearch/person", (c) => handleRemoteSearch(c, "Person"));
app.post("/Items/RemoteSearch/Trailer", (c) => handleRemoteSearch(c, "Movie"));
app.post("/items/remotesearch/trailer", (c) => handleRemoteSearch(c, "Movie"));
app.post("/Items/RemoteSearch/MusicVideo", (c) => handleRemoteSearch(c, "Movie"));
app.post("/items/remotesearch/musicvideo", (c) => handleRemoteSearch(c, "Movie"));
app.post("/Items/RemoteSearch/Book", (c) => c.json([]));
app.post("/items/remotesearch/book", (c) => c.json([]));
app.post("/Items/RemoteSearch/MusicAlbum", (c) => c.json([]));
app.post("/items/remotesearch/musicalbum", (c) => c.json([]));
app.post("/Items/RemoteSearch/MusicArtist", (c) => c.json([]));
app.post("/items/remotesearch/musicartist", (c) => c.json([]));

// Apply Remote Search Result to an item
const handleRemoteSearchApply = async (c: any) => {
  const itemId = c.req.param("itemId");
  const replaceAllImages = c.req.query("replaceAllImages") !== "false";
  let searchResult: any = {};
  try {
    searchResult = await c.req.json();
  } catch (e) {}

  const item: any = await resolveItem(c.env.DB, itemId);
  if (!item) {
    return c.notFound();
  }
  // Use canonical internal Id for all subsequent DB operations
  const canonicalId = item.Id;

  const tmdbId = searchResult.ProviderIds?.Tmdb || searchResult.ProviderIds?.tmdb || searchResult.providerIds?.Tmdb || searchResult.providerIds?.tmdb;
  let fullDetails = null;
  if (tmdbId) {
    fullDetails = await getTmdbDetails(
      c.env.TMDB_API_KEY,
      parseInt(tmdbId),
      item.Type === "Series" ? "Series" : "Movie"
    );
  }

  const newName = fullDetails?.title || searchResult.Name || item.Name;
  const newOverview = fullDetails?.overview || searchResult.Overview || item.Overview;
  const newPoster = fullDetails?.posterPath || searchResult.ImageUrl;
  const newBackdrop = fullDetails?.backdropPath;

  let existingMediaInfo: any = {};
  if (item.MediaInfo) {
    try {
      existingMediaInfo = JSON.parse(item.MediaInfo);
    } catch (e) {}
  }

  if (fullDetails) {
    existingMediaInfo.tmdb = {
      id: fullDetails.id,
      title: fullDetails.title,
      overview: fullDetails.overview,
      tagline: fullDetails.tagline,
      genres: fullDetails.genres,
      people: fullDetails.people,
      studios: fullDetails.studios,
      voteAverage: fullDetails.voteAverage,
      releaseDate: fullDetails.releaseDate,
      posterPath: fullDetails.posterPath,
      backdropPath: fullDetails.backdropPath,
    };
  }

  const updatedMediaInfoStr = JSON.stringify(existingMediaInfo);

  const primaryImage = newPoster || item.PrimaryImageFileId;
  const backdropImage = newBackdrop || item.BackdropImageFileId;

  await c.env.DB.prepare(`
    UPDATE Items SET 
      Name = ?, 
      Overview = ?, 
      TmdbId = ?, 
      PrimaryImageFileId = ?,
      BackdropImageFileId = ?,
      MediaInfo = ?
    WHERE Id = ?
  `).bind(
    newName,
    newOverview,
    tmdbId ? String(tmdbId) : item.TmdbId,
    primaryImage,
    backdropImage,
    updatedMediaInfoStr,
    canonicalId
  ).run();

  return c.body(null, 204);
};
app.post("/Items/RemoteSearch/Apply/:itemId", handleRemoteSearchApply);
app.post("/items/remotesearch/apply/:itemId", handleRemoteSearchApply);

// Shows NextUp endpoint
const handleNextUp = async (c: any) => {
  const userId = c.req.param("userId") || c.req.query("userId") || c.req.query("UserId") || DEFAULT_ADMIN_ID;
  const rawSeriesId = c.req.query("seriesId") || c.req.query("SeriesId");
  let series: any = null;
  let seriesId = rawSeriesId;
  let tmdbSeasonEpMap: Map<number, any> | null = null;
  if (rawSeriesId) {
    series = await resolveItem(c.env.DB, rawSeriesId);
    if (series) {
      seriesId = series.Id;
      if (series.TmdbId) {
        tmdbSeasonEpMap = await getTvSeasonEpisodes(c.env.TMDB_API_KEY, parseInt(series.TmdbId), 1);
      }
    }
  }

  let sql = `
    SELECT * FROM (
      SELECT Items.*, ROW_NUMBER() OVER (
        PARTITION BY (SELECT ParentId FROM Items AS Seasons WHERE Seasons.Id = Items.ParentId) 
        ORDER BY ParentIndexNumber ASC, IndexNumber ASC
      ) as rn
      FROM Items 
      WHERE Type = 'Episode' 
        AND Id NOT IN (SELECT ItemId FROM UserItemData WHERE UserId = ? AND Played = 1) 
        AND COALESCE(Uuid,'') NOT IN (SELECT ItemId FROM UserItemData WHERE UserId = ? AND Played = 1)
  `;
  const params: any[] = [userId, userId];
  if (seriesId) {
    sql += " AND ParentId IN (SELECT Id FROM Items WHERE ParentId = ?)";
    params.push(seriesId);
  }
  sql += ") WHERE rn = 1 ORDER BY DateCreated DESC LIMIT 10";
  const { results } = await c.env.DB.prepare(sql).bind(...params).all();

  const itemIds = results.map((r: any) => r.Id);
  const userDataMap = await fetchUserItemDataMap(c.env.DB, userId, itemIds);

  const seriesCache = new Map<string, any>();
  if (series) seriesCache.set(series.Id, series);

  const items = await Promise.all(results.map(async (row: any) => {
    const parsed = parseMediaInfo(row);
    let sRow = series;
    if (!sRow) {
      const season: any = await resolveItem(c.env.DB, row.ParentId);
      if (season) {
        if (!seriesCache.has(season.ParentId)) {
          const s = await resolveItem(c.env.DB, season.ParentId);
          if (s) seriesCache.set(season.ParentId, s);
        }
        sRow = seriesCache.get(season.ParentId);
      }
    }

    const sUuid = sRow ? (sRow.Uuid || toValidUuid(sRow.Id)) : (seriesId ? toValidUuid(seriesId) : undefined);
    const sName = sRow?.Name;
    const sPoster = sRow?.PrimaryImageFileId;
    const sBackdrop = sRow?.BackdropImageFileId;

    let epName = cleanEpisodeTitle(row.Name, row.IndexNumber);
    let epOverview = row.Overview || "";
    let epImage = row.PrimaryImageFileId ? "cached" : undefined;

    let tmdbEp = tmdbSeasonEpMap?.get(row.IndexNumber);
    if (!tmdbEp && sRow?.TmdbId) {
      const epMap = await getTvSeasonEpisodes(c.env.TMDB_API_KEY, parseInt(sRow.TmdbId), row.ParentIndexNumber || 1);
      tmdbEp = epMap.get(row.IndexNumber);
    }

    if (tmdbEp) {
      if (tmdbEp.name) epName = `${row.IndexNumber || 1}. ${tmdbEp.name}`;
      if (!epOverview && tmdbEp.overview) epOverview = tmdbEp.overview;
      if (tmdbEp.stillPath && !row.PrimaryImageFileId) {
        epImage = "cached";
        c.executionCtx?.waitUntil(
          c.env.DB.prepare("UPDATE Items SET PrimaryImageFileId = ?, Overview = COALESCE(Overview, ?) WHERE Id = ?")
            .bind(tmdbEp.stillPath, tmdbEp.overview, row.Id)
            .run()
        );
      }
    }

    const epUuid = row.Uuid || toValidUuid(row.Id);
    const seasonUuid = row.ParentId ? toValidUuid(row.ParentId) : undefined;
    const userData = buildUserData(epUuid, userDataMap.get(row.Id) || userDataMap.get(epUuid), parsed.RunTimeTicks);
    const container = row.Name.endsWith(".mkv") ? "mkv" : "mp4";

    return {
      Name: epName,
      ServerId: SERVER_ID,
      Id: epUuid,
      Type: "Episode",
      SeriesId: sUuid,
      SeriesName: sName,
      SeasonId: seasonUuid,
      SeasonName: `Temporada ${row.ParentIndexNumber || 1}`,
      IndexNumber: row.IndexNumber || 1,
      ParentIndexNumber: row.ParentIndexNumber || 1,
      MediaType: "Video",
      RunTimeTicks: parsed.RunTimeTicks,
      HasSubtitles: parsed.MediaStreams.some((s: any) => s.Type === "Subtitle"),
      Overview: epOverview,
      PrimaryImageTag: row.PrimaryImageFileId ? (getImageTag(row.PrimaryImageFileId) || "cached") : "cached",
      ImageTags: { Primary: row.PrimaryImageFileId ? (getImageTag(row.PrimaryImageFileId) || "cached") : "cached" },
      SeriesPrimaryImageTag: sPoster ? "cached" : undefined,
      ParentPrimaryImageItemId: sUuid,
      ParentPrimaryImageTag: sPoster ? "cached" : undefined,
      ParentBackdropItemId: sUuid,
      ParentBackdropImageTags: sBackdrop ? ["cached"] : undefined,
      UserData: userData,
      DisplayPreferencesId: toValidUuid("displaypref_" + row.Id),
      MediaSources: [buildMediaSource(row, parsed, true, false, container, epUuid)],
    };
  }));

  return c.json({ Items: items, TotalRecordCount: items.length, StartIndex: 0 });
};

app.get("/Shows/NextUp", handleNextUp);
app.get("/shows/nextup", handleNextUp);

// LiveTv mocks to avoid 404s
app.get("/LiveTv/*", (c) => c.json({ Items: [], TotalRecordCount: 0, StartIndex: 0 }));

const handlePlaybackInfo = async (c: any) => {
  let body: any = {};
  if (c.req.method === "POST") {
    try {
      body = await c.req.json();
    } catch (e) {}
  }
  const paramId = c.req.param("itemId");
  const queryId = c.req.query("Id") || c.req.query("id") || c.req.query("itemId") || c.req.query("ItemId");
  const bodyId = body.Id || body.id || body.ItemId || body.itemId;
  const mediaSourceId = c.req.query("mediaSourceId") || c.req.query("MediaSourceId") || body.MediaSourceId || body.mediaSourceId;
  const targetId = paramId || queryId || bodyId || mediaSourceId;

  let row = await resolveItem(c.env.DB, targetId);
  if (!row && mediaSourceId && mediaSourceId !== targetId) {
    row = await resolveItem(c.env.DB, mediaSourceId);
  }
  if (!row) return c.notFound();

  const isVideo = row.Type === "Movie" || row.Type === "Episode";
  const isAudio = row.Type === "Audio";
  const parsed = parseMediaInfo(row);
  const container = isAudio ? "mp3" : (row.Name.endsWith(".mkv") ? "mkv" : "mp4");
  const effectiveMediaSourceId = mediaSourceId || row.Uuid || toValidUuid(row.Id);

  let allRows = [row];
  if (row.Type === "Movie" || row.Type === "Episode") {
    const parentCondition = row.ParentId ? `ParentId = '${row.ParentId}'` : (row.LibraryId ? `LibraryId = '${row.LibraryId}'` : "1=1");
    const siblings = await c.env.DB.prepare(`SELECT * FROM Items WHERE Name = ? AND Type = ? AND ${parentCondition}`).bind(row.Name, row.Type).all();
    if (siblings.results && siblings.results.length > 0) {
      allRows = siblings.results;
    }
  }

  const mediaSources = allRows.map((r: any) => {
    const p = parseMediaInfo(r);
    const c = r.Type === "Audio" ? "mp3" : (r.Name.endsWith(".mkv") ? "mkv" : "mp4");
    const eId = r.Uuid || toValidUuid(r.Id);
    return buildMediaSource(r, p, isVideo, isAudio, c, eId);
  });

  return c.json({
    PlaySessionId: toValidUuid("playsession_" + row.Id),
    MediaSources: mediaSources,
  });
};

app.get("/Items/:itemId/PlaybackInfo", handlePlaybackInfo);
app.post("/Items/:itemId/PlaybackInfo", handlePlaybackInfo);
app.get("/items/:itemId/playbackinfo", handlePlaybackInfo);
app.post("/items/:itemId/playbackinfo", handlePlaybackInfo);
app.get("/Items/PlaybackInfo", handlePlaybackInfo);
app.post("/Items/PlaybackInfo", handlePlaybackInfo);
app.get("/items/playbackinfo", handlePlaybackInfo);
app.post("/items/playbackinfo", handlePlaybackInfo);
app.get("/Users/:userId/Items/:itemId/PlaybackInfo", handlePlaybackInfo);
app.post("/Users/:userId/Items/:itemId/PlaybackInfo", handlePlaybackInfo);
app.get("/users/:userId/items/:itemId/playbackinfo", handlePlaybackInfo);
app.post("/users/:userId/items/:itemId/playbackinfo", handlePlaybackInfo);

const streamHandler = async (c: any) => {
  try {
    const itemId = c.req.param("itemId");
    const mediaSourceId = c.req.query("mediaSourceId") || c.req.query("MediaSourceId");
    const targetId = itemId || mediaSourceId;

    const url = new URL(c.req.url);
    const path = url.pathname;
    let ext = c.req.param("ext") || "";
    if (!ext && path.includes(".")) {
      ext = path.split(".").pop() || "";
    }
    if (!ext) {
      ext = path.toLowerCase().includes("audio") ? "mp3" : "mp4";
    }

    let item = await resolveItem(c.env.DB, targetId);
    if (!item && mediaSourceId && mediaSourceId !== targetId) {
      item = await resolveItem(c.env.DB, mediaSourceId);
    }
    if (!item || !item.FileId) {
      return c.text("Item not found", 404);
    }

    const gdrive = new GoogleDrive(c.env);
    const token = await gdrive.getAccessToken();

    const requestHeaders: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };

    const range = c.req.header("Range");
    if (range) {
      requestHeaders["Range"] = range;
    }

    if (c.req.method === "HEAD") {
      const gdriveHead = await fetch(
        `https://www.googleapis.com/drive/v3/files/${item.FileId}?alt=media&supportsAllDrives=true`,
        { method: "HEAD", headers: requestHeaders }
      );
      const headHeaders = new Headers();
      headHeaders.set("Content-Type", ext === "mp3" ? "audio/mpeg" : (ext === "flac" ? "audio/flac" : (ext === "m4a" ? "audio/mp4" : "video/mp4")));
      headHeaders.set("Accept-Ranges", "bytes");
      headHeaders.set("Access-Control-Allow-Origin", "*");
      headHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      headHeaders.set("Access-Control-Allow-Headers", "*");
      headHeaders.set("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
      if (gdriveHead.headers.has("Content-Length")) headHeaders.set("Content-Length", gdriveHead.headers.get("Content-Length")!);
      if (item.Size) headHeaders.set("Content-Length", item.Size.toString());
      return new Response(null, { status: 200, headers: headHeaders });
    }

    const gdriveResponse = await fetch(
      `https://www.googleapis.com/drive/v3/files/${item.FileId}?alt=media&supportsAllDrives=true`,
      { headers: requestHeaders },
    );

    if (!gdriveResponse.ok && gdriveResponse.status !== 206) {
      const errText = await gdriveResponse.text();
      return c.text(
        "Failed to fetch from gdrive: " +
          gdriveResponse.status +
          " body: " +
          errText,
        500,
      );
    }

    const responseHeaders = new Headers();
    responseHeaders.set("Content-Type", ext === "mp3" ? "audio/mpeg" : (ext === "flac" ? "audio/flac" : (ext === "m4a" ? "audio/mp4" : "video/mp4")));
    responseHeaders.set("Accept-Ranges", "bytes");
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    responseHeaders.set("Access-Control-Allow-Headers", "*");
    responseHeaders.set("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");

    if (gdriveResponse.headers.has("Content-Length")) {
      responseHeaders.set(
        "Content-Length",
        gdriveResponse.headers.get("Content-Length")!,
      );
    }
    if (gdriveResponse.headers.has("Content-Range")) {
      responseHeaders.set(
        "Content-Range",
        gdriveResponse.headers.get("Content-Range")!,
      );
    }

    return new Response(gdriveResponse.body, {
      status: gdriveResponse.status,
      headers: responseHeaders,
    });
  } catch (e: any) {
    return c.text(e.message, 500);
  }
};

app.all("/Videos/:itemId/stream", streamHandler);
app.all("/Videos/:itemId/stream.:ext{[a-zA-Z0-9]+}", streamHandler);
app.all("/Videos/:itemId/main.m3u8", streamHandler);
app.all("/Videos/:itemId/master.m3u8", streamHandler);
app.all("/Videos/:itemId/*", streamHandler);
app.all("/Videos/:itemId", streamHandler);
app.all("/videos/:itemId/stream", streamHandler);
app.all("/videos/:itemId/stream.:ext{[a-zA-Z0-9]+}", streamHandler);
app.all("/videos/:itemId/main.m3u8", streamHandler);
app.all("/videos/:itemId/master.m3u8", streamHandler);
app.all("/videos/:itemId/*", streamHandler);
app.all("/videos/:itemId", streamHandler);

app.all("/Audio/:itemId/stream", streamHandler);
app.all("/Audio/:itemId/stream.:ext{[a-zA-Z0-9]+}", streamHandler);
app.all("/Audio/:itemId/universal", streamHandler);
app.all("/Audio/:itemId/*", streamHandler);
app.all("/Audio/:itemId", streamHandler);
app.all("/audio/:itemId/stream", streamHandler);
app.all("/audio/:itemId/stream.:ext{[a-zA-Z0-9]+}", streamHandler);
app.all("/audio/:itemId/universal", streamHandler);
app.all("/audio/:itemId/*", streamHandler);
app.all("/audio/:itemId", streamHandler);

const handleImageUpload = async (c: any) => {
  try {
    const itemId = c.req.param("itemId");
    const imageType = (c.req.param("imageType") || "primary").toLowerCase();
    
    let buffer: ArrayBuffer | null = null;
    let mime = "image/jpeg";
    const contentType = c.req.header("Content-Type") || c.req.header("content-type") || "";
    
    if (contentType.includes("multipart/form-data")) {
      const formData = await c.req.parseBody().catch(() => ({}));
      const fileObj: any = formData.file || formData.image || Object.values(formData)[0];
      if (fileObj && fileObj instanceof File) {
        buffer = await fileObj.arrayBuffer();
        mime = fileObj.type || "image/jpeg";
      }
    } else if (contentType.includes("json")) {
      const json = await c.req.json().catch(() => ({}));
      const base64Str = json.Base64 || json.Data || "";
      const raw = atob(base64Str.replace(/^data:image\/[a-z]+;base64,/, "").trim());
      const u8 = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
      buffer = u8.buffer;
    } else {
      const rawBuffer = await c.req.arrayBuffer();
      if (rawBuffer && rawBuffer.byteLength > 0) {
        const decoder = new TextDecoder();
        const textSample = decoder.decode(rawBuffer.slice(0, Math.min(100, rawBuffer.byteLength)));
        if (textSample.startsWith("data:image/") || textSample.includes(";base64,")) {
          const fullText = decoder.decode(rawBuffer);
          const cleanBase64 = fullText.replace(/^data:image\/[a-z]+;base64,/, "").trim();
          const raw = atob(cleanBase64);
          const u8 = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
          buffer = u8.buffer;
        } else {
          buffer = rawBuffer;
        }
      }
    }

    if (!buffer || buffer.byteLength === 0) return new Response(null, { status: 204 });

    let imageValue: string | null = null;
    // 1. Try Google Drive upload
    try {
      const gdrive = new GoogleDrive(c.env);
      const parentFolderId = c.env.GDRIVE_MEDIA_FOLDER_ID || c.env.GDRIVE_TEAM_DRIVE_ID || "1_Wz2S3UojoFgZxkxYMC_TAAavmsfg-aj";
      imageValue = await gdrive.uploadFile(`${itemId}_${imageType}.jpg`, mime, parentFolderId, buffer);
    } catch (gdriveErr) {
      console.warn("GDrive image upload failed, storing base64 in D1:", gdriveErr);
    }

    // 2. Fallback to base64 data URL in D1 so upload NEVER fails
    if (!imageValue) {
      const bytes = new Uint8Array(buffer);
      let binary = "";
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      imageValue = `data:${mime};base64,${btoa(binary)}`;
    }

    // O Web envia o ItemId da biblioteca como UUID (row.Uuid), não como o
    // Id interno "view_nome". Resolver primeiro evita UPDATE em zero linhas.
    const library = await resolveLibrary(c.env.DB, itemId);
    if (library) {
      if (imageType.startsWith("backdrop")) {
        await c.env.DB.prepare("UPDATE Libraries SET BackdropImageFileId = ? WHERE Id = ?").bind(imageValue, library.Id).run();
      } else {
        await c.env.DB.prepare("UPDATE Libraries SET PrimaryImageFileId = ? WHERE Id = ?").bind(imageValue, library.Id).run();
      }
    } else {
      const item = await resolveItem(c.env.DB, itemId);
      if (item) {
        if (imageType.startsWith("backdrop")) {
          await c.env.DB.prepare("UPDATE Items SET BackdropImageFileId = ? WHERE Id = ?").bind(imageValue, item.Id).run();
        } else {
          await c.env.DB.prepare("UPDATE Items SET PrimaryImageFileId = ? WHERE Id = ?").bind(imageValue, item.Id).run();
        }
      }
    }
    return new Response(null, { status: 204 });
  } catch (e: any) {
    console.error("handleImageUpload error:", e);
    return c.text(e.message, 500);
  }
};

app.post("/Items/:itemId/Images/:imageType", handleImageUpload);
app.post("/Items/:itemId/Images/:imageType/:index", handleImageUpload);

const handleImageDelete = async (c: any) => {
  const itemId = c.req.param("itemId");
  const imageType = (c.req.param("imageType") || "primary").toLowerCase();
  const library = await resolveLibrary(c.env.DB, itemId);
  if (library) {
    if (imageType.startsWith("backdrop")) {
      await c.env.DB.prepare("UPDATE Libraries SET BackdropImageFileId = NULL WHERE Id = ?").bind(library.Id).run();
    } else {
      await c.env.DB.prepare("UPDATE Libraries SET PrimaryImageFileId = NULL WHERE Id = ?").bind(library.Id).run();
    }
  } else {
    const item = await resolveItem(c.env.DB, itemId);
    if (item) {
      if (imageType.startsWith("backdrop")) {
        await c.env.DB.prepare("UPDATE Items SET BackdropImageFileId = NULL WHERE Id = ?").bind(item.Id).run();
      } else {
        await c.env.DB.prepare("UPDATE Items SET PrimaryImageFileId = NULL WHERE Id = ?").bind(item.Id).run();
      }
    }
  }
  return new Response(null, { status: 204 });
};

app.delete("/Items/:itemId/Images/:imageType", handleImageDelete);
app.delete("/Items/:itemId/Images/:imageType/:index", handleImageDelete);
app.post("/Items/:itemId/Images/:imageType/Delete", handleImageDelete);
app.post("/Items/:itemId/Images/:imageType/:index/Delete", handleImageDelete);

// Subtitles routes
const handleSubtitles = (c: any) => {
  return new Response("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n...\n", {
    headers: { "Content-Type": "text/vtt; charset=utf-8", "Access-Control-Allow-Origin": "*" },
  });
};
app.all("/Videos/:itemId/:mediaSourceId/Subtitles/:index/*", handleSubtitles);
app.all("/videos/:itemId/:mediaSourceId/Subtitles/:index/*", handleSubtitles);
app.all("/videos/:itemId/:mediaSourceId/subtitles/:index/*", handleSubtitles);
app.all("/Videos/:itemId/Subtitles/:index/*", handleSubtitles);
app.all("/videos/:itemId/Subtitles/:index/*", handleSubtitles);
app.all("/videos/:itemId/subtitles/:index/*", handleSubtitles);
app.all("/Videos/:itemId/Subtitles*", handleSubtitles);
app.all("/videos/:itemId/subtitles*", handleSubtitles);


export default {
  fetch: app.fetch,
  async scheduled(event: any, env: Bindings, ctx: any) {
    try {
      ctx.waitUntil(runSync(env));
    } catch (e) {
      console.error("Scheduled sync error:", e);
    }
  },
};
