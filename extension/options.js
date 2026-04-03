// ─── Estado local ─────────────────────────────────────────────────────────────
/*
  Config em memória - espelho do que está salvo no storage.
  Toda alteração atualiza aqui E salva no storage.
  Os valores abaixo são os padrões (sobrescritos ao carregar).
*/
let config = {
  modo:               "python",
  sites_bloqueados:   ["x.com", "twitter.com"],
  duracao_acesso_min: 60,
  max_paginas_secao:  25,
  margem_paginas_secao: 5,
  min_paginas_secao: 10
};

// ─── IndexedDB ─────────────────────────────────────────────────────────────────
const BookDB = {
  _db: null,
  async abrir() {
    if (this._db) return this._db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("anti_twitter_books", 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore("livros", { keyPath: "id" });
      req.onsuccess = e => { this._db = e.target.result; resolve(this._db); };
      req.onerror   = ()  => reject(req.error);
    });
  },
  async salvar(id, nome, formato, dados) {
    const db = await this.abrir();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("livros", "readwrite");
      tx.objectStore("livros").put({ id, nome, formato, dados });
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
  },
  async listar() {
    const db = await this.abrir();
    return new Promise((resolve, reject) => {
      const req = db.transaction("livros", "readonly").objectStore("livros").getAll();
      req.onsuccess = () => resolve(req.result.map(({ id, nome, formato }) => ({ id, nome, formato })));
      req.onerror   = () => reject(req.error);
    });
  },
  async deletar(id) {
    const db = await this.abrir();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("livros", "readwrite");
      tx.objectStore("livros").delete(id);
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
  }
};

// ─── Toast ────────────────────────────────────────────────────────────────────

/**
 * Exibe uma notificação temporária na parte inferior da tela.
 * @param {string} msg
 */
function mostrarToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.add("visivel");
  setTimeout(() => toast.classList.remove("visivel"), 2200);
}

// ─── Config ───────────────────────────────────────────────────────────────────

// Salva o estado atual de `config` no storage e notifica o background.
async function salvarConfig() {
  await browser.storage.local.set({ config });
  await browser.runtime.sendMessage({ action: "save_config", config });
}

async function carregarConfig() {
  const resultado = await browser.storage.local.get("config");
  if (resultado.config) {
    config = { ...config, ...resultado.config };
  }
}

// ─── Modo de operação ─────────────────────────────────────────────────────────

/**
 * Ativa um modo e atualiza a interface.
 * @param {"js"|"python"} modo
 */
function selecionarModo(modo) {
  config.modo = modo;

  document.getElementById("opcaoJS").classList.toggle("ativo", modo === "js");
  document.getElementById("opcaoPython").classList.toggle("ativo", modo === "python");

  // Card de livros só é relevante no modo JS
  document.getElementById("cardLivros").style.display = modo === "js" ? "block" : "none";

  salvarConfig(); // fire-and-forget — não precisamos aguardar
  mostrarToast(`Modo ${modo === "js" ? "JS" : "Python"} ativado`);
}

// ─── Configurações gerais ─────────────────────────────────────────────────────

function salvarConfigGeral() {
  const duracao = Number(document.getElementById("duracaoAcesso").value);
  const maxPaginasSecao = Number(document.getElementById("maxPaginasSecao").value);
  const margemPaginasSecao = Number(document.getElementById("margemPaginasSecao").value);
  const minPaginasSecao = Number(document.getElementById("minPaginasSecao").value);

  // Validação de intervalo antes de salvar
  if (duracao < 5 || duracao > 480) {
    mostrarToast("Duração deve ser entre 5 e 480 minutos");
    return;
  }
  if (maxPaginasSecao < 5 || maxPaginasSecao > 200) {
    mostrarToast("Máx. por seção deve ser entre 5 e 200 páginas");
    return;
  }
  if (margemPaginasSecao < 0 || margemPaginasSecao > 30) {
    mostrarToast("Margem deve ser entre 0 e 30 páginas");
    return;
  }
  if (minPaginasSecao < 1 || minPaginasSecao > 50) {
    mostrarToast("Mín. por seção deve ser entre 1 e 50 páginas");
    return;
  }
  if (minPaginasSecao > maxPaginasSecao + margemPaginasSecao) {
    mostrarToast("Mín. por seção não pode passar do limite máximo com margem");
    return;
  }

  config.duracao_acesso_min = duracao;
  config.max_paginas_secao = maxPaginasSecao;
  config.margem_paginas_secao = margemPaginasSecao;
  config.min_paginas_secao = minPaginasSecao;
  salvarConfig();
  mostrarToast("Configurações salvas!");
}

// ─── Sites bloqueados ─────────────────────────────────────────────────────────

// Re-renderiza a lista de sites a partir do estado atual de `config`.
function renderizarSites() {
  const lista = document.getElementById("listaSites");
  lista.innerHTML = ""; // limpa tudo

  if (config.sites_bloqueados.length === 0) {
    lista.innerHTML = '<li style="color:#888;font-size:.85rem;">Nenhum site bloqueado</li>';
    return;
  }

  config.sites_bloqueados.forEach(site => {
    const li = document.createElement("li");
    const texto = document.createElement("span");
    const botao = document.createElement("button");

    texto.textContent = site;
    botao.className = "btn-remover";
    botao.type = "button";
    botao.textContent = "Remover";
    botao.addEventListener("click", () => removerSite(site));

    li.appendChild(texto);
    li.appendChild(botao);
    lista.appendChild(li);
  });
}

function adicionarSite() {
  let site = document.getElementById("novoSite").value.trim().toLowerCase();
  site = site
    .replace(/^https?:\/\//, "") // remove "https://"
    .replace(/\/.*$/, "");        // remove tudo após a primeira barra

  // Validações: não vazio e não duplicado
  if (!site) { mostrarToast("Digite um domínio válido"); return; }
  if (config.sites_bloqueados.includes(site)) { mostrarToast("Site já está na lista"); return; }

  config.sites_bloqueados.push(site);
  document.getElementById("novoSite").value = "";

  salvarConfig();
  renderizarSites();
  mostrarToast(`${site} adicionado`);
}

function removerSite(site) {
  config.sites_bloqueados = config.sites_bloqueados.filter(s => s !== site);
  salvarConfig();
  renderizarSites();
  mostrarToast(`${site} removido`);
}

// Enter no campo de novo site também dispara adicionarSite
document.getElementById("novoSite").addEventListener("keydown", e => {
  if (e.key === "Enter") adicionarSite();
});

// ─── Livros (modo JS) ─────────────────────────────────────────────────────────

async function renderizarLivros() {
  const lista  = document.getElementById("listaLivros");
  const livros = await BookDB.listar();
  lista.innerHTML = "";

  if (livros.length === 0) {
    lista.innerHTML = '<li style="color:#888;font-size:.85rem;">Nenhum livro adicionado</li>';
    return;
  }

  livros.forEach(livro => {
    const li = document.createElement("li");
    const conteudo = document.createElement("span");
    const formato = document.createElement("span");
    const botao = document.createElement("button");

    conteudo.textContent = livro.nome;
    formato.className = "label-formato";
    formato.textContent = livro.formato;
    conteudo.appendChild(document.createTextNode(" "));
    conteudo.appendChild(formato);

    botao.className = "btn-remover";
    botao.type = "button";
    botao.textContent = "Remover";
    botao.addEventListener("click", () => {
      deletarLivro(livro.id);
    });

    li.appendChild(conteudo);
    li.appendChild(botao);
    lista.appendChild(li);
  });
}

async function deletarLivro(id) {
  await BookDB.deletar(id);
  await renderizarLivros();
  mostrarToast("Livro removido");
}

document.getElementById("uploadLivros").addEventListener("change", async e => {
  const arquivos = Array.from(e.target.files);
  for (const arq of arquivos) {
    const buf  = await arq.arrayBuffer();
    const fmt  = arq.name.endsWith(".epub") ? "epub" : "pdf";
    const id   = `livro_${Date.now()}_${arq.name}`;
    const nome = arq.name.replace(/\.(epub|pdf)$/i, "");
    await BookDB.salvar(id, nome, fmt, buf);
  }
  await renderizarLivros();
  mostrarToast(`${arquivos.length} livro(s) adicionado(s)`);
  e.target.value = "";
});

// ─── Analytics ────────────────────────────────────────────────────────────────

// Carrega e exibe o resumo de analytics.
async function carregarAnalytics() {
  const resumo = await Analytics.resumo();
  if (!resumo) {
    document.getElementById("statTentativas").textContent = "0";
    return;
  }

  document.getElementById("statTentativas").textContent = resumo.total_tentativas;
  document.getElementById("statTaxa").textContent       = `${resumo.taxa_conclusao}%`;
  document.getElementById("statPico").textContent       = `${resumo.hora_pico}h`;
  document.getElementById("statHumor").textContent      =
    resumo.humor_medio !== null ? `${resumo.humor_medio}/5` : "—";
}

// Gera e baixa o CSV de analytics.
async function exportarCSV() {
  const csv = await Analytics.exportarCSV();
  if (!csv) { mostrarToast("Sem dados para exportar"); return; }

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href     = url;
  link.download = `anti_twitter_${new Date().toISOString().slice(0, 10)}.csv`;

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  URL.revokeObjectURL(url); // libera a memória do Blob
  mostrarToast("CSV exportado!");
}

async function limparDados() {  
  if (!confirm("Limpar todos os dados de analytics? Essa ação não pode ser desfeita.")) return;
  await Analytics.limpar();
  await carregarAnalytics();
  mostrarToast("Dados limpos");
}

async function voltarAoGate() {
  const gateUrl = browser.runtime.getURL("gate.html");
  const abasGate = await browser.tabs.query({ url: `${gateUrl}*` });

  if (abasGate.length > 0) {
    const abaGate = abasGate[0];
    await browser.tabs.update(abaGate.id, { active: true });
    await browser.windows.update(abaGate.windowId, { focused: true });
  } else {
    await browser.tabs.create({ url: gateUrl });
  }

  const abaAtual = await browser.tabs.getCurrent();
  if (abaAtual?.id) {
    await browser.tabs.remove(abaAtual.id);
  }
}

// ─── Inicialização ────────────────────────────────────────────────────────────

(async function init() {
  await carregarConfig();

  // Aplica modo salvo na interface
  document.getElementById("opcaoJS").classList.toggle("ativo", config.modo === "js");
  document.getElementById("opcaoPython").classList.toggle("ativo", config.modo === "python");
  document.getElementById("cardLivros").style.display =
    config.modo === "js" ? "block" : "none";
  document.getElementById("duracaoAcesso").value = config.duracao_acesso_min;
  document.getElementById("maxPaginasSecao").value = config.max_paginas_secao;
  document.getElementById("margemPaginasSecao").value = config.margem_paginas_secao;
  document.getElementById("minPaginasSecao").value = config.min_paginas_secao;

  renderizarSites();
  await renderizarLivros();
  await carregarAnalytics();

  // ─── Event listeners ──────────────────────────────────────────────────────────
  document.getElementById("opcaoJS").addEventListener("click", () => selecionarModo("js"));
  document.getElementById("opcaoPython").addEventListener("click", () => selecionarModo("python"));
  document.getElementById("btnSalvarGeral").addEventListener("click", salvarConfigGeral);
  document.getElementById("btnAdicionarSite").addEventListener("click", adicionarSite);
  document.getElementById("btnExportarCSV").addEventListener("click", exportarCSV);
  document.getElementById("btnLimparDados").addEventListener("click", limparDados);
  document.getElementById("btnVoltarGate").addEventListener("click", voltarAoGate);
})();
