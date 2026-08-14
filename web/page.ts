import { initOptoSync, OptoSyncClient } from '@opto-sync/client/browser';

const queueDatabase = 'trpc-service-worker-e2e';
const stateDatabase = 'trpc-service-worker-state';
let client: OptoSyncClient | undefined;

async function initialize(): Promise<void> {
  await initOptoSync();
  client = new OptoSyncClient({ databaseName: queueDatabase });
  await navigator.serviceWorker.register('/sw.js', { scope: '/', type: 'module' });
  await navigator.serviceWorker.ready;
}

async function queueMultiplexedEdits(): Promise<void> {
  if (!client) throw new Error('page client is not initialized');
  await Promise.all([
    client.queueMutation('documents', 'doc-1', {
      id: 'doc-1',
      title: 'offline edit from web lane one',
      updatedAt: '200',
      metadata: { webLane: 'one' },
    }),
    client.queueMutation('documents', 'doc-2', {
      id: 'doc-2',
      title: 'offline edit from web lane two',
      updatedAt: '201',
      metadata: { webLane: 'two' },
    }),
  ]);
}

async function wakeWorker(): Promise<unknown> {
  const registration = await navigator.serviceWorker.ready;
  const target = registration.active ?? registration.waiting ?? registration.installing;
  if (!target) throw new Error('service worker is not active');
  const channel = new MessageChannel();
  const reply = new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('worker response timeout')), 10_000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timeout);
      resolve(event.data);
    };
  });
  target.postMessage({ type: 'opto-sync:sync' }, [channel.port2]);
  return reply;
}

function openStateDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(stateDatabase, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function authoritativeRecord(key: string): Promise<unknown> {
  const database = await openStateDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction('records', 'readonly').objectStore('records').get(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result?.record ?? null);
    });
  } finally {
    database.close();
  }
}

declare global {
  interface Window {
    optoTest: {
      initialize(): Promise<void>;
      queueMultiplexedEdits(): Promise<void>;
      wakeWorker(): Promise<unknown>;
      authoritativeRecord(key: string): Promise<unknown>;
    };
  }
}

window.optoTest = {
  initialize,
  queueMultiplexedEdits,
  wakeWorker,
  authoritativeRecord,
};
