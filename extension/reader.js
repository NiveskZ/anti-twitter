// ─── Parâmetros da URL ────────────────────────────────────────────────────────

const params    = new URLSearchParams(window.location.search);
const bookId    = params.get("book");
const tipoMeta  = params.get("modo");    // "pages" ou "chapter"
const metaTotal = Number(params.get("amount")) || 1;
// paginaInicial: onde a contagem começa e onde o scroll inicia.
// Vem do bookmark salvo ou do campo manual no gate.html.
// Valor 1 significa "desde o início".
const paginaInicial = Math.max(1, Number(params.get("pagina")) || 1);

let progressoAtual = 0;
let indicadorContagemTimeout = null;

// ─── Utilitários ──────────────────────────────────────────────────────────────

/**
 * Carrega um script externo como uma Promise.
 * @param {string} url
 * @returns {Promise<void>}
 */
function carregarScript(url) {
  return new Promise((resolve, reject) => {
    const existente = document.querySelector(`script[src="${url}"]`);
    if (existente) {
      if (existente.dataset.carregado === "true") { resolve(); return; }
      existente.addEventListener("load",  resolve, { once: true });
      existente.addEventListener("error", () => reject(new Error(`Falha: ${url}`)), { once: true });
      return;
    }
    const s   = document.createElement("script");
    s.src     = url;
    s.onload  = () => { s.dataset.carregado = "true"; resolve(); };
    s.onerror = () => reject(new Error(`Falha: ${url}`));
    document.head.appendChild(s);
  });
}

/**
 * Atualiza barra de progresso e o botão da barra superior.
 * @param {number} atual
 * @param {number} total
 */
function atualizarProgresso(atual, total) {
  progressoAtual = Math.max(0, atual);
  const pct = Math.min(100, Math.round((progressoAtual / total) * 100));

  document.getElementById("textoProgresso").textContent = `${progressoAtual} / ${total}`;
  document.getElementById("fillProgresso").style.width  = pct + "%";

  const btn = document.getElementById("btnConcluirReader");
  if (progressoAtual >= total) {
    btn.disabled        = false;
    btn.textContent     = "✅ Meta atingida — concluir";
    btn.style.background = "#1b5e1b";
    // Sinaliza ao gate.js (via storage) que a meta foi cumprida
    browser.storage.local.set({ meta_atingida: true });
  } else {
    btn.disabled = true;
    btn.style.background = "#555";
    btn.textContent = `${progressoAtual} / ${total} ${tipoMeta === "chapter" ? "cap" : "pág"}`;
  }
}

/** Atualiza linha de detalhe abaixo do contador. */
function atualizarDetalhe(texto = "") {
  document.getElementById("detalheProgresso").textContent = texto;
}

/** Exibe indicador flash discreto ao contar uma página. */
function mostrarIndicador(texto) {
  const el = document.getElementById("indicadorContagem");
  el.textContent = texto;
  el.classList.add("visivel");

  clearTimeout(indicadorContagemTimeout);
  indicadorContagemTimeout = setTimeout(() => {
    el.classList.remove("visivel");
  }, 900);
}

/** Atualiza o rodapé com a página atual do PDF. */
function atualizarRodapePagina(atual, total) {
  const el = document.getElementById("rodapePagina");
  const input = document.getElementById("inputPaginaPDF");
  const totalEl = document.getElementById("totalPaginasPDF");
  if (!el || !input || !totalEl) return;
  el.style.display = "flex";
  if (document.activeElement !== input) {
    input.value = atual;
  }
  input.max = total;
  totalEl.textContent = `/ ${total}`;
}

// Conclui a sessão e fecha a aba do leitor.
async function concluirLeitura() {
  await browser.runtime.sendMessage({ action: "complete_session" });
  document.getElementById("btnConcluirReader").textContent = "✅ Acesso liberado!";
  setTimeout(() => window.close(), 1200);
}

// ─── Bookmark ─────────────────────────────────────────────────────────────────
 
/**
 * Salva a última página vista para um livro.
 * Armazenado em browser.storage.local sob a chave "bookmarks".
 * @param {string} id
 * @param {number} pagina
 */
async function salvarBookmark(id, pagina) {
  const resultado = await browser.storage.local.get("bookmarks");
  const bookmarks = resultado.bookmarks || {};
  bookmarks[id]   = { pagina, timestamp: Date.now() };
  await browser.storage.local.set({ bookmarks });
}

async function carregarProgressoPDF(id) {
  if (!id) return {};
  const resultado = await browser.storage.local.get("progresso_pdf");
  return resultado.progresso_pdf?.[id] || {};
}

async function salvarProgressoPDF(id, progressoLivro) {
  if (!id) return;
  const resultado = await browser.storage.local.get("progresso_pdf");
  const progressoPDF = resultado.progresso_pdf || {};
  progressoPDF[id] = progressoLivro;
  await browser.storage.local.set({ progresso_pdf: progressoPDF });
}

const CONFIG_LEITOR_PADRAO = {
  max_paginas_secao: 25,
  margem_paginas_secao: 5,
  min_paginas_secao: 10
};

async function carregarConfigLeitor() {
  try {
    const resposta = await browser.runtime.sendMessage({ action: "get_config" });
    return { ...CONFIG_LEITOR_PADRAO, ...(resposta.config || {}) };
  } catch {
    return { ...CONFIG_LEITOR_PADRAO };
  }
}

// ─── IndexedDB ────────────────────────────────────────────────────────────────

/*
  Só precisamos do método `buscar` aqui - o leitor não escreve no banco.
  Versão reduzida do BookDB do gate.js.
*/
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
  /**
   * Busca um livro pelo id.
   * @param {string} id
   * @returns {Promise<{id, nome, formato, dados: ArrayBuffer}|undefined>}
   */
  async buscar(id) {
    const db = await this.abrir();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction("livros", "readonly");
      const req = tx.objectStore("livros").get(id);
      req.onsuccess = () => resolve(req.result);      // undefined se não encontrado
      req.onerror   = () => reject(req.error);
    });
  }
};

// ─── Detecção de estrutura do PDF ─────────────────────────────────────────────
 
/*
  ESTRATÉGIA: outline (bookmarks do PDF) como fonte primária, texto como fallback.
 
  Usar o outline do PDF é muito mais confiável que varredura de texto porque:
  - Reflete a intenção do autor, não heurísticas de padrão
  - Não confunde "Section 1.1" com um capítulo
  - Não se perde em numeração romana do prefácio
  - É O(capítulos) em vez de O(páginas) — muito mais rápido
 
  A seleção começa no top-level e pode descer níveis quando a seção fica
  grande demais. Quando isso acontece, preservamos a página inicial do pai
  para não perder o texto introdutório antes do primeiro subtítulo.
*/
 
const TITULOS_ESTRUTURAIS = /^\s*(cover|title page|copyright|contents|table of contents|index|bibliography|references|about the author|acknowledgements?)\s*$/i;
const TITULOS_PRELIMINARES = /^\s*(preface|prefacio|foreword|introducao|introduction)\s*$/i;
 
/**
 * Resolve número de página (1-indexed) a partir de uma entrada do outline.
 * O dest pode ser string (named destination) ou array (explicit destination).
 * @param {PDFDocumentProxy} pdfDoc
 * @param {*} dest
 * @returns {Promise<number|null>}
 */
async function resolverPaginaDoOutline(pdfDoc, dest) {
  if (!dest) return null;
  try {
    if (typeof dest === "string") dest = await pdfDoc.getDestination(dest);
    if (!dest?.[0]) return null;
    const idx = await pdfDoc.getPageIndex(dest[0]);
    return idx + 1;
  } catch {
    return null;
  }
}
 
async function resolverOutline(pdfDoc, itens = []) {
  const resolvidos = [];

  for (const item of itens) {
    if (TITULOS_ESTRUTURAIS.test(item.title || "")) continue;

    const pagina = await resolverPaginaDoOutline(pdfDoc, item.dest);
    if (!pagina) continue;

    resolvidos.push({
      titulo: item.title || "",
      pagina,
      filhos: await resolverOutline(pdfDoc, item.items || [])
    });
  }

  return resolvidos.sort((a, b) => a.pagina - b.pagina);
}

function calcularFimDaSecao(secoes, indice, fimGrupo) {
  return Math.max(
    secoes[indice].pagina,
    ((secoes[indice + 1]?.pagina ?? (fimGrupo + 1)) - 1)
  );
}

function escolherSecoesDoOutline(secoes, fimGrupo, maxPaginas, margem) {
  const resultado = [];

  secoes.forEach((secao, indice) => {
    const fim = calcularFimDaSecao(secoes, indice, fimGrupo);
    const totalPaginas = fim - secao.pagina + 1;
    const filhosValidos = secao.filhos
      .filter(filho => filho.pagina >= secao.pagina && filho.pagina <= fim)
      .sort((a, b) => a.pagina - b.pagina);

    if (totalPaginas > maxPaginas + margem && filhosValidos.length > 0) {
      const filhosEscolhidos = adicionarPaginaInicialDaSecao(
        escolherSecoesDoOutline(filhosValidos, fim, maxPaginas, margem),
        secao.pagina
      );
      resultado.push(...filhosEscolhidos);
      return;
    }

    resultado.push({ titulo: secao.titulo, pagina: secao.pagina });
  });

  return resultado.filter((secao, indice, lista) =>
    indice === 0 || secao.pagina > lista[indice - 1].pagina
  );
}

function montarTituloAgrupado(secoes, inicio, fim) {
  if (inicio === fim) return secoes[inicio].titulo;
  return `${secoes[inicio].titulo} + ${secoes[fim].titulo}`;
}

function agruparSecoesCurtas(secoes, fimGrupo, minPaginas) {
  const agrupadas = [];

  for (let i = 0; i < secoes.length; i++) {
    let fimIndice = i;
    let fim = calcularFimDaSecao(secoes, fimIndice, fimGrupo);

    while ((fim - secoes[i].pagina + 1) < minPaginas && fimIndice + 1 < secoes.length) {
      fimIndice++;
      fim = calcularFimDaSecao(secoes, fimIndice, fimGrupo);
    }

    if ((fim - secoes[i].pagina + 1) < minPaginas && agrupadas.length > 0) {
      const anterior = agrupadas[agrupadas.length - 1];
      anterior.fim = fim;
      anterior.titulo = `${anterior.titulo} + ${secoes[fimIndice].titulo}`;
      continue;
    }

    agrupadas.push({
      titulo: montarTituloAgrupado(secoes, i, fimIndice),
      pagina: secoes[i].pagina,
      fim
    });
    i = fimIndice;
  }

  return agrupadas;
}

function adicionarPaginaInicialDaSecao(secoes, paginaInicialSecao) {
  if (!secoes.length || secoes[0].pagina <= paginaInicialSecao) return secoes;
  return [
    { ...secoes[0], pagina: paginaInicialSecao },
    ...secoes.slice(1)
  ];
}
 
/**
 * Fallback quando o PDF não tem outline: varredura de texto simplificada.
 * Só detecta "Chapter N" ou "Capítulo N" explícitos no cabeçalho da página.
 * @param {PDFDocumentProxy} pdfDoc
 * @param {number} totalPaginas
 * @returns {Promise<Array<{titulo: string, pagina: number}>>}
 */
async function detectarCapitulosDeTexto(pdfDoc, totalPaginas) {
  const capitulos = [];
  for (let i = 1; i <= totalPaginas; i++) {
    const pagina   = await pdfDoc.getPage(i);
    const conteudo = await pagina.getTextContent();
    const texto    = conteudo.items.map(it => it.str).join(" ")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().slice(0, 240);
    if (/\b(capitulo|chapter)\s+\d+\b/.test(texto)) {
      capitulos.push({ titulo: `Capítulo ${capitulos.length + 1}`, pagina: i });
    }
  }
  return capitulos;
}
 
/** Verifica se numeroPagina está dentro de algum intervalo ignorado. */
function paginaEstaEmIntervalo(numeroPagina, intervalos) {
  return intervalos.some(iv => numeroPagina >= iv.inicio && numeroPagina <= iv.fim);
}
 
/** Conta páginas fora dos intervalos ignorados entre inicio e fim (inclusive). */
function contarPaginasContaveis(inicio, fim, intervalosIgnorados) {
  let total = 0;
  for (let p = inicio; p <= fim; p++) {
    if (!paginaEstaEmIntervalo(p, intervalosIgnorados)) total++;
  }
  return total;
}
 
/** Retorna o índice do capítulo ao qual numeroPagina pertence, ou -1. */
function encontrarCapituloAtual(capitulos, numeroPagina) {
  return capitulos.findIndex(cap => numeroPagina >= cap.inicio && numeroPagina <= cap.fim);
}
 
/** Marca um capítulo como concluído apenas quando todas as páginas válidas foram lidas. */
function concluirCapituloSeNecessario(capitulo, indice, paginasVistas, concluidosPorIdx) {
  if (!capitulo || concluidosPorIdx.has(indice)) return false;
 
  const lidas      = Array.from(paginasVistas).filter(p => p >= capitulo.inicio && p <= capitulo.fim).length;
 
  if (lidas >= capitulo.totalPaginas) {
    concluidosPorIdx.add(indice);
    return true;
  }
  return false;
}
 
/**
 * Detecta estrutura do PDF: capítulos, intervalos ignorados e página inicial.
 *
 * Se paginaInicial === 1 (não definido pelo usuário), detecta automaticamente
 * o início do primeiro capítulo de conteúdo e usa como página inicial.
 * Isso pula capa, sumário e prefácio sem configuração manual.
 *
 * @param {PDFDocumentProxy} pdfDoc
 * @param {number} totalPaginas
 */
async function detectarEstrutura(pdfDoc, totalPaginas) {
  document.getElementById("carregando").textContent = "Analisando estrutura…";
  const configLeitor = await carregarConfigLeitor();

  let capitulosRaw = [];
  const outline = await pdfDoc.getOutline();
  if (outline?.length) {
    const secoes = await resolverOutline(pdfDoc, outline);
    const secoesEscolhidas = escolherSecoesDoOutline(
      secoes,
      totalPaginas,
      configLeitor.max_paginas_secao,
      configLeitor.margem_paginas_secao
    );
    capitulosRaw = agruparSecoesCurtas(
      secoesEscolhidas,
      totalPaginas,
      configLeitor.min_paginas_secao
    );
  }

  if (capitulosRaw.length === 0) {
    capitulosRaw = await detectarCapitulosDeTexto(pdfDoc, totalPaginas);
  }
 
  // Determina página inicial de leitura
  const primeiroCapituloDeConteudo = capitulosRaw.find(c => !TITULOS_PRELIMINARES.test(c.titulo || ""))
    || capitulosRaw[0]
    || { pagina: 1 };
  const paginaPrimeiroConteudo = primeiroCapituloDeConteudo.pagina;
  const paginaInicialLeitura = paginaInicial > 1 ? paginaInicial : paginaPrimeiroConteudo;
 
  const intervalosIgnorados = paginaPrimeiroConteudo > 1
    ? [{ inicio: 1, fim: paginaPrimeiroConteudo - 1, motivo: "introducao" }]
    : [];
 
  const capitulos = capitulosRaw
    .filter(cap => cap.pagina >= paginaPrimeiroConteudo)
    .map((cap, i, lista) => {
      const fim = cap.fim || ((lista[i + 1]?.pagina ?? totalPaginas + 1) - 1);
      return {
        id:           `${cap.pagina}-${Math.max(cap.pagina, fim)}`,
        titulo:       cap.titulo,
        inicio:       cap.pagina,
        fim:          Math.max(cap.pagina, fim),
        totalPaginas: contarPaginasContaveis(cap.pagina, fim, intervalosIgnorados)
      };
    });
 
  const totalPaginasContaveis = contarPaginasContaveis(
    paginaPrimeiroConteudo, totalPaginas, intervalosIgnorados
  );
 
  return { capitulos, intervalosIgnorados, paginaInicialLeitura, totalPaginasContaveis };
}

// ─── Leitor EPUB ──────────────────────────────────────────────────────────────
 
let rendition = null;
 
/**
 * Inicializa o leitor epub.js.
 * JSZip precisa ser carregado antes do epub.js — dependência obrigatória.
 * @param {ArrayBuffer} arrayBuffer
 */
async function iniciarEpub(arrayBuffer) {
  await carregarScript("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js");
  await carregarScript("https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js");
 
  document.getElementById("viewerEpub").style.display = "block";
  document.getElementById("carregando").style.display = "none";
 
  const livro = ePub(arrayBuffer);
  rendition   = livro.renderTo("viewerEpub", {
    width: "100%", height: "100%", flow: "paginated"
  });
  rendition.display();
 
  let paginasViradas = 0;
  rendition.on("relocated", location => {
    paginasViradas++;
    const progresso = tipoMeta === "chapter" ? location.start.index : paginasViradas;
    atualizarProgresso(progresso, metaTotal);
    if (bookId) salvarBookmark(bookId, location.start.index);
  });
}
 
function paginaAnterior() { if (rendition) rendition.prev(); }
function proximaPagina()  { if (rendition) rendition.next(); }
 
// ─── Leitor PDF ───────────────────────────────────────────────────────────────
 
/**
 * Inicializa o leitor PDF.js, detecta estrutura e renderiza as páginas.
 *
 * threshold: 0.85 — 85% do canvas precisa estar visível para a página contar.
 * Evita que rolar rapidamente para "ver quanto falta" contabilize páginas não lidas.
 *
 * @param {ArrayBuffer} arrayBuffer
 */
async function iniciarPDF(arrayBuffer) {
  await carregarScript(
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"
  );
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  const container = document.getElementById("viewerPDF");
  container.style.display = "flex";

  const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const totalPags = pdfDoc.numPages;
  const estrutura = await detectarEstrutura(pdfDoc, totalPags);
  const { capitulos, intervalosIgnorados, paginaInicialLeitura, totalPaginasContaveis } = estrutura;
  const paginasVistas = new Set();
  const capitulosConcluidosPorIdx = new Set();
  const progressoPDF = await carregarProgressoPDF(bookId);
  const paginasRenderizadas = new Set();
  const renderizacoesAtivas = new Map();
  const paginas = [];
  const paginaComSalto = paginaInicialLeitura > 1;
  let leituraAtivada = !paginaComSalto;
  let saltoInicialExecutado = false;
  let paginaAtualVisual = 1;
  const inputPagina = document.getElementById("inputPaginaPDF");
  const btnIrPagina = document.getElementById("btnIrPaginaPDF");
  const btnMetaDaqui = document.getElementById("btnMetaDaqui");
  let paginaBaseSessao = paginaInicialLeitura;
  let indiceBaseCapitulo = Math.max(0, encontrarCapituloAtual(capitulos, paginaInicialLeitura));

  document.getElementById("carregando").textContent = "Preparando páginas…";
  inputPagina.max = totalPags;
  inputPagina.value = paginaComSalto ? paginaInicialLeitura : 1;

  for (let i = 1; i <= totalPags; i++) {
    const pagina = await pdfDoc.getPage(i);
    const viewport = pagina.getViewport({ scale: 1.4 });
    const shell = document.createElement("div");
    const placeholder = document.createElement("div");

    shell.className = "pagina-pdf";
    shell.dataset.pagina = i;
    shell.style.width = `${viewport.width}px`;
    shell.style.height = `${viewport.height}px`;

    placeholder.className = "pagina-pdf-placeholder";
    placeholder.style.height = `${viewport.height}px`;
    placeholder.textContent = `Página ${i}`;

    shell.appendChild(placeholder);
    container.appendChild(shell);
    paginas.push({ numero: i, shell, viewport });
  }

  async function renderizarPagina(numeroPagina) {
    if (paginasRenderizadas.has(numeroPagina)) return;
    if (renderizacoesAtivas.has(numeroPagina)) return renderizacoesAtivas.get(numeroPagina);

    const tarefa = (async () => {
      const paginaInfo = paginas[numeroPagina - 1];
      if (!paginaInfo) return;

      const pagina = await pdfDoc.getPage(numeroPagina);
      const canvas = document.createElement("canvas");
      canvas.width = paginaInfo.viewport.width;
      canvas.height = paginaInfo.viewport.height;
      canvas.dataset.pagina = numeroPagina;

      await pagina.render({
        canvasContext: canvas.getContext("2d"),
        viewport: paginaInfo.viewport
      }).promise;

      paginaInfo.shell.replaceChildren(canvas);
      paginasRenderizadas.add(numeroPagina);
      renderizacoesAtivas.delete(numeroPagina);
    })();

    renderizacoesAtivas.set(numeroPagina, tarefa);
    return tarefa;
  }

  function renderizarFaixa(centro, raio = 2) {
    for (let numero = Math.max(1, centro - raio); numero <= Math.min(totalPags, centro + raio); numero++) {
      renderizarPagina(numero);
    }
  }

  function obterRazaoVisivel(shell) {
    const rect = shell.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const alturaVisivel = Math.min(rect.bottom, containerRect.bottom) - Math.max(rect.top, containerRect.top);
    return Math.max(0, alturaVisivel) / Math.max(1, rect.height);
  }

  function paginasVisiveis(threshold = 0.85) {
    return paginas.filter(pagina => obterRazaoVisivel(pagina.shell) >= threshold);
  }

  function sincronizarPaginaAtual() {
    let melhorPagina = null;
    let melhorRazao = 0;

    paginas.forEach(pagina => {
      const razao = obterRazaoVisivel(pagina.shell);
      if (razao <= 0) return;

      if (!melhorPagina || razao > melhorRazao) {
        melhorPagina = pagina;
        melhorRazao = razao;
      }
    });

    if (!melhorPagina) return;

    paginaAtualVisual = melhorPagina.numero;
    atualizarRodapePagina(paginaAtualVisual, totalPags);

    if (leituraAtivada && bookId) {
      salvarBookmark(bookId, paginaAtualVisual);
    }

    renderizarFaixa(paginaAtualVisual, 2);
  }

  function contarPaginasLidasNoCapitulo(capitulo) {
    return Array.from(paginasVistas).filter(p => p >= capitulo.inicio && p <= capitulo.fim).length;
  }

  function contarCapitulosConcluidosNaSessao() {
    return Array.from(capitulosConcluidosPorIdx).filter(indice => indice >= indiceBaseCapitulo).length;
  }

  function contarPaginasLidasNaSessao() {
    return Array.from(paginasVistas).filter(pagina => pagina >= paginaBaseSessao).length;
  }

  function hidratarProgressoDoCapitulo(capitulo) {
    if (!capitulo) return;
    const paginaLidaAte = Math.min(capitulo.fim, progressoPDF[capitulo.id] || 0);
    if (paginaLidaAte < capitulo.inicio) return;

    for (let pagina = capitulo.inicio; pagina <= paginaLidaAte; pagina++) {
      if (!paginaEstaEmIntervalo(pagina, intervalosIgnorados)) {
        paginasVistas.add(pagina);
      }
    }
  }

  function salvarPaginaLidaNoCapitulo(capitulo, numeroPagina) {
    if (!capitulo || !bookId) return;
    const paginaLidaAte = progressoPDF[capitulo.id] || 0;
    if (numeroPagina <= paginaLidaAte) return;
    progressoPDF[capitulo.id] = Math.min(capitulo.fim, numeroPagina);
    salvarProgressoPDF(bookId, progressoPDF);
  }

  function processarPaginaVisivel(shell, origem = "observer") {
    const numPag = Number(shell.dataset.pagina);
    const jaVista = paginasVistas.has(numPag);

    if (paginaEstaEmIntervalo(numPag, intervalosIgnorados)) {
      shell.classList.add("ignorada");
      if (origem !== "inicial") mostrarIndicador(`p.${numPag} ignorada`);
      return;
    }

    paginasVistas.add(numPag);
    shell.classList.add("lida");

    if (tipoMeta === "chapter" && capitulos.length > 0) {
      const idx = encontrarCapituloAtual(capitulos, numPag);
      const cap = capitulos[idx];

      if (cap) {
        hidratarProgressoDoCapitulo(cap);
        paginasVistas.add(numPag);
        salvarPaginaLidaNoCapitulo(cap, numPag);

        const lidas = contarPaginasLidasNoCapitulo(cap);
        const concluiu = concluirCapituloSeNecessario(cap, idx, paginasVistas, capitulosConcluidosPorIdx);

        atualizarDetalhe(
          `${cap.titulo || `Cap. ${idx + 1}`}: ${lidas}/${cap.totalPaginas} · Total: ${paginasVistas.size}/${totalPaginasContaveis}`
        );

        if (origem !== "inicial" && (!jaVista || concluiu)) {
          mostrarIndicador(concluiu
            ? `${cap.titulo || `Cap. ${idx + 1}`} concluído`
            : `p.${numPag} contabilizada`
          );
        }
      }

      atualizarProgresso(contarCapitulosConcluidosNaSessao(), metaTotal);
      return;
    }

    if (!jaVista && bookId) {
      salvarBookmark(bookId, numPag);
    }
    atualizarProgresso(contarPaginasLidasNaSessao(), metaTotal);
    atualizarDetalhe(`${paginasVistas.size} / ${totalPaginasContaveis} páginas válidas`);
    if (origem !== "inicial" && !jaVista) mostrarIndicador(`p.${numPag} contabilizada`);
  }

  function processarPaginasVisiveis(origem = "observer") {
    paginasVisiveis().forEach(pagina => processarPaginaVisivel(pagina.shell, origem));
  }

  async function executarSaltoInicial() {
    if (!paginaComSalto || saltoInicialExecutado) return;

    saltoInicialExecutado = true;
    await renderizarPagina(paginaInicialLeitura);
    renderizarFaixa(paginaInicialLeitura, 2);

    leituraAtivada = true;
    const alvo = paginas[paginaInicialLeitura - 1]?.shell;
    if (alvo) {
      container.scrollTop = Math.max(0, alvo.offsetTop - 16);
    }

    requestAnimationFrame(() => {
      sincronizarPaginaAtual();
      processarPaginasVisiveis("inicial");
    });
  }

  async function irParaPagina(numeroPagina, ativarLeitura = true) {
    const paginaDestino = Math.max(1, Math.min(totalPags, numeroPagina));

    await renderizarPagina(paginaDestino);
    renderizarFaixa(paginaDestino, 2);

    if (ativarLeitura) {
      leituraAtivada = true;
      saltoInicialExecutado = true;
      removerListenersSalto();
    }

    const alvo = paginas[paginaDestino - 1]?.shell;
    if (alvo) {
      container.scrollTop = Math.max(0, alvo.offsetTop - 16);
    }

    inputPagina.value = paginaDestino;
    requestAnimationFrame(() => {
      sincronizarPaginaAtual();
      if (leituraAtivada) processarPaginasVisiveis("inicial");
    });
  }

  function definirMetaDaqui() {
    paginaBaseSessao = paginaAtualVisual;

    if (tipoMeta === "chapter" && capitulos.length > 0) {
      const indiceAtual = encontrarCapituloAtual(capitulos, paginaAtualVisual);
      if (indiceAtual >= 0) {
        indiceBaseCapitulo = indiceAtual;
        const capituloAtual = capitulos[indiceAtual];
        hidratarProgressoDoCapitulo(capituloAtual);
        atualizarProgresso(contarCapitulosConcluidosNaSessao(), metaTotal);
        atualizarDetalhe(
          `${capituloAtual.titulo || `Cap. ${indiceAtual + 1}`}: ${contarPaginasLidasNoCapitulo(capituloAtual)}/${capituloAtual.totalPaginas} · meta daqui`
        );
        mostrarIndicador("Meta reiniciada daqui");
        return;
      }
    }

    atualizarProgresso(contarPaginasLidasNaSessao(), metaTotal);
    atualizarDetalhe(`${contarPaginasLidasNaSessao()} / ${metaTotal} páginas na meta atual`);
    mostrarIndicador("Meta reiniciada daqui");
  }

  function onWheelInicial(evento) {
    if (evento.deltaY <= 0) return;
    evento.preventDefault();
    executarSaltoInicial();
    removerListenersSalto();
  }

  function onKeydownInicial(evento) {
    if (!["ArrowDown", "PageDown", " ", "Enter"].includes(evento.key)) return;
    evento.preventDefault();
    executarSaltoInicial();
    removerListenersSalto();
  }

  function removerListenersSalto() {
    container.removeEventListener("wheel", onWheelInicial);
    document.removeEventListener("keydown", onKeydownInicial);
  }

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      renderizarFaixa(Number(entry.target.dataset.pagina), 1);
      if (!leituraAtivada) return;

      sincronizarPaginaAtual();
      processarPaginaVisivel(entry.target);
    });
  }, { threshold: 0.85 });

  paginas.forEach(pagina => observer.observe(pagina.shell));

  await renderizarPagina(1);
  renderizarFaixa(1, 1);

  if (paginaComSalto) {
    atualizarDetalhe(`Na capa · avance para continuar da p.${paginaInicialLeitura}`);
    atualizarRodapePagina(1, totalPags);
    renderizarFaixa(paginaInicialLeitura, 2);
    container.addEventListener("wheel", onWheelInicial, { passive: false });
    document.addEventListener("keydown", onKeydownInicial);
  } else {
    document.getElementById("carregando").style.display = "none";
    requestAnimationFrame(() => {
      leituraAtivada = true;
      sincronizarPaginaAtual();
      processarPaginasVisiveis("inicial");
    });
  }

  document.getElementById("carregando").style.display = "none";

  container.addEventListener("scroll", () => {
    requestAnimationFrame(() => {
      if (!leituraAtivada && container.scrollTop > 0) {
        executarSaltoInicial();
        removerListenersSalto();
        return;
      }

      sincronizarPaginaAtual();
      if (leituraAtivada) processarPaginasVisiveis();
    });
  }, { passive: true });

  btnIrPagina.addEventListener("click", () => {
    irParaPagina(Number(inputPagina.value) || paginaAtualVisual || 1);
  });
  inputPagina.addEventListener("keydown", evento => {
    if (evento.key === "Enter") {
      evento.preventDefault();
      irParaPagina(Number(inputPagina.value) || paginaAtualVisual || 1);
    }
  });
  btnMetaDaqui?.addEventListener("click", definirMetaDaqui);
}

// ─── Inicialização ────────────────────────────────────────────────────────────
 
(async function init() {
  if (!bookId) {
    document.getElementById("carregando").textContent =
      "Nenhum livro especificado. Volte ao gate e selecione um livro.";
    return;
  }
 
  const btn = document.getElementById("btnConcluirReader");
  btn.disabled    = true;
  btn.textContent = `0 / ${metaTotal} ${tipoMeta === "chapter" ? "capítulo(s)" : "página(s)"}`;
 
  document.getElementById("btnAnterior").addEventListener("click", paginaAnterior);
  document.getElementById("btnProximo").addEventListener("click", proximaPagina);
  document.getElementById("btnConcluirReader").addEventListener("click", concluirLeitura);
  document.addEventListener("keydown", e => {
    if (e.key === "ArrowLeft")  paginaAnterior();
    if (e.key === "ArrowRight") proximaPagina();
  });
 
  try {
    const registro = await BookDB.buscar(bookId);
    if (!registro) throw new Error("Livro não encontrado. Pode ter sido removido.");
 
    document.getElementById("tituloLivro").textContent = registro.nome;
 
    if      (registro.formato === "epub") await iniciarEpub(registro.dados);
    else if (registro.formato === "pdf")  await iniciarPDF(registro.dados);
    else throw new Error(`Formato não suportado: ${registro.formato}`);
 
  } catch (err) {
    const el = document.getElementById("carregando");
    el.style.display = "flex";
    el.textContent   = `Erro: ${err.message}`;
    console.error("[anti-twitter] reader:", err);
  }
})();
