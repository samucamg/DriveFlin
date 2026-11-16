// ==========================================================================
// DriveFlin — OAuth 2.0 Refresh Token Generator Cloudflare Worker
// Domain: generator.driveflin.org
// ==========================================================================

const htmlContent = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DriveFlin — Gerador de Conexão Google Drive</title>
  <link rel="icon" type="image/png" href="https://driveflin.org/assets/img/favicon.png">
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
      text-decoration: none;
      box-sizing: border-box;
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
    .direct-link {
      display: none;
      margin-top: 10px;
      padding: 10px;
      background: #1e1e24;
      border-radius: 6px;
      text-align: center;
      font-size: 13px;
    }
    .direct-link a {
      color: #60a5fa;
      text-decoration: none;
      font-weight: 600;
    }
    .direct-link a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div>
        <a href="https://driveflin.org">
          <img class="brand-logo" src="https://raw.githubusercontent.com/samucamg/DriveFlin/main/assets/DriveFlin.png" alt="DriveFlin">
        </a>
      </div>
      <div class="logo-text">🎬 Drive<span>Flin</span> Generator</div>
      <p class="subtitle">Gerador Seguro de Conexão Google Drive (OAuth 2.0)</p>
    </div>

    <div class="alert alert-warning">
      <span>💡</span>
      <div>
        <strong>100% Privado e Seguro:</strong> Este gerador roda no Cloudflare Workers em <code>generator.driveflin.org</code>. Suas credenciais são trocadas diretamente com os servidores da Google, sem intermediários.
      </div>
    </div>

    <!-- PASSO 1 -->
    <div class="card">
      <div class="step-title">
        <span class="step-badge">1</span>
        Credenciais do Google Cloud
      </div>

      <div class="alert alert-info" style="margin-bottom: 16px;">
        <span>ℹ️</span>
        <div style="font-size: 12px; line-height: 1.6;">
          <strong>Como obter no Google Cloud Console:</strong><br>
          1. Acesse <a href="https://console.cloud.google.com/apis/credentials" target="_blank" style="color: #bfdbfe; font-weight: 600;">Google Cloud Console → Credenciais ↗</a>.<br>
          2. Clique em <strong>+ CRIAR CREDENCIAIS → ID do cliente OAuth</strong>.<br>
          3. Em Tipo de aplicativo, escolha <strong>App para computador</strong> (Desktop) ou <strong>Aplicativo da Web</strong>.<br>
          <em>* Se escolher Aplicativo da Web, adicione <code>http://localhost</code> nas URIs de redirecionamento autorizados.</em>
        </div>
      </div>
      
      <div class="form-group">
        <label for="clientId">Client ID <span style="color: var(--accent);">*</span></label>
        <input type="text" id="clientId" placeholder="ex: 370045112228-xxxx.apps.googleusercontent.com" oninput="saveInputs(); updateDirectLink();">
      </div>

      <div class="form-group">
        <label for="clientSecret">Client Secret <span style="color: var(--accent);">*</span></label>
        <input type="text" id="clientSecret" placeholder="ex: GOCSPX-xxxxxxxxxxxxxxxxxxxxxxxx" oninput="saveInputs()">
      </div>

      <button class="btn btn-secondary" id="authBtn" onclick="handleAuthClick()">
        🔗 1. Abrir Autorização Google
      </button>

      <div id="directLinkBox" class="direct-link">
        👉 Janela bloqueada pelo navegador? <a id="directLinkAnchor" href="#" target="_blank" rel="noopener noreferrer">Clique aqui para abrir a autorização da Google</a>
      </div>

      <div id="authError" style="color: #f87171; font-size: 13px; margin-top: 10px; display: none;"></div>
    </div>

    <!-- PASSO 2 -->
    <div class="card" id="step2Card">
      <div class="step-title">
        <span class="step-badge">2</span>
        Código de Retorno da Google
      </div>

      <div class="form-group">
        <label for="authCode">Cole a URL completa ou o código retornado pela Google:</label>
        <input type="text" id="authCode" placeholder="http://localhost/?code=4/0Axxxx... ou 4/0Axxxx...">
        <div class="form-help">
          Após autorizar na Google, seu navegador mostrará uma página em branco ou erro de conexão no localhost (isto é normal). Copie o endereço completo da barra de endereços (URL) e cole acima.
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
      <a href="https://console.cloud.google.com/apis/credentials" target="_blank">Google Cloud Console ↗</a> &nbsp;•&nbsp; 
      <a href="https://github.com/samucamg/DriveFlin" target="_blank">GitHub ↗</a>
    </div>
  </div>

  <script>
    function getAuthUrl(cid) {
      return 'https://accounts.google.com/o/oauth2/auth'
        + '?client_id=' + encodeURIComponent(cid)
        + '&redirect_uri=' + encodeURIComponent('http://localhost')
        + '&response_type=code'
        + '&access_type=offline'
        + '&scope=' + encodeURIComponent('https://www.googleapis.com/auth/drive')
        + '&prompt=consent';
    }

    function updateDirectLink() {
      const cid = (document.getElementById('clientId').value || '').trim();
      const directBox = document.getElementById('directLinkBox');
      const directAnchor = document.getElementById('directLinkAnchor');
      if (cid) {
        const url = getAuthUrl(cid);
        directAnchor.href = url;
        directBox.style.display = 'block';
      } else {
        directBox.style.display = 'none';
      }
    }

    function handleAuthClick() {
      const cid = (document.getElementById('clientId').value || '').trim();
      const cs = (document.getElementById('clientSecret').value || '').trim();
      const err = document.getElementById('authError');

      if (!cid) {
        err.innerText = 'Preencha o Client ID antes de abrir a autorização.';
        err.style.display = 'block';
        return;
      }
      err.style.display = 'none';

      saveInputs();
      updateDirectLink();

      const authUrl = getAuthUrl(cid);
      const win = window.open(authUrl, '_blank');
      if (!win) {
        document.getElementById('directLinkBox').style.display = 'block';
      }
    }

    function saveInputs() {
      try {
        const cid = document.getElementById('clientId').value;
        const cs = document.getElementById('clientSecret').value;
        localStorage.setItem('df_cid', cid);
        localStorage.setItem('df_cs', cs);
      } catch (_) {}
    }

    function loadSavedInputs() {
      try {
        const cid = localStorage.getItem('df_cid');
        const cs = localStorage.getItem('df_cs');
        if (cid) document.getElementById('clientId').value = cid;
        if (cs) document.getElementById('clientSecret').value = cs;
        updateDirectLink();
      } catch (_) {}
    }

    async function exchangeToken() {
      const cid = (document.getElementById('clientId').value || '').trim();
      const cs = (document.getElementById('clientSecret').value || '').trim();
      const rawCode = (document.getElementById('authCode').value || '').trim();
      const err = document.getElementById('exchangeError');
      const btn = document.getElementById('exchangeBtn');
      const resultBox = document.getElementById('resultBox');

      err.style.display = 'none';
      resultBox.style.display = 'none';

      if (!cid || !cs || !rawCode) {
        err.innerText = 'Preencha todos os campos (Client ID, Client Secret e o Código de Retorno).';
        err.style.display = 'block';
        return;
      }

      let code = rawCode;
      if (code.includes('code=')) {
        try {
          const parsed = new URL(code.startsWith('http') ? code : 'http://' + code);
          const extracted = parsed.searchParams.get('code');
          if (extracted) code = extracted;
        } catch (_) {
          const m = code.match(/code=([^&]+)/);
          if (m) code = decodeURIComponent(m[1]);
        }
      }

      btn.disabled = true;
      btn.innerText = 'Trocando código com a Google...';

      try {
        const res = await fetch('/api/oauth/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            code: code, 
            clientId: cid, 
            clientSecret: cs,
            redirectUri: 'http://localhost'
          })
        });
        const data = await res.json();

        if (!data.success) {
          let msg = data.error || 'Falha ao trocar código com o Google.';
          if (data.details && data.details.error === 'invalid_grant') {
            msg = 'Código expirado ou inválido (invalid_grant). Gere um novo código clicando em "1. Abrir Autorização Google".';
          } else if (data.details && data.details.error === 'redirect_uri_mismatch') {
            msg = 'Erro redirect_uri_mismatch. Certifique-se de que a credencial no Google Cloud foi criada como "App para computador" ou adicione "http://localhost" nas URIs autorizadas de seu Aplicativo da Web.';
          } else if (data.details && data.details.error === 'invalid_client') {
            msg = 'Client ID ou Client Secret incorretos (invalid_client). Verifique se digitou corretamente.';
          }
          throw new Error(msg);
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

    window.addEventListener('DOMContentLoaded', () => {
      loadSavedInputs();
    });
  </script>
</body>
</html>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // API: Exchange code for refresh token
    if (url.pathname === '/api/oauth/exchange' && request.method === 'POST') {
      try {
        const body = await request.json();
        let code = (body.code || '').trim();
        const clientId = (body.clientId || '').trim();
        const clientSecret = (body.clientSecret || '').trim();
        const redirectUri = (body.redirectUri || 'http://localhost').trim();

        if (!code || !clientId || !clientSecret) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Campos obrigatórios ausentes: code, clientId ou clientSecret.'
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        // Handle case where user pasted full URL (e.g. http://localhost/?code=4/0A...)
        if (code.includes('code=')) {
          try {
            const parsed = new URL(code.startsWith('http') ? code : 'http://' + code);
            const extracted = parsed.searchParams.get('code');
            if (extracted) code = extracted;
          } catch (_) {
            const m = code.match(/code=([^&]+)/);
            if (m) code = decodeURIComponent(m[1]);
          }
        }

        // Exchange with Google
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code: code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
          }),
        });

        const tokenData = await tokenRes.json();

        if (!tokenRes.ok || tokenData.error) {
          return new Response(JSON.stringify({
            success: false,
            error: tokenData.error_description || tokenData.error || 'Falha ao trocar código com o Google.',
            details: tokenData
          }), {
            status: tokenRes.status || 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        return new Response(JSON.stringify({
          success: true,
          refresh_token: tokenData.refresh_token,
          access_token: tokenData.access_token,
          expires_in: tokenData.expires_in,
          token_type: tokenData.token_type,
          scope: tokenData.scope,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (err) {
        return new Response(JSON.stringify({
          success: false,
          error: err.message || 'Erro interno no gerador.'
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    // Default: Serve the HTML page
    return new Response(htmlContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        ...corsHeaders
      }
    });
  }
};
