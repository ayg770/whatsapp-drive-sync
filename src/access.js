import crypto from 'node:crypto';

function equalSecret(a, b) {
  const digest = (value) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}
export function accessMiddleware(users) {
  return (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    if (!users) {
      if (process.env.NODE_ENV === 'production')
        return res.status(503).json({ error: 'Access control is not configured' });
      req.visitor = { name: 'local-development', admin: true };
      return next();
    }
    const header = req.get('authorization') || '';
    const decoded = header.startsWith('Basic ')
      ? Buffer.from(header.slice(6), 'base64').toString()
      : '';
    const colon = decoded.indexOf(':');
    const name = decoded.slice(0, colon);
    const password = decoded.slice(colon + 1);
    const user = users[name];
    if (
      colon < 1 ||
      !Object.hasOwn(users, name) ||
      !user ||
      !equalSecret(password, user.password)
    ) {
      res.set('WWW-Authenticate', 'Basic realm="WhatsApp Drive Sync", charset="UTF-8"');
      return res.status(401).send('Authentication required');
    }
    // Browser Basic credentials are ambient: reject cross-site state changes.
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      req.get('sec-fetch-site') === 'cross-site'
    ) {
      return res.status(403).json({ error: 'Cross-site request rejected' });
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('origin')) {
      try {
        if (new URL(req.get('origin')).host !== req.get('host')) throw new Error('origin mismatch');
      } catch {
        return res.status(403).json({ error: 'Cross-origin request rejected' });
      }
    }
    req.visitor = { name, admin: user.admin === true };
    next();
  };
}
export function readAccessUsers() {
  if (!process.env.ACCESS_USERS_JSON) return null;
  let users;
  try {
    users = JSON.parse(process.env.ACCESS_USERS_JSON);
  } catch {
    throw new Error('ACCESS_USERS_JSON must be valid JSON');
  }
  if (
    !users ||
    Array.isArray(users) ||
    !Object.keys(users).length ||
    Object.entries(users).some(
      ([name, user]) =>
        !name ||
        name.includes(':') ||
        !user ||
        typeof user.password !== 'string' ||
        user.password.length < 12
    )
  ) {
    throw new Error(
      'ACCESS_USERS_JSON must contain named users with passwords of at least 12 characters'
    );
  }
  return users;
}
