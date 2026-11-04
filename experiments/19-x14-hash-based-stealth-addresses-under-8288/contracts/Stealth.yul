// Experiment 19 (X14): a one-time stealth account, versions 1 and 3, spent under a modelled
// EIP-8288. The account is the sender and payer of its own spend:
//
//   [0] VERIFY -> account  data: version 1: T (32) || triple (96); version 3: triple (96)
//   [1] SENDER -> account  spend(address destination, uint256 amount)
//
// A triple is scheme (32) || data_hash (32) || verification_key_hash (32), as EIP-8288 declares a
// dependency. On the test network nothing proves the triple: EIP-8288 is modelled, and the
// recursive proof that would make the triple true is checked off chain (the experiment's prover).
// The message both versions authorise is
//   m = keccak256(DOMAIN || account || nonce || destination || amount),
// and VERIFY checks:
//   version 1 (a leanSTARK of the preimage):   scheme 0x11, data_hash = H(H(C || m) || T), vk = VK
//   version 3 (a plain leanSPHINCS signature): scheme 0x10, data_hash = m, vk = the key itself
// H is keccak256 over the bytes, the leanVM hash of programs/v1_preimage.py.
//
// initcode = <this object> || version || word || vk, where word is C (version 1) or the
// leanSPHINCS key (version 3), and vk is version 1's program key (zero for version 3).
object "Stealth" {
    code {
        let size := datasize("runtime")
        datacopy(0, dataoffset("runtime"), size)
        codecopy(size, sub(codesize(), 96), 96)
        return(0, add(size, 96))
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
            case 0xaf7d6ca3 { spend() }                         // spend(address,uint256)
            case 0x54fd4d50 { ret(VERSION()) }                  // version()
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
                // Its own nonce: one nonce key, key 0 (EIP-8250's keccak256(1 || 0)).
                if iszero(eq(txparam(0x0e), 1)) { revert(0, 0) }
                mstore(0x100, 1)
                mstore(0x120, 0)
                if iszero(eq(keccak256(0x100, 0x40), txparam(0x0f))) { revert(0, 0) }
                if iszero(eq(shr(224, framedataload(0, 1)), 0xaf7d6ca3)) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, 1), 0x44)) { revert(0, 0) }
                let destination := framedataload(0x04, 1)
                let amount := framedataload(0x24, 1)
                if shr(160, destination) { revert(0, 0) }
                // m = keccak256(DOMAIN || account || nonce || destination || amount)
                mstore(0x200, 0x0bc2bb6b03725b6aeb2f6210912c0b1480ff7c66147147ad893a4fbe0bfde91d) // keccak256("exp-e2e-frames/19/spend")
                mstore(0x220, address())
                mstore(0x240, txparam(0x01))
                mstore(0x260, destination)
                mstore(0x280, amount)
                let m := keccak256(0x200, 0xa0)
                switch VERSION()
                case 1 {
                    if iszero(eq(frameparam(0x04, me), 128)) { revert(0, 0) }
                    let t := framedataload(0, me)
                    mstore(0x300, WORD())
                    mstore(0x320, m)
                    mstore(0x300, keccak256(0x300, 0x40))
                    mstore(0x320, t)
                    let d := keccak256(0x300, 0x40)
                    triple(me, 32, 0x11, d, VK())
                }
                case 3 {
                    if iszero(eq(frameparam(0x04, me), 96)) { revert(0, 0) }
                    triple(me, 0, 0x10, m, WORD())
                }
                default { revert(0, 0) }
                approve(3)
            }
            function triple(me, at, scheme, dataHash, vk) {
                if iszero(eq(framedataload(at, me), scheme)) { revert(0, 0) }
                if iszero(eq(framedataload(add(at, 32), me), dataHash)) { revert(0, 0) }
                if iszero(eq(framedataload(add(at, 64), me), vk)) { revert(0, 0) }
            }

            function spend() {
                if iszero(eq(caller(), address())) { revert(0, 0) }
                if iszero(call(gas(), calldataload(4), calldataload(0x24), 0, 0, 0, 0)) { revert(0, 0) }
                stop()
            }

            function VERSION() -> v { v := word(96) }
            function WORD() -> v { v := word(64) }
            function VK() -> v { v := word(32) }
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
