// AccountablePaymaster: pays the gas of a frame transaction that a committee signed and named
// itself in. The ticket paymaster's check, with the group key replaced by the signers' keys: a
// bitmap names which of the committee's N members signed, and their BLS signatures on the
// transaction's own slot are checked under the sum of their keys.
//
// Funding: any call with value adds to the float (a multiple of DENOMINATION, or it reverts).
//
// Paying: in a VERIFY frame with scope PAYMENT, the frame's data is
//
//   epoch (8) || salt (32) || mode (1) || bitmap (ceil(N / 8)) || keys (256 N) || sigs
//
// - bitmap: bit i of byte i / 8, least significant first, is member i;
// - keys: the committee's N public keys in EIP-2537's G2 encoding, in member order; their
//   keccak256 must be COMMIT, so the frame carries them and the code holds one word;
// - mode 0: sigs is one G1 point (128 bytes), the signers' signatures aggregated off chain;
// - mode 1: sigs is one G1 point per signer, in member order, aggregated here.
//
// At least QUORUM members must be named. The message is the ticket's, under its own namespace:
//
//   message = chain_id (32) || sender (20) || nonce_keys_hash (32) || nonce_seq (8)
//             || epoch (8) || salt (32)                                            132 bytes
//
// and sigma must verify as Commonware's `ops::verify_message::<MinSig>` checks one:
// H = hash_to_curve(union_unique(NAMESPACE, message)) in G1, RFC 9380's
// BLS12381G1_XMD:SHA-256_SSWU_RO_ suite under the DST below, and e(sigma, -g2) e(H, sum PK_i) = 1.
// It also requires the transaction's max cost (TXPARAM 0x06) to be at most DENOMINATION.
//
// It reads no storage and no balance, and calls only precompiles.
//
// initcode = <this object> || COMMIT (32) || QUORUM (32) || N (32) || DENOMINATION (32)
object "AccountablePaymaster" {
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
            fund()

            function fund() {
                let d := denomination()
                if iszero(callvalue()) { revert(0, 0) }
                if mod(callvalue(), d) { revert(0, 0) }
                stop()
            }

            function validate(me) {
                if iszero(eq(frameparam(0x06, me), 1)) { fail() }      // scope PAYMENT only
                if gt(txparam(0x06), denomination()) { fail() }
                let n := members()
                let b := shr(3, add(n, 7))
                let keysAt := add(41, b)
                let sigsAt := add(keysAt, mul(n, 256))
                if lt(calldatasize(), sigsAt) { fail() }
                let mode := shr(248, calldataload(40))

                hashToG1()                                              // H at 0xa80

                // The keys, checked against COMMIT, then the signers' sum at 0xc00.
                calldatacopy(0x1000, keysAt, mul(n, 256))
                if iszero(eq(keccak256(0x1000, mul(n, 256)), commit())) { fail() }
                let k := 0
                for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                    let bit := and(shr(and(i, 7), shr(248, calldataload(add(41, shr(3, i))))), 1)
                    if bit {
                        k := add(k, 1)
                        mcopy(0xd00, 0xc00, 256)
                        mcopy(0xe00, add(0x1000, mul(i, 256)), 256)
                        if iszero(staticcall(gas(), 0x0d, 0xd00, 512, 0xc00, 256)) { fail() }
                    }
                }
                if lt(k, quorum()) { fail() }

                // sigma at 0x900.
                switch mode
                case 0 {
                    if iszero(eq(calldatasize(), add(sigsAt, 128))) { fail() }
                    calldatacopy(0x900, sigsAt, 128)
                }
                case 1 {
                    if iszero(eq(calldatasize(), add(sigsAt, mul(k, 128)))) { fail() }
                    for { let j := 0 } lt(j, k) { j := add(j, 1) } {
                        mcopy(0xd00, 0xf00, 128)
                        calldatacopy(0xd80, add(sigsAt, mul(j, 128)), 128)
                        if iszero(staticcall(gas(), 0x0b, 0xd00, 256, 0xf00, 128)) { fail() }
                    }
                    mcopy(0x900, 0xf00, 128)
                }
                default { fail() }

                // e(sigma, -g2) e(H, sum PK_i) = 1
                datacopy(0x980, dataoffset("negG2"), 256)
                mcopy(0xb00, 0xc00, 256)
                if iszero(staticcall(gas(), 0x0f, 0x900, 0x300, 0x00, 0x20)) { fail() }
                if iszero(eq(mload(0x00), 1)) { fail() }
                approvePayment()
            }

            // H = hash_to_curve(union_unique(NAMESPACE, message)), as the ticket paymaster
            // computes it, written at 0xa80 in EIP-2537's encoding.
            function hashToG1() {
                calldatacopy(0x200, calldatasize(), 64)                 // Z_pad: zeros
                mstore(0x240, shl(248, 15))                             // varint(len(NAMESPACE))
                mstore(0x241, NAMESPACE())
                mstore(0x250, chainid())
                mstore(0x270, shl(96, txparam(0x02)))                   // sender
                mstore(0x284, txparam(0x0f))                            // nonce_keys_hash
                mstore(0x2a4, shl(192, txparam(0x01)))                  // nonce_seq
                calldatacopy(0x2ac, 0, 40)                              // epoch, salt
                mstore(0x2d4, shl(240, 0x0080))                         // len_in_bytes = 128
                mstore8(0x2d6, 0)
                mstore(0x2d7, DST1())
                mstore(0x2f7, DST2())
                sha256(0x200, 0x103, 0x100)                             // b_0
                let b0 := mload(0x100)
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
                toField(0x400, 0x600)
                toField(0x440, 0x640)
                if iszero(staticcall(gas(), 0x10, 0x600, 64, 0x700, 128)) { fail() }
                if iszero(staticcall(gas(), 0x10, 0x640, 64, 0x780, 128)) { fail() }
                if iszero(staticcall(gas(), 0x0b, 0x700, 256, 0xa80, 128)) { fail() }
            }

            function sha256(from, len, to) {
                if iszero(staticcall(gas(), 0x02, from, len, to, 32)) { fail() }
            }

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

            function tail(i) -> v {
                codecopy(0, sub(codesize(), sub(128, mul(i, 32))), 32)
                v := mload(0)
            }
            function commit() -> v { v := tail(0) }
            function quorum() -> v { v := tail(1) }
            function members() -> v { v := tail(2) }
            function denomination() -> v { v := tail(3) }
            function fail() { revert(0, 0) }
            // "FRAME_COMMIT_V1", left-aligned.
            function NAMESPACE() -> v { v := 0x4652414d455f434f4d4d49545f56310000000000000000000000000000000000 }
            function DST1() -> v { v := 0x424c535f5349475f424c53313233383147315f584d443a5348412d3235365f53 }
            function DST2() -> v { v := 0x5357555f524f5f504f505f2b0000000000000000000000000000000000000000 }
            function P1() -> v { v := 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f624 }
            function P2() -> v { v := 0x1eabfffeb153ffffb9feffffffffaaab00000000000000000000000000000000 }
            function approvePayment() { verbatim_0i_0o(hex"60015f5faa") }
            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
        }
        data "negG2" hex"00000000000000000000000000000000024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb80000000000000000000000000000000013e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e000000000000000000000000000000000d1b3cc2c7027888be51d9ef691d77bcb679afda66c73f17f9ee3837a55024f78c71363275a75d75d86bab79f74782aa0000000000000000000000000000000013fa4d4a0ad8b1ce186ed5061789213d993923066dddaf1040bc3ff59f825c78df74f2d75467e25e0f55f8a00fa030ed"
    }
}
