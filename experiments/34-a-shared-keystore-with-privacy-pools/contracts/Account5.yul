// Experiment 34, arm B: a stealth account whose identity's leaf has two rules, the account's own
// program being main4: a proof under main4's key allows exactly one call, execute(target, value,
// data), which the account then makes. It is the recipient template of case (h) and the depositor
// of case (j). The account is the sender and payer:
//
//   [0] VERIFY -> 0x8272   data: source_id (32) || slot (8) || root (32)
//   [1] DEFAULT -> the CREATE2 deployer, deploying this account (only while it has no code)
//   [.] VERIFY -> account  data: empty
//   [.] DEP_VERIFY (mode 4) data: triple (96) = 0x11 || D || VK_MAIN4
//   [.] SENDER -> account  execute(address target, uint256 value, bytes data)
//   nonce key: key 0
//
// VERIFY requires the tuple's source to be the keystore's, a maximum fee per gas of at most 1,000
// wei (arm A's cap), and
//   m = keccak256(DOMAIN || account || nonce || target || value || keccak256(data))
//   D = keccak256(keccak256(C || m) || keccak256(root || 0))
// the digest main4 publishes; any other call shape is refused.
//
// This object is the implementation, deployed once. Each account is an EIP-1167 clone of it with
// three words appended, runtime = clone (45) || C || VK_MAIN4 || SOURCE, 141 bytes.
object "Account5" {
    code {
        let size := datasize("runtime")
        datacopy(0, dataoffset("runtime"), size)
        return(0, size)
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
            case 0xb61d27f6 { execute() }                       // execute(address,uint256,bytes)
            default { revert(0, 0) }

            function validate(me) {
                if gt(txparam(0x04), 1000) { revert(0, 0) }
                // The frames after the verifier and an optional deployment: VERIFY, dependency, call.
                if iszero(or(eq(me, 1), eq(me, 2))) { revert(0, 0) }
                let dep := add(me, 1)
                let s := add(me, 2)
                if iszero(eq(txparam(0x09), add(s, 1))) { revert(0, 0) }
                if iszero(eq(frameparam(0x06, me), 3)) { revert(0, 0) }
                if frameparam(0x04, me) { revert(0, 0) }
                if iszero(eq(frameparam(0x02, dep), 4)) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, dep), 96)) { revert(0, 0) }
                // Frame 0: EIP-8272's verifier, one 72-byte tuple from the keystore.
                if iszero(eq(frameparam(0x02, 0), 1)) { revert(0, 0) }
                if iszero(eq(frameparam(0x00, 0), 0x8272)) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, 0), 72)) { revert(0, 0) }
                if iszero(eq(framedataload(0, 0), SOURCE())) { revert(0, 0) }
                let root := framedataload(40, 0)
                // The call: this account's own execute(target, value, data), nothing else.
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
                if iszero(eq(shr(224, framedataload(0, s)), 0xb61d27f6)) { revert(0, 0) }
                // The ABI layout: target, value, offset 0x60, length, then the data padded to words.
                if iszero(eq(framedataload(68, s), 0x60)) { revert(0, 0) }
                let len := framedataload(100, s)
                if gt(len, 0x400) { revert(0, 0) }
                let padded := and(add(len, 31), not(31))
                if iszero(eq(frameparam(0x04, s), add(132, padded))) { revert(0, 0) }
                for { let i := 0 } lt(i, padded) { i := add(i, 32) } {
                    mstore(add(0x400, i), framedataload(add(132, i), s))
                }
                mstore(0x200, 0x3e8692af09137f47db4c4abfbfd487a72d95ad52c7a49eb01bb0ef705d69687c) // keccak256("exp-e2e-frames/34/execute")
                mstore(0x220, address())
                mstore(0x240, txparam(0x01))
                mstore(0x260, framedataload(4, s))
                mstore(0x280, framedataload(36, s))
                mstore(0x2a0, keccak256(0x400, len))
                let m := keccak256(0x200, 0xc0)
                mstore(0x300, C())
                mstore(0x320, m)
                let cm := keccak256(0x300, 0x40)
                mstore(0x300, root)
                mstore(0x320, 0)
                let rp := keccak256(0x300, 0x40)
                mstore(0x300, cm)
                mstore(0x320, rp)
                let d := keccak256(0x300, 0x40)
                if iszero(eq(framedataload(0, dep), 0x11)) { revert(0, 0) }
                if iszero(eq(framedataload(32, dep), d)) { revert(0, 0) }
                if iszero(eq(framedataload(64, dep), VK_MAIN4())) { revert(0, 0) }
                approve(3)
            }

            // execute(target, value, data): the call the proof allowed.
            function execute() {
                if iszero(eq(caller(), address())) { revert(0, 0) }
                let off := add(4, calldataload(68))
                let len := calldataload(off)
                calldatacopy(0, add(off, 32), len)
                if iszero(call(gas(), calldataload(4), calldataload(36), 0, len, 0, 0)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }
                stop()
            }

            function C() -> v { v := word(96) }
            function VK_MAIN4() -> v { v := word(64) }
            function SOURCE() -> v { v := word(32) }
            // A word of the account's own code: under the clone's delegatecall, address() is the
            // account and codesize() would be this implementation's.
            function word(fromEnd) -> v {
                let a := address()
                extcodecopy(a, 0x60, sub(extcodesize(a), fromEnd), 32)
                v := mload(0x60)
            }
            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function framedataload(offset, frame) -> v { v := verbatim_2i_1o(hex"b1", offset, frame) }
            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
        }
    }
}
