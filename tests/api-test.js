// tests/api-test.js - automatic checks of the backend (REST + Socket.IO + MySQL).
// Run the server first, then:  npm test
//
// WARNING: this creates test users and tickets. Run it against a SCRATCH database
// (see README "Running the tests"), not the database with your demo data.
//   BASE_URL   default http://localhost:3000
const path = require("path");
const jwt = require("jsonwebtoken");
const { io } = require("socket.io-client");
const db = require("../server/db");   // also loads server/.env

const BASE = process.env.BASE_URL || "http://localhost:3000";
let passed = 0, failed = 0;

function check(name, condition, detail) {
  if (condition) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail) : "")); }
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function call(method, url, token, body) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = "Bearer " + token;
  const res = await fetch(BASE + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

// register + login a new student, returns { token, id, email }
async function newStudent(label) {
  const email = label + "_" + Date.now() + "_" + Math.floor(Math.random() * 1e6) + "@test.local";
  await call("POST", "/api/register", null, { name: label, email, password: "secret123" });
  const r = await call("POST", "/api/login", null, { email, password: "secret123" });
  return { token: r.data.token, id: r.data.user.id, email };
}

// open a socket and collect the events it receives
function openSocket(token) {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, { auth: { token }, reconnection: false });
    socket.events = [];
    socket.onAny((name, data) => socket.events.push({ name, data }));
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", (e) => reject(e));
  });
}

async function main() {
  // ---------- Setup: admin login ----------
  const adminLogin = await call("POST", "/api/login", null,
    { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  check("Admin can login (seeded admin)", adminLogin.status === 200 && adminLogin.data.user.role === "admin", adminLogin);
  const admin = adminLogin.data.token;

  // Use a brand-new service so token numbers start at 1 for this run
  await call("POST", "/api/services", admin, { name: "Test Service " + Date.now(), counter: 9 });
  const services = (await call("GET", "/api/services")).data;
  const svc = services[services.length - 1];
  const svc2 = services[0];

  console.log("\n[1] Registration");
  const email1 = "alice_" + Date.now() + "@test.local";
  let r = await call("POST", "/api/register", null, { name: "Alice", email: email1, password: "secret123" });
  check("Register new student -> 201", r.status === 201, r);
  r = await call("POST", "/api/register", null, { name: "Alice", email: email1, password: "secret123" });
  check("Duplicate email -> 409", r.status === 409, r);
  r = await call("POST", "/api/register", null, { name: "", email: "x@y.com", password: "secret123" });
  check("Empty name -> 400", r.status === 400, r);
  r = await call("POST", "/api/register", null, { name: "B", email: "bad-email", password: "secret123" });
  check("Bad email -> 400", r.status === 400, r);
  r = await call("POST", "/api/register", null, { name: "B", email: "b@c.com", password: "123" });
  check("Short password -> 400", r.status === 400, r);
  r = await call("POST", "/api/register", null, { name: "Hacker", email: "h_" + Date.now() + "@t.com", password: "secret123", role: "admin" });
  const [hackerRow] = await db.query("SELECT role FROM users WHERE name = 'Hacker' ORDER BY id DESC LIMIT 1");
  check("Cannot register as admin by sending role=admin", hackerRow[0].role === "student", hackerRow);

  console.log("\n[2/3] Login, password storage");
  r = await call("POST", "/api/login", null, { email: email1, password: "wrong" });
  check("Wrong password -> 401", r.status === 401, r);
  r = await call("POST", "/api/login", null, { email: "' OR '1'='1", password: "x" });
  check("SQL-injection style email -> 401 (not 500)", r.status === 401, r);
  r = await call("POST", "/api/login", null, { email: email1, password: "secret123" });
  check("Login -> 200 + token", r.status === 200 && !!r.data.token, r);
  const alice = { token: r.data.token, id: r.data.user.id };
  const [urow] = await db.query("SELECT password_hash FROM users WHERE id = ?", [alice.id]);
  check("Password is stored as a bcrypt hash, not plaintext",
    urow[0].password_hash.startsWith("$2") && !urow[0].password_hash.includes("secret123"));

  console.log("\n[5] Real-time (Socket.IO)");
  let refused = false;
  try { await openSocket("not-a-real-token"); } catch (e) { refused = true; }
  check("Socket with fake token is refused", refused);
  const forged = jwt.sign({ id: 999, role: "admin" }, "some_other_secret");
  refused = false;
  try { await openSocket(forged); } catch (e) { refused = true; }
  check("Socket with forged admin token is refused", refused);

  const adminSock = await openSocket(admin);
  const aliceSock = await openSocket(alice.token);
  const bob = await newStudent("Bob");
  const carol = await newStudent("Carol");
  const carolSock = await openSocket(carol.token);   // Carol will be in a DIFFERENT service

  // ---------- Join ----------
  console.log("\n[2/3] Join queue");
  r = await call("POST", "/api/tickets", alice.token, { serviceId: svc.id });
  check("Alice joins -> 201", r.status === 201, r);
  const [t1] = await db.query("SELECT * FROM tickets WHERE user_id = ?", [alice.id]);
  check("Ticket is stored in MySQL (token 1, WAITING)", t1.length === 1 && t1[0].token_number === 1 && t1[0].status === "WAITING", t1);
  await wait(300);
  check("Admin socket got 'queue-changed' for this service (no refresh)",
    adminSock.events.some(e => e.name === "queue-changed" && e.data.serviceId === svc.id), adminSock.events);
  check("Alice's socket got 'ticket-changed'", aliceSock.events.some(e => e.name === "ticket-changed"));

  r = await call("POST", "/api/tickets", alice.token, { serviceId: svc.id });
  check("Second ticket in same queue -> 409", r.status === 409, r);
  r = await call("POST", "/api/tickets", alice.token, { serviceId: svc2.id });
  check("Ticket in another queue while active -> 409", r.status === 409, r);
  r = await call("POST", "/api/tickets", bob.token, { serviceId: 999999 });
  check("Unknown service -> 404", r.status === 404, r);
  r = await call("POST", "/api/tickets", bob.token, { serviceId: "abc" });
  check("Invalid service id -> 400", r.status === 400, r);

  r = await call("POST", "/api/tickets", bob.token, { serviceId: svc.id });
  check("Bob joins -> 201", r.status === 201);
  r = await call("GET", "/api/tickets/my-active", bob.token);
  check("Bob: token 2, 1 person ahead, ~4 min", r.data.ticket.label.endsWith("-002") && r.data.peopleAhead === 1 && r.data.estimatedWait === 4, r.data);

  console.log("\n[5] Call next, live update");
  carolSock.events.length = 0;
  aliceSock.events.length = 0;
  r = await call("POST", "/api/admin/services/" + svc.id + "/call-next", admin);
  check("Call next -> 200", r.status === 200, r);
  await wait(300);
  check("Alice's socket got 'ticket-changed' after call", aliceSock.events.some(e => e.name === "ticket-changed"));
  r = await call("GET", "/api/tickets/my-active", alice.token);
  check("Alice now sees status CALLED (YOUR TURN)", r.data.ticket.status === "CALLED", r.data);
  r = await call("GET", "/api/tickets/my-active", bob.token);
  check("Bob sees now serving = token 1, 0 ahead", r.data.nowServing.endsWith("-001") && r.data.peopleAhead === 0, r.data);
  check("Carol (other queue) got no events", carolSock.events.length === 0, carolSock.events);
  check("Students never receive admin events", !aliceSock.events.some(e => e.name === "queue-changed"));

  console.log("\n[7] Status rules");
  r = await call("POST", "/api/admin/services/" + svc.id + "/call-next", admin);
  check("Call next while one is CALLED -> 409", r.status === 409, r);
  const [bobT] = await db.query("SELECT id FROM tickets WHERE user_id = ?", [bob.id]);
  r = await call("POST", "/api/admin/tickets/" + bobT[0].id + "/complete", admin);
  check("Complete a WAITING ticket -> 409", r.status === 409, r);
  r = await call("POST", "/api/tickets/" + t1[0].id + "/cancel", alice.token);
  check("Cancel a CALLED ticket -> 409", r.status === 409, r);

  r = await call("POST", "/api/admin/tickets/" + t1[0].id + "/skip", admin);
  check("Skip called ticket -> 200", r.status === 200, r);
  r = await call("POST", "/api/admin/services/" + svc.id + "/call-next", admin);
  check("Call next after skip -> Bob called", r.status === 200);
  r = await call("POST", "/api/admin/tickets/" + t1[0].id + "/recall", admin);
  check("Recall while Bob is CALLED -> 409", r.status === 409, r);
  r = await call("POST", "/api/admin/tickets/" + bobT[0].id + "/complete", admin);
  check("Complete Bob -> 200", r.status === 200, r);
  r = await call("POST", "/api/admin/tickets/" + bobT[0].id + "/complete", admin);
  check("Complete Bob again -> 409", r.status === 409, r);
  r = await call("POST", "/api/admin/tickets/" + t1[0].id + "/recall", admin);
  check("Recall Alice (skipped) -> 200", r.status === 200, r);
  r = await call("GET", "/api/tickets/my-active", alice.token);
  check("Alice is CALLED again", r.data.ticket.status === "CALLED", r.data);
  r = await call("POST", "/api/admin/tickets/" + t1[0].id + "/skip", admin);
  r = await call("POST", "/api/tickets/" + t1[0].id + "/cancel", alice.token);
  check("Alice cancels her SKIPPED ticket -> 200", r.status === 200, r);
  r = await call("POST", "/api/tickets/" + t1[0].id + "/cancel", alice.token);
  check("Cancel again -> 409", r.status === 409, r);

  console.log("\n[1-10] Queue view, stats, history, empty queue");
  r = await call("GET", "/api/admin/queue/" + svc.id, admin);
  check("Stats: 0 waiting, 1 completed, 0 skipped; queue empty",
    r.data.stats.waiting === 0 && r.data.stats.completed === 1 && r.data.stats.skipped === 0 && r.data.tickets.length === 0, r.data);
  r = await call("POST", "/api/admin/services/" + svc.id + "/call-next", admin);
  check("Call next on EMPTY queue -> 404 with message", r.status === 404 && r.data.error === "No one is waiting", r);
  r = await call("GET", "/api/tickets/history", alice.token);
  check("Alice history keeps her cancelled ticket", r.data.length === 1 && r.data[0].status === "CANCELLED", r.data);
  r = await call("GET", "/api/tickets/history", bob.token);
  check("Bob history shows only his COMPLETED ticket", r.data.length === 1 && r.data[0].status === "COMPLETED", r.data);
  const [aliceTimes] = await db.query("SELECT called_at, cancelled_at FROM tickets WHERE id = ?", [t1[0].id]);
  check("Timestamps called_at / cancelled_at are filled", !!aliceTimes[0].called_at && !!aliceTimes[0].cancelled_at, aliceTimes);

  console.log("\n[9] Security");
  r = await call("POST", "/api/admin/services/" + svc.id + "/call-next", bob.token);
  check("Student calling admin call-next -> 403", r.status === 403, r);
  r = await call("GET", "/api/admin/queue/" + svc.id, bob.token);
  check("Student viewing admin queue -> 403", r.status === 403, r);
  r = await call("POST", "/api/services", bob.token, { name: "Evil", counter: 1 });
  check("Student adding service -> 403", r.status === 403, r);
  r = await call("DELETE", "/api/services/" + svc.id, bob.token);
  check("Student deleting service -> 403", r.status === 403, r);
  r = await call("POST", "/api/admin/tickets/" + bobT[0].id + "/skip", bob.token);
  check("Student skipping a ticket -> 403", r.status === 403, r);
  r = await call("GET", "/api/admin/queue/" + svc.id);
  check("No token at all -> 401", r.status === 401, r);
  r = await call("GET", "/api/admin/queue/" + svc.id, forged);
  check("Forged admin token -> 401", r.status === 401, r);
  r = await call("POST", "/api/tickets", admin, { serviceId: svc.id });
  check("Admin cannot join a queue -> 403", r.status === 403, r);

  await call("POST", "/api/tickets", bob.token, { serviceId: svc.id });
  const [bobNew] = await db.query("SELECT id FROM tickets WHERE user_id = ? AND status = 'WAITING'", [bob.id]);
  r = await call("POST", "/api/tickets/" + bobNew[0].id + "/cancel", carol.token);
  check("Carol cancelling Bob's ticket -> 404", r.status === 404, r);
  const [still] = await db.query("SELECT status FROM tickets WHERE id = ?", [bobNew[0].id]);
  check("Bob's ticket is untouched", still[0].status === "WAITING");
  r = await call("GET", "/api/tickets/history", carol.token);
  check("Carol's history does not contain Bob's tickets", r.data.length === 0, r.data);

  console.log("\n[10] Invalid input and edge cases");
  r = await fetch(BASE + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad json" });
  check("Broken JSON -> 400", r.status === 400);
  r = await call("POST", "/api/admin/tickets/abc/skip", admin);
  check("Non-numeric ticket id -> 400", r.status === 400, r);
  r = await call("POST", "/api/admin/tickets/99999999/skip", admin);
  check("Unknown ticket id -> 404", r.status === 404, r);
  r = await call("POST", "/api/services", admin, { name: "", counter: 1 });
  check("Add service with empty name -> 400", r.status === 400, r);
  r = await call("POST", "/api/services", admin, { name: "X", counter: -3 });
  check("Add service with bad counter -> 400", r.status === 400, r);
  r = await call("DELETE", "/api/services/" + svc.id, admin);
  check("Delete service with a waiting person -> 409", r.status === 409, r);

  console.log("\n[5] Concurrency (many requests at the same moment)");
  // Bob cancels, then 6 students join together -> numbers must be unique
  await call("POST", "/api/tickets/" + bobNew[0].id + "/cancel", bob.token);
  const crowd = [];
  for (let i = 0; i < 6; i++) crowd.push(await newStudent("Crowd" + i));
  const joins = await Promise.all(crowd.map(s => call("POST", "/api/tickets", s.token, { serviceId: svc.id })));
  check("6 simultaneous joins all succeed", joins.every(j => j.status === 201), joins.map(j => j.status));
  const [nums] = await db.query(
    "SELECT token_number FROM tickets WHERE service_id = ? AND queue_date = CURDATE() AND status = 'WAITING' ORDER BY token_number", [svc.id]);
  const numberList = nums.map(n => n.token_number);
  check("Token numbers are unique and consecutive", new Set(numberList).size === 6 && numberList[5] - numberList[0] === 5, numberList);

  const calls = await Promise.all([1, 2, 3, 4, 5].map(() => call("POST", "/api/admin/services/" + svc.id + "/call-next", admin)));
  const okCount = calls.filter(c => c.status === 200).length;
  const [calledNow] = await db.query("SELECT COUNT(*) AS n FROM tickets WHERE service_id = ? AND queue_date = CURDATE() AND status = 'CALLED'", [svc.id]);
  check("5 simultaneous Call Next -> exactly one succeeds", okCount === 1 && calledNow[0].n === 1, calls.map(c => c.status));

  const dupJoins = await Promise.all([1, 2, 3, 4].map(() => call("POST", "/api/tickets", bob.token, { serviceId: svc.id })));
  const [bobActive] = await db.query("SELECT COUNT(*) AS n FROM tickets WHERE user_id = ? AND status IN ('WAITING','CALLED','SKIPPED')", [bob.id]);
  check("4 simultaneous joins by one student -> only one ticket", bobActive[0].n === 1, dupJoins.map(j => j.status));

  console.log("\n[2] Services: delete empty service");
  // finish everyone in svc so it can be deleted
  for (let i = 0; i < 20; i++) {
    const q = (await call("GET", "/api/admin/queue/" + svc.id, admin)).data;
    if (q.tickets.length === 0) break;
    const current = q.tickets.find(t => t.status === "CALLED");
    if (current) { await call("POST", "/api/admin/tickets/" + current.id + "/complete", admin); continue; }
    const skipped = q.tickets.find(t => t.status === "SKIPPED");
    if (skipped) { await call("POST", "/api/admin/tickets/" + skipped.id + "/recall", admin); continue; }
    await call("POST", "/api/admin/services/" + svc.id + "/call-next", admin);
  }
  r = await call("DELETE", "/api/services/" + svc.id, admin);
  check("Delete empty service -> 200", r.status === 200, r);
  r = await call("GET", "/api/services");
  check("Deleted service no longer listed", !r.data.some(s => s.id === svc.id));
  r = await call("GET", "/api/tickets/history", bob.token);
  check("History still shows tickets of the deleted service", r.data.length >= 1, r.data);

  adminSock.close(); aliceSock.close(); carolSock.close();
  await db.end();
  console.log("\nResult: " + passed + " passed, " + failed + " failed");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.log("Test crashed:", err); process.exit(1); });
