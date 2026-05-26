import { Router } from 'express';
import {
  buildClientForTenant,
  TwilioNotConnectedError,
} from '../twilioClient.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const { client } = await buildClientForTenant(req.user.uid);
    const services = await client.messaging.v1.services.list({ limit: 100 });
    res.json({
      services: services.map((s) => ({
        sid: s.sid,
        friendlyName: s.friendlyName,
      })),
    });
  } catch (err) {
    if (err instanceof TwilioNotConnectedError) {
      return res.status(400).json({ error: 'twilio_not_connected' });
    }
    if (err.status === 401 || err.code === 20003) {
      return res.status(400).json({ error: 'twilio_auth_failed' });
    }
    next(err);
  }
});

export default router;
