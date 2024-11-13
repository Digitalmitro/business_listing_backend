// backend/middleware/authMiddleware.js
const jwt = require('jsonwebtoken');
exports.authMiddleware = (req, res, next) => {
  const token = req.header('Authorization')?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "Unauthorized" });
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: "Forbidden" });
    req.user = user;
    next();
  });
};