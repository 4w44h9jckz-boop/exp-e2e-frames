// Experiment 33: a stealth account whose keys live in a shared keystore. Experiment 19's version 2a
// stub, changed in one respect: the root the proof is against comes from EIP-8272's recent-root
// verifier frame, which checks that the keystore wrote it recently. The account is the sender and
// payer of its own spend:
//
//   [0] VERIFY -> 0x8272   data: source_id (32) || slot (8) || root (32)
//                          or, on the maximum-age client: 0x01 || source_id || slot || root || max_age (8)
//   [1] VERIFY -> account  data: empty            (reading 2)   [1] DEP_VERIFY (mode 4): triple
//   [2] DEP_VERIFY (mode 4) data: triple (96)     or (reading 1) [2] VERIFY -> account
//   [3] SENDER -> account  spend(address destination, uint256 amount)
//   nonce key: key 0, at the account's own sequence
//
// VERIFY reads frame 0's tuple, requires its source to be the keystore's, and requires the
// dependency triple to be 0x11 || D || VK, with
//   m = keccak256(DOMAIN || account || nonce || destination || amount)
//   D = keccak256(keccak256(C || m) || root)
// the digest experiment 32's spend program publishes. With BOUND > 0 the account also requires the
// maximum-age form, with max_age <= BOUND, so a root older than BOUND slots cannot spend it.
//
// initcode = <this object> || C || VK || SOURCE || BOUND
object "Account" {
    code {
        let size := datasize("runtime")
        datacopy(0, dataoffset("runtime"), size)
        codecopy(size, sub(codesize(), 128), 128)
        return(0, add(size, 128))
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
            default { revert(0, 0) }

            function validate(me) {
                if iszero(eq(txparam(0x09), 4)) { revert(0, 0) }
                if iszero(or(eq(me, 1), eq(me, 2))) { revert(0, 0) }
                if iszero(eq(frameparam(0x06, me), 3)) { revert(0, 0) }
                if frameparam(0x04, me) { revert(0, 0) }
                // The dependency frame is the other of frames 1 and 2.
                let dep := sub(3, me)
                if iszero(eq(frameparam(0x02, dep), 4)) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, dep), 96)) { revert(0, 0) }
                // Frame 0: EIP-8272's verifier, one tuple, in either form.
                if iszero(eq(frameparam(0x02, 0), 1)) { revert(0, 0) }
                if iszero(eq(frameparam(0x00, 0), 0x8272)) { revert(0, 0) }
                let len := frameparam(0x04, 0)
                let at := 0
                switch len
                case 72 { if BOUND() { revert(0, 0) } }
                case 81 {
                    if iszero(eq(shr(248, framedataload(0, 0)), 1)) { revert(0, 0) }
                    at := 1
                    if BOUND() {
                        let maxAge := shr(192, framedataload(73, 0))
                        if gt(maxAge, BOUND()) { revert(0, 0) }
                    }
                }
                default { revert(0, 0) }
                if iszero(eq(framedataload(at, 0), SOURCE())) { revert(0, 0) }
                let root := framedataload(add(at, 40), 0)
                // Frame 3: this account's own spend.
                let s := 3
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
                if iszero(eq(shr(224, framedataload(0, s)), 0xaf7d6ca3)) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, s), 0x44)) { revert(0, 0) }
                let destination := framedataload(0x04, s)
                let amount := framedataload(0x24, s)
                if shr(160, destination) { revert(0, 0) }
                mstore(0x200, 0x7a9b131c1d86dda6461d84fbb4b42adae7a73bf7369fbea1189515c4cdd45462) // keccak256("exp-e2e-frames/33/spend")
                mstore(0x220, address())
                mstore(0x240, txparam(0x01))
                mstore(0x260, destination)
                mstore(0x280, amount)
                let m := keccak256(0x200, 0xa0)
                mstore(0x300, C())
                mstore(0x320, m)
                mstore(0x300, keccak256(0x300, 0x40))
                mstore(0x320, root)
                let d := keccak256(0x300, 0x40)
                if iszero(eq(framedataload(0, dep), 0x11)) { revert(0, 0) }
                if iszero(eq(framedataload(32, dep), d)) { revert(0, 0) }
                if iszero(eq(framedataload(64, dep), VK())) { revert(0, 0) }
                approve(3)
            }

            function spend() {
                if iszero(eq(caller(), address())) { revert(0, 0) }
                if iszero(call(gas(), calldataload(4), calldataload(0x24), 0, 0, 0, 0)) { revert(0, 0) }
                stop()
            }

            function C() -> v { v := word(128) }
            function VK() -> v { v := word(96) }
            function SOURCE() -> v { v := word(64) }
            function BOUND() -> v { v := word(32) }
            function word(fromEnd) -> v {
                codecopy(0x60, sub(codesize(), fromEnd), 32)
                v := mload(0x60)
            }
            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function framedataload(offset, frame) -> v { v := verbatim_2i_1o(hex"b1", offset, frame) }
            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
        }
    }
}
