// Experiment 34, arm A: a stealth account whose identity's leaf carries a scoped rule. Experiment
// 33's stub, with one mode: a proof under the account's scoped program key allows exactly one call,
// depositAll(P), which at execution deposits the account's whole balance into the pool's Entrypoint
// with the precommitment P. The account is the sender and payer, so it pays its own gas from what it
// received, and a relayer with no keys can submit it, deploying it first:
//
//   [0] VERIFY -> 0x8272   data: source_id (32) || slot (8) || root (32)
//   [1] DEFAULT -> the CREATE2 deployer, deploying this account (only while it has no code)
//   [.] VERIFY -> account  data: empty
//   [.] DEP_VERIFY (mode 4) data: triple (96) = 0x11 || D || VK_SCOPE
//   [.] SENDER -> account  depositAll(uint256 P)
//   nonce key: key 0
//
// VERIFY requires the tuple's source to be the keystore's, and
//   m = keccak256(DOMAIN || account || nonce || P)
//   D = keccak256(keccak256(C || m) || keccak256(root || P))
// the digest the scoped program publishes; any other call shape is refused.
//
// This object is the implementation, deployed once. Each account is a 173-byte EIP-1167 clone of it
// with its four words appended, runtime = clone (45) || C || VK_SCOPE || SOURCE || ENTRYPOINT, and the
// implementation reads them from the account's code. A deploy frame in a validation prefix may
// declare at most 500,000 state gas (EIP-8141's MAX_VERIFY_STATE_GAS), which at EIP-8037's 1,530 gas
// per state byte admits a clone and not the 726 bytes of an account that carries this code itself.
object "Account4" {
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
            case 0xc6f678bd { depositAll() }                    // depositAll(uint256)
            default { revert(0, 0) }

            function validate(me) {
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
                // The call: this account's own depositAll(P), nothing else.
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
                if iszero(eq(shr(224, framedataload(0, s)), 0xc6f678bd)) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, s), 0x24)) { revert(0, 0) }
                let pre := framedataload(0x04, s)
                mstore(0x200, 0xe7707b99c5b99cf4896397a0caeb350190916789c1147dda36d51030717e70fa) // keccak256("exp-e2e-frames/34/deposit")
                mstore(0x220, address())
                mstore(0x240, txparam(0x01))
                mstore(0x260, pre)
                let m := keccak256(0x200, 0x80)
                mstore(0x300, C())
                mstore(0x320, m)
                let cm := keccak256(0x300, 0x40)
                mstore(0x300, root)
                mstore(0x320, pre)
                let rp := keccak256(0x300, 0x40)
                mstore(0x300, cm)
                mstore(0x320, rp)
                let d := keccak256(0x300, 0x40)
                if iszero(eq(framedataload(0, dep), 0x11)) { revert(0, 0) }
                if iszero(eq(framedataload(32, dep), d)) { revert(0, 0) }
                if iszero(eq(framedataload(64, dep), VK_SCOPE())) { revert(0, 0) }
                approve(3)
            }

            // depositAll(uint256 P): the whole balance, after the transaction's reserved cost, into
            // the pool through the Entrypoint's deposit(uint256).
            function depositAll() {
                if iszero(eq(caller(), address())) { revert(0, 0) }
                mstore(0, shl(224, 0xb6b55f25))
                mstore(4, calldataload(4))
                if iszero(call(gas(), ENTRYPOINT(), selfbalance(), 0, 0x24, 0, 0)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }
                stop()
            }

            function C() -> v { v := word(128) }
            function VK_SCOPE() -> v { v := word(96) }
            function SOURCE() -> v { v := word(64) }
            function ENTRYPOINT() -> v { v := word(32) }
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
