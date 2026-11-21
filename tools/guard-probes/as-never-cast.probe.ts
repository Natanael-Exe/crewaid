// D-013 probe — the `as never` ban MUST reject this file.
//
// `as never` is assignable to every parameter type, so it silences exactly the
// errors that matter: a genuine mismatch at a contract boundary. It hid a real
// Prisma.JsonValue-vs-Json error in the WS emit path, where the fix was to
// convert through the shared schema (apps/orchestrator/src/common/contract.ts).
//
// Expected rule: no-restricted-syntax (selector TSAsExpression > TSNeverKeyword)

declare function takesAContractType(value: { id: string; parts: string[] }): void;

const rowFromAnotherLayer = { id: 'msg_1', parts: { nested: true } };

takesAContractType(rowFromAnotherLayer as never);
