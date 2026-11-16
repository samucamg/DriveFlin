// ==========================================================================
// DriveFlin - Built-in OAuth 2.0 Refresh Token Generator Page & API
// ==========================================================================

export const oauthHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DriveFlin — Gerador de Conexão Google Drive</title>
  <link rel="icon" type="image/png" href="/assets/img/favicon.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Cascadia+Code:wght@400;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0a0a0c;
      --surface: #141418;
      --surface-alt: #1a1a20;
      --surface-hover: #22222a;
      --border: #272730;
      --accent: #e50914;
      --accent-hover: #f40612;
      --accent-glow: rgba(229, 9, 20, 0.25);
      --text: #ffffff;
      --text-muted: #a3a3b2;
      --green: #10b981;
      --green-soft: rgba(16, 185, 129, 0.1);
      --yellow: #f59e0b;
      --yellow-soft: rgba(245, 158, 11, 0.1);
      --blue: #3b82f6;
      --blue-soft: rgba(59, 130, 246, 0.1);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: 'Inter', sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 40px 20px;
    }
    .wrapper {
      width: 100%;
      max-width: 720px;
    }
    .header {
      text-align: center;
      margin-bottom: 32px;
    }
    .brand-logo {
      max-width: 240px;
      height: auto;
      margin-bottom: 16px;
      filter: drop-shadow(0 4px 12px rgba(0,0,0,0.5));
    }
    .logo-text {
      font-size: 26px;
      font-weight: 800;
      margin-bottom: 8px;
      letter-spacing: -0.5px;
    }
    .logo-text span { color: var(--accent); }
    .subtitle {
      font-size: 15px;
      color: var(--text-muted);
      line-height: 1.5;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 28px;
      margin-bottom: 24px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    }
    .step-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      background: var(--accent);
      color: #fff;
      border-radius: 50%;
      font-size: 13px;
      font-weight: 700;
      margin-right: 8px;
    }
    .step-title {
      font-size: 16px;
      font-weight: 700;
      display: flex;
      align-items: center;
      margin-bottom: 14px;
    }
    .form-group {
      margin-bottom: 18px;
    }
    label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 6px;
    }
    input[type="text"], select {
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px 14px;
      color: #fff;
      font-size: 14px;
      font-family: inherit;
      transition: all 0.2s;
    }
    select {
      cursor: pointer;
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='%23a3a3b2' viewBox='0 0 16 16'%3E%3Cpath d='M7.247 11.14 2.451 5.658C1.885 5.013 2.345 4 3.204 4h9.592a1 1 0 0 1 .753 1.659l-4.796 5.48a1 1 0 0 1-1.506 0z'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 14px center;
      padding-right: 40px;
    }
    input[type="text"]:focus, select:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-glow);
    }
    .form-help {
      font-size: 12px;
      color: #8e8ea0;
      margin-top: 6px;
      line-height: 1.5;
    }
    .form-help a {
      color: #93c5fd;
      text-decoration: none;
    }
    .form-help a:hover { text-decoration: underline; }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      width: 100%;
      padding: 13px 20px;
      font-size: 14px;
      font-weight: 600;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s;
      border: none;
    }
    .btn-primary {
      background: var(--accent);
      color: #fff;
    }
    .btn-primary:hover {
      background: var(--accent-hover);
      transform: translateY(-1px);
    }
    .btn-secondary {
      background: var(--surface-alt);
      color: #fff;
      border: 1px solid var(--border);
    }
    .btn-secondary:hover {
      background: var(--surface-hover);
      border-color: var(--text-muted);
    }
    .alert {
      padding: 14px 16px;
      border-radius: 6px;
      font-size: 13px;
      margin-bottom: 18px;
      display: flex;
      gap: 10px;
      align-items: flex-start;
      line-height: 1.5;
    }
    .alert-warning {
      background: var(--yellow-soft);
      border: 1px solid rgba(245, 158, 11, 0.3);
      color: #fde68a;
    }
    .alert-info {
      background: var(--blue-soft);
      border: 1px solid rgba(59, 130, 246, 0.3);
      color: #bfdbfe;
    }
    .alert-success {
      background: var(--green-soft);
      border: 1px solid rgba(16, 185, 129, 0.3);
      color: #a7f3d0;
    }
    .result-box {
      display: none;
      background: #000;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 18px;
      margin-top: 20px;
    }
    .token-display {
      background: #111;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 12px;
      font-family: 'Cascadia Code', monospace;
      font-size: 13px;
      color: var(--green);
      word-break: break-all;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .copy-btn {
      background: var(--surface-alt);
      border: 1px solid var(--border);
      color: var(--text-muted);
      border-radius: 4px;
      padding: 4px 10px;
      font-size: 12px;
      cursor: pointer;
      flex-shrink: 0;
    }
    .copy-btn:hover { color: #fff; border-color: var(--accent); }
    .env-box {
      font-family: 'Cascadia Code', monospace;
      font-size: 12px;
      color: #cbd5e1;
      background: #0d0d11;
      padding: 12px;
      border-radius: 6px;
      border: 1px solid #1f1f27;
      white-space: pre-wrap;
      line-height: 1.6;
    }
    .footer {
      text-align: center;
      font-size: 13px;
      color: var(--text-muted);
      margin-top: 20px;
    }
    .footer a {
      color: var(--accent);
      text-decoration: none;
    }
    .footer a:hover { text-decoration: underline; }
    .pill {
      display: inline-block;
      padding: 2px 6px;
      background: #222;
      border: 1px solid #333;
      border-radius: 4px;
      font-family: monospace;
      font-size: 11px;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div>
        <a href="https://driveflin.org">
          <img class="brand-logo" src="/assets/img/DriveFlin.png" alt="DriveFlin" onerror="this.src='https://raw.githubusercontent.com/samucamg/DriveFlin/main/assets/driveflin-web-assets/DriveFlin.png'">
        </a>
      </div>
      <div class="logo-text">🎬 Drive<span>Flin</span> Generator</div>
      <p class="subtitle">Gerador Seguro de Conexão Google Drive (OAuth 2.0)</p>
    </div>

    <div class="alert alert-warning">
      <span>💡</span>
      <div>
        <strong>100% Privado e Seguro:</strong> Este gerador roda diretamente no Cloudflare Workers. Suas credenciais são trocadas diretamente com os servidores da Google, sem intermediários.
      </div>
    </div>

    <!-- PASSO 1 -->
    <div class="card">
      <div class="step-title">
        <span class="step-badge">1</span>
        Credenciais do Google Cloud
      </div>
      
      <div class="form-group">
        <label for="appType">Tipo da Credencial criada no Google Cloud:</label>
        <select id="appType" onchange="updateRedirectUriHelp()">
          <option value="desktop" selected>App para Computador (Desktop App) — Recomendado (Sem erro de URI)</option>
          <option value="web">Aplicativo da Web (Web Application) — Retorno direto</option>
        </select>
        <div id="typeHelpDesktop" class="alert alert-info" style="margin-top: 10px; margin-bottom: 0;">
          <span>ℹ️</span>
          <div>
            <strong>Tipo Computador (Desktop):</strong> O Google autoriza o redirecionamento para <code>http://localhost</code> nativamente. Não é necessário configurar URIs de redirecionamento no Google Cloud!
          </div>
        </div>
        <div id="typeHelpWeb" class="alert alert-warning" style="margin-top: 10px; margin-bottom: 0; display: none;">
          <span>⚠️</span>
          <div>
            <strong>Importante para Aplicativo da Web:</strong> Para evitar o erro <span class="pill">redirect_uri_mismatch</span> do Google, acesse o <a href="https://console.cloud.google.com/apis/credentials" target="_blank">Google Cloud Console</a>, clique no seu cliente e em <strong>URIs de redirecionamento autorizados</strong> adicione exatamente:<br>
            <span class="pill" id="webRedirectUriDisplay">https://generator.driveflin.org</span>
          </div>
        </div>
      </div>

      <div class="form-group">
        <label for="clientId">Client ID <span style="color: var(--accent);">*</span></label>
        <input type="text" id="clientId" placeholder="ex: 1032237895629-xxxx.apps.googleusercontent.com">
      </div>

      <div class="form-group">
        <label for="clientSecret">Client Secret <span style="color: var(--accent);">*</span></label>
        <input type="text" id="clientSecret" placeholder="ex: GOCSPX-xxxxxxxxxxxxxxxxxxxxxxxx">
        <div class="form-help">Ambos são obtidos no <a href="https://console.cloud.google.com/apis/credentials" target="_blank">Google Cloud Console ↗</a> em APIs e Serviços > Credenciais.</div>
      </div>

      <button class="btn btn-secondary" onclick="openGoogleAuth()">
        🔗 1. Abrir Autorização Google
      </button>
      <div id="authError" style="color: #f87171; font-size: 13px; margin-top: 10px; display: none;"></div>
    </div>

    <!-- PASSO 2 -->
    <div class="card" id="step2Card">
      <div class="step-title">
        <span class="step-badge">2</span>
        Código de Retorno da Google
      </div>

      <div class="form-group">
        <label for="authCode">Cole a URL completa da página ou o código:</label>
        <input type="text" id="authCode" placeholder="http://localhost/?code=4/0Axxxx... ou cole o código 4/0A...">
        <div class="form-help">
          Após autorizar na Google, seu navegador mostrará uma página em branco ou erro de conexão (normal, pois o localhost não roda um servidor). Copie o endereço completo da barra de endereços (URL) e cole acima.
        </div>
      </div>

      <button class="btn btn-primary" id="exchangeBtn" onclick="exchangeToken()">
        🔑 2. Gerar Refresh Token
      </button>
      <div id="exchangeError" style="color: #f87171; font-size: 13px; margin-top: 10px; display: none;"></div>

      <div class="result-box" id="resultBox">
        <div class="alert alert-success" style="margin-bottom: 12px;">
          <span>✓</span>
          <div><strong>Sucesso!</strong> Seu Refresh Token perpétuo foi gerado com sucesso!</div>
        </div>

        <label>Seu Refresh Token:</label>
        <div class="token-display">
          <span id="tokenVal"></span>
          <button class="copy-btn" onclick="copyToken()">Copiar</button>
        </div>

        <label style="margin-top: 14px;">Adicione nas Variáveis do Cloudflare Workers (Settings > Variables and Secrets):</label>
        <div class="env-box" id="envBox"></div>
      </div>
    </div>

    <div class="footer">
      <a href="https://driveflin.org" target="_blank">← Ir para driveflin.org</a> &nbsp;•&nbsp; 
      <a href="/web/index.html">Interface do Jellyfin</a> &nbsp;•&nbsp; 
      <a href="https://console.cloud.google.com/apis/credentials" target="_blank">Google Cloud Console ↗</a> &nbsp;•&nbsp; 
      <a href="https://github.com/samucamg/DriveFlin" target="_blank">GitHub ↗</a>
    </div>
  </div>

  <script>
    function updateRedirectUriHelp() {
      const type = document.getElementById('appType').value;
      const helpDesktop = document.getElementById('typeHelpDesktop');
      const helpWeb = document.getElementById('typeHelpWeb');
      const webDisplay = document.getElementById('webRedirectUriDisplay');
      webDisplay.innerText = window.location.origin;

      if (type === 'desktop') {
        helpDesktop.style.display = 'flex';
        helpWeb.style.display = 'none';
      } else {
        helpDesktop.style.display = 'none';
        helpWeb.style.display = 'flex';
      }
    }

    function openGoogleAuth() {
      const cid = document.getElementById('clientId').value.trim();
      const cs = document.getElementById('clientSecret').value.trim();
      const type = document.getElementById('appType').value;
      const err = document.getElementById('authError');

      if (!cid || !cs) {
        err.innerText = 'Preencha o Client ID E o Client Secret antes de abrir a autorização.';
        err.style.display = 'block';
        return;
      }
      err.style.display = 'none';

      // Persist in sessionStorage so credentials survive redirects
      sessionStorage.setItem('df_cid', cid);
      sessionStorage.setItem('df_cs', cs);
      sessionStorage.setItem('df_type', type);

      const redirectUri = type === 'web' ? window.location.origin : 'http://localhost';

      const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth'
        + '?scope=' + encodeURIComponent('https://www.googleapis.com/auth/drive')
        + '&response_type=code'
        + '&access_type=offline'
        + '&prompt=consent'
        + '&client_id=' + encodeURIComponent(cid)
        + '&redirect_uri=' + encodeURIComponent(redirectUri);
      
      window.open(authUrl, '_blank');
    }

    async function exchangeToken() {
      const cid = document.getElementById('clientId').value.trim() || sessionStorage.getItem('df_cid') || '';
      const cs = document.getElementById('clientSecret').value.trim() || sessionStorage.getItem('df_cs') || '';
      const type = document.getElementById('appType').value;
      const codeInput = document.getElementById('authCode').value.trim();
      const err = document.getElementById('exchangeError');
      const btn = document.getElementById('exchangeBtn');
      const resultBox = document.getElementById('resultBox');

      err.style.display = 'none';
      resultBox.style.display = 'none';

      if (!cid || !cs || !codeInput) {
        err.innerText = 'Preencha todos os campos (Client ID, Client Secret e Código).';
        err.style.display = 'block';
        return;
      }

      btn.disabled = true;
      btn.innerText = 'Trocando código com a Google...';

      const redirectUri = type === 'web' ? window.location.origin : 'http://localhost';

      try {
        const res = await fetch('/api/oauth/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            code: codeInput, 
            clientId: cid, 
            clientSecret: cs,
            redirectUri: redirectUri
          })
        });
        const data = await res.json();

        if (!data.success) {
          throw new Error(data.error || 'Erro ao obter Refresh Token da Google.');
        }

        document.getElementById('tokenVal').innerText = data.refresh_token;
        document.getElementById('envBox').innerText = 
          'GDRIVE_CLIENT_ID = ' + cid + '\\n' +
          'GDRIVE_CLIENT_SECRET = ' + cs + '\\n' +
          'GDRIVE_REFRESH_TOKEN = ' + data.refresh_token;

        resultBox.style.display = 'block';
        resultBox.scrollIntoView({ behavior: 'smooth' });
      } catch (e) {
        err.innerText = 'Erro: ' + e.message;
        err.style.display = 'block';
      } finally {
        btn.disabled = false;
        btn.innerText = '🔑 2. Gerar Refresh Token';
      }
    }

    function copyToken() {
      const token = document.getElementById('tokenVal').innerText;
      navigator.clipboard.writeText(token).then(() => {
        alert('Refresh Token copiado para a área de transferência!');
      });
    }

    // Auto-detect code in URL if Google redirected directly
    window.addEventListener('DOMContentLoaded', () => {
      updateRedirectUriHelp();

      const savedCid = sessionStorage.getItem('df_cid');
      const savedCs = sessionStorage.getItem('df_cs');
      const savedType = sessionStorage.getItem('df_type');

      if (savedCid) document.getElementById('clientId').value = savedCid;
      if (savedCs) document.getElementById('clientSecret').value = savedCs;
      if (savedType) {
        document.getElementById('appType').value = savedType;
        updateRedirectUriHelp();
      }

      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      const error = params.get('error');

      if (error) {
        const err = document.getElementById('authError');
        err.innerText = 'Erro retornado pela Google: ' + error;
        err.style.display = 'block';
      } else if (code) {
        document.getElementById('authCode').value = code;
        if (savedCid && savedCs) {
          exchangeToken();
        }
      }
    });
  </script>
</body>
</html>`;
