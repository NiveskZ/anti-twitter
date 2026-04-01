# Anti-Twitter

Extensão para Firefox/Zen Browser que intercepta o acesso ao X/Twitter e exige que você leia um trecho de um livro antes de liberar o site.

## Como funciona

Ao tentar acessar `x.com` ou `twitter.com`, você é redirecionado para uma página intermediária onde deve:

1. Selecionar um livro da pasta `livros/`
2. Definir uma meta (capítulos ou páginas)
3. Marcar como concluído quando terminar
4. Clicar em "Entrar no X" — o acesso fica liberado por 60 minutos

## Requisitos

- Firefox ou Zen Browser (não compatível com Chrome/Brave)
- Python 3
- `gh` e `git` para contribuir

## Instalação

**1. Clone o repositório:**
```bash
git clone https://github.com/NiveskZ/anti-twitter.git
cd anti-twitter
```

**2. Adicione seus livros:**

Coloque arquivos `.epub` ou `.pdf` na pasta `livros/`.

**3. Instale o native messaging host:**
```bash
bash setup.sh
```

Isso registra o backend Python no Firefox/Zen para que a extensão consiga se comunicar com ele.

**4. Carregue a extensão:**

- Abra `about:debugging` no navegador
- Clique em "Carregar extensão temporária"
- Selecione o arquivo `extension/manifest.json`

## Configuração

No arquivo `anti_twitter/app.py` você pode ajustar:
```python
ACCESS_DURATION_MINUTES = 60  # tempo de acesso após completar a meta
BOOKS_DIR = Path(__file__).parent.parent / "livros"  # pasta dos livros
```

## Licença

MIT
