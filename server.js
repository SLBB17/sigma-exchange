
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const path = require("path");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const PgSession = require("connect-pg-simple")(session);
const { initDb } = require("./db");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === "production";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL est manquante.");
  process.exit(1);
}

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error("SESSION_SECRET doit contenir au moins 32 caractères.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: IS_PRODUCTION ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on("error", (error) => {
  console.error("Erreur PostgreSQL :", error.message);
});

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(express.json({ limit: "50kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));

app.use(
  session({
    name: "sigma.sid",
    secret: process.env.SESSION_SECRET,
    store: new PgSession({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: true
    }),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: IS_PRODUCTION,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  })
);

// Les fichiers HTML, CSS et JavaScript sont servis depuis public/.
app.use(express.static(path.join(__dirname, "public")));

const asyncRoute = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

const requireAuth = (req, res, next) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Connecte-toi pour continuer." });
  }
  next();
};

const requireAdmin = asyncRoute(async (req, res, next) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Connexion requise." });
  }

  const result = await pool.query(
    "SELECT role FROM users WHERE id = $1",
    [req.session.userId]
  );

  if (!result.rows[0] || result.rows[0].role !== "admin") {
    return res.status(403).json({ error: "Accès administrateur refusé." });
  }

  next();
});

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    balance: Number(user.balance),
    createdAt: user.created_at
  };
}

function validQuantity(value) {
  const quantity = Number(value);
  return Number.isFinite(quantity) &&
    quantity > 0 &&
    quantity <= 1000000 &&
    Math.round(quantity * 1000) / 1000 === quantity;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function transaction(callback) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// --------------------------------------------------
// SANTÉ ET COMPTE
// --------------------------------------------------

app.get("/api/health", asyncRoute(async (req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true, database: "connected" });
}));

app.get("/api/me", asyncRoute(async (req, res) => {
  if (!req.session.userId) {
    return res.json({ user: null });
  }

  const result = await pool.query(
    `SELECT id, username, role, balance, created_at
     FROM users WHERE id = $1`,
    [req.session.userId]
  );

  if (!result.rows.length) {
    return req.session.destroy(() => res.json({ user: null }));
  }

  res.json({ user: publicUser(result.rows[0]) });
}));

app.post("/api/register", asyncRoute(async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({
      error: "Le pseudo doit contenir de 3 à 20 lettres, chiffres ou _."
    });
  }

  if (password.length < 8 || password.length > 128) {
    return res.status(400).json({
      error: "Le mot de passe doit contenir entre 8 et 128 caractères."
    });
  }

  const hash = await bcrypt.hash(password, 12);

  let user;

  try {
    const result = await pool.query(
      `INSERT INTO users (username, password_hash)
       VALUES ($1, $2)
       RETURNING id, username, role, balance, created_at`,
      [username, hash]
    );
    user = result.rows[0];
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Ce pseudo est déjà utilisé." });
    }
    throw error;
  }

  await transaction(async (client) => {
    const title = await client.query(
      "SELECT id FROM titles WHERE name = $1",
      ["Nouveau membre"]
    );

    if (title.rows[0]) {
      await client.query(
        `INSERT INTO user_titles (user_id, title_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [user.id, title.rows[0].id]
      );
    }
  });

  req.session.regenerate((error) => {
    if (error) {
      return res.status(500).json({ error: "Création de session impossible." });
    }

    req.session.userId = user.id;

    req.session.save((saveError) => {
      if (saveError) {
        return res.status(500).json({ error: "Sauvegarde de session impossible." });
      }

      res.status(201).json({ user: publicUser(user) });
    });
  });
}));

app.post("/api/login", asyncRoute(async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  const result = await pool.query(
    `SELECT id, username, password_hash, role, balance, created_at
     FROM users WHERE LOWER(username) = LOWER($1)`,
    [username]
  );

  const user = result.rows[0];

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Pseudo ou mot de passe incorrect." });
  }

  req.session.regenerate((error) => {
    if (error) {
      return res.status(500).json({ error: "Création de session impossible." });
    }

    req.session.userId = user.id;

    req.session.save((saveError) => {
      if (saveError) {
        return res.status(500).json({ error: "Sauvegarde de session impossible." });
      }

      res.json({ user: publicUser(user) });
    });
  });
}));

app.post("/api/logout", (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);

    res.clearCookie("sigma.sid", {
      httpOnly: true,
      secure: IS_PRODUCTION,
      sameSite: "lax"
    });

    res.json({ ok: true });
  });
});

// --------------------------------------------------
// MARCHÉ VIRTUEL
// --------------------------------------------------

app.get("/api/market", asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT symbol, name, price, updated_at
     FROM market_assets
     ORDER BY symbol`
  );

  res.json({
    assets: result.rows.map((asset) => ({
      ...asset,
      price: Number(asset.price)
    }))
  });
}));

app.get("/api/portfolio", requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT h.symbol, h.quantity, h.average_price,
            a.name, a.price
     FROM holdings h
     LEFT JOIN market_assets a ON a.symbol = h.symbol
     WHERE h.user_id = $1
     ORDER BY h.symbol`,
    [req.session.userId]
  );

  res.json({
    holdings: result.rows.map((holding) => ({
      ...holding,
      quantity: Number(holding.quantity),
      average_price: Number(holding.average_price),
      price: holding.price === null ? null : Number(holding.price)
    }))
  });
}));

app.post("/api/trade", requireAuth, asyncRoute(async (req, res) => {
  const symbol = String(req.body.symbol || "").trim().toUpperCase();
  const side = String(req.body.side || "");
  const quantity = Number(req.body.quantity);

  if (!/^[A-Z0-9_-]{1,20}$/.test(symbol)) {
    return res.status(400).json({ error: "Symbole invalide." });
  }

  if (!["buy", "sell"].includes(side) || !validQuantity(quantity)) {
    return res.status(400).json({ error: "Ordre ou quantité invalide." });
  }

  const result = await transaction(async (client) => {
    const assetResult = await client.query(
      "SELECT symbol, name, price FROM market_assets WHERE symbol = $1 FOR UPDATE",
      [symbol]
    );

    const asset = assetResult.rows[0];
    if (!asset) {
      const error = new Error("Cet actif n'existe pas.");
      error.status = 404;
      throw error;
    }

    const price = Number(asset.price);
    const total = Math.round(price * quantity * 100) / 100;

    if (!Number.isFinite(total) || total <= 0) {
      const error = new Error("Montant de transaction invalide.");
      error.status = 400;
      throw error;
    }

    const userResult = await client.query(
      "SELECT id, balance FROM users WHERE id = $1 FOR UPDATE",
      [req.session.userId]
    );

    const user = userResult.rows[0];
    if (!user) {
      const error = new Error("Compte introuvable.");
      error.status = 401;
      throw error;
    }

    if (side === "buy") {
      const debit = await client.query(
        `UPDATE users SET balance = balance - $1
         WHERE id = $2 AND balance >= $1
         RETURNING balance`,
        [total, user.id]
      );

      if (!debit.rows.length) {
        const error = new Error("Solde virtuel insuffisant.");
        error.status = 400;
        throw error;
      }

      const oldHolding = await client.query(
        `SELECT quantity, average_price FROM holdings
         WHERE user_id = $1 AND symbol = $2 FOR UPDATE`,
        [user.id, symbol]
      );

      const oldQty = Number(oldHolding.rows[0]?.quantity || 0);
      const oldAverage = Number(oldHolding.rows[0]?.average_price || 0);
      const newQty = oldQty + quantity;
      const newAverage = ((oldQty * oldAverage) + total) / newQty;

      await client.query(
        `INSERT INTO holdings (user_id, symbol, quantity, average_price)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, symbol)
         DO UPDATE SET quantity = EXCLUDED.quantity,
                       average_price = EXCLUDED.average_price`,
        [user.id, symbol, newQty, newAverage]
      );
    } else {
      const holdingResult = await client.query(
        `SELECT quantity FROM holdings
         WHERE user_id = $1 AND symbol = $2 FOR UPDATE`,
        [user.id, symbol]
      );

      const held = Number(holdingResult.rows[0]?.quantity || 0);

      if (held + 1e-9 < quantity) {
        const error = new Error("Tu ne possèdes pas assez de cet actif.");
        error.status = 400;
        throw error;
      }

      await client.query(
        `UPDATE holdings
         SET quantity = quantity - $1
         WHERE user_id = $2 AND symbol = $3`,
        [quantity, user.id, symbol]
      );

      await client.query(
        `DELETE FROM holdings
         WHERE user_id = $1 AND symbol = $2 AND quantity <= 0`,
        [user.id, symbol]
      );

      await client.query(
        "UPDATE users SET balance = balance + $1 WHERE id = $2",
        [total, user.id]
      );
    }

    const balanceResult = await client.query(
      "SELECT balance FROM users WHERE id = $1",
      [user.id]
    );

    await client.query(
      `INSERT INTO transactions (user_id, type, details)
       VALUES ($1, $2, $3::jsonb)`,
      [
        user.id,
        side === "buy" ? "market_buy" : "market_sell",
        JSON.stringify({ symbol, quantity, price, total })
      ]
    );

    return {
      symbol,
      side,
      quantity,
      price,
      total,
      balance: Number(balanceResult.rows[0].balance)
    };
  });

  res.json(result);
}));

app.get("/api/transactions", requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT id, type, details, created_at
     FROM transactions WHERE user_id = $1
     ORDER BY created_at DESC LIMIT 100`,
    [req.session.userId]
  );

  res.json({ transactions: result.rows || [] });
}));

// --------------------------------------------------
// CARTES ET BOUTIQUE
// --------------------------------------------------

app.get("/api/cards", requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT uc.card_id, uc.quantity, c.name, c.rarity,
            c.image_url, c.description
     FROM user_cards uc
     JOIN cards c ON c.id = uc.card_id
     WHERE uc.user_id = $1
     ORDER BY c.name`,
    [req.session.userId]
  );

  res.json({ cards: result.rows || [] });
}));

app.get("/api/shop", asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, description, price, stock, image_url
     FROM shop_packs
     WHERE active = TRUE
     ORDER BY price, id`
  );

  res.json({
    packs: result.rows.map((pack) => ({
      ...pack,
      price: Number(pack.price),
      stock: Number(pack.stock)
    }))
  });
}));

async function drawCard(client, userId) {
  const roll = Math.random();
  let rarity;

  if (roll < 0.01) rarity = "legendary";
  else if (roll < 0.06) rarity = "epic";
  else if (roll < 0.25) rarity = "rare";
  else rarity = "common";

  let result = await client.query(
    `SELECT id, name, rarity FROM cards
     WHERE rarity = $1 ORDER BY random() LIMIT 1`,
    [rarity]
  );

  if (!result.rows.length) {
    result = await client.query(
      "SELECT id, name, rarity FROM cards ORDER BY random() LIMIT 1"
    );
  }

  const card = result.rows[0];

  if (!card) {
    throw new Error("Aucune carte n'est disponible dans la base.");
  }

  await client.query(
    `INSERT INTO user_cards (user_id, card_id, quantity)
     VALUES ($1, $2, 1)
     ON CONFLICT (user_id, card_id)
     DO UPDATE SET quantity = user_cards.quantity + 1`,
    [userId, card.id]
  );

  return { id: card.id, name: card.name, rarity: card.rarity };
}

app.post("/api/shop/buy", requireAuth, asyncRoute(async (req, res) => {
  const packId = Number(req.body.packId);

  if (!Number.isSafeInteger(packId) || packId <= 0) {
    return res.status(400).json({ error: "Pack invalide." });
  }

  const result = await transaction(async (client) => {
    const packResult = await client.query(
      `SELECT id, name, price, stock
       FROM shop_packs
       WHERE id = $1 AND active = TRUE
       FOR UPDATE`,
      [packId]
    );

    const pack = packResult.rows[0];

    if (!pack) {
      const error = new Error("Ce pack n'est pas disponible.");
      error.status = 404;
      throw error;
    }

    if (Number(pack.stock) <= 0) {
      const error = new Error("Ce pack est en rupture de stock.");
      error.status = 400;
      throw error;
    }

    const userResult = await client.query(
      "SELECT id, balance FROM users WHERE id = $1 FOR UPDATE",
      [req.session.userId]
    );

    const user = userResult.rows[0];
    const price = Number(pack.price);

    if (!user || Number(user.balance) < price) {
      const error = new Error("Solde virtuel insuffisant.");
      error.status = 400;
      throw error;
    }

    await client.query(
      "UPDATE users SET balance = balance - $1 WHERE id = $2",
      [price, user.id]
    );

    await client.query(
      "UPDATE shop_packs SET stock = stock - 1 WHERE id = $1",
      [pack.id]
    );

    const cards = [];
    for (let i = 0; i < 5; i++) {
      cards.push(await drawCard(client, user.id));
    }

    const balanceResult = await client.query(
      "SELECT balance FROM users WHERE id = $1",
      [user.id]
    );

    await client.query(
      `INSERT INTO transactions (user_id, type, details)
       VALUES ($1, 'pack_purchase', $2::jsonb)`,
      [user.id, JSON.stringify({ packId, packName: pack.name, price, cards })]
    );

    return {
      pack: pack.name,
      price,
      cards,
      balance: Number(balanceResult.rows[0].balance)
    };
  });

  res.json(result);
}));

// --------------------------------------------------
// TITRES
// --------------------------------------------------

app.get("/api/titles", requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT t.id, t.name, t.description,
       EXISTS (
         SELECT 1 FROM user_titles ut
         WHERE ut.title_id = t.id AND ut.user_id = $1
       ) AS unlocked
     FROM titles t
     ORDER BY t.id`,
    [req.session.userId]
  );

  res.json({ titles: result.rows || [] });
}));

// --------------------------------------------------
// ADMINISTRATION
// --------------------------------------------------

app.get("/api/admin/users", requireAdmin, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT id, username, role, balance, created_at
     FROM users ORDER BY id DESC LIMIT 200`
  );

  res.json({ users: result.rows || [] });
}));

app.post("/api/admin/shop/restock", requireAdmin, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `UPDATE shop_packs
     SET stock = floor(random() * 16 + 5)::integer
     WHERE active = TRUE
     RETURNING id, name, stock`
  );

  res.json({ ok: true, packs: result.rows || [] });
}));

// Crée des cours fictifs fluctuants, jamais reliés à un marché réel.
async function updateMarket() {
  await pool.query(`
    UPDATE market_assets
    SET price = GREATEST(
      1,
      ROUND((price * (1 + (random() - 0.49) * 0.04))::numeric, 4)
    ),
    updated_at = NOW()
  `);
}

let marketTimer;

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Route API introuvable." });
  }

  res.status(404).send("Page introuvable.");
});

app.use((error, req, res, next) => {
  console.error("Erreur serveur :", error.message);

  if (res.headersSent) return next(error);

  const status = Number.isInteger(error.status) ? error.status : 500;

  res.status(status).json({
    error: status === 500
      ? "Une erreur interne est survenue."
      : error.message
  });
});

async function start() {
  await pool.query("SELECT 1");
  await initDb(pool);

  // Stock initialisé dans db.js ; renouvellement automatique toutes les 5 min.
  marketTimer = setInterval(async () => {
    try {
      await pool.query(`
        UPDATE shop_packs
        SET stock = floor(random() * 16 + 5)::integer
        WHERE active = TRUE
      `);
    } catch (error) {
      console.error("Erreur de réapprovisionnement :", error.message);
    }
  }, 5 * 60 * 1000);

  marketTimer.unref();

  await updateMarket();

  const marketUpdateTimer = setInterval(() => {
    updateMarket().catch((error) =>
      console.error("Erreur de mise à jour du marché :", error.message)
    );
  }, 60 * 1000);

  marketUpdateTimer.unref();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Sigma Exchange est lancé sur le port ${PORT}`);
  });
}

start().catch((error) => {
  console.error("Impossible de démarrer Sigma Exchange :", error);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  if (marketTimer) clearInterval(marketTimer);
  await pool.end();
  process.exit(0);
});
