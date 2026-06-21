'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

/**
 * 测试隔离辅助：每个测试文件在 test.before 里创建一个独立数据库，
 * 在 test.after 里删除。由于 `node --test` 默认把每个测试文件跑在
 * 独立子进程中，各文件的独立库互不干扰，从而默认并发也能稳定通过。
 *
 * DDL（建库/授权/删库）用 root 账号；被测应用的连接池仍用 `care`
 * 账号（与生产一致的受限权限），由 GRANT 授予该独立库的访问权。
 */

const ROOT_CONFIG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 13380,
  user: process.env.DB_ROOT_USER || 'root',
  password: process.env.DB_ROOT_PASSWORD || 'rootpass',
  charset: 'utf8mb4',
};

const APP_USER = process.env.DB_USER || 'care';
const APP_PASSWORD = process.env.DB_PASSWORD || 'carepass';

function uniqueDbName() {
  const rand = Math.random().toString(36).slice(2, 10);
  return `ec_test_${process.pid}_${Date.now().toString(36)}_${rand}`;
}

/** 建独立库 + 授权 + 载入 schema；返回库名，并设置 process.env.DB_NAME 指向它。 */
async function setupIsolatedDb() {
  const dbName = uniqueDbName();
  const conn = await mysql.createConnection({ ...ROOT_CONFIG, multipleStatements: true });
  try {
    await conn.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    // 兼容非 docker 环境：用户可能尚未创建（docker 已建）
    await conn.query(`CREATE USER IF NOT EXISTS '${APP_USER}'@'%' IDENTIFIED BY '${APP_PASSWORD}'`);
    await conn.query(`GRANT ALL ON \`${dbName}\`.* TO '${APP_USER}'@'%'`);
    await conn.query(`USE \`${dbName}\``);
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    await conn.query(sql);
  } finally {
    await conn.end();
  }
  process.env.DB_NAME = dbName;
  return dbName;
}

/** 删除独立库。 */
async function teardownIsolatedDb(dbName) {
  const conn = await mysql.createConnection(ROOT_CONFIG);
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  } finally {
    await conn.end();
  }
}

module.exports = { setupIsolatedDb, teardownIsolatedDb, ROOT_CONFIG };
