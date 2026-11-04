// Experiment 19 (X14), version 5: Tornado's design under a modelled EIP-8288, its tree rebuilt
// with Keccak-256 (programs/v5_tornado.py). One denomination; the pool is the sender and payer of
// each withdrawal:
//
//   [0] VERIFY -> pool   data: triple (96) = 0x11 || D || VK, D = H(H(root || nf) || binding)
//   [1] SENDER -> pool   withdraw(bytes32 root, bytes32 nf, address recipient, address relayer, uint256 fee)
//   nonce key: nf, at sequence 0, so a note is withdrawn once
//
// binding = keccak256(recipient || relayer || fee), as Tornado binds them into its proof. The
// recursive proof that would make the triple true is checked off chain, by the experiment's
// prover: EIP-8288 is modelled. The tree's zeros are z_0 = keccak256("exp-e2e-frames/19/zero"),
// z_{i+1} = H(z_i || z_i); every root it has had is kept.
//
// Storage: 0 leaf count; 2 the current root; 0x100 + level the filled subtrees; keccak(root || 4)
// a known root. initcode = <this object> || vk
object "Pool5" {
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
                if eq(frameparam(0x02, frame), 1) { validate(frame) }
                stop()
            }
            if iszero(calldatasize()) { stop() }
            switch shr(224, calldataload(0))
            case 0xb214faa5 { deposit(calldataload(4)) }        // deposit(bytes32)
            case 0xa55c1853 { withdraw() }                      // withdraw(bytes32,bytes32,address,address,uint256)
            case 0xebf0c717 { ret(sload(2)) }                   // root()
            case 0x30e69fc3 { ret(sload(0)) }                   // leafCount()
            default { revert(0, 0) }

            function validate(me) {
                if me { revert(0, 0) }
                if iszero(eq(frameparam(0x06, me), 3)) { revert(0, 0) }
                if iszero(eq(txparam(0x09), 2)) { revert(0, 0) }
                if iszero(eq(frameparam(0x02, 1), 2)) { revert(0, 0) }
                if iszero(eq(frameparam(0x00, 1), address())) { revert(0, 0) }
                if frameparam(0x08, 1) { revert(0, 0) }
                if frameparam(0x03, 1) { revert(0, 0) }
                if txparam(0x0b) { revert(0, 0) }
                if txparam(0x07) { revert(0, 0) }
                if txparam(0x01) { revert(0, 0) }
                if iszero(eq(shr(224, framedataload(0, 1)), 0xa55c1853)) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, 1), 0xa4)) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, me), 96)) { revert(0, 0) }
                let root := framedataload(0x04, 1)
                let nf := framedataload(0x24, 1)
                let fee := framedataload(0x84, 1)
                if iszero(sload(mapslot(root, 4))) { revert(0, 0) }
                if gt(fee, DENOM()) { revert(0, 0) }
                // The one nonce key is the nullifier hash.
                if iszero(eq(txparam(0x0e), 1)) { revert(0, 0) }
                mstore(0x100, 1)
                mstore(0x120, nf)
                if iszero(eq(keccak256(0x100, 0x40), txparam(0x0f))) { revert(0, 0) }
                // binding = keccak256(recipient || relayer || fee); D = H(H(root || nf) || binding)
                mstore(0x200, framedataload(0x44, 1))
                mstore(0x220, framedataload(0x64, 1))
                mstore(0x240, fee)
                let binding := keccak256(0x200, 0x60)
                mstore(0x300, root)
                mstore(0x320, nf)
                mstore(0x300, keccak256(0x300, 0x40))
                mstore(0x320, binding)
                let d := keccak256(0x300, 0x40)
                if iszero(eq(framedataload(0, me), 0x11)) { revert(0, 0) }
                if iszero(eq(framedataload(32, me), d)) { revert(0, 0) }
                if iszero(eq(framedataload(64, me), VK())) { revert(0, 0) }
                approve(3)
            }

            function withdraw() {
                if iszero(eq(caller(), address())) { revert(0, 0) }
                let recipient := calldataload(0x44)
                let relayer := calldataload(0x64)
                let fee := calldataload(0x84)
                if iszero(call(gas(), recipient, sub(DENOM(), fee), 0, 0, 0, 0)) { revert(0, 0) }
                if fee { if iszero(call(gas(), relayer, fee, 0, 0, 0, 0)) { revert(0, 0) } }
                stop()
            }

            function deposit(c) {
                if iszero(eq(callvalue(), DENOM())) { revert(0, 0) }
                let index := sload(0)
                if iszero(lt(index, shl(20, 1))) { revert(0, 0) }
                let node := c
                let i := index
                for { let level := 0 } lt(level, 20) { level := add(level, 1) } {
                    switch and(i, 1)
                    case 0 {
                        sstore(add(0x100, level), node)
                        node := h2(node, zero(level))
                    }
                    default { node := h2(sload(add(0x100, level)), node) }
                    i := shr(1, i)
                }
                sstore(2, node)
                sstore(mapslot(node, 4), 1)
                sstore(0, add(index, 1))
                mstore(0, c)
                mstore(0x20, index)
                log1(0, 0x40, 0x98e783c3864bbf744a057ef605a2a61701c3b62b5ed68b3745b99094497daf1f) // Deposit(bytes32 commitment, uint256 leafIndex)
                stop()
            }
            function h2(a, b) -> r {
                mstore(0, a)
                mstore(0x20, b)
                r := keccak256(0, 0x40)
            }
            // z_0 = keccak256("exp-e2e-frames/19/zero"), z_{i+1} = H(z_i || z_i), recomputed per level.
            function zero(level) -> z {
                z := 0xd60aeb146bd0a6ecc9c4f92151f04884e5f15c71c8dd06bf85a7479552c55d02 // keccak256("exp-e2e-frames/19/zero")
                for { let l := 0 } lt(l, level) { l := add(l, 1) } { z := h2(z, z) }
            }
            function DENOM() -> v { v := 1000000000000000 }
            function VK() -> v { v := word(32) }
            function word(fromEnd) -> v {
                codecopy(0x60, sub(codesize(), fromEnd), 32)
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
