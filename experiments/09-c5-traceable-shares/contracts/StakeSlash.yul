// StakeSlash: n holders' stakes, slashed by evidence the contract checks itself.
//
// Created with root || n || depth appended to this code, and the stakes as its value, split
// evenly among the n holders. root is the Merkle root over the leaves keccak256(i || u_i), where
// u_i = keccak256(x_i) is holder i's key component, padded with zero leaves to 2^depth.
//
// Calldata of 32 bytes: i; returns holder i's stake.
// Otherwise, slash: k || k entries of (i || w || depth siblings, leaf first). For each entry the
// contract computes u = keccak256(w), walks the path from keccak256(i || u) by the bits of i, and
// requires the root; then it pays every named holder's stake to the caller. Any entry that does
// not open the root reverts the whole call: w is a root of the traced polynomial and the
// preimage of u_i, which only holder i's point, given to it alone, can be.
object "StakeSlash" {
    code {
        codecopy(0, sub(codesize(), 96), 96)
        let n := mload(32)
        if or(iszero(n), gt(mload(64), 32)) { revert(0, 0) }
        sstore(0, mload(0))
        sstore(1, n)
        sstore(2, mload(64))
        let stake := div(callvalue(), n)
        for { let i := 0 } lt(i, n) { i := add(i, 1) } { sstore(add(3, i), stake) }
        datacopy(0, dataoffset("runtime"), datasize("runtime"))
        return(0, datasize("runtime"))
    }
    object "runtime" {
        code {
            if callvalue() { revert(0, 0) }
            let n := sload(1)
            if eq(calldatasize(), 32) {
                let i := calldataload(0)
                if iszero(lt(i, n)) { revert(0, 0) }
                mstore(0, sload(add(3, i)))
                return(0, 32)
            }
            let root := sload(0)
            let depth := sload(2)
            let k := calldataload(0)
            let entry := mul(32, add(2, depth))
            if or(iszero(k), gt(k, n)) { revert(0, 0) }
            if iszero(eq(calldatasize(), add(32, mul(k, entry)))) { revert(0, 0) }
            let total := 0
            let p := 32
            for { let j := 0 } lt(j, k) { j := add(j, 1) } {
                let i := calldataload(p)
                if iszero(lt(i, n)) { revert(0, 0) }
                mstore(0, calldataload(add(p, 32)))
                mstore(32, keccak256(0, 32))
                mstore(0, i)
                let node := keccak256(0, 64)
                let q := add(p, 64)
                for { let d := 0 } lt(d, depth) { d := add(d, 1) } {
                    let sibling := calldataload(add(q, mul(d, 32)))
                    switch and(shr(d, i), 1)
                    case 0 { mstore(0, node) mstore(32, sibling) }
                    default { mstore(0, sibling) mstore(32, node) }
                    node := keccak256(0, 64)
                }
                if iszero(eq(node, root)) { revert(0, 0) }
                let slot := add(3, i)
                total := add(total, sload(slot))
                sstore(slot, 0)
                mstore(0, i)
                // Slashed(uint256 holder)
                log1(0, 32, 0x0a6331e5cfe25333c065863fddcbcd3c103d07a3aaa549b327736ccb1e7b3cab)
                p := add(q, mul(depth, 32))
            }
            if iszero(total) { revert(0, 0) }
            if iszero(call(gas(), caller(), total, 0, 0, 0, 0)) { revert(0, 0) }
        }
    }
}
