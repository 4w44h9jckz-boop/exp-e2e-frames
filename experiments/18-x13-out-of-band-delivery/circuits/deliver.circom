pragma circom 2.1.0;

// Experiment 18 (X13): one spend of a note that commits to its delivery, on the owner branch or
// the refund branch, without saying which.
//
//   owner = H(pkR, d)                       the recipient's key and its floor
//   c     = H(value, owner, n, s, h, T, refund)
//   leaf  = H(c, t0)                        inserted by the registry, t0 its block time
//   nullifier = H(n)                        one per note, for both branches
//   outCommitment = H(value, outInner)      the spender's fresh note
//
// owner branch:  H(sk) == pkR
// refund branch: H(sk) == refund, and T <= tNow, and t0 + d <= T
//
// H is circomlib's MiMCSponge, as experiment 15's tree and experiment 06's deployed hasher.
// Times are seconds, range-checked to 40 bits, so the 41-bit comparisons cannot wrap.

// Compiled with -l experiments/15-x10-out-and-back/circuits, from the repository root.
include "common.circom";

template Deliver(levels) {
    signal input root;
    signal input nullifier;
    signal input tNow;
    signal input outCommitment;

    signal input value;
    signal input pkR;
    signal input d;
    signal input n;
    signal input s;
    signal input h;
    signal input T;
    signal input refund;
    signal input t0;
    signal input branch;
    signal input sk;
    signal input outInner;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    component valueBits = Num2Bits(64);
    valueBits.in <== value;
    component tBits[4];
    for (var i = 0; i < 4; i++) {
        tBits[i] = Num2Bits(40);
    }
    tBits[0].in <== tNow;
    tBits[1].in <== d;
    tBits[2].in <== T;
    tBits[3].in <== t0;

    component owner = Hash(2);
    owner.in[0] <== pkR;
    owner.in[1] <== d;
    component c = Hash(7);
    c.in[0] <== value;
    c.in[1] <== owner.out;
    c.in[2] <== n;
    c.in[3] <== s;
    c.in[4] <== h;
    c.in[5] <== T;
    c.in[6] <== refund;
    component leaf = Hash(2);
    leaf.in[0] <== c.out;
    leaf.in[1] <== t0;
    component tree = MerkleRoot(levels);
    tree.leaf <== leaf.out;
    for (var i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }
    root === tree.root;

    component nf = Hash(1);
    nf.in[0] <== n;
    nullifier === nf.out;

    branch * (1 - branch) === 0;
    component spender = Hash(1);
    spender.in[0] <== sk;
    (spender.out - pkR) * (1 - branch) === 0;
    (spender.out - refund) * branch === 0;

    component late = LessEqThan(41);
    late.in[0] <== T;
    late.in[1] <== tNow;
    component floor = LessEqThan(41);
    floor.in[0] <== t0 + d;
    floor.in[1] <== T;
    (1 - late.out) * branch === 0;
    (1 - floor.out) * branch === 0;

    component out = Hash(2);
    out.in[0] <== value;
    out.in[1] <== outInner;
    outCommitment === out.out;
}

component main {public [root, nullifier, tNow, outCommitment]} = Deliver(20);
