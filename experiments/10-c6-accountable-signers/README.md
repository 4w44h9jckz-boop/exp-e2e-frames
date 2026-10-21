# Experiment 10: who signed, accountable against threshold signing

**The claim.** "A threshold signature is compact because it says nothing about who signed", a
feature for privacy and a defect for accountability (the main post, *How to NOT Build a Rollup
for L1*, on FOCIL's lists signed member by member). An accountable signature names the signers,
at a cost a `VERIFY` frame can pay.

**What would show it wrong.** Written before the first run, as the checks in
[`test/c6.test.ts`](../../test/c6.test.ts), and pushed before the first transaction:
- a threshold signature can be attributed from the signature and chain data alone: two
  different quorums make different signatures, or the threshold spend's frame carries anything
  beyond the epoch, the salt and the signature;
- naming the signers costs more than the validation budget at the committee sizes Appendix F
  names, 3-of-5, 7-of-10, 13 and 256: an accountable spend at one of those sizes is not mined,
  or its `VERIFY` frame uses more than 500,000 gas, the most the testnet's nodes admit.
  (Appendix D names no committee size.) EIP-8141's public mempool admits 100,000, which the
  threshold check already exceeds (122,006 gas in experiment 04); both are recorded against it.

**Amended before the first run** (the owner's word, through the coordinator, 2026-10-21): the
second check is worded as above; a control runs beside both BLS forms, `k` ordinary ECDSA
signatures from the same quorum checked one by one; and the record says who sees the partial
signatures. In threshold signing the members' partials go to whoever combines them, here the
runner, and only the combined signature reaches the chain; the accountable and ECDSA forms put
the signers in the transaction.

**Reported beside the results (2026-10-21, the owner's word through the coordinator)**; the
claim and the checks above are unchanged:
- **Summing the signers' keys, as run, against subtracting the non-signers from a stored
  aggregate** (derived): the paymaster adds `k = n - f` keys, one EIP-2537 G2 addition (600 gas)
  each; holding the sum of all `n` keys in code and subtracting the `f` absent ones costs `f`
  additions instead, about `(k - f) * 600` gas less (for 256 members, 86 fewer additions),
  and needs the absent keys only, not the present ones.
- **Keys from calldata checked against a stored commitment, as run, against keys from storage**
  (derived): calldata is 16 gas a non-zero byte, about 4,100 gas for a 256-byte key plus its
  share of one keccak; storage is 8 cold slot reads, 16,800 gas a key, and a public-mempool
  `VERIFY` frame may read no storage but its sender's, so a paymaster cannot read keys there at
  all. Keys in the paymaster's own code fit up to 96 G2 keys (EIP-170's 24,576 bytes).
- **Proofs of possession at registration**: not run. The runner makes the keys itself; a
  deployment checks each key's proof of possession before its hash is fixed in the paymaster,
  since the aggregate check is open to rogue keys otherwise (Commonware's multisig scheme says
  the same).
- **Bytes on the wire, bitmap included**: every spend records its transaction's encoded bytes
  and its `VERIFY` data's; the bitmap is `ceil(n / 8)` of them.
- **The hash to the curve**: RFC 9380's `BLS12381G1_XMD:SHA-256_SSWU_RO_`, with
  `expand_message_xmd` over the SHA-256 precompile, two field elements reduced with MODEXP,
  EIP-2537's `MAP_FP_TO_G1` on each and one G1 addition, under the DST
  `BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_POP_`, as Commonware's `MinSig` hashes and as the
  ticket paymaster does.
- **Not run**: verifier keys of constant size for an accountable scheme (ePrint 2023/1793).

## Pieces

| Piece | Pin (`pins.json`) | Role |
|---|---|---|
| kohaku-rs | `ab056ab` | `kohaku-frame-ticket`'s `TicketPaymaster`, the threshold form's paymaster unchanged, and the transaction builders |
| cmw-monorepo | `489e313` | Commonware `v2026.9.0`: a dealt threshold key, threshold signing and recovery, BLS key pairs and message signing (`MinSig`) |
| [`contracts/AccountablePaymaster.yul`](contracts/AccountablePaymaster.yul) | this experiment | the accountable form's paymaster, written from the ticket paymaster; `AccountablePaymaster.hex` is its creation code from solc 0.8.37, EVM osaka, optimizer on, 200 runs, and `npm test` compiles it again |
| [`contracts/EcdsaPaymaster.yul`](contracts/EcdsaPaymaster.yul) | this experiment | the control: `k` secp256k1 signatures named by a bitmap, each checked with `ECRECOVER` against the committee's committed addresses; compiled and checked the same way |
| chain | ethrex `hegota-testnet-hotfix` at `64b8fc09` | runs both checks on EIP-2537's precompiles |

## The two forms

For a committee of `n` members, `f = floor((n - 1) / 3)` and a quorum of `n - f` signs a fresh
sender's slot: the ticket's message (chain ID, sender, nonce keys, nonce sequence, epoch, salt).

| Form | `VERIFY` data | The paymaster checks |
|---|---|---|
| threshold | epoch (8), salt (32), one G1 signature (128): 168 bytes | `e(sigma, -g2) e(H(m), PK) = 1`, `PK` the group key in its code |
| accountable, aggregate | epoch, salt, mode 0, a bitmap of `n` bits, the `n` keys (256 bytes each), one G1 signature | the keys hash to the word in its code; at least `n - f` bits set; `e(sigma, -g2) e(H(m), sum of named keys) = 1` |
| accountable, individual | the same, mode 1, then each named signer's own signature | the same, with the signatures added in the frame |
| ECDSA control | epoch, salt, a bitmap of `n` bits, the `n` addresses (20 bytes each), then each named signer's `r`, `s`, `v` (65 bytes) | the addresses hash to the word in its code; each signature, low `s`, recovers to its member's address from `keccak256("FRAME_ECDSA_V1" || message)`; at least `n - f` named |

The threshold key is dealt by Commonware's `deal`, not made by a DKG: this experiment measures
verification, and experiment 08 measures the DKG and resharing. The accountable keys are `n`
independent key pairs; a deployment would check each key's proof of possession when the
committee is registered, before its hash is fixed in the paymaster.

The keys travel in the frame, with one hash in the code, because the paymaster reads no storage
and calls only precompiles, as a public-mempool `VERIFY` frame must, and a contract's code holds
at most 24,576 bytes: 96 G2 keys. So the accountable form pays for the keys as calldata at every
size, and the record shows how much.

## The run

For each size in 5, 10, 13, 16, 32, 64, 128 and 256: one transaction from the funder deploys
the three paymasters and funds them; then four spends, each from a fresh sender with no ether, go
to the chain's RPC one after another: threshold, ECDSA control, accountable aggregate, accountable
individual.
Off chain, the threshold signature is recovered from two quorums that differ, and compared.

## Run

```bash
npm install
npm run account && npm run faucet
npx tsx experiments/10-c6-accountable-signers/run.ts [attempt-label] [sizes]
```

The record is written to `results/<attempt>.json`: every transaction, its bytes, its gas by
frame, each paymaster and key set, every signature, and the chain's facts. It holds no private
key or share. `npm test` checks it offline, and checks every signature again with noble's
BLS12-381.

## Results

Attempt 3 (`results/3-margin-2.json`), from `4bb2de7`, on 2026-10-21, with each frame's declared
limit 2% over its fit (`LIMIT_MARGIN`). Thirty-one spends were mined, in blocks 493,619 to
493,692, each from a fresh sender with no ether, each paid by its paymaster. Each cell is
the paymaster's `VERIFY` gas and its data in bytes:

| n | quorum | threshold | accountable, aggregate | accountable, individual | ECDSA control |
|---|---|---|---|---|---|
| 5 | 4 | 122,006 / 168 | 126,842 / 1,450 | 129,351 / 1,834 | 18,108 / 401 |
| 10 | 7 | 122,006 / 168 | 130,317 / 2,731 | 134,671 / 3,499 | 28,704 / 697 |
| 13 | 9 | 122,006 / 168 | 132,571 / 3,499 | 138,155 / 4,523 | 35,736 / 887 |
| 16 | 11 | 122,006 / 168 | 134,827 / 4,267 | 141,641 / 5,547 | 42,756 / 1,077 |
| 32 | 22 | 122,006 / 168 | 147,172 / 8,365 | 160,751 / 11,053 | 81,371 / 2,114 |
| 64 | 43 | 122,006 / 168 | 171,227 / 16,561 | 197,721 / 21,937 | 155,246 / 4,123 |
| 128 | 86 | 122,006 / 168 | 220,932 / 32,953 | 273,871 / 43,833 | 306,357 / 8,206 |
| 256 | 171 | 122,006 / 168 | 322,587 / 65,737 | 427,801 / 87,497 | refused / 16,307 |

- **The threshold signature names no one.** At every size, the two quorums that differ made the
  same signature, byte for byte, and its frame carries 168 bytes: epoch, salt, signature.
  Nothing on chain or in the frame says who signed. Not shown wrong.
- **Naming the signers fits the budget at every size Appendix F names.** At 256 members, the
  aggregate form used 322,587 gas and the individual form 427,801, under the testnet nodes'
  500,000; at 5, 10 and 13 every accountable spend was mined well under it. Not shown wrong.
  Neither form fits EIP-8141's 100,000, and nor does the threshold check, at 122,006.
- **The control.** `k` ECDSA signatures cost about 3,514 gas each: cheaper than BLS up to about
  32 members, dearer above, and at 256 (171 signers) the declared budget passed 500,000 and the
  node refused the spend, as recorded.
- **Bytes.** The accountable form carries every member's 256-byte key, so its data grows with
  `n`: 65,737 bytes at 256 for one aggregate signature, against the threshold form's constant
  168. The keys could live in the paymaster's code up to 96 members.
- **Noble agrees** with the chain on every signature: the threshold one under the group key,
  each aggregate under the named keys' sum, and each individual one under its own signer's key;
  each ECDSA signature recovers to its member's address.

Attempts 1 and 2 are in `results/superseded/`, each refused somewhere by a parameter of the
harness, not by the claim's checks: the ticket's 0.001 ETH denomination in the first, a 10%
limit margin in the second. Their mined spends agree with attempt 3's to the gas.
