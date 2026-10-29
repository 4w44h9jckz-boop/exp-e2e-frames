pragma circom 2.1.0;

// Experiment 15's batch: eight appended leaves into the tree, in the next aligned subtree.
//
// `startIndex` is a multiple of 8. Under `oldRoot`, the subtree of height 3 at position
// startIndex / 8 is empty, which is Tornado's zero subtree zeros(3); under `newRoot`, the same
// position holds the subtree of `leaves`, and every other node is the same. So the batch adds
// exactly these eight leaves, at these indices, and changes nothing else.

include "common.circom";

template Batch(levels, height) {
    var width = 1 << height;
    signal input oldRoot;
    signal input newRoot;
    signal input startIndex;
    signal input leaves[width];

    signal input pathElements[levels - height];

    // zeros(3) of Tornado's tree: zeros(0) = keccak256("tornado") mod p, zeros(i + 1) = H(zeros(i), zeros(i)).
    var EMPTY = 0x20121ee811489ff8d61f09fb89e313f14959a0f28bb428a20dba6b0b068b3bdb;

    // The subtree of the leaves.
    component h[width - 1];
    var k = 0;
    signal nodes[2 * width - 1];
    for (var i = 0; i < width; i++) { nodes[i] <== leaves[i]; }
    var below = 0;
    var above = width;
    for (var w = width; w > 1; w = w / 2) {
        for (var j = 0; j < w / 2; j++) {
            h[k] = Hash(2);
            h[k].in[0] <== nodes[below + 2 * j];
            h[k].in[1] <== nodes[below + 2 * j + 1];
            nodes[above + j] <== h[k].out;
            k++;
        }
        below = above;
        above = above + w / 2;
    }

    // The position, from the index: the low `height` bits are zero.
    component bits = Num2Bits(levels);
    bits.in <== startIndex;
    for (var i = 0; i < height; i++) { bits.out[i] === 0; }

    component before = MerkleRoot(levels - height);
    component after = MerkleRoot(levels - height);
    before.leaf <== EMPTY;
    after.leaf <== nodes[2 * width - 2];
    for (var i = 0; i < levels - height; i++) {
        before.pathElements[i] <== pathElements[i];
        after.pathElements[i] <== pathElements[i];
        before.pathIndices[i] <== bits.out[height + i];
        after.pathIndices[i] <== bits.out[height + i];
    }
    oldRoot === before.root;
    newRoot === after.root;
}

component main {public [oldRoot, newRoot, startIndex, leaves]} = Batch(20, 3);
