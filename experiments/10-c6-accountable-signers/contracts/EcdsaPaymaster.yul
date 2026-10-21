// EcdsaPaymaster: the control beside the BLS forms. Pays the gas of a frame transaction that k of
// a committee's N members signed with ordinary secp256k1 keys, each signature checked on its own
// with ECRECOVER, the signers named by a bitmap.
//
// Funding: any call with value adds to the float (a multiple of DENOMINATION, or it reverts).
//
// Paying: in a VERIFY frame with scope PAYMENT, the frame's data is
//
//   epoch (8) || salt (32) || bitmap (ceil(N / 8)) || addresses (20 N) || signatures (65 k)
//
// - bitmap: bit i of byte i / 8, least significant first, is member i;
// - addresses: the committee's N addresses in member order; their keccak256 must be COMMIT;
// - signatures: r (32) || s (32) || v (1, 27 or 28) for each named member, in member order, on
//   digest = keccak256(NAMESPACE || message), with s in the lower half of the order.
//
// The message is the ticket's (chain_id || sender || nonce_keys_hash || nonce_seq || epoch ||
// salt, 132 bytes). At least QUORUM members must be named, and the transaction's max cost
// (TXPARAM 0x06) must be at most DENOMINATION. It reads no storage and no balance, and calls only
// precompiles.
//
// initcode = <this object> || COMMIT (32) || QUORUM (32) || N (32) || DENOMINATION (32)
object "EcdsaPaymaster" {
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
                let addrsAt := add(40, b)
                let sigsAt := add(addrsAt, mul(n, 20))
                if lt(calldatasize(), sigsAt) { fail() }

                // digest = keccak256(NAMESPACE (14) || message (132)), at 0x00.
                mstore(0x100, NAMESPACE())
                mstore(0x10e, chainid())
                mstore(0x12e, shl(96, txparam(0x02)))                   // sender
                mstore(0x142, txparam(0x0f))                            // nonce_keys_hash
                mstore(0x162, shl(192, txparam(0x01)))                  // nonce_seq
                calldatacopy(0x16a, 0, 40)                              // epoch, salt
                let digest := keccak256(0x100, 146)

                calldatacopy(0x1000, addrsAt, mul(n, 20))
                if iszero(eq(keccak256(0x1000, mul(n, 20)), commit())) { fail() }

                let k := 0
                for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                    let bit := and(shr(and(i, 7), shr(248, calldataload(add(40, shr(3, i))))), 1)
                    if bit {
                        let at := add(sigsAt, mul(k, 65))
                        let r := calldataload(at)
                        let s := calldataload(add(at, 32))
                        let v := shr(248, calldataload(add(at, 64)))
                        if gt(s, 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0) { fail() }
                        mstore(0x200, digest)
                        mstore(0x220, v)
                        mstore(0x240, r)
                        mstore(0x260, s)
                        mstore(0x280, 0)
                        if iszero(staticcall(gas(), 0x01, 0x200, 128, 0x280, 32)) { fail() }
                        let expected := shr(96, mload(add(0x1000, mul(i, 20))))
                        if iszero(mload(0x280)) { fail() }
                        if iszero(eq(mload(0x280), expected)) { fail() }
                        k := add(k, 1)
                    }
                }
                if lt(k, quorum()) { fail() }
                if iszero(eq(calldatasize(), add(sigsAt, mul(k, 65)))) { fail() }
                approvePayment()
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
            // "FRAME_ECDSA_V1", left-aligned.
            function NAMESPACE() -> v { v := 0x4652414d455f45434453415f5631000000000000000000000000000000000000 }
            function approvePayment() { verbatim_0i_0o(hex"60015f5faa") }
            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
        }
    }
}
