// auth.js - everything about passwords, JWT login tokens and "who is allowed in".
const jwt = require("jsonwebtoken");

// Make an error that carries an HTTP status code (400, 401, 403, 404, 409 ...).
// The error handler in server.js turns it into a JSON reply.
function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// After a successful login we give the browser a JWT. It contains the user's id and role,
// signed with our secret, so nobody can change it without us noticing.
function makeToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: "8h" }
  );
}

// Returns the data inside a token, or throws if it is fake / expired.
function readToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

// Middleware: runs BEFORE a route. Only lets logged-in users through.
// The browser sends:  Authorization: Bearer <token>
function requireLogin(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  try {
    req.user = readToken(token);   // now routes can use req.user.id and req.user.role
    next();
  } catch (e) {
    next(fail(401, "Please login first"));
  }
}

// Middleware factory: requireRole("admin") only lets admins through.
// The role comes from the signed token, NOT from anything the browser can fake.
function requireRole(role) {
  return function (req, res, next) {
    if (req.user.role !== role) {
      return next(fail(403, "You are not allowed to do this"));
    }
    next();
  };
}

module.exports = { fail, makeToken, readToken, requireLogin, requireRole };
