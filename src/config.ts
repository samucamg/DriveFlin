// Persistência das variáveis de instalação no Cloudflare KV (binding DRIVEFLIN_CONFIG).
//
// Problema: os campos do [vars] do wrangler.toml (GDRIVE_CLIENT_ID etc.) aparecem na tela
// de instalação da Cloudflare, mas a cada commit/redeploy pelo Git eles voltam ao valor
// do wrangler.toml (vazio) e a configuração se perde.
//
// Solução (mesmo modelo do veroroute-edge): o cliente preenche os campos UMA vez na
// instalação (ou em Settings > Variables and Secrets). Na primeira requisição o Worker
// grava esses valores no KV. Depois de um redeploy, quando a variável chega vazia, o
// valor salvo no KV é usado. Se o cliente preencher um valor novo, ele substitui o salvo.
//
//   variável preenchida  →  vale ela (e é salva no KV)
//   variável vazia       →  vale o que está no KV

export const KV_CONFIG_KEY = "config";
const CACHE_TTL_MS = 5000;

/** Variáveis que sobrevivem a redeploys. ADMIN_PASSWORD não entra: a senha já fica no D1 (com hash). */
export const PERSISTED_VARS = [
  "GDRIVE_CLIENT_ID",
  "GDRIVE_CLIENT_SECRET",
  "GDRIVE_REFRESH_TOKEN",
  "GDRIVE_TEAM_DRIVE_ID",
  "TMDB_API_KEY",
  "RCLONE_PASS",
  "RCLONE_SALT",
] as const;

type Stored = Partial<Record<(typeof PERSISTED_VARS)[number], string>> & { updatedAt?: string };

let cache: { value: Stored; exp: number } | null = null;

function hasKV(env: any): boolean {
  return !!env?.DRIVEFLIN_CONFIG && typeof env.DRIVEFLIN_CONFIG.get === "function";
}

async function readStored(env: any): Promise<Stored> {
  if (cache && Date.now() < cache.exp) return cache.value;
  let value: Stored = {};
  try {
    const raw = await env.DRIVEFLIN_CONFIG.get(KV_CONFIG_KEY);
    if (raw) value = JSON.parse(raw) as Stored;
  } catch (e) {
    console.error("[config] falha ao ler o KV:", (e as any)?.message || e);
    if (cache) return cache.value; // erro transitório: mantém o último valor bom
  }
  cache = { value, exp: Date.now() + CACHE_TTL_MS };
  return value;
}

/**
 * Devolve o env efetivo e, se houver variável preenchida diferente do que está no KV,
 * grava no KV em segundo plano (ctx.waitUntil) sem atrasar a resposta.
 */
export async function withPersistedVars<T extends Record<string, any>>(env: T, ctx?: { waitUntil?: (p: Promise<any>) => void }): Promise<T> {
  if (!hasKV(env)) return env;
  const stored = await readStored(env);
  const eff: any = { ...env };
  const next: Stored = { ...stored };
  let changed = false;

  for (const name of PERSISTED_VARS) {
    const fromEnv = String((env as any)[name] ?? "").trim();
    const fromKv = String(stored[name] ?? "").trim();
    if (fromEnv) {
      if (fromEnv !== fromKv) {
        next[name] = fromEnv;
        changed = true;
      }
    } else if (fromKv) {
      eff[name] = fromKv;
    }
  }

  if (changed) {
    next.updatedAt = new Date().toISOString();
    cache = { value: next, exp: Date.now() + CACHE_TTL_MS };
    const write = env.DRIVEFLIN_CONFIG.put(KV_CONFIG_KEY, JSON.stringify(next)).catch((e: any) => {
      console.error("[config] falha ao gravar no KV:", e?.message || e);
      cache = null;
    });
    if (ctx?.waitUntil) ctx.waitUntil(write);
    else await write;
  }
  return eff;
}
