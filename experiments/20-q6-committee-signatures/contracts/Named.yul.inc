            // ---- the committee's named signatures (experiment 20) ----
            //
            // At least QUORUM() EIP-8288 dependency triples (0x10, digest, key), each key a
            // distinct member's, in increasing member order, read from frame f at offset `at` to
            // the end of its data. The block's recursive proof, leanVM's aggregation, makes every
            // declared triple true; this only checks that they are the committee's, on `digest`.
            function named(digest, f, at) {
                let len := frameparam(0x04, f)
                if lt(len, at) { revert(0, 0) }
                let bytes := sub(len, at)
                if mod(bytes, 96) { revert(0, 0) }
                let count := div(bytes, 96)
                if lt(count, QUORUM()) { revert(0, 0) }
                let next := 0
                for { let j := 0 } lt(j, count) { j := add(j, 1) } {
                    let o := add(at, mul(j, 96))
                    if iszero(eq(framedataload(o, f), 0x10)) { revert(0, 0) }
                    if iszero(eq(framedataload(add(o, 32), f), digest)) { revert(0, 0) }
                    let i := memberIndex(framedataload(add(o, 64), f))
                    if lt(i, next) { revert(0, 0) }
                    next := add(i, 1)
                }
            }

            // The member whose leanSPHINCS key is k; reverts for a key outside the committee.
            function memberIndex(k) -> i {
                let n := MEMBERS()
                for { i := 0 } lt(i, n) { i := add(i, 1) } {
                    if eq(memberKey(i), k) { leave }
                }
                revert(0, 0)
            }

            // The committee, ending COMMITTEE_END() bytes before the end of the code:
            // key 0 .. key n-1 (32 each), QUORUM, MEMBERS.
            function MEMBERS() -> v { v := tailWord(add(COMMITTEE_END(), 32)) }
            function QUORUM() -> v { v := tailWord(add(COMMITTEE_END(), 64)) }
            function memberKey(i) -> v {
                if iszero(lt(i, MEMBERS())) { revert(0, 0) }
                v := tailWord(add(add(COMMITTEE_END(), 64), shl(5, sub(MEMBERS(), i))))
            }
            function tailWord(fromEnd) -> v {
                codecopy(0x1e0, sub(codesize(), fromEnd), 32)
                v := mload(0x1e0)
            }
