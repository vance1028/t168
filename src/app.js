'use strict';

const express = require('express');
const cors = require('cors');

const authRouter = require('./routes/auth');
const usersRouter = require('./routes/users');
const canteensRouter = require('./routes/canteens');
const eldersRouter = require('./routes/elders');
const mealsRouter = require('./routes/meals');
const ordersRouter = require('./routes/orders');
const { sendError } = require('./utils/http');

function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', service: '社区长者助餐运营管理平台', time: new Date().toISOString() });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/canteens', canteensRouter);
  app.use('/api/elders', eldersRouter);
  app.use('/api/meals', mealsRouter);
  app.use('/api/orders', ordersRouter);

  app.use((req, res) => sendError(res, 404, '接口不存在'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return sendError(res, 400, '请求体不是合法的 JSON');
    if (err && err.statusCode) return sendError(res, err.statusCode, err.message);
    // eslint-disable-next-line no-console
    console.error(err);
    return sendError(res, 500, '服务器内部错误');
  });

  return app;
}

module.exports = { createApp };
