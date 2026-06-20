'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

/** MySQL 连接管理（mysql2/promise 连接池，全程 utf8mb4）。 */

const DB_CONFIG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 13377,
  user: process.env.DB_USER || 'care',
  password: process.env.DB_PASSWORD || 'carepass',
  database: process.env.DB_NAME || 'eldercare',
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
};

let pool = null;

function getPool() {
  if (!pool) pool = mysql.createPool(DB_CONFIG);
  return pool;
}

async function ensureSchema() {
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const conn = await mysql.createConnection({ ...DB_CONFIG, multipleStatements: true });
  try {
    await conn.query(sql);
  } finally {
    await conn.end();
  }
}

async function resetAll() {
  const conn = await getPool().getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of ['orders', 'meals', 'elders', 'canteens', 'users']) {
      await conn.query(`TRUNCATE TABLE ${t}`);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    conn.release();
  }
}

async function waitForDb(retries = 60, delayMs = 1000) {
  for (let i = 0; i < retries; i += 1) {
    try {
      const conn = await mysql.createConnection({ ...DB_CONFIG, database: undefined });
      await conn.end();
      return true;
    } catch (e) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('数据库连接超时');
}

async function close() {
  if (pool) { await pool.end(); pool = null; }
}

module.exports = { getPool, ensureSchema, resetAll, waitForDb, close, DB_CONFIG };
