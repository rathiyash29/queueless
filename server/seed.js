// seed.js - run once with:  npm run seed
// Creates the first admin (from .env) and three starting services.
// Safe to run again: it will not create duplicates.
const bcrypt = require("bcryptjs");
const db = require("./db");

async function seed() {
  const name = process.env.ADMIN_NAME || "Admin";
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";

  if (!email || password.length < 8) {
    console.log("Set ADMIN_EMAIL and ADMIN_PASSWORD (min 8 characters) in server/.env first.");
    process.exit(1);
  }

  // Admin account
  const [found] = await db.query("SELECT id FROM users WHERE email = ?", [email]);
  if (found.length === 0) {
    const hash = await bcrypt.hash(password, 10);   // 10 = how many times it is scrambled
    await db.query(
      "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')",
      [name, email, hash]
    );
    console.log("Admin created:", email);
  } else {
    console.log("Admin already exists:", email);
  }

  // Starting services (only if there are none yet)
  const [services] = await db.query("SELECT id FROM services");
  if (services.length === 0) {
    await db.query(
      "INSERT INTO services (name, prefix, counter_no, icon) VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)",
      ["College Office", "A", 1, "🏫", "Canteen", "B", 2, "🍽️", "Library", "C", 3, "📚"]
    );
    console.log("Default services created.");
  }

  await db.end();
}

seed().catch(err => {
  console.log("Seed failed:", err.message);
  process.exit(1);
});
