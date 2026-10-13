import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';

export async function openDb(): Promise<Database> {
    return open({
        filename: process.env.DATABASE_URL?.replace('sqlite:', '') || './office.db',
        driver: sqlite3.Database
    });
}

export async function initializeDb(db: Database) {
    await db.exec(`
    CREATE TABLE IF NOT EXISTS offices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config JSON NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      office_id TEXT REFERENCES offices(id),
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      config JSON NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      agent_id TEXT REFERENCES agents(id),
      type TEXT,
      content TEXT NOT NULL,
      importance REAL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
