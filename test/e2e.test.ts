import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import test from 'node:test';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { createHTTPServer } from '@trpc/server/adapters/standalone';
import { OptoSyncClient, SYNC_STATUS } from '@opto-sync/client';

import { appRouter, resetAuthoritative, type AppRouter } from '../src/router.js';

test('an optimistic IndexedDB write crosses tRPC and is merged by Opto-Sync', async () => {
  resetAuthoritative();
  const server = createHTTPServer({ router: appRouter });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const rpc = createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: `http://127.0.0.1:${address.port}` })],
    });
    const health = await rpc.health.query();
    assert.match(health.mergeEngine, /^0\.2\./);

    const client = new OptoSyncClient({ databaseName: 'trpc-opto-sync-e2e' });
    const mutation = await client.queueMutation('documents', 'doc-1', {
      id: 'doc-1',
      title: 'offline edit',
      updatedAt: '200',
      metadata: { clientOnly: true },
    });

    const serverDocument = await rpc.document.query();
    const optimistic = await client.localView('documents', 'doc-1', serverDocument);
    assert.equal(optimistic.title, 'offline edit');
    assert.deepEqual(optimistic.metadata, { serverOnly: true, clientOnly: true });

    const merged = await rpc.merge.mutate({ incoming: optimistic as never });
    await client.markMutation(mutation, SYNC_STATUS.SYNCED);
    assert.equal(merged.title, 'offline edit');
    assert.deepEqual(merged.metadata, { serverOnly: true, clientOnly: true });
    assert.equal((await client.pendingMutations()).length, 0);
    client.db.close();
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
