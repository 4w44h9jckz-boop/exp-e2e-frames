pragma circom 2.1.0;

// What every circuit of experiment 15 shares, as exp-frames experiment 32's kernel.circom has it:
// H is circomlib's MiMCSponge with 220 rounds and key 0, as in Tornado Cash, so the tree is
// Tornado's height-20 MiMC tree and experiment 06's deployed hasher computes the same function.

include "circomlib/circuits/mimcsponge.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";

template Hash(n) {
    signal input in[n];
    signal output out;
    component h = MiMCSponge(n, 220, 1);
    for (var i = 0; i < n; i++) { h.ins[i] <== in[i]; }
    h.k <== 0;
    out <== h.outs[0];
}

// Tornado Cash's MerkleTreeChecker, with the root as an output.
template DualMux() {
    signal input in[2];
    signal input s;
    signal output out[2];
    s * (1 - s) === 0;
    out[0] <== (in[1] - in[0]) * s + in[0];
    out[1] <== (in[0] - in[1]) * s + in[1];
}

template MerkleRoot(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output root;
    component selectors[levels];
    component hashers[levels];
    for (var i = 0; i < levels; i++) {
        selectors[i] = DualMux();
        if (i == 0) {
            selectors[i].in[0] <== leaf;
        } else {
            selectors[i].in[0] <== hashers[i - 1].out;
        }
        selectors[i].in[1] <== pathElements[i];
        selectors[i].s <== pathIndices[i];
        hashers[i] = Hash(2);
        hashers[i].in[0] <== selectors[i].out[0];
        hashers[i].in[1] <== selectors[i].out[1];
    }
    root <== hashers[levels - 1].out;
}

// A note of `tag` worth `state`, owned by whoever knows the secrets, in the tree under `root`;
// and its nullifier H(tag, nullifierSecret), so the same secrets give unrelated nullifiers for
// two assets.
template OwnedNote(levels) {
    signal input root;
    signal input tag;
    signal input state;
    signal input nullifierSecret;
    signal input secret;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output nullifier;

    component inner = Hash(2);
    inner.in[0] <== nullifierSecret;
    inner.in[1] <== secret;
    component leaf = Hash(3);
    leaf.in[0] <== tag;
    leaf.in[1] <== inner.out;
    leaf.in[2] <== state;
    component tree = MerkleRoot(levels);
    tree.leaf <== leaf.out;
    for (var i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }
    root === tree.root;

    component n = Hash(2);
    n.in[0] <== tag;
    n.in[1] <== nullifierSecret;
    nullifier <== n.out;
}

// `commitment` is either 0 or H(tag, inner, value).
template OptionalNote() {
    signal input commitment;
    signal input tag;
    signal input inner;
    signal input value;
    signal output none;
    component note = Hash(3);
    note.in[0] <== tag;
    note.in[1] <== inner;
    note.in[2] <== value;
    component z = IsZero();
    z.in <== commitment;
    (commitment - note.out) * (1 - z.out) === 0;
    none <== z.out;
}
