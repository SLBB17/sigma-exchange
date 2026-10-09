
async function initDb(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(20) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'user',
      balance NUMERIC(18,2) NOT NULL DEFAULT 10000,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS holdings (
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      symbol VARCHAR(20) NOT NULL,
      quantity NUMERIC(18,6) NOT NULL DEFAULT 0,
      average_price NUMERIC(18,4) NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, symbol)
    );

    CREATE TABLE IF NOT EXISTS cards (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      rarity VARCHAR(20) NOT NULL DEFAULT 'common',
      image_url TEXT,
      description TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS user_cards (
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      card_id BIGINT REFERENCES cards(id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, card_id)
    );

    CREATE TABLE IF NOT EXISTS shop_packs (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price NUMERIC(12,2) NOT NULL DEFAULT 100,
      stock INTEGER NOT NULL DEFAULT 0,
      image_url TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS titles (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS user_titles (
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      title_id BIGINT REFERENCES titles(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, title_id)
    );

    CREATE TABLE IF NOT EXISTS market_assets (
      symbol VARCHAR(20) PRIMARY KEY,
      name TEXT NOT NULL,
      price NUMERIC(18,4) NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(30) NOT NULL,
      details JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    INSERT INTO shop_packs (name, description, price, stock)
    SELECT v.name, v.description, v.price, v.stock
    FROM (VALUES
      ('Pack Découverte', 'Des cartes pour commencer ta collection.', 100, 10),
      ('Pack Premium', 'Un pack de cartes aux raretés variées.', 500, 6),
      ('Pack Légendaire', 'Un pack spécial de collection.', 1500, 2)
    ) AS v(name, description, price, stock)
    WHERE NOT EXISTS (
      SELECT 1 FROM shop_packs WHERE shop_packs.name = v.name
    );

    INSERT INTO cards (name, rarity, description)
    VALUES
      ('Nova', 'common', 'Une carte de la collection Sigma.'),
      ('Orion', 'rare', 'Une carte rare de la collection Sigma.'),
      ('Eclipse', 'epic', 'Une carte épique de la collection Sigma.'),
      ('Singularity', 'legendary', 'Une carte légendaire de la collection Sigma.')
    ON CONFLICT (name) DO NOTHING;

    INSERT INTO titles (name, description)
    VALUES
      ('Nouveau membre', 'Bienvenue sur Sigma Exchange.'),
      ('Collectionneur', 'Collectionne tes premières cartes.'),
      ('Investisseur', 'Découvre le marché simulé.')
    ON CONFLICT (name) DO NOTHING;

    INSERT INTO market_assets (symbol, name, price)
    VALUES
      ('SIG', 'Sigma Technologies', 120.00),
      ('NOVA', 'Nova Systems', 85.00),
      ('ORX', 'Orion Industries', 210.00),
      ('ECL', 'Eclipse Energy', 64.00)
    ON CONFLICT (symbol) DO NOTHING;
  `);
}

module.exports = { initDb };
