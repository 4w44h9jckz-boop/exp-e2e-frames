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

None yet: the claim and the checks above are pushed before the first transaction.
