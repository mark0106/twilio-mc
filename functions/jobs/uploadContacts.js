import { Readable } from 'node:stream';
import Papa from 'papaparse';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase.js';
import {
  normalizePhone,
  pickPhoneField,
  pickFirstName,
  pickLastName,
  pickCustomFields,
} from '../phone.js';

const PROGRESS_EVERY = 5_000;
const MAX_ERROR_SAMPLE = 100;
const NEWLINE = 0x0a;

function countLines(buffer) {
  let count = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === NEWLINE) count++;
  }
  return count;
}

// Strip BOM if present so the first header doesn't end up as "﻿phone".
function stripBom(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3);
  }
  return buffer;
}

function transformHeader(header) {
  return String(header || '').trim().toLowerCase();
}

export async function processCsvUpload({
  tenantId,
  name,
  region = 'US',
  fileBuffer,
}) {
  const buffer = stripBom(fileBuffer);

  // Pre-count newlines so the progress doc has a real `total` for the UI bar.
  // We subtract 1 for the header row; minimum 0.
  const linesTotal = Math.max(0, countLines(buffer) - 1);

  const tenantRef = db.collection('tenants').doc(tenantId);
  const listRef = tenantRef.collection('contactLists').doc();
  const contactsRef = listRef.collection('contacts');

  await listRef.set({
    name: String(name || 'Untitled list').trim().slice(0, 200) || 'Untitled list',
    count: 0,
    status: 'uploading',
    uploadProgress: { processed: 0, total: linesTotal, errors: 0 },
    region,
    createdAt: FieldValue.serverTimestamp(),
  });

  let processed = 0; // rows with a valid phone, queued for write
  let errors = 0;
  let written = 0; // rows that BulkWriter has confirmed committed
  let lastProgressAt = 0;
  const errorSample = [];

  const bulkWriter = db.bulkWriter();
  bulkWriter.onWriteError((err) => err.failedAttempts < 5);
  bulkWriter.onWriteResult(() => {
    written++;
    if (written - lastProgressAt >= PROGRESS_EVERY) {
      lastProgressAt = written;
      listRef
        .update({
          'uploadProgress.processed': written,
          'uploadProgress.errors': errors,
        })
        .catch(() => {});
    }
  });

  let rowIndex = 0;

  const stream = Readable.from([buffer]);

  await new Promise((resolve, reject) => {
    Papa.parse(stream, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader,
      step: (results, parser) => {
        rowIndex++;
        const row = results.data;
        if (!row || typeof row !== 'object') return;

        const phoneRaw = pickPhoneField(row);
        const phone = normalizePhone(phoneRaw, region);

        if (!phone) {
          errors++;
          if (errorSample.length < MAX_ERROR_SAMPLE) {
            errorSample.push({
              row: rowIndex,
              reason: phoneRaw ? 'invalid_phone' : 'missing_phone',
              value: phoneRaw == null ? null : String(phoneRaw).slice(0, 64),
            });
          }
          return;
        }

        const contact = { phone };
        const firstName = pickFirstName(row);
        if (firstName) contact.firstName = firstName;
        const lastName = pickLastName(row);
        if (lastName) contact.lastName = lastName;
        const customFields = pickCustomFields(row);
        if (Object.keys(customFields).length) contact.customFields = customFields;

        processed++;
        bulkWriter.set(contactsRef.doc(), contact);
      },
      complete: () => resolve(),
      error: (err) => reject(err),
    });
  });

  await bulkWriter.close();

  await listRef.update({
    status: 'ready',
    count: processed,
    uploadProgress: { processed, total: linesTotal || processed, errors },
    ...(errorSample.length ? { errorSample } : {}),
    completedAt: FieldValue.serverTimestamp(),
  });

  return {
    listId: listRef.id,
    name: (await listRef.get()).data().name,
    processed,
    errors,
    errorSample,
    total: linesTotal,
  };
}

// Used by DELETE — wipes a list doc and all its subcollections.
export async function deleteContactList({ tenantId, listId }) {
  const listRef = db
    .collection('tenants')
    .doc(tenantId)
    .collection('contactLists')
    .doc(listId);
  await db.recursiveDelete(listRef);
}
