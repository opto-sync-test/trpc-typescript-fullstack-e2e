import { initTRPC } from '@trpc/server';
import { reconcileIncoming, engineVersion, type JsonRecord } from '@opto-sync/client';
import { z } from 'zod';

const t = initTRPC.create();
const documentSchema = z.object({
  id: z.string(),
  title: z.string(),
  updatedAt: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

let authoritative: JsonRecord = {
  id: 'doc-1',
  title: 'server draft',
  updatedAt: '100',
  metadata: { serverOnly: true },
};

export function resetAuthoritative(): void {
  authoritative = {
    id: 'doc-1',
    title: 'server draft',
    updatedAt: '100',
    metadata: { serverOnly: true },
  };
}

export const appRouter = t.router({
  health: t.procedure.query(() => ({
    ok: true,
    mergeEngine: engineVersion(),
  })),
  document: t.procedure.query(() => authoritative),
  merge: t.procedure
    .input(z.object({ incoming: documentSchema }))
    .mutation(({ input }) => {
      authoritative = reconcileIncoming(authoritative, input.incoming);
      return authoritative;
    }),
});

export type AppRouter = typeof appRouter;
