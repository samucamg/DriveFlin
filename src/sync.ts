import { GoogleDrive } from './gdrive';
import { Cipher } from '@fyears/rclone-crypt';
import { toValidUuid } from './index';

// Sync a single series folder directly into the DB (no self-fetch needed)
async function syncSeriesFolder(env: any, gdrive: any, rc: any, libraryId: string, seriesId: string, seriesFolderId: string, seenIds: string[]) {
  const seasonList: any = await gdrive.listFolder(seriesFolderId);
  for (const seasonItem of (seasonList.files || [])) {
    if ((seasonItem.shortcutDetails?.targetMimeType || seasonItem.mimeType) === 'application/vnd.google-apps.folder') {
      let seasonName = seasonItem.name;
      try { seasonName = await rc.decryptFileName(seasonItem.name); } catch(e) {}
      const sMatch = seasonName.match(/S(\d+)|Season\s*(\d+)|Temporada\s*(\d+)/i);
      const seasonNumber = sMatch ? parseInt(sMatch[1] || sMatch[2] || sMatch[3]) : 1;
      const seasonId = `season_${(seasonItem.shortcutDetails?.targetId || seasonItem.id)}`;
      seenIds.push(seasonId);

      await env.DB.prepare(`
        INSERT INTO Items (Id, ParentId, LibraryId, Type, Name, IndexNumber, FolderId, Uuid)
        VALUES (?, ?, ?, 'Season', ?, ?, ?, ?)
        ON CONFLICT(Id) DO UPDATE SET Name = CASE WHEN Items.TmdbId IS NULL THEN excluded.Name ELSE Items.Name END, IndexNumber = excluded.IndexNumber, FolderId = excluded.FolderId, Uuid = excluded.Uuid
      `).bind(seasonId, seriesId, libraryId, seasonName, seasonNumber, (seasonItem.shortcutDetails?.targetId || seasonItem.id), toValidUuid(seasonId)).run();

      const epList: any = await gdrive.listFolder((seasonItem.shortcutDetails?.targetId || seasonItem.id));
      for (const ep of (epList.files || [])) {
        if ((ep.shortcutDetails?.targetMimeType || ep.mimeType) === 'application/vnd.google-apps.folder') continue;
        let epName = ep.name;
        try { epName = await rc.decryptFileName(ep.name); } catch(e) {}
        if (!epName.match(/\.(mp4|mkv|avi|webm|m4v|mov|wmv)$/i)) continue;
        const rowEpId = `ep_${(ep.shortcutDetails?.targetId || ep.id)}`;
        seenIds.push(rowEpId);
        
        const epMatch = epName.match(/(?:[Ss]\d+)?\s*[Ee](\d+)|\b\d+x(\d+)\b|\bEp[._\s]*(\d+)\b|(?:^|\D)(\d{1,3})\s*\./i);
        const epNumber = epMatch ? parseInt(epMatch[1] || epMatch[2] || epMatch[3] || epMatch[4]) : 1;
        await env.DB.prepare(`
          INSERT INTO Items (Id, ParentId, LibraryId, Type, Name, IndexNumber, ParentIndexNumber, FileId, EncryptedName, Size, Uuid)
          VALUES (?, ?, ?, 'Episode', ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(Id) DO UPDATE SET Name = CASE WHEN Items.TmdbId IS NULL THEN excluded.Name ELSE Items.Name END, IndexNumber = excluded.IndexNumber, ParentIndexNumber = excluded.ParentIndexNumber, FileId = excluded.FileId, EncryptedName = excluded.EncryptedName, Size = excluded.Size, Uuid = excluded.Uuid
        `).bind(rowEpId, seasonId, libraryId, epName, epNumber, seasonNumber, (ep.shortcutDetails?.targetId || ep.id), ep.name, ep.size || 0, toValidUuid(rowEpId)).run();
      }
    } else {
      // File at series root level (no season folder) — treat as S01
      let epName = seasonItem.name;
      try { epName = await rc.decryptFileName(seasonItem.name); } catch(e) {}
      if (!epName.match(/\.(mp4|mkv|avi|webm|m4v|mov|wmv)$/i)) continue;

      const defaultSeasonId = `season_${seriesFolderId}_s1`;
      seenIds.push(defaultSeasonId);
      
      await env.DB.prepare(`
        INSERT INTO Items (Id, ParentId, LibraryId, Type, Name, IndexNumber, FolderId, Uuid)
        VALUES (?, ?, ?, 'Season', 'Season 1', 1, ?, ?)
        ON CONFLICT(Id) DO UPDATE SET Name = CASE WHEN Items.TmdbId IS NULL THEN excluded.Name ELSE Items.Name END, IndexNumber = excluded.IndexNumber, FolderId = excluded.FolderId, Uuid = excluded.Uuid
      `).bind(defaultSeasonId, seriesId, libraryId, seriesFolderId, toValidUuid(defaultSeasonId)).run();

      const rowEpId = `ep_${(seasonItem.shortcutDetails?.targetId || seasonItem.id)}`;
      seenIds.push(rowEpId);
      
      const epMatch = epName.match(/(?:[Ss]\d+)?\s*[Ee](\d+)|\b\d+x(\d+)\b|\bEp[._\s]*(\d+)\b|(?:^|\D)(\d{1,3})\s*\./i);
      const epNumber = epMatch ? parseInt(epMatch[1] || epMatch[2] || epMatch[3] || epMatch[4]) : 1;
      await env.DB.prepare(`
        INSERT INTO Items (Id, ParentId, LibraryId, Type, Name, IndexNumber, ParentIndexNumber, FileId, EncryptedName, Size, Uuid)
        VALUES (?, ?, ?, 'Episode', ?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(Id) DO UPDATE SET Name = CASE WHEN Items.TmdbId IS NULL THEN excluded.Name ELSE Items.Name END, IndexNumber = excluded.IndexNumber, FileId = excluded.FileId, EncryptedName = excluded.EncryptedName, Size = excluded.Size, Uuid = excluded.Uuid
      `).bind(rowEpId, defaultSeasonId, libraryId, epName, epNumber, (seasonItem.shortcutDetails?.targetId || seasonItem.id), seasonItem.name, seasonItem.size || 0, toValidUuid(rowEpId)).run();
    }
  }
}

// Sync a single movie folder directly into the DB (with recursion)
async function syncMovieFolder(env: any, gdrive: any, rc: any, libraryId: string, folderId: string, seenIds: string[], depth: number = 0, pending: any[] = []) {
  if (depth > 3) return;
  const list: any = await gdrive.listFolder(folderId);
  for (const item of (list.files || [])) {
    try {
      if ((item.shortcutDetails?.targetMimeType || item.mimeType) === 'application/vnd.google-apps.folder') {
        await syncMovieFolder(env, gdrive, rc, libraryId, (item.shortcutDetails?.targetId || item.id), seenIds, depth + 1, pending);
      } else {
        let name = item.name;
        try { name = await rc.decryptFileName(item.name); } catch(e) {}
        if (!name.match(/\.(mp4|mkv|avi|webm|m4v|mov|wmv)$/i)) continue;
        const fileId = item.shortcutDetails?.targetId || item.id;
        const rowId = `movie_${fileId}`;
        seenIds.push(rowId);
        pending.push(env.DB.prepare(`
          INSERT INTO Items (Id, ParentId, LibraryId, Type, Name, FileId, EncryptedName, Size, Uuid)
          VALUES (?, ?, ?, 'Movie', ?, ?, ?, ?, ?)
          ON CONFLICT(Id) DO UPDATE SET Name = CASE WHEN Items.TmdbId IS NULL THEN excluded.Name ELSE Items.Name END, Size = excluded.Size, FileId = excluded.FileId, EncryptedName = excluded.EncryptedName, Uuid = excluded.Uuid
        `).bind(rowId, libraryId, libraryId, name, fileId, item.name, item.size || 0, toValidUuid(rowId)));
        if (pending.length >= 50) {
          await env.DB.batch(pending.splice(0, pending.length));
        }
      }
    } catch (err) {
      console.error(`Error syncing movie item:`, err);
    }
  }
  if (depth === 0 && pending.length) await env.DB.batch(pending.splice(0, pending.length));
}

export async function runSync(env: any) {
  const gdrive = new GoogleDrive(env);
  const rc = new Cipher('base32');
  rc.dirNameEncrypt = false;
  if (env.RCLONE_PASS) {
    await rc.key(env.RCLONE_PASS, env.RCLONE_SALT || '');
  }

  const { results: libraries } = await env.DB.prepare("SELECT * FROM Libraries").all();

  for (const lib of libraries) {
    try {
      const libraryId = lib.Id;
      const libraryFolderId = lib.FolderId;
      if (!libraryFolderId) continue;
      // Skip libraries that silently point to "root" when a Shared Drive is
      // configured  - "root" + teamDriveId = entire Shared Drive, not intended.
      if (libraryFolderId === "root" && gdrive.teamDriveId) continue;

      const isMovieLib = (lib.CollectionType === 'movies') || lib.Name.toLowerCase().includes('filme');
      const isTvLib = (lib.CollectionType === 'tvshows') || lib.Name.toLowerCase().includes('serie');
      const isMusicLib = (lib.CollectionType === 'music') || lib.Name.toLowerCase().includes('musica');

      const topList: any = await gdrive.listFolder(libraryFolderId);
      if (!topList || !topList.files) continue;

      const seenIds: string[] = [];

      if (isTvLib) {
        for (const seriesFolder of topList.files) {
          if ((seriesFolder.shortcutDetails?.targetMimeType || seriesFolder.mimeType) !== 'application/vnd.google-apps.folder') continue;
          let seriesName = seriesFolder.name;
          try { seriesName = await rc.decryptFileName(seriesFolder.name); } catch(e) {}
          if (/^S\d+/i.test(seriesName) || /^Season/i.test(seriesName) || /^Temporada/i.test(seriesName)) continue;

          const seriesId = `series_${(seriesFolder.shortcutDetails?.targetId || seriesFolder.id)}`;
          seenIds.push(seriesId);
          
          await env.DB.prepare(`
            INSERT INTO Items (Id, ParentId, LibraryId, Type, Name, FolderId, Uuid)
            VALUES (?, ?, ?, 'Series', ?, ?, ?)
            ON CONFLICT(Id) DO UPDATE SET Name = CASE WHEN Items.TmdbId IS NULL THEN excluded.Name ELSE Items.Name END, FolderId = excluded.FolderId, Uuid = excluded.Uuid
          `).bind(seriesId, libraryId, libraryId, seriesName, (seriesFolder.shortcutDetails?.targetId || seriesFolder.id), toValidUuid(seriesId)).run();

          await syncSeriesFolder(env, gdrive, rc, libraryId, seriesId, (seriesFolder.shortcutDetails?.targetId || seriesFolder.id), seenIds).catch(err => {
            console.error(`Error syncing series ${seriesName}:`, err);
          });
        }
      } else if (isMovieLib) {
        await syncMovieFolder(env, gdrive, rc, libraryId, libraryFolderId, seenIds);
      } else if (isMusicLib) {
        for (const item of topList.files) {
          try {
            let name = item.name;
            try { name = await rc.decryptFileName(item.name); } catch(e) {}
            if (!name.match(/\.(mp3|flac|m4a|ogg|wav|aac)$/i)) continue;
            const rowId = `audio_${(item.shortcutDetails?.targetId || item.id)}`;
            seenIds.push(rowId);
            
            await env.DB.prepare(`
              INSERT INTO Items (Id, ParentId, LibraryId, Type, Name, FileId, EncryptedName, Size, Uuid)
              VALUES (?, ?, ?, 'Audio', ?, ?, ?, ?, ?)
              ON CONFLICT(Id) DO UPDATE SET Name = CASE WHEN Items.TmdbId IS NULL THEN excluded.Name ELSE Items.Name END, Size = excluded.Size, FileId = excluded.FileId, EncryptedName = excluded.EncryptedName, Uuid = excluded.Uuid
            `).bind(rowId, libraryId, libraryId, name, (item.shortcutDetails?.targetId || item.id), item.name, item.size || 0, toValidUuid(rowId)).run();
          } catch (err) {
            console.error(`Error syncing audio item:`, err);
          }
        }
      }
      
      // Cleanup items that are no longer in this library
      if (seenIds.length > 0) {
        const placeholders = seenIds.map(() => '?').join(',');
        
        // SQLite has a limit on parameters per query (usually 999 or 32766). 
        // We can safely chunk it just in case, but usually a library has a few thousand items at most.
        // Let's do a batch fetch of existing IDs and delete the missing ones to avoid limit issues.
        const allLibItems: any = await env.DB.prepare("SELECT Id FROM Items WHERE LibraryId = ?").bind(libraryId).all();
        const seenSet = new Set(seenIds);
        const toDelete = (allLibItems.results || []).map((r: any) => r.Id).filter((id: string) => !seenSet.has(id));
        
        if (toDelete.length > 0) {
          console.log(`Deleting ${toDelete.length} stale items from library ${libraryId}`);
          // Chunk deletions
          for (let i = 0; i < toDelete.length; i += 50) {
            const chunk = toDelete.slice(i, i + 50);
            const chunkPlaceholders = chunk.map(() => '?').join(',');
            await env.DB.prepare(`DELETE FROM Items WHERE Id IN (${chunkPlaceholders})`).bind(...chunk).run();
          }
        }
      }

    } catch (err) {
      console.error(`Error syncing library ${lib.Id}:`, err);
    }
  }

  // Background TMDB Metadata Enrichment
  try {
    console.log("Running background TMDB metadata enrichment...");
    const { searchTmdb, getTmdbDetails } = await import('./tmdb');
    
    const missingMetadata = await env.DB.prepare("SELECT * FROM Items WHERE TmdbId IS NULL AND (Type = 'Movie' OR Type = 'Series') LIMIT 50").all();
    
    if (missingMetadata.results && missingMetadata.results.length > 0) {
      console.log(`Enriching ${missingMetadata.results.length} items with TMDB metadata...`);
      for (const row of missingMetadata.results) {
         const searchRes = await searchTmdb(env.TMDB_API_KEY, row.Name, row.Type);
         if (searchRes) {
            const tmdbDet = await getTmdbDetails(env.TMDB_API_KEY, searchRes.id, row.Type);
            if (tmdbDet) {
                const mediaInfoStr = JSON.stringify({
                  tmdb: {
                    id: tmdbDet.id,
                    title: tmdbDet.title,
                    overview: tmdbDet.overview,
                    tagline: tmdbDet.tagline,
                    genres: tmdbDet.genres,
                    people: tmdbDet.people,
                    studios: tmdbDet.studios,
                    voteAverage: tmdbDet.voteAverage,
                    releaseDate: tmdbDet.releaseDate,
                    posterPath: tmdbDet.posterPath,
                    backdropPath: tmdbDet.backdropPath,
                  }
                });
                
                await env.DB.prepare(`
                  UPDATE Items SET 
                    TmdbId = ?, 
                    PrimaryImageFileId = COALESCE(PrimaryImageFileId, ?), 
                    BackdropImageFileId = COALESCE(BackdropImageFileId, ?),
                    Overview = COALESCE(Overview, ?),
                    Name = ?,
                    MediaInfo = ?
                  WHERE Id = ?
                `).bind(
                  searchRes.id, 
                  tmdbDet.posterPath, 
                  tmdbDet.backdropPath, 
                  tmdbDet.overview,
                  tmdbDet.title || row.Name,
                  mediaInfoStr,
                  row.Id
                ).run();
            } else {
                // Fallback if details fail
                await env.DB.prepare("UPDATE Items SET TmdbId = ?, Name = ? WHERE Id = ?").bind(searchRes.id, searchRes.title || row.Name, row.Id).run();
            }
         } else {
            // Mark as searched so we don't retry every time in the next runs (could use a dummy TMDB ID like -1)
            await env.DB.prepare("UPDATE Items SET TmdbId = ? WHERE Id = ?").bind("-1", row.Id).run();
         }
      }
    }
  } catch (err) {
    console.error("Error auto-fetching TMDB metadata:", err);
  }

  return { success: true };
}
