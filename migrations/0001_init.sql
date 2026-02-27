CREATE TABLE IF NOT EXISTS accounts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT    NOT NULL UNIQUE,
  refresh_token   TEXT    NOT NULL,
  access_token    TEXT    NOT NULL DEFAULT '',
  token_expires   INTEGER NOT NULL DEFAULT 0,
  error_count     INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT    NOT NULL DEFAULT '',
  last_error_time INTEGER NOT NULL DEFAULT 0
);
