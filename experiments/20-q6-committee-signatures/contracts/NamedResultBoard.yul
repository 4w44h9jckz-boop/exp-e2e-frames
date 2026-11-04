// NamedResultBoard: experiment 06's ResultBoard (X5) with its threshold BLS check replaced by the
// committee's named leanSPHINCS signatures, declared as EIP-8288 dependencies. It is its own
// frame-transaction sender and payer, and records an FHE result once its VERIFY frame has checked
// that at least QUORUM distinct members signed it.
//
// One result per transaction, exactly. Where EIP-8288 is enabled (the local chain):
//
//   frame 0  VERIFY      this contract, scope 3. Data: request (32) || handle (32) || value (32)
//   frame 1  DEP_VERIFY  (mode 4) the triples (0x10, m, member key), 96 bytes each
//   frame 2  SENDER      this contract -> itself, record(bytes32 request, bytes32 handle,
//                        uint256 value), the same three words
//
// and with EIP-8288 modelled (the test network), the triples follow the three words in frame 0's
// data and the SENDER frame is frame 1. The message the members sign is
//
//   m = keccak256(keccak256("exp-e2e-frames/20/result") || chain_id || request || handle || value)
//
// The transaction's only EIP-8250 nonce key is the request, at sequence 0: one result per request.
// VERIFY reads no storage and no balance, and calls nothing.
//
// initcode = <this object> || key 0 .. key n-1 (32 each) || QUORUM (32) || MEMBERS (32)
object "NamedResultBoard" {
    code {
        let size := datasize("runtime")
        datacopy(0, dataoffset("runtime"), size)
        codecopy(size, sub(codesize(), 32), 32)
        let tail := add(64, shl(5, mload(size)))
        codecopy(size, sub(codesize(), tail), tail)
        return(0, add(size, tail))
    }
    object "runtime" {
        code {
            if eq(caller(), 0xaa) {
                let frame := txparam(0x0a)
                if eq(frameparam(0x02, frame), 1) { validate(frame) }
                stop()
            }
            switch shr(224, calldataload(0))
            case 0xf3f65e7e { record() }   // record(bytes32,bytes32,uint256)
            default {
                // Plain ether funds it.
                if calldatasize() { revert(0, 0) }
                stop()
            }

            function validate(me) {
                if me { revert(0, 0) }
                if iszero(eq(frameparam(0x06, me), 3)) { revert(0, 0) }
                let dep := eq(frameparam(0x02, 1), 4)
                let s := add(1, dep)
                if iszero(eq(txparam(0x09), add(2, dep))) { revert(0, 0) }
                if txparam(0x0b) { revert(0, 0) }
                if txparam(0x07) { revert(0, 0) }
                if dep { if iszero(eq(calldatasize(), 96)) { revert(0, 0) } }

                // The SENDER frame: to this contract, no value, no flags, record(...) of the same words.
                if iszero(eq(frameparam(0x02, s), 2)) { revert(0, 0) }
                if iszero(eq(frameparam(0x00, s), address())) { revert(0, 0) }
                if frameparam(0x08, s) { revert(0, 0) }
                if frameparam(0x03, s) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, s), 100)) { revert(0, 0) }
                if iszero(eq(shr(224, framedataload(0, s)), 0xf3f65e7e)) { revert(0, 0) }
                for { let i := 0 } lt(i, 3) { i := add(i, 1) } {
                    if iszero(eq(framedataload(add(4, shl(5, i)), s), calldataload(shl(5, i)))) { revert(0, 0) }
                }

                // One result per request: the request is the only nonce key, at sequence 0.
                if iszero(eq(txparam(0x0e), 1)) { revert(0, 0) }
                if txparam(0x01) { revert(0, 0) }
                mstore(0, 1)
                mstore(0x20, calldataload(0))
                if iszero(eq(keccak256(0, 0x40), txparam(0x0f))) { revert(0, 0) }

                // A bound on what one result can cost this contract.
                if gt(txparam(0x06), 10000000000000000) { revert(0, 0) }

                mstore(0x100, 0xd3169824862b38f1bbb312bb63b73c551fe81c5bee2ba56ff584663415c2f0dc) // keccak256("exp-e2e-frames/20/result")
                mstore(0x120, chainid())
                calldatacopy(0x140, 0, 96)
                let m := keccak256(0x100, 0xa0)
                switch dep
                case 1 { named(m, 1, 0) }
                default { named(m, me, 96) }
                approve(3)
            }

            // SENDER: Result(bytes32 indexed request, bytes32 handle, uint256 value)
            function record() {
                if iszero(eq(caller(), address())) { revert(0, 0) }
                if iszero(eq(calldatasize(), 100)) { revert(0, 0) }
                mstore(0, calldataload(36))
                mstore(0x20, calldataload(68))
                log2(0, 0x40, 0xaa1d5f0b25dff41865d3df1899cb9e93857ce12817e5b56639e6b89079e31f90, calldataload(4))
                stop()
            }

            // @include Named.yul.inc
            function COMMITTEE_END() -> v { v := 0 }

            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function framedataload(offset, frame) -> v { v := verbatim_2i_1o(hex"b1", offset, frame) }
            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
        }
    }
}
