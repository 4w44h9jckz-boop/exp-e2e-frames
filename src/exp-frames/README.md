# Vendored from exp-frames

`frametx/`, `contracts.ts`, `deploy.ts` and `execute.ts` are copied from
[exp-frames](https://github.com/4w44h9jckz-boop/exp-frames) at `37ac4aa`, its `main` after pull
request #50, so that experiment 15 builds and checks its frame transactions offline without a
checkout. The one edit: `contracts.ts` resolves `REPO_ROOT` two directories up instead of one,
since it sits one level deeper here. Change nothing else here; take a newer exp-frames instead,
and say so.
