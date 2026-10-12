// routes.js - ALL the REST API of QueueLess, plus the queue logic.
// Each route = one URL the frontend can call with fetch().
// Express 5 automatically passes errors thrown inside async routes to the error handler in server.js.
const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("./db");
const { fail, makeToken, requireLogin, requireRole } = require("./auth");

const WAIT_PER_PERSON = 4;                       // estimated minutes per person ahead
const ACTIVE = ["WAITING", "CALLED", "SKIPPED"]; // a ticket is "active" while it is in one of these

// We pass in the Socket.IO object (io) so routes can announce changes.
module.exports = function (io) {
  const router = express.Router();

  // ---------------------------------------------------------------
  // HELPER FUNCTIONS
  // ---------------------------------------------------------------

  // Token label like "A-007"
  function makeLabel(prefix, number) {
    return prefix + "-" + String(number).padStart(3, "0");
  }

  // Check that a value from the URL/body is a whole number
  function toId(value) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw fail(400, "Invalid id");
    return id;
  }

  // Runs queue changes safely.
  // 1. Starts a transaction (all-or-nothing).
  // 2. Locks the service row with "FOR UPDATE". If two requests touch the same service
  //    at the same moment, the second one WAITS until the first one finishes.
  //    This is what stops two admins calling the same token, or two students getting the same number.
  async function withServiceLock(serviceId, work) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query(
        "SELECT id FROM services WHERE id = ? AND is_active = 1 FOR UPDATE", [serviceId]);
      if (rows.length === 0) throw fail(404, "Service not found");
      const result = await work(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  // Tell connected browsers that something changed. Called only AFTER the database commit.
  // We only send a small "something changed" signal; browsers then ask the REST API for
  // the real data, so nobody receives data they are not allowed to see.
  async function notifyQueueChanged(serviceId, changedUserId) {
    try {
      io.to("admins").emit("queue-changed", { serviceId: serviceId });

      // Every student still in this service's queue today (+ the student who just changed)
      const [rows] = await db.query(
        "SELECT DISTINCT user_id FROM tickets WHERE service_id = ? AND queue_date = CURDATE() AND status IN (?)",
        [serviceId, ACTIVE]);
      const userIds = rows.map(r => r.user_id);
      if (changedUserId && !userIds.includes(changedUserId)) userIds.push(changedUserId);
      userIds.forEach(id => io.to("user:" + id).emit("ticket-changed"));
    } catch (err) {
      console.log("Socket notify failed:", err.message);
    }
  }

  // Moves one ticket from one status to another. Used by complete, skip, recall and cancel.
  //   from       - statuses the ticket is allowed to be in right now
  //   to         - the new status
  //   timeColumn - which timestamp column to fill (or null)
  //   onlyUserId - if given, the ticket must belong to this user (students can only touch their own)
  //   mustBeFree - if true, no other ticket of this service may be CALLED (used by recall)
  async function moveTicket(ticketId, options) {
    const [found] = await db.query("SELECT service_id, user_id FROM tickets WHERE id = ?", [ticketId]);
    // Same message for "not found" and "not yours", so nobody can discover other people's ticket ids
    if (found.length === 0 || (options.onlyUserId && found[0].user_id !== options.onlyUserId)) {
      throw fail(404, "Ticket not found");
    }
    const serviceId = found[0].service_id;

    await withServiceLock(serviceId, async (conn) => {
      if (options.mustBeFree) {
        const [called] = await conn.query(
          "SELECT id FROM tickets WHERE service_id = ? AND queue_date = CURDATE() AND status = 'CALLED'", [serviceId]);
        if (called.length > 0) throw fail(409, "Mark the current token as completed or skip it first");
      }
      const timeSql = options.timeColumn ? ", " + options.timeColumn + " = NOW()" : ""; // timeColumn is fixed text from our code, not user input
      // The "AND status IN (...)" makes this update atomic: if the status already changed, 0 rows are updated.
      const [result] = await conn.query(
        "UPDATE tickets SET status = ?" + timeSql + " WHERE id = ? AND status IN (?)",
        [options.to, ticketId, options.from]);
      if (result.affectedRows === 0) {
        throw fail(409, "This ticket cannot be changed from its current status");
      }
    });

    await notifyQueueChanged(serviceId, found[0].user_id);
    return { serviceId: serviceId };
  }

  // Close yesterday's (and older) unfinished tickets so they leave the live queue.
  // Queues are daily, so anything still waiting from an earlier day is closed as CANCELLED.
  async function expireOldTickets() {
    await db.query(
      "UPDATE tickets SET status = 'CANCELLED', cancelled_at = NOW() WHERE queue_date < CURDATE() AND status IN (?)",
      [ACTIVE]);
  }
  router.use(async (req, res, next) => {
    await expireOldTickets();
    next();
  });

  // ---------------------------------------------------------------
  // 1. REGISTER AND LOGIN  (public)
  // ---------------------------------------------------------------
  router.post("/register", async (req, res) => {
    const body = req.body || {};
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (name === "" || email === "" || password === "") throw fail(400, "Please fill all fields");
    if (name.length > 100 || email.length > 150) throw fail(400, "Name or email is too long");
    if (!email.includes("@") || !email.includes(".")) throw fail(400, "Enter a valid email");
    if (password.length < 6) throw fail(400, "Password must be at least 6 characters");

    const [existing] = await db.query("SELECT id FROM users WHERE email = ?", [email]);
    if (existing.length > 0) throw fail(409, "Email already registered");

    const hash = await bcrypt.hash(password, 10);   // scramble the password; only the hash is stored
    // The role is ALWAYS 'student' here. Nobody can register themselves as admin.
    await db.query("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'student')",
      [name, email, hash]);
    res.status(201).json({ message: "Registered successfully! Now login." });
  });

  router.post("/login", async (req, res) => {
    const body = req.body || {};
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    const [rows] = await db.query("SELECT id, name, role, password_hash FROM users WHERE email = ?", [email]);
    const user = rows[0];
    // Same message for "no such email" and "wrong password"
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      throw fail(401, "Wrong email or password");
    }
    res.json({
      token: makeToken(user),
      user: { id: user.id, name: user.name, role: user.role }
    });
  });

  // Lets the frontend check that its saved token is still valid
  router.get("/me", requireLogin, (req, res) => {
    res.json({ id: req.user.id, name: req.user.name, role: req.user.role });
  });

  // ---------------------------------------------------------------
  // 2. SERVICES
  // ---------------------------------------------------------------
  // Anyone can see the list of services (the home page shows it)
  router.get("/services", async (req, res) => {
    const [rows] = await db.query(
      "SELECT id, name, prefix, counter_no, icon FROM services WHERE is_active = 1 ORDER BY id");
    res.json(rows);
  });

  // Admin: add a service
  router.post("/services", requireLogin, requireRole("admin"), async (req, res) => {
    const body = req.body || {};
    const name = String(body.name || "").trim();
    const counter = Number(body.counter);

    if (name === "" || name.length > 100) throw fail(400, "Enter a service name (max 100 characters)");
    if (!Number.isInteger(counter) || counter <= 0) throw fail(400, "Counter must be a positive whole number");

    // Pick the first letter A-Z that no active service is using
    const [used] = await db.query("SELECT prefix FROM services WHERE is_active = 1");
    const usedLetters = used.map(s => s.prefix);
    let prefix = null;
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(65 + i);
      if (!usedLetters.includes(letter)) { prefix = letter; break; }
    }
    if (prefix === null) throw fail(400, "No free prefix letters left");

    await db.query("INSERT INTO services (name, prefix, counter_no, icon) VALUES (?, ?, ?, '📄')",
      [name, prefix, counter]);
    io.emit("services-changed");
    res.status(201).json({ message: "Service added" });
  });

  // Admin: delete a service (only if nobody is waiting in it)
  router.delete("/services/:id", requireLogin, requireRole("admin"), async (req, res) => {
    const serviceId = toId(req.params.id);
    await withServiceLock(serviceId, async (conn) => {
      const [busy] = await conn.query(
        "SELECT id FROM tickets WHERE service_id = ? AND status IN (?) LIMIT 1", [serviceId, ACTIVE]);
      if (busy.length > 0) throw fail(409, "Cannot delete: people are still in this queue");
      // Soft delete: the row stays so ticket history keeps working
      await conn.query("UPDATE services SET is_active = 0 WHERE id = ?", [serviceId]);
    });
    io.emit("services-changed");
    res.json({ message: "Service deleted" });
  });

  // ---------------------------------------------------------------
  // 3. STUDENT TICKETS  (student only)
  // ---------------------------------------------------------------
  // Join a queue
  router.post("/tickets", requireLogin, requireRole("student"), async (req, res) => {
    const serviceId = toId((req.body || {}).serviceId);
    const userId = req.user.id;

    await withServiceLock(serviceId, async (conn) => {
      // Lock this user's row too, so double-clicking Join (or two tabs) cannot slip through
      await conn.query("SELECT id FROM users WHERE id = ? FOR UPDATE", [userId]);

      const [mine] = await conn.query(
        "SELECT id FROM tickets WHERE user_id = ? AND status IN (?) LIMIT 1", [userId, ACTIVE]);
      if (mine.length > 0) throw fail(409, "You already have an active token");

      // Next token number = highest number used today for this service + 1
      const [max] = await conn.query(
        "SELECT COALESCE(MAX(token_number), 0) AS last FROM tickets WHERE service_id = ? AND queue_date = CURDATE()",
        [serviceId]);
      await conn.query(
        "INSERT INTO tickets (user_id, service_id, queue_date, token_number) VALUES (?, ?, CURDATE(), ?)",
        [userId, serviceId, max[0].last + 1]);
    });

    await notifyQueueChanged(serviceId, userId);
    res.status(201).json({ message: "Joined the queue" });
  });

  // My current ticket + live queue numbers
  router.get("/tickets/my-active", requireLogin, requireRole("student"), async (req, res) => {
    const [rows] = await db.query(
      `SELECT t.id, t.service_id, t.token_number, t.status, t.created_at,
              s.name AS service_name, s.prefix, s.counter_no
       FROM tickets t JOIN services s ON s.id = t.service_id
       WHERE t.user_id = ? AND t.status IN (?)
       ORDER BY t.id DESC LIMIT 1`, [req.user.id, ACTIVE]);

    // No active ticket: just show the last one (if any)
    if (rows.length === 0) {
      const [last] = await db.query(
        `SELECT t.token_number, t.status, s.name AS service_name, s.prefix
         FROM tickets t JOIN services s ON s.id = t.service_id
         WHERE t.user_id = ? ORDER BY t.id DESC LIMIT 1`, [req.user.id]);
      const lastTicket = last.length === 0 ? null : {
        label: makeLabel(last[0].prefix, last[0].token_number),
        serviceName: last[0].service_name,
        status: last[0].status
      };
      return res.json({ ticket: null, lastTicket: lastTicket });
    }

    const t = rows[0];
    // Who is being served right now in my service?
    const [serving] = await db.query(
      `SELECT token_number FROM tickets
       WHERE service_id = ? AND queue_date = CURDATE() AND status = 'CALLED' LIMIT 1`, [t.service_id]);
    // How many WAITING people have a smaller number than mine?
    let peopleAhead = 0;
    if (t.status === "WAITING") {
      const [ahead] = await db.query(
        `SELECT COUNT(*) AS n FROM tickets
         WHERE service_id = ? AND queue_date = CURDATE() AND status = 'WAITING' AND token_number < ?`,
        [t.service_id, t.token_number]);
      peopleAhead = ahead[0].n;
    }

    res.json({
      ticket: {
        id: t.id,
        label: makeLabel(t.prefix, t.token_number),
        serviceName: t.service_name,
        counterNo: t.counter_no,
        status: t.status
      },
      nowServing: serving.length === 0 ? null : makeLabel(t.prefix, serving[0].token_number),
      peopleAhead: peopleAhead,
      estimatedWait: peopleAhead * WAIT_PER_PERSON
    });
  });

  // Cancel (leave) my ticket. WAITING and SKIPPED tickets can be cancelled.
  router.post("/tickets/:id/cancel", requireLogin, requireRole("student"), async (req, res) => {
    await moveTicket(toId(req.params.id), {
      onlyUserId: req.user.id,
      from: ["WAITING", "SKIPPED"],
      to: "CANCELLED",
      timeColumn: "cancelled_at"
    });
    res.json({ message: "Ticket cancelled" });
  });

  // My history - only MY tickets (the WHERE user_id = ? is what keeps it private)
  router.get("/tickets/history", requireLogin, requireRole("student"), async (req, res) => {
    const [rows] = await db.query(
      `SELECT t.token_number, t.status, t.created_at, s.name AS service_name, s.prefix
       FROM tickets t JOIN services s ON s.id = t.service_id
       WHERE t.user_id = ? ORDER BY t.id DESC`, [req.user.id]);
    res.json(rows.map(t => ({
      label: makeLabel(t.prefix, t.token_number),
      serviceName: t.service_name,
      createdAt: t.created_at,
      status: t.status
    })));
  });

  // ---------------------------------------------------------------
  // 4. ADMIN QUEUE OPERATIONS  (admin only)
  // ---------------------------------------------------------------
  // View today's queue and counts for one service
  router.get("/admin/queue/:serviceId", requireLogin, requireRole("admin"), async (req, res) => {
    const serviceId = toId(req.params.serviceId);

    const [tickets] = await db.query(
      `SELECT t.id, t.token_number, t.status, u.name AS student_name, s.prefix
       FROM tickets t
       JOIN users u ON u.id = t.user_id
       JOIN services s ON s.id = t.service_id
       WHERE t.service_id = ? AND t.queue_date = CURDATE() AND t.status IN (?)
       ORDER BY t.token_number`, [serviceId, ACTIVE]);

    const [counts] = await db.query(
      "SELECT status, COUNT(*) AS n FROM tickets WHERE service_id = ? AND queue_date = CURDATE() GROUP BY status",
      [serviceId]);
    const stats = { waiting: 0, completed: 0, skipped: 0 };
    counts.forEach(c => {
      if (c.status === "WAITING") stats.waiting = c.n;
      if (c.status === "COMPLETED") stats.completed = c.n;
      if (c.status === "SKIPPED") stats.skipped = c.n;
    });

    const list = tickets.map(t => ({
      id: t.id,
      label: makeLabel(t.prefix, t.token_number),
      studentName: t.student_name,
      status: t.status
    }));
    const serving = list.find(t => t.status === "CALLED");
    res.json({ nowServing: serving ? serving.label : null, stats: stats, tickets: list });
  });

  // Call the next waiting token (smallest number first)
  router.post("/admin/services/:serviceId/call-next", requireLogin, requireRole("admin"), async (req, res) => {
    const serviceId = toId(req.params.serviceId);
    let calledUserId = null;

    await withServiceLock(serviceId, async (conn) => {
      const [called] = await conn.query(
        "SELECT id FROM tickets WHERE service_id = ? AND queue_date = CURDATE() AND status = 'CALLED'", [serviceId]);
      if (called.length > 0) throw fail(409, "Mark the current token as completed or skip it first");

      const [next] = await conn.query(
        `SELECT id, user_id FROM tickets
         WHERE service_id = ? AND queue_date = CURDATE() AND status = 'WAITING'
         ORDER BY token_number LIMIT 1 FOR UPDATE`, [serviceId]);
      if (next.length === 0) throw fail(404, "No one is waiting");

      await conn.query("UPDATE tickets SET status = 'CALLED', called_at = NOW() WHERE id = ?", [next[0].id]);
      calledUserId = next[0].user_id;
    });

    await notifyQueueChanged(serviceId, calledUserId);
    res.json({ message: "Next token called" });
  });

  // Mark the called token as completed
  router.post("/admin/tickets/:id/complete", requireLogin, requireRole("admin"), async (req, res) => {
    await moveTicket(toId(req.params.id), { from: ["CALLED"], to: "COMPLETED", timeColumn: "completed_at" });
    res.json({ message: "Token completed" });
  });

  // Skip the called token
  router.post("/admin/tickets/:id/skip", requireLogin, requireRole("admin"), async (req, res) => {
    await moveTicket(toId(req.params.id), { from: ["CALLED"], to: "SKIPPED", timeColumn: null });
    res.json({ message: "Token skipped" });
  });

  // Recall a skipped token (only when nobody else is being served)
  router.post("/admin/tickets/:id/recall", requireLogin, requireRole("admin"), async (req, res) => {
    await moveTicket(toId(req.params.id), { from: ["SKIPPED"], to: "CALLED", timeColumn: "called_at", mustBeFree: true });
    res.json({ message: "Token recalled" });
  });

  return router;
};
