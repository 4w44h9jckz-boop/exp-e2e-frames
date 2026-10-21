# Superseded attempts

Kept as they came out; `npm test` does not read this folder. Each was refused somewhere by the
harness's own parameters, not by the node's budget or the claim's checks:

- `1-first-run.json` (from `def840e`): every paymaster took the ticket's 0.001 ETH denomination
  and refuses a transaction whose max cost exceeds it. The accountable form's keys, carried as
  data, cost more than that from 64 members on, so it was refused at 64, 128 and 256.
- `2-denomination.json` (from `3c0f046`): 0.01 ETH. The accountable form was mined at every
  size in aggregate mode, 322,587 gas at 256. At 256 the individual mode was refused because its
  declared limit, a fit to the first run's gas plus 10%, put the prefix over the node's 500,000;
  the check it needs is below that.

The ECDSA control at 256 was refused in both for its budget: it needs about 3,514 gas a
signature, about 600,000 for 171 signers, which no declaration fits under 500,000.
