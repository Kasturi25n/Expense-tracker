import jwt from 'jsonwebtoken';

export function createAuthMiddleware(jwtSecret) {
  return function requireAuth(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }
    const token = header.slice('Bearer '.length);
    try {
      const payload = jwt.verify(token, jwtSecret);
      req.userId = payload.userId;
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}
