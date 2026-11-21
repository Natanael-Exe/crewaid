# MOD-AI-06 — Owned resume validation and admission

D-181 ratifies the validation boundary before its implementation. It does not
grant a continuation lease or consume an approval.

The server validates a complete canonical ExecutionResume batch against owned
database state under bot, TANSTACK thread, parked run and native proposal locks.
The original run must be interrupted without producer fields. Every pending
native descriptor in the thread must belong to that original run and its still
pending private proposal. The shared approval response schema, current native
definition, descriptor/schema hashes, exact private proposal and native generation
are checked before calling the installed validateInterruptResumeBatch helper.
Duplicate, partial, foreign, changed, cancelled or malformed entries change
nothing. No model, tool, browser or remote call occurs in this transaction.

The result carries validated server records and the library's canonical batch
fingerprint. It is a read snapshot, not a write capability or policy grant. The
subsequent answer admission transaction must repeat these checks under its own
locks while atomically staging private policy decisions and admitting the fresh
resumesRunId continuation. Native consumption remains D-180/D-179's successful
boundary. Accepted retries require their own stored acceptance proof; this
initial validation must not accept resolved private proposals by inference.

Before admission can be activated, persist normalized raw arguments separately
from the reviewed projection and the relevant skill revision. Reconstruct plans
from owned records, revalidate edits and recheck grants/resources/browser
generation before dispatch. Define accepted-versus-consumed retries, abandoned
answers/new input, cumulative checkpoint budgets and dispatch uncertainty before
their schema/code changes. Approval intent must never authorize replay of a
possibly committed effect. These remain required MOD-AI-06/MOD-DU-02 work.

Acceptance for this validation slice uses actual PostgreSQL, the current native
definition and the installed library validator. Complete batches return a stable
fingerprint without writes; duplicates, omissions, foreign IDs, mixed runs,
forged schemas/correlations, terminal private/native proposals and changed parked
state are refused. No new endpoint, table, configuration key or tool loop is added.
