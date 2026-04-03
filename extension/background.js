/**
 * background.js — Coração da extensão
 *
 * Responsabilidades:
 * 1. Ler as configurações do usuário (sites bloqueados, modo ativo)
 * 2. Interceptar navegação para esses sites
 * 3. Verificar se o acesso está liberado (modo JS ou Python)
 * 4. Redirecionar para gate.html se não estiver
 * 5. Registrar tentativas no analytics
 * 6. Repassar mensagens do gate.js para o app.py (modo Python)
 *
 * CONCEITO: Este script roda numa página de fundo invisível e persiste enquanto
 * o navegador estiver aberto. É o equivalente a um servidor local leve.
 */

const GATE_URL = browser.runtime.getURL("gate.html");
// ─── Configurações padrão ───────────────────────────────────────────────────
 
const CONFIG_PADRAO = {
  modo: "python",       // "python" ou "js"
  sites_bloqueados: [   // lista de domínios a bloquear
    "x.com",
    "twitter.com"
  ],
  duracao_acesso_min: 60  // minutos de acesso após completar a meta
};
 
// Cache em memória das configs (evita await em toda interceptação)
let config = { ...CONFIG_PADRAO };
 
/**
 * Carrega as configurações do storage e atualiza o cache em memória.
 * CONCEITO: `async/await` é como `asyncio` em Python - pausa até a operação I/O completar.
 */
async function carregarConfig() {
  const resultado = await browser.storage.local.get("config");
  config = { ...CONFIG_PADRAO, ...(resultado.config || {}) };
  console.log("[anti-twitter] Config carregada:", config);
}


// ─── Verificação de acesso ──────────────────────────────────────────────────
 
/**
 * Verifica se o acesso está liberado conforme o modo atual.
 * Retorna true se liberado, false se bloqueado.
 */
async function verificarAcesso() {
  if (config.modo === "js") {
    // Modo JS: lê o estado diretamente do storage local
    const resultado = await browser.storage.local.get("estado_js");
    const estado = resultado.estado_js || {};
    if (!estado.liberado_ate) return false;
    return Date.now() < estado.liberado_ate;
 
  } else {
    // Modo Python: pergunta ao app.py via native messaging
    try {
      const resposta = await browser.runtime.sendNativeMessage(
        "reader_gate_host",
        { action: "status" }
      );
      return resposta.ok && resposta.allowed;
    } catch (err) {
      console.error("[anti-twitter] Erro no native messaging:", err);
      return false; // Em caso de erro, bloqueia por segurança
    }
  }
}

// ─── Interceptação de navegação ─────────────────────────────────────────────
 
/**
 * Verifica se uma URL pertence a um dos sites bloqueados.
 *
 * CONCEITO: `some()` é como `any()` em Python — retorna true se ALGUM item satisfaz a condição.
 */
function ehSiteBloqueado(url) {
  try {
    const hostname = new URL(url).hostname; // extrai "x.com" de "https://x.com/home"
    return config.sites_bloqueados.some(site =>
      hostname === site || hostname.endsWith("." + site)
    );
  } catch {
    return false;
  }
}
 
/**
 * Ouve quando uma aba começa a carregar e intercepta se for um site bloqueado.
 *
 * CONCEITO: `addListener` é como `signal.connect()` em Qt ou `@event` em outros frameworks.
 * Registra uma função que será chamada automaticamente quando o evento ocorrer.
 */
browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Só nos interessa quando a URL muda (início de navegação)
  if (changeInfo.status !== "loading") return;
 
  const url = changeInfo.url || tab.url;
  if (!url || url.startsWith(GATE_URL)) return; // evita loop infinito
 
  if (!ehSiteBloqueado(url)) return;
 
  // Registra a tentativa de acesso ANTES de verificar se está liberado
  await Analytics.registrar({
    evento: "tentativa",
    site:   new URL(url).hostname,
    modo:   config.modo
  });
 
  const liberado = await verificarAcesso();
 
  if (!liberado) {
    // Redireciona para o gate, passando a URL de destino como parâmetro
    const urlGate = `${GATE_URL}?target=${encodeURIComponent(url)}`;
    browser.tabs.update(tabId, { url: urlGate });
  }
});

// ─── Mensagens do gate.js ───────────────────────────────────────────────────
 
/**
 * Recebe mensagens enviadas pelo gate.js e as processa.
 *
 * Em modo Python: repassa para o app.py via native messaging.
 * Em modo JS: processa localmente sem sair do browser.
 *
 * CONCEITO: `return true` no final é obrigatório quando a resposta é assíncrona.
 * Diz ao Firefox "aguarda, vou responder depois" — sem isso a conexão fecha.
 */

browser.runtime.onMessage.addListener((mensagem, sender, enviarResposta) => {
  processarMensagem(mensagem)
    .then(enviarResposta)
    .catch(err => enviarResposta({ ok: false, error: String(err) }));
  return true; // mantém o canal aberto para resposta assíncrona
});

async function processarMensagem(mensagem) {
  const { action } = mensagem;
 
  // Mensagens de configuração são sempre processadas localmente
  if (action === "get_config") {
    return { ok: true, config };
  }
 
  if (action === "save_config") {
    config = { ...CONFIG_PADRAO, ...mensagem.config };
    await browser.storage.local.set({ config });
    return { ok: true };
  }
 
  // Em modo JS, processa o estado localmente
  if (config.modo === "js") {
    return processarModoJS(mensagem);
  }
 
  // Em modo Python, repassa para o app.py
  try {
    return await browser.runtime.sendNativeMessage("reader_gate_host", mensagem);
  } catch (err) {
    return { ok: false, error: `Native messaging falhou: ${err.message}` };
  }
}

// ─── Estado modo JS ─────────────────────────────────────────────────────────
 
/**
 * Processa ações de estado quando em modo JS (sem Python).
 * Replica a lógica do app.py, mas usando browser.storage.local.
 */
async function processarModoJS(mensagem) {
  const resultado = await browser.storage.local.get("estado_js");
  const estado = resultado.estado_js || { liberado_ate: null, sessao_atual: null };
  const { action } = mensagem;
 
  if (action === "status") {
    let liberado = false;
    let restante = 0;
    if (estado.liberado_ate && Date.now() < estado.liberado_ate) {
      liberado = true;
      restante = (estado.liberado_ate - Date.now()) / 60000;
    } else if (estado.liberado_ate) {
      // Acesso expirou - limpa
      estado.liberado_ate = null;
      await browser.storage.local.set({ estado_js: estado });
    }
    return {
      ok: true,
      allowed: liberado,
      remaining_minutes: Math.round(restante * 10) / 10,
      current_session: estado.sessao_atual
    };
  }
 
  if (action === "list_books") {
    // Busca metadados dos livros do IndexedDB via mensagem especial
    // (o IndexedDB não é acessível no background, então o gate.js faz isso direto)
    return { ok: true, books: [], js_mode: true };
  }
 
  if (action === "start_session") {
    estado.sessao_atual = {
      book_id:    mensagem.book_id,
      book_title: mensagem.book_title || mensagem.book_id,
      mode:       mensagem.mode,
      amount:     mensagem.amount
    };
    estado.liberado_ate = null;
    await browser.storage.local.set({ estado_js: estado, meta_atingida: false });
    return { ok: true };
  }
 
  if (action === "complete_session") {
    if (!estado.sessao_atual) {
      return { ok: false, error: "Nenhuma sessão ativa" };
    }
    const duracao = (config.duracao_acesso_min || 60) * 60 * 1000;
    estado.liberado_ate = Date.now() + duracao;
    estado.sessao_atual = null;
    await browser.storage.local.set({ estado_js: estado, meta_atingida: false });
 
    // Registra no analytics
    await Analytics.registrar({
      evento: "sessao_concluida",
      modo:   "js"
    });
 
    return { ok: true, access_granted_minutes: config.duracao_acesso_min || 60 };
  }
 
  return { ok: false, error: `Ação desconhecida: ${action}` };
}
 
// ─── Inicialização ───────────────────────────────────────────────────────────
 
// Recarrega config quando storage muda (ex: usuário alterou options)
browser.storage.onChanged.addListener((changes) => {
  if (changes.config) {
    config = { ...config, ...(changes.config.newValue || {}) };
    console.log("[anti-twitter] Config atualizada:", config);
  }
});
 
// Carrega config na inicialização
carregarConfig();
console.log("[anti-twitter] background.js carregado");
