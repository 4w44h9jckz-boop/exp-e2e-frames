pragma circom 2.1.0;

// Experiment 15's round: four owners each spend one note of `denomination`, together.
//
// One proof shows four notes of `tag` worth `denomination` in the tree under `root`, and their
// four nullifiers. A committee proves it from the owners' secret-shared witnesses, so the
// committee, not the owner, chooses every public input. So each owner's output is fixed by the
// owner's own secret, not by the committee:
//   - the partial note the AMM's call-back completes has inner H(secret, 1);
//   - the refund note, added instead if the round's export fails, is H(tag, H(secret, 2), denomination).
// Whoever knows `secret` can spend both later (nullifier secret = secret, secret = 1 or 2), and
// the committee cannot point them anywhere else. `binding` carries the round's destination, fee,
// output asset and minimum output.
//
// Each owner's private inputs have names of their own (m0_..., m1_..., ...), so that each owner
// secret-shares only its own fields and co-circom's merge-input-shares joins the four.

include "common.circom";

template Member(levels) {
    signal input root;
    signal input tag;
    signal input denomination;
    signal input nullifier;
    signal input partialInner;
    signal input refundCommitment;
    signal input nullifierSecret;
    signal input secret;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    component note = OwnedNote(levels);
    note.root <== root;
    note.tag <== tag;
    note.state <== denomination;
    note.nullifierSecret <== nullifierSecret;
    note.secret <== secret;
    for (var i = 0; i < levels; i++) {
        note.pathElements[i] <== pathElements[i];
        note.pathIndices[i] <== pathIndices[i];
    }
    nullifier === note.nullifier;

    component partial = Hash(2);
    partial.in[0] <== secret;
    partial.in[1] <== 1;
    partialInner === partial.out;

    component refundInner = Hash(2);
    refundInner.in[0] <== secret;
    refundInner.in[1] <== 2;
    component refund = Hash(3);
    refund.in[0] <== tag;
    refund.in[1] <== refundInner.out;
    refund.in[2] <== denomination;
    refundCommitment === refund.out;
}

template Round4(levels) {
    signal input root;
    signal input denomination;
    signal input tag;
    signal input nullifier[4];
    signal input partialInner[4];
    signal input refundCommitment[4];
    signal input binding;

    signal input m0_nullifierSecret;
    signal input m0_secret;
    signal input m0_pathElements[levels];
    signal input m0_pathIndices[levels];
    signal input m1_nullifierSecret;
    signal input m1_secret;
    signal input m1_pathElements[levels];
    signal input m1_pathIndices[levels];
    signal input m2_nullifierSecret;
    signal input m2_secret;
    signal input m2_pathElements[levels];
    signal input m2_pathIndices[levels];
    signal input m3_nullifierSecret;
    signal input m3_secret;
    signal input m3_pathElements[levels];
    signal input m3_pathIndices[levels];

    component m[4];
    for (var k = 0; k < 4; k++) {
        m[k] = Member(levels);
        m[k].root <== root;
        m[k].tag <== tag;
        m[k].denomination <== denomination;
        m[k].nullifier <== nullifier[k];
        m[k].partialInner <== partialInner[k];
        m[k].refundCommitment <== refundCommitment[k];
    }
    m[0].nullifierSecret <== m0_nullifierSecret;
    m[0].secret <== m0_secret;
    m[1].nullifierSecret <== m1_nullifierSecret;
    m[1].secret <== m1_secret;
    m[2].nullifierSecret <== m2_nullifierSecret;
    m[2].secret <== m2_secret;
    m[3].nullifierSecret <== m3_nullifierSecret;
    m[3].secret <== m3_secret;
    for (var i = 0; i < levels; i++) {
        m[0].pathElements[i] <== m0_pathElements[i];
        m[0].pathIndices[i] <== m0_pathIndices[i];
        m[1].pathElements[i] <== m1_pathElements[i];
        m[1].pathIndices[i] <== m1_pathIndices[i];
        m[2].pathElements[i] <== m2_pathElements[i];
        m[2].pathIndices[i] <== m2_pathIndices[i];
        m[3].pathElements[i] <== m3_pathElements[i];
        m[3].pathIndices[i] <== m3_pathIndices[i];
    }

    signal bindingSquare <== binding * binding;
}

component main {public [root, denomination, tag, nullifier, partialInner, refundCommitment, binding]} = Round4(20);
