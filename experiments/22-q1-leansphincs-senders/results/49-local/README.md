# exp-frames experiment 49, arms 2 to 6, on experiment 22's local chain

Records of `q2-local.ts`, one directory per run.

- `1-first-run/` (repository commit `f06b9e1`, kohaku-rs `f80adbe`): nothing was mined. The
  funder's first transaction stayed in ethrex's pool, and every later arm failed behind it. The
  builder refused all 239 blocks it built: "no aggregate proof for the block's leanSPHINCS
  dependencies" (`checks` in `run.json`). The wallet wrote its witnesses as
  `w-0x<key>.json`, with the signature prefixed `0x0x`, because its `hand_in` formats both with a
  helper that already adds `0x`. The patched builder reads `w-<key>.json`. So no witness was
  found, and no signature was checked. The run says nothing about the arms themselves; it is kept
  because it is a run.
