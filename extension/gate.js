// Pega a URL de destino (twitter/x.com) que estava sendo acessada
function getTargetUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("target") || "https://x.com/";
}

// Envia mensagem para o app.py via native messaging
async function callNative(message) {
  try {
    return await browser.runtime.sendNativeMessage("reader_gate_host", message);
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// Carrega lista de livros da pasta ~/Livros
async function loadBooks() {
  const res = await callNative({ action: "list_books" });
  const select = document.getElementById("bookSelect");
  select.innerHTML = "";

  if (!res.ok || !Array.isArray(res.books)) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Nenhum livro disponível (verifique ~/Livros)";
    select.appendChild(opt);
    return;
  }

  for (const book of res.books) {
    const opt = document.createElement("option");
    opt.value = book.id;
    opt.textContent = `${book.title} (${book.format})`;
    if (book.preselected) opt.selected = true;
    select.appendChild(opt);
  }
}

// Atualiza o status de acesso na tela
async function refreshStatus() {
  const res = await callNative({ action: "status" });
  const el = document.getElementById("status");

  if (!res.ok) {
    el.textContent = `Erro: ${res.error || "backend indisponível"}`;
    el.className = "erro";
    return;
  }

  if (res.allowed) {
    const mins = Math.round(res.remaining_minutes ?? 0);
    el.textContent = `✅ Acesso liberado! (expira em ${mins} min)`;
    el.className = "ok";
  } else if (res.current_session) {
    const s = res.current_session;
    el.textContent = `📖 Sessão ativa: ${s.amount} ${s.mode === "pages" ? "página(s)" : "capítulo(s)"} — marque como concluído quando terminar.`;
    el.className = "";
  } else {
    el.textContent = "❌ Acesso bloqueado. Inicie uma sessão de leitura.";
    el.className = "erro";
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const target = getTargetUrl();
  document.getElementById("targetInfo").textContent = `Destino: ${target}`;

  await loadBooks();
  await refreshStatus();

  // Iniciar sessão de leitura
  document.getElementById("startBtn").addEventListener("click", async () => {
    const bookId = document.getElementById("bookSelect").value;
    const mode = document.getElementById("modeSelect").value;
    const amount = Number(document.getElementById("amountInput").value);

    const res = await callNative({ action: "start_session", book_id: bookId, mode, amount });
    const el = document.getElementById("status");

    if (res.ok) {
      el.textContent = `📖 Sessão iniciada: leia ${amount} ${mode === "pages" ? "página(s)" : "capítulo(s)"} e clique em "Marcar como concluído".`;
      el.className = "";
    } else {
      el.textContent = `Erro ao iniciar: ${res.error || "desconhecido"}`;
      el.className = "erro";
    }
  });

  // Marcar leitura como concluída
  document.getElementById("completeBtn").addEventListener("click", async () => {
    const res = await callNative({ action: "complete_session" });
    const el = document.getElementById("status");

    if (res.ok) {
      el.textContent = "✅ Meta concluída! Acesso liberado.";
      el.className = "ok";
    } else {
      el.textContent = `Erro: ${res.error || "desconhecido"}`;
      el.className = "erro";
    }

    await refreshStatus();
  });

  // Entrar no X/Twitter
  document.getElementById("enterBtn").addEventListener("click", async () => {
    const res = await callNative({ action: "status" });

    if (res.ok && res.allowed) {
      window.location.href = target;
      return;
    }

    const el = document.getElementById("status");
    el.textContent = "❌ Ainda não liberado. Conclua a meta de leitura antes.";
    el.className = "erro";
  });
});
