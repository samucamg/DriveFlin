import { GoogleDrive } from "./gdrive";

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

  const dateCreated = new Date().toISOString();
  const backupData = {
    version: 1,
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
    },
  };

  const jsonStr = JSON.stringify(backupData, null, 2);
  const fileName = `DriveFlin_Backup_${dateCreated.slice(0, 19).replace(/[:T]/g, "-")}.json`;
  const backupId = "backup_" + Date.now();

  // 1. Save to D1 database for instant reliability
  await env.DB.prepare(`
    INSERT OR REPLACE INTO Backups (Id, Name, DateCreated, Size, Data)
    VALUES (?, ?, ?, ?, ?)
  `).bind(backupId, fileName, dateCreated, jsonStr.length, jsonStr).run();

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
    const { results } = await env.DB.prepare("SELECT Id, Name, DateCreated, Size FROM Backups").all();
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

  // Restore Libraries
  if (backupData.tables.Libraries && Array.isArray(backupData.tables.Libraries)) {
    for (const lib of backupData.tables.Libraries) {
      await env.DB.prepare(`
        INSERT OR REPLACE INTO Libraries (Id, Name, FolderId, CollectionType, PrimaryImageFileId)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        lib.Id,
        lib.Name,
        lib.FolderId,
        lib.CollectionType || null,
        lib.PrimaryImageFileId || null
      ).run();
    }
  }

  // Restore Items
  const validItemColumns = [
    "Id", "ParentId", "LibraryId", "Type", "Name", "Overview",
    "IndexNumber", "ParentIndexNumber", "FolderId", "FileId",
    "EncryptedName", "Size", "PrimaryImageFileId", "BackdropImageFileId",
    "TmdbId", "MediaInfo", "DateCreated"
  ];

  if (backupData.tables.Items && Array.isArray(backupData.tables.Items)) {
    for (const it of backupData.tables.Items) {
      const keys = Object.keys(it).filter((k) => validItemColumns.includes(k));
      if (keys.length > 0) {
        const placeholders = keys.map(() => "?").join(", ");
        const values = keys.map((k) => it[k] ?? null);
        await env.DB.prepare(`
          INSERT OR REPLACE INTO Items (${keys.join(", ")})
          VALUES (${placeholders})
        `).bind(...values).run();
      }
    }
  }

  // Restore Config
  if (backupData.tables.Config && Array.isArray(backupData.tables.Config)) {
    for (const cfg of backupData.tables.Config) {
      await env.DB.prepare(`
        INSERT OR REPLACE INTO Config (Key, Value) VALUES (?, ?)
      `).bind(cfg.Key, cfg.Value).run();
    }
  }

  // Restore PlaybackProgress
  if (backupData.tables.PlaybackProgress && Array.isArray(backupData.tables.PlaybackProgress)) {
    for (const prog of backupData.tables.PlaybackProgress) {
      await env.DB.prepare(`
        INSERT OR REPLACE INTO PlaybackProgress (UserId, ItemId, PositionTicks, Played, LastPlayedDate)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        prog.UserId,
        prog.ItemId,
        prog.PositionTicks,
        prog.Played,
        prog.LastPlayedDate || null
      ).run();
    }
  }

  return {
    success: true,
    restoredStats: {
      libraries: backupData.tables.Libraries?.length || 0,
      items: backupData.tables.Items?.length || 0,
      config: backupData.tables.Config?.length || 0,
    },
  };
}

