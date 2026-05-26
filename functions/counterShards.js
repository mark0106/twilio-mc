import { FieldValue } from 'firebase-admin/firestore';
import { db } from './firebase.js';
import { INTERNAL_STATUSES } from './sendsStateMachine.js';

export const SHARD_COUNT = 50;

export function pickShardId() {
  return Math.floor(Math.random() * SHARD_COUNT);
}

export function shardRef(tenantId, sendId, shardId) {
  return db
    .collection('tenants')
    .doc(tenantId)
    .collection('singleSends')
    .doc(sendId)
    .collection('counterShards')
    .doc(String(shardId));
}

// Writes all SHARD_COUNT shard docs with every counter set to 0. Done in a
// single batched write so the shards appear atomically — otherwise the UI's
// onSnapshot would see partial state.
export async function initCounterShards(tenantId, sendId) {
  const zero = Object.fromEntries(INTERNAL_STATUSES.map((s) => [s, 0]));
  const batch = db.batch();
  for (let i = 0; i < SHARD_COUNT; i++) {
    batch.set(shardRef(tenantId, sendId, i), zero);
  }
  await batch.commit();
}

export function buildShardIncrementUpdate(deltas) {
  const update = {};
  for (const [field, delta] of Object.entries(deltas)) {
    if (delta) update[field] = FieldValue.increment(delta);
  }
  return update;
}
