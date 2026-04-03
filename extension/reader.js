// ─── Parâmetros da URL ────────────────────────────────────────────────────────

const params      = new URLSearchParams(window.location.search);
const bookId      = params.get("book");
const tipoMeta    = params.get("modo");    // "pages" ou "chapter"
const metaTotal   = Number(params.get("amount")) || 1;
// paginaInicial: onde a contagem começa e onde o scroll inicia.
// Vem do bookmark salvo ou do campo manual no gate.html.
// Valor 1 significa "desde o início".
const paginaInicial = Math.max(1, Number(params.get("pagina")) || 1);

let progressoAtual           = 0;
let indicadorContagemTimeout = null;

// ─── Cache de elementos DOM ───────────────────────────────────────────────────
//
// Buscamos cada elemento uma única vez aqui no topo.
// As funções iniciarEpub e iniciarPDF antes faziam getElementById
// separadamente para os mesmos elementos — removemos essa duplicação.
//
const EL = {
  textoProgresso:   document.getElementById("textoProgresso"),
  fillProgresso:    document.getElementById("fillProgresso"),
  btnConcluir:      document.getElementById("btnConcluirReader"),
  detalheProgresso: document.getElementById("detalheProgresso"),
  indicador:        document.getElementById("indicadorContagem"),
  carregando:       document.getElementById("carregando"),
  rodapePagina:     document.getElementById("rodapePagina"),
  inputPagina:      document.getElementById("inputPaginaPDF"),
  totalPaginasEl:   document.getElementById("totalPaginasPDF"),
  labelPagina:      document.getElementById("labelPaginaPDF"),
  btnIrPagina:      document.getElementById("btnIrPaginaPDF"),
  btnMetaDaqui:     document.getElementById("btnMetaDaqui"),
  acoesPDF:         document.getElementById("acoesPDF"),
  btnToggleSumario: document.getElementById("btnToggleSumario"),
  btnFecharSumario: document.getElementById("btnFecharSumario"),
  listaSumario:     document.getElementById("listaSumario"),
  painelSumario:    document.getElementById("painelSumario"),
  btnZoomMenos:     document.getElementById("btnZoomMenos"),
  btnZoomMais:      document.getElementById("btnZoomMais"),
  textoZoom:        document.getElementById("textoZoomPDF"),
  viewerEpub:       document.getElementById("viewerEpub"),
  viewerPDF:        document.getElementById("viewerPDF"),
  btnAnterior:      document.getElementById("btnAnterior"),
  btnProximo:       document.getElementById("btnProximo"),
};

// ─── Utilitários gerais ───────────────────────────────────────────────────────

/**
 * Carrega um script externo como Promise, evitando duplicatas.
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
 * Atualiza barra de progresso e texto do botão de conclusão.
 * @param {number} atual
 * @param {number} total
 */
function atualizarProgresso(atual, total) {
  progressoAtual = Math.max(0, atual);
  const pct = Math.min(100, Math.round((progressoAtual / total) * 100));

  EL.textoProgresso.textContent = `${progressoAtual} / ${total}`;
  EL.fillProgresso.style.width  = pct + "%";

  if (progressoAtual >= total) {
    EL.btnConcluir.disabled         = false;
    EL.btnConcluir.textContent      = "✅ Meta atingida — concluir";
    EL.btnConcluir.style.background = "#1b5e1b";
    browser.storage.local.set({ meta_atingida: true });
  } else {
    EL.btnConcluir.disabled         = true;
    EL.btnConcluir.style.background = "#555";
    EL.btnConcluir.textContent      = `${progressoAtual} / ${total} ${tipoMeta === "chapter" ? "cap" : "pág"}`;
  }
}

/** Atualiza linha de detalhe abaixo do contador principal. */
function atualizarDetalhe(texto = "") {
  EL.detalheProgresso.textContent = texto;
}

/** Exibe indicador flash discreto durante contagem de página. */
function mostrarIndicador(texto) {
  EL.indicador.textContent = texto;
  EL.indicador.classList.add("visivel");
  clearTimeout(indicadorContagemTimeout);
  indicadorContagemTimeout = setTimeout(() => EL.indicador.classList.remove("visivel"), 900);
}

/**
 * Configura e exibe o rodapé de navegação pela primeira vez.
 * Antes existiam duas funções quase idênticas (atualizarRodapePagina e
 * configurarRodapeEpub) que configuravam display em cada chamada.
 * Agora o layout é configurado uma vez aqui e atualizarRodape() só
 * atualiza os valores numéricos.
 * @param {"pdf"|"epub"} modo
 * @param {number} total
 */
function iniciarRodape(modo, total) {
  EL.rodapePagina.style.display = "flex";
  EL.labelPagina.textContent    = modo === "epub" ? "Posição" : "Página";
  EL.inputPagina.value          = 1;
  EL.inputPagina.max            = total;
  EL.totalPaginasEl.textContent = `/ ${total}`;
}

/**
 * Atualiza os valores exibidos no rodapé sem reconfigurar o layout.
 * @param {number} atual
 * @param {number} total
 */
function atualizarRodape(atual, total) {
  if (document.activeElement !== EL.inputPagina) EL.inputPagina.value = atual;
  EL.inputPagina.max            = total;
  EL.totalPaginasEl.textContent = `/ ${total}`;
}

/** Conclui sessão e fecha a aba do leitor. */
async function concluirLeitura() {
  await browser.runtime.sendMessage({ action: "complete_session" });
  EL.btnConcluir.textContent = "✅ Acesso liberado!";
  setTimeout(() => window.close(), 1200);
}

// ─── Bookmark ─────────────────────────────────────────────────────────────────

/** Carrega o bookmark de um livro. Retorna objeto vazio se não houver. */
async function carregarBookmark(id) {
  if (!id) return {};
  const resultado = await browser.storage.local.get("bookmarks");
  return resultado.bookmarks?.[id] || {};
}

/**
 * Salva campos de posição no bookmark de um livro.
 * Faz merge com o bookmark existente — não sobrescreve campos omitidos.
 */
async function salvarBookmark(id, dados) {
  if (!id) return;
  const resultado = await browser.storage.local.get("bookmarks");
  const bookmarks = resultado.bookmarks || {};
  bookmarks[id]   = { ...(bookmarks[id] || {}), ...dados, timestamp: Date.now() };
  await browser.storage.local.set({ bookmarks });
}

/** Carrega o progresso por capítulo de um livro PDF. */
async function carregarProgressoPDF(id) {
  if (!id) return {};
  const resultado = await browser.storage.local.get("progresso_pdf");
  return resultado.progresso_pdf?.[id] || {};
}

/** Salva o progresso por capítulo de um livro PDF. */
async function salvarProgressoPDF(id, progressoLivro) {
  if (!id) return;
  const resultado    = await browser.storage.local.get("progresso_pdf");
  const progressoPDF = resultado.progresso_pdf || {};
  progressoPDF[id]   = progressoLivro;
  await browser.storage.local.set({ progresso_pdf: progressoPDF });
}

// ─── Configuração do leitor ────────────────────────────────────────────────────

const CONFIG_LEITOR_PADRAO = { max_paginas_secao: 25, margem_paginas_secao: 5, min_paginas_secao: 10 };

async function carregarConfigLeitor() {
  try {
    const resposta = await browser.runtime.sendMessage({ action: "get_config" });
    return { ...CONFIG_LEITOR_PADRAO, ...(resposta.config || {}) };
  } catch {
    return { ...CONFIG_LEITOR_PADRAO };
  }
}

// ─── IndexedDB ────────────────────────────────────────────────────────────────

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
  /** @returns {Promise<{id, nome, formato, dados: ArrayBuffer}|undefined>} */
  async buscar(id) {
    const db = await this.abrir();
    return new Promise((resolve, reject) => {
      const req = db.transaction("livros", "readonly").objectStore("livros").get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }
};

// ─── Detecção de estrutura do PDF ─────────────────────────────────────────────
//
// ESTRATÉGIA: outline (bookmarks do PDF) como fonte primária, texto como fallback.
//
// Outline é mais confiável que varredura de texto porque:
//   - Reflete a intenção do autor, não heurísticas de padrão
//   - Não confunde "Section 1.1" com um capítulo
//   - Não se perde em numeração romana do prefácio
//   - É O(capítulos) em vez de O(páginas)
//
// Quando seções do outline são grandes demais, descemos um nível.
// Seções muito curtas são agrupadas para evitar microseções.
//

const TITULOS_ESTRUTURAIS  = /^\s*(cover|title page|copyright|contents|table of contents|index|bibliography|references|about the author|acknowledgements?)\s*$/i;
const TITULOS_PRELIMINARES = /^\s*(preface|prefacio|foreword|introducao|introduction)\s*$/i;

/** Resolve número de página (1-indexed) a partir de uma entrada do outline. */
async function resolverPaginaDoOutline(pdfDoc, dest) {
  if (!dest) return null;
  try {
    if (typeof dest === "string") dest = await pdfDoc.getDestination(dest);
    if (!dest?.[0]) return null;
    return (await pdfDoc.getPageIndex(dest[0])) + 1;
  } catch {
    return null;
  }
}

/** Resolve recursivamente o outline do PDF, ignorando entradas estruturais. */
async function resolverOutline(pdfDoc, itens = []) {
  const resolvidos = [];
  for (const item of itens) {
    if (TITULOS_ESTRUTURAIS.test(item.title || "")) continue;
    const pagina = await resolverPaginaDoOutline(pdfDoc, item.dest);
    if (!pagina) continue;
    resolvidos.push({ titulo: item.title || "", pagina, filhos: await resolverOutline(pdfDoc, item.items || []) });
  }
  return resolvidos.sort((a, b) => a.pagina - b.pagina);
}

function montarSumarioFallback(capitulos) {
  return capitulos.map(cap => ({ titulo: cap.titulo, pagina: cap.pagina, filhos: [] }));
}

function calcularFimDaSecao(secoes, indice, fimGrupo) {
  return Math.max(secoes[indice].pagina, ((secoes[indice + 1]?.pagina ?? (fimGrupo + 1)) - 1));
}

/**
 * Escolhe as seções do outline para a meta de leitura.
 * Quando uma seção é maior que maxPaginas+margem e tem filhos, usa os filhos.
 * Preserva a página inicial do pai para não perder o texto introdutório.
 */
function escolherSecoesDoOutline(secoes, fimGrupo, maxPaginas, margem) {
  const resultado = [];
  secoes.forEach((secao, indice) => {
    const fim           = calcularFimDaSecao(secoes, indice, fimGrupo);
    const totalPaginas  = fim - secao.pagina + 1;
    const filhosValidos = secao.filhos
      .filter(f => f.pagina >= secao.pagina && f.pagina <= fim)
      .sort((a, b) => a.pagina - b.pagina);

    if (totalPaginas > maxPaginas + margem && filhosValidos.length > 0) {
      resultado.push(...adicionarPaginaInicialDaSecao(
        escolherSecoesDoOutline(filhosValidos, fim, maxPaginas, margem),
        secao.pagina
      ));
      return;
    }
    resultado.push({ titulo: secao.titulo, pagina: secao.pagina });
  });
  return resultado.filter((s, i, lista) => i === 0 || s.pagina > lista[i - 1].pagina);
}

function montarTituloAgrupado(secoes, inicio, fim) {
  return inicio === fim ? secoes[inicio].titulo : `${secoes[inicio].titulo} + ${secoes[fim].titulo}`;
}

/** Agrupa seções menores que minPaginas para evitar microseções. */
function agruparSecoesCurtas(secoes, fimGrupo, minPaginas) {
  const agrupadas = [];
  for (let i = 0; i < secoes.length; i++) {
    let fimIndice = i;
    let fim       = calcularFimDaSecao(secoes, fimIndice, fimGrupo);
    while ((fim - secoes[i].pagina + 1) < minPaginas && fimIndice + 1 < secoes.length) {
      fimIndice++;
      fim = calcularFimDaSecao(secoes, fimIndice, fimGrupo);
    }
    if ((fim - secoes[i].pagina + 1) < minPaginas && agrupadas.length > 0) {
      const anterior  = agrupadas[agrupadas.length - 1];
      anterior.fim    = fim;
      anterior.titulo = `${anterior.titulo} + ${secoes[fimIndice].titulo}`;
      continue;
    }
    agrupadas.push({ titulo: montarTituloAgrupado(secoes, i, fimIndice), pagina: secoes[i].pagina, fim });
    i = fimIndice;
  }
  return agrupadas;
}

function adicionarPaginaInicialDaSecao(secoes, paginaInicialSecao) {
  if (!secoes.length || secoes[0].pagina <= paginaInicialSecao) return secoes;
  return [{ ...secoes[0], pagina: paginaInicialSecao }, ...secoes.slice(1)];
}

/** Fallback quando o PDF não tem outline: varredura de texto simplificada. */
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

function paginaEstaEmIntervalo(numeroPagina, intervalos) {
  return intervalos.some(iv => numeroPagina >= iv.inicio && numeroPagina <= iv.fim);
}

function contarPaginasContaveis(inicio, fim, intervalosIgnorados) {
  let total = 0;
  for (let p = inicio; p <= fim; p++) {
    if (!paginaEstaEmIntervalo(p, intervalosIgnorados)) total++;
  }
  return total;
}

function encontrarCapituloAtual(capitulos, numeroPagina) {
  return capitulos.findIndex(cap => numeroPagina >= cap.inicio && numeroPagina <= cap.fim);
}

function concluirCapituloSeNecessario(capitulo, indice, paginasVistas, concluidosPorIdx) {
  if (!capitulo || concluidosPorIdx.has(indice)) return false;
  const lidas = Array.from(paginasVistas).filter(p => p >= capitulo.inicio && p <= capitulo.fim).length;
  if (lidas >= capitulo.totalPaginas) { concluidosPorIdx.add(indice); return true; }
  return false;
}

/**
 * Detecta estrutura do PDF: capítulos, intervalos ignorados e página inicial.
 * Quando paginaInicial === 1, determina automaticamente o início do primeiro
 * capítulo de conteúdo, pulando capa, sumário e prefácio.
 */
async function detectarEstrutura(pdfDoc, totalPaginas) {
  EL.carregando.textContent = "Analisando estrutura…";
  const configLeitor = await carregarConfigLeitor();

  let capitulosRaw = [];
  let sumario      = [];
  const outline    = await pdfDoc.getOutline();

  if (outline?.length) {
    const secoes = await resolverOutline(pdfDoc, outline);
    sumario      = secoes;
    capitulosRaw = agruparSecoesCurtas(
      escolherSecoesDoOutline(secoes, totalPaginas, configLeitor.max_paginas_secao, configLeitor.margem_paginas_secao),
      totalPaginas,
      configLeitor.min_paginas_secao
    );
  }

  if (capitulosRaw.length === 0) capitulosRaw = await detectarCapitulosDeTexto(pdfDoc, totalPaginas);
  if (sumario.length === 0)      sumario       = montarSumarioFallback(capitulosRaw);

  const primeiroCapituloDeConteudo = capitulosRaw.find(c => !TITULOS_PRELIMINARES.test(c.titulo || ""))
    || capitulosRaw[0] || { pagina: 1 };

  const paginaPrimeiroConteudo = primeiroCapituloDeConteudo.pagina;
  const paginaInicialLeitura   = paginaInicial > 1 ? paginaInicial : paginaPrimeiroConteudo;

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

  const totalPaginasContaveis = contarPaginasContaveis(paginaPrimeiroConteudo, totalPaginas, intervalosIgnorados);
  return { capitulos, intervalosIgnorados, paginaInicialLeitura, totalPaginasContaveis, sumario };
}

// ─── Leitor EPUB ──────────────────────────────────────────────────────────────

let rendition = null;
let livroEpub = null;

function normalizarHrefEpub(href = "")  { return href.split("#")[0]; }
function resolverTituloTocEpub(item)    { return item?.label || item?.title || item?.href || "Seção"; }

function mapearSumarioEpub(itens = []) {
  return itens
    .map(item => ({
      titulo: resolverTituloTocEpub(item),
      href:   item?.href || "",
      filhos: mapearSumarioEpub(item?.subitems || item?.items || [])
    }))
    .filter(item => item.href || item.filhos.length > 0);
}

function coletarCapitulosEpub(itens = [], vistos = new Set(), capitulos = []) {
  itens.forEach(item => {
    const hrefBase = normalizarHrefEpub(item?.href || "");
    if (hrefBase && !vistos.has(hrefBase)) {
      vistos.add(hrefBase);
      capitulos.push({ id: hrefBase, titulo: resolverTituloTocEpub(item), href: item.href, hrefBase });
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
  const ZOOM_MIN   = 85;
  const ZOOM_MAX   = 170;
  const ZOOM_PASSO = 10;

  await carregarScript("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js");
  await carregarScript("https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js");

  const bookmark = await carregarBookmark(bookId);
  let zoomEpub               = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(bookmark.epub_zoom) || 100));
  let localizacaoAtual       = null;
  let totalLocalizacoes      = 0;
  let baseLocalizacaoSessao  = Number.isFinite(bookmark.location) ? bookmark.location : 0;
  let baseCapituloSessao     = -1;
  let ultimoCapituloVisitado = -1;
  const capitulosConcluidos  = new Set();

  EL.viewerEpub.style.display = "block";
  EL.acoesPDF.style.display   = "flex";
  EL.carregando.textContent   = "Preparando EPUB…";

  livroEpub = ePub(arrayBuffer);
  const [navigation] = await Promise.all([
    livroEpub.loaded.navigation.catch(() => ({ toc: [] })),
    livroEpub.ready
  ]);

  const sumario   = mapearSumarioEpub(navigation?.toc || []);
  const capitulos = coletarCapitulosEpub(navigation?.toc || []);
  const primeiroCapituloDeConteudo = capitulos.find(cap =>
    !TITULOS_PRELIMINARES.test(cap.titulo || "") && !TITULOS_ESTRUTURAIS.test(cap.titulo || "")
  ) || capitulos[0] || null;

  rendition = livroEpub.renderTo("viewerEpub", { width: "100%", height: "100%", flow: "paginated" });
  rendition.themes.fontSize(`${zoomEpub}%`);
  EL.textoZoom.textContent = `${zoomEpub}%`;

  EL.carregando.textContent = "Gerando posições do EPUB…";
  await livroEpub.locations.generate(1200);
  totalLocalizacoes = Number(livroEpub.locations?.total) || livroEpub.locations?._locations?.length || 0;
  iniciarRodape("epub", Math.max(1, totalLocalizacoes));

  // ── Helpers internos do EPUB ─────────────────────────────────────────────────

  function obterIndiceLocalizacao(location) {
    if (!location) return 0;
    if (Number.isFinite(location.start?.location)) return location.start.location;
    if (livroEpub.locations && typeof livroEpub.locations.locationFromCfi === "function" && location.start?.cfi) {
      const idx = livroEpub.locations.locationFromCfi(location.start.cfi);
      return Number.isFinite(idx) ? idx : 0;
    }
    return 0;
  }

  function obterCapituloAtual(location) {
    if (!location) return { indice: -1, capitulo: null };
    const hrefAtual    = normalizarHrefEpub(location.start?.href || "");
    const indicePorHref = capitulos.findIndex(cap => cap.hrefBase === hrefAtual);
    return indicePorHref >= 0
      ? { indice: indicePorHref, capitulo: capitulos[indicePorHref] }
      : { indice: -1, capitulo: null };
  }

  function contarCapitulosConcluidosNaSessao() {
    return Array.from(capitulosConcluidos).filter(idx => idx >= baseCapituloSessao).length;
  }

  function contarPaginasNaSessao(indiceAtual) {
    return Math.max(1, indiceAtual - baseLocalizacaoSessao + 1);
  }

  function registrarMudancaDeCapitulo(indiceAtual) {
    if (indiceAtual < 0) return;
    if (ultimoCapituloVisitado < 0) { ultimoCapituloVisitado = indiceAtual; return; }
    if (indiceAtual > ultimoCapituloVisitado) {
      for (let idx = ultimoCapituloVisitado; idx < indiceAtual; idx++) {
        if (idx >= baseCapituloSessao) capitulosConcluidos.add(idx);
      }
    }
    ultimoCapituloVisitado = indiceAtual;
  }

  function salvarPosicaoAtual(location) {
    if (!bookId || !location?.start?.cfi) return;
    const indiceAtual  = obterIndiceLocalizacao(location);
    const { capitulo } = obterCapituloAtual(location);
    salvarBookmark(bookId, {
      pagina:    indiceAtual + 1,
      cfi:       location.start.cfi,
      location:  indiceAtual,
      href:      location.start?.href || "",
      href_base: capitulo?.hrefBase || normalizarHrefEpub(location.start?.href || ""),
      epub_zoom: zoomEpub
    });
  }

  function atualizarDetalheEpub(location) {
    const { capitulo } = obterCapituloAtual(location);
    const indiceAtual  = obterIndiceLocalizacao(location);
    const paginaAtual  = indiceAtual + 1;
    const totalPaginas = Math.max(1, totalLocalizacoes);

    atualizarRodape(paginaAtual, totalPaginas);

    if (tipoMeta === "chapter") {
      atualizarDetalhe(`${capitulo?.titulo || "Seção atual"} · Livro: ${paginaAtual}/${totalPaginas}`);
      atualizarProgresso(contarCapitulosConcluidosNaSessao(), metaTotal);
      return;
    }

    const lidas = contarPaginasNaSessao(indiceAtual);
    atualizarDetalhe(`${lidas} / ${metaTotal} posições na meta atual · Livro: ${paginaAtual}/${totalPaginas}`);
    atualizarProgresso(lidas, metaTotal);
  }

  async function atualizarZoomEpub(delta) {
    const novaEscala = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomEpub + delta));
    if (novaEscala === zoomEpub) return;
    const cfiAtual = localizacaoAtual?.start?.cfi || rendition.currentLocation()?.start?.cfi;
    zoomEpub = novaEscala;
    EL.textoZoom.textContent = `${zoomEpub}%`;
    rendition.themes.fontSize(`${zoomEpub}%`);
    if (bookId) salvarBookmark(bookId, { epub_zoom: zoomEpub });
    if (cfiAtual) await rendition.display(cfiAtual);
  }

  function definirMetaDaquiEpub() {
    if (!localizacaoAtual) return;
    const indiceAtual = obterIndiceLocalizacao(localizacaoAtual);
    baseLocalizacaoSessao = indiceAtual;

    if (tipoMeta === "chapter") {
      const { indice, capitulo } = obterCapituloAtual(localizacaoAtual);
      baseCapituloSessao    = Math.max(0, indice);
      ultimoCapituloVisitado = baseCapituloSessao;
      capitulosConcluidos.clear();
      atualizarProgresso(0, metaTotal);
      atualizarDetalhe(`${capitulo?.titulo || `Cap. ${indice + 1}`} · meta daqui`);
      mostrarIndicador("Meta reiniciada daqui");
      return;
    }

    atualizarProgresso(contarPaginasNaSessao(indiceAtual), metaTotal);
    atualizarDetalhe(`${contarPaginasNaSessao(indiceAtual)} / ${metaTotal} posições na meta atual`);
    mostrarIndicador("Meta reiniciada daqui");
  }

  async function irParaPosicaoEpub(numero) {
    const destino    = Math.max(1, Math.min(Math.max(1, totalLocalizacoes), Number(numero) || 1));
    const cfiDestino = livroEpub.locations?.cfiFromLocation?.(destino - 1);
    if (cfiDestino) await rendition.display(cfiDestino);
  }

  function montarItemSumarioEpub(item, nivel = 0) {
    const botao = document.createElement("button");
    botao.type  = "button";
    botao.className   = `item-sumario nivel-${Math.min(nivel, 3)}`;
    botao.textContent = item.titulo || "Seção";
    if (!item.href) {
      botao.disabled      = true;
      botao.style.opacity = "0.65";
    } else {
      botao.addEventListener("click", async () => {
        EL.painelSumario.classList.remove("aberto");
        await rendition.display(item.href);
      });
    }
    EL.listaSumario.appendChild(botao);
    (item.filhos || []).forEach(filho => montarItemSumarioEpub(filho, nivel + 1));
  }

  // ── Montagem e eventos do EPUB ────────────────────────────────────────────────

  EL.listaSumario.innerHTML = "";
  sumario.forEach(item => montarItemSumarioEpub(item));

  if (bookmark.href_base) {
    const idx = capitulos.findIndex(cap => cap.hrefBase === bookmark.href_base);
    if (idx >= 0) { baseCapituloSessao = idx; ultimoCapituloVisitado = idx; }
  }

  rendition.on("relocated", location => {
    localizacaoAtual = location;
    const { indice } = obterCapituloAtual(location);
    registrarMudancaDeCapitulo(indice);
    salvarPosicaoAtual(location);
    atualizarDetalheEpub(location);
  });

  await rendition.display(bookmark.cfi || primeiroCapituloDeConteudo?.href || undefined);

  if ((baseCapituloSessao < 0 || !bookmark.href_base) && localizacaoAtual) {
    baseCapituloSessao    = Math.max(0, obterCapituloAtual(localizacaoAtual).indice);
    ultimoCapituloVisitado = baseCapituloSessao;
  }
  if (!bookmark.cfi && localizacaoAtual) baseLocalizacaoSessao = obterIndiceLocalizacao(localizacaoAtual);
  if (localizacaoAtual) atualizarDetalheEpub(localizacaoAtual);

  EL.btnToggleSumario?.addEventListener("click", () => EL.painelSumario.classList.toggle("aberto"));
  EL.btnFecharSumario?.addEventListener("click", () => EL.painelSumario.classList.remove("aberto"));
  EL.btnZoomMenos?.addEventListener("click",     () => atualizarZoomEpub(-ZOOM_PASSO));
  EL.btnZoomMais?.addEventListener("click",      () => atualizarZoomEpub(ZOOM_PASSO));
  EL.btnMetaDaqui?.addEventListener("click",     definirMetaDaquiEpub);
  EL.btnIrPagina?.addEventListener("click",      () => irParaPosicaoEpub(EL.inputPagina.value));
  EL.inputPagina?.addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    irParaPosicaoEpub(EL.inputPagina.value);
  });

  EL.carregando.style.display = "none";
}

function paginaAnterior() { if (rendition) rendition.prev(); }
function proximaPagina()  { if (rendition) rendition.next(); }

// ─── Leitor PDF ───────────────────────────────────────────────────────────────
//
// Renderização lazy: cria canvas só para as páginas próximas à visível.
// threshold 0.85 — 85% do shell precisa estar visível para contar a página,
// evitando que rolar rápido para "ver quanto falta" contabilize páginas não lidas.
//

async function iniciarPDF(arrayBuffer) {
  const ESCALA_BASE = 1.4;
  const ZOOM_MIN    = 0.85;
  const ZOOM_MAX    = 2.2;
  const ZOOM_PASSO  = 0.15;

  await carregarScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js");
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  const container = EL.viewerPDF;
  container.style.display = "flex";

  const pdfDoc    = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const totalPags = pdfDoc.numPages;
  const estrutura = await detectarEstrutura(pdfDoc, totalPags);
  const { capitulos, intervalosIgnorados, paginaInicialLeitura, totalPaginasContaveis, sumario } = estrutura;

  const paginasVistas             = new Set();
  const capitulosConcluidosPorIdx = new Set();
  const progressoPDF              = await carregarProgressoPDF(bookId);
  const paginasRenderizadas       = new Set();
  const renderizacoesAtivas       = new Map();
  const paginas                   = [];

  let versaoRender          = 0;
  const paginaComSalto      = paginaInicialLeitura > 1;
  let leituraAtivada        = !paginaComSalto;
  let saltoInicialExecutado = false;
  let paginaAtualVisual     = 1;
  let paginaBaseSessao      = paginaInicialLeitura;
  let indiceBaseCapitulo    = Math.max(0, encontrarCapituloAtual(capitulos, paginaInicialLeitura));
  let zoomPDF               = 1;

  EL.carregando.textContent = "Preparando páginas…";
  EL.acoesPDF.style.display = "flex";
  iniciarRodape("pdf", totalPags);
  EL.inputPagina.value      = paginaComSalto ? paginaInicialLeitura : 1;
  EL.textoZoom.textContent  = "100%";

  // ── Criação dos shells (placeholders) ────────────────────────────────────────

  for (let i = 1; i <= totalPags; i++) {
    const pagina      = await pdfDoc.getPage(i);
    const viewport    = pagina.getViewport({ scale: ESCALA_BASE });
    const shell       = document.createElement("div");
    const placeholder = document.createElement("div");

    shell.className      = "pagina-pdf";
    shell.dataset.pagina = i;
    shell.style.width    = `${viewport.width}px`;
    shell.style.height   = `${viewport.height}px`;

    placeholder.className   = "pagina-pdf-placeholder";
    placeholder.textContent = `Página ${i}`;

    shell.appendChild(placeholder);
    container.appendChild(shell);
    paginas.push({ numero: i, shell, larguraBase: viewport.width, alturaBase: viewport.height });
  }

  // ── Renderização e zoom ────────────────────────────────────────────────────

  function atualizarEscalaVisualDaPagina({ shell, larguraBase, alturaBase }) {
    const largura = larguraBase * zoomPDF;
    const altura  = alturaBase  * zoomPDF;
    shell.style.width  = `${largura}px`;
    shell.style.height = `${altura}px`;
    const el = shell.firstElementChild;
    if (el) { el.style.width = `${largura}px`; el.style.height = `${altura}px`; }
  }

  async function renderizarPagina(numeroPagina) {
    if (paginasRenderizadas.has(numeroPagina)) return;
    if (renderizacoesAtivas.has(numeroPagina)) return renderizacoesAtivas.get(numeroPagina);

    const tarefa = (async () => {
      const paginaInfo  = paginas[numeroPagina - 1];
      if (!paginaInfo) return;
      const versaoAtual = versaoRender;

      const pagina   = await pdfDoc.getPage(numeroPagina);
      const viewport = pagina.getViewport({ scale: ESCALA_BASE * zoomPDF });
      const canvas   = document.createElement("canvas");
      canvas.width        = viewport.width;
      canvas.height       = viewport.height;
      canvas.dataset.pagina = numeroPagina;
      canvas.style.width  = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      await pagina.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

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
      const placeholder       = document.createElement("div");
      placeholder.className   = "pagina-pdf-placeholder";
      placeholder.textContent = `Página ${paginaInfo.numero}`;
      paginaInfo.shell.replaceChildren(placeholder);
      atualizarEscalaVisualDaPagina(paginaInfo);
    });
  }

  function renderizarFaixa(centro, raio = 2) {
    for (let n = Math.max(1, centro - raio); n <= Math.min(totalPags, centro + raio); n++) {
      renderizarPagina(n);
    }
  }

  function atualizarZoomPDF(novoZoom) {
    zoomPDF = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, novoZoom));
    EL.textoZoom.textContent = `${Math.round(zoomPDF * 100)}%`;
    resetarPaginasRenderizadas();
    renderizarFaixa(paginaAtualVisual || paginaInicialLeitura || 1, 2);
  }

  // ── Visibilidade e sincronização ──────────────────────────────────────────────

  function obterRazaoVisivel(shell) {
    const rect  = shell.getBoundingClientRect();
    const cRect = container.getBoundingClientRect();
    return Math.max(0, Math.min(rect.bottom, cRect.bottom) - Math.max(rect.top, cRect.top)) / Math.max(1, rect.height);
  }

  function paginasVisiveis(threshold = 0.85) {
    return paginas.filter(p => obterRazaoVisivel(p.shell) >= threshold);
  }

  function sincronizarPaginaAtual() {
    let melhor = null;
    let melhorRazao = 0;
    paginas.forEach(p => {
      const razao = obterRazaoVisivel(p.shell);
      if (razao > 0 && (!melhor || razao > melhorRazao)) { melhor = p; melhorRazao = razao; }
    });
    if (!melhor) return;
    paginaAtualVisual = melhor.numero;
    atualizarRodape(paginaAtualVisual, totalPags);
    if (leituraAtivada && bookId) salvarBookmark(bookId, { pagina: paginaAtualVisual });
    renderizarFaixa(paginaAtualVisual, 2);
  }

  // ── Contagem e progresso ──────────────────────────────────────────────────────

  function contarPaginasLidasNoCapitulo(cap) {
    return Array.from(paginasVistas).filter(p => p >= cap.inicio && p <= cap.fim).length;
  }

  function contarCapitulosConcluidosNaSessao() {
    return Array.from(capitulosConcluidosPorIdx).filter(idx => idx >= indiceBaseCapitulo).length;
  }

  function contarPaginasLidasNaSessao() {
    return Array.from(paginasVistas).filter(p => p >= paginaBaseSessao).length;
  }

  function hidratarProgressoDoCapitulo(cap) {
    if (!cap) return;
    const paginaLidaAte = Math.min(cap.fim, progressoPDF[cap.id] || 0);
    if (paginaLidaAte < cap.inicio) return;
    for (let p = cap.inicio; p <= paginaLidaAte; p++) {
      if (!paginaEstaEmIntervalo(p, intervalosIgnorados)) paginasVistas.add(p);
    }
  }

  function salvarPaginaLidaNoCapitulo(cap, numeroPagina) {
    if (!cap || !bookId) return;
    if (numeroPagina <= (progressoPDF[cap.id] || 0)) return;
    progressoPDF[cap.id] = Math.min(cap.fim, numeroPagina);
    salvarProgressoPDF(bookId, progressoPDF);
  }

  function processarPaginaVisivel(shell, origem = "observer") {
    const numPag  = Number(shell.dataset.pagina);
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
        salvarPaginaLidaNoCapitulo(cap, numPag);
        const lidas    = contarPaginasLidasNoCapitulo(cap);
        const concluiu = concluirCapituloSeNecessario(cap, idx, paginasVistas, capitulosConcluidosPorIdx);
        atualizarDetalhe(
          `${cap.titulo || `Cap. ${idx + 1}`}: ${lidas}/${cap.totalPaginas} · Total: ${paginasVistas.size}/${totalPaginasContaveis}`
        );
        if (origem !== "inicial" && (!jaVista || concluiu)) {
          mostrarIndicador(concluiu ? `${cap.titulo || `Cap. ${idx + 1}`} concluído` : `p.${numPag} contabilizada`);
        }
      }

      atualizarProgresso(contarCapitulosConcluidosNaSessao(), metaTotal);
      return;
    }

    atualizarProgresso(contarPaginasLidasNaSessao(), metaTotal);
    atualizarDetalhe(`${paginasVistas.size} / ${totalPaginasContaveis} páginas válidas`);
    if (origem !== "inicial" && !jaVista) mostrarIndicador(`p.${numPag} contabilizada`);
  }

  function processarPaginasVisiveis(origem = "observer") {
    paginasVisiveis().forEach(p => processarPaginaVisivel(p.shell, origem));
  }

  // ── Salto inicial ────────────────────────────────────────────────────────────

  function removerListenersSalto() {
    container.removeEventListener("wheel", onWheelInicial);
    document.removeEventListener("keydown", onKeydownInicial);
  }

  function onWheelInicial(e) {
    if (e.deltaY <= 0) return;
    e.preventDefault();
    executarSaltoInicial();
    removerListenersSalto();
  }

  function onKeydownInicial(e) {
    if (!["ArrowDown", "PageDown", " ", "Enter"].includes(e.key)) return;
    e.preventDefault();
    executarSaltoInicial();
    removerListenersSalto();
  }

  async function executarSaltoInicial() {
    if (!paginaComSalto || saltoInicialExecutado) return;
    saltoInicialExecutado = true;
    await renderizarPagina(paginaInicialLeitura);
    renderizarFaixa(paginaInicialLeitura, 2);
    leituraAtivada = true;
    const alvo = paginas[paginaInicialLeitura - 1]?.shell;
    if (alvo) container.scrollTop = Math.max(0, alvo.offsetTop - 16);
    requestAnimationFrame(() => { sincronizarPaginaAtual(); processarPaginasVisiveis("inicial"); });
  }

  // ── Navegação e meta ─────────────────────────────────────────────────────────

  async function irParaPagina(numeroPagina, ativarLeitura = true) {
    const destino = Math.max(1, Math.min(totalPags, numeroPagina));
    await renderizarPagina(destino);
    renderizarFaixa(destino, 2);
    if (ativarLeitura) { leituraAtivada = true; saltoInicialExecutado = true; removerListenersSalto(); }
    const alvo = paginas[destino - 1]?.shell;
    if (alvo) container.scrollTop = Math.max(0, alvo.offsetTop - 16);
    EL.inputPagina.value = destino;
    requestAnimationFrame(() => { sincronizarPaginaAtual(); if (leituraAtivada) processarPaginasVisiveis("inicial"); });
  }

  function definirMetaDaqui() {
    paginaBaseSessao = paginaAtualVisual;

    if (tipoMeta === "chapter" && capitulos.length > 0) {
      const indiceAtual = encontrarCapituloAtual(capitulos, paginaAtualVisual);
      if (indiceAtual >= 0) {
        indiceBaseCapitulo = indiceAtual;
        const cap          = capitulos[indiceAtual];
        hidratarProgressoDoCapitulo(cap);
        atualizarProgresso(contarCapitulosConcluidosNaSessao(), metaTotal);
        atualizarDetalhe(
          `${cap.titulo || `Cap. ${indiceAtual + 1}`}: ${contarPaginasLidasNoCapitulo(cap)}/${cap.totalPaginas} · meta daqui`
        );
        mostrarIndicador("Meta reiniciada daqui");
        return;
      }
    }

    atualizarProgresso(contarPaginasLidasNaSessao(), metaTotal);
    atualizarDetalhe(`${contarPaginasLidasNaSessao()} / ${metaTotal} páginas na meta atual`);
    mostrarIndicador("Meta reiniciada daqui");
  }

  // ── Sumário ────────────────────────────────────────────────────────────────

  function montarItemSumario(item, nivel = 0) {
    if (!item?.pagina) return;
    const botao = document.createElement("button");
    botao.type      = "button";
    botao.className = `item-sumario nivel-${Math.min(nivel, 3)}`;
    botao.textContent = item.titulo || `Página ${item.pagina}`;
    botao.addEventListener("click", () => { EL.painelSumario.classList.remove("aberto"); irParaPagina(item.pagina); });
    EL.listaSumario.appendChild(botao);
    (item.filhos || []).forEach(filho => montarItemSumario(filho, nivel + 1));
  }

  // ── Observer e renderização inicial ──────────────────────────────────────────

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      renderizarFaixa(Number(entry.target.dataset.pagina), 1);
      if (!leituraAtivada) return;
      sincronizarPaginaAtual();
      processarPaginaVisivel(entry.target);
    });
  }, { threshold: 0.85 });

  paginas.forEach(p => observer.observe(p.shell));
  paginas.forEach(atualizarEscalaVisualDaPagina);

  EL.listaSumario.innerHTML = "";
  sumario.forEach(item => montarItemSumario(item));

  await renderizarPagina(1);
  renderizarFaixa(1, 1);

  if (paginaComSalto) {
    atualizarDetalhe(`Na capa · avance para continuar da p.${paginaInicialLeitura}`);
    atualizarRodape(1, totalPags);
    renderizarFaixa(paginaInicialLeitura, 2);
    container.addEventListener("wheel", onWheelInicial, { passive: false });
    document.addEventListener("keydown", onKeydownInicial);
  } else {
    requestAnimationFrame(() => {
      leituraAtivada = true;
      sincronizarPaginaAtual();
      processarPaginasVisiveis("inicial");
    });
  }

  EL.carregando.style.display = "none";

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

  // ── Event listeners do PDF ────────────────────────────────────────────────────

  EL.btnIrPagina?.addEventListener("click", () =>
    irParaPagina(Number(EL.inputPagina.value) || paginaAtualVisual || 1)
  );
  EL.inputPagina?.addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    irParaPagina(Number(EL.inputPagina.value) || paginaAtualVisual || 1);
  });
  EL.btnMetaDaqui?.addEventListener("click",     definirMetaDaqui);
  EL.btnToggleSumario?.addEventListener("click", () => EL.painelSumario.classList.toggle("aberto"));
  EL.btnFecharSumario?.addEventListener("click", () => EL.painelSumario.classList.remove("aberto"));
  EL.btnZoomMenos?.addEventListener("click",     () => atualizarZoomPDF(zoomPDF - ZOOM_PASSO));
  EL.btnZoomMais?.addEventListener("click",      () => atualizarZoomPDF(zoomPDF + ZOOM_PASSO));
}

// ─── Inicialização ────────────────────────────────────────────────────────────

(async function init() {
  if (!bookId) {
    EL.carregando.textContent = "Nenhum livro especificado. Volte ao gate e selecione um livro.";
    return;
  }

  EL.btnConcluir.disabled    = true;
  EL.btnConcluir.textContent = `0 / ${metaTotal} ${tipoMeta === "chapter" ? "capítulo(s)" : "página(s)"}`;

  EL.btnAnterior?.addEventListener("click", paginaAnterior);
  EL.btnProximo?.addEventListener("click",  proximaPagina);
  EL.btnConcluir.addEventListener("click",  concluirLeitura);
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
    EL.carregando.style.display = "flex";
    EL.carregando.textContent   = `Erro: ${err.message}`;
    console.error("[anti-twitter] reader:", err);
  }
})();
