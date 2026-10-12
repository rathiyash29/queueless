// db.js - creates ONE connection pool that every other file shares.
// A pool keeps a few MySQL connections open and reuses them (faster than reconnecting).
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true }); // reads server/.env
const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || "queueless",
  connectionLimit: 10,
  dateStrings: true,   // give dates back as plain text like "2026-10-12 14:30:00"
  charset: "utf8mb4"
});

module.exports = pool;
