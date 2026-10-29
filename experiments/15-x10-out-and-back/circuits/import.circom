pragma circom 2.1.0;

// Experiment 15's import, for R0 only: the claim of a receipt the AMM registered.
//
// The export committed to `partial` = H(tag, inner), and the AMM registered a receipt for `value`
// of `tag` against it. The claim proves that `newCommitment` = H(tag, inner, value) for the same
// `inner`, without showing it, so only whoever made the partial note can claim the receipt.

include "common.circom";

template Import() {
    signal input partial;
    signal input tag;
    signal input value;
    signal input newCommitment;

    signal input inner;

    component p = Hash(2);
    p.in[0] <== tag;
    p.in[1] <== inner;
    partial === p.out;

    component note = Hash(3);
    note.in[0] <== tag;
    note.in[1] <== inner;
    note.in[2] <== value;
    newCommitment === note.out;
}

component main {public [partial, tag, value, newCommitment]} = Import();
