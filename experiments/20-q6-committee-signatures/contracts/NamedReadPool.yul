// NamedReadPool: experiment 16's ReadPool (X11) with its attesters' ECDSA quorum replaced by the
// committee's named leanSPHINCS signatures, declared as EIP-8288 dependencies. Experiment 20 (Q6).
// The sale, the bonds, the payouts, the digests, the nonce keys and the floors are ReadPool's.
//
// Where EIP-8288 is enabled (the local chain):
//
//   [0] VERIFY      this pool, APPROVE_EXECUTION_AND_PAYMENT, no data
//   [1] DEP_VERIFY  (mode 4) the triples (0x10, digest, member key), 96 bytes each
//   [2] SENDER      this pool: settle, refund or slash, with ReadPool's words less the signatures
//
// and with EIP-8288 modelled (the test network), the triples are frame 0's data and the SENDER
// frame is frame 1. The digests are ReadPool's:
//
//   settle = keccak256(SETTLE_TAG || chainid || pool || server || epoch || n || root)
//   refund = keccak256(REFUND_TAG || chainid || pool || serial || recipient)
//
// settle and refund need at least QUORUM triples on their digest, each a distinct member's, in
// increasing member order. slash needs exactly two triples under the slashed member's key: on
// batch A's settle digest, then on the conflicting digest (batch B's settle digest, kind 1, or the
// refund's, kind 2).
//
// initcode = <this object> || price || slashAmount || salt || key 0 .. key n-1 || QUORUM || MEMBERS
object "NamedReadPool" {
    code {
        let size := datasize("runtime")
        datacopy(0, dataoffset("runtime"), size)
        codecopy(size, sub(codesize(), 32), 32)
        let tail := add(160, shl(5, mload(size)))
        codecopy(size, sub(codesize(), tail), tail)
        return(0, add(size, tail))
    }
    object "runtime" {
        code {
            // ENTRY_POINT (0xaa) calls in DEFAULT and VERIFY frames. Only VERIFY does anything.
            if eq(caller(), 0xaa) {
                let frame := txparam(0x0a)
                if eq(frameparam(0x02, frame), 1) { validate(frame) }
                stop()
            }

            // Plain ether tops up the float the pool pays gas from.
            if iszero(calldatasize()) { stop() }

            switch shr(224, calldataload(0))
            case 0xd96a094a { buy(calldataload(4)) }       // buy(uint256)
            case 0x9940686e { bond(calldataload(4)) }      // bond(uint256)
            case 0x9b2db373 { settle() }                   // settle(uint256[])
            case 0xaa613df5 { refund() }                   // refund(uint256[])
            case 0x4c91a906 { slash() }                    // slash(uint256[])
            case 0xa035b1fe { ret(PRICE()) }               // price()
            case 0x02c7e7af { ret(sload(0)) }              // sold()
            case 0x295b4e17 { ret(sload(1)) }              // paid()
            case 0x12f53950 { ret(sload(2)) }              // refunded()
            case 0xc60df258 { ret(sload(bondSlot(calldataload(4)))) } // bondOf(uint256)
            case 0x956d113b { ret(memberKey(calldataload(4))) }       // member(uint256)
            case 0x8802834e { ret(SLASH()) }               // slashAmount()
            default { revert(0, 0) }

            // ---- plain calls ----

            function buy(n) {
                if iszero(n) { revert(0, 0) }
                if iszero(eq(callvalue(), mul(n, PRICE()))) { revert(0, 0) }
                sstore(0, add(sload(0), n))
                mstore(0, n)
                log2(0, 0x20, 0xc55650ccda1011e1cdc769b1fbf546ebb8c97800b6072b49e06cd560305b1d67, caller()) // Bought(address indexed buyer, uint256 n)
                stop()
            }

            function bond(i) {
                let s := bondSlot(i)
                sstore(s, add(sload(s), callvalue()))
                mstore(0, callvalue())
                log2(0, 0x20, 0xbe7f8c7784c3e75dcaa3137da865e21982f5ff9dca09c78511a29bc7d3560b8f, i) // Bonded(uint256 indexed member, uint256 value)
                stop()
            }

            // ---- VERIFY ----

            function validate(me) {
                if me { revert(0, 0) }
                if iszero(eq(frameparam(0x06, me), 3)) { revert(0, 0) }
                let s := sf()
                // Exactly one SENDER frame follows, to this pool, with no value and no flags.
                if iszero(eq(txparam(0x09), add(1, s))) { revert(0, 0) }
                if iszero(eq(frameparam(0x02, s), 2)) { revert(0, 0) }
                if iszero(eq(frameparam(0x00, s), address())) { revert(0, 0) }
                if frameparam(0x08, s) { revert(0, 0) }
                if frameparam(0x03, s) { revert(0, 0) }
                if txparam(0x01) { revert(0, 0) }
                if txparam(0x0b) { revert(0, 0) }
                if txparam(0x07) { revert(0, 0) }
                if eq(s, 2) { if calldatasize() { revert(0, 0) } }
                if iszero(eq(framedataload(0x04, s), 0x20)) { revert(0, 0) }
                switch shr(224, framedataload(0, s))
                case 0x9b2db373 { validateSettle() }
                case 0xaa613df5 { validateRefund() }
                case 0x4c91a906 { validateSlash() }
                default { revert(0, 0) }
                approve(3)
            }

            // The SENDER frame: 2 behind a dependency frame, else 1.
            function sf() -> s { s := add(1, eq(frameparam(0x02, 1), 4)) }
            // The frame the triples are in: the dependency frame, else VERIFY's own data.
            function df() -> f { f := sub(sf(), 1) }

            // settle(w): server, epoch, n, root, fee.
            function validateSettle() {
                checkWords(5)
                let server := w(0)
                let n := w(2)
                let fee := w(4)
                if or(iszero(server), shr(160, server)) { revert(0, 0) }
                if iszero(n) { revert(0, 0) }
                if gt(n, outstanding()) { revert(0, 0) }
                checkFee(fee, mul(n, PRICE()))
                named(settleDigest(server, w(1), n, w(3)), df(), 0)
                key(1, server, w(1))
                floors()
            }

            // refund(w): serial, recipient, fee.
            function validateRefund() {
                checkWords(3)
                let recipient := w(1)
                if or(iszero(recipient), shr(160, recipient)) { revert(0, 0) }
                if iszero(outstanding()) { revert(0, 0) }
                checkFee(w(2), PRICE())
                named(refundDigest(w(0), recipient), df(), 0)
                key(2, w(0), 0)
                floors()
            }

            // slash(w): member, reporter, fee, kind, then the conflict.
            //   kind 1: batch A (server, epoch, n, root), batch B (the same four), serial, its index
            //           in A, its index in B, A's path (8 words), B's path (8 words)
            //   kind 2: batch A (four words), serial, the refund's recipient, the serial's index in
            //           A, A's path (8 words)
            // The triples: (0x10, A's digest, the member's key), (0x10, the other digest, the same key).
            function validateSlash() {
                let m := w(0)
                let reporter := w(1)
                let k := memberKey(m)
                if or(iszero(reporter), shr(160, reporter)) { revert(0, 0) }
                if lt(sload(bondSlot(m)), SLASH()) { revert(0, 0) }
                checkFee(w(2), SLASH())
                let a := settleDigest(w(4), w(5), w(6), w(7))
                let b := 0
                let other := 0
                switch w(3)
                case 1 {
                    checkWords(31)
                    b := settleDigest(w(8), w(9), w(10), w(11))
                    if eq(a, b) { revert(0, 0) }
                    if iszero(inRoot(w(12), w(13), w(6), w(7), 15)) { revert(0, 0) }
                    if iszero(inRoot(w(12), w(14), w(10), w(11), 23)) { revert(0, 0) }
                    // The same pair, either way round, is one conflict.
                    switch lt(a, b)
                    case 1 { other := pair(a, b) }
                    default { other := pair(b, a) }
                }
                case 2 {
                    checkWords(19)
                    b := refundDigest(w(8), w(9))
                    if iszero(inRoot(w(8), w(10), w(6), w(7), 11)) { revert(0, 0) }
                    other := pair(a, b)
                }
                default { revert(0, 0) }
                let f := df()
                if iszero(eq(frameparam(0x04, f), 192)) { revert(0, 0) }
                triple(f, 0, a, k)
                triple(f, 96, b, k)
                key(3, m, other)
                floors()
            }

            function triple(f, o, digest, k) {
                if iszero(eq(framedataload(o, f), 0x10)) { revert(0, 0) }
                if iszero(eq(framedataload(add(o, 32), f), digest)) { revert(0, 0) }
                if iszero(eq(framedataload(add(o, 64), f), k)) { revert(0, 0) }
            }

            // The SENDER frame's call: the length at 0x24, the words from 0x44.
            function checkWords(n) {
                let s := sf()
                if iszero(eq(framedataload(0x24, s), n)) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, s), add(0x44, shl(5, n)))) { revert(0, 0) }
            }
            function w(i) -> v { v := framedataload(add(0x44, shl(5, i)), sf()) }

            // The fee covers the transaction's maximum cost and leaves something to pay.
            function checkFee(fee, amount) {
                if lt(fee, txparam(0x06)) { revert(0, 0) }
                if iszero(lt(fee, amount)) { revert(0, 0) }
            }

            function inRoot(serial, index, n, root, at) -> ok {
                if iszero(lt(index, n)) { leave }
                let d := 0
                for {} lt(shl(d, 1), n) {} { d := add(d, 1) }
                if gt(d, 8) { leave }
                mstore(0, serial)
                let node := keccak256(0, 0x20)
                for { let l := 0 } lt(l, d) { l := add(l, 1) } {
                    let sib := w(add(at, l))
                    switch and(shr(l, index), 1)
                    case 0 {
                        mstore(0, node)
                        mstore(0x20, sib)
                    }
                    default {
                        mstore(0, sib)
                        mstore(0x20, node)
                    }
                    node := keccak256(0, 0x40)
                }
                ok := eq(node, root)
            }

            // The one nonce key, at sequence 0: EIP-8250's nonce_keys_hash = keccak256(1 || key).
            function key(kind, x, y) {
                mstore(0x100, kind)
                mstore(0x120, x)
                mstore(0x140, y)
                let k := keccak256(0x100, 0x60)
                if iszero(eq(txparam(0x0e), 1)) { revert(0, 0) }
                mstore(0x100, 1)
                mstore(0x120, k)
                if iszero(eq(keccak256(0x100, 0x40), txparam(0x0f))) { revert(0, 0) }
            }

            // The SENDER frame can always finish once the nonce key is used: enough execution for
            // a payment, and state for a fresh recipient and two fresh slots.
            function floors() {
                if lt(frameparam(0x01, sf()), 80000) { revert(0, 0) }
                if lt(frameparam(0x09, sf()), add(183600, mul(2, 97920))) { revert(0, 0) }
            }

            function settleDigest(server, epoch, n, root) -> d {
                mstore(0x100, 0x96e137ebfc9cac7f9a07605e3f04a6c2643ba87bb541e54664ed3e0c67b8f124) // keccak256("exp-e2e-frames/16/settle")
                mstore(0x120, chainid())
                mstore(0x140, address())
                mstore(0x160, server)
                mstore(0x180, epoch)
                mstore(0x1a0, n)
                mstore(0x1c0, root)
                d := keccak256(0x100, 0xe0)
            }
            function refundDigest(serial, recipient) -> d {
                mstore(0x100, 0x01833d6cfa23304b91a4b9eb72c9ba9d48936ecd2e471dc8ecc5b56b652a84ea) // keccak256("exp-e2e-frames/16/refund")
                mstore(0x120, chainid())
                mstore(0x140, address())
                mstore(0x160, serial)
                mstore(0x180, recipient)
                d := keccak256(0x100, 0xa0)
            }
            function pair(x, y) -> p {
                mstore(0x100, x)
                mstore(0x120, y)
                p := keccak256(0x100, 0x40)
            }

            function outstanding() -> o { o := sub(sload(0), add(sload(1), sload(2))) }

            // ---- SENDER ----

            function cw(i) -> v { v := calldataload(add(0x44, shl(5, i))) }
            function self() { if iszero(eq(caller(), address())) { revert(0, 0) } }

            function settle() {
                self()
                let server := cw(0)
                let n := cw(2)
                sstore(1, add(sload(1), n))
                pay(server, sub(mul(n, PRICE()), cw(4)))
                mstore(0, cw(1))
                mstore(0x20, n)
                mstore(0x40, cw(3))
                log2(0, 0x60, 0x6b56d51fe6d2a04d3a8f33cf3906affd53f0d4e7a42e5c708b201ed71333bb4f, server) // Settled(address indexed server, uint256 epoch, uint256 n, bytes32 root)
                stop()
            }

            function refund() {
                self()
                let recipient := cw(1)
                sstore(2, add(sload(2), 1))
                pay(recipient, sub(PRICE(), cw(2)))
                mstore(0, recipient)
                log2(0, 0x20, 0xa68a88f865c0180ccfe8280b863d13857fb683a804c95ba6265e78be32ebed78, cw(0)) // RefundPaid(bytes32 indexed serial, address recipient)
                stop()
            }

            function slash() {
                self()
                let m := cw(0)
                let s := bondSlot(m)
                sstore(s, sub(sload(s), SLASH()))
                pay(cw(1), sub(SLASH(), cw(2)))
                mstore(0, cw(1))
                mstore(0x20, cw(3))
                log2(0, 0x40, 0x0ebf205de0d16b8c4e99b7cd8c52f0e40c86547ecda94f93c3fcf75fd0408463, m) // Slashed(uint256 indexed member, address reporter, uint256 kind)
                stop()
            }

            function pay(to, amount) {
                if iszero(call(50000, to, amount, 0, 0, 0, 0)) { revert(0, 0) }
            }

            // ---- constants and helpers ----

            function bondSlot(i) -> s {
                if iszero(lt(i, MEMBERS())) { revert(0, 0) }
                s := add(0x10, i)
            }
            // price, slashAmount and salt sit before the committee.
            function PRICE() -> v { v := tailWord(add(160, shl(5, MEMBERS()))) }
            function SLASH() -> v { v := tailWord(add(128, shl(5, MEMBERS()))) }
            function ret(v) {
                mstore(0, v)
                return(0, 0x20)
            }

            // @include Named.yul.inc
            function COMMITTEE_END() -> v { v := 0 }

            // EIP-8141 opcodes. verbatim puts its first argument on top.
            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function framedataload(offset, frame) -> v { v := verbatim_2i_1o(hex"b1", offset, frame) }
            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
        }
    }
}
