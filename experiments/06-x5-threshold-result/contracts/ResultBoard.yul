// ResultBoard: the chain's end of experiment 06. It is its own frame-transaction sender and
// payer, and records an FHE result once its VERIFY frame has checked the committee's threshold
// BLS signature over the result.
//
// One result per transaction, exactly:
//
//   frame 0  VERIFY  this contract, scope 3. Its data is the result as the committee signed it:
//
//              request (32) || handle (32) || value (32) || sigma (128, EIP-2537's G1)   224 bytes
//
//   frame 1  SENDER  this contract -> itself, record(bytes32 request, bytes32 handle, uint256
//                    value), the same three words.
//
// The signed message is the committee's fixed format (exp-e2e-frames `committee/bls-committee`):
//
//   message = chain_id (32) || request (32) || handle (32) || value (32)          128 bytes
//
// and sigma must be the committee's signature on it, as Commonware's `ops::verify_message::
// <MinSig>` checks one: H = hash_to_curve(union_unique(NAMESPACE, message)) in G1, RFC 9380's
// BLS12381G1_XMD:SHA-256_SSWU_RO_ suite under the DST below, and e(sigma, -g2) e(H, PK) = 1. The
// check is the ticket paymaster's (kohaku-rs `crates/frame-ticket/contracts/TicketPaymaster.yul`)
// with its namespace and message changed; union_unique is 148 bytes in both, so the layout is the
// same.
//
// The transaction's only EIP-8250 nonce key is the request, at sequence 0: one result per request
// can be included.
//
// VERIFY reads no storage and no balance, calls only precompiles, and forwards gas only as GAS
// immediately before STATICCALL.
//
// initcode = <this object> || PK (256, EIP-2537's encoding of a G2 point)
object "ResultBoard" {
    code {
        let size := datasize("runtime")
        datacopy(0, dataoffset("runtime"), size)
        codecopy(size, sub(codesize(), 256), 256)
        return(0, add(size, 256))
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
                if me { fail() }
                if iszero(eq(txparam(0x09), 2)) { fail() }
                if iszero(eq(frameparam(0x06, me), 3)) { fail() }
                if iszero(eq(calldatasize(), 224)) { fail() }

                // Frame 1: SENDER, to this contract, no value, no flags, record(...) of the same words.
                if iszero(eq(frameparam(0x02, 1), 2)) { fail() }
                if iszero(eq(frameparam(0x00, 1), address())) { fail() }
                if frameparam(0x08, 1) { fail() }
                if frameparam(0x03, 1) { fail() }
                if iszero(eq(frameparam(0x04, 1), 100)) { fail() }
                if iszero(eq(shr(224, framedataload(0, 1)), 0xf3f65e7e)) { fail() }
                for { let i := 0 } lt(i, 3) { i := add(i, 1) } {
                    if iszero(eq(framedataload(add(4, shl(5, i)), 1), calldataload(shl(5, i)))) { fail() }
                }

                // One result per request: the request is the only nonce key, at sequence 0.
                if iszero(eq(txparam(0x0e), 1)) { fail() }
                if txparam(0x01) { fail() }
                mstore(0, 1)
                mstore(0x20, calldataload(0))
                if iszero(eq(keccak256(0, 0x40), txparam(0x0f))) { fail() }

                // A bound on what one result can cost this contract.
                if gt(txparam(0x06), MAX_COST()) { fail() }

                // msg_prime = Z_pad (64) || union_unique(NAMESPACE, message) (148)
                //             || I2OSP(128, 2) || I2OSP(0, 1) || DST_prime (44), at 0x200.
                calldatacopy(0x200, calldatasize(), 64)                 // Z_pad: zeros
                mstore(0x240, shl(248, 19))                             // varint(len(NAMESPACE))
                mstore(0x241, NAMESPACE())                              // 19 bytes, to 0x254
                mstore(0x254, chainid())
                calldatacopy(0x274, 0, 96)                              // request, handle, value
                mstore(0x2d4, shl(240, 0x0080))                         // len_in_bytes = 128
                mstore8(0x2d6, 0)
                mstore(0x2d7, DST1())
                mstore(0x2f7, DST2())
                sha256(0x200, 0x103, 0x100)                             // b_0
                let b0 := mload(0x100)

                // b_i = H(strxor(b_0, b_{i-1}) || I2OSP(i, 1) || DST_prime), uniform at 0x400.
                mstore(0x161, DST1())
                mstore(0x181, DST2())
                let prev := 0
                for { let i := 1 } lt(i, 5) { i := add(i, 1) } {
                    mstore(0x140, xor(b0, prev))
                    mstore8(0x160, i)
                    let out := add(0x400, shl(5, sub(i, 1)))
                    sha256(0x140, 77, out)
                    prev := mload(out)
                }

                // u_j = OS2IP(uniform[64j .. 64j+64]) mod p, then Q_j = map_to_curve(u_j).
                toField(0x400, 0x600)
                toField(0x440, 0x640)
                if iszero(staticcall(gas(), 0x10, 0x600, 64, 0x700, 128)) { fail() }
                if iszero(staticcall(gas(), 0x10, 0x640, 64, 0x780, 128)) { fail() }

                // e(sigma, -g2) e(Q_0 + Q_1, PK) = 1
                calldatacopy(0x900, 96, 128)
                datacopy(0x980, dataoffset("negG2"), 256)
                if iszero(staticcall(gas(), 0x0b, 0x700, 256, 0xa80, 128)) { fail() }
                codecopy(0xb00, sub(codesize(), 256), 256)
                if iszero(staticcall(gas(), 0x0f, 0x900, 0x300, 0x00, 0x20)) { fail() }
                if iszero(eq(mload(0x00), 1)) { fail() }
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

            function sha256(from, len, to) {
                if iszero(staticcall(gas(), 0x02, from, len, to, 32)) { fail() }
            }

            // 64 bytes at `from`, reduced mod p by MODEXP (exponent 1), written at `to` as
            // EIP-2537's 64-byte field element.
            function toField(from, to) {
                mstore(0x500, 64)
                mstore(0x520, 1)
                mstore(0x540, 48)
                mstore(0x560, mload(from))
                mstore(0x580, mload(add(from, 32)))
                mstore8(0x5a0, 1)
                mstore(0x5a1, P1())
                mstore(0x5c1, P2())
                mstore(to, 0)
                if iszero(staticcall(gas(), 0x05, 0x500, 209, add(to, 16), 48)) { fail() }
            }

            function fail() { revert(0, 0) }
            function MAX_COST() -> c { c := 10000000000000000 } // 0.01 ETH
            // "FRAME_FHE_RESULT_V1", left-aligned.
            function NAMESPACE() -> v { v := 0x4652414d455f4648455f524553554c545f563100000000000000000000000000 }
            // "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_POP_" || I2OSP(43, 1), left-aligned.
            function DST1() -> v { v := 0x424c535f5349475f424c53313233383147315f584d443a5348412d3235365f53 }
            function DST2() -> v { v := 0x5357555f524f5f504f505f2b0000000000000000000000000000000000000000 }
            // The base field's modulus p, 48 bytes, left-aligned over two words.
            function P1() -> v { v := 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f624 }
            function P2() -> v { v := 0x1eabfffeb153ffffb9feffffffffaaab00000000000000000000000000000000 }
            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function framedataload(offset, frame) -> v { v := verbatim_2i_1o(hex"b1", offset, frame) }
            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
        }
        // -g2, the negated generator of G2, in EIP-2537's encoding.
        data "negG2" hex"00000000000000000000000000000000024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb80000000000000000000000000000000013e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e000000000000000000000000000000000d1b3cc2c7027888be51d9ef691d77bcb679afda66c73f17f9ee3837a55024f78c71363275a75d75d86bab79f74782aa0000000000000000000000000000000013fa4d4a0ad8b1ce186ed5061789213d993923066dddaf1040bc3ff59f825c78df74f2d75467e25e0f55f8a00fa030ed"
    }
}
