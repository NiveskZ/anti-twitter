// ─── Parâmetros da URL ────────────────────────────────────────────────────────

const params    = new URLSearchParams(window.location.search);
const bookId    = params.get("book");
const tipoMeta  = params.get("modo");    // "pages" ou "chapter"
const metaTotal = Number(params.get("amount")) || 1;

let progressoAtual = 0;

// ─── Utilitários ──────────────────────────────────────────────────────────────

/**
 * Carrega um script externo como uma Promise.
 * @param {string} url
 * @returns {Promise<void>}
 */
function carregarScript(url) {
  return new Promise((resolve, reject) => {
    const script   = document.createElement("script");
    script.src     = url;
    script.onload  = resolve;
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
  const pct = Math.min(100, Math.round((atual / total) * 100));

  document.getElementById("textoProgresso").textContent = `${atual} / ${total}`;
  document.getElementById("fillProgresso").style.width  = pct + "%";

  if (atual >= total) {
    const btn = document.getElementById("btnConcluirReader");
    btn.disabled        = false;
    btn.textContent     = "✅ Meta atingida — concluir";
    btn.style.background = "#1b5e1b";

    // Sinaliza ao gate.js (via storage) que a meta foi cumprida
    browser.storage.local.set({ meta_atingida: true });
  } else {
    // Atualiza o texto do botão com o progresso atual
    document.getElementById("btnConcluirReader").textContent =
      `${atual} / ${total} ${tipoMeta === "chapter" ? "cap" : "pág"}`;
  }
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
 * Inicializa o leitor epub.js.
 * @param {ArrayBuffer} arrayBuffer
 */
async function iniciarEpub(arrayBuffer) {
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
 * `threshold: 0.5` = dispara quando 50% do elemento está visível.
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
  document.getElementById("carregando").style.display = "none";

  const pdfDoc      = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const totalPaginas = pdfDoc.numPages;
  const paginasVistas = new Set(); // Set = conjunto sem duplicatas (como set() em Python)

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
        paginasVistas.add(Number(entry.target.dataset.pagina));
        atualizarProgresso(paginasVistas.size, metaTotal);
      }
    });
  }, { threshold: 0.5 });

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
