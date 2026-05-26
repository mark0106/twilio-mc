import { Router } from 'express';
import Busboy from 'busboy';
import { db } from '../firebase.js';
import {
  processCsvUpload,
  deleteContactList,
} from '../jobs/uploadContacts.js';

const router = Router();

const MAX_FILE_BYTES = 32 * 1024 * 1024;

function tenantRef(uid) {
  return db.collection('tenants').doc(uid);
}

// POST /contact-lists?region=US  multipart: { name, csv }
router.post('/', (req, res, next) => {
  let busboy;
  try {
    busboy = Busboy({
      headers: req.headers,
      limits: {
        fileSize: MAX_FILE_BYTES,
        files: 1,
        fields: 5,
      },
    });
  } catch (err) {
    return res.status(400).json({ error: 'invalid_multipart', message: err.message });
  }

  const fields = {};
  let fileChunks = [];
  let fileTooLarge = false;
  let fileSeen = false;

  busboy.on('field', (name, value) => {
    if (name in fields) return; // ignore dupes
    fields[name] = value;
  });

  busboy.on('file', (fieldname, file, info) => {
    fileSeen = true;
    file.on('data', (chunk) => {
      fileChunks.push(chunk);
    });
    file.on('limit', () => {
      fileTooLarge = true;
      fileChunks = []; // free the memory
      file.resume();
    });
    file.on('end', () => {
      if (fileTooLarge) return;
    });
  });

  busboy.on('error', next);

  busboy.on('close', async () => {
    try {
      if (!fileSeen) {
        return res.status(400).json({ error: 'missing_csv_file' });
      }
      if (fileTooLarge) {
        return res.status(413).json({
          error: 'file_too_large',
          maxBytes: MAX_FILE_BYTES,
        });
      }

      const buffer = Buffer.concat(fileChunks);
      fileChunks = null;
      if (!buffer.length) {
        return res.status(400).json({ error: 'empty_csv_file' });
      }

      const name = (fields.name || '').trim() || 'Untitled list';
      const region = (req.query.region || fields.region || 'US')
        .toString()
        .toUpperCase()
        .slice(0, 2);

      const result = await processCsvUpload({
        tenantId: req.user.uid,
        name,
        region,
        fileBuffer: buffer,
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Cloud Functions Gen 2 pre-buffers the request body into req.rawBody, so
  // piping the (already-consumed) req stream into busboy fails with
  // "Unexpected end of form". When rawBody is available, feed it directly.
  if (req.rawBody) {
    busboy.end(req.rawBody);
  } else {
    req.pipe(busboy);
  }
});

// GET /contact-lists  — list view (frontend usually reads via onSnapshot, but this is here for API parity)
router.get('/', async (req, res, next) => {
  try {
    const snap = await tenantRef(req.user.uid)
      .collection('contactLists')
      .orderBy('createdAt', 'desc')
      .limit(200)
      .get();
    res.json({
      lists: snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          name: data.name,
          count: data.count || 0,
          status: data.status,
          uploadProgress: data.uploadProgress || null,
          createdAt: data.createdAt?.toDate?.()?.toISOString?.() || null,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

// GET /contact-lists/:id/preview  — first 20 contacts
router.get('/:id/preview', async (req, res, next) => {
  try {
    const listRef = tenantRef(req.user.uid)
      .collection('contactLists')
      .doc(req.params.id);
    const listSnap = await listRef.get();
    if (!listSnap.exists) return res.status(404).json({ error: 'not_found' });

    const contactsSnap = await listRef.collection('contacts').limit(20).get();
    res.json({
      list: {
        id: listSnap.id,
        name: listSnap.data().name,
        count: listSnap.data().count || 0,
        status: listSnap.data().status,
        errorSample: listSnap.data().errorSample || [],
      },
      contacts: contactsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /contact-lists/:id  — recursive delete
router.delete('/:id', async (req, res, next) => {
  try {
    const listRef = tenantRef(req.user.uid)
      .collection('contactLists')
      .doc(req.params.id);
    const snap = await listRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found' });

    await deleteContactList({ tenantId: req.user.uid, listId: req.params.id });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

export default router;
