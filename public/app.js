
const $ = (selector) => document.querySelector(selector);

let currentUser = null;
let authMode = "login";

const money = (value) =>
  Number(value || 0).toLocaleString("fr-FR", {
    style: "decimal",
    maximumFractionDigits: 2
  }) + " crédits";

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Une erreur est survenue.");
  return data;
}

function showMessage(message, isError = false, target = "#page-message") {
  const element = $(target);
  if (!element) return;
  element.textContent = message;
  element.classList.toggle("error", isError);
}

function showAuth(mode) {
  authMode = mode;
  $("#auth-panel").classList.remove("hidden");
  $("#auth-title").textContent = mode === "register" ? "Créer un compte" : "Connexion";
  $("#auth-submit").textContent = mode === "register" ? "Créer mon compte" : "Se connecter";
  $("#auth-message").textContent = "";
  $("#password").value = "";
}

function renderAccount() {
  const connected = Boolean(currentUser);
  $("#auth-panel").classList.add("hidden");
  $("#welcome-panel").classList.toggle("hidden", connected);
  $("#dashboard").classList.toggle("hidden", !connected);

  $("#account-area").innerHTML = connected
    ? `<span class="pill">${escapeHtml(currentUser.username)}</span>`
    : `<button class="button secondary" id="show-login">Connexion</button>
       <button class="button primary" id="show-register">Créer un compte</button>`;

  if (connected) {
    $("#user-name").textContent = currentUser.username;
    $("#balance").textContent = money(currentUser.balance);
    $("#admin-tab").classList.toggle("hidden", currentUser.role !== "admin");
  }

  $("#show-login")?.addEventListener("click", () => showAuth("login"));
  $("#show-register")?.addEventListener("click", () => showAuth("register"));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;"
  })[char]);
}

async function loadMarket() {
  const data = await api("/api/market");
  const assets = Array.isArray(data.assets) ? data.assets : [];

  $("#market-list").innerHTML = assets.length
    ? assets.map(asset => `
      <article class="asset-card">
        <div class="asset-symbol">${escapeHtml(asset.symbol)}</div>
        <h3>${escapeHtml(asset.name)}</h3>
        <div class="price">${money(asset.price)}</div>
        <p class="muted">Cours simulé</p>
        <p>Quantité</p>
        <input type="number" min="0.001" max="1000000" step="0.001"
          id="qty-${escapeHtml(asset.symbol)}" value="1">
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="button primary" data-trade="buy" data-symbol="${escapeHtml(asset.symbol)}">Acheter</button>
          <button class="button secondary" data-trade="sell" data-symbol="${escapeHtml(asset.symbol)}">Vendre</button>
        </div>
      </article>`).join("")
    : "<p>Aucun actif disponible.</p>";

  $("#market-list").querySelectorAll("[data-trade]").forEach(button => {
    button.addEventListener("click", async () => {
      const symbol = button.dataset.symbol;
      const quantity = Number($(`#qty-${CSS.escape(symbol)}`).value);

      if (!Number.isFinite(quantity) || quantity <= 0) {
        return showMessage("Saisis une quantité valide.", true);
      }

      try {
        const result = await api("/api/trade", {
          method: "POST",
          body: JSON.stringify({
            symbol,
            quantity,
            side: button.dataset.trade
          })
        });

        currentUser.balance = result.balance;
        renderAccount();
        await loadMarket();
        await loadPortfolio();
        showMessage("Opération simulée effectuée.");
      } catch (error) {
        showMessage(error.message, true);
      }
    });
  });
}

async function loadPortfolio() {
  const data = await api("/api/portfolio");
  const holdings = Array.isArray(data.holdings) ? data.holdings : [];
  $("#holding-count").textContent = holdings.length;
}

async function loadShop() {
  const data = await api("/api/shop");
  const packs = Array.isArray(data.packs) ? data.packs : [];

  $("#shop-list").innerHTML = packs.length
    ? packs.map(pack => `
      <article class="shop-card">
        <div class="card-art">✦</div>
        <h3>${escapeHtml(pack.name)}</h3>
        <p>${escapeHtml(pack.description)}</p>
        <div class="price">${money(pack.price)}</div>
        <p class="muted">Stock : ${Number(pack.stock) || 0}</p>
        <button class="button primary full" data-pack="${Number(pack.id)}"
          ${Number(pack.stock) <= 0 ? "disabled" : ""}>Acheter le pack</button>
      </article>`).join("")
    : "<p>La boutique est vide pour le moment.</p>";

  $("#shop-list").querySelectorAll("[data-pack]").forEach(button => {
    button.addEventListener("click", async () => {
      try {
        const result = await api("/api/shop/buy", {
          method: "POST",
          body: JSON.stringify({ packId: Number(button.dataset.pack) })
        });
        currentUser.balance = result.balance;
        renderAccount();
        await loadShop();
        await loadCollection();
        showMessage("Pack ouvert ! Tes cartes ont été ajoutées à ta collection.");
      } catch (error) {
        showMessage(error.message, true);
      }
    });
  });
}

async function loadCollection() {
  const data = await api("/api/cards");
  const cards = Array.isArray(data.cards) ? data.cards : [];
  const count = cards.reduce((sum, card) => sum + Number(card.quantity || 0), 0);
  $("#card-count").textContent = count;

  $("#collection-list").innerHTML = cards.length
    ? cards.map(card => `
      <article class="collect-card">
        <div class="card-art">✧</div>
        <span class="pill">${escapeHtml(card.rarity)}</span>
        <h3>${escapeHtml(card.name)}</h3>
        <p>Quantité : ${Number(card.quantity) || 0}</p>
      </article>`).join("")
    : "<p>Ta collection est vide. Essaie d'ouvrir un pack !</p>";
}

async function loadTitles() {
  const data = await api("/api/titles");
  const titles = Array.isArray(data.titles) ? data.titles : [];

  $("#titles-list").innerHTML = titles.length
    ? titles.map(title => `
      <article class="title-card">
        <div class="card-art">♜</div>
        <h3>${escapeHtml(title.name)}</h3>
        <p>${escapeHtml(title.description)}</p>
        <span class="pill">${title.unlocked ? "Débloqué" : "À débloquer"}</span>
      </article>`).join("")
    : "<p>Aucun titre disponible.</p>";
}

async function loadAdmin() {
  if (currentUser?.role !== "admin") return;

  const data = await api("/api/admin/users");
  const users = Array.isArray(data.users) ? data.users : [];

  $("#admin-users").innerHTML = users.map(user => `
    <article class="asset-card">
      <strong>${escapeHtml(user.username)}</strong>
      <p>${escapeHtml(user.role)} · ${money(user.balance)}</p>
    </article>`).join("") || "<p>Aucun utilisateur.</p>";
}

async function refreshDashboard() {
  renderAccount();
  if (!currentUser) return;

  await Promise.all([
    loadMarket(),
    loadPortfolio(),
    loadShop(),
    loadCollection(),
    loadTitles()
  ]);

  if (currentUser.role === "admin") await loadAdmin();
}

$("#show-login").addEventListener("click", () => showAuth("login"));
$("#show-register").addEventListener("click", () => showAuth("register"));
$("#close-auth").addEventListener("click", () => $("#auth-panel").classList.add("hidden"));

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = $("#username").value.trim();
  const password = $("#password").value;

  try {
    const result = await api(authMode === "register" ? "/api/register" : "/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });

    currentUser = result.user;
    await refreshDashboard();
    showMessage("Bienvenue sur Sigma Exchange !");
  } catch (error) {
    showMessage(error.message, true, "#auth-message");
  }
});

$("#logout").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST" });
    currentUser = null;
    renderAccount();
    showMessage("Tu es déconnecté.");
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", async () => {
    if (tab.classList.contains("hidden")) return;

    document.querySelectorAll(".tab").forEach(item =>
      item.classList.toggle("active", item === tab)
    );

    document.querySelectorAll(".page-section").forEach(section =>
      section.classList.toggle("hidden", section.id !== `page-${tab.dataset.page}`)
    );

    if (tab.dataset.page === "admin") {
      try { await loadAdmin(); }
      catch (error) { showMessage(error.message, true); }
    }
  });
});

$("#restock").addEventListener("click", async () => {
  try {
    await api("/api/admin/shop/restock", { method: "POST" });
    await loadShop();
    showMessage("Le stock a été renouvelé.", false, "#admin-message");
  } catch (error) {
    showMessage(error.message, true, "#admin-message");
  }
});

async function init() {
  try {
    const data = await api("/api/me");
    currentUser = data.user;
    renderAccount();

    if (currentUser) {
      await refreshDashboard();
    }
  } catch (error) {
    console.error("Initialisation :", error);
    showMessage("Impossible de charger le site. Vérifie le serveur.");
  }
}

init();
