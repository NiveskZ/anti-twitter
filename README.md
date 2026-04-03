# Anti-Twitter

Extensão para Firefox/Zen Browser que intercepta o acesso a sites configuráveis e exige que você complete uma meta de leitura antes de liberar o acesso.

## Como funciona

Ao tentar acessar um site bloqueado (por padrão x.com e twitter.com), você é redirecionado para uma página intermediária onde deve:

1. Selecionar um livro
2. Definir uma meta (capítulos ou páginas)
3. Ler e marcar como concluído quando terminar
4. Clicar em "Entrar no site" — o acesso fica liberado pelo tempo configurado (padrão: 60 minutos)

## Modos de operação

### Modo JS (recomendado para novos usuários)
Sem instalação adicional além da extensão. Livros armazenados no browser via IndexedDB. Leitor de epub e PDF embutido com sumário, zoom e bookmark automático.

### Modo Python (recomendado para quem já usa)
Requer Python 3 e execução do `setup.sh`. Abre livros no seu aplicativo favorito (Calibre, Okular, etc.).

## Requisitos

- Firefox ou Zen Browser (não compatível com Chrome/Brave)
- Python 3 — apenas para o modo Python

## Instalação

**1. Clone o repositório:**
```bash
git clone https://github.com/NiveskZ/anti-twitter.git
cd anti-twitter
```

**2. Carregue a extensão no navegador:**
- Abra `about:debugging`
- Clique em "Carregar extensão temporária"
- Selecione o arquivo `manifest.json`

**3. (Opcional — modo Python) Adicione livros e instale o host:**
```bash
# Coloque arquivos .epub ou .pdf na pasta livros/
bash setup.sh
```

**4. Configure o modo em ⚙️ Configurações** (acessível pela página de bloqueio)

## Leitor inline (modo JS)

O leitor abre numa aba dedicada com:

- **Sumário lateral** navegável por clique
- **Zoom** ajustável (A- / A+), persistido entre sessões
- **Bookmark automático** — retoma exatamente onde parou
- **Campo "Começar da página"** no gate pré-preenchido com o bookmark
- **Rodapé de navegação** com número de página e campo para ir direto
- **Meta daqui** — redefine o ponto de partida da contagem sem reiniciar a sessão
- **Threshold de 85%** — a página só conta quando 85% dela está visível

## Configurações disponíveis

- Modo de operação (JS ou Python)
- Sites bloqueados — adicione qualquer domínio além dos padrões
- Duração do acesso após completar a meta
- Granularidade do outline para contagem de capítulos:
  - Máximo de páginas por seção
  - Margem antes de descer um nível no outline
  - Mínimo de páginas por seção (agrupa microseções)
- Gerenciamento de livros (modo JS)

## Analytics para Ciência de Dados

A extensão coleta dados de comportamento localmente. Nenhum dado sai do seu dispositivo.

Campos coletados por evento:

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `timestamp_ms` | int | Unix timestamp em ms |
| `hora` | 0–23 | Hora da tentativa |
| `dia_semana` | 0–6 | 0 = domingo |
| `evento` | string | tentativa, sessao_iniciada, sessao_concluida, acesso_liberado |
| `humor` | 1–5 ou null | Auto-reportado antes da sessão |
| `energia` | 1–5 ou null | Auto-reportado antes da sessão |
| `livro` | string | Título do livro lido |

**Exportar e analisar com pandas:**
```python
import pandas as pd

df = pd.read_csv("anti_twitter_analytics.csv")

# Tentativas por hora do dia
df[df["evento"] == "tentativa"]["hora"] \
  .value_counts().sort_index() \
  .plot(kind="bar", title="Tentativas por hora")

# Taxa de conclusão por dia da semana
concluidas = df[df["evento"] == "sessao_concluida"].groupby("dia_semana").size()
iniciadas  = df[df["evento"] == "sessao_iniciada"].groupby("dia_semana").size()
(concluidas / iniciadas).plot(kind="bar", title="Taxa de conclusão por dia")
```

O CSV pode ser exportado em ⚙️ Configurações → Seus dados de comportamento.

## Privacidade e segurança

- Todos os dados ficam exclusivamente no seu dispositivo
- Nenhuma requisição de rede é feita pela extensão
- Livros (modo JS) armazenados no IndexedDB do perfil do Firefox
- O código é aberto e auditável

## Licença

MIT

---

## Histórico de mudanças

### v0.4
- Leitor inline para PDF e EPUB com rastreamento de progresso
- Detecção de capítulos em PDF por `pdfDoc.getOutline()` (outline nativo)
- Bookmark de página/posição salvo em `browser.storage.local`
- Campo "Começar da página" no gate pré-preenchido com bookmark
- Retomada estrutural no EPUB com bookmark por CFI
- Abertura pela capa com salto intencional no primeiro gesto
- Threshold de leitura em 85%
- Granularidade configurável por seção (máximo, margem, mínimo)
- Agrupamento de microseções no outline
- "Meta daqui" para redefinir a base da sessão sem reiniciar
- Rodapé com página atual e navegação manual
- Sumário lateral navegável no leitor
- Zoom próprio no leitor (PDF e EPUB), persistido via bookmark
- Seleção automática do último livro aberto no gate
- options.html com botão "Voltar ao gate"
- Correção da remoção de sites bloqueados e livros no modo JS
- Substituição de onclick inline por addEventListener

### v0.3
- Modo JS: leitor inline de epub e PDF sem Python
- Sites bloqueados configuráveis pelo usuário
- Página de configurações (⚙️)
- Analytics com exportação para CSV
- Coleta de humor e energia para análise comportamental

### v0.2
- Primeira versão com native messaging Python
- Bloqueio de x.com e twitter.com
- Meta de leitura por capítulos ou páginas
