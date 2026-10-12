// =====================================================
// QueueLess - all frontend JavaScript
// The browser talks to the Node.js/Express backend with fetch().
// All real data (users, services, tickets) lives in MySQL.
// Live updates come from Socket.IO (no refreshing, no timers).
// =====================================================

const STATUS_TEXT = {
  WAITING: "Waiting",
  CALLED: "Your Turn",
  COMPLETED: "Completed",
  SKIPPED: "Skipped",
  CANCELLED: "Cancelled"
};

// =============== 1. COMMON HELPERS ===============

// The browser only remembers the login token (and the name, just to show "Welcome").
// The server checks the token on every request, so changing these values in the
// browser cannot give anyone extra power.
function getToken() {
  return localStorage.getItem("ql_token");
}

// Sends a request to the backend and returns the JSON answer.
// If the server replies with an error, we throw it so the caller can show the message.
async function api(url, method, body) {
  const options = { method: method || "GET", headers: {} };
  if (body) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  if (getToken()) {
    options.headers["Authorization"] = "Bearer " + getToken();
  }

  const response = await fetch(url, options);
  const data = await response.json();

  if (response.status === 401 && getToken()) {
    logout(); // token expired or invalid
  }
  if (!response.ok) {
    throw new Error(data.error || "Something went wrong");
  }
  return data;
}

// Stops HTML tags typed by users (like <script>) from running on the page
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function logout() {
  localStorage.removeItem("ql_token");
  localStorage.removeItem("ql_name");
  location.href = "index.html";
}

// Blocks a page unless the SERVER confirms the right role. Returns the user or null.
async function checkLogin(role) {
  if (!getToken()) {
    alert("Please login first");
    location.href = "login.html";
    return null;
  }
  try {
    const user = await api("/api/me");
    if (user.role !== role) throw new Error("Wrong role");
    return user;
  } catch (e) {
    alert("Please login first");
    location.href = "login.html";
    return null;
  }
}

// Connects to Socket.IO using our login token, and listens for events.
// events looks like: { "ticket-changed": function, "services-changed": function }
function connectSocket(events) {
  const socket = io({ auth: { token: getToken() } });
  for (const name in events) {
    socket.on(name, events[name]);
  }
  socket.on("connect_error", (err) => {
    if (err.message === "Please login first") logout();
  });
  return socket;
}

// Gets the list of services from the database
async function loadServices() {
  return await api("/api/services");
}

// =============== 2. HOME PAGE ===============
async function showServicesOnHome() {
  const box = document.getElementById("serviceList");
  const services = await loadServices();
  box.innerHTML = "";
  services.forEach(s => {
    box.innerHTML += `<div class="service-item">${s.icon} ${escapeHtml(s.name)} <small>(Counter ${s.counter_no})</small></div>`;
  });
}

// =============== 3. REGISTER AND LOGIN ===============
async function registerUser() {
  const name = document.getElementById("regName").value.trim();
  const email = document.getElementById("regEmail").value.trim().toLowerCase();
  const password = document.getElementById("regPassword").value;

  // Quick checks here for friendly messages (the server checks again - it never trusts the browser)
  if (name === "" || email === "" || password === "") {
    alert("Please fill all fields");
    return;
  }
  if (!email.includes("@") || !email.includes(".")) {
    alert("Enter a valid email");
    return;
  }
  if (password.length < 6) {
    alert("Password must be at least 6 characters");
    return;
  }

  try {
    const result = await api("/api/register", "POST", { name: name, email: email, password: password });
    alert(result.message);
  } catch (e) {
    alert(e.message);
  }
}

async function loginUser() {
  const email = document.getElementById("loginEmail").value.trim().toLowerCase();
  const password = document.getElementById("loginPassword").value;

  try {
    const result = await api("/api/login", "POST", { email: email, password: password });
    localStorage.setItem("ql_token", result.token);
    localStorage.setItem("ql_name", result.user.name);
    location.href = result.user.role === "admin" ? "admin.html" : "student.html";
  } catch (e) {
    alert(e.message);
  }
}

// =============== 4. STUDENT DASHBOARD ===============
let selectedServiceId = null;

async function initStudent() {
  const user = await checkLogin("student");
  if (!user) return;
  document.getElementById("welcome").innerText = "Welcome, " + user.name;

  showServiceChoices();
  loadMyTicket();

  // Live updates: the server says "your ticket/queue changed" -> we reload
  connectSocket({
    "ticket-changed": loadMyTicket,
    "services-changed": showServiceChoices
  });
}

// Shows the list of services; the chosen one is highlighted
async function showServiceChoices() {
  const box = document.getElementById("serviceList");
  const services = await loadServices();

  // Keep the selection valid (the chosen service may have been deleted)
  if (!services.some(s => s.id === selectedServiceId)) {
    selectedServiceId = services.length > 0 ? services[0].id : null;
  }

  box.innerHTML = "";
  services.forEach(s => {
    const css = (s.id === selectedServiceId) ? "service-item selected" : "service-item";
    box.innerHTML += `<div class="${css}" onclick="chooseService(${s.id})">
      ${s.icon} ${escapeHtml(s.name)} <small>(Counter ${s.counter_no})</small></div>`;
  });
}

function chooseService(id) {
  selectedServiceId = id;
  showServiceChoices();
}

async function joinQueue() {
  if (selectedServiceId === null) {
    alert("Please select a service");
    return;
  }
  try {
    await api("/api/tickets", "POST", { serviceId: selectedServiceId });
    loadMyTicket();
  } catch (e) {
    alert(e.message);
  }
}

async function cancelTicket(ticketId) {
  if (!confirm("Leave the queue?")) return;
  try {
    await api("/api/tickets/" + ticketId + "/cancel", "POST");
    loadMyTicket();
  } catch (e) {
    alert(e.message);
  }
}

// Gets my current ticket from the server and draws it
async function loadMyTicket() {
  const box = document.getElementById("tokenBox");
  let data;
  try {
    data = await api("/api/tickets/my-active");
  } catch (e) {
    box.innerHTML = "<p>Could not load your ticket: " + escapeHtml(e.message) + "</p>";
    return;
  }

  // Case 1: not in any queue
  if (!data.ticket) {
    document.title = "QueueLess - Student";
    let html = "<p>You are not in any queue. Select a service above and click Join Queue.</p>";
    if (data.lastTicket) {
      html += `<p>Last token: <b>${data.lastTicket.label}</b> (${escapeHtml(data.lastTicket.serviceName)}) - ${STATUS_TEXT[data.lastTicket.status]}</p>`;
    }
    box.innerHTML = html;
    return;
  }

  // Case 2: in a queue
  const t = data.ticket;
  let html = `<p>Your token</p>
              <div class="token-number">${t.label}</div>
              <p>Service: <b>${escapeHtml(t.serviceName)}</b> (Counter ${t.counterNo})</p>`;

  if (t.status === "CALLED") {
    document.title = "🔔 YOUR TURN - QueueLess";
    html += `<div class="your-turn">🔔 It's YOUR TURN! Please go to counter ${t.counterNo}.</div>`;
  } else if (t.status === "SKIPPED") {
    document.title = "QueueLess - Student";
    html += `<div class="warning-box">Your token was skipped. Please meet the staff at the counter or leave the queue.</div>`;
  } else {
    document.title = "QueueLess - Student";
    html += `<div class="info-box">
               <p>Status: <b>${STATUS_TEXT[t.status]}</b></p>
               <p>Now serving: <b>${data.nowServing ? data.nowServing : "-"}</b></p>
               <p>People ahead: <b>${data.peopleAhead}</b></p>
               <p>Estimated wait: <b>~${data.estimatedWait} min</b></p>
             </div>`;
  }

  // A token that is being served right now cannot be cancelled
  if (t.status !== "CALLED") {
    html += `<br><button class="red" onclick="cancelTicket(${t.id})">Leave Queue</button>`;
  }
  box.innerHTML = html;
}

// =============== 5. ADMIN DASHBOARD ===============
async function initAdmin() {
  const user = await checkLogin("admin");
  if (!user) return;

  await loadAdminServices();   // this also loads the queue

  connectSocket({
    // Reload only if the change happened in the service the admin is looking at
    "queue-changed": (data) => {
      if (data.serviceId === selectedService()) loadAdminQueue();
    },
    "services-changed": loadAdminServices
  });
}

// Fills the dropdown (keeping the old selection) and the "Manage services" table
async function loadAdminServices() {
  const services = await loadServices();

  const select = document.getElementById("serviceSelect");
  const oldValue = select.value;
  select.innerHTML = "";
  services.forEach(s => {
    select.innerHTML += `<option value="${s.id}">${s.icon} ${escapeHtml(s.name)} (Counter ${s.counter_no})</option>`;
  });
  if (oldValue) select.value = oldValue;
  if (select.selectedIndex === -1) select.selectedIndex = 0;

  const table = document.getElementById("serviceTable");
  table.innerHTML = "";
  services.forEach(s => {
    table.innerHTML += `<tr>
      <td>${s.prefix}</td>
      <td>${s.icon} ${escapeHtml(s.name)}</td>
      <td>${s.counter_no}</td>
      <td><button class="red" onclick="deleteService(${s.id})">Delete</button></td>
    </tr>`;
  });

  loadAdminQueue();
}

function selectedService() {
  return Number(document.getElementById("serviceSelect").value);
}

// Gets the queue of the selected service from the server and draws it
async function loadAdminQueue() {
  const table = document.getElementById("tokenTable");
  const sid = selectedService();

  if (!sid) {   // no service exists
    document.getElementById("statServing").innerText = "-";
    document.getElementById("statWaiting").innerText = 0;
    document.getElementById("statServed").innerText = 0;
    document.getElementById("statSkipped").innerText = 0;
    table.innerHTML = "<tr><td colspan='4'>No services. Add one below.</td></tr>";
    return;
  }

  let data;
  try {
    data = await api("/api/admin/queue/" + sid);
  } catch (e) {
    return;
  }

  // Statistics
  document.getElementById("statServing").innerText = data.nowServing ? data.nowServing : "-";
  document.getElementById("statWaiting").innerText = data.stats.waiting;
  document.getElementById("statServed").innerText = data.stats.completed;
  document.getElementById("statSkipped").innerText = data.stats.skipped;

  // Queue table (only tokens that still need attention)
  table.innerHTML = "";
  if (data.tickets.length === 0) {
    table.innerHTML = "<tr><td colspan='4'>No one in the queue.</td></tr>";
    return;
  }

  data.tickets.forEach(t => {
    let buttons = "";
    if (t.status === "CALLED") {
      buttons = `<button class="green" onclick="completeToken(${t.id})">Mark Completed</button>
                 <button class="orange" onclick="skipToken(${t.id})">Skip</button>`;
    } else if (t.status === "SKIPPED") {
      buttons = `<button onclick="recallToken(${t.id})">Recall</button>`;
    }

    table.innerHTML += `<tr>
      <td>${t.label}</td>
      <td>${escapeHtml(t.studentName)}</td>
      <td>${STATUS_TEXT[t.status]}</td>
      <td>${buttons}</td>
    </tr>`;
  });
}

// Runs an admin action, shows any error, then refreshes the table
async function adminAction(url) {
  try {
    await api(url, "POST");
  } catch (e) {
    alert(e.message);
  }
  loadAdminQueue();
}

function callNextToken() {
  adminAction("/api/admin/services/" + selectedService() + "/call-next");
}
function completeToken(id) {
  adminAction("/api/admin/tickets/" + id + "/complete");
}
function skipToken(id) {
  adminAction("/api/admin/tickets/" + id + "/skip");
}
function recallToken(id) {
  adminAction("/api/admin/tickets/" + id + "/recall");
}

// ----- Manage services -----
async function addService() {
  const name = document.getElementById("newService").value.trim();
  const counter = document.getElementById("newCounter").value;

  if (name === "" || counter === "") {
    alert("Enter service name and counter number");
    return;
  }

  try {
    await api("/api/services", "POST", { name: name, counter: Number(counter) });
    document.getElementById("newService").value = "";
    document.getElementById("newCounter").value = "";
    loadAdminServices();
  } catch (e) {
    alert(e.message);
  }
}

async function deleteService(id) {
  if (!confirm("Delete this service?")) return;
  try {
    await api("/api/services/" + id, "DELETE");
    loadAdminServices();
  } catch (e) {
    alert(e.message);
  }
}

// =============== 6. HISTORY PAGE ===============
async function initHistory() {
  const user = await checkLogin("student");
  if (!user) return;

  const table = document.getElementById("historyTable");
  const tickets = await api("/api/tickets/history");

  if (tickets.length === 0) {
    table.innerHTML = "<tr><td colspan='4'>No tokens yet. Join a queue from the dashboard.</td></tr>";
    return;
  }

  tickets.forEach(t => {
    table.innerHTML += `<tr>
      <td>${t.label}</td>
      <td>${escapeHtml(t.serviceName)}</td>
      <td>${t.createdAt}</td>
      <td>${STATUS_TEXT[t.status]}</td>
    </tr>`;
  });
}
