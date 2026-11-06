// Experiment 19 (X14), run 3: one of version 5's four pots. A pot holds part of the pool's funds and
// is the sender and payer of the withdrawals its nullifiers name:
//
//   [0] VERIFY -> EIP-8272   data: source_id (32) || slot (8) || root (32), the pool's recent root
//   [1] VERIFY -> pot        data: triple (96) = 0x11 || D || VK, D = H(H(root || nf) || binding)
//   [2] SENDER -> pot        withdraw(bytes32 root, bytes32 nf, address recipient, address relayer, uint256 fee)
//   nonce key: nf, at sequence 0
//
// A pot accepts only the nullifiers whose pot is itself, nf mod 4 = its index, so that one note
// cannot be withdrawn from two pots under two senders' nonce keys. Its VERIFY reads no state, not
// even its own: the root comes from EIP-8272's verifier frame, which checks that the pool published
// it recently. binding = keccak256(recipient || relayer || fee), as Pool5.yul has it, and the proof
// is version 5's program. EIP-8288 is modelled, as in Pool5.yul's test-network path.
//
// initcode = <this object> || source_id || index || vk
object "Pot" {
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
            case 0xa55c1853 { withdraw() }                      // withdraw(bytes32,bytes32,address,address,uint256)
            default { revert(0, 0) }

            function validate(me) {
                // Frame 0 is EIP-8272's verifier frame; this frame approves; frame 2 withdraws.
                if iszero(eq(me, 1)) { revert(0, 0) }
                if iszero(eq(frameparam(0x06, me), 3)) { revert(0, 0) }
                if iszero(eq(txparam(0x09), 3)) { revert(0, 0) }
                if iszero(eq(frameparam(0x00, 0), 0x8272)) { revert(0, 0) }
                if iszero(eq(frameparam(0x02, 0), 1)) { revert(0, 0) }
                if frameparam(0x03, 0) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, 0), 72)) { revert(0, 0) }
                if iszero(eq(framedataload(0, 0), SOURCE())) { revert(0, 0) }
                let root := framedataload(40, 0)
                if iszero(eq(frameparam(0x02, 2), 2)) { revert(0, 0) }
                if iszero(eq(frameparam(0x00, 2), address())) { revert(0, 0) }
                if frameparam(0x08, 2) { revert(0, 0) }
                if frameparam(0x03, 2) { revert(0, 0) }
                if txparam(0x0b) { revert(0, 0) }
                if txparam(0x07) { revert(0, 0) }
                if txparam(0x01) { revert(0, 0) }
                if iszero(eq(shr(224, framedataload(0, 2)), 0xa55c1853)) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, 2), 0xa4)) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, me), 96)) { revert(0, 0) }
                if iszero(eq(framedataload(0x04, 2), root)) { revert(0, 0) }
                let nf := framedataload(0x24, 2)
                let fee := framedataload(0x84, 2)
                if gt(fee, DENOM()) { revert(0, 0) }
                if iszero(eq(and(nf, 3), INDEX())) { revert(0, 0) }
                // The one nonce key is the nullifier hash.
                if iszero(eq(txparam(0x0e), 1)) { revert(0, 0) }
                mstore(0x100, 1)
                mstore(0x120, nf)
                if iszero(eq(keccak256(0x100, 0x40), txparam(0x0f))) { revert(0, 0) }
                mstore(0x200, framedataload(0x44, 2))
                mstore(0x220, framedataload(0x64, 2))
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

            function DENOM() -> v { v := 1000000000000000 }
            function SOURCE() -> v { v := word(96) }
            function INDEX() -> v { v := word(64) }
            function VK() -> v { v := word(32) }
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
