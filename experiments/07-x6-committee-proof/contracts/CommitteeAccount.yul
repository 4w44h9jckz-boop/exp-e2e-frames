// CommitteeAccount: the chain's end of experiment 07's shared-state update. It is the frame
// transaction's sender; a proving committee's proof, checked in its VERIFY frame, approves
// execution; a separate payer's own VERIFY frame approves the fee.
//
// A stand-in, stated in the README before the run: the proof is of experiment 01's withdrawal
// circuit, over a tree of notes this account keeps by its root alone. An update spends one note,
// held by the committee in shares, and credits one unit to the proof's recipient in this account's
// own ledger. The circuit's relayer, fee and refund must be zero.
//
// One update per transaction, exactly:
//
//   frame 0  VERIFY  this contract, scope 2 (EXECUTION). Its data is
//
//              proof (256, the verifier's eight words) || recipient (32) || nullifierHash (32)
//
//   frame 1  VERIFY  a payer other than this contract, scope 1 (PAYMENT)
//   frame 2  SENDER  this contract -> itself, credit(address recipient, bytes32 nullifierHash),
//                    the same two words
//
// The transaction's only EIP-8250 nonce key is the nullifier hash, at sequence 0: a note can be
// spent once. VERIFY reads no storage and no balance, and calls only the verifier, a contract
// with code that reads no storage, forwarding gas only as GAS immediately before STATICCALL.
//
// initcode = <this object> || root (32) || verifier (32)
object "CommitteeAccount" {
    code {
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
            switch shr(224, calldataload(0))
            case 0x90f7dbd5 { credit() }      // credit(address,bytes32)
            case 0x70a08231 {                 // balanceOf(address)
                mstore(0, sload(slotOf(calldataload(4))))
                return(0, 0x20)
            }
            default { revert(0, 0) }

            function validate(me) {
                if me { fail() }
                if iszero(eq(txparam(0x09), 3)) { fail() }
                if iszero(eq(frameparam(0x06, me), 2)) { fail() }
                if iszero(eq(calldatasize(), 320)) { fail() }

                // Frame 1: a payer's VERIFY, for payment only.
                if iszero(eq(frameparam(0x02, 1), 1)) { fail() }
                if iszero(eq(frameparam(0x06, 1), 1)) { fail() }
                if eq(frameparam(0x00, 1), address()) { fail() }

                // Frame 2: SENDER, to this contract, no value, no flags, credit(...) of the same words.
                if iszero(eq(frameparam(0x02, 2), 2)) { fail() }
                if iszero(eq(frameparam(0x00, 2), address())) { fail() }
                if frameparam(0x08, 2) { fail() }
                if frameparam(0x03, 2) { fail() }
                if iszero(eq(frameparam(0x04, 2), 68)) { fail() }
                if iszero(eq(shr(224, framedataload(0, 2)), 0x90f7dbd5)) { fail() }
                let recipient := calldataload(256)
                let nullifierHash := calldataload(288)
                if shr(160, recipient) { fail() }
                if iszero(eq(framedataload(4, 2), recipient)) { fail() }
                if iszero(eq(framedataload(36, 2), nullifierHash)) { fail() }

                // A note is spent once: the nullifier hash is the only nonce key, at sequence 0.
                if iszero(eq(txparam(0x0e), 1)) { fail() }
                if txparam(0x01) { fail() }
                mstore(0, 1)
                mstore(0x20, nullifierHash)
                if iszero(eq(keccak256(0, 0x40), txparam(0x0f))) { fail() }

                // verifyProof(bytes proof, uint256[6] input) with input = root, nullifierHash,
                // recipient, relayer 0, fee 0, refund 0. The arguments at 0x204, the proof's bytes
                // in the tail.
                mstore(0x200, shl(224, 0x695ef6f9))
                mstore(0x204, 0xe0)
                mstore(0x224, word(64))
                mstore(0x244, nullifierHash)
                mstore(0x264, recipient)
                mstore(0x284, 0)
                mstore(0x2a4, 0)
                mstore(0x2c4, 0)
                mstore(0x2e4, 256)
                calldatacopy(0x304, 0, 256)
                mstore(0, 0)
                if iszero(staticcall(gas(), word(32), 0x200, 516, 0, 0x20)) { fail() }
                if iszero(and(eq(returndatasize(), 0x20), eq(mload(0), 1))) { fail() }
                approve(2)
            }

            // SENDER: one unit to the recipient. Update(bytes32 indexed nullifierHash, address recipient)
            function credit() {
                if iszero(eq(caller(), address())) { revert(0, 0) }
                if iszero(eq(calldatasize(), 68)) { revert(0, 0) }
                let recipient := calldataload(4)
                let slot := slotOf(recipient)
                sstore(slot, add(sload(slot), 1))
                mstore(0, recipient)
                log2(0, 0x20, 0xb2b848c23b147f2d3c11308c74cb0ff81a30b54628e5c73c4d70bf623eb98f72, calldataload(36))
                stop()
            }

            // The ledger's slot for `who`: keccak256(who || 0).
            function slotOf(who) -> s {
                mstore(0x80, who)
                mstore(0xa0, 0)
                s := keccak256(0x80, 0x40)
            }

            // A constructor word, counted from the end of the code: verifier 32, root 64.
            // Uses scratch at 0x60.
            function word(fromEnd) -> v {
                codecopy(0x60, sub(codesize(), fromEnd), 32)
                v := mload(0x60)
            }

            function fail() { revert(0, 0) }
            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function framedataload(offset, frame) -> v { v := verbatim_2i_1o(hex"b1", offset, frame) }
            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
        }
    }
}
