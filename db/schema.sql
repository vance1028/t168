-- 社区长者助餐运营管理平台 表结构（全程 utf8mb4，确保中文正常）
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  username      VARCHAR(64) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  name          VARCHAR(64) NOT NULL,
  role          VARCHAR(16) NOT NULL DEFAULT 'VIEWER',
  status        VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 助餐点（社区食堂）
CREATE TABLE IF NOT EXISTS canteens (
  id          INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  code        VARCHAR(32) NOT NULL UNIQUE,
  name        VARCHAR(128) NOT NULL,
  district    VARCHAR(64) NOT NULL,
  address     VARCHAR(255) NOT NULL DEFAULT '',
  capacity    INT NOT NULL DEFAULT 0,
  status      VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 长者档案
CREATE TABLE IF NOT EXISTS elders (
  id            INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  code          VARCHAR(32) NOT NULL UNIQUE,
  name          VARCHAR(64) NOT NULL,
  gender        VARCHAR(8) NOT NULL DEFAULT 'U',
  age           INT NOT NULL DEFAULT 0,
  phone         VARCHAR(32) NOT NULL DEFAULT '',
  subsidy_level VARCHAR(8) NOT NULL DEFAULT 'C',
  dietary       VARCHAR(255) NOT NULL DEFAULT '',
  canteen_id    INT UNSIGNED NULL,
  status        VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_elder_canteen FOREIGN KEY (canteen_id) REFERENCES canteens(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 餐次（某助餐点某日某餐别提供的菜品）
CREATE TABLE IF NOT EXISTS meals (
  id          INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  canteen_id  INT UNSIGNED NOT NULL,
  serve_date  DATE NOT NULL,
  meal_type   VARCHAR(16) NOT NULL DEFAULT 'LUNCH',
  dish_name   VARCHAR(128) NOT NULL,
  price_cents INT NOT NULL DEFAULT 0,
  status      VARCHAR(16) NOT NULL DEFAULT 'PUBLISHED',
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_meal_canteen FOREIGN KEY (canteen_id) REFERENCES canteens(id) ON DELETE CASCADE,
  INDEX idx_meal_date (serve_date),
  INDEX idx_meal_canteen (canteen_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 订餐
CREATE TABLE IF NOT EXISTS orders (
  id           INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  elder_id     INT UNSIGNED NOT NULL,
  meal_id      INT UNSIGNED NOT NULL,
  slot_id      INT UNSIGNED NULL,
  dining_type  VARCHAR(16) NOT NULL DEFAULT 'DINE_IN',
  qty          INT NOT NULL DEFAULT 1,
  amount_cents INT NOT NULL DEFAULT 0,
  subsidy_cents INT NOT NULL DEFAULT 0,
  pay_cents    INT NOT NULL DEFAULT 0,
  status       VARCHAR(16) NOT NULL DEFAULT 'RESERVED',
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_order_elder FOREIGN KEY (elder_id) REFERENCES elders(id) ON DELETE CASCADE,
  CONSTRAINT fk_order_meal FOREIGN KEY (meal_id) REFERENCES meals(id) ON DELETE CASCADE,
  INDEX idx_order_status (status),
  INDEX idx_order_elder (elder_id),
  INDEX idx_order_slot (slot_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========================================
-- 分时段预约：时段配额表
-- 每个助餐点某日某餐别的一个时段档位（如 2026-06-21 午餐 11:00-11:30）
-- 含乐观锁 version，用于并发占用/释放的原子性保证
-- ========================================
CREATE TABLE IF NOT EXISTS time_slots (
  id          INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  canteen_id  INT UNSIGNED NOT NULL,
  serve_date  DATE NOT NULL,
  meal_type   VARCHAR(16) NOT NULL DEFAULT 'LUNCH',
  start_time  TIME NOT NULL,
  end_time    TIME NOT NULL,
  capacity    INT NOT NULL DEFAULT 0,
  used        INT NOT NULL DEFAULT 0,
  version     INT NOT NULL DEFAULT 0,
  status      VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_slot_canteen FOREIGN KEY (canteen_id) REFERENCES canteens(id) ON DELETE CASCADE,
  UNIQUE KEY uk_slot_unique (canteen_id, serve_date, meal_type, start_time),
  INDEX idx_slot_date (serve_date),
  INDEX idx_slot_canteen_date (canteen_id, serve_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========================================
-- 分时段预约：预约 / 候补中表
-- kind = CONFIRMED 表示占用了正式名额，used 计数+1
-- kind = WAITLIST  表示在候补队列，由 waitlist_seq 决定排队先后
-- waitlist_seq 单调递增：按入队顺序编号，递补时严格按 seq 升序
-- 乐观锁 version 防止并发下同一候补被重复递补
-- ========================================
CREATE TABLE IF NOT EXISTS reservations (
  id              INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  order_id        INT UNSIGNED NOT NULL UNIQUE,
  elder_id        INT UNSIGNED NOT NULL,
  slot_id         INT UNSIGNED NOT NULL,
  kind            VARCHAR(16) NOT NULL DEFAULT 'CONFIRMED',
  waitlist_seq    INT UNSIGNED NULL,
  status          VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  promoted_at     DATETIME(3) NULL,
  version         INT NOT NULL DEFAULT 0,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_resv_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_resv_elder FOREIGN KEY (elder_id) REFERENCES elders(id) ON DELETE CASCADE,
  CONSTRAINT fk_resv_slot  FOREIGN KEY (slot_id)  REFERENCES time_slots(id) ON DELETE CASCADE,
  UNIQUE KEY uk_resv_waitlist_seq (slot_id, waitlist_seq),
  INDEX idx_resv_slot_kind (slot_id, kind, status),
  INDEX idx_resv_waitlist  (slot_id, kind, waitlist_seq),
  INDEX idx_resv_elder     (elder_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
