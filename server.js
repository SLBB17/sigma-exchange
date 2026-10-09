
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const path = require("path");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const PgSession = require("connect-pg-simple")(session);

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error("ERREUR : la variable DATABASE_URL est manquante.");
  process.exit(1);
}

if (!process.env.SESSION_SECRET) {
  console.error("ERREUR : la variable SESSION_SECRET est manquante.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false }));

app.use(
  session({
    store: new PgSession({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: true
    }),
    name: "sigma.sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  })
);

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

  if (result.rows.length === 0 || result.rows[0].role !== "admin") {
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
    req.session.userId = null;
    return res.json({ user: null });
  }

  res.json({ user: publicUser(result.rows[0]) });
}));

app.post("/api/register", asyncRoute(async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({
      error: "Le pseudo doit contenir 3 à 20 caractères : lettres, chiffres ou _."
    });
  }

  if (password.length < 8 || password.length > 128) {
    return res.status(400).json({
      error: "Le mot de passe doit contenir entre 8 et 128 caractères."
    });
  }

  const hash = await bcrypt.hash(password, 12);

  let result;

  try {
    result = await pool.query(
      `INSERT INTO users (username, password_hash)
       VALUES ($1, $2)
       RETURNING id, username, role, balance, created_at`,
      [username, hash]
    );
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Ce pseudo est déjà utilisé." });
    }
    throw error;
  }

  req.session.regenerate((error) => {
    if (error) {
      return res.status(500).json({ error: "Impossible de créer la session." });
    }

    req.session.userId = result.rows[0].id;

    req.session.save((saveError) => {
      if (saveError) {
        return res.status(500).json({ error: "Impossible de sauvegarder la session." });
      }
      res.status(201).json({ user: publicUser(result.rows[0]) });
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
      return res.status(500).json({ error: "Impossible de créer la session." });
    }

    req.session.userId = user.id;

    req.session.save((saveError) => {
      if (saveError) {
        return res.status(500).json({ error: "Impossible de sauvegarder la session." });
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
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax"
    });

    res.json({ ok: true });
  });
});

app.get("/api/portfolio", requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT symbol, quantity, average_price
     FROM holdings
     WHERE user_id = $1
     ORDER BY symbol`,
    [req.session.userId]
  );

  res.json({ holdings: result.rows || [] });
}));

app.get("/api/cards", requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT uc.card_id, uc.quantity, c.name, c.rarity, c.image_url
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

  res.json({ packs: result.rows || [] });
}));

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

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Route introuvable." });
  }

  res.status(404).send("Page introuvable.");
});

app.use((error, req, res, next) => {
  console.error("Erreur serveur :", error);

  if (res.headersSent) return next(error);

  res.status(500).json({
    error: "Une erreur interne est survenue."
  });
});

async function start() {
  await pool.query("SELECT 1");

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Sigma Exchange écoute sur le port ${PORT}`);
  });
}

start().catch((error) => {
  console.error("Impossible de démarrer Sigma Exchange :", error);
  process.exit(1);
});
