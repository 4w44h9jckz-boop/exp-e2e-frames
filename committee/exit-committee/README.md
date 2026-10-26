# exit-committee

The committee's side of experiment 14 (X9): the update it proves over shares, the openings it
publishes, and its signature on a reconciliation. The vault, the plan and the reasons for each
choice are in `experiments/14-x9-exit-without-permission/README.md`; this page fixes the formats.

## The formats (fixed)

| Item | Format |
|---|---|
| Sealing | exp-frames experiment 33's announcement scheme, version `0x02`: `shared = x(e P)` on secp256k1; `key, iv = HKDF-SHA256(ikm = shared, salt = E, info)`; `0x02 \|\| keccak256(shared)[0] \|\| E (33) \|\| AES-256-GCM(key, iv, plaintext, aad) \|\| tag (16)` |
| AAD | the vault's address (20) and a 64-bit big-endian number |
| Intent | sealed to the committee's key with info `x9/intent`, AAD number the intent's index; plaintext the owner's opening key (33, compressed) and `B(s)` (32, circomlib-packed): 116 bytes sealed |
| Opening | sealed to the owner's key with info `x9/opening`, AAD number the update's number (the intent's index); plaintext `n_j (31) \|\| member (1) \|\| leaf (u32 BE) \|\| update (u64 BE) \|\| 4 zero bytes`: 99 bytes sealed, three per update in member order |
| Parts | member `j`'s windows of the nullifier's 31 little-endian bytes, window `w` = bits `4w .. 4w + 3`: member 0 windows 0-20, member 1 21-41, member 2 42-61 |
| Commitment | `x(A(n_0) + A(n_1) + A(n_2) - 2 H(0 \|\| 0) + B(s))`, `A(x) = H(x \|\| 0)`, `B(s) = H(0 \|\| s) - H(0 \|\| 0)`, `H` circomlib's Pedersen hash as a Baby Jubjub point |
| Recipient | `uint160(keccak256(vault (32) \|\| keccak256(sealed intent) \|\| C \|\| keccak256(openings)))` |
| Reconcile | `chain_id (32) \|\| vault (32) \|\| escapeAt (32) \|\| keccak256(list)`, the list every redeemed nullifier hash ascending; a 3-of-3 BLS signature, MinSig, namespace `X9_RECONCILE_V1`; nonce key `keccak256("X9_RECONCILE" \|\| escapeAt (32))` |

`test/fixtures/x9/vectors.json` (`exit-committee vectors`) holds one of each with fake keys;
`test/x9.test.ts` opens and recomputes them in TypeScript.

## Command line

```bash
exit-committee keys --dir committee                       # the sealing key and the 3-of-3 BLS key
exit-committee initcode --dir committee --hex ExitVault.hex --salt 0x..
exit-committee open-intent --dir committee --member 0 --vault 0x.. --index 0 --sealed 0x..
exit-committee part --dir committee --member 0 --index 0  # prints A(n_0)
exit-committee commit --dir committee --index 0 --parts A0,A1,A2
exit-committee seal --dir committee --member 0 --vault 0x.. --index 0 --leaf 5
exit-committee recipient --vault 0x.. --sealed 0x.. --c 0x.. --openings 0x..
co-withdraw member --id 0 --share share-0.bin --peers .. --recipient 0x.. --out member-0.json
exit-committee update-data --proof 0x.. --root 0x.. --nullifier-hash 0x.. --c 0x.. --openings 0x..
exit-committee reconcile --dir committee --chain-id 8141 --vault 0x.. --escape-at N --nullifier-hashes 0x..,0x..
exit-committee steal --dir committee --index 0 --leaves 0x..,0x.. --to 0x..
```

Each member's secrets (the sealing key, its BLS share, the intents it opened, its parts) are
written under `committee/member-<j>/`, readable by their owner only, and never printed. Every
command prints only public values. `steal` reads all three members' directories at once, as the
eighth condition asks: everything the members hold, together.
