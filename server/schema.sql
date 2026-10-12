-- QueueLess database schema.
-- First create an empty database, then load this file into it (see README, Step 4):
--   mysql -u YOUR_USER -p -e "CREATE DATABASE queueless"
--   mysql -u YOUR_USER -p queueless -e "source server/schema.sql"
-- It is safe to run again: nothing is dropped, tables are only created if missing.

-- 1. USERS: students and admins (role column tells them apart)
CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(150) NOT NULL UNIQUE,      -- UNIQUE: no two accounts with the same email
  password_hash VARCHAR(100) NOT NULL,             -- bcrypt hash, NEVER the real password
  role          ENUM('student', 'admin') NOT NULL DEFAULT 'student',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. SERVICES: the queues people can join (College Office, Canteen, ...)
-- is_active = 0 means "deleted". We hide the row instead of removing it,
-- so old tickets in students' history still have a service to point to.
CREATE TABLE IF NOT EXISTS services (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(100) NOT NULL,
  prefix     CHAR(1) NOT NULL,                     -- letter used in token labels: A-001
  counter_no INT NOT NULL,
  icon       VARCHAR(10) NOT NULL DEFAULT '📄',
  is_active  TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) DEFAULT CHARSET = utf8mb4;

-- 3. TICKETS: one row per token a student takes
CREATE TABLE IF NOT EXISTS tickets (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NOT NULL,
  service_id    INT NOT NULL,
  queue_date    DATE NOT NULL,                     -- token numbers restart every day
  token_number  INT NOT NULL,                      -- 1, 2, 3 ... for that service on that day
  status        ENUM('WAITING','CALLED','COMPLETED','SKIPPED','CANCELLED') NOT NULL DEFAULT 'WAITING',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  called_at     DATETIME NULL,
  completed_at  DATETIME NULL,
  cancelled_at  DATETIME NULL,
  FOREIGN KEY (user_id)    REFERENCES users(id),
  FOREIGN KEY (service_id) REFERENCES services(id),
  -- Safety net: the database itself refuses a duplicate token number
  UNIQUE KEY one_number_per_day (service_id, queue_date, token_number),
  INDEX idx_queue (service_id, queue_date, status),
  INDEX idx_user (user_id, status)
);
