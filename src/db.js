'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

/** MySQL 连接管理（mysql2/promise 连接池，全程 utf8mb4）。 */

/* 配置在调用时读取环境变量（惰性），便于测试在每个文件 test.before 里
   切换到独立数据库（process.env.DB_NAME），实现并行测试隔离。 */
function config() {
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 13380,
    user: process.env.DB_USER || 'care',
    password: process.env.DB_PASSWORD || 'carepass',
    database: process.env.DB_NAME || 'eldercare',
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 10,
  };
}

/* 兼容历史导出（部分模块可能直接引用 DB_CONFIG） */
const DB_CONFIG = new Proxy({}, {
  get(_t, prop) { return config()[prop]; },
});

let pool = null;

function getPool() {
  if (!pool) pool = mysql.createPool(config());
  return pool;
}

async function ensureSchema() {
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const conn = await mysql.createConnection({ ...config(), multipleStatements: true });
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
    for (const t of ['reservations', 'time_slots', 'orders', 'meals', 'elders', 'canteens', 'users']) {
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
      const conn = await mysql.createConnection({ ...config(), database: undefined });
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

module.exports = { getPool, ensureSchema, resetAll, waitForDb, close, DB_CONFIG, config };
