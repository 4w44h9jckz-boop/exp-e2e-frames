# bls-committee

The signing half of C1's committee: a BLS12-381 key from Commonware's DKG, held by four members
with a quorum of three, signing what the FHE half decrypted. See [`../README.md`](../README.md).

## The signed result (fixed)

`bls-committee` signs, under Commonware's `ops::sign_message::<MinSig>` with namespace
`FRAME_FHE_RESULT_V1`:

```text
message = chain_id (32) || request (32) || handle (32) || value (32)          128 bytes
```

- `request`: 32 bytes the result transaction names its request by;
- `handle`: keccak256 of the result ciphertext's bytes, as the coprocessor wrote them;
- `value`: the decrypted value, big-endian.

The point signed is `hash_to_curve(len(namespace) || namespace || message)` in G1, RFC 9380's
`BLS12381G1_XMD:SHA-256_SSWU_RO_` suite under the DST `BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_POP_`,
the same as a blind ticket's. So the ticket paymaster's check, with its namespace and message
changed, checks a result: `e(sigma, -g2) e(H(m), PK) = 1` on EIP-2537. The signature is 128 bytes
and the key 256, in EIP-2537's encodings.

`sign` refuses fewer signers than the quorum. `sign-below` writes what two of four can make, the
interpolation of their two partials at zero, so a run can show it refused.

## One result per request

Each member keeps a lock per request (`member-<i>.locks.json`): the digest of the one message it
signed for that request. It signs that message again if asked, and refuses any other result for
the same request. Any two quorums of `q` among `n` share at least `2q - n` members; with
`n = 4`, `q = 3` and at most `t = 1` corrupted member, `q > (n + t) / 2`, so two quorums share
two members and at least one honest member, who refuses the second result. `--ignore-lock`
names members who behave as corrupted ones and sign regardless.

## What `t` members can make

`forge` takes the named members' shares and every public value of the DKG (the group sharing,
which sums the dealers' commitments, and every member's partial key: what a member of a Feldman
round sees besides its own dealings) and tries: each partial alone, each partial with its
Lagrange weight in a quorum it could join, and, for two or more, their sum and their
interpolation at zero. Every candidate is checked under the group key.

## Commonware's parameters, as this crate uses them

- `Sharing::required()` is `q`, the number of partials that recover a signature: `n - f` with
  `f = N3f1::max_faults(n)`; the dealers' polynomials have degree `q - 1`. For four members,
  `q = 3` and `f = 1`.
- `dkg::feldman_desmedt` does not fix the qualified set before key-dependent values are
  revealed: each dealer's commitment polynomial, whose constant term is its contribution to the
  group key, goes out in the first round, and the dealers whose logs count are chosen when the
  logs are finalized. Commonware's own documentation names the consequence (`feldman_desmedt`,
  "Non-Uniform Distribution"): a bias of `O(lg N)` bits in the key, harmless for signing.

## Command line

```bash
bls-committee dkg --members 4 --out bls                         # public.json, sharing.bin, member-<i>.share
bls-committee sign --dir bls --signers 0,1,2 --chain-id 8141 --request 0x... --ciphertext result.bin --value 42 --out signed.json
bls-committee sign ... --ignore-lock 0                          # member 0 signs regardless of its lock
bls-committee sign-below --dir bls --signers 0,1 ... --out below.json
bls-committee forge --dir bls --signers 3 ... --out forge.json
bls-committee verify --dir bls --signed signed.json
```
