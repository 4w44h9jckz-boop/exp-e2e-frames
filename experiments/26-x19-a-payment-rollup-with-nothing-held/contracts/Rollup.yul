// Experiment 26 (X19): the rollup. It holds the root of a depth-20 Keccak tree of channel leaves and
// is the sender and payer of every transaction that touches it, approving each in its own VERIFY,
// as experiment 24's PoolSelf is. No account sends from a key: a channel's members appear only as
// leanSPHINCS dependencies, and a user's proof only as a leanSTARK one.
//
// A leaf is H(kh, c), with kh = H(key0, key1, recipient) and c = H(B(balance), salt); H is
// keccak256 over 32-byte words and B(x) is x in the word's first eight bytes, little-endian. The
// user's program (programs/x19_transfer.py) publishes D = H(H(oldLeaf, newLeaf), T) with
//   T = H(H(H(chan, c1), H(to, A)), H(H(B(fee), expiry), nullifier)),
// and every word of it is recomputed here from calldata.
//
// Transactions, each its own layout, and nothing else is approved:
//   apply   [0] VERIFY  [1] DEP: (0x10, T, key0) (0x10, T, key1) (0x11, D, VK)  [2] SENDER apply
//           nonce key: the nullifier
//   queue   [0] VERIFY  [1] DEP: (0x10, T, key0) (0x10, T, key1)                [2] SENDER queue
//           nonce key: keccak256("x19/queue" || nullifier)
//   freeze  [0] VERIFY  [1] DEP: (0x10, F, key)                                  [2] SENDER freeze
//           nonce key: keccak256("x19/freeze" || chan); F = keccak256("x19/freeze" || rollup || chan)
//   claim   [0] VERIFY  [1] DEP: (0x10, C, key)                                  [2] SENDER claim
//           nonce key: keccak256("x19/claim" || chan); C = keccak256("x19/claim" || rollup || chan
//           || takerTo || takerFee)
//   backup  [0] VERIFY  [1] DEP: (0x10, V, key)                                  [2] SENDER backup
//           one blob; V its versioned hash; nonce key: keccak256("x19/backup" || chan || block)
// where key is either member's, named by `which`. Every SENDER frame's data starts with the same
// head, so VERIFY reads the same offsets:
//   0x04 key0  0x24 key1  0x44 recipient  0x64 chan  0x84 which
// apply and queue go on with
//   0xa4 c0  0xc4 c1  0xe4 to  0x104 amountCommit  0x124 fee  0x144 expiry  0x164 nullifier
//   0x184 feeTo  0x1a4 path[20]  (apply only)
// claim goes on with  0xa4 balance  0xc4 salt  0xe4 c  0x104 takerTo  0x124 takerFee  0x144 path[20]
//
// k and the expiry count rollup blocks (amendment 1). The rollup refuses, in VERIFY, any block that
// omits the oldest unincluded queued leaf once K rollup blocks have followed its queueing.
//
// Storage: 0 the root; 1 the rollup's block count; 2 the queue's tail; 3 its head;
// mapslot(i, 4) the queued T; mapslot(i, 5) the block count when queued; mapslot(chan, 6) frozen;
// mapslot(chan, 7) claimed; mapslot(chan, 8) the latest backup's versioned hash;
// mapslot(chan, 9) the channel's kh, written at genesis.
// code = <this object> || VK (32 bytes), the user's program key.
object "Rollup" {
    code {
        let size := datasize("runtime")
        datacopy(0, dataoffset("runtime"), size)
        codecopy(size, sub(codesize(), 32), 32)
        return(0, add(size, 32))
    }
    object "runtime" {
        code {
            if eq(caller(), 0xaa) {
                let frame := txparam(0x0a)
                if eq(frameparam(0x02, frame), 1) { validate(frame) }   // VERIFY
                stop()
            }
            if iszero(calldatasize()) { stop() }
            switch shr(224, calldataload(0))
            // The five SENDER frames' selectors are those of apply(), queue(), freeze(), claim() and
            // backup(); their data is the fixed layout above, not ABI arguments.
            case 0xdb595b3b { doApply() }
            case 0xe10d29ee { doQueue() }
            case 0x62a5af3b { doFreeze() }
            case 0x4e71d92d { doClaim() }
            case 0x50a9e127 { doBackup() }
            case 0xebf0c717 { ret(sload(0)) }                   // root()
            case 0x07225b4d { ret(sload(1)) }                   // blockCount()
            case 0x80fc249c { ret(sload(mapslot(calldataload(4), 8))) } // backupOf(uint256)
            case 0x5e30555f { ret(sload(mapslot(calldataload(4), 6))) } // frozenAt(uint256)
            default { revert(0, 0) }

            // ---------------------------------------------------------------- VERIFY

            function validate(me) {
                if me { revert(0, 0) }
                if iszero(eq(frameparam(0x06, me), 3)) { revert(0, 0) }
                if iszero(eq(txparam(0x09), 3)) { revert(0, 0) }
                if txparam(0x0b) { revert(0, 0) }                    // no signatures
                // [1] the dependency frame; [2] the SENDER frame, to this rollup, no value or flags.
                if iszero(eq(frameparam(0x02, 1), 4)) { revert(0, 0) }
                let s := 2
                if iszero(eq(frameparam(0x02, s), 2)) { revert(0, 0) }
                if iszero(eq(frameparam(0x00, s), address())) { revert(0, 0) }
                if frameparam(0x08, s) { revert(0, 0) }
                if frameparam(0x03, s) { revert(0, 0) }
                // One nonce key, at sequence 0: a transaction of each kind happens once.
                if iszero(eq(txparam(0x0e), 1)) { revert(0, 0) }
                if txparam(0x01) { revert(0, 0) }
                // The SENDER frame cannot be starved after approval.
                if lt(frameparam(0x01, s), 150000) { revert(0, 0) }
                if lt(frameparam(0x09, s), 300000) { revert(0, 0) }

                let chan := framedataload(0x64, s)
                if iszero(lt(chan, shl(20, 1))) { revert(0, 0) }
                let key := memberKey(s)
                if iszero(eq(kh(s), sload(mapslot(chan, 9)))) { revert(0, 0) }
                switch shr(224, framedataload(0, s))
                case 0xdb595b3b { vApply(s, chan) }
                case 0xe10d29ee { vQueue(s, chan) }
                case 0x62a5af3b { vFreeze(s, chan, key) }
                case 0x4e71d92d { vClaim(s, chan, key) }
                case 0x50a9e127 { vBackup(s, chan, key) }
                default { revert(0, 0) }
                approve(3)
            }

            function vApply(s, chan) {
                if iszero(eq(frameparam(0x04, s), 0x424)) { revert(0, 0) }
                if txparam(0x07) { revert(0, 0) }                    // no blobs
                if sload(mapslot(chan, 6)) { revert(0, 0) }          // not frozen
                let fee := framedataload(0x124, s)
                if shr(64, fee) { revert(0, 0) }
                if lt(fee, txparam(0x06)) { revert(0, 0) }           // the fee covers the worst case
                if iszero(eq(txparam(0x10), framedataload(0x164, s))) { revert(0, 0) }
                let next := add(sload(1), 1)
                if lt(framedataload(0x144, s), next) { revert(0, 0) } // not past its expiry
                let t := transferLeaf(s)
                forcedQueue(t)
                // The members' signatures on T, and the user's proof on D, in frame 1.
                if iszero(eq(frameparam(0x04, 1), 288)) { revert(0, 0) }
                let k := kh(s)
                let oldLeaf := h2(k, framedataload(0xa4, s))
                let newLeaf := h2(k, framedataload(0xc4, s))
                triple(0, 0x10, t, framedataload(0x04, s))
                triple(96, 0x10, t, framedataload(0x24, s))
                triple(192, 0x11, h2(h2(oldLeaf, newLeaf), t), VK())
                // The old leaf is in the stored root at chan.
                if iszero(eq(rootOf(oldLeaf, chan, s, 0x1a4), sload(0))) { revert(0, 0) }
            }

            function vQueue(s, chan) {
                if iszero(eq(frameparam(0x04, s), 0x1a4)) { revert(0, 0) }
                if txparam(0x07) { revert(0, 0) }
                if sload(mapslot(chan, 6)) { revert(0, 0) }
                let fee := framedataload(0x124, s)
                if shr(64, fee) { revert(0, 0) }
                if lt(fee, txparam(0x06)) { revert(0, 0) }
                if iszero(eq(txparam(0x10), tagged(0x7831392f7175657565, framedataload(0x164, s)))) { revert(0, 0) } // "x19/queue"
                let t := transferLeaf(s)
                if iszero(eq(frameparam(0x04, 1), 192)) { revert(0, 0) }
                triple(0, 0x10, t, framedataload(0x04, s))
                triple(96, 0x10, t, framedataload(0x24, s))
            }

            function vFreeze(s, chan, key) {
                if iszero(eq(frameparam(0x04, s), 0xa4)) { revert(0, 0) }
                if txparam(0x07) { revert(0, 0) }
                if sload(mapslot(chan, 6)) { revert(0, 0) }
                if iszero(eq(txparam(0x10), tagged(0x7831392f667265657a65, chan))) { revert(0, 0) } // "x19/freeze"
                mstore(0x400, 0x7831392f667265657a65)
                mstore(0x420, address())
                mstore(0x440, chan)
                if iszero(eq(frameparam(0x04, 1), 96)) { revert(0, 0) }
                triple(0, 0x10, keccak256(0x400, 0x60), key)
            }

            function vClaim(s, chan, key) {
                if iszero(eq(frameparam(0x04, s), 0x3c4)) { revert(0, 0) }
                if txparam(0x07) { revert(0, 0) }
                if iszero(sload(mapslot(chan, 6))) { revert(0, 0) }  // frozen
                if sload(mapslot(chan, 7)) { revert(0, 0) }          // not yet claimed
                if iszero(eq(txparam(0x10), tagged(0x7831392f636c61696d, chan))) { revert(0, 0) } // "x19/claim"
                let bal := framedataload(0xa4, s)
                let takerFee := framedataload(0x124, s)
                if shr(64, bal) { revert(0, 0) }
                if gt(add(takerFee, txparam(0x06)), bal) { revert(0, 0) }
                if shr(160, framedataload(0x104, s)) { revert(0, 0) }
                // The opening is the channel's leaf, in the stored root.
                let c := h2(B(bal), framedataload(0xc4, s))
                if iszero(eq(c, framedataload(0xe4, s))) { revert(0, 0) }
                if iszero(eq(rootOf(h2(kh(s), c), chan, s, 0x144), sload(0))) { revert(0, 0) }
                mstore(0x400, 0x7831392f636c61696d)
                mstore(0x420, address())
                mstore(0x440, chan)
                mstore(0x460, framedataload(0x104, s))
                mstore(0x480, takerFee)
                if iszero(eq(frameparam(0x04, 1), 96)) { revert(0, 0) }
                triple(0, 0x10, keccak256(0x400, 0xa0), key)
            }

            function vBackup(s, chan, key) {
                if iszero(eq(frameparam(0x04, s), 0xa4)) { revert(0, 0) }
                if iszero(eq(txparam(0x07), 1)) { revert(0, 0) }     // exactly one blob
                mstore(0x400, 0x7831392f6261636b7570)                // "x19/backup"
                mstore(0x420, chan)
                mstore(0x440, sload(1))
                if iszero(eq(txparam(0x10), keccak256(0x400, 0x60))) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, 1), 96)) { revert(0, 0) }
                triple(0, 0x10, blobhash(0), key)
            }

            // The queue's rule: once the oldest unincluded queued leaf is more than K rollup blocks
            // old, the next block must be it.
            function forcedQueue(t) {
                let head := sload(3)
                if iszero(lt(head, sload(2))) { leave }
                // Queued at count q: blocks q+1 to q+K may omit it; block q+K+1, built at count q+K, may not.
                if lt(sload(1), add(sload(mapslot(head, 5)), K())) { leave }
                if iszero(eq(t, sload(mapslot(head, 4)))) { revert(0, 0) }
            }

            // ---------------------------------------------------------------- SENDER frames

            function doApply() {
                if iszero(eq(caller(), address())) { revert(0, 0) }
                let chan := calldataload(0x64)
                let k := khCall()
                let t := transferLeafCall()
                let newLeaf := h2(k, calldataload(0xc4))
                sstore(0, rootOfCall(newLeaf, chan, 0x1a4))
                sstore(1, add(sload(1), 1))
                let head := sload(3)
                if lt(head, sload(2)) {
                    if eq(t, sload(mapslot(head, 4))) { sstore(3, add(head, 1)) }
                }
                // The aggregator's fee: the transfer's fee less the most this transaction can cost.
                let tip := sub(calldataload(0x124), txparam(0x06))
                if tip { pop(call(gas(), calldataload(0x184), tip, 0, 0, 0, 0)) }
                // Transfer(uint256 indexed chan, uint256 indexed to, bytes32 amountCommit, bytes32 T, bytes32 newLeaf)
                mstore(0, calldataload(0x104))
                mstore(0x20, t)
                mstore(0x40, newLeaf)
                log3(0, 0x60, 0xf7a5a6b409bb583bd3dbc6acbef7da6c3b7748312d8281c5fddb5ab291415985, chan, calldataload(0xe4))
                stop()
            }

            function doQueue() {
                if iszero(eq(caller(), address())) { revert(0, 0) }
                let t := transferLeafCall()
                let tail := sload(2)
                sstore(mapslot(tail, 4), t)
                sstore(mapslot(tail, 5), sload(1))
                sstore(2, add(tail, 1))
                // Queued(uint256 indexed position, bytes32 T, uint256 atBlock)
                mstore(0, t)
                mstore(0x20, sload(1))
                log2(0, 0x40, 0x720b5ebc92a2846490e50e7f8308bc6f14952c32e34ac503fb59f33135e09f2b, tail)
                stop()
            }

            function doFreeze() {
                if iszero(eq(caller(), address())) { revert(0, 0) }
                let chan := calldataload(0x64)
                sstore(mapslot(chan, 6), add(sload(1), 1))
                // Frozen(uint256 indexed chan, uint256 atBlock)
                mstore(0, sload(1))
                log2(0, 0x20, 0x3e488e247bd383c586f4fc0350fed312fc2af4b1012529d2252ed33efd8fe631, chan)
                stop()
            }

            function doClaim() {
                if iszero(eq(caller(), address())) { revert(0, 0) }
                let chan := calldataload(0x64)
                sstore(mapslot(chan, 7), 1)
                let bal := calldataload(0xa4)
                let takerFee := calldataload(0x124)
                let payout := sub(sub(bal, takerFee), txparam(0x06))
                let recipient := calldataload(0x44)
                if takerFee { pop(call(gas(), calldataload(0x104), takerFee, 0, 0, 0, 0)) }
                if iszero(call(gas(), recipient, payout, 0, 0, 0, 0)) { revert(0, 0) }
                // Claimed(uint256 indexed chan, address recipient, uint256 payout, uint256 takerFee)
                mstore(0, recipient)
                mstore(0x20, payout)
                mstore(0x40, takerFee)
                log2(0, 0x60, 0xd9cb1e2714d65a111c0f20f060176ad657496bd47a3de04ec7c3d4ca232112ac, chan)
                stop()
            }

            function doBackup() {
                if iszero(eq(caller(), address())) { revert(0, 0) }
                let chan := calldataload(0x64)
                sstore(mapslot(chan, 8), blobhash(0))
                // Backup(uint256 indexed chan, bytes32 versionedHash, uint256 atBlock)
                mstore(0, blobhash(0))
                mstore(0x20, sload(1))
                log2(0, 0x40, 0x81b53c490562904dc127060d5eacc6e9ac7019c1be55a1439a496fe00a9a5caf, chan)
                stop()
            }

            // ---------------------------------------------------------------- hashes

            function h2(a, b) -> r {
                mstore(0x300, a)
                mstore(0x320, b)
                r := keccak256(0x300, 0x40)
            }
            // B(x): x in the word's first eight bytes, little-endian.
            function B(x) -> w {
                let r := 0
                for { let i := 0 } lt(i, 8) { i := add(i, 1) } {
                    r := or(shl(8, r), and(shr(mul(8, i), x), 0xff))
                }
                w := shl(192, r)
            }
            function tagged(tag, x) -> r {
                mstore(0x340, tag)
                mstore(0x360, x)
                r := keccak256(0x340, 0x40)
            }
            function memberKey(s) -> k {
                switch framedataload(0x84, s)
                case 0 { k := framedataload(0x04, s) }
                case 1 { k := framedataload(0x24, s) }
                default { revert(0, 0) }
            }
            function kh(s) -> r {
                mstore(0x380, framedataload(0x04, s))
                mstore(0x3a0, framedataload(0x24, s))
                let rc := framedataload(0x44, s)
                if shr(160, rc) { revert(0, 0) }
                mstore(0x3c0, rc)
                r := keccak256(0x380, 0x60)
            }
            function khCall() -> r {
                calldatacopy(0x380, 0x04, 0x60)
                r := keccak256(0x380, 0x60)
            }
            function transferLeaf(s) -> t {
                let left := h2(h2(framedataload(0x64, s), framedataload(0xc4, s)), h2(framedataload(0xe4, s), framedataload(0x104, s)))
                let right := h2(h2(B(framedataload(0x124, s)), framedataload(0x144, s)), framedataload(0x164, s))
                t := h2(left, right)
            }
            function transferLeafCall() -> t {
                let left := h2(h2(calldataload(0x64), calldataload(0xc4)), h2(calldataload(0xe4), calldataload(0x104)))
                let right := h2(h2(B(calldataload(0x124)), calldataload(0x144)), calldataload(0x164))
                t := h2(left, right)
            }
            function triple(at, scheme, dataHash, key) {
                if iszero(eq(framedataload(at, 1), scheme)) { revert(0, 0) }
                if iszero(eq(framedataload(add(at, 32), 1), dataHash)) { revert(0, 0) }
                if iszero(eq(framedataload(add(at, 64), 1), key)) { revert(0, 0) }
            }
            // The root a leaf at index implies, with the 20 siblings from offset `at` of frame s.
            function rootOf(leaf, index, s, at) -> node {
                node := leaf
                for { let level := 0 } lt(level, 20) { level := add(level, 1) } {
                    let sib := framedataload(add(at, shl(5, level)), s)
                    switch and(shr(level, index), 1)
                    case 0 { node := h2(node, sib) }
                    default { node := h2(sib, node) }
                }
            }
            function rootOfCall(leaf, index, at) -> node {
                node := leaf
                for { let level := 0 } lt(level, 20) { level := add(level, 1) } {
                    let sib := calldataload(add(at, shl(5, level)))
                    switch and(shr(level, index), 1)
                    case 0 { node := h2(node, sib) }
                    default { node := h2(sib, node) }
                }
            }

            function K() -> v { v := 4 }
            function VK() -> v {
                codecopy(0x60, sub(codesize(), 32), 32)
                v := mload(0x60)
            }
            function mapslot(key, tag) -> s {
                mstore(0, key)
                mstore(0x20, tag)
                s := keccak256(0, 0x40)
            }
            function ret(v) {
                mstore(0, v)
                return(0, 0x20)
            }
            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function framedataload(offset, frame) -> v { v := verbatim_2i_1o(hex"b1", offset, frame) }
            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
        }
    }
}
