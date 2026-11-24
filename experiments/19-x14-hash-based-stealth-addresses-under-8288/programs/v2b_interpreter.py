# Experiment 19 (X14), version 2b (Amendment 3): one fixed program that interprets a committed rule.
#
# A rule is a threshold t and three slots, each empty (type 0), a leanSPHINCS key (type 1, its two
# cells) or a preimage key (type 2, the two cells of H(k, TAG_KEY), version 1's K). It is committed
#   K = H(H(H(g^t, type 0, type 1, type 2), H(value 0, value 1)), value 2),
# and C = H(K, r). A spend proves that exactly t slots are satisfied, a key's by its signature on m
# and a preimage key's by its k, and publishes D = H(H(C, m), T) with T = H(H(r, K), m), versions 1
# and 2a's shape, so the account is the same stub under this program's key. The rule, the keys,
# the preimages, r, m and the signatures are private; which slots signed is too. H is the leanVM
# hash, Keccak-256 over the cells' bytes.
#
# The signatures are checked by leanVM's own in-circuit verifier, lifted below by lift.py; only
# main is this experiment's.
# public_input: the two cells of D
from snark_lib import *

# ---- LIFTED: begin (lift.py: leanVM 3cbac04, crates/rec_aggregation/guests/lean_ethereum.py,
# MIT or Apache-2.0, copyright 2026 leanEthereum; verbatim, with its placeholders filled
# by leanVM's own host)
BASE_FIELD_BITS = 64
Y_INV = f192(1,0,1)
# Every hash is Keccak-256 (primitives::hash::hash): a block is 136 bytes, eight and a
# half cells, XORed into the previous KECCAK_STATE-cell sponge state before a KECCAK,
# and the last output's first two cells are the digest. A hash of runtime length
# carries that state through a heap run between loop frames, KECCAK_STATE cells a
# step (`claim_list_digest`).
KECCAK_STATE = 13
# Both schemes' one-time keys: chains of CHAIN_LENGTH positions, whose digits are
# dispatched DIGIT_GROUP at a time, the last chain alone, and the address, a cell
# whose low lane is lo:32 | hi:24 | type:5 | step:3 and whose high lane is a
# leanSPHINCS hypertree address's layer:8 | tree:32, zero otherwise. TW_* hold the
# type. Every 16-byte native value is one canonical cell.
W = 2
CHAIN_LENGTH = 2 ** W
CHAIN_STEPS = CHAIN_LENGTH - 1
DIGIT_GROUP = 3
DIGIT_GROUPS = CHAIN_LENGTH ** DIGIT_GROUP
# The digit sum of group k, at k.
DIGIT_SUMS = [0, 1, 2, 3, 1, 2, 3, 4, 2, 3, 4, 5, 3, 4, 5, 6, 1, 2, 3, 4, 2, 3, 4, 5, 3, 4, 5, 6, 4, 5, 6, 7, 2, 3, 4, 5, 3, 4, 5, 6, 4, 5, 6, 7, 5, 6, 7, 8, 3, 4, 5, 6, 4, 5, 6, 7, 5, 6, 7, 8, 6, 7, 8, 9]
TW_CHAIN = 72057594037927936
TW_LEAF = 144115188075855872
TW_NODE = 216172782113783808
TW_MSG = 864691128455135232
HI_MUL = 2 ** 32
STEP_MUL = 2 ** 61
# The scheme's own letters, prefixed SP_: under each bottom leaf a FORS instance of
# SP_FORS_TREES trees of height SP_FORS_HEIGHT, and above them three layers of trees
# over WOTS+C keys of SP_V chains, of heights SP_HEIGHT_0, SP_HEIGHT_1 and SP_HEIGHT_2
# from the bottom.
SP_V = 64
SP_TARGET_SUM = 128
SP_HEIGHT_0 = 8
SP_HEIGHT_1 = 8
SP_HEIGHT_2 = 10
SP_H = SP_HEIGHT_0 + SP_HEIGHT_1 + SP_HEIGHT_2
SP_FORS_TREES = 24
SP_FORS_HEIGHT = 10
# The message digest's fields are one little-endian bit string over its two calls'
# outputs: the index, then each FORS tree's leaf. The first call's two cells are all
# fields; the second call's first cell starts with SP_TAIL_BITS bits of them, its low
# lane's other bits unused.
SP_CELL_BITS = 2 * BASE_FIELD_BITS
SP_DIGEST_BITS = SP_H + SP_FORS_TREES * SP_FORS_HEIGHT
SP_TAIL_BITS = SP_DIGEST_BITS - 2 * SP_CELL_BITS
SP_UNUSED_BITS = BASE_FIELD_BITS - SP_TAIL_BITS
# The hash types of its own.
SP_TW_ENC = 288230376151711744
SP_TW_FLEAF = 1080863910568919040
SP_TW_FNODE = 1224979098644774912
# A FORS address's hi is tree + 64 position: a leaf, or level + 16 j for node j. The
# shifts place a leaf and a node index in the address's low lane.
SP_FLEAF_SHIFT = 32 + 6
SP_FNODE_SHIFT = 32 + 10
# A hypertree address holds its layer and tree in its high lane: the layer in the low
# byte, the tree above it.
SP_LAYER_MUL = 2 ** 64
SP_TREE_MUL = 2 ** 72
# Values bounded a byte at a time: each byte hinted in the exponent, range checked,
# and read as the bits it spells off a table of the SP_BYTE_VALUES bytes.
SP_BYTE_VALUES = 256
# The encoding counter, LE_32 in the low four bytes of its lane: bounded by
# rebuilding it from exactly that many bytes, so the guest accepts no preimage the
# native verifier cannot parse.
SP_COUNTER_BYTES = 4
# The bottom encoding's input: P, A, the FORS key's two top nodes per tree, then the
# counter; a higher layer's: P, A, the root below, then the counter.
SP_ENCODING_BYTES = 16 * (2 + 2 * SP_FORS_TREES) + SP_COUNTER_BYTES
SP_ROOT_ENCODING_BYTES = 16 * 3 + SP_COUNTER_BYTES
# The unused bits, likewise: a byte at a time, the last one holding the rest.
SP_UNUSED_BYTES = (SP_UNUSED_BITS + 7) // 8
SP_UNUSED_TOP = 2 ** (SP_UNUSED_BITS - 8 * (SP_UNUSED_BYTES - 1))


@inline
def is_child(node, kids, k: Const, bit):
    # A node is not ordered against its sibling: the two children are hinted in
    # order, at kids[k] and kids[k + 1], and `node` is checked to be the one `bit`
    # names, the left one at 0, the right one at 1. One product, stored where the
    # left child's difference already is, which is the assert.
    check = StackBuf(1)
    check[0] = node + kids[k]
    check[0] = bit * (kids[k] + kids[k + 1])
    return


@inline
def chain_tip(walks, i: Const):
    # Chain i's tip, in the last of its CHAIN_STEPS slots of `walks`.
    tip = walks[((i + 1) * CHAIN_STEPS - 1) * KECCAK_STATE]
    return tip


@inline
def walk(at, pp, walks, tags, i: Const, k: Const, lx: Const):
    # Walk chain i from position k to its end, the step leaving position s landing in
    # chain i's slot s of `walks`, so the tip is chain_tip(walks, i) whatever k is. A
    # leanSPHINCS step's address carries i and s, its input ending after the value; a
    # leanXMSS one only s, at[s] computed once per key, i riding after the value, read
    # off `tags` so a dispatch arm names it rather than setting it again.
    if const(k == CHAIN_STEPS):
        hint_witness(walks[((i + 1) * CHAIN_STEPS - 1) * KECCAK_STATE:((i + 1) * CHAIN_STEPS - 1) * KECCAK_STATE + 1], "chain_starts")
    else:
        value = hint_witness("chain_starts")
        for s in unroll(k, CHAIN_STEPS):
            o = (CHAIN_STEPS * i + s) * KECCAK_STATE
            if const(lx == 1):
                keccak([pp, at[s]], [value, tags[i]], walks[o:o + KECCAK_STATE])
            else:
                keccak([pp, at + const(TW_CHAIN + i * HI_MUL + s * STEP_MUL)], [value, 0], walks[o:o + KECCAK_STATE], len=48)
            value = walks[o]
    return


@inline
def walk_group(at, pp, walks, tags, first: Const, n: Const, k: Const, lx: Const, powers, product, encoded):
    # The n <= DIGIT_GROUP chains from `first` on, at the digits of k, one
    # dispatch for all of them. Folds the digits' sum into `product`, in the
    # exponent (`powers[s]` is GEN ** s), and the digits into `encoded`, where the
    # encoding digest holds them.
    for r in unroll(0, n):
        walk(at, pp, walks, tags, first + r, (k // CHAIN_LENGTH ** r) % CHAIN_LENGTH, lx)
    return product * powers[DIGIT_SUMS[k]], encoded + const(k * CHAIN_LENGTH ** first)


@inline
def leaf_word(p0, p1, walks, j: Const):
    # Word j of a one-time leaf's input: the prefix (p0, p1), then the chain tips.
    w = p0
    if const(j == 1):
        w = p1
    if const(j != 0):
        if const(j != 1):
            w = chain_tip(walks, j - 2)
    return w


@inline
def wots_leaf(p0, p1, walks, n: Const, leaf):
    # The hash of the prefix (p0, p1) and the n chain tips, each read where its walk left it.
    keccak_cells([leaf_word(p0, p1, walks, j) for j in unroll(0, n + 2)], leaf)
    return


@inline
def sp_from_bytes(byte_bits, marks, n: Const, top: Const):
    # The integer whose n bytes, low first, are hinted in the exponent at marks[k]:
    # each range checked (the top one below `top`, SP_BYTE_VALUES or SP_UNUSED_TOP)
    # and read off `byte_bits` as the bits it spells, so the integer is below
    # top * 2^(8 (n - 1)).
    for t in unroll(0, n):
        k = n - 1 - t
        if const(t == 0):
            if const(top == SP_BYTE_VALUES):
                assert log(marks[k]) < SP_BYTE_VALUES
            else:
                assert log(marks[k]) < SP_UNUSED_TOP
            value = byte_bits[marks[k]]
        else:
            assert log(marks[k]) < SP_BYTE_VALUES
            value = byte_bits[marks[k]] + value * GEN ** 8
    return value


@inline
def sp_bit(bits0, bits1, bits2, i: Const):
    # Bit i of the digest's fields, from the bit runs of the three cells holding them.
    b = bits0[i % SP_CELL_BITS]
    if const(i // SP_CELL_BITS == 1):
        b = bits1[i - SP_CELL_BITS]
    if const(i // SP_CELL_BITS == 2):
        b = bits2[i - 2 * SP_CELL_BITS]
    return b


@inline
def sp_shifts(bits0, bits1, bits2, vals, off: Const, n: Const):
    # The field of n bits from bit `off` and its right shifts: vals[off + l] is the
    # field shifted by l, its value at l = 0 and the node indices above a leaf after.
    vals[off + n - 1] = sp_bit(bits0, bits1, bits2, off + n - 1)
    for r in unroll(1, n):
        vals[off + n - 1 - r] = sp_bit(bits0, bits1, bits2, off + n - 1 - r) + GEN * vals[off + n - r]
    return


@inline
def sp_place(lane, vals, lanes, off: Const, n: Const):
    # Places the field of n bits from bit `off`, whose value and shifts are in `vals`,
    # into the 64-bit lane being rebuilt, and returns that lane. A lane the field
    # completes is stored in lanes; a field across two lanes gives the first its low
    # bits and starts the next with the rest.
    if const((off + n - 1) // BASE_FIELD_BITS == off // BASE_FIELD_BITS):
        if const(off % BASE_FIELD_BITS == 0):
            lane = vals[off]
        else:
            lane = lane + vals[off] * GEN ** (off % BASE_FIELD_BITS)
        if const((off + n) % BASE_FIELD_BITS == 0):
            lanes[off // BASE_FIELD_BITS] = lane
    else:
        low = vals[off] + vals[off + BASE_FIELD_BITS - off % BASE_FIELD_BITS] * GEN ** (BASE_FIELD_BITS - off % BASE_FIELD_BITS)
        lanes[off // BASE_FIELD_BITS] = lane + low * GEN ** (off % BASE_FIELD_BITS)
        lane = vals[off + BASE_FIELD_BITS - off % BASE_FIELD_BITS]
    return lane


@inline
def sp_fors_tree(pp, idx, bits0, bits1, bits2, vals, fkey, c: Const):
    # FORS tree c of instance idx: its leaf, the field from bit SP_H + SP_FORS_HEIGHT c,
    # hashed from its hinted secret, then climbed up the hinted ordered pairs to the
    # level below the top, whose two nodes, the tree's part of the FORS key, are
    # hinted into fkey[2 + 2c] for the encoding to absorb.
    secret = hint_witness("sp_fors_secrets")
    held = StackBuf(KECCAK_STATE)
    keccak([pp, idx + const(SP_TW_FLEAF + c * HI_MUL) + vals[SP_H + SP_FORS_HEIGHT * c] * GEN ** SP_FLEAF_SHIFT], [secret, 0], held, len=48)
    cur = held[0]
    # The tree's node address before its level and index, so what a level adds is one
    # constant every tree shares.
    base = idx + const(SP_TW_FNODE + c * HI_MUL)
    for level in unroll(0, SP_FORS_HEIGHT - 1):
        kids = StackBuf(2)
        hint_witness(kids, "sp_fors_nodes")
        is_child(cur, kids, 0, sp_bit(bits0, bits1, bits2, SP_H + SP_FORS_HEIGHT * c + level))
        parent = StackBuf(KECCAK_STATE)
        keccak([pp, base + const(64 * (level + 1) * HI_MUL) + vals[SP_H + SP_FORS_HEIGHT * c + level + 1] * GEN ** SP_FNODE_SHIFT], kids, parent)
        cur = parent[0]
    hint_witness(fkey[2 + 2 * c:4 + 2 * c], "sp_fors_nodes")
    is_child(cur, fkey, 2 + 2 * c, sp_bit(bits0, bits1, bits2, SP_H + SP_FORS_HEIGHT * c + SP_FORS_HEIGHT - 1))
    return


def sp_wots(pp, at, encoding):
    # The leaf of the one-time key at address `at` (its leaf, layer and tree) whose
    # encoding digest is `encoding`. The codeword: DIGIT_GROUP digits at a time,
    # hinted in the exponent, range checked and dispatched once, the arm walking
    # every chain's remaining steps and folding its digits in: their sums into a
    # product that must be the target sum, and the digits, each group where the
    # digest holds it, into the digest. One function for the three layers.
    walks = StackBuf(SP_V * CHAIN_STEPS * KECCAK_STATE)
    powers = StackBuf(DIGIT_GROUP * CHAIN_STEPS + 1)
    for s in unroll(0, DIGIT_GROUP * CHAIN_STEPS + 1):
        powers[s] = GEN ** s
    digit_product = 1
    encoded = 0
    # A leanSPHINCS chain index rides its step's address, so the chain-index table a
    # leanXMSS walk reads is unused here and `powers` stands in for it.
    for p in unroll(0, SP_V // DIGIT_GROUP):
        group = hint_witness("digits")
        assert log(group) < DIGIT_GROUPS
        digit_product, encoded = match(log(group), range(0, DIGIT_GROUPS), lambda k: walk_group(at, pp, walks, powers, DIGIT_GROUP * p, DIGIT_GROUP, k, 0, powers, digit_product, encoded))
    # The chain the groups leave over.
    group = hint_witness("digits")
    assert log(group) < CHAIN_LENGTH
    digit_product, encoded = match(log(group), range(0, CHAIN_LENGTH), lambda k: walk_group(at, pp, walks, powers, SP_V - 1, 1, k, 0, powers, digit_product, encoded))
    assert encoded == encoding
    assert digit_product == GEN ** SP_TARGET_SUM
    leaf = StackBuf(KECCAK_STATE)
    wots_leaf(pp, at + TW_LEAF, walks, SP_V, leaf)
    return leaf[0]


@inline
def sp_path(node, pp, bits, vals, out, off: Const, height: Const, lane):
    # merkle_path in one tree of the hypertree, whose leaf index is the field from
    # bit `off` of the digest's first cell: every address adds `lane`, the tree's
    # layer and tree as an address's high lane holds them, and the root is at index
    # 0. Not merkle_path itself, where a runtime lane would cost leanXMSS XORs.
    cur = node
    for level in unroll(0, height):
        kids = StackBuf(2)
        hint_witness(kids, "siblings")
        is_child(cur, kids, 0, bits[off + level])
        if const(level + 1 == height):
            parent = out
            keccak([pp, lane + const(TW_NODE + (level + 1) * HI_MUL)], kids, parent)
        else:
            parent = StackBuf(KECCAK_STATE)
            keccak([pp, lane + const(TW_NODE + (level + 1) * HI_MUL) + vals[off + level + 1]], kids, parent)
        cur = parent[0]
    return


@inline
def sp_upper_layer(pp, at, below, byte_bits, bits, vals, out, off: Const, height: Const, lane):
    # A layer above the bottom: the key at `at` signs the root below, its counter
    # rebuilt from four bytes, then the path to its tree's root into out.
    ctr = StackBuf(SP_COUNTER_BYTES)
    hint_witness(ctr, "sp_counter")
    counter = sp_from_bytes(byte_bits, ctr, SP_COUNTER_BYTES, SP_BYTE_VALUES)
    enc = StackBuf(KECCAK_STATE)
    keccak([pp, at + SP_TW_ENC], [below, counter], enc, len=SP_ROOT_ENCODING_BYTES)
    leaf = sp_wots(pp, at, enc[0])
    sp_path(leaf, pp, bits, vals, out, off, height, lane)
    return


def verify_sig_lean_sphincs(signer, byte_bits):
    # `signer` is one 4-cell entry of the leanSPHINCS coverage table: the pubkey's root and
    # public parameter, then the message THAT signer signed, the two bound together
    # by the scheme's claim-list digest, as for leanXMSS.
    pp = signer[GEN]

    # ---- the message digest, which picks the index and every FORS leaf ----
    # D_c = H(P | A_msg(c) | m | R), 80 bytes in one block, for c = 0, 1.
    rho = hint_witness("sp_rand")
    d0 = StackBuf(KECCAK_STATE)
    d1 = StackBuf(KECCAK_STATE)
    keccak([pp, TW_MSG], [signer[GEN ** 2], signer[GEN ** 3]], d0, tail=[rho, 0, 0, 0], len=80)
    keccak([pp, TW_MSG + const(HI_MUL)], [signer[GEN ** 2], signer[GEN ** 3]], d1, tail=[rho, 0, 0, 0], len=80)

    # The fields' bits are advice pinned Boolean, and the digest is rebuilt from them:
    # lane by lane from the fields' values, which their shifts give, and the unused
    # bits after the last field as hinted bytes (sp_from_bytes). The second call's
    # high lane is what the rest leaves, checked to be a lane.
    bits0 = StackBuf(SP_CELL_BITS)
    bits1 = StackBuf(SP_CELL_BITS)
    bits2 = StackBuf(SP_TAIL_BITS)
    hint_decompose_bits(bits0, d0[0], SP_CELL_BITS)
    hint_decompose_bits(bits1, d0[1], SP_CELL_BITS)
    hint_decompose_bits(bits2, d1[0], SP_TAIL_BITS)
    for b in unroll(0, SP_CELL_BITS):
        bits0[b] = bits0[b] * bits0[b]
        bits1[b] = bits1[b] * bits1[b]
    for b in unroll(0, SP_TAIL_BITS):
        bits2[b] = bits2[b] * bits2[b]
    vals = StackBuf(SP_DIGEST_BITS)
    sp_shifts(bits0, bits1, bits2, vals, 0, SP_HEIGHT_0)
    sp_shifts(bits0, bits1, bits2, vals, SP_HEIGHT_0, SP_HEIGHT_1)
    sp_shifts(bits0, bits1, bits2, vals, SP_HEIGHT_0 + SP_HEIGHT_1, SP_HEIGHT_2)
    for c in unroll(0, SP_FORS_TREES):
        sp_shifts(bits0, bits1, bits2, vals, SP_H + SP_FORS_HEIGHT * c, SP_FORS_HEIGHT)
    lanes = StackBuf(4)
    lane = sp_place(0, vals, lanes, 0, SP_HEIGHT_0)
    lane = sp_place(lane, vals, lanes, SP_HEIGHT_0, SP_HEIGHT_1)
    idx = sp_place(lane, vals, lanes, SP_HEIGHT_0 + SP_HEIGHT_1, SP_HEIGHT_2)
    lane = idx
    for c in unroll(0, SP_FORS_TREES):
        lane = sp_place(lane, vals, lanes, SP_H + SP_FORS_HEIGHT * c, SP_FORS_HEIGHT)
    d0[0] = lanes[0] + lanes[1] * const(2 ** 64)
    d0[1] = lanes[2] + lanes[3] * const(2 ** 64)
    unused_bytes = StackBuf(SP_UNUSED_BYTES)
    hint_witness(unused_bytes, "sp_unused")
    unused = sp_from_bytes(byte_bits, unused_bytes, SP_UNUSED_BYTES, SP_UNUSED_TOP)
    high = (d1[0] + lane + unused * GEN ** SP_TAIL_BITS) * Y_INV
    assert_in_k(high, unused)

    # ---- FORS: each tree's opening climbed to its two top nodes, the FORS key ----
    # The bottom encoding's input: P, A, the FORS key, which no hash folds, then the
    # counter.
    fkey = StackBuf(3 + 2 * SP_FORS_TREES)
    fkey[0] = pp
    for c in unroll(0, SP_FORS_TREES):
        sp_fors_tree(pp, idx, bits0, bits1, bits2, vals, fkey, c)

    # ---- the hypertree: each layer's one-time key signs what the layer below gives ----
    # A key's address holds its leaf in the low lane and its layer and tree in the
    # high one: the bottom tree is idx >> SP_HEIGHT_0, the middle one the top key's leaf.
    tree_b = vals[SP_HEIGHT_0] + vals[SP_HEIGHT_0 + SP_HEIGHT_1] * GEN ** SP_HEIGHT_1
    lane_b = tree_b * const(SP_TREE_MUL)
    lane_m = vals[SP_HEIGHT_0 + SP_HEIGHT_1] * const(SP_TREE_MUL) + const(SP_LAYER_MUL)
    lane_t = const(2 * SP_LAYER_MUL)
    at_b = vals[0] + lane_b
    at_m = vals[SP_HEIGHT_0] + lane_m
    at_t = vals[SP_HEIGHT_0 + SP_HEIGHT_1] + lane_t
    # D = Th(P, A_enc, M | LE_32(c)), M the FORS key at the bottom (804 bytes, six
    # blocks) and the root below above it (52 bytes, one block). Each counter is
    # rebuilt from its four bytes.
    fkey[1] = at_b + SP_TW_ENC
    ctr_b = StackBuf(SP_COUNTER_BYTES)
    hint_witness(ctr_b, "sp_counter")
    fkey[2 + 2 * SP_FORS_TREES] = sp_from_bytes(byte_bits, ctr_b, SP_COUNTER_BYTES, SP_BYTE_VALUES)
    enc_b = StackBuf(KECCAK_STATE)
    keccak_cells(fkey, enc_b, len=SP_ENCODING_BYTES)
    leaf = sp_wots(pp, at_b, enc_b[0])
    root_b = StackBuf(KECCAK_STATE)
    sp_path(leaf, pp, bits0, vals, root_b, 0, SP_HEIGHT_0, lane_b)

    root_m = StackBuf(KECCAK_STATE)
    sp_upper_layer(pp, at_m, root_b[0], byte_bits, bits0, vals, root_m, SP_HEIGHT_0, SP_HEIGHT_1, lane_m)
    root = StackBuf(KECCAK_STATE)
    sp_upper_layer(pp, at_t, root_m[0], byte_bits, bits0, vals, root, SP_HEIGHT_0 + SP_HEIGHT_1, SP_HEIGHT_2, lane_t)
    assert root[0] == signer[1]
    return
# ---- LIFTED: end


def main():
    t = hint_witness("t")
    types = StackBuf(3)
    hint_witness(types, "types")
    values = StackBuf(6)
    hint_witness(values, "values")
    use = StackBuf(3)
    hint_witness(use, "use")
    r = StackBuf(2)
    hint_witness(r, "r")
    m = StackBuf(2)
    hint_witness(m, "m")
    tag_key = StackBuf(2)
    tag_key[0] = 1
    tag_key[1] = 0

    byte_bits = HeapBuf(SP_BYTE_VALUES)
    for v in unroll(0, SP_BYTE_VALUES):
        byte_bits[GEN ** v] = v

    # Each slot the spend uses is satisfied; the used slots, counted in the exponent, are t. A use
    # flag is pinned Boolean, so its factor 1 + s (g + 1) is g when it is used and 1 when not.
    count = 1
    for i in unroll(0, 3):
        s = use[i]
        assert s * s == s
        count = count * (1 + s * (GEN + 1))
        if s == 1:
            if types[i] == 1:
                signer = HeapBuf(4)
                signer[1] = values[2 * i]
                signer[GEN] = values[2 * i + 1]
                signer[GEN ** 2] = m[0]
                signer[GEN ** 3] = m[1]
                verify_sig_lean_sphincs(signer, byte_bits)
            else:
                assert types[i] == 2
                k = StackBuf(2)
                hint_witness(k, "preimage")
                kv = StackBuf(2)
                keccak(k, tag_key, kv)
                assert kv[0] == values[2 * i]
                assert kv[1] == values[2 * i + 1]
    assert count == t

    a = StackBuf(2)
    keccak([t, types[0]], [types[1], types[2]], a)
    b = StackBuf(2)
    keccak(values[0:2], values[2:4], b)
    ab = StackBuf(2)
    keccak(a, b, ab)
    key = StackBuf(2)
    keccak(ab, values[4:6], key)
    c = StackBuf(2)
    keccak(key, r, c)
    rk = StackBuf(2)
    keccak(r, key, rk)
    tt = StackBuf(2)
    keccak(rk, m, tt)
    cm = StackBuf(2)
    keccak(c, m, cm)
    d = StackBuf(2)
    keccak(cm, tt, d)
    p = GEN ** 0
    p[1] = d[0]
    p[GEN] = d[1]
    return
