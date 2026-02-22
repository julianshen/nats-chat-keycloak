CREATE TABLE IF NOT EXISTS messages (
    id          BIGSERIAL PRIMARY KEY,
    room        VARCHAR(255) NOT NULL,
    username    VARCHAR(255) NOT NULL,
    text        TEXT NOT NULL,
    timestamp   BIGINT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_room_ts ON messages(room, timestamp DESC);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_id VARCHAR(255);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS parent_timestamp BIGINT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS broadcast BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, timestamp);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at BIGINT;

CREATE TABLE IF NOT EXISTS message_versions (
    id                BIGSERIAL PRIMARY KEY,
    room              VARCHAR(255) NOT NULL,
    message_timestamp BIGINT NOT NULL,
    text              TEXT NOT NULL,
    edited_at         BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_versions_lookup
    ON message_versions(room, message_timestamp, edited_at DESC);

CREATE TABLE IF NOT EXISTS message_reactions (
    id                BIGSERIAL PRIMARY KEY,
    room              VARCHAR(255) NOT NULL,
    message_timestamp BIGINT NOT NULL,
    user_id           VARCHAR(255) NOT NULL,
    emoji             VARCHAR(64)  NOT NULL,
    created_at        TIMESTAMPTZ  DEFAULT NOW(),
    UNIQUE (room, message_timestamp, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_lookup
    ON message_reactions(room, message_timestamp);

CREATE TABLE IF NOT EXISTS read_receipts (
    user_id    VARCHAR(255) NOT NULL,
    room       VARCHAR(255) NOT NULL,
    last_read  BIGINT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, room)
);

-- Sticker tables
CREATE TABLE IF NOT EXISTS sticker_products (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    thumbnail VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stickers (
    id VARCHAR(64) PRIMARY KEY,
    product_id VARCHAR(64) NOT NULL REFERENCES sticker_products(id),
    image_file VARCHAR(255) NOT NULL,
    sort_order INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stickers_product ON stickers(product_id, sort_order);

INSERT INTO sticker_products (id, name, thumbnail) VALUES
  ('pepe-frog', 'Pepe the Frog', 'pepe-frog/thumb.svg'),
  ('pusheen', 'Pusheen Cat', 'pusheen/thumb.svg'),
  ('party', 'Party Time', 'party/thumb.svg')
ON CONFLICT DO NOTHING;

INSERT INTO stickers (id, product_id, image_file, sort_order) VALUES
  ('pepe-happy', 'pepe-frog', 'pepe-frog/happy.svg', 1),
  ('pepe-sad', 'pepe-frog', 'pepe-frog/sad.svg', 2),
  ('pepe-angry', 'pepe-frog', 'pepe-frog/angry.svg', 3),
  ('pepe-think', 'pepe-frog', 'pepe-frog/think.svg', 4),
  ('pepe-laugh', 'pepe-frog', 'pepe-frog/laugh.svg', 5),
  ('pusheen-hi', 'pusheen', 'pusheen/hi.svg', 1),
  ('pusheen-love', 'pusheen', 'pusheen/love.svg', 2),
  ('pusheen-eat', 'pusheen', 'pusheen/eat.svg', 3),
  ('pusheen-sleep', 'pusheen', 'pusheen/sleep.svg', 4),
  ('pusheen-angry', 'pusheen', 'pusheen/angry.svg', 5),
  ('party-popper', 'party', 'party/popper.svg', 1),
  ('party-dance', 'party', 'party/dance.svg', 2),
  ('party-cake', 'party', 'party/cake.svg', 3),
  ('party-balloon', 'party', 'party/balloon.svg', 4)
ON CONFLICT DO NOTHING;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS sticker_url TEXT;

-- App registry tables
CREATE TABLE IF NOT EXISTS apps (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT,
    icon_url        TEXT,
    component_url   TEXT NOT NULL,
    subject_prefix  TEXT NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channel_apps (
    room            TEXT NOT NULL,
    app_id          TEXT NOT NULL REFERENCES apps(id),
    installed_by    TEXT NOT NULL,
    installed_at    TIMESTAMPTZ DEFAULT NOW(),
    config          JSONB DEFAULT '{}',
    PRIMARY KEY (room, app_id)
);

-- Poll app tables
CREATE TABLE IF NOT EXISTS polls (
    id          TEXT PRIMARY KEY,
    room        TEXT NOT NULL,
    question    TEXT NOT NULL,
    options     JSONB NOT NULL,
    created_by  TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    closed      BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id     TEXT NOT NULL REFERENCES polls(id),
    user_id     TEXT NOT NULL,
    option_idx  INT NOT NULL,
    voted_at    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (poll_id, user_id)
);

-- Seed poll app into registry
INSERT INTO apps (id, name, description, icon_url, component_url, subject_prefix) VALUES
  ('poll', 'Poll', 'Create polls and vote in real-time', NULL, 'http://localhost:8091/poll-app.js', 'app.poll')
ON CONFLICT DO NOTHING;

-- Whiteboard tables
CREATE TABLE IF NOT EXISTS whiteboard_boards (
    id          TEXT PRIMARY KEY,
    room        TEXT NOT NULL,
    name        TEXT NOT NULL,
    elements    JSONB NOT NULL DEFAULT '[]',
    created_by  TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_whiteboard_boards_room ON whiteboard_boards(room, created_at DESC);

-- Seed whiteboard app into registry
INSERT INTO apps (id, name, description, icon_url, component_url, subject_prefix) VALUES
  ('whiteboard', 'Whiteboard', 'Collaborative drawing boards with Excalidraw', NULL,
   'http://localhost:8092/whiteboard-app.js', 'app.whiteboard')
ON CONFLICT DO NOTHING;

-- Knowledge Base tables
CREATE TABLE IF NOT EXISTS kb_pages (
    id          TEXT PRIMARY KEY,
    room        TEXT NOT NULL,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL DEFAULT '',
    created_by  TEXT NOT NULL,
    updated_by  TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kb_pages_room ON kb_pages(room, updated_at DESC);

-- Seed KB app into registry
INSERT INTO apps (id, name, description, icon_url, component_url, subject_prefix) VALUES
  ('kb', 'Knowledge Base', 'Collaborative knowledge sharing with rich text pages', NULL,
   'http://localhost:8093/kb-app.js', 'app.kb')
ON CONFLICT DO NOTHING;
