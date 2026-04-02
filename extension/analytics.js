/**
 * analytics.js - Módulo de coleta de dados comportamentais
 *
 * Este arquivo é incluído em todas as páginas da extensão via <script src="analytics.js">.
 * Ele define um objeto global `Analytics` com métodos para registrar, buscar e exportar eventos.
 *
 * CONCEITO JAVASCRIPT: Um objeto com métodos é como um "módulo" em JS.
 * Em Python seria equivalente a uma classe com métodos estáticos (@staticmethod).
 *
 * ESTRUTURA DE UM EVENTO:
 * {
 *   timestamp_ms: número (ex: 1712000000000) - milissegundos desde 01/01/1970
 *   data_hora:    string ISO (ex: "2025-04-01T14:30:00.000Z")
 *   dia_semana:   0–6 (0 = domingo)
 *   hora:         0–23
 *   minuto:       0–59
 *   evento:       "tentativa" | "sessao_iniciada" | "sessao_concluida" | "acesso_liberado" | "acesso_negado"
 *   site:         "x.com" | "twitter.com" | etc.
 *   modo:         "js" | "python"
 *   humor:        1–5 ou null 
 *   energia:      1–5 ou null
 *   livro:        string ou null
 *   tipo_meta:    "paginas" | "capitulos" | null
 *   quantidade_meta: número ou null
 * }
 */

const Analytics = {
  /**
   * Registra um evento no browser.storage.local.
   *
   * CONCEITO: `browser.storage.local` é como um dicionário persistente do navegador.
   * Em Python seria equivalente a um shelve ou um json salvo em arquivo.
   * O `await` pausa a execução até a Promise (operação assíncrona) terminar.
   *
   * @param {Object} dados - Campos do evento (campos ausentes viram null)
   */
  async registrar(dados) {
    const agora = new Date();
 
    // Spread operator (...): copia todos os campos de `dados` para o objeto.
    // Os campos definidos antes do spread são os valores padrão (como kwargs em Python).
    const evento = {
      timestamp_ms:    agora.getTime(),
      data_hora:       agora.toISOString(),
      dia_semana:      agora.getDay(),
      hora:            agora.getHours(),
      minuto:          agora.getMinutes(),
      evento:          null,
      site:            null,
      modo:            null,
      humor:           null,
      energia:         null,
      livro:           null,
      tipo_meta:       null,
      quantidade_meta: null,
      ...dados         // sobrescreve os nulls com os dados reais passados
    };
 
    // Busca o array existente de eventos (ou array vazio se não existe)
    const resultado = await browser.storage.local.get("analytics");
    const eventos = resultado.analytics || [];
 
    eventos.push(evento);
 
    // Mantém no máximo 10.000 registros para não estourar o storage (~5MB)
    if (eventos.length > 10000) {
      eventos.splice(0, eventos.length - 10000); // remove os mais antigos
    }
 
    await browser.storage.local.set({ analytics: eventos });
  },
 
  /**
   * Retorna todos os eventos registrados.
   */
  async buscarTodos() {
    const resultado = await browser.storage.local.get("analytics");
    return resultado.analytics || [];
  },
 
  /**
   * Exporta os eventos como string CSV.
   *
   * Esse CSV pode ser lido diretamente com pandas:
   *   import pandas as pd
   *   df = pd.read_csv("anti_twitter_analytics.csv")
   *   df["hora"].value_counts().sort_index().plot(kind="bar")  # pico de tentativas por hora
   *
   * @returns {string|null} - string CSV ou null se não há dados
   */
  async exportarCSV() {
    const eventos = await this.buscarTodos();
    if (eventos.length === 0) return null;
 
    // Define a ordem e os nomes das colunas
    const cabecalhos = [
      "timestamp_ms", "data_hora", "dia_semana", "hora", "minuto",
      "evento", "site", "modo", "humor", "energia",
      "livro", "tipo_meta", "quantidade_meta"
    ];
 
    // Mapeia cada evento para uma linha CSV
    const linhas = eventos.map(e =>
      cabecalhos.map(col => {
        const val = e[col];
        if (val === null || val === undefined) return "";
        // Envolve em aspas se contém vírgula
        const str = String(val);
        return str.includes(",") ? `"${str}"` : str;
      }).join(",")
    );
 
    return [cabecalhos.join(","), ...linhas].join("\n");
  },
 
  /**
   * Retorna um resumo rápido dos dados (para exibir na options page).
   * Esse tipo de análise descritiva é o primeiro passo em qualquer projeto de DS.
   */
  async resumo() {
    const eventos = await this.buscarTodos();
    if (eventos.length === 0) return null;
 
    const tentativas = eventos.filter(e => e.evento === "tentativa");
    const concluidas = eventos.filter(e => e.evento === "sessao_concluida");
 
    // Contagem por hora (para identificar picos de vulnerabilidade)
    const porHora = new Array(24).fill(0);
    tentativas.forEach(e => porHora[e.hora]++);
    const horaPico = porHora.indexOf(Math.max(...porHora));
 
    // Taxa de conclusão
    const iniciadas = eventos.filter(e => e.evento === "sessao_iniciada").length;
    const taxaConclusao = iniciadas > 0 ? Math.round((concluidas.length / iniciadas) * 100) : 0;
 
    // Humor médio (se disponível)
    const comHumor = eventos.filter(e => e.humor !== null);
    const humorMedio = comHumor.length > 0
      ? (comHumor.reduce((s, e) => s + e.humor, 0) / comHumor.length).toFixed(1)
      : null;
 
    return {
      total_eventos:   eventos.length,
      total_tentativas: tentativas.length,
      taxa_conclusao:  taxaConclusao,
      hora_pico:       horaPico,
      humor_medio:     humorMedio,
      registros_humor: comHumor.length
    };
  },
 
  async limpar() {
    await browser.storage.local.set({ analytics: [] });
  }
};