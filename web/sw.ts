import { createTRPCClient, httpBatchLink } from '@trpc/client';
import {
  initOptoSync,
  OptoSyncClient,
  ProtocolSyncLoop,
  type Change,
  type ProtocolTransport,
  type SnapshotRecord,
} from '@opto-sync/client/browser';
import {
  installOptoSyncServiceWorker,
  type ServiceWorkerScopeLike,
} from '@opto-sync/client/service-worker';

import type { AppRouter } from '../src/router.js';

const queueDatabase = 'trpc-service-worker-e2e';
const stateDatabase = 'trpc-service-worker-state';
const scope = self as unknown as ServiceWorkerScopeLike & {
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
};

scope.addEventListener('install', (event: { waitUntil(work: Promise<unknown>): void }) => {
  event.waitUntil(scope.skipWaiting());
});
scope.addEventListener('activate', (event: { waitUntil(work: Promise<unknown>): void }) => {
  event.waitUntil(scope.clients.claim());
});

function openStateDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(stateDatabase, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('records', { keyPath: 'key' });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function applyChanges(changes: readonly Change[]): Promise<void> {
  const database = await openStateDatabase();
  try {
    const transaction = database.transaction('records', 'readwrite');
    const records = transaction.objectStore('records');
    for (const change of changes) {
      const key = `${change.table}/${change.recordId}`;
      if (change.operation === 'delete') records.delete(key);
      else records.put({ key, record: change.record, revision: change.revision });
    }
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

async function replaceAuthoritative(records: readonly SnapshotRecord[]): Promise<void> {
  const database = await openStateDatabase();
  try {
    const transaction = database.transaction('records', 'readwrite');
    const store = transaction.objectStore('records');
    store.clear();
    for (const entry of records) {
      store.put({
        key: `${entry.table}/${entry.recordId}`,
        record: entry.record,
        revision: entry.revision,
      });
    }
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

installOptoSyncServiceWorker({
  scope,
  async createSession() {
    await initOptoSync();
    const client = new OptoSyncClient({ databaseName: queueDatabase });
    const rpc = createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: `${location.origin}/trpc` })],
    });
    const transport: ProtocolTransport = {
      push: async (request) => rpc.protocolPush.mutate(request as never),
      pull: async (checkpoint, limit) => rpc.protocolPull.query({ checkpoint, limit }),
      snapshot: async () => rpc.protocolSnapshot.query(),
    };
    const loop = new ProtocolSyncLoop(
      client,
      transport,
      { applyChanges, replaceAuthoritative },
      { observeBrowserLifecycle: false, pushLimit: 100, pullLimit: 100 },
    );
    return { loop };
  },
});
