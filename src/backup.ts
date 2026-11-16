import { GoogleDrive } from "./gdrive";
import { invalidateSessionCache } from "./auth";

export async function getBackupFolderId(gdrive: GoogleDrive): Promise<string> {
  const rootContents: any = await gdrive.listFolder("root");
  if (rootContents && rootContents.files) {
    const existing = rootContents.files.find(
      (f: any) =>
        f.mimeType === "application/vnd.google-apps.folder" &&
        f.name === "DriveFlin_Backups"
    );
    if (existing) return existing.id;
  }
  return await gdrive.createFolder("DriveFlin_Backups");
}

export async function createDatabaseBackup(env: any): Promise<any> {
  // Ensure Backups table exists in D1
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS Backups (
      Id TEXT PRIMARY KEY,
      Name TEXT,
      DateCreated TEXT,
      Size INTEGER,
      Data TEXT
    )
  `).run();

  const { results: libraries } = await env.DB.prepare("SELECT * FROM Libraries").all();
  const { results: items } = await env.DB.prepare("SELECT * FROM Items").all();

  let config: any[] = [];
  try {
    const { results } = await env.DB.prepare("SELECT * FROM Config").all();
    config = results;
  } catch (e) {}

  let progress: any[] = [];
  try {
    const { results } = await env.DB.prepare("SELECT * FROM PlaybackProgress").all();
    progress = results;
  } catch (e) {}

  // v2: usuários (senhas já com hash) e progresso/favoritos por usuário.
  let users: any[] = [];
  try {
    const { results } = await env.DB.prepare("SELECT Id, Name, Password, Policy, Configuration FROM Users").all();
    users = results;
  } catch (e) {}

  let userItemData: any[] = [];
  try {
    const { results } = await env.DB.prepare("SELECT * FROM UserItemData").all();
    userItemData = results;
  } catch (e) {}

  const dateCreated = new Date().toISOString();
  const backupData = {
    version: 2,
    appName: "DriveFlin",
    dateCreated,
    stats: {
      libraries: libraries.length,
      items: items.length,
    },
    tables: {
      Libraries: libraries,
      Items: items,
      Config: config,
      PlaybackProgress: progress,
      Users: users,
      UserItemData: userItemData,
    },
  };

  const jsonStr = JSON.stringify(backupData, null, 2);
  const fileName = `DriveFlin_Backup_${dateCreated.slice(0, 19).replace(/[:T]/g, "-")}.json`;
  const backupId = "backup_" + Date.now();

  // 1. Cópia no D1 (melhor esforço: o D1 limita o tamanho de cada linha, então
  //    bibliotecas grandes ficam só no Google Drive).
  let savedInD1 = false;
  try {
    await env.DB.prepare(`
      INSERT OR REPLACE INTO Backups (Id, Name, DateCreated, Size, Data)
      VALUES (?, ?, ?, ?, ?)
    `).bind(backupId, fileName, dateCreated, jsonStr.length, jsonStr).run();
    savedInD1 = true;
  } catch (e) {
    try {
      // Tabela criada pela v1 (colunas Timestamp/Filename obrigatórias)
      await env.DB.prepare(`
        INSERT OR REPLACE INTO Backups (Id, Timestamp, Filename, Name, DateCreated, Size, Data)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(backupId, dateCreated, fileName, fileName, dateCreated, jsonStr.length, jsonStr).run();
      savedInD1 = true;
    } catch (e2: any) {
      console.warn("Backup não coube no D1, ficará só no Drive:", e2?.message || e2);
    }
  }

  // 2. Also attempt upload to Google Drive
  let gdriveFileId: string | null = null;
  try {
    const gdrive = new GoogleDrive(env);
    const backupFolderId = await getBackupFolderId(gdrive);
    gdriveFileId = await gdrive.uploadFile(
      fileName,
      "application/json",
      backupFolderId,
      jsonStr
    );
  } catch (err: any) {
    console.warn("Could not upload backup to Google Drive:", err.message);
  }
  if (!savedInD1 && !gdriveFileId) {
    throw new Error("Backup failed: could not save to D1 nor Google Drive");
  }

  return {
    Path: gdriveFileId || backupId,
    Name: fileName,
    DateCreated: dateCreated,
    Size: jsonStr.length,
  };
}

export async function listDatabaseBackups(env: any): Promise<any[]> {
  const backupsMap = new Map<string, any>();

  // 1. List from D1 database
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS Backups (
        Id TEXT PRIMARY KEY,
        Name TEXT,
        DateCreated TEXT,
        Size INTEGER,
        Data TEXT
      )
    `).run();
    const { results } = await env.DB.prepare("SELECT Id, Name, DateCreated, Size FROM Backups WHERE Name IS NOT NULL").all();
    for (const b of (results || [])) {
      backupsMap.set(b.Name, {
        Path: b.Id,
        Name: b.Name,
        DateCreated: b.DateCreated,
        Size: b.Size,
      });
    }
  } catch (e) {}

  // 2. List from Google Drive
  try {
    const gdrive = new GoogleDrive(env);
    const backupFolderId = await getBackupFolderId(gdrive);
    const folderContents: any = await gdrive.listFolder(backupFolderId);
    if (folderContents && folderContents.files) {
      for (const f of folderContents.files) {
        if (f.name.endsWith(".json")) {
          backupsMap.set(f.name, {
            Path: f.id,
            Name: f.name,
            DateCreated: f.createdTime || new Date().toISOString(),
            Size: parseInt(f.size || "1024"),
          });
        }
      }
    }
  } catch (e) {}

  return Array.from(backupsMap.values()).sort(
    (a, b) => new Date(b.DateCreated).getTime() - new Date(a.DateCreated).getTime()
  );
}

export async function restoreDatabaseBackup(env: any, fileId: string): Promise<any> {
  let backupData: any = null;

  // 1. Check if stored in D1
  if (fileId.startsWith("backup_")) {
    const row: any = await env.DB.prepare("SELECT Data FROM Backups WHERE Id = ?").bind(fileId).first();
    if (row && row.Data) {
      backupData = JSON.parse(row.Data);
    }
  }

  // 2. Otherwise download from Google Drive
  if (!backupData) {
    const gdrive = new GoogleDrive(env);
    const token = await gdrive.getAccessToken();

    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (!res.ok) {
      // Fallback check in D1 by Name
      const row: any = await env.DB.prepare("SELECT Data FROM Backups WHERE Name = ? OR Id = ?").bind(fileId, fileId).first();
      if (row && row.Data) {
        backupData = JSON.parse(row.Data);
      } else {
        throw new Error(`Failed to download backup file: ${await res.text()}`);
      }
    } else {
      backupData = await res.json();
    }
  }

  if (!backupData || !backupData.tables) {
    throw new Error("Invalid backup file format");
  }

  // v2: tudo vira uma lista de comandos executados em lotes (db.batch). Isso respeita
  // o limite de subrequisições do Worker e evita restaurações pela metade.
  const db = env.DB;
  const stmts: any[] = [];
  const t = backupData.tables;

  if (Array.isArray(t.Libraries)) {
    for (const lib of t.Libraries) {
      if (!lib || !lib.Id) continue;
      stmts.push(db.prepare(`
        INSERT OR REPLACE INTO Libraries (Id, Name, FolderId, CollectionType, PrimaryImageFileId, BackdropImageFileId, Uuid)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        lib.Id,
        lib.Name,
        lib.FolderId,
        lib.CollectionType || null,
        lib.PrimaryImageFileId || null,
        lib.BackdropImageFileId || null,
        lib.Uuid || null
      ));
    }
  }

  const validItemColumns = [
    "Id", "ParentId", "LibraryId", "Type", "Name", "Overview",
    "IndexNumber", "ParentIndexNumber", "FolderId", "FileId",
    "EncryptedName", "Size", "PrimaryImageFileId", "BackdropImageFileId",
    "TmdbId", "MediaInfo", "DateCreated", "Uuid"
  ];
  if (Array.isArray(t.Items)) {
    for (const it of t.Items) {
      if (!it) continue;
      const keys = Object.keys(it).filter((k) => validItemColumns.includes(k));
      if (!keys.includes("Id")) continue;
      const placeholders = keys.map(() => "?").join(", ");
      stmts.push(db.prepare(`INSERT OR REPLACE INTO Items (${keys.join(", ")}) VALUES (${placeholders})`).bind(...keys.map((k) => it[k] ?? null)));
    }
  }

  if (Array.isArray(t.Config)) {
    for (const cfg of t.Config) {
      if (!cfg || !cfg.Key) continue;
      stmts.push(db.prepare("INSERT OR REPLACE INTO Config (Key, Value) VALUES (?, ?)").bind(cfg.Key, cfg.Value));
    }
  }

  let restoredUsers = 0;
  if (Array.isArray(t.Users)) {
    for (const u of t.Users) {
      if (!u || !u.Id || !u.Name) continue;
      restoredUsers++;
      if (u.Password === undefined || u.Password === null) {
        // Sem senha no backup: atualiza só nome/política e mantém a senha atual.
        stmts.push(db.prepare("UPDATE Users SET Name = ?, Policy = ?, Configuration = ? WHERE Id = ?")
          .bind(u.Name, u.Policy ?? null, u.Configuration ?? null, u.Id));
      } else {
        stmts.push(db.prepare("INSERT OR REPLACE INTO Users (Id, Name, Password, Policy, Configuration) VALUES (?, ?, ?, ?, ?)")
          .bind(u.Id, u.Name, String(u.Password), u.Policy ?? null, u.Configuration ?? null));
      }
    }
  }

  if (Array.isArray(t.UserItemData)) {
    for (const d of t.UserItemData) {
      if (!d || !d.UserId || !d.ItemId) continue;
      stmts.push(db.prepare(`
        INSERT OR REPLACE INTO UserItemData (UserId, ItemId, PlaybackPositionTicks, Played, IsFavorite, LastPlayedDate)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(d.UserId, d.ItemId, d.PlaybackPositionTicks ?? 0, d.Played ?? 0, d.IsFavorite ?? 0, d.LastPlayedDate ?? null));
    }
  }

  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100));
  }

  if (restoredUsers > 0) {
    // Sessões antigas deixam de valer após restaurar usuários.
    try { await db.prepare("DELETE FROM Sessions").run(); } catch (e) {}
    invalidateSessionCache();
  }

  return {
    success: true,
    restoredStats: {
      libraries: backupData.tables.Libraries?.length || 0,
      items: backupData.tables.Items?.length || 0,
      config: backupData.tables.Config?.length || 0,
      users: restoredUsers,
      userItemData: backupData.tables.UserItemData?.length || 0,
    },
  };
}

