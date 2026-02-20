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
