// ─── Parâmetros da URL ────────────────────────────────────────────────────────

const params    = new URLSearchParams(window.location.search);
const bookId    = params.get("book");
const tipoMeta  = params.get("modo");    // "pages" ou "chapter"
const metaTotal = Number(params.get("amount")) || 1;
const offsetManual = Math.max(0, Number(params.get("offset")) || 0);

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
    const scriptExistente = document.querySelector(`script[src="${url}"]`);
    if (scriptExistente) {
      if (scriptExistente.dataset.carregado === "true") {
        resolve();
        return;
      }

      scriptExistente.addEventListener("load", resolve, { once: true });
      scriptExistente.addEventListener(
        "error",
        () => reject(new Error(`Falha ao carregar: ${url}`)),
        { once: true }
      );
      return;
    }

    const script   = document.createElement("script");
    script.src     = url;
    script.onload  = () => {
      script.dataset.carregado = "true";
      resolve();
    };
    script.onerror = () => reject(new Error(`Falha ao carregar: ${url}`));
    document.head.appendChild(script);
  });
}

/**
 * Atualiza barra de progresso e o botão da barra superior.
 * @param {number} atual
 * @param {number} total
 */
function atualizarProgresso(atual, total) {
  progressoAtual = atual;
  const progressoSeguro = Math.max(0, atual);
  const pct = Math.min(100, Math.round((progressoSeguro / total) * 100));

  document.getElementById("textoProgresso").textContent = `${progressoSeguro} / ${total}`;
  document.getElementById("fillProgresso").style.width  = pct + "%";

  if (progressoSeguro >= total) {
    const btn = document.getElementById("btnConcluirReader");
    btn.disabled        = false;
    btn.textContent     = "✅ Meta atingida — concluir";
    btn.style.background = "#1b5e1b";

    // Sinaliza ao gate.js (via storage) que a meta foi cumprida
    browser.storage.local.set({ meta_atingida: true });
  } else {
    // Atualiza o texto do botão com o progresso atual
    document.getElementById("btnConcluirReader").textContent =
      `${progressoSeguro} / ${total} ${tipoMeta === "chapter" ? "cap" : "pág"}`;
  }
}

function atualizarDetalheProgresso(texto = "") {
  document.getElementById("detalheProgresso").textContent = texto;
}

function mostrarIndicadorContagem(texto) {
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
  const btn = document.getElementById("btnConcluirReader");
  btn.textContent = "✅ Acesso liberado!";
  setTimeout(() => window.close(), 1200);
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

// ─── Leitor EPUB ──────────────────────────────────────────────────────────────

let rendition = null;

/**
 * Normaliza o texto extraído do PDF para facilitar heurísticas simples.
 * @param {string} texto
 * @returns {string}
 */
function normalizarTextoPagina(texto) {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extrai o texto de uma página do PDF como string única.
 * @param {PDFDocumentProxy} pdfDoc
 * @param {number} numeroPagina
 * @returns {Promise<string>}
 */
async function extrairTextoPagina(pdfDoc, numeroPagina) {
  const pagina = await pdfDoc.getPage(numeroPagina);
  const conteudo = await pagina.getTextContent();
  return conteudo.items.map(item => item.str).join(" ");
}

function normalizarLinha(texto) {
  return normalizarTextoPagina(texto).replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
}

function extrairCabecalhoPagina(textoNormalizado) {
  return textoNormalizado.slice(0, 240);
}

function detectarMarcadoresPagina(textoNormalizado) {
  const cabecalho = extrairCabecalhoPagina(textoNormalizado);
  const temSumario = /\b(sumario|contents)\b/.test(cabecalho);
  const temCapitulo = /\b(capitulo|chapter)\s+(\d+|[ivxlcdm]+)\b/.test(cabecalho);
  const temReferencias = /\b(referencias|bibliografia|bibliography|references|works cited)\b/.test(cabecalho);

  return {
    capitulo: temCapitulo && !temSumario,
    referencias: temReferencias && !temSumario
  };
}

function parecePaginaDeSumario(textoNormalizado) {
  const cabecalho = extrairCabecalhoPagina(textoNormalizado);
  return /\b(sumario|contents)\b/.test(cabecalho);
}

function tituloDeveSerIgnorado(titulo) {
  return [
    "sumario", "contents", "acknowledgments", "acknowledgements", "about the author",
    "bibliografia", "bibliography", "references", "referencias", "index"
  ].includes(titulo);
}

function tituloPareceCapituloRelevante(titulo) {
  if (!titulo || tituloDeveSerIgnorado(titulo)) return false;

  return /\b(capitulo|chapter|parte|part|introducao|introduction|prologo|prologue|epilogo|epilogue)\b/.test(titulo)
    || titulo.split(" ").length >= 2
    || titulo.length >= 5;
}

function extrairEntradasDeSumario(textoPagina) {
  const linhas = textoPagina
    .split("\n")
    .map(linha => linha.trim())
    .filter(Boolean);

  const entradas = [];

  for (let i = 0; i < linhas.length; i++) {
    const linhaAtual = normalizarLinha(linhas[i]);
    const proximaLinha = normalizarLinha(linhas[i + 1] || "");

    if (!linhaAtual || /^\d+$/.test(linhaAtual)) continue;

    const matchMesmaLinha = linhaAtual.match(/^(.*?)(\d+|[ivxlcdm]+)$/i);
    if (matchMesmaLinha && tituloPareceCapituloRelevante(matchMesmaLinha[1].trim())) {
      entradas.push({
        titulo: matchMesmaLinha[1].trim(),
        paginaRotulo: matchMesmaLinha[2].trim()
      });
      continue;
    }

    if (/^(\d+|[ivxlcdm]+)$/i.test(proximaLinha) && tituloPareceCapituloRelevante(linhaAtual)) {
      entradas.push({
        titulo: linhaAtual,
        paginaRotulo: proximaLinha
      });
      i++;
    }
  }

  return entradas;
}

function paginaRotuloParaNumero(paginaRotulo) {
  if (/^\d+$/.test(paginaRotulo)) {
    return Number(paginaRotulo);
  }

  const mapa = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  const texto = paginaRotulo.toLowerCase();
  let total = 0;
  let anterior = 0;

  for (let i = texto.length - 1; i >= 0; i--) {
    const valor = mapa[texto[i]] || 0;
    if (valor < anterior) total -= valor;
    else total += valor;
    anterior = valor;
  }

  return total || null;
}

function encontrarPaginaPorTitulo(titulo, paginasNormalizadas, paginaMinima = 1) {
  if (!titulo) return null;

  const tituloLimpo = titulo.replace(/\b(capitulo|chapter|parte|part)\b\s*[\divxlcdm-]*/g, "").trim();
  const alvo = tituloLimpo || titulo;

  for (let i = paginaMinima - 1; i < paginasNormalizadas.length; i++) {
    const cabecalho = extrairCabecalhoPagina(paginasNormalizadas[i]);
    if (cabecalho.includes(alvo)) {
      return i + 1;
    }
  }

  return null;
}

function detectarCapitulosPorSumario(entradasSumario, paginasNormalizadas, totalPaginas, paginaMinimaBusca) {
  if (entradasSumario.length === 0) return [];

  let deslocamento = null;
  for (const entrada of entradasSumario) {
    const paginaRotulo = paginaRotuloParaNumero(entrada.paginaRotulo);
    const paginaReal = encontrarPaginaPorTitulo(entrada.titulo, paginasNormalizadas, paginaMinimaBusca);

    if (paginaRotulo && paginaReal) {
      deslocamento = paginaReal - paginaRotulo;
      break;
    }
  }

  if (deslocamento === null) return [];

  const capitulos = entradasSumario
    .map(entrada => {
      const paginaRotulo = paginaRotuloParaNumero(entrada.paginaRotulo);
      if (!paginaRotulo) return null;

      return {
        titulo: entrada.titulo,
        inicio: paginaRotulo + deslocamento
      };
    })
    .filter(Boolean)
    .filter((entrada, indice, lista) => {
      const proxima = lista[indice + 1];
      return entrada.inicio >= 1
        && entrada.inicio <= totalPaginas
        && (!proxima || entrada.inicio < proxima.inicio);
    });

  return capitulos;
}

function paginaEstaEmIntervalo(numeroPagina, intervalos) {
  return intervalos.some(intervalo =>
    numeroPagina >= intervalo.inicio && numeroPagina <= intervalo.fim
  );
}

function contarPaginasContaveis(inicio, fim, intervalosIgnorados) {
  let total = 0;
  for (let pagina = inicio; pagina <= fim; pagina++) {
    if (!paginaEstaEmIntervalo(pagina, intervalosIgnorados)) {
      total++;
    }
  }
  return total;
}

function montarCapitulos(paginasCapitulo, paginasReferencia, paginaInicialLeitura, totalPaginas) {
  const capitulos = [];

  paginasCapitulo
    .filter(pagina => pagina >= paginaInicialLeitura)
    .forEach((inicio, indice, lista) => {
      const proximoCapitulo = lista[indice + 1] || (totalPaginas + 1);
      const proximaReferencia = paginasReferencia.find(pagina =>
        pagina > inicio && pagina < proximoCapitulo
      );
      const fim = (proximaReferencia || proximoCapitulo) - 1;

      capitulos.push({
        titulo: `Capítulo ${capitulos.length + 1}`,
        inicio,
        fim: Math.max(inicio, fim)
      });
    });

  return capitulos;
}

function montarIntervalosIgnorados(paginaInicialLeitura, paginasReferencia, paginasCapitulo, totalPaginas) {
  const intervalos = [];

  if (paginaInicialLeitura > 1) {
    intervalos.push({
      inicio: 1,
      fim: paginaInicialLeitura - 1,
      motivo: "introducao"
    });
  }

  paginasReferencia
    .filter(pagina => pagina >= paginaInicialLeitura)
    .forEach(inicio => {
      const proximoCapitulo = paginasCapitulo.find(pagina => pagina > inicio);
      intervalos.push({
        inicio,
        fim: (proximoCapitulo || (totalPaginas + 1)) - 1,
        motivo: "referencias"
      });
    });

  return intervalos;
}

function encontrarCapituloAtual(capitulos, numeroPagina) {
  return capitulos.findIndex(capitulo =>
    numeroPagina >= capitulo.inicio && numeroPagina <= capitulo.fim
  );
}

function concluirCapituloSeNecessario(capitulo, indiceCapitulo, paginasVistas, paginasConcluidasPorCapitulo, numeroPaginaAtual) {
  if (!capitulo) return false;

  const paginasLidasNoCapitulo = Array.from(paginasVistas).filter(pagina =>
    pagina >= capitulo.inicio && pagina <= capitulo.fim
  ).length;
  const percentualLido = capitulo.totalPaginas === 0 ? 0 : paginasLidasNoCapitulo / capitulo.totalPaginas;
  const estaNaUltimaPagina = numeroPaginaAtual === capitulo.fim;

  if (estaNaUltimaPagina && percentualLido >= 0.9) {
    paginasConcluidasPorCapitulo.add(indiceCapitulo);
    return true;
  }

  return false;
}

/**
 * Extrai uma estrutura simples do PDF baseada em páginas de capítulo.
 * É mais confiável começar a contagem quando aparece o primeiro capítulo
 * do que tentar adivinhar capa, prefácio e sumário separadamente.
 *
 * @param {PDFDocumentProxy} pdfDoc
 * @param {number} totalPaginas
 * @returns {Promise<{capitulos: Array<{inicio: number, fim: number, totalPaginas: number}>, intervalosIgnorados: Array<{inicio: number, fim: number, motivo: string}>, paginaInicialLeitura: number, totalPaginasContaveis: number}>}
 */
async function detectarEstruturaPdf(pdfDoc, totalPaginas) {
  const paginasCapitulo = [];
  const paginasReferencia = [];
  const paginasNormalizadas = [];
  const paginasBrutas = [];

  document.getElementById("carregando").textContent = "Analisando estrutura do livro…";

  for (let i = 1; i <= totalPaginas; i++) {
    const textoBruto = await extrairTextoPagina(pdfDoc, i);
    const texto = normalizarTextoPagina(textoBruto);
    paginasBrutas.push(textoBruto);
    paginasNormalizadas.push(texto);
    const marcadores = detectarMarcadoresPagina(texto);

    if (marcadores.capitulo) {
      paginasCapitulo.push(i);
    }
    if (marcadores.referencias) {
      paginasReferencia.push(i);
    }
  }

  const paginasDeSumario = paginasNormalizadas
    .map((texto, indice) => parecePaginaDeSumario(texto) ? indice + 1 : null)
    .filter(Boolean);
  const entradasSumario = paginasDeSumario.flatMap(numeroPagina =>
    extrairEntradasDeSumario(paginasBrutas[numeroPagina - 1])
  );
  const capitulosDoSumario = detectarCapitulosPorSumario(
    entradasSumario,
    paginasNormalizadas,
    totalPaginas,
    (paginasDeSumario.at(-1) || 0) + 1
  );
  const paginasCapituloDetectadas = capitulosDoSumario.length > 0
    ? capitulosDoSumario.map(capitulo => capitulo.inicio)
    : paginasCapitulo;
  const primeiraPaginaCapitulo = paginasCapituloDetectadas[0] || 1;
  const paginaInicialLeitura = Math.max(primeiraPaginaCapitulo, offsetManual + 1);
  const intervalosIgnorados = montarIntervalosIgnorados(
    paginaInicialLeitura,
    paginasReferencia,
    paginasCapituloDetectadas,
    totalPaginas
  );
  const capitulosBase = capitulosDoSumario.length > 0
    ? capitulosDoSumario
        .filter(capitulo => capitulo.inicio >= paginaInicialLeitura)
        .map((capitulo, indice, lista) => {
          const proximoCapitulo = lista[indice + 1]?.inicio || (totalPaginas + 1);
          const proximaReferencia = paginasReferencia.find(pagina =>
            pagina > capitulo.inicio && pagina < proximoCapitulo
          );

          return {
            titulo: capitulo.titulo,
            inicio: capitulo.inicio,
            fim: Math.max(capitulo.inicio, (proximaReferencia || proximoCapitulo) - 1)
          };
        })
    : montarCapitulos(
        paginasCapituloDetectadas,
        paginasReferencia,
        paginaInicialLeitura,
        totalPaginas
      );
  const capitulos = capitulosBase.map(capitulo => ({
    ...capitulo,
    totalPaginas: contarPaginasContaveis(capitulo.inicio, capitulo.fim, intervalosIgnorados)
  }));

  const totalPaginasContaveis = contarPaginasContaveis(
    paginaInicialLeitura,
    totalPaginas,
    intervalosIgnorados
  );

  return {
    capitulos,
    intervalosIgnorados,
    paginaInicialLeitura,
    totalPaginasContaveis
  };
}

/**
 * Inicializa o leitor epub.js.
 * @param {ArrayBuffer} arrayBuffer
 */
async function iniciarEpub(arrayBuffer) {
  await carregarScript(
    "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"
  );
  await carregarScript(
    "https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js"
  );

  document.getElementById("viewerEpub").style.display = "block";
  document.getElementById("carregando").style.display = "none";

  // `ePub` é o objeto global exposto pela biblioteca após carregar
  const livro = ePub(arrayBuffer);
  rendition   = livro.renderTo("viewerEpub", {
    width:  "100%",
    height: "100%",
    flow:   "paginated"
  });

  rendition.display(); // exibe o início do livro

  // Rastreia progresso conforme o tipo de meta
  let paginasViradas = 0;
  rendition.on("relocated", location => {
    paginasViradas++;
    const progresso = tipoMeta === "chapter"
      ? location.start.index  // número do capítulo
      : paginasViradas;        // número de páginas viradas
    atualizarProgresso(progresso, metaTotal);
  });
}

// Essas funções são globais para serem chamadas pelos botões no HTML
function paginaAnterior() { if (rendition) rendition.prev(); }
function proximaPagina()  { if (rendition) rendition.next(); }

// Navegação por teclado — acessibilidade básica
document.addEventListener("keydown", e => {
  if (e.key === "ArrowLeft")  paginaAnterior();
  if (e.key === "ArrowRight") proximaPagina();
});

// ─── Leitor PDF ───────────────────────────────────────────────────────────────

/**
 * Inicializa o leitor PDF.js e renderiza todas as páginas.
 * 
 * `threshold: 0.85` = dispara quando 85% do elemento está visível.
 * Usamos isso para detectar quais páginas o usuário realmente leu.
 * @param {ArrayBuffer} arrayBuffer
 */
async function iniciarPDF(arrayBuffer) {
  await carregarScript(
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"
  );

  // Worker precisa ser configurado ANTES de carregar qualquer PDF
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  const container = document.getElementById("viewerPDF");
  container.style.display = "flex";

  const pdfDoc      = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const totalPaginas = pdfDoc.numPages;
  const paginasVistas = new Set(); // Set = conjunto sem duplicatas (como set() em Python)
  const estrutura = await detectarEstruturaPdf(pdfDoc, totalPaginas);
  const { capitulos, intervalosIgnorados, totalPaginasContaveis } = estrutura;
  const paginasConcluidasPorCapitulo = new Set();

  document.getElementById("carregando").style.display = "none";
  atualizarDetalheProgresso(`Livro: 0 / ${totalPaginasContaveis} páginas válidas`);

  // Renderiza todas as páginas em canvas sequencialmente
  for (let i = 1; i <= totalPaginas; i++) {
    const pagina   = await pdfDoc.getPage(i);
    const viewport = pagina.getViewport({ scale: 1.4 }); // escala de leitura confortável

    const canvas     = document.createElement("canvas");
    const ctx        = canvas.getContext("2d");  // contexto 2D para desenho
    canvas.width     = viewport.width;
    canvas.height    = viewport.height;
    canvas.dataset.pagina = i; // guarda o número da página para o Observer

    // render() é assíncrono — precisamos de await para garantir ordem
    await pagina.render({ canvasContext: ctx, viewport }).promise;
    container.appendChild(canvas);
  }

  // Observer que rastreia quais páginas o usuário visualizou
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const numeroPagina = Number(entry.target.dataset.pagina);
        const canvas = entry.target;

        if (paginaEstaEmIntervalo(numeroPagina, intervalosIgnorados)) {
          canvas.classList.add("ignorada");
          mostrarIndicadorContagem(`Página ${numeroPagina} ignorada`);
          return;
        }

        paginasVistas.add(numeroPagina);
        canvas.classList.add("lida");

        if (tipoMeta === "chapter" && capitulos.length > 0) {
          const indiceCapitulo = encontrarCapituloAtual(capitulos, numeroPagina);
          const capituloAtual = capitulos[indiceCapitulo];

          if (capituloAtual) {
            const paginasLidasNoCapitulo = Array.from(paginasVistas).filter(pagina =>
              pagina >= capituloAtual.inicio && pagina <= capituloAtual.fim
            ).length;
            const concluiuAgora = concluirCapituloSeNecessario(
              capituloAtual,
              indiceCapitulo,
              paginasVistas,
              paginasConcluidasPorCapitulo,
              numeroPagina
            );

            atualizarDetalheProgresso(
              `${capituloAtual.titulo || `Capítulo ${indiceCapitulo + 1}`}: ${paginasLidasNoCapitulo} / ${capituloAtual.totalPaginas} páginas · Livro: ${paginasVistas.size} / ${totalPaginasContaveis}`
            );
            mostrarIndicadorContagem(
              concluiuAgora
                ? `${capituloAtual.titulo || `Capítulo ${indiceCapitulo + 1}`} concluído`
                : `Página ${numeroPagina} contabilizada`
            );
          }

          atualizarProgresso(paginasConcluidasPorCapitulo.size, metaTotal);
          return;
        }

        atualizarProgresso(paginasVistas.size, metaTotal);
        atualizarDetalheProgresso(
          `Livro: ${paginasVistas.size} / ${totalPaginasContaveis} páginas válidas`
        );
        mostrarIndicadorContagem(`Página ${numeroPagina} contabilizada`);
      }
    });
  }, { threshold: 0.85 });

  // Começa a observar cada canvas
  container.querySelectorAll("canvas").forEach(c => observer.observe(c));
}

// ─── Inicialização ────────────────────────────────────────────────────────────

(async function init() {
  if (!bookId) {
    document.getElementById("carregando").textContent =
      "Nenhum livro especificado. Volte ao gate e selecione um livro.";
    return;
  }

  // Configura o botão com o estado inicial (meta não atingida)
  const btn = document.getElementById("btnConcluirReader");
  btn.disabled    = true;
  btn.textContent = `0 / ${metaTotal} ${tipoMeta === "chapter" ? "capítulo(s)" : "página(s)"}`;

  // ─── Event listeners ──────────────────────────────────────────────────────────
  document.getElementById("btnAnterior").addEventListener("click", paginaAnterior);
  document.getElementById("btnProximo").addEventListener("click", proximaPagina);
  document.getElementById("btnConcluirReader").addEventListener("click", concluirLeitura);

  // Navegação por teclado
  document.addEventListener("keydown", e => {
    if (e.key === "ArrowLeft")  paginaAnterior();
    if (e.key === "ArrowRight") proximaPagina();
  });

  try {
    const registro = await BookDB.buscar(bookId);

    if (!registro) {
      throw new Error("Livro não encontrado. Pode ter sido removido.");
    }

    document.getElementById("tituloLivro").textContent = registro.nome;

    // Despacha para o leitor correto
    if (registro.formato === "epub") {
      await iniciarEpub(registro.dados);
    } else if (registro.formato === "pdf") {
      await iniciarPDF(registro.dados);
    } else {
      throw new Error(`Formato não suportado: ${registro.formato}`);
    }

  } catch (err) {
    document.getElementById("carregando").style.display = "flex";
    document.getElementById("carregando").textContent   = `Erro: ${err.message}`;
    console.error("[anti-twitter] reader:", err);
  }
})();
