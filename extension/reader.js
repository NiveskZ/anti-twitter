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
  const label = document.getElementById("labelPaginaPDF");
  const input = document.getElementById("inputPaginaPDF");
  const totalEl = document.getElementById("totalPaginasPDF");
  const btnIr = document.getElementById("btnIrPaginaPDF");
  if (!el || !label || !input || !totalEl || !btnIr) return;
  el.style.display = "flex";
  label.style.display = "inline";
  input.style.display = "inline-block";
  totalEl.style.display = "inline";
  btnIr.style.display = "inline-block";
  if (document.activeElement !== input) {
    input.value = atual;
  }
  input.max = total;
  totalEl.textContent = `/ ${total}`;
}

function configurarRodapeEpub() {
  const el = document.getElementById("rodapePagina");
  const label = document.getElementById("labelPaginaPDF");
  const input = document.getElementById("inputPaginaPDF");
  const totalEl = document.getElementById("totalPaginasPDF");
  const btnIr = document.getElementById("btnIrPaginaPDF");
  if (!el || !label || !input || !totalEl || !btnIr) return;
  el.style.display = "flex";
  label.style.display = "none";
  input.style.display = "none";
  totalEl.style.display = "none";
  btnIr.style.display = "none";
}

// Conclui a sessão e fecha a aba do leitor.
async function concluirLeitura() {
  await browser.runtime.sendMessage({ action: "complete_session" });
  document.getElementById("btnConcluirReader").textContent = "✅ Acesso liberado!";
  setTimeout(() => window.close(), 1200);
}

// ─── Bookmark ─────────────────────────────────────────────────────────────────
 
async function carregarBookmark(id) {
  if (!id) return {};
  const resultado = await browser.storage.local.get("bookmarks");
  return resultado.bookmarks?.[id] || {};
}

/**
 * Salva a posição atual de um livro.
 * Armazenado em browser.storage.local sob a chave "bookmarks".
 * @param {string} id
 * @param {Object} dados
 */
async function salvarBookmark(id, dados) {
  if (!id) return;
  const resultado = await browser.storage.local.get("bookmarks");
  const bookmarks = resultado.bookmarks || {};
  bookmarks[id] = {
    ...(bookmarks[id] || {}),
    ...dados,
    timestamp: Date.now()
  };
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

function montarSumarioFallback(capitulos) {
  return capitulos.map(capitulo => ({
    titulo: capitulo.titulo,
    pagina: capitulo.pagina,
    filhos: []
  }));
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
  let sumario = [];
  const outline = await pdfDoc.getOutline();
  if (outline?.length) {
    const secoes = await resolverOutline(pdfDoc, outline);
    sumario = secoes;
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
  if (sumario.length === 0) {
    sumario = montarSumarioFallback(capitulosRaw);
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
 
  return { capitulos, intervalosIgnorados, paginaInicialLeitura, totalPaginasContaveis, sumario };
}

// ─── Leitor EPUB ──────────────────────────────────────────────────────────────
 
let rendition = null;
let livroEpub = null;

function normalizarHrefEpub(href = "") {
  return href.split("#")[0];
}

function resolverTituloTocEpub(item) {
  return item?.label || item?.title || item?.href || "Seção";
}

function mapearSumarioEpub(itens = []) {
  return itens
    .map(item => ({
      titulo: resolverTituloTocEpub(item),
      href: item?.href || "",
      filhos: mapearSumarioEpub(item?.subitems || item?.items || [])
    }))
    .filter(item => item.href || item.filhos.length > 0);
}

function coletarCapitulosEpub(itens = [], vistos = new Set(), capitulos = []) {
  itens.forEach(item => {
    const hrefBase = normalizarHrefEpub(item?.href || "");
    if (hrefBase && !vistos.has(hrefBase)) {
      vistos.add(hrefBase);
      capitulos.push({
        id: hrefBase,
        titulo: resolverTituloTocEpub(item),
        href: item.href,
        hrefBase
      });
    }

    coletarCapitulosEpub(item?.subitems || item?.items || [], vistos, capitulos);
  });

  return capitulos;
}
 
/**
 * Inicializa o leitor epub.js.
 * JSZip precisa ser carregado antes do epub.js — dependência obrigatória.
 * @param {ArrayBuffer} arrayBuffer
 */
async function iniciarEpub(arrayBuffer) {
  const ZOOM_MIN = 85;
  const ZOOM_MAX = 170;
  const ZOOM_PASSO = 10;

  await carregarScript("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js");
  await carregarScript("https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js");

  const viewerEpub = document.getElementById("viewerEpub");
  const acoesPDF = document.getElementById("acoesPDF");
  const btnToggleSumario = document.getElementById("btnToggleSumario");
  const btnFecharSumario = document.getElementById("btnFecharSumario");
  const listaSumario = document.getElementById("listaSumario");
  const painelSumario = document.getElementById("painelSumario");
  const btnZoomMenos = document.getElementById("btnZoomMenos");
  const btnZoomMais = document.getElementById("btnZoomMais");
  const textoZoomPDF = document.getElementById("textoZoomPDF");
  const btnMetaDaqui = document.getElementById("btnMetaDaqui");
  const bookmark = await carregarBookmark(bookId);
  let zoomEpub = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(bookmark.epub_zoom) || 100));
  let localizacaoAtual = null;
  let baseLocalizacaoSessao = Number.isFinite(bookmark.location) ? bookmark.location : 0;
  let baseCapituloSessao = 0;

  viewerEpub.style.display = "block";
  acoesPDF.style.display = "flex";
  configurarRodapeEpub();
  document.getElementById("carregando").textContent = "Preparando EPUB…";

  livroEpub = ePub(arrayBuffer);
  const [navigation] = await Promise.all([
    livroEpub.loaded.navigation.catch(() => ({ toc: [] })),
    livroEpub.ready
  ]);

  const sumario = mapearSumarioEpub(navigation?.toc || []);
  const capitulos = coletarCapitulosEpub(navigation?.toc || []);
  const primeiroCapituloDeConteudo = capitulos.find(capitulo =>
    !TITULOS_PRELIMINARES.test(capitulo.titulo || "") &&
    !TITULOS_ESTRUTURAIS.test(capitulo.titulo || "")
  ) || capitulos[0] || null;

  rendition = livroEpub.renderTo("viewerEpub", {
    width: "100%",
    height: "100%",
    flow: "paginated"
  });
  rendition.themes.fontSize(`${zoomEpub}%`);
  textoZoomPDF.textContent = `${zoomEpub}%`;

  document.getElementById("carregando").textContent = "Gerando posições do EPUB…";
  await livroEpub.locations.generate(1200);

  function obterIndiceLocalizacao(location) {
    if (!location) return 0;

    if (Number.isFinite(location.start?.location)) {
      return location.start.location;
    }

    if (livroEpub.locations && typeof livroEpub.locations.locationFromCfi === "function" && location.start?.cfi) {
      const indice = livroEpub.locations.locationFromCfi(location.start.cfi);
      return Number.isFinite(indice) ? indice : 0;
    }

    return 0;
  }

  function obterCapituloAtual(location) {
    if (!location) {
      return { indice: -1, capitulo: null };
    }

    const hrefAtual = normalizarHrefEpub(location.start?.href || "");
    const indicePorHref = capitulos.findIndex(capitulo => capitulo.hrefBase === hrefAtual);
    if (indicePorHref >= 0) {
      return { indice: indicePorHref, capitulo: capitulos[indicePorHref] };
    }

    const indiceSpine = Math.max(0, Number(location.start?.index) || 0);
    return {
      indice: indiceSpine,
      capitulo: capitulos[indiceSpine] || null
    };
  }

  function contarCapitulosConcluidosNaSessao(indiceAtual) {
    if (indiceAtual < 0) return 0;
    return Math.max(0, indiceAtual - baseCapituloSessao);
  }

  function contarPaginasNaSessao(indiceAtual) {
    return Math.max(1, indiceAtual - baseLocalizacaoSessao + 1);
  }

  function salvarPosicaoAtual(location) {
    if (!bookId || !location?.start?.cfi) return;

    const indiceAtual = obterIndiceLocalizacao(location);
    const { capitulo } = obterCapituloAtual(location);

    salvarBookmark(bookId, {
      cfi: location.start.cfi,
      location: indiceAtual,
      href: location.start?.href || "",
      href_base: capitulo?.hrefBase || normalizarHrefEpub(location.start?.href || ""),
      epub_zoom: zoomEpub
    });
  }

  function atualizarDetalheEpub(location) {
    const { indice, capitulo } = obterCapituloAtual(location);
    const paginaAtual = location.start?.displayed?.page || 1;
    const totalPaginas = location.start?.displayed?.total || paginaAtual;

    if (tipoMeta === "chapter") {
      atualizarDetalhe(
        `${capitulo?.titulo || `Cap. ${indice + 1}`}: ${paginaAtual}/${totalPaginas}`
      );
      atualizarProgresso(contarCapitulosConcluidosNaSessao(indice), metaTotal);
      return;
    }

    const indiceAtual = obterIndiceLocalizacao(location);
    const lidas = contarPaginasNaSessao(indiceAtual);
    atualizarDetalhe(`${lidas} / ${metaTotal} posições na meta atual`);
    atualizarProgresso(lidas, metaTotal);
  }

  function alternarSumario() {
    painelSumario.classList.toggle("aberto");
  }

  function montarItemSumarioEpub(item, nivel = 0) {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = `item-sumario nivel-${Math.min(nivel, 3)}`;
    botao.textContent = item.titulo || "Seção";
    if (!item.href) {
      botao.disabled = true;
      botao.style.opacity = "0.65";
    } else {
      botao.addEventListener("click", async () => {
        painelSumario.classList.remove("aberto");
        await rendition.display(item.href);
      });
    }
    listaSumario.appendChild(botao);

    (item.filhos || []).forEach(filho => montarItemSumarioEpub(filho, nivel + 1));
  }

  async function atualizarZoomEpub(delta) {
    const novaEscala = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomEpub + delta));
    if (novaEscala === zoomEpub) return;

    const cfiAtual = localizacaoAtual?.start?.cfi || rendition.currentLocation()?.start?.cfi;
    zoomEpub = novaEscala;
    textoZoomPDF.textContent = `${zoomEpub}%`;
    rendition.themes.fontSize(`${zoomEpub}%`);
    if (bookId) {
      salvarBookmark(bookId, { epub_zoom: zoomEpub });
    }
    if (cfiAtual) {
      await rendition.display(cfiAtual);
    }
  }

  function definirMetaDaquiEpub() {
    if (!localizacaoAtual) return;

    const indiceAtual = obterIndiceLocalizacao(localizacaoAtual);
    baseLocalizacaoSessao = indiceAtual;

    if (tipoMeta === "chapter") {
      const { indice, capitulo } = obterCapituloAtual(localizacaoAtual);
      baseCapituloSessao = Math.max(0, indice);
      atualizarProgresso(0, metaTotal);
      atualizarDetalhe(
        `${capitulo?.titulo || `Cap. ${indice + 1}`}: ${localizacaoAtual.start?.displayed?.page || 1}/${localizacaoAtual.start?.displayed?.total || 1} · meta daqui`
      );
      mostrarIndicador("Meta reiniciada daqui");
      return;
    }

    atualizarProgresso(contarPaginasNaSessao(indiceAtual), metaTotal);
    atualizarDetalhe(`${contarPaginasNaSessao(indiceAtual)} / ${metaTotal} posições na meta atual`);
    mostrarIndicador("Meta reiniciada daqui");
  }

  listaSumario.innerHTML = "";
  sumario.forEach(item => montarItemSumarioEpub(item));

  if (bookmark.href_base) {
    const indiceBookmark = capitulos.findIndex(capitulo => capitulo.hrefBase === bookmark.href_base);
    if (indiceBookmark >= 0) {
      baseCapituloSessao = indiceBookmark;
    }
  }

  rendition.on("relocated", location => {
    localizacaoAtual = location;
    salvarPosicaoAtual(location);
    atualizarDetalheEpub(location);
  });

  await rendition.display(bookmark.cfi || primeiroCapituloDeConteudo?.href || undefined);

  if (!bookmark.href_base && localizacaoAtual) {
    baseCapituloSessao = Math.max(0, obterCapituloAtual(localizacaoAtual).indice);
  }

  if (!bookmark.cfi && localizacaoAtual) {
    baseLocalizacaoSessao = obterIndiceLocalizacao(localizacaoAtual);
  }
  if (localizacaoAtual) {
    atualizarDetalheEpub(localizacaoAtual);
  }

  btnToggleSumario?.addEventListener("click", alternarSumario);
  btnFecharSumario?.addEventListener("click", () => painelSumario.classList.remove("aberto"));
  btnZoomMenos?.addEventListener("click", () => atualizarZoomEpub(-ZOOM_PASSO));
  btnZoomMais?.addEventListener("click", () => atualizarZoomEpub(ZOOM_PASSO));
  btnMetaDaqui?.addEventListener("click", definirMetaDaquiEpub);

  document.getElementById("carregando").style.display = "none";
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
  const ESCALA_BASE = 1.4;
  const ZOOM_MIN = 0.85;
  const ZOOM_MAX = 2.2;
  const ZOOM_PASSO = 0.15;

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
  const { capitulos, intervalosIgnorados, paginaInicialLeitura, totalPaginasContaveis, sumario } = estrutura;
  const paginasVistas = new Set();
  const capitulosConcluidosPorIdx = new Set();
  const progressoPDF = await carregarProgressoPDF(bookId);
  const paginasRenderizadas = new Set();
  const renderizacoesAtivas = new Map();
  const paginas = [];
  let versaoRender = 0;
  const paginaComSalto = paginaInicialLeitura > 1;
  let leituraAtivada = !paginaComSalto;
  let saltoInicialExecutado = false;
  let paginaAtualVisual = 1;
  const inputPagina = document.getElementById("inputPaginaPDF");
  const btnIrPagina = document.getElementById("btnIrPaginaPDF");
  const btnMetaDaqui = document.getElementById("btnMetaDaqui");
  const acoesPDF = document.getElementById("acoesPDF");
  const btnToggleSumario = document.getElementById("btnToggleSumario");
  const btnFecharSumario = document.getElementById("btnFecharSumario");
  const listaSumario = document.getElementById("listaSumario");
  const painelSumario = document.getElementById("painelSumario");
  const btnZoomMenos = document.getElementById("btnZoomMenos");
  const btnZoomMais = document.getElementById("btnZoomMais");
  const textoZoomPDF = document.getElementById("textoZoomPDF");
  let paginaBaseSessao = paginaInicialLeitura;
  let indiceBaseCapitulo = Math.max(0, encontrarCapituloAtual(capitulos, paginaInicialLeitura));
  let zoomPDF = 1;

  document.getElementById("carregando").textContent = "Preparando páginas…";
  acoesPDF.style.display = "flex";
  inputPagina.max = totalPags;
  inputPagina.value = paginaComSalto ? paginaInicialLeitura : 1;
  textoZoomPDF.textContent = "100%";

  for (let i = 1; i <= totalPags; i++) {
    const pagina = await pdfDoc.getPage(i);
    const viewport = pagina.getViewport({ scale: ESCALA_BASE });
    const shell = document.createElement("div");
    const placeholder = document.createElement("div");

    shell.className = "pagina-pdf";
    shell.dataset.pagina = i;
    shell.style.width = `${viewport.width}px`;
    shell.style.height = `${viewport.height}px`;

    placeholder.className = "pagina-pdf-placeholder";
    placeholder.textContent = `Página ${i}`;

    shell.appendChild(placeholder);
    container.appendChild(shell);
    paginas.push({
      numero: i,
      shell,
      larguraBase: viewport.width,
      alturaBase: viewport.height
    });
  }

  function atualizarEscalaVisualDaPagina(paginaInfo) {
    const largura = paginaInfo.larguraBase * zoomPDF;
    const altura = paginaInfo.alturaBase * zoomPDF;
    paginaInfo.shell.style.width = `${largura}px`;
    paginaInfo.shell.style.height = `${altura}px`;

    const elemento = paginaInfo.shell.firstElementChild;
    if (!elemento) return;
    elemento.style.width = `${largura}px`;
    elemento.style.height = `${altura}px`;
  }

  async function renderizarPagina(numeroPagina) {
    if (paginasRenderizadas.has(numeroPagina)) return;
    if (renderizacoesAtivas.has(numeroPagina)) return renderizacoesAtivas.get(numeroPagina);

    const tarefa = (async () => {
      const paginaInfo = paginas[numeroPagina - 1];
      if (!paginaInfo) return;
      const versaoAtual = versaoRender;

      const pagina = await pdfDoc.getPage(numeroPagina);
      const viewport = pagina.getViewport({ scale: ESCALA_BASE * zoomPDF });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.dataset.pagina = numeroPagina;
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      await pagina.render({
        canvasContext: canvas.getContext("2d"),
        viewport
      }).promise;

      if (versaoAtual !== versaoRender) return;
      paginaInfo.shell.replaceChildren(canvas);
      paginasRenderizadas.add(numeroPagina);
      renderizacoesAtivas.delete(numeroPagina);
    })();

    renderizacoesAtivas.set(numeroPagina, tarefa);
    return tarefa;
  }

  function resetarPaginasRenderizadas() {
    versaoRender++;
    paginasRenderizadas.clear();
    renderizacoesAtivas.clear();

    paginas.forEach(paginaInfo => {
      const placeholder = document.createElement("div");
      placeholder.className = "pagina-pdf-placeholder";
      placeholder.textContent = `Página ${paginaInfo.numero}`;
      paginaInfo.shell.replaceChildren(placeholder);
      atualizarEscalaVisualDaPagina(paginaInfo);
    });
  }

  function renderizarFaixa(centro, raio = 2) {
    for (let numero = Math.max(1, centro - raio); numero <= Math.min(totalPags, centro + raio); numero++) {
      renderizarPagina(numero);
    }
  }

  function atualizarZoomPDF(novoZoom) {
    zoomPDF = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, novoZoom));
    textoZoomPDF.textContent = `${Math.round(zoomPDF * 100)}%`;
    resetarPaginasRenderizadas();
    renderizarFaixa(paginaAtualVisual || paginaInicialLeitura || 1, 2);
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
      salvarBookmark(bookId, { pagina: paginaAtualVisual });
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
      salvarBookmark(bookId, { pagina: numPag });
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

  function alternarSumario() {
    painelSumario.classList.toggle("aberto");
  }

  function montarItemSumario(item, nivel = 0) {
    if (!item?.pagina) return;

    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = `item-sumario nivel-${Math.min(nivel, 3)}`;
    botao.textContent = item.titulo || `Página ${item.pagina}`;
    botao.addEventListener("click", () => {
      painelSumario.classList.remove("aberto");
      irParaPagina(item.pagina);
    });
    listaSumario.appendChild(botao);

    (item.filhos || []).forEach(filho => montarItemSumario(filho, nivel + 1));
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
  paginas.forEach(atualizarEscalaVisualDaPagina);

  listaSumario.innerHTML = "";
  sumario.forEach(item => montarItemSumario(item));

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
  btnToggleSumario?.addEventListener("click", alternarSumario);
  btnFecharSumario?.addEventListener("click", () => painelSumario.classList.remove("aberto"));
  btnZoomMenos?.addEventListener("click", () => atualizarZoomPDF(zoomPDF - ZOOM_PASSO));
  btnZoomMais?.addEventListener("click", () => atualizarZoomPDF(zoomPDF + ZOOM_PASSO));
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
