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
    // Atualiza o texto do botão com o progresso atual
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
 
  Só usamos os itens do NÍVEL 0 (top-level). Seções (1.1, 1.2...) ficam
  em `item.items` (nível 1) e são ignoradas automaticamente.
*/
 
const TITULOS_ESTRUTURAIS = /^\s*(cover|title page|copyright|contents|table of contents|index|bibliography|references|about the author|acknowledgements?)\s*$/i;
 
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
 
/**
 * Extrai capítulos do outline do PDF (nível 0 apenas).
 * @param {PDFDocumentProxy} pdfDoc
 * @returns {Promise<Array<{titulo: string, pagina: number}>>}
 */
async function detectarCapitulosDoOutline(pdfDoc) {
  const outline = await pdfDoc.getOutline();
  if (!outline || outline.length === 0) return [];
 
  const capitulos = [];
  for (const item of outline) {
    if (TITULOS_ESTRUTURAIS.test(item.title || "")) continue;
    const pagina = await resolverPaginaDoOutline(pdfDoc, item.dest);
    if (pagina) capitulos.push({ titulo: item.title || "", pagina });
  }
  return capitulos;
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
 
/**
 * Marca um capítulo como concluído quando 80% das suas páginas foram vistas.
 * Não exige chegar na última página — o leitor pode parar antes dos exercícios.
 */
function concluirCapituloSeNecessario(capitulo, indice, paginasVistas, concluidosPorIdx) {
  if (!capitulo || concluidosPorIdx.has(indice)) return false;
 
  const lidas      = Array.from(paginasVistas).filter(p => p >= capitulo.inicio && p <= capitulo.fim).length;
  const percentual = capitulo.totalPaginas === 0 ? 0 : lidas / capitulo.totalPaginas;
 
  if (percentual >= 0.8) {
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
 
  let capitulosRaw = await detectarCapitulosDoOutline(pdfDoc);
  if (capitulosRaw.length === 0) {
    capitulosRaw = await detectarCapitulosDeTexto(pdfDoc, totalPaginas);
  }
 
  // Determina página inicial de leitura
  let paginaInicialLeitura = paginaInicial;
  if (paginaInicial <= 1 && capitulosRaw.length > 0) {
    // Pula prefácio/introdução — usa o primeiro item que parece capítulo numerado
    const primeiroCap = capitulosRaw.find(c =>
      !/\b(preface|prefacio|foreword|introduction|introducao)\b/i.test(c.titulo)
    ) || capitulosRaw[0];
    paginaInicialLeitura = primeiroCap.pagina;
  }
 
  const intervalosIgnorados = paginaInicialLeitura > 1
    ? [{ inicio: 1, fim: paginaInicialLeitura - 1, motivo: "introducao" }]
    : [];
 
  const capitulos = capitulosRaw
    .filter(cap => cap.pagina >= paginaInicialLeitura)
    .map((cap, i, lista) => {
      const fim = (lista[i + 1]?.pagina ?? totalPaginas + 1) - 1;
      return {
        titulo:       cap.titulo,
        inicio:       cap.pagina,
        fim:          Math.max(cap.pagina, fim),
        totalPaginas: contarPaginasContaveis(cap.pagina, fim, intervalosIgnorados)
      };
    });
 
  const totalPaginasContaveis = contarPaginasContaveis(
    paginaInicialLeitura, totalPaginas, intervalosIgnorados
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
 
  const pdfDoc   = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const totalPags = pdfDoc.numPages;
  const estrutura = await detectarEstrutura(pdfDoc, totalPags);
  const { capitulos, intervalosIgnorados, paginaInicialLeitura, totalPaginasContaveis } = estrutura;
  const paginasVistas             = new Set();
  const capitulosConcluidosPorIdx = new Set();
 
  document.getElementById("carregando").style.display = "none";
  atualizarDetalhe(`0 / ${totalPaginasContaveis} páginas válidas`);
 
  // Renderiza todas as páginas como canvas
  for (let i = 1; i <= totalPags; i++) {
    const pagina   = await pdfDoc.getPage(i);
    const viewport = pagina.getViewport({ scale: 1.4 });
    const canvas   = document.createElement("canvas");
    canvas.width   = viewport.width;
    canvas.height  = viewport.height;
    canvas.dataset.pagina = i;
    await pagina.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    container.appendChild(canvas);
  }
 
  // Observer: conta páginas realmente lidas (85% visível)
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
 
      const numPag = Number(entry.target.dataset.pagina);
      const canvas = entry.target;
 
      // Salva bookmark a cada página, mesmo antes do início da contagem
      if (bookId) salvarBookmark(bookId, numPag);
 
      // Página antes do início — marca visualmente, não conta
      if (paginaEstaEmIntervalo(numPag, intervalosIgnorados)) {
        canvas.classList.add("ignorada");
        mostrarIndicador(`p.${numPag} ignorada`);
        return;
      }
 
      paginasVistas.add(numPag);
      canvas.classList.add("lida");
 
      if (tipoMeta === "chapter" && capitulos.length > 0) {
        const idx = encontrarCapituloAtual(capitulos, numPag);
        const cap = capitulos[idx];
 
        if (cap) {
          const lidas    = Array.from(paginasVistas).filter(p => p >= cap.inicio && p <= cap.fim).length;
          const concluiu = concluirCapituloSeNecessario(cap, idx, paginasVistas, capitulosConcluidosPorIdx);
 
          atualizarDetalhe(
            `${cap.titulo || `Cap. ${idx + 1}`}: ${lidas}/${cap.totalPaginas} · Total: ${paginasVistas.size}/${totalPaginasContaveis}`
          );
          mostrarIndicador(concluiu
            ? `${cap.titulo || `Cap. ${idx + 1}`} concluído`
            : `p.${numPag} contabilizada`
          );
        }
        atualizarProgresso(capitulosConcluidosPorIdx.size, metaTotal);
        return;
      }
 
      // Modo páginas
      atualizarProgresso(paginasVistas.size, metaTotal);
      atualizarDetalhe(`${paginasVistas.size} / ${totalPaginasContaveis} páginas válidas`);
      mostrarIndicador(`p.${numPag} contabilizada`);
    });
  }, { threshold: 0.85 });
 
  container.querySelectorAll("canvas").forEach(c => observer.observe(c));
 
  // Scroll para a página inicial (bookmark ou configuração manual)
  if (paginaInicialLeitura > 1) {
    const alvo = container.querySelector(`canvas[data-pagina="${paginaInicialLeitura}"]`);
    if (alvo) setTimeout(() => alvo.scrollIntoView({ behavior: "instant" }), 80);
  }
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
