// Experiment 19 (X14), run 3: version 5's pool with its funds split across four pots. This contract
// keeps the Keccak tree and takes deposits; it holds no funds and sends no transactions. Each
// deposit inserts its leaf, publishes the new root through EIP-8272 so that a pot's VERIFY can take
// it from the verifier frame, and forwards the denomination to pot leafIndex mod 4. Withdrawals are
// the pots' (Pot.yul), each the sender and payer of its own.
//
// The tree is version 5's: z_0 = keccak256("exp-e2e-frames/19/zero"), z_{i+1} = H(z_i || z_i).
// Storage: 0 leaf count; 2 the current root; 0x100 + level the filled subtrees; 0x200 + j pot j's
// address, set once by setPots. initcode = <this object> || salt, and the EIP-8272 source id is
// keccak256(this || salt).
object "Pool6" {
    code {
        let size := datasize("runtime")
        datacopy(0, dataoffset("runtime"), size)
        codecopy(size, sub(codesize(), 32), 32)
        return(0, add(size, 32))
    }
    object "runtime" {
        code {
            switch shr(224, calldataload(0))
            case 0xb214faa5 { deposit(calldataload(4)) }        // deposit(bytes32)
            case 0xec1eac65 { setPots() }                       // setPots(address[4])
            case 0x8bb852fe { recordRoot(sload(2)) stop() }     // republish()
            case 0xebf0c717 { ret(sload(2)) }                   // root()
            case 0x30e69fc3 { ret(sload(0)) }                   // leafCount()
            default { revert(0, 0) }

            // Once, by whoever calls first: the deployment's own frame transaction calls it in the
            // frame after deploying, so nobody else can.
            function setPots() {
                if sload(0x200) { revert(0, 0) }
                for { let j := 0 } lt(j, 4) { j := add(j, 1) } {
                    let pot := calldataload(add(4, mul(32, j)))
                    if iszero(pot) { revert(0, 0) }
                    sstore(add(0x200, j), pot)
                }
                stop()
            }

            function deposit(c) {
                if iszero(eq(callvalue(), DENOM())) { revert(0, 0) }
                if iszero(sload(0x200)) { revert(0, 0) }
                let index := sload(0)
                if iszero(lt(index, shl(20, 1))) { revert(0, 0) }
                let node := c
                let i := index
                for { let level := 0 } lt(level, 20) { level := add(level, 1) } {
                    switch and(i, 1)
                    case 0 {
                        sstore(add(0x100, level), node)
                        node := h2(node, zero(level))
                    }
                    default { node := h2(sload(add(0x100, level)), node) }
                    i := shr(1, i)
                }
                sstore(2, node)
                sstore(0, add(index, 1))
                recordRoot(node)
                mstore(0, c)
                mstore(0x20, index)
                log1(0, 0x40, 0x98e783c3864bbf744a057ef605a2a61701c3b62b5ed68b3745b99094497daf1f) // Deposit(bytes32 commitment, uint256 leafIndex)
                if iszero(call(gas(), sload(add(0x200, and(index, 3))), DENOM(), 0, 0, 0, 0)) { revert(0, 0) }
                stop()
            }

            // EIP-8272 write: calldata salt || root, source_id = keccak256(this || salt).
            function recordRoot(root) {
                mstore(0, SALT())
                mstore(0x20, root)
                if iszero(call(gas(), 0x8272, 0, 0, 0x40, 0, 0)) { revert(0, 0) }
                mstore(0, root)
                mstore(0x20, slotnum())
                log1(0, 0x40, 0x2fd31368794d8179a2869e743a7fb1d8819c4b52d4154ba95ddbba7cf39a8552) // RecentRoot(bytes32 root, uint64 slot)
            }
            function h2(a, b) -> r {
                mstore(0, a)
                mstore(0x20, b)
                r := keccak256(0, 0x40)
            }
            function zero(level) -> z {
                z := 0xd60aeb146bd0a6ecc9c4f92151f04884e5f15c71c8dd06bf85a7479552c55d02 // keccak256("exp-e2e-frames/19/zero")
                for { let l := 0 } lt(l, level) { l := add(l, 1) } { z := h2(z, z) }
            }
            function DENOM() -> v { v := 1000000000000000 }
            function SALT() -> v {
                codecopy(0x60, sub(codesize(), 32), 32)
                v := mload(0x60)
            }
            function ret(v) {
                mstore(0, v)
                return(0, 0x20)
            }
            function slotnum() -> v { v := verbatim_0i_1o(hex"4b") }
        }
    }
}
