// Experiment 33: the shared keystore as an EIP-8272 root source. It keeps the roots of experiment
// 32's two trees, their sizes and the used registration tags, and writes its root
// rho = keccak256(root(leaves) || root(revocations)) to the recent-root contract after every change.
// The trees themselves stay off chain: each update carries the paths it needs, checked against the
// stored roots before and after each step.
//
// The keystore is the sender and payer of its own registrations and rotations:
//
//   [0] VERIFY -> keystore     data: empty
//   [1] DEP_VERIFY (mode 4)    data: triple (96) = 0x11 || D || key of the program
//   [2] SENDER -> keystore     register(...) or rotate(...)
//   nonce key: key 0
//
// VERIFY computes D from the SENDER frame's own arguments and reads no storage:
//   register(L0, Q, pathT[20]):                         D = keccak256(L0 || Q),                   key VK_REG
//   rotate(rho, N, L1, ab, entry, pathE[20], pathA[20], pathT[20]):
//                                                       D = keccak256(keccak256(rho || N) || keccak256(L1 || MODE0)), key VK_ROT
// MODE0 is the cell g^0 = 1 followed by a zero cell, experiment 32's rotation under the current
// rule. A revocation entry is E(a, b) = keccak256(TAG_ENT || a16 || b16), a16 and b16 the 16 bytes
// of a and b, little-endian, as experiment 32's programs hash them; kappa is the first 16 bytes of N,
// read the same way. refresh(), open to anyone, writes the current root again at the current slot.
//
// initcode = <this object> || VK_REG || VK_ROT
object "Keystore" {
    code {
        // The empty trees: the leaf tree's root is the zero chain's top; the revocation tree holds
        // E(0, 2^128 - 1) at index 0.
        mstore(0, 0x0601534b00000000000000000000000000000000000000000000000000000000) // TAG_ENT
        mstore(0x20, 0x00000000000000000000000000000000ffffffffffffffffffffffffffffffff)
        let h := keccak256(0, 0x40)
        let z := 0
        for { let l := 0 } lt(l, 20) { l := add(l, 1) } {
            mstore(0x40, h)
            mstore(0x60, z)
            h := keccak256(0x40, 0x40)
            mstore(0x40, z)
            mstore(0x60, z)
            z := keccak256(0x40, 0x40)
        }
        sstore(1, z)
        sstore(2, h)
        sstore(4, 1)
        mstore(0x40, z)
        mstore(0x60, h)
        let rho := keccak256(0x40, 0x40)
        sstore(0, rho)
        mstore(0x40, 0)
        mstore(0x60, rho)
        if iszero(call(gas(), 0x8272, 0, 0x40, 0x40, 0, 0)) { revert(0, 0) }
        let size := datasize("runtime")
        datacopy(0, dataoffset("runtime"), size)
        codecopy(size, sub(codesize(), 64), 64)
        return(0, add(size, 64))
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
            case 0xb4016cff { register() }                      // register(bytes32,bytes32,bytes32[20])
            case 0x6d2be516 { rotate() }                        // rotate(bytes32,bytes32,bytes32,bytes32,uint256,bytes32[20],bytes32[20],bytes32[20])
            case 0xf8ac93e8 { refresh() }                       // refresh()
            case 0xebf0c717 { ret(sload(0)) }                   // root()
            case 0xe7ede060 { ret(sload(3)) }                   // leaves()
            case 0x0fc99376 { ret(sload(4)) }                   // entries()
            default { revert(0, 0) }

            function validate(me) {
                if me { revert(0, 0) }
                if iszero(eq(txparam(0x09), 3)) { revert(0, 0) }
                if iszero(eq(frameparam(0x06, me), 3)) { revert(0, 0) }
                if iszero(eq(frameparam(0x02, 1), 4)) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, 1), 96)) { revert(0, 0) }
                let s := 2
                if iszero(eq(frameparam(0x02, s), 2)) { revert(0, 0) }
                if iszero(eq(frameparam(0x00, s), address())) { revert(0, 0) }
                if frameparam(0x08, s) { revert(0, 0) }
                if frameparam(0x03, s) { revert(0, 0) }
                if txparam(0x0b) { revert(0, 0) }
                if txparam(0x07) { revert(0, 0) }
                if iszero(eq(txparam(0x0e), 1)) { revert(0, 0) }
                mstore(0x100, 1)
                mstore(0x120, 0)
                if iszero(eq(keccak256(0x100, 0x40), txparam(0x0f))) { revert(0, 0) }
                let d := 0
                let vk := 0
                switch shr(224, framedataload(0, s))
                case 0xb4016cff {
                    if iszero(eq(frameparam(0x04, s), 708)) { revert(0, 0) }
                    mstore(0x200, framedataload(0x04, s))
                    mstore(0x220, framedataload(0x24, s))
                    d := keccak256(0x200, 0x40)
                    vk := VK_REG()
                }
                case 0x6d2be516 {
                    if iszero(eq(frameparam(0x04, s), 2084)) { revert(0, 0) }
                    mstore(0x200, framedataload(0x04, s))
                    mstore(0x220, framedataload(0x24, s))
                    let rn := keccak256(0x200, 0x40)
                    mstore(0x200, framedataload(0x44, s))
                    mstore(0x220, 0x0100000000000000000000000000000000000000000000000000000000000000) // MODE0
                    let lm := keccak256(0x200, 0x40)
                    mstore(0x200, rn)
                    mstore(0x220, lm)
                    d := keccak256(0x200, 0x40)
                    vk := VK_ROT()
                }
                default { revert(0, 0) }
                if iszero(eq(framedataload(0, 1), 0x11)) { revert(0, 0) }
                if iszero(eq(framedataload(32, 1), d)) { revert(0, 0) }
                if iszero(eq(framedataload(64, 1), vk)) { revert(0, 0) }
                approve(3)
            }

            // register(bytes32 L0, bytes32 Q, bytes32[20] pathT)
            function register() {
                if iszero(eq(caller(), address())) { revert(0, 0) }
                let q := calldataload(0x24)
                mstore(0, q)
                mstore(0x20, 5)
                let used := keccak256(0, 0x40)
                if sload(used) { revert(0, 0) }
                sstore(used, 1)
                let idx := sload(3)
                if iszero(eq(rootOf(0, idx, 0x44), sload(1))) { revert(0, 0) }
                sstore(1, rootOf(calldataload(0x04), idx, 0x44))
                sstore(3, add(idx, 1))
                publish()
                stop()
            }

            // rotate(bytes32 rho, bytes32 N, bytes32 L1, bytes32 ab, uint256 entry,
            //        bytes32[20] pathE, bytes32[20] pathA, bytes32[20] pathT)
            function rotate() {
                if iszero(eq(caller(), address())) { revert(0, 0) }
                if iszero(eq(calldataload(0x04), sload(0))) { revert(0, 0) }
                let n := calldataload(0x24)
                let ab := calldataload(0x64)
                let entry := calldataload(0x84)
                let hi := not(sub(shl(128, 1), 1))
                let kappa := le16(and(n, hi))
                let a := le16(and(ab, hi))
                let b := le16(shl(128, ab))
                if iszero(and(lt(a, kappa), lt(kappa, b))) { revert(0, 0) }
                // Replace E(a, b) by E(a, kappa) at its index.
                if iszero(eq(rootOf(ent(ab), entry, 0xa4), sload(2))) { revert(0, 0) }
                let r1 := rootOf(ent(or(and(ab, hi), shr(128, and(n, hi)))), entry, 0xa4)
                // Append E(kappa, b).
                let idxN := sload(4)
                if iszero(eq(rootOf(0, idxN, 0x324), r1)) { revert(0, 0) }
                sstore(2, rootOf(ent(or(and(n, hi), and(ab, not(hi)))), idxN, 0x324))
                sstore(4, add(idxN, 1))
                // Append L1.
                let idxT := sload(3)
                if iszero(eq(rootOf(0, idxT, 0x5a4), sload(1))) { revert(0, 0) }
                sstore(1, rootOf(calldataload(0x44), idxT, 0x5a4))
                sstore(3, add(idxT, 1))
                publish()
                stop()
            }

            function refresh() {
                if callvalue() { revert(0, 0) }
                write(sload(0))
                stop()
            }

            function publish() {
                mstore(0, sload(1))
                mstore(0x20, sload(2))
                let rho := keccak256(0, 0x40)
                sstore(0, rho)
                write(rho)
            }
            // EIP-8272 write: salt 0 || root, so source_id = keccak256(this || 0).
            function write(rho) {
                mstore(0, 0)
                mstore(0x20, rho)
                if iszero(call(gas(), 0x8272, 0, 0, 0x40, 0, 0)) { revert(0, 0) }
            }
            function ent(w) -> h {
                mstore(0, 0x0601534b00000000000000000000000000000000000000000000000000000000) // TAG_ENT
                mstore(0x20, w)
                h := keccak256(0, 0x40)
            }
            // The root above `leaf` at `index`, with the twenty siblings at calldata `off`.
            function rootOf(leaf, index, off) -> h {
                h := leaf
                for { let l := 0 } lt(l, 20) { l := add(l, 1) } {
                    let sib := calldataload(add(off, mul(l, 32)))
                    switch and(shr(l, index), 1)
                    case 0 { mstore(0, h) mstore(0x20, sib) }
                    default { mstore(0, sib) mstore(0x20, h) }
                    h := keccak256(0, 0x40)
                }
            }
            // The integer whose 16 bytes, little-endian, are the high half of `w`.
            function le16(w) -> v {
                for { let i := 0 } lt(i, 16) { i := add(i, 1) } {
                    v := or(v, shl(mul(8, i), byte(i, w)))
                }
            }
            function VK_REG() -> v { v := word(64) }
            function VK_ROT() -> v { v := word(32) }
            function word(fromEnd) -> v {
                codecopy(0x60, sub(codesize(), fromEnd), 32)
                v := mload(0x60)
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
