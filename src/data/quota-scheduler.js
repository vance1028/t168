'use strict';

/**
 * 配额与候补调度 —— 纯逻辑模块
 * 核心诉求：
 *   1) 时段容量占用并发安全（used 绝不超 capacity）
 *   2) 候补严格按入队顺序递补，并发不错位、不超额、同一名额不同时给两人
 *   3) 错峰推荐（空闲优先，避开高峰）
 *   4) 容量调整时已有预约/候补的正确处置
 *
 * 所有公共函数要求调用方提供一个已开启事务的连接 conn（或 pool），
 * 本模块内部只做 SQL 拼装与执行，事务提交/回滚由上层（store.js）控制。
 */

const errors = {
  SLOT_NOT_FOUND: 'SLOT_NOT_FOUND',
  SLOT_INACTIVE: 'SLOT_INACTIVE',
  SLOT_FULL: 'SLOT_FULL',
  ALREADY_RESERVED: 'ALREADY_RESERVED',
  NO_WAITLIST_TO_PROMOTE: 'NO_WAITLIST_TO_PROMOTE',
  CAPACITY_SHRINK_CONFLICT: 'CAPACITY_SHRINK_CONFLICT',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  RESERVATION_NOT_FOUND: 'RESERVATION_NOT_FOUND',
};

/* ------------------------------ 工具 ------------------------------ */

async function lockSlot(conn, slotId) {
  const [rows] = await conn.query(
    'SELECT * FROM time_slots WHERE id = ? FOR UPDATE',
    [slotId],
  );
  if (!rows.length) throw new SlotError(errors.SLOT_NOT_FOUND, `时段 ${slotId} 不存在`);
  const s = rows[0];
  if (s.status !== 'ACTIVE') throw new SlotError(errors.SLOT_INACTIVE, `时段未开放`);
  return s;
}

class SlotError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'SlotError';
  }
}

function toCamel(r) {
  if (!r) return null;
  return {
    id: r.id,
    canteenId: r.canteen_id,
    serveDate: r.serve_date,
    mealType: r.meal_type,
    startTime: r.start_time,
    endTime: r.end_time,
    capacity: r.capacity,
    used: r.used,
    version: r.version,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapReservation(r) {
  if (!r) return null;
  return {
    id: r.id,
    orderId: r.order_id,
    elderId: r.elder_id,
    slotId: r.slot_id,
    kind: r.kind,
    waitlistSeq: r.waitlist_seq,
    status: r.status,
    promotedAt: r.promoted_at,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* =================== 1. 尝试占用一个正式名额 ===================
 * 用 version 乐观锁做原子 CAS：
 *   UPDATE time_slots SET used = used+1, version = version+1
 *   WHERE id = ? AND version = ? AND used < capacity
 * 若影响行数 = 1，占用成功；否则说明并发冲突或已满，重试或报错。
 */
async function tryConfirmSlot(conn, slotId, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const slot = await lockSlot(conn, slotId);
    if (slot.used >= slot.capacity) {
      throw new SlotError(errors.SLOT_FULL, `时段已满（${slot.used}/${slot.capacity}）`);
    }
    const [upd] = await conn.query(
      `UPDATE time_slots
         SET used = used + 1,
             version = version + 1,
             updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND version = ? AND used < capacity`,
      [slotId, slot.version],
    );
    if (upd.affectedRows === 1) {
      const [rows] = await conn.query('SELECT * FROM time_slots WHERE id = ?', [slotId]);
      return toCamel(rows[0]);
    }
  }
  throw new SlotError(errors.VERSION_CONFLICT, '并发冲突，多次重试失败');
}

/* =================== 2. 入候补队列 ===================
 * 在同一事务内对 slot 加锁，取 MAX(waitlist_seq)+1 作为新入队者的序号，
 * 保证 waitlist_seq 全局单调递增（不会重复）。
 */
async function enqueueWaitlist(conn, slotId, { orderId, elderId }) {
  await lockSlot(conn, slotId);
  const [seqRows] = await conn.query(
    `SELECT COALESCE(MAX(waitlist_seq), 0) AS max_seq
       FROM reservations
      WHERE slot_id = ? AND kind = 'WAITLIST'
        FOR UPDATE`,
    [slotId],
  );
  const nextSeq = Number(seqRows[0].max_seq) + 1;
  await conn.query(
    `INSERT INTO reservations (order_id, elder_id, slot_id, kind, waitlist_seq, status)
     VALUES (?, ?, ?, 'WAITLIST', ?, 'ACTIVE')`,
    [orderId, elderId, slotId, nextSeq],
  );
  const [rows] = await conn.query(
    `SELECT * FROM reservations WHERE order_id = ?`,
    [orderId],
  );
  return { reservation: mapReservation(rows[0]), waitlistSeq: nextSeq };
}

/* =================== 3. 释放正式名额 + 触发候补递补 ===================
 * 步骤（同一事务，slot 行锁保护全程）：
 *   a. used -= 1 释放（version CAS）
 *   b. while used < capacity：
 *        i.  SELECT ... FOR UPDATE 按 waitlist_seq ASC 取队头一条 WAITLIST 状态的候补
 *       ii.  用 version 乐观锁把它 UPDATE 成 CONFIRMED（避免重复递补）
 *      iii.  成功则 used += 1，否则跳过（可能被并发抢先递补了）
 *   c. 返回所有被递补的 reservation 列表（供上层发通知）
 */
async function releaseSlotAndPromote(conn, slotId, confirmedReservationId, maxRetries = 3) {
  const promoted = [];
  let slot = null;

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    slot = await lockSlot(conn, slotId);
    const [upd] = await conn.query(
      `UPDATE time_slots
         SET used = used - 1,
             version = version + 1,
             updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND version = ? AND used > 0`,
      [slotId, slot.version],
    );
    if (upd.affectedRows === 1) break;
    if (attempt === maxRetries - 1) {
      throw new SlotError(errors.VERSION_CONFLICT, '释放名额时并发冲突');
    }
  }

  // 把该确认预约标记为释放（状态改为 CANCELLED）
  if (confirmedReservationId !== undefined && confirmedReservationId !== null) {
    await conn.query(
      `UPDATE reservations SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP(3)
        WHERE id = ?`,
      [confirmedReservationId],
    );
  }

  // —— 递补循环 ——
  while (true) {
    slot = await lockSlot(conn, slotId);
    if (slot.used >= slot.capacity) break;

    const [waiters] = await conn.query(
      `SELECT * FROM reservations
        WHERE slot_id = ? AND kind = 'WAITLIST' AND status = 'ACTIVE'
        ORDER BY waitlist_seq ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [slotId],
    );
    if (!waiters.length) break;
    const w = waiters[0];

    // 乐观锁：只有 version 对得上才递补，否则说明已被另一并发抢走
    const [promoteUpd] = await conn.query(
      `UPDATE reservations
         SET kind        = 'CONFIRMED',
             waitlist_seq = NULL,
             status       = 'PROMOTED',
             promoted_at  = CURRENT_TIMESTAMP(3),
             version      = version + 1,
             updated_at   = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND version = ? AND kind = 'WAITLIST' AND status = 'ACTIVE'`,
      [w.id, w.version],
    );
    if (promoteUpd.affectedRows !== 1) continue;

    // 递补成功 -> used += 1（同样走 CAS）
    let promotedOk = false;
    for (let i = 0; i < maxRetries; i += 1) {
      const cur = await lockSlot(conn, slotId);
      const [useUpd] = await conn.query(
        `UPDATE time_slots
           SET used = used + 1,
               version = version + 1,
               updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND version = ? AND used < capacity`,
        [slotId, cur.version],
      );
      if (useUpd.affectedRows === 1) {
        promotedOk = true;
        break;
      }
    }
    if (!promotedOk) {
      // 理论上极端情况：容量刚被运营砍了。回滚这次递补，重新放回候补（保留原 seq 不变）。
      await conn.query(
        `UPDATE reservations
           SET kind        = 'WAITLIST',
               waitlist_seq = ?,
               status       = 'ACTIVE',
               promoted_at  = NULL,
               version      = version + 1
         WHERE id = ?`,
        [w.waitlist_seq, w.id],
      );
      break;
    }

    const [rows] = await conn.query(`SELECT * FROM reservations WHERE id = ?`, [w.id]);
    promoted.push(mapReservation(rows[0]));
  }

  const [finalSlot] = await conn.query('SELECT * FROM time_slots WHERE id = ?', [slotId]);
  return {
    slot: toCamel(finalSlot[0]),
    promoted,
  };
}

/* =================== 4. 容量调整：扩大 / 缩小 ===================
 * 规则：
 *   - 容量扩大：直接 UPDATE，然后从候补队头尽可能递补上来
 *   - 容量缩小：若 newCapacity < used，需把超出部分 CONFIRMED -> WAITLIST（按创建时间晚的先转），
 *     差额再从候补递补？不，缩容时不会有剩余，直接把超出的正式用户转为候补队尾
 * 返回结果：{ slot, demoted, promoted }
 */
async function resizeCapacity(conn, slotId, newCapacity, maxRetries = 3) {
  if (newCapacity < 0) throw new SlotError('INVALID_CAPACITY', '容量不能为负');

  const demoted = [];
  const promoted = [];
  let slot = null;

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    slot = await lockSlot(conn, slotId);
    const [upd] = await conn.query(
      `UPDATE time_slots
         SET capacity = ?,
             version  = version + 1,
             updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND version = ?`,
      [newCapacity, slotId, slot.version],
    );
    if (upd.affectedRows === 1) break;
    if (attempt === maxRetries - 1) {
      throw new SlotError(errors.VERSION_CONFLICT, '调整容量时并发冲突');
    }
  }

  slot = await lockSlot(conn, slotId);

  // ---------- 缩容：正式名额超出部分转到候补 ----------
  if (slot.used > newCapacity) {
    const overflow = slot.used - newCapacity;
    // 按 created_at 倒序，把最近创建的 overflow 个 CONFIRMED 转为候补
    const [victims] = await conn.query(
      `SELECT * FROM reservations
        WHERE slot_id = ? AND kind = 'CONFIRMED' AND status IN ('ACTIVE','PROMOTED')
        ORDER BY created_at DESC, id DESC
        LIMIT ?
        FOR UPDATE`,
      [slotId, overflow],
    );

    // 取当前候补最大序号，避免冲突
    const [seqRows] = await conn.query(
      `SELECT COALESCE(MAX(waitlist_seq), 0) AS max_seq
         FROM reservations
        WHERE slot_id = ? AND kind = 'WAITLIST'`,
      [slotId],
    );
    let seq = Number(seqRows[0].max_seq);

    for (const v of victims) {
      seq += 1;
      await conn.query(
        `UPDATE reservations
           SET kind         = 'WAITLIST',
               waitlist_seq = ?,
               status       = 'ACTIVE',
               promoted_at  = NULL,
               version      = version + 1,
               updated_at   = CURRENT_TIMESTAMP(3)
         WHERE id = ?`,
        [seq, v.id],
      );
      const [rows] = await conn.query(`SELECT * FROM reservations WHERE id = ?`, [v.id]);
      demoted.push(mapReservation(rows[0]));
    }
    // 同步 used = newCapacity
    await conn.query(
      `UPDATE time_slots
         SET used = ?, updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?`,
      [newCapacity, slotId],
    );
    slot = await lockSlot(conn, slotId);
  }

  // ---------- 扩容：有空闲名额就从候补递补 ----------
  while (slot.used < slot.capacity) {
    const [waiters] = await conn.query(
      `SELECT * FROM reservations
        WHERE slot_id = ? AND kind = 'WAITLIST' AND status = 'ACTIVE'
        ORDER BY waitlist_seq ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [slotId],
    );
    if (!waiters.length) break;
    const w = waiters[0];
    const [promoteUpd] = await conn.query(
      `UPDATE reservations
         SET kind         = 'CONFIRMED',
             waitlist_seq = NULL,
             status       = 'PROMOTED',
             promoted_at  = CURRENT_TIMESTAMP(3),
             version      = version + 1,
             updated_at   = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND version = ? AND kind = 'WAITLIST' AND status = 'ACTIVE'`,
      [w.id, w.version],
    );
    if (promoteUpd.affectedRows !== 1) continue;

    let promoteOk = false;
    for (let i = 0; i < maxRetries; i += 1) {
      const cur = await lockSlot(conn, slotId);
      const [useUpd] = await conn.query(
        `UPDATE time_slots
           SET used = used + 1,
               version = version + 1,
               updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND version = ? AND used < capacity`,
        [slotId, cur.version],
      );
      if (useUpd.affectedRows === 1) { promoteOk = true; break; }
    }
    if (!promoteOk) {
      await conn.query(
        `UPDATE reservations
           SET kind         = 'WAITLIST',
               waitlist_seq = ?,
               status       = 'ACTIVE',
               promoted_at  = NULL,
               version      = version + 1
         WHERE id = ?`,
        [w.waitlist_seq, w.id],
      );
      break;
    }
    const [rows] = await conn.query(`SELECT * FROM reservations WHERE id = ?`, [w.id]);
    promoted.push(mapReservation(rows[0]));
    slot = await lockSlot(conn, slotId);
  }

  const [finalSlot] = await conn.query('SELECT * FROM time_slots WHERE id = ?', [slotId]);
  return {
    slot: toCamel(finalSlot[0]),
    demoted,
    promoted,
  };
}

/* =================== 5. 错峰推荐 ===================
 * 输入：同助餐点同日同餐别的时段列表（[{id,capacity,used,startTime,waitlistCount}]）
 * 输出：按「空闲程度优先 + 时段顺序」排序的推荐列表
 *   评分规则：
 *     剩余率 = (capacity - used) / capacity（越高越推荐）
 *     若剩余率相同，waitlist 越少越推荐
 *     再按时间升序（早一点的时段通常更空）
 */
function recommendOffPeak(slots) {
  if (!slots || !slots.length) return [];
  return slots
    .filter(s => s.status === 'ACTIVE' && s.capacity > 0)
    .map((s) => {
      const remaining = Math.max(0, s.capacity - s.used);
      const remainingRate = remaining / s.capacity;
      const waitlist = s.waitlistCount ?? 0;
      return {
        ...s,
        remaining,
        remainingRate,
        // 评分：剩余率 70% - 候补比例 30%
        score: remainingRate * 0.7 - Math.min(1, waitlist / s.capacity) * 0.3,
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // 分数相同：有剩余名额排前面
      if ((b.remaining > 0) !== (a.remaining > 0)) return (b.remaining > 0) - (a.remaining > 0);
      // 再相同：早的时段优先
      return String(a.startTime).localeCompare(String(b.startTime));
    });
}

/* =================== 6. 冷热分布（运营视图辅助） ===================
 * 把一批时段按「热度」打标签：
 *   HOT      used >= 0.9 * capacity 或候补 > 0
 *   WARM     used >= 0.6 * capacity
 *   COOL     used < 0.6 * capacity
 *   EMPTY    used === 0
 */
function classifyHeat(slots) {
  return (slots || []).map((s) => {
    const ratio = s.capacity > 0 ? s.used / s.capacity : 0;
    const waitlist = s.waitlistCount ?? 0;
    let heat;
    if (s.used === 0) heat = 'EMPTY';
    else if (ratio >= 0.9 || waitlist > 0) heat = 'HOT';
    else if (ratio >= 0.6) heat = 'WARM';
    else heat = 'COOL';
    return { ...s, heat, fillRatio: Number(ratio.toFixed(4)) };
  });
}

module.exports = {
  errors,
  SlotError,
  tryConfirmSlot,
  enqueueWaitlist,
  releaseSlotAndPromote,
  resizeCapacity,
  recommendOffPeak,
  classifyHeat,
  // 导出给 store 层复用
  toCamel,
  mapReservation,
  lockSlot,
};
