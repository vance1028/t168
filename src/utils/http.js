'use strict';

/** 统一响应：成功 { data, ... }，失败 { error: { message } }。 */
function sendData(res, status, data, extra = {}) {
  return res.status(status).json({ data, ...extra });
}
function sendError(res, status, message) {
  return res.status(status).json({ error: { message } });
}
function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('非法的 id');
    err.statusCode = 400;
    throw err;
  }
  return id;
}

module.exports = { sendData, sendError, parseId };
