import { initTRPC } from '@trpc/server';
import {
  reconcileIncoming,
  engineVersion,
  type Change,
  type JsonRecord,
  type MutationResult,
  type PushResponse,
} from '@opto-sync/client';
import { z } from 'zod';

const t = initTRPC.create();
const documentSchema = z.object({
  id: z.string(),
  title: z.string(),
  updatedAt: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const pushRequestSchema = z.object({
  protocolVersion: z.literal(1),
  clientId: z.string().min(1),
  mutations: z.array(z.object({
    mutationId: z.string().regex(/^[1-9]\d*$/),
    operation: z.enum(['upsert', 'delete']),
    table: z.string().min(1),
    recordId: z.string().min(1),
    payload: documentSchema.optional(),
    baseRevision: z.string().optional(),
    resurrect: z.boolean().optional(),
  })).max(100),
});

let authoritative = new Map<string, JsonRecord>();
let changes: Change[] = [];
let seenMutations = new Map<string, MutationResult>();
let protocolAvailable = true;

function seedDocuments(): void {
  authoritative = new Map([
    ['documents/doc-1', {
      id: 'doc-1',
      title: 'server draft one',
      updatedAt: '100',
      metadata: { serverOnly: true },
    }],
    ['documents/doc-2', {
      id: 'doc-2',
      title: 'server draft two',
      updatedAt: '100',
      metadata: { serverOnly: true },
    }],
  ]);
  changes = [];
  seenMutations = new Map();
  protocolAvailable = true;
}

function applyChange(
  table: string,
  recordId: string,
  incoming: JsonRecord | null,
  source?: { clientId: string; mutationId: string },
): Change {
  const key = `${table}/${recordId}`;
  const checkpoint = String(changes.length + 1);
  let record: JsonRecord | null = null;
  if (incoming) {
    record = authoritative.has(key)
      ? reconcileIncoming(authoritative.get(key)!, incoming)
      : incoming;
    authoritative.set(key, record);
  } else {
    authoritative.delete(key);
  }
  const change: Change = {
    checkpoint,
    table,
    recordId,
    operation: record ? 'upsert' : 'delete',
    record,
    revision: checkpoint,
    ...(source ? { source } : {}),
  };
  changes.push(change);
  return change;
}

seedDocuments();

export function resetAuthoritative(): void {
  seedDocuments();
}

export function setProtocolAvailable(available: boolean): void {
  protocolAvailable = available;
}

function requireProtocolAvailable(): void {
  if (!protocolAvailable) throw new Error('sync transport is temporarily unavailable');
}

export const appRouter = t.router({
  health: t.procedure.query(() => ({
    ok: true,
    mergeEngine: engineVersion(),
  })),
  document: t.procedure
    .input(z.object({ id: z.string() }).optional())
    .query(({ input }) => authoritative.get(`documents/${input?.id ?? 'doc-1'}`)),
  merge: t.procedure
    .input(z.object({ incoming: documentSchema }))
    .mutation(({ input }) => {
      return applyChange('documents', input.incoming.id, input.incoming).record;
    }),
  serverEdit: t.procedure
    .input(documentSchema)
    .mutation(({ input }) => applyChange('documents', input.id, input).record),
  protocolPush: t.procedure
    .input(pushRequestSchema)
    .mutation(({ input }): PushResponse => {
      requireProtocolAvailable();
      const results = input.mutations.map((mutation): MutationResult => {
        const dedupeKey = `${input.clientId}/${mutation.mutationId}`;
        const previous = seenMutations.get(dedupeKey);
        if (previous) {
          return {
            ...previous,
            status: 'duplicate',
            originalStatus: previous.status === 'rejected' ? 'rejected' : 'applied',
          };
        }
        if (mutation.operation === 'upsert' && !mutation.payload) {
          const rejected: MutationResult = {
            mutationId: mutation.mutationId,
            status: 'rejected',
            code: 'PAYLOAD_REQUIRED',
            message: 'upserts require a document payload',
          };
          seenMutations.set(dedupeKey, rejected);
          return rejected;
        }
        const change = applyChange(
          mutation.table,
          mutation.recordId,
          mutation.operation === 'upsert' ? mutation.payload! : null,
          { clientId: input.clientId, mutationId: mutation.mutationId },
        );
        const applied: MutationResult = {
          mutationId: mutation.mutationId,
          status: 'applied',
          checkpoint: change.checkpoint,
          revision: change.revision,
        };
        seenMutations.set(dedupeKey, applied);
        return applied;
      });
      return {
        protocolVersion: 1,
        clientId: input.clientId,
        lastMutationId: input.mutations.at(-1)?.mutationId ?? '0',
        checkpoint: String(changes.length),
        results,
      };
    }),
  protocolPull: t.procedure
    .input(z.object({
      checkpoint: z.string().regex(/^(?:0|[1-9]\d*)$/),
      limit: z.number().int().min(1).max(1000),
    }))
    .query(({ input }) => {
      requireProtocolAvailable();
      const pending = changes
        .filter((change) => BigInt(change.checkpoint) > BigInt(input.checkpoint))
        .slice(0, input.limit);
      const checkpoint = pending.at(-1)?.checkpoint ?? input.checkpoint;
      return {
        protocolVersion: 1 as const,
        checkpoint,
        hasMore: changes.some((change) => BigInt(change.checkpoint) > BigInt(checkpoint)),
        changes: pending,
      };
    }),
  protocolSnapshot: t.procedure.query(() => {
    requireProtocolAvailable();
    return {
      protocolVersion: 1 as const,
      checkpoint: String(changes.length),
      records: [...authoritative.entries()].map(([key, record]) => {
        const [table, recordId] = key.split('/');
        const revision = [...changes].reverse().find(
          (change) => change.table === table && change.recordId === recordId,
        )?.revision ?? '1';
        return { table, recordId, record, revision };
      }),
    };
  }),
});

export type AppRouter = typeof appRouter;
