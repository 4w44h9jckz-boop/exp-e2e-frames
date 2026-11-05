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
- `2-second-run/` (repository commit `0114573`, kohaku-rs `1fe661e`, which names witnesses as the
  builder reads them): 18 blocks with leanSPHINCS dependencies were built, and all 18 proofs
  checked valid. No secp256k1 key was set.
  - **Arm 2:** the account's transaction was mined at 26,225 gas, and a triple naming another key
    was refused by the pool's simulation.
  - **Arm 3:** recovery ran end to end: start, cancel, an outside guardian's start refused, two
    shares sealed with ML-KEM-768, finish past the unlock time, and the new owner's transaction.
  - **Arm 6:** the pool note's deposit was mined.
  - **Arms 4 and 5, and copy (a)'s tickets:** refused by the patched ethrex's pool, "frame
    transaction validation prefix does not match any recognized shape". The wallet's `declare`
    puts the dependency frame after the first `VERIFY`. In a ticket transaction that is between
    the sender's `VERIFY` and the paymaster's, which no recognized prefix allows. Experiment 22's
    rebuilt transactions put it after the last `VERIFY`, and are recognized.
