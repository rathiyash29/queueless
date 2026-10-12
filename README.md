# QueueLess – Virtual Queue Management System

Web Technologies mini-project. Students join a queue online, get a digital token and watch their turn live. Admins call, skip, recall and complete tokens.

**Stack:** HTML/CSS/vanilla JavaScript · Node.js + Express · MySQL · Socket.IO · JWT · bcryptjs

---

## 1. What was already there, and what changed

Your teammate's frontend (index, login, student, admin, history pages + `style.css` + `script.js`) was clean and already well structured. It used `localStorage` as a fake database.

| Part | Before | Now |
|---|---|---|
| Users, services, tickets | `localStorage` | MySQL tables |
| Passwords | Plain text in the browser | bcrypt hash in MySQL |
| Admin password | Hard-coded `admin123`, shown on login page | Created by `seed.js` from your `.env`; hint removed from `login.html` |
| Role check | Browser compared `user.role` (anyone could edit it) | Server checks the signed JWT on every request |
| Live updates | `setInterval` + `storage` event | Socket.IO |
| Token numbers | `count + 1` in the browser | Backend, per service per day, protected against clashes |
| Names shown on pages | Inserted as raw HTML | Escaped with `escapeHtml()` (stops script injection) |

**Kept as it was:** all HTML pages (only a few `onclick` names and one `<script>` line changed), `style.css`, the look and flow, and the function structure of `script.js`.

**Moved:** the frontend files now live in `public/`. Express serves only that folder, so nobody can download `server/.env` through the browser.

## 2. Project structure

```
QueueLess/
  public/                 <- the frontend (what the browser loads)
    index.html            Home page, lists services
    login.html            Login + Register
    student.html          Student dashboard (join queue, see token)
    admin.html            Admin dashboard (call/skip/recall/complete, manage services)
    history.html          Student's previous tickets
    style.css             All styling
    script.js             All frontend logic: fetch() calls + Socket.IO
  server/
    server.js             Starts Express + Socket.IO, serves public/, handles errors
    db.js                 Creates the shared MySQL connection pool
    auth.js               JWT creation/checking, "must be logged in", "must be admin"
    routes.js             Every API URL + the queue logic (the heart of the project)
    schema.sql            Creates the 3 tables
    seed.js               Creates the first admin + 3 starting services
    .env.example          Template for your private settings
  tests/
    api-test.js           70 automatic checks (REST, Socket.IO, MySQL, security, concurrency)
  package.json            Dependencies and npm scripts
  .gitignore              Keeps node_modules and .env out of GitHub
  README.md               This file
```

## 3. Setup on Windows + VS Code

### Prerequisites
1. **Node.js 18 or newer** (LTS from nodejs.org). Check: `node -v`
2. **MySQL Server 8** (MySQL Installer from mysql.com). Remember the `root` password you choose during install.
3. VS Code.

### Step 1 – Open the project
VS Code → File → Open Folder → choose `QueueLess`. Open a terminal: Terminal → New Terminal.

### Step 2 – Install packages
```
npm install
```

### Step 3 – Create your `.env`
Copy `server\.env.example` to `server\.env` (in the VS Code explorer: right-click → Copy, Paste, rename to `.env`). Then fill in **your own** values:

| Setting | Meaning |
|---|---|
| `DB_USER`, `DB_PASSWORD` | Your MySQL login (for example the `root` user and the password you set) |
| `DB_NAME` | Keep `queueless` |
| `JWT_SECRET` | Any long random text (20+ characters) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | The admin login you want (password at least 8 characters) |

### Step 4 – Create the database and tables
```
mysql -u root -p -e "CREATE DATABASE queueless"
mysql -u root -p queueless -e "source server/schema.sql"
```
Type your MySQL password when asked. (If `mysql` is "not recognized", either use the **MySQL 8.0 Command Line Client** from the Start menu and run `CREATE DATABASE queueless; USE queueless; source C:/full/path/to/QueueLess/server/schema.sql;` – or add `C:\Program Files\MySQL\MySQL Server 8.0\bin` to your PATH and reopen the terminal. In MySQL Workbench you can also paste the contents of `schema.sql` into a query tab after creating the database.)

### Step 5 – Create the first admin and starting services
```
npm run seed
```
It prints `Admin created: ...`. It can be run again safely.

### Step 6 – Start the server
```
npm start
```
You should see `QueueLess running at http://localhost:3000`.

### Step 7 – Open the website
Open **http://localhost:3000** in the browser. 
Do **not** double-click the HTML files (`file://...`): the pages must come from the server so that `fetch()` and Socket.IO work.

| What | URL |
|---|---|
| Home | http://localhost:3000 |
| Login / Register | http://localhost:3000/login.html |
| API example | http://localhost:3000/api/services |

### Admin login
Use the `ADMIN_EMAIL` and `ADMIN_PASSWORD` you wrote in `server\.env`. Students register themselves on the login page (they can never become admins this way).

### Trying the live updates
Open the admin in a normal window and the student in a **private/incognito window** (they must not share the same login). Join a queue as the student, then press **Call Next Token** as the admin and watch the student screen change by itself.

## 4. Troubleshooting

| Problem | Cause / fix |
|---|---|
| `ER_ACCESS_DENIED_ERROR` | `DB_USER` / `DB_PASSWORD` in `server\.env` are wrong. |
| `ER_BAD_DB_ERROR: Unknown database` | Step 4 not done. |
| `ER_NO_SUCH_TABLE` | `schema.sql` was not loaded into the `queueless` database. |
| `ECONNREFUSED 127.0.0.1:3306` | MySQL is not running. Windows: open *Services* → start *MySQL80*. |
| `JWT_SECRET is missing` | `server\.env` does not exist (it must be named `.env`, not `.env.txt` or `.env.example`). |
| `EADDRINUSE: port 3000` | Something else uses port 3000. Change `PORT` in `.env` and use that port in the URL. |
| Admin login says "Wrong email or password" | Run `npm run seed` after setting `ADMIN_EMAIL`/`ADMIN_PASSWORD`. Changing `.env` later does not change an admin that already exists. |
| Page shows no services / buttons do nothing | You opened the file directly. Use http://localhost:3000. Check the browser console (F12). |
| Student page keeps redirecting to login | Your login expired (8 hours) or the server restarted with a different `JWT_SECRET`. Log in again. |
| `mysql` not recognized | See Step 4 note. |

## 5. How everything works together

```
 Browser (HTML + script.js)
     |  fetch("/api/...") with  Authorization: Bearer <JWT>
     v
 Express (server.js) -> auth.js checks the JWT -> routes.js runs the logic
     |  SQL with ? placeholders
     v
 MySQL (users, services, tickets)

 After a change is saved in MySQL, routes.js tells Socket.IO:
 "something changed in service 2".  Socket.IO pings the right browsers,
 and script.js asks the API for the fresh data.
```

* **HTML** is the page skeleton, **CSS** the looks.
* **script.js** reads what the user does, calls the API with `fetch()`, and redraws parts of the page with the answer.
* **Express** receives the HTTP request, runs the middleware (`requireLogin`, `requireRole`), and runs the route.
* **MySQL** is the single source of truth. Nothing important is stored in the browser.
* **Socket.IO** keeps an open connection from each logged-in browser to the server so the server can push "refresh now" messages without the browser asking.

### Database tables
* `users` – id, name, email (unique), password_hash, role (`student`/`admin`), created_at
* `services` – id, name, prefix (letter for token labels), counter_no, icon, is_active
* `tickets` – id, user_id → users, service_id → services, queue_date, token_number, status, created_at, called_at, completed_at, cancelled_at

Status values: `WAITING → CALLED → COMPLETED`, and `CALLED → SKIPPED → CALLED (recall)`, `WAITING/SKIPPED → CANCELLED`.

### The API
| Method + URL | Who | What |
|---|---|---|
| POST `/api/register` | anyone | create a student |
| POST `/api/login` | anyone | returns a JWT |
| GET `/api/me` | logged in | checks the JWT, returns name and role |
| GET `/api/services` | anyone | list services |
| POST `/api/services` | admin | add a service |
| DELETE `/api/services/:id` | admin | delete a service (only if nobody is waiting) |
| POST `/api/tickets` | student | join a queue |
| GET `/api/tickets/my-active` | student | my ticket, now serving, people ahead, wait time |
| POST `/api/tickets/:id/cancel` | student (own ticket) | leave the queue |
| GET `/api/tickets/history` | student | my past tickets |
| GET `/api/admin/queue/:serviceId` | admin | today's queue + counts |
| POST `/api/admin/services/:serviceId/call-next` | admin | call next waiting token |
| POST `/api/admin/tickets/:id/complete` / `skip` / `recall` | admin | change a ticket |

### Important functions

**Backend – `routes.js`**
* `withServiceLock(serviceId, work)` – starts a transaction and locks that service's row (`SELECT ... FOR UPDATE`). Anyone else changing the *same* service waits their turn. This is why two admins can never call the same token and two students can never get the same number.
* `moveTicket(ticketId, options)` – one function used by complete, skip, recall and cancel. It checks the ticket exists (and belongs to the student, if needed), then does `UPDATE ... WHERE id=? AND status IN (allowed statuses)`. If the status was wrong, 0 rows change and we answer `409`. This is how invalid status changes are prevented.
* `notifyQueueChanged(serviceId, userId)` – called only after the database change succeeded. Sends `queue-changed` to the `admins` room and `ticket-changed` to each student still in that queue (plus the student whose ticket just changed).
* `expireOldTickets()` – queues are daily; unfinished tickets from earlier days are closed as CANCELLED.
* Routes: `/tickets` (join), `/tickets/my-active` (people ahead = count of WAITING tickets with a smaller number, wait = people ahead × 4 minutes), `/admin/services/:id/call-next`.

**Backend – `auth.js`**: `makeToken` (sign a JWT), `requireLogin` (reads `Authorization: Bearer`, verifies, puts the user in `req.user`), `requireRole("admin")`, `fail(status, message)` (creates an error with an HTTP status).

**Frontend – `script.js`**
`api()` (one helper that wraps `fetch`, adds the JWT, throws on errors), `registerUser()`, `loginUser()`, `loadServices()`, `joinQueue()`, `loadMyTicket()`, `cancelTicket()`, `loadAdminQueue()`, `callNextToken()`, `completeToken()`, `skipToken()`, `recallToken()`, `addService()`, `deleteService()`, `connectSocket()`, `checkLogin()` (asks the server who you are), `escapeHtml()`.

### What happens when a student joins a queue
1. Student selects "Canteen" and clicks **Join Queue** → `joinQueue()` in `script.js`.
2. `api("/api/tickets", "POST", {serviceId})` sends `fetch` with the JWT.
3. Express runs `requireLogin` (valid JWT?) and `requireRole("student")`.
4. The route calls `withServiceLock`: transaction starts, the Canteen row is locked.
5. It locks the student's own row, then checks the student has no WAITING/CALLED/SKIPPED ticket (else `409`).
6. It finds the highest token number used today for Canteen and inserts a new row with `number + 1`, status `WAITING`.
7. Transaction commits. The unique key `(service_id, queue_date, token_number)` is a second safety net.
8. `notifyQueueChanged` emits `queue-changed` to admins and `ticket-changed` to the student's room.
9. The route answers `201`. `joinQueue()` calls `loadMyTicket()`, which GETs `/api/tickets/my-active` and draws "B-001, people ahead: 0".
10. The admin's page receives `queue-changed` and calls `loadAdminQueue()`, so the new row appears without a refresh.

### What happens when the admin clicks Call Next Token
1. `callNextToken()` → POST `/api/admin/services/:id/call-next` with the admin's JWT.
2. `requireRole("admin")` rejects non-admins with `403`.
3. `withServiceLock` locks the service row (a second simultaneous call waits here).
4. If a ticket is already `CALLED` → `409`. Otherwise it selects the WAITING ticket with the smallest number; none → `404 "No one is waiting"`.
5. It sets that ticket to `CALLED` and fills `called_at`. Commit.
6. `notifyQueueChanged` emits `queue-changed` (admins) and `ticket-changed` (every student in that queue).
7. Each student's browser runs `loadMyTicket()`. The called student gets status `CALLED` → the green **YOUR TURN** box and a tab title with 🔔. The others see new "now serving" and "people ahead" values.

### Design choices (good to mention to your professor)
* **Socket.IO only sends a signal**, not the data. The browser then asks the normal authenticated API. So no queue data is ever pushed to someone who is not allowed to see it.
* **Socket authentication:** the JWT is sent when connecting; a missing or fake token is refused. Each user is in a private room (`user:<id>`); admins also join `admins`. Students never receive admin events.
* **One active ticket per student** (across all services). This matches your teammate's original behaviour and is stricter than "one per queue".
* **Cancel** is allowed for WAITING and SKIPPED tickets. A ticket being served (CALLED) must be completed or skipped by the admin.
* **Deleting a service** hides it (`is_active = 0`) instead of erasing the row, so students' history keeps working. It is refused while people are still in that queue.
* **SQL safety:** every query uses `?` placeholders (parameterized), so user text is never glued into SQL.
* **Passwords:** only bcrypt hashes are stored. Login gives the same error for a wrong email and a wrong password.

## 6. Tests

`tests/api-test.js` checks the backend with real HTTP, real WebSocket connections and real MySQL queries (registration, login, password hashing, join, duplicates, call/skip/recall/complete/cancel, invalid transitions, empty queue, history, role and ownership protection, forged tokens, Socket.IO delivery and isolation, and simultaneous requests).

It **creates test users and tickets**, so run it on a separate scratch database, not on your demo data:

```
mysql -u root -p -e "CREATE DATABASE queueless_test"
mysql -u root -p queueless_test -e "source server/schema.sql"
```
Windows `cmd`:
```
set DB_NAME=queueless_test
set PORT=3100
set BASE_URL=http://localhost:3100
npm run seed
npm start
```
Then in a **second** terminal (set the same three variables there as well) run `npm test`. (PowerShell syntax: `$env:DB_NAME="queueless_test"`.)

## 7. Known limitations (honest list)
* No rate limiting on login (a real deployment should add it).
* The JWT is kept in the browser's `localStorage` (needed to stay logged in); HTML escaping reduces the risk of it being stolen.
* The socket checks the JWT when it connects; a token that expires later is only noticed at the next API call or reconnect.
* Estimated wait is a fixed 4 minutes per person (`WAIT_PER_PERSON` in `routes.js`).
* Passwords cannot be reset, and there is no email verification.
* Run over HTTPS if you ever deploy it.

## 8. Viva questions and answers

**Q1. What is the architecture of your project?** 
A three-layer web app. The frontend (HTML/CSS/JS) runs in the browser, the backend (Node.js + Express) holds the logic and the REST API, and MySQL stores all data. Socket.IO adds real-time push from the server to browsers.

**Q2. What is a REST API?** 
A set of URLs where the HTTP method says the action (GET read, POST create, DELETE remove) and data is exchanged as JSON. Example: `POST /api/tickets` joins a queue.

**Q3. What does `fetch()` do?** 
It sends an HTTP request from JavaScript and returns a Promise. We wrap it in `api()` so every request carries the JWT and errors are handled in one place.

**Q4. What is `async/await`?** 
A readable way to wait for Promises. `await api(...)` pauses that function until the server replies, without freezing the page.

**Q5. What is JWT and how do you use it?** 
A JSON Web Token is a signed text containing the user's id and role. After login the server gives it to the browser, and the browser sends it with each request. The server verifies the signature with `JWT_SECRET`, so a changed token is rejected.

**Q6. Why can't a student become admin by editing `localStorage`?** 
The role that counts is inside the signed JWT and checked on the server by `requireRole`. Editing browser data doesn't change the signature, and a forged token is rejected (tested: 401/403).

**Q7. Why bcrypt? What is hashing?** 
Hashing is one-way: you can't get the password back from the hash. bcrypt adds a random salt and is deliberately slow, which makes guessing attacks expensive. Even we (and anyone who steals the database) can't read passwords.

**Q8. What is SQL injection and how did you prevent it?** 
Attacker text that becomes part of the SQL command. We use parameterized queries (`WHERE email = ?` with values in an array), so input is always treated as data, never as SQL. We tested an input like `' OR '1'='1`.

**Q9. What is XSS and how did you prevent it?** 
Injecting HTML/JS (for example in a name) that runs in another user's browser. `escapeHtml()` converts `<` and `>` to harmless text before we build HTML.

**Q10. What is middleware in Express?** 
A function that runs before the route handler and can stop or continue the request. `requireLogin` and `requireRole("admin")` are middleware.

**Q11. What is a database transaction, and why do you use one?** 
A group of SQL steps that either all succeed (`commit`) or all are undone (`rollback`). Joining needs "check, find number, insert" to behave as one unit.

**Q12. How do you stop two admins from calling the same token?** 
`SELECT ... FOR UPDATE` on the service row inside a transaction. The second request waits until the first finishes, then sees a token is already CALLED and gets a 409. We tested 5 simultaneous requests: exactly one succeeded. (We also removed the lock once to confirm the test then fails.)

**Q13. How are token numbers generated?** 
Highest number for that service on today's date plus one, inside the locked transaction. A UNIQUE key `(service_id, queue_date, token_number)` is a second safety net. Numbers restart each day.

**Q14. How is "people ahead" calculated?** 
Count of tickets with status WAITING in the same service and day whose token number is smaller than mine. Waiting time = people ahead × 4 minutes.

**Q15. What is Socket.IO and why not `setInterval`?** 
A library for a persistent two-way connection (WebSocket, with fallbacks). The server pushes an event the moment data changes, so updates are instant and there's no constant polling.

**Q16. How are socket connections secured?** 
`io.use()` verifies the JWT during the handshake and refuses the connection otherwise. Rooms limit who gets which event. Events carry no private data; the browser fetches data through the authenticated API.

**Q17. When do you send socket events?** 
Only after the database transaction has committed, so browsers never hear about a change that didn't happen.

**Q18. What is a foreign key?** 
A column that points to a row in another table (`tickets.user_id → users.id`). MySQL then refuses tickets for users or services that don't exist.

**Q19. Why store `queue_date` and use `CURDATE()`?** 
So each day is a fresh queue with numbers starting at 1, and old unfinished tickets are closed instead of clogging today's queue.

**Q20. Why is a deleted service only hidden?** 
Tickets in history point to the service. Removing the row would break history (and the foreign key). `is_active = 0` hides it while keeping the records.

**Q21. What does CORS mean, and why isn't it needed here?** 
Browsers block requests between different origins unless the server allows it. Express serves the pages and the API from the same origin (`localhost:3000`), so no CORS setup is needed.

**Q22. What are HTTP status codes you used?** 
200 OK, 201 Created, 400 bad input, 401 not logged in, 403 not allowed, 404 not found, 409 conflict (duplicate/invalid status change), 500 server error.

**Q23. What is `.env` and why isn't it on GitHub?** 
A file with secrets (DB password, JWT secret) read by `dotenv` into `process.env`. It's listed in `.gitignore`; `.env.example` shows the format with placeholders.

**Q24. Why a connection pool?** 
Opening a MySQL connection for every request is slow. A pool keeps several open and reuses them.

**Q25. Explain the lifecycle of a ticket.** 
`WAITING` → admin calls → `CALLED` → completed (`COMPLETED`) or skipped (`SKIPPED`). Skipped can be recalled to `CALLED`. A student can cancel while `WAITING` or `SKIPPED` (`CANCELLED`). Completed and cancelled tickets stay in the table for history.
