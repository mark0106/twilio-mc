import { auth } from './firebase.js';

export async function verifyFirebaseToken(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ error: 'missing_bearer_token' });
  }
  try {
    const decoded = await auth.verifyIdToken(match[1]);
    req.user = { uid: decoded.uid, email: decoded.email };
    next();
  } catch (err) {
    req.log?.warn({ err: err.message }, 'id token verification failed');
    res.status(401).json({ error: 'invalid_token' });
  }
}
