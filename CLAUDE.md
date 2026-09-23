See [AGENTS.md](AGENTS.md) for the full working context on this project:
the multi-tenancy model, the money conventions, why writes are RPC-only, how
the group-namespaced query cache works, and the migration rules that were
learned by breaking real pushes.

Read it before changing anything — a bug in this codebase does not surface as
an error, it surfaces as a number that is slightly too large.
