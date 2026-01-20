import Database from 'better-sqlite3';
import { getConfig } from '../utils/config';
import { logger } from '../utils/logger';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const config = getConfig();
    db = new Database(config.dbPath);
    db.pragma('journal_mode = WAL');
    initializeSchema(db);
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function initializeSchema(database: Database.Database): void {
  logger.info('Initializing database schema');

  // Issues table - tracks GitHub issues we've seen
  database.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY,
      github_id INTEGER UNIQUE NOT NULL,
      repo_name TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      state TEXT NOT NULL,
      html_url TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'new',
      branch_name TEXT,
      task_file_path TEXT,
      UNIQUE(repo_name, issue_number)
    )
  `);

  // Repositories table - tracks cloned repos
  database.exec(`
    CREATE TABLE IF NOT EXISTS repositories (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      clone_url TEXT NOT NULL,
      local_path TEXT,
      last_cloned_at TEXT,
      last_updated_at TEXT
    )
  `);

  // Scan history table - tracks when we last scanned
  database.exec(`
    CREATE TABLE IF NOT EXISTS scan_history (
      id INTEGER PRIMARY KEY,
      scanned_at TEXT NOT NULL DEFAULT (datetime('now')),
      repos_scanned INTEGER NOT NULL DEFAULT 0,
      issues_found INTEGER NOT NULL DEFAULT 0,
      new_issues INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Create indexes for faster queries
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
    CREATE INDEX IF NOT EXISTS idx_issues_repo ON issues(repo_name);
    CREATE INDEX IF NOT EXISTS idx_issues_github_id ON issues(github_id);
  `);

  logger.info('Database schema initialized');
}
