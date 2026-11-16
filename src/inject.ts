export const injectScript = `
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/prayag17/JellyFlix@latest/default.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/prayag17/JellyFlix@latest/addons/Logo.css">
<style>
  :root {
    --accent: #e50914 !important;
    --accent-hover: #b80710 !important;
    --primary-accent-color: #e50914 !important;
    --theme-primary-color: #e50914 !important;
  }
  .button-accent, .button-accent:hover, .emby-button.raised-accent, .paper-icon-button-light:hover {
    background-color: #e50914 !important;
    color: #ffffff !important;
  }
  .sliderBubble {
    background-color: #e50914 !important;
  }
  .mdl-slider-background-lower {
    background-color: #e50914 !important;
  }
  .cardContent {
    border-radius: 8px !important;
    overflow: hidden !important;
    transition: transform 0.25s ease, box-shadow 0.25s ease !important;
  }
  .card:hover .cardContent {
    transform: scale(1.04);
    box-shadow: 0 10px 25px rgba(0,0,0,0.8) !important;
  }
  .dashboardDocument {
    background-color: #141414 !important;
  }
  .navMenuOption-selected {
    border-left: 4px solid #e50914 !important;
    background: rgba(229, 9, 20, 0.15) !important;
  }
</style>
<script>
(function() {
  const origDateParse = Date.parse;
  Date.parse = function(str) {
    if (!str || str === 'undefined' || str === 'null') return Date.now();
    const val = origDateParse.apply(this, arguments);
    return isNaN(val) ? Date.now() : val;
  };

  const originalAlert = window.alert;
  window.alert = function(msg) {
    fetch('/debug_log', { method: 'POST', body: JSON.stringify({ type: 'alert', msg: msg, stack: new Error().stack }) });
    originalAlert.apply(this, arguments);
  };
  const originalError = console.error;
  console.error = function() {
    fetch('/debug_log', { method: 'POST', body: JSON.stringify({ type: 'error', args: Array.from(arguments).map(a => a ? a.toString() : 'null') }) });
    originalError.apply(this, arguments);
  };
  window.addEventListener('unhandledrejection', function(event) {
    fetch('/debug_log', { method: 'POST', body: JSON.stringify({ type: 'unhandledrejection', reason: event.reason ? event.reason.toString() : 'null', stack: event.reason ? event.reason.stack : '' }) });
  });
})();

  window.addEventListener('load', () => {
    setInterval(() => {
      const header = document.querySelector('.formDialogHeader');
      if (header && header.textContent.includes('Imagens') && !document.querySelector('#customUrlUploader')) {
        const btn = document.createElement('button');
        btn.id = 'customUrlUploader';
        btn.className = 'emby-button raised-accent';
        btn.style.margin = '10px';
        btn.textContent = 'Upload por URL (DriveFlin)';
        btn.onclick = async () => {
          const url = prompt('Digite a URL da imagem:');
          if (!url) return;
          // Extract item id from url hash or data attribute
          const match = window.location.hash.match(/id=([a-f0-9]+)/i) || window.location.hash.match(/\/([a-f0-9]{32})/i);
          let itemId = match ? match[1] : null;
          if (!itemId) {
              const el = document.querySelector('.formDialogContent');
              if (el) {
                  // Usually images dialog doesn't have data-itemid, it's in the URL
              }
          }
          if (itemId) {
            const res = await fetch('/Items/' + itemId + '/RemoteImages/Download?ImageUrl=' + encodeURIComponent(url) + '&Type=Primary', {
              method: 'POST',
              headers: {
                'X-Emby-Token': window.ApiClient.accessToken()
              }
            });
            if (res.ok) {
              alert('Imagem atualizada com sucesso!');
              window.location.reload();
            } else {
              alert('Erro: ' + res.status);
            }
          } else {
            alert('Não foi possível determinar o Item ID da URL.');
          }
        };
        const content = document.querySelector('.formDialogContent');
        if (content) {
          content.insertBefore(btn, content.firstChild);
        }
      }
    }, 1000);
  });

</script>
`;
