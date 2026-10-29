pragma circom 2.1.0;

// Experiment 15's kernel: one spend, for every configuration but the round.
//
// The proof shows that a note of `tag` worth `state` is in the tree under `root`, that
// `nullifier` is its nullifier, and that `amountOut` leaves it:
//   - the rest stays in `changeCommitment` = H(tag, newInner, state - amountOut), a note of the
//     same asset, or 0, allowed only when nothing is left;
//   - `refundCommitment` = H(tag, refundInner, amountOut) is the note the registry adds instead
//     if `amountOut` goes to an export that fails, or 0 for a plain payout.
// `binding` is what the registry binds to the proof: how `amountOut` leaves (a payout or an
// export, its recipient or destination, the fee, and for an export the partial note and the
// minimum output). It is a public input the circuit does not use, as Tornado Cash binds its
// recipient and fee.

include "common.circom";

template Kernel(levels) {
    signal input root;
    signal input nullifier;
    signal input tag;
    signal input amountOut;
    signal input changeCommitment;
    signal input refundCommitment;
    signal input binding;

    signal input nullifierSecret;
    signal input secret;
    signal input state;
    signal input newInner;
    signal input refundInner;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    component note = OwnedNote(levels);
    note.root <== root;
    note.tag <== tag;
    note.state <== state;
    note.nullifierSecret <== nullifierSecret;
    note.secret <== secret;
    for (var i = 0; i < levels; i++) {
        note.pathElements[i] <== pathElements[i];
        note.pathIndices[i] <== pathIndices[i];
    }
    nullifier === note.nullifier;

    // 64-bit values throughout, so the subtraction cannot wrap.
    component stateBits = Num2Bits(64);
    stateBits.in <== state;
    component outBits = Num2Bits(64);
    outBits.in <== amountOut;
    signal newState <== state - amountOut;
    component newStateBits = Num2Bits(64);
    newStateBits.in <== newState;

    component change = OptionalNote();
    change.commitment <== changeCommitment;
    change.tag <== tag;
    change.inner <== newInner;
    change.value <== newState;
    newState * change.none === 0;

    component refund = OptionalNote();
    refund.commitment <== refundCommitment;
    refund.tag <== tag;
    refund.inner <== refundInner;
    refund.value <== amountOut;

    signal bindingSquare <== binding * binding;
}

component main {public [root, nullifier, tag, amountOut, changeCommitment, refundCommitment, binding]} = Kernel(20);
