/**
 * gate.js — Lógica da página de bloqueio
 *
 * Funções precisam ser globais para serem chamadas pelos event listeners
 * registrados no DOMContentLoaded. Isso é padrão em extensões MV2 sem
 * bundler — não usamos módulos ES6 por restrições de CSP.
 */

// ─── Estado da página ────────────────────────────────────────────────────────

let modoAtual          = "python";
let humorSelecionado   = null;    
let energiaSelecionada = null;

/**
 * Extrai a URL de destino dos parâmetros da página.
 * @returns {string} URL do site que o usuário queria acessar
 */
function pegarUrlAlvo() {
  const params = new URLSearchParams(window.location.search);
  return params.get("target") || "https://x.com/";
}

// ─── IndexedDB para livros (Modo JS) ─────────────────────────────────────────

/*
  Em vez de espalhar funções soltas, agrupamos tudo relacionado
  ao banco de livros num objeto `BookDB`.
  É o equivalente a uma classe estática em Python — não criamos
  instâncias, só chamamos BookDB.abrir(), BookDB.salvar() etc.
*/


//BookDB — interface com o IndexedDB para armazenar livros.
const BookDB = {
  _db: null, // cache da conexão aberta

  async abrir() {
    if (this._db) return this._db; // retorna conexão cacheada

    return new Promise((resolve, reject) => {
      const req = indexedDB.open("anti_twitter_books", 1);

      req.onupgradeneeded = (e) => {
        // Cria a "tabela" de livros se ainda não existe
        e.target.result.createObjectStore("livros", { keyPath: "id" });
      };

      req.onsuccess = (e) => {
        this._db = e.target.result;
        resolve(this._db);
      };

      req.onerror = () => reject(req.error);
    });
  },

  /**
   * Salva um livro no banco.
   *
   * @param {string} id          - Identificador único
   * @param {string} nome        - Nome do livro (sem extensão)
   * @param {string} formato     - "epub" ou "pdf"
   * @param {ArrayBuffer} dados  - Bytes do arquivo
   */
  async salvar(id, nome, formato, dados) {
    const db = await this.abrir();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("livros", "readwrite");
      tx.objectStore("livros").put({ id, nome, formato, dados });
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
  },

  /**
   * Lista todos os livros (só metadados, sem o binário).
   * @returns {Promise<Array<{id, nome, formato}>>}
   */
  async listar() {
    const db = await this.abrir();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction("livros", "readonly");
      const req = tx.objectStore("livros").getAll();
      req.onsuccess = () => resolve(
        // Desestruturação: extrai só os campos que precisamos
        req.result.map(({ id, nome, formato }) => ({ id, nome, formato }))
      );
      req.onerror = () => reject(req.error);
    });
  },

  /**
   * Remove um livro pelo id.
   * @param {string} id
   */
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

// ─── Bookmark ─────────────────────────────────────────────────────────────────
 
/**
 * Carrega o bookmark salvo para um livro.
 * Retorna o número da última página lida, ou 1 se não houver bookmark.
 * @param {string} bookId
 * @returns {Promise<number>}
 */
async function carregarBookmark(bookId) {
  const resultado = await browser.storage.local.get("bookmarks");
  return resultado.bookmarks?.[bookId]?.pagina || 1;
}

// ─── Comunicação com o background.js ─────────────────────────────────────────

/**
 * Envia uma mensagem para o background.js e aguarda resposta.
 * @param {Object} mensagem - Objeto com pelo menos `{ action: string }`
 * @returns {Promise<Object>} - Resposta do background
 */
async function callNative(mensagem) {
  try {
    return await browser.runtime.sendMessage(mensagem);
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ─── Helpers de UI ────────────────────────────────────────────────────────────

/**
 * Atualiza o elemento #status com texto e classe visual.
 * @param {string} texto - Mensagem a exibir
 * @param {string} tipo  - "ok" | "erro" | "info" | ""
 */
function mostrarStatus(texto, tipo = "") {
  const el   = document.getElementById("status");
  el.textContent = texto;
  el.className   = tipo;
}

/**
 * Marca um botão de escala como selecionado e salva o valor.
 * @param {"humor"|"energia"} tipo
 * @param {number} valor - 1 a 5
 */
function selecionarEscala(tipo, valor) {
  if (tipo === "humor")   humorSelecionado   = valor;
  if (tipo === "energia") energiaSelecionada = valor;

  // Capitaliza a primeira letra para montar o id do container
  // "humor" → "Humor", "energia" → "Energia"
  const idContainer = `escala${tipo.charAt(0).toUpperCase() + tipo.slice(1)}`;

  document.querySelectorAll(`#${idContainer} .escala-btn`).forEach(btn => {
    btn.classList.toggle("selecionado", Number(btn.dataset.valor) === valor);
  });
}

/**
 * Troca o modo ativo (JS ou Python) e atualiza toda a interface.
 * @param {"js"|"python"} modo
 */
function trocarModo(modo) {
  modoAtual = modo;

  // Atualiza as abas visuais
  document.getElementById("tabJS").classList.toggle("ativo", modo === "js");
  document.getElementById("tabPython").classList.toggle("ativo", modo === "python");

  document.querySelectorAll("[data-so-modo]").forEach(el => {
    el.classList.toggle("visivel", el.dataset.soModo === modo);
  });

  // Salva preferência
  callNative({ action: "save_config", config: { modo } });

  // Recarrega livros e status para o modo ativo
  carregarLivros();
  atualizarStatus();
}

// ─── Carregamento de dados ────────────────────────────────────────────────────

/**
 * Popula o <select> de livros conforme o modo atual.
 *
 * Em vez de ter todas as <option> no HTML, criamos programaticamente:
 *   1. `document.createElement("option")` - cria o elemento
 *   2. `.value = ...` - define o valor interno (enviado ao servidor / ao handler)
 *   3. `.textContent = ...` - define o texto visível
 *   4. `select.appendChild(opt)` - insere no DOM
 *
 * É o equivalente a construir uma string HTML e injetar,
 * mas mais seguro (sem risco de XSS) e mais legível.
 */
async function carregarLivros() {
  if (modoAtual === "js") {
    const livros = await BookDB.listar();
    const select = document.getElementById("selectLivroJS");
    select.innerHTML = ""; // limpa opções anteriores
 
    if (livros.length === 0) {
      select.innerHTML = '<option value="">Nenhum livro - adicione um abaixo</option>';
      atualizarCampoPaginaInicial(null);
      return;
    }
 
    livros.forEach((livro, indice) => {
      const opt       = document.createElement("option");
      opt.value       = livro.id;
      opt.textContent = `${livro.nome} (${livro.formato})`;
      if (indice === 0) opt.selected = true; // pré-seleciona o primeiro
      select.appendChild(opt);
    });
 
    // Carrega bookmark do livro pré-selecionado
    if (livros.length > 0) {
      atualizarCampoPaginaInicial(livros[0].id);
    }
 
  } else {
    // Modo Python: pede a lista ao app.py via background.js
    const res    = await callNative({ action: "list_books" });
    const select = document.getElementById("selectLivroPython");
    select.innerHTML = "";
 
    if (!res.ok || !Array.isArray(res.books) || res.books.length === 0) {
      select.innerHTML = '<option value="">Nenhum livro em ~/livros</option>';
      return;
    }
 
    res.books.forEach((livro, indice) => {
      const opt       = document.createElement("option");
      opt.value       = livro.id;
      opt.textContent = `${livro.title} (${livro.format})`;
      if (livro.preselected || indice === 0) opt.selected = true;
      select.appendChild(opt);
    });
  }
}

/**
 * Carrega o bookmark de um livro e preenche o campo "Começar da página".
 * Se bookId for null, reseta o campo para 1.
 * @param {string|null} bookId
 */
async function atualizarCampoPaginaInicial(bookId) {
  const campo = document.getElementById("paginaInicial");
  if (!campo) return;
  if (!bookId) { campo.value = 1; return; }
 
  const pagina = await carregarBookmark(bookId);
  campo.value  = pagina;
 
  // Exibe uma dica se há progresso salvo
  const dica = document.getElementById("dicaBookmark");
  if (dica) {
    dica.textContent = pagina > 1 ? `↩ Continuando da p.${pagina}` : "";
  }
}

//Consulta o estado atual e atualiza o #status na tela.
async function atualizarStatus() {
  const res = await callNative({ action: "status" });

  if (!res.ok) {
    mostrarStatus(`Erro: ${res.error || "backend indisponível"}`, "erro");
    return;
  }

  if (res.allowed) {
    const mins = Math.round(res.remaining_minutes ?? 0);
    mostrarStatus(`✅ Acesso liberado! Expira em ${mins} min.`, "ok");

  } else if (res.current_session) {
    const s       = res.current_session;
    const tipoStr = s.mode === "pages" ? "página(s)" : "capítulo(s)";
    mostrarStatus(
      `📖 Sessão ativa: ${s.amount} ${tipoStr} de "${s.book_title || s.book_id}". Marque como concluído quando terminar.`,
      "info"
    );
  } else {
    mostrarStatus("❌ Acesso bloqueado. Inicie uma sessão de leitura.", "erro");
  }
}

// ─── Ações do usuário ─────────────────────────────────────────────────────────

//Inicia uma sessão de leitura.
async function iniciarSessao() {
  // Lê o livro selecionado conforme o modo
  let bookId, bookTitle;

  if (modoAtual === "js") {
    const select = document.getElementById("selectLivroJS");
    bookId    = select.value;
    bookTitle = select.options[select.selectedIndex]?.text || bookId;
  } else {
    const select = document.getElementById("selectLivroPython");
    bookId    = select.value;
    bookTitle = select.options[select.selectedIndex]?.text || bookId;
  }

  if (!bookId) {
    mostrarStatus("Selecione um livro antes de começar.", "erro");
    return; // early return — não executa o resto
  }

  const modo   = document.getElementById("tipoMeta").value;
  const amount = Number(document.getElementById("quantidadeMeta").value);
    // paginaInicial: onde a contagem começa. Vem do bookmark ou da entrada manual.
  const paginaInicial = Math.max(1, Number(document.getElementById("paginaInicial")?.value) || 1);

  // Registra no analytics ANTES de enviar ao background
  // Assim temos o registro mesmo se o background falhar
  await Analytics.registrar({
    evento:          "sessao_iniciada",
    modo:            modoAtual,
    livro:           bookTitle,
    tipo_meta:       modo === "pages" ? "paginas" : "capitulos",
    quantidade_meta: amount,
    humor:           humorSelecionado,   // null se não selecionado — ok
    energia:         energiaSelecionada
  });

  const res = await callNative({
    action:     "start_session",
    book_id:    bookId,
    book_title: bookTitle,
    mode:       modo,
    amount
  });

  if (res.ok) {
    const tipoStr = modo === "pages" ? "página(s)" : "capítulo(s)";
    mostrarStatus(
      `📖 Sessão iniciada: leia ${amount} ${tipoStr} e clique em "Marcar como concluído".`,
      "info"
    );

    // No modo JS, abre o leitor inline numa nova aba
    if (modoAtual === "js") {
      const readerUrl = browser.runtime.getURL(
        `reader.html?book=${encodeURIComponent(bookId)}&modo=${modo}&amount=${amount}&pagina=${paginaInicial}`
      );
      browser.tabs.create({ url: readerUrl });
    }
    // No modo Python, o app.py já abriu o leitor externo via xdg-open

  } else {
    mostrarStatus(`Erro ao iniciar: ${res.error || "desconhecido"}`, "erro");
  }
}

/**
 * Marca a sessão atual como concluída e libera o acesso.
 */
async function concluirSessao() {
  const res = await callNative({ action: "complete_session" });

  if (res.ok) {
    mostrarStatus("✅ Meta concluída! Acesso liberado.", "ok");
    await Analytics.registrar({
      evento: "sessao_concluida",
      modo:   modoAtual
    });
  } else {
    mostrarStatus(`Erro: ${res.error || "desconhecido"}`, "erro");
  }

  // Atualiza o status para mostrar o tempo restante
  await atualizarStatus();
}

//Redireciona para o site alvo se o acesso estiver liberado.
async function entrarNoSite() {
  const res = await callNative({ action: "status" });

  if (res.ok && res.allowed) {
    await Analytics.registrar({ evento: "acesso_liberado", modo: modoAtual });
    window.location.href = pegarUrlAlvo();
    return;
  }

  mostrarStatus("❌ Ainda bloqueado. Conclua a meta de leitura primeiro.", "erro");
}

// ─── Inicialização ────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {

  // Mostra o domínio alvo na interface
  const alvo = pegarUrlAlvo();
  try {
    document.getElementById("destinoInfo").textContent =
      `Destino: ${new URL(alvo).hostname}`;
  } catch {
    document.getElementById("destinoInfo").textContent = `Destino: ${alvo}`;
  }

  // Carrega a configuração salva para saber qual modo estava ativo
  const resConfig = await callNative({ action: "get_config" });
  const modo      = resConfig.config?.modo || "python";

  modoAtual = modo;
  document.getElementById(`tab${modo === "js" ? "JS" : "Python"}`).classList.add("ativo");
  document.querySelectorAll("[data-so-modo]").forEach(el => {
    el.classList.toggle("visivel", el.dataset.soModo === modo);
  });

  await carregarLivros();
  await atualizarStatus();

  // Rodapé com link para configurações e modo atual
  document.getElementById("rodape").innerHTML =
    `<a href="${browser.runtime.getURL("options.html")}" target="_blank">⚙️ Configurações</a>` +
    ` · Modo: ${modo === "js" ? "JS (sem Python)" : "Python"}`;

  // ─── Event listeners ─────────────────────────────────────────────────────────
  document.getElementById("tabJS").addEventListener("click",     () => trocarModo("js"));
  document.getElementById("tabPython").addEventListener("click", () => trocarModo("python"));
  document.getElementById("btnIniciar").addEventListener("click",  iniciarSessao);
  document.getElementById("btnConcluir").addEventListener("click", concluirSessao);
  document.getElementById("btnEntrar").addEventListener("click",   entrarNoSite);
 
  document.getElementById("inputArquivo").addEventListener("change", async evento => {
    const arquivos = Array.from(evento.target.files);
    mostrarStatus(`Adicionando ${arquivos.length} livro(s)…`, "info");
    for (const arquivo of arquivos) {
      const arrayBuffer = await arquivo.arrayBuffer();
      const formato     = arquivo.name.endsWith(".epub") ? "epub" : "pdf";
      const id          = `livro_${Date.now()}_${arquivo.name}`;
      const nome        = arquivo.name.replace(/\.(epub|pdf)$/i, "");
      await BookDB.salvar(id, nome, formato, arrayBuffer);
    }
    mostrarStatus(`✅ ${arquivos.length} livro(s) adicionado(s).`, "ok");
    await carregarLivros();
    evento.target.value = "";
  });
 
  // Quando o usuário troca o livro selecionado, atualiza o campo de página inicial
  document.getElementById("selectLivroJS").addEventListener("change", e => {
    atualizarCampoPaginaInicial(e.target.value || null);
  });
 
  document.querySelectorAll("#escalaHumor .escala-btn").forEach(btn => {
    btn.addEventListener("click", () => selecionarEscala("humor", Number(btn.dataset.valor)));
  });
  document.querySelectorAll("#escalaEnergia .escala-btn").forEach(btn => {
    btn.addEventListener("click", () => selecionarEscala("energia", Number(btn.dataset.valor)));
  });
});
