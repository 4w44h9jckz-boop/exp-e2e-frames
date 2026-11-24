// Experiment 34, arm B: the ownership check the modified pool calls after a withdrawal's proof.
// Solidity cannot read frames, so the pool calls this contract with abi.encode(T, context,
// recipient, relayFeeBPS). It returns empty on success and reverts otherwise. It requires:
//
//   frame 0: EIP-8272's verifier, one 72-byte tuple from the keystore's source; root = its root
//   a dependency frame (mode 4, 96 bytes) whose triple is 0x11 || d || VK, VK own_main's or
//   own_scoped's (the first such frame counts)
//   m = keccak256(DOMAIN_B || context)
//   X = 0 under own_main; under own_scoped, X = C', read from the recipient's code, which must be
//       exactly an Account5 clone with C' (IMPL, VK_MAIN4 and SOURCE fixed here), and the relay
//       fee must be 0
//   d = keccak256(keccak256(T || m) || keccak256(root || X))
//
// initcode = <this object> || SOURCE || VK_OWN_MAIN || VK_OWN_SCOPED || VK_MAIN4 || IMPL
object "OwnerCheck" {
    code {
        let size := datasize("runtime")
        datacopy(0, dataoffset("runtime"), size)
        codecopy(size, sub(codesize(), 160), 160)
        return(0, add(size, 160))
    }
    object "runtime" {
        code {
            if lt(calldatasize(), 128) { revert(0, 0) }
            let tag := calldataload(0)
            let context := calldataload(32)
            let recipient := calldataload(64)
            let fee := calldataload(96)

            // Frame 0: the recent-root verifier, one tuple from the keystore.
            if iszero(eq(frameparam(0x02, 0), 1)) { revert(0, 0) }
            if iszero(eq(frameparam(0x00, 0), 0x8272)) { revert(0, 0) }
            if iszero(eq(frameparam(0x04, 0), 72)) { revert(0, 0) }
            if iszero(eq(framedataload(0, 0), SOURCE())) { revert(0, 0) }
            let root := framedataload(40, 0)

            // The ownership dependency.
            let d := 0
            let vk := 0
            let n := txparam(0x09)
            for { let k := 0 } lt(k, n) { k := add(k, 1) } {
                if and(eq(frameparam(0x02, k), 4), eq(frameparam(0x04, k), 96)) {
                    let v := framedataload(64, k)
                    if and(eq(framedataload(0, k), 0x11), or(eq(v, VK_OWN_MAIN()), eq(v, VK_OWN_SCOPED()))) {
                        d := framedataload(32, k)
                        vk := v
                        break
                    }
                }
            }
            if iszero(vk) { revert(0, 0) }

            mstore(0x00, 0xcf6742571133b446a62484532b0aa421694e48e10e1af0fecdd982e8227e66a5) // keccak256("exp-e2e-frames/34/owner")
            mstore(0x20, context)
            let m := keccak256(0x00, 0x40)

            let x := 0
            if eq(vk, VK_OWN_SCOPED()) {
                if fee { revert(0, 0) }
                if iszero(eq(extcodesize(recipient), 141)) { revert(0, 0) }
                extcodecopy(recipient, 0x200, 45, 32)
                x := mload(0x200)
                // The template: EIP-1167's runtime for IMPL, then C', VK_MAIN4 and SOURCE.
                mstore(0x300, shl(176, 0x363d3d373d3d3d363d73))
                mstore(0x30a, shl(96, IMPL()))
                mstore(0x31e, shl(136, 0x5af43d82803e903d91602b57fd5bf3))
                mstore(0x32d, x)
                mstore(0x34d, VK_MAIN4())
                mstore(0x36d, SOURCE())
                if iszero(eq(keccak256(0x300, 141), extcodehash(recipient))) { revert(0, 0) }
            }

            mstore(0x00, tag)
            mstore(0x20, m)
            let tm := keccak256(0x00, 0x40)
            mstore(0x00, root)
            mstore(0x20, x)
            let rx := keccak256(0x00, 0x40)
            mstore(0x00, tm)
            mstore(0x20, rx)
            if iszero(eq(keccak256(0x00, 0x40), d)) { revert(0, 0) }
            return(0, 0)

            function SOURCE() -> v { v := word(160) }
            function VK_OWN_MAIN() -> v { v := word(128) }
            function VK_OWN_SCOPED() -> v { v := word(96) }
            function VK_MAIN4() -> v { v := word(64) }
            function IMPL() -> v { v := word(32) }
            function word(fromEnd) -> v {
                codecopy(0x60, sub(codesize(), fromEnd), 32)
                v := mload(0x60)
            }
            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function framedataload(offset, frame) -> v { v := verbatim_2i_1o(hex"b1", offset, frame) }
        }
    }
}
