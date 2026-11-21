import { Prisma } from '@prisma/client';
import {
  messageKeyring,
  openJson,
  openText,
  sealJson,
  sealText,
  type SealableJson,
} from '../credentials/message-cipher.js';
import type { Keyring } from '../credentials/keyring.js';

/**
 * Seals message text on its way into the database and opens it on the way out
 * (D-236), as a Prisma client extension on the one client.
 *
 * Why here, and not at each call site
 *
 * Some twenty files write or read a `Message`, and a row reaches others as a
 * relation of something else (an attachment's message, a task's brief). A
 * seal at each call site is correct on the day it is written and wrong on the
 * day someone adds the twenty-first: the new read shows ciphertext, or the new
 * write stores plaintext and nothing fails. Below the call sites there is one
 * place, and code above it never sees a sealed value.
 *
 * What this does not see
 *
 * Raw SQL. A `$queryRaw` that selects `content` gets the stored value, and
 * Postgres cannot search or compare ciphertext, so those few queries open what
 * they read themselves (`openStoredMessageText`) and transcript search ranks
 * opened text (`work/transcript-search.ts`). Two things are refused outright
 * instead of being allowed to go quietly wrong:
 *
 * - a `where` that compares `content` to anything but the empty string,
 * which could only ever match nothing;
 * - a message or run event written as a nested write of another model,
 * which this extension's per-model hook would not seal.
 */

const MESSAGE = 'Message';
const RUN_EVENT = 'RunEvent';

/** Operations whose result holds rows, and so possibly a sealed value. */
const ROW_RESULTS: ReadonlySet<string> = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'create',
  'update',
  'upsert',
  'delete',
  'createManyAndReturn',
  'updateManyAndReturn',
]);

const NESTED_WRITES: readonly string[] = [
  'create',
  'createMany',
  'connectOrCreate',
  'update',
  'updateMany',
  'upsert',
];

type Row = Record<string, unknown>;

/** model → relation field → the model it points at, read from the client's own schema. */
const RELATIONS: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(
  Prisma.dmmf.datamodel.models.map((model) => [
    model.name,
    new Map(
      model.fields
        .filter((field) => field.kind === 'object')
        .map((field) => [field.name, field.type]),
    ),
  ]),
);

export function messageSealing(resolve: () => Keyring | null = messageKeyring) {
  return Prisma.defineExtension({
    name: 'message-sealing',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const keyring = resolve();
          const result: unknown = await query(sealArguments(model, args, keyring));
          return ROW_RESULTS.has(operation) ? openRows(model, result, keyring) : result;
        },
      },
    },
  });
}

/**
 * Open `content` as a raw query returned it. For the few queries that must
 * select it in SQL; everything that goes through a model is opened already.
 */
export function openStoredMessageText(stored: string): string {
  return openText(stored, 'message.content', messageKeyring());
}

function sealArguments<A>(model: string, args: A, keyring: Keyring | null): A {
  if (!isRow(args)) return args;
  if (model === MESSAGE) refuseContentComparison(args['where']);
  if (model !== MESSAGE && model !== RUN_EVENT) {
    refuseNestedWrite(model, args['data']);
    refuseNestedWrite(model, args['create']);
    refuseNestedWrite(model, args['update']);
    return args;
  }
  if (keyring === null) return args;
  const seal = model === MESSAGE ? sealMessage : sealRunEvent;
  const sealed: Row = { ...args };
  for (const key of ['data', 'create', 'update']) {
    const value = args[key];
    if (Array.isArray(value)) {
      sealed[key] = value.map((entry: unknown) => (isRow(entry) ? seal(entry, keyring) : entry));
    } else if (isRow(value)) {
      sealed[key] = seal(value, keyring);
    }
  }
  // Same keys, same shapes: only the values of sealed columns changed.
  return sealed as A;
}

/** A copy, never the caller's object: a retried write must not seal its own ciphertext. */
function sealMessage(data: Row, keyring: Keyring): Row {
  const sealed: Row = { ...data };
  const content = data['content'];
  if (typeof content === 'string') {
    sealed['content'] = sealText(content, 'message.content', keyring);
  } else if (isRow(content) && typeof content['set'] === 'string') {
    sealed['content'] = { set: sealText(content['set'], 'message.content', keyring) };
  }
  const parts = data['parts'];
  if (isJsonValue(parts)) sealed['parts'] = sealJson(parts, 'message.parts', keyring);
  return sealed;
}

function sealRunEvent(data: Row, keyring: Keyring): Row {
  const chunk = data['chunk'];
  return isJsonValue(chunk) ? { ...data, chunk: sealJson(chunk, 'runEvent.chunk', keyring) } : data;
}

/** A value for a `Json` column, as opposed to "leave it" or one of Prisma's nulls. */
function isJsonValue(value: unknown): value is SealableJson {
  if (value === undefined || value === null) return false;
  return value !== Prisma.DbNull && value !== Prisma.JsonNull && value !== Prisma.AnyNull;
}

/** Opens every message and run event in a result, following the relations it includes. */
function openRows(model: string, value: unknown, keyring: Keyring | null): unknown {
  if (Array.isArray(value)) {
    for (const entry of value) openRows(model, entry, keyring);
    return value;
  }
  if (!isRow(value)) return value;
  if (model === MESSAGE) {
    const content = value['content'];
    if (typeof content === 'string')
      value['content'] = openText(content, 'message.content', keyring);
    if (value['parts'] !== undefined) {
      value['parts'] = openJson(value['parts'], 'message.parts', keyring);
    }
  } else if (model === RUN_EVENT && value['chunk'] !== undefined) {
    value['chunk'] = openJson(value['chunk'], 'runEvent.chunk', keyring);
  }
  for (const [field, target] of RELATIONS.get(model) ?? []) {
    const related = value[field];
    if (related !== undefined && related !== null) openRows(target, related, keyring);
  }
  return value;
}

function refuseContentComparison(where: unknown): void {
  if (Array.isArray(where)) {
    for (const entry of where) refuseContentComparison(entry);
    return;
  }
  if (!isRow(where)) return;
  if (where['content'] !== undefined && !comparesToEmpty(where['content'])) {
    throw new Error(
      'Message.content is sealed at rest, so the database can only tell an empty one from a ' +
        'non-empty one. Read the rows and compare what they say instead.',
    );
  }
  for (const key of ['AND', 'OR', 'NOT']) refuseContentComparison(where[key]);
}

function comparesToEmpty(filter: unknown): boolean {
  if (filter === '') return true;
  if (!isRow(filter)) return false;
  return Object.entries(filter).every(([key, value]) => {
    if (value === undefined) return true;
    if (key === 'equals' || key === 'not') return comparesToEmpty(value);
    if (key === 'in' || key === 'notIn')
      return Array.isArray(value) && value.every((v) => v === '');
    return false;
  });
}

function refuseNestedWrite(model: string, data: unknown): void {
  if (Array.isArray(data)) {
    for (const entry of data) refuseNestedWrite(model, entry);
    return;
  }
  if (!isRow(data)) return;
  for (const [field, target] of RELATIONS.get(model) ?? []) {
    const nested = data[field];
    if (!isRow(nested)) continue;
    for (const verb of NESTED_WRITES) {
      const written = nested[verb];
      if (written === undefined) continue;
      if (target === MESSAGE || target === RUN_EVENT) {
        throw new Error(
          `${target} rows are sealed by their own model's writes. Write this one with ` +
            `${target === MESSAGE ? 'message' : 'runEvent'}.create, not nested under ${model}.`,
        );
      }
      // `update`, `upsert` and `connectOrCreate` wrap the data one level down.
      for (const entry of Array.isArray(written) ? written : [written]) {
        if (!isRow(entry)) continue;
        refuseNestedWrite(target, entry);
        for (const key of ['data', 'create', 'update']) refuseNestedWrite(target, entry[key]);
      }
    }
  }
}

function isRow(value: unknown): value is Row {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !Buffer.isBuffer(value)
  );
}
