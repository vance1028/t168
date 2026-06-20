'use strict';

const { createApp } = require('./app');
const { getPool, ensureSchema, waitForDb } = require('./db');
const { seed } = require('./seed');

const PORT = Number(process.env.PORT) || 5090;

async function main() {
  await waitForDb();
  await ensureSchema();
  getPool();
  if (process.env.SEED_ON_START !== 'false') {
    const result = await seed();
    // eslint-disable-next-line no-console
    console.log('种子数据:', result.skipped ? '已存在，跳过' : JSON.stringify(result));
  }
  const app = createApp();
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`社区长者助餐运营管理平台 API 已启动: http://localhost:${PORT}`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
