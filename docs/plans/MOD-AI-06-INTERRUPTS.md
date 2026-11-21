# MOD-AI-06 — Native interrupts on private approval rows

D-180 ratifies this storage boundary before implementation. The backend remains
inactive until whole-batch admission, plan reconstruction and crash acceptance
also pass.

## One row, two distinct states

The existing RunInterrupt is the private policy proposal. Its id, payload,
response, status and timestamps retain their policy meanings. An operator answer
may resolve that policy proposal before a continuation runs. TanStack consumes
the native interrupt only at its successful persistence boundary; a failed
continuation must still see the native interrupt pending. Equating these two
states would lose recovery information.

The same row therefore gains nullable nativeInterruptId (globally unique),
nativePayload, nativeResponse, nativeStatus, nativeRequestedAt and
nativeResolvedAt. No second approval row or table is created. The native payload
is the complete library descriptor, including its schema binding and typed
request. nativeResponse is an optional JSON envelope `{ value: ... }`, preserving
an explicit JSON null separately from an absent response. A database constraint
requires either an entirely absent native facet or a complete facet with legal
pending/terminal timestamps. Policy-only automatic approvals and identity windows
are excluded from native reads. There is no historical backfill or fallback.

## Explicit transactional authority

The principal-scoped adapter requires server callbacks for a transaction, locating
the existing private proposal, authorizing attachment and authorizing each terminal
write. An attachment verifies owned matching run/thread/proposal identity under
locks and is insert-if-absent on the native ID. Duplicate owned IDs retain their
original record regardless of replacement input; a foreign global collision is
opaque. Only a pending private proposal without a native facet can be attached.

The production attachment validator uses the captured D-177 lease through the
D-179 boundary fence, the shared strict tool approval schema and the installed
library's binding constructor/reader. It verifies the private proposal, native
descriptor ID, thread/run, generation zero, batch index, definition, key, schema
hashes/response schema, tool call, arguments and policy binding. Protocol data
does not grant policy authority. Generic conformance uses explicitly admitted
fixture proposals and synthetic payloads, never the production validator.

resolve/cancel are no-ops for missing, foreign, wrong-engine or already terminal
native IDs. commitBatch rejects duplicates, missing IDs and non-pending entries
before mutation and commits every entry or none. Owned thread locks are acquired
in stable order before proposal locks. Every entry's mandatory server authority
is checked before any native write. Terminal protocol writes never implicitly
approve a private proposal or replace its resolution. The subsequent resume
admission implementation must provide a server-owned acceptance proof plus the
fresh continuation lease; this slice supplies no permissive production consumer.
All mutations can join D-179 so native consumption, canonical transcript and run
closure roll back together. Reads validate complete JSON and preserve native
requestedAt ordering, using row sequence for ties.

## Acceptance and remaining work

Run the unmodified installed InterruptStore conformance cases with explicit
omissions. PostgreSQL tests must cover scope/engine isolation, one-row attachment,
duplicate/colliding IDs, private/native state separation, null response, stable
ordering, concurrent consumption, all-or-none validation/authority failure,
transaction rollback, malformed descriptor/schema/correlation and stale/cancelled
producer attachment. Test real middleware pause with these stores at the owned
closing boundary. Complete migration drift, R7 and the repository gate.

This does not yet implement answer admission, accepted-batch identity, policy plan
reconstruction, durable dispatch uncertainty, process restart or event closure.
Those are mandatory remaining MOD-AI-06/MOD-AI-07/MOD-DU-02 work. No endpoint,
configuration switch, second tool loop or new workflow engine is introduced.
