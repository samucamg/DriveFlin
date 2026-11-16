-- DriveFlin Database Schema for Cloudflare D1
-- Default Admin credentials: admin / admin

DROP TABLE IF EXISTS Users;
CREATE TABLE Users (
    Id TEXT PRIMARY KEY,
    Name TEXT NOT NULL,
    Password TEXT NOT NULL
);

DROP TABLE IF EXISTS Libraries;
CREATE TABLE Libraries (
    Id TEXT PRIMARY KEY,
    Name TEXT NOT NULL,
    FolderId TEXT NOT NULL,
    Uuid TEXT
);
CREATE INDEX IF NOT EXISTS idx_libraries_uuid ON Libraries(Uuid);

DROP TABLE IF EXISTS Items;
CREATE TABLE Items (
    Id TEXT PRIMARY KEY,
    ParentId TEXT,
    LibraryId TEXT,
    Type TEXT NOT NULL, -- 'Series', 'Season', 'Episode', 'Movie', 'Audio'
    Name TEXT NOT NULL,
    Overview TEXT,
    IndexNumber INTEGER, -- S01 -> 1
    ParentIndexNumber INTEGER, -- Season Number for Episodes
    FolderId TEXT,
    FileId TEXT,
    EncryptedName TEXT,
    Size INTEGER,
    PrimaryImageFileId TEXT,
    BackdropImageFileId TEXT,
    TmdbId TEXT,
    MediaInfo TEXT,
    DateCreated DATETIME DEFAULT CURRENT_TIMESTAMP,
    Uuid TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_uuid ON Items(Uuid);

DROP TABLE IF EXISTS UserData;
CREATE TABLE UserData (
    UserId TEXT,
    ItemId TEXT,
    PlaybackPositionTicks INTEGER DEFAULT 0,
    PlayCount INTEGER DEFAULT 0,
    IsFavorite BOOLEAN DEFAULT 0,
    Played BOOLEAN DEFAULT 0,
    LastPlayedDate DATETIME,
    PRIMARY KEY (UserId, ItemId)
);

-- Insert Default User: admin / admin
INSERT INTO Users (Id, Name, Password) VALUES ('user_admin_123', 'admin', 'admin');
