const tokenCache = new Map<string, { token: string; exp: number }>();

export class GoogleDrive {
  private clientId: string;
  private clientSecret: string;
  private refreshToken: string;
  public teamDriveId: string;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(env: any) {
    // v2: nenhuma credencial embutida. Configure os secrets do Worker:
    //   GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, GDRIVE_REFRESH_TOKEN (e opcionalmente GDRIVE_TEAM_DRIVE_ID)
    this.clientId = String(env?.GDRIVE_CLIENT_ID || "").trim();
    this.clientSecret = String(env?.GDRIVE_CLIENT_SECRET || "").trim();
    this.refreshToken = String(env?.GDRIVE_REFRESH_TOKEN || "").trim();
    this.teamDriveId = String(env?.GDRIVE_TEAM_DRIVE_ID || "").trim();
  }

  isConfigured(): boolean {
    return !!(this.clientId && this.clientSecret && this.refreshToken);
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }
    if (!this.isConfigured()) {
      throw new Error("Google Drive não configurado: defina GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET e GDRIVE_REFRESH_TOKEN nos secrets do Worker.");
    }

    // Reaproveita o access token entre requisições do mesmo isolate (evita um refresh por stream).
    const cacheKey = this.clientId + ":" + this.refreshToken.slice(-12);
    const cached = tokenCache.get(cacheKey);
    if (cached && Date.now() < cached.exp) {
      this.accessToken = cached.token;
      this.tokenExpiresAt = cached.exp;
      return cached.token;
    }

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });

    if (!response.ok) {
      // Não repassa o corpo da resposta do Google para o cliente.
      const detail = await response.text().catch(() => "");
      console.error("[gdrive] refresh falhou:", response.status, detail.slice(0, 200));
      throw new Error('Failed to refresh Google Drive token (' + response.status + ')');
    }

    const data: any = await response.json();
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + (Math.max(Number(data.expires_in) || 3600, 120) - 60) * 1000;
    tokenCache.set(cacheKey, { token: this.accessToken || '', exp: this.tokenExpiresAt });

    return this.accessToken || '';
  }

  async listFolder(rawFolderId: string = 'root') {
    const idMatch = rawFolderId.match(/[-\w]{25,}/);
    // Evita injeção na query do Drive (aspas/barras) quando o valor não é um ID.
    const folderId = idMatch ? idMatch[0] : String(rawFolderId).replace(/['\\]/g, "");

    const token = await this.getAccessToken();
    const fields = "nextPageToken,files(id,name,mimeType,size,createdTime,driveId,shortcutDetails(targetId,targetMimeType))";
    const params = new URLSearchParams({
      pageSize: "1000",
      fields,
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true",
    });

    // A Shared Drive root is only selected when its ID is explicit.
    // The ordinary "root" remains the user's My Drive root.
    if (folderId === this.teamDriveId && this.teamDriveId) {
      params.set("q", "'" + this.teamDriveId + "' in parents and trashed=false");
      params.set("corpora", "drive");
      params.set("driveId", this.teamDriveId);
    } else if (folderId !== "root") {
      params.set("q", "'" + folderId + "' in parents and trashed=false");
      params.set("corpora", "allDrives");
    } else {
      params.set("q", "'root' in parents and trashed=false");
    }
    let urlBase = "https://www.googleapis.com/drive/v3/files?" + params.toString();

    let allFiles: any[] = [];
    let pageToken: string | null = null;
    let anySuccess = false;

    do {
      let url = urlBase;
      if (pageToken) url += "&pageToken=" + pageToken;
      
      let res = await fetch(url, {
        headers: { Authorization: "Bearer " + token }
      });
      
      if (!res.ok && folderId === 'root' && !pageToken) {
        const fallback = new URLSearchParams({
          pageSize: "1000",
          q: "'root' in parents and trashed=false",
          fields,
          includeItemsFromAllDrives: "true",
          supportsAllDrives: "true",
        });
        urlBase = "https://www.googleapis.com/drive/v3/files?" + fallback.toString();
        res = await fetch(urlBase, {
          headers: { Authorization: "Bearer " + token }
        });
      }

      if (!res.ok) {
        throw new Error("Failed to list folder: " + await res.text());
      }

      const data: any = await res.json();
      anySuccess = true;
      if (data.files && data.files.length > 0) {
        allFiles = allFiles.concat(data.files);
      }
      pageToken = data.nextPageToken || null;
    } while (pageToken);

    return { files: allFiles };
  }

  async uploadFile(fileName: string, mimeType: string, parentFolderId: string, streamOrBuffer: any): Promise<string> {
    const token = await this.getAccessToken();
    
    const metadata: any = {
      name: fileName,
    };
    if (parentFolderId && parentFolderId !== 'root') {
      metadata.parents = [parentFolderId];
    }
    
    let initRes = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "X-Upload-Content-Type": mimeType
      },
      body: JSON.stringify(metadata)
    });
    
    if (!initRes.ok && metadata.parents) {
      delete metadata.parents;
      initRes = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + token,
          "Content-Type": "application/json",
          "X-Upload-Content-Type": mimeType
        },
        body: JSON.stringify(metadata)
      });
    }
    
    if (!initRes.ok) throw new Error("Failed to init upload: " + await initRes.text());
    
    const uploadUrl = initRes.headers.get("Location");
    if (!uploadUrl) throw new Error("No upload URL returned");
    
    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": mimeType
      },
      body: streamOrBuffer
    });
    
    if (!uploadRes.ok) throw new Error("Failed to upload: " + await uploadRes.text());
    
    const result: any = await uploadRes.json();
    return result.id;
  }

  async getFile(fileId: string): Promise<any> {
    const token = await this.getAccessToken();
    const res = await fetch("https://www.googleapis.com/drive/v3/files/" + fileId + "?fields=id,name,mimeType,parents,driveId,trashed,shortcutDetails(targetId,targetMimeType)&supportsAllDrives=true", {
      headers: { Authorization: "Bearer " + token }
    });
    if (!res.ok) return null;
    return await res.json();
  }

  async createFolder(folderName: string, parentFolderId?: string): Promise<string> {
    const token = await this.getAccessToken();
    const metadata: any = {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder"
    };
    if (parentFolderId && parentFolderId !== 'root') {
      metadata.parents = [parentFolderId];
    } else if (this.teamDriveId && this.teamDriveId.trim() !== '') {
      metadata.parents = [this.teamDriveId];
    }
    let res = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(metadata)
    });
    if (!res.ok && metadata.parents) {
      delete metadata.parents;
      this.teamDriveId = '';
      res = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(metadata)
      });
    }
    if (!res.ok) throw new Error("Failed to create folder: " + await res.text());
    const data: any = await res.json();
    return data.id;
  }
}
