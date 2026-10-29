// Registry: notes of ether and of a token in one tree, its own frame-transaction sender, and a
// bridge out to public contracts and back (experiment 15).
//
// A note is a leaf H(tag, inner, value) of Tornado Cash's height-20 MiMC tree: `tag` is the
// asset (ETH_TAG for ether, else a token's address), `inner` = H(nullifierSecret, secret) the
// owner's, `value` a 64-bit amount the registry holds. Spending reveals H(tag, nullifierSecret).
// This is exp-frames experiment 32's registry, with three changes:
//
//   - an export: a spend may send its amount to a destination's `onPrivateExport(bytes)`, which
//     comes back in the same transaction through `completeImport(uint256)` (R1 to R3), or through
//     `registerImportReceipt(address,bytes32,bytes32)` and a later claim (R0);
//   - a refund: an export runs inside a call to this registry that reverts unless it came back,
//     and if it reverts the registry adds the refund note the proof bound instead;
//   - two ways to add a leaf, fixed at deployment: MODE 0 inserts it into the tree on chain, as
//     experiment 32 does; MODE 1 appends it to an accumulator, acc <- keccak256(acc || leaf), and
//     a batch proof advances the root every 8 leaves.
//
// Every transaction it sends is an EIP-8141 frame transaction with tx.sender = this registry and
// no signature. Layouts, exactly:
//
//   spend, round   0 VERIFY 0x8272 (source_id || slot || root)   1 VERIFY this, scope 3
//                  2 SENDER this: processPrivateTransaction(bytes32 root, uint256 kind, uint256[] w)
//                  nonce keys: the nullifiers, ascending, at sequence 0
//   claim (R0)     0 VERIFY this, scope 3   1 SENDER this: processPrivateTransaction(0, 2, w)
//                  nonce key: the receipt's id
//   batch (MODE 1) 0 VERIFY this, scope 3   1 SENDER this: advanceRoot(uint256[] w)
//                  nonce key: 2^255 + the batch's first index
//
// kind 1, a spend (19 words):
//   0 nullifier  1 tag  2 amountOut  3 changeCommitment  4 refundCommitment
//   5 how: 0 payout, 1 export completed by call-back, 2 export completed by a receipt
//   6 recipient or destination  7 fee  8 tagOut  9 partial (how 1: innerOut; how 2: H(tagOut, innerOut))
//   10 minOut  11-18 proof
//   binding = keccak256(w[5..10]) >> 8; kernel inputs: root, nullifier, tag, amountOut, change, refund, binding
// kind 2, a claim of a receipt (13 words):
//   0 receiptId  1 partial  2 tagOut  3 value  4 newCommitment  5-12 proof
//   receiptId = keccak256(partial || value || tagOut); import inputs: partial, tagOut, value, newCommitment
// kind 3, a round of four notes of one denomination (26 words):
//   0-3 nullifiers  4-7 partialInners  8-11 refundCommitments  12 tag  13 denomination
//   14 destination  15 fee  16 tagOut  17 minOut (total)  18-25 proof
//   binding = keccak256(w[14..17]) >> 8; round inputs: root, denomination, tag, nullifiers,
//   partialInners, refundCommitments, binding
// a batch (18 words): 0 startIndex  1 newRoot  2-9 leaves  10-17 proof
//   batch inputs: oldRoot, newRoot, startIndex, leaves
//
// VERIFY reads nothing outside this registry: roots come through frame 0, spent notes are used
// nonce keys, and a claim or a batch reads only this registry's own storage. The registry pays
// every transaction it sends. A spend of ether pays a fee that covers it; the rest (token spends,
// claims, batches, failed exports) are paid from a float the registry is given.
//
// initcode = <this object> || vRound || vBatch || vImport || vKernel || hasher || mode || salt
// (words appended to the deployed code and read back from its end).
object "Registry" {
    code {
        let size := datasize("runtime")
        datacopy(0, dataoffset("runtime"), size)
        codecopy(size, sub(codesize(), 224), 224)
        // MODE 1 starts from the empty tree's root, which it publishes when the first batch lands.
        if eq(word(64), 1) { sstore(2, EMPTY_ROOT()) }
        return(0, add(size, 224))

        function word(fromEnd) -> v {
            codecopy(0, sub(codesize(), fromEnd), 32)
            v := mload(0)
        }
        function EMPTY_ROOT() -> r { r := 0x29d7ed391256ccc3ea596c86e933b89ff339d25ea8ddced975ae2fe30b5296d4 }
    }
    object "runtime" {
        code {
            // ENTRY_POINT (0xaa) calls in DEFAULT and VERIFY frames. Only VERIFY does anything.
            if eq(caller(), 0xaa) {
                let frame := txparam(0x0a)
                if eq(frameparam(0x02, frame), 1) { validate(frame) }
                stop()
            }

            // Plain ether tops up the float the registry pays gas from.
            if iszero(calldatasize()) { stop() }

            switch shr(224, calldataload(0))
            case 0xb214faa5 { deposit(calldataload(4)) }        // deposit(bytes32)
            case 0x9d1cb51f { process() }                       // processPrivateTransaction(bytes32,uint256,uint256[])
            case 0x606890e8 { advance() }                       // advanceRoot(uint256[])
            case 0x04db602d { exportInner() }                   // exportInner()
            case 0x73f16533 { completeImport(calldataload(4)) } // completeImport(uint256)
            case 0xe2affc47 { registerImportReceipt(calldataload(4), calldataload(0x24), calldataload(0x44)) } // registerImportReceipt(address,bytes32,bytes32)
            case 0x1e83409a { claim(calldataload(4)) }          // claim(address)
            case 0x8bb852fe { republish() }                     // republish()
            case 0xebf0c717 { ret(sload(2)) }                   // root()
            case 0x30e69fc3 { ret(sload(0)) }                   // leafCount()
            case 0x277f13d6 { ret(sload(1)) }                   // batchedCount()
            case 0x03381154 { ret(sload(3)) }                   // accumulator()
            case 0x72a41fdd { ret(sload(mapslot(calldataload(4), 7))) } // receiptOf(bytes32)
            case 0xdf18e047 { ret(sload(mapslot(calldataload(4), 6))) } // owed(address)
            case 0xd069aab9 { ret(sourceId()) }                 // sourceId()
            case 0x295a5212 { ret(MODE()) }                     // mode()
            default { revert(0, 0) }

            // ---- VERIFY ----

            function validate(me) {
                if iszero(eq(frameparam(0x06, me), 3)) { revert(0, 0) }
                let frames := txparam(0x09)
                // The SENDER frame follows this one and is the last: one extra frame running as
                // the registry could move every note's funds.
                let s := add(me, 1)
                if iszero(eq(frames, add(s, 1))) { revert(0, 0) }
                if iszero(eq(frameparam(0x02, s), 2)) { revert(0, 0) }
                if iszero(eq(frameparam(0x00, s), address())) { revert(0, 0) }
                if frameparam(0x08, s) { revert(0, 0) }
                if frameparam(0x03, s) { revert(0, 0) }
                if txparam(0x01) { revert(0, 0) }
                let selector := shr(224, framedataload(0, s))
                switch me
                case 1 {
                    // spend or round: frame 0 is the EIP-8272 verifier frame.
                    if iszero(eq(selector, 0x9d1cb51f)) { revert(0, 0) }
                    let root := framedataload(0x04, s)
                    if iszero(eq(frameparam(0x00, 0), 0x8272)) { revert(0, 0) }
                    if iszero(eq(frameparam(0x02, 0), 1)) { revert(0, 0) }
                    if frameparam(0x03, 0) { revert(0, 0) }
                    if iszero(eq(frameparam(0x04, 0), 72)) { revert(0, 0) }
                    if iszero(eq(framedataload(0, 0), sourceId())) { revert(0, 0) }
                    if iszero(eq(framedataload(40, 0), root)) { revert(0, 0) }
                    let kind := framedataload(0x24, s)
                    switch kind
                    case 1 { validateSpend(s, root) }
                    case 3 { validateRound(s, root) }
                    default { revert(0, 0) }
                }
                case 0 {
                    switch selector
                    case 0x9d1cb51f {
                        if iszero(eq(framedataload(0x24, s), 2)) { revert(0, 0) }
                        validateClaim(s)
                    }
                    case 0x606890e8 { validateBatch(s) }
                    default { revert(0, 0) }
                }
                default { revert(0, 0) }
                approve(3)
            }

            // processPrivateTransaction(root, kind, w): w's length at 0x64, its words from 0x84.
            function checkWords(s, n) {
                if iszero(eq(framedataload(0x44, s), 0x60)) { revert(0, 0) }
                if iszero(eq(framedataload(0x64, s), n)) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, s), add(0x84, shl(5, n)))) { revert(0, 0) }
            }
            function w(s, i) -> v { v := framedataload(add(0x84, shl(5, i)), s) }
            function fw(s, i) -> v {
                v := w(s, i)
                if iszero(lt(v, FIELD())) { revert(0, 0) }
            }

            // The nonce keys are exactly `keys` (in memory at 0x420.., `n` of them), at sequence 0:
            // EIP-8250's nonce_keys_hash = keccak256(len || keys).
            function checkKeys(n) {
                if iszero(eq(txparam(0x0e), n)) { revert(0, 0) }
                mstore(0x400, n)
                if iszero(eq(keccak256(0x400, shl(5, add(n, 1))), txparam(0x0f))) { revert(0, 0) }
            }

            function validateSpend(s, root) {
                checkWords(s, 19)
                let nullifier := fw(s, 0)
                let tag := w(s, 1)
                let amountOut := w(s, 2)
                let how := w(s, 5)
                let to := w(s, 6)
                let fee := w(s, 7)
                let tagOut := w(s, 8)
                if or(shr(160, tag), shr(160, to)) { revert(0, 0) }
                if shr(160, tagOut) { revert(0, 0) }
                if shr(64, amountOut) { revert(0, 0) }
                if gt(how, 2) { revert(0, 0) }
                if iszero(amountOut) { revert(0, 0) }
                if how {
                    // An export: of ether only, with a refund note and an asset to come back.
                    if iszero(eq(tag, ETH_TAG())) { revert(0, 0) }
                    if iszero(fw(s, 4)) { revert(0, 0) }
                    if iszero(tagOut) { revert(0, 0) }
                    if iszero(fw(s, 9)) { revert(0, 0) }
                }
                if eq(tag, ETH_TAG()) {
                    if gt(fee, amountOut) { revert(0, 0) }
                    if lt(fee, txparam(0x06)) { revert(0, 0) }
                }
                mstore(0x420, nullifier)
                checkKeys(1)

                // The kernel proof against its seven inputs.
                let p := 0x80
                framedatacopy(p, add(0x84, shl(5, 11)), 256, s)
                mstore(add(p, 0x100), root)
                mstore(add(p, 0x120), nullifier)
                mstore(add(p, 0x140), tag)
                mstore(add(p, 0x160), amountOut)
                mstore(add(p, 0x180), fw(s, 3))
                mstore(add(p, 0x1a0), fw(s, 4))
                framedatacopy(0x300, add(0x84, shl(5, 5)), 192, s)
                mstore(add(p, 0x1c0), shr(8, keccak256(0x300, 192)))
                verify(V_KERNEL(), p, 0x1e0)

                // So that nobody can starve frame 2 after the nonce key is used: its bookkeeping and
                // change note; for an export, the call, the call-back's note, and the refund
                // note's reserve, which the export cannot spend.
                let exec := add(FLOOR_SPEND(), LEAF_EXECUTION())
                let state := add(NEW_ACCOUNT_STATE(), mul(LEAF_SLOTS(), SLOT_STATE()))
                if how {
                    exec := add(exec, add(FLOOR_EXPORT(), add(COMPLETE_EXECUTION(), mul(2, LEAF_EXECUTION()))))
                    state := add(state, mul(add(3, mul(2, LEAF_SLOTS())), SLOT_STATE()))
                }
                if lt(frameparam(0x01, s), exec) { revert(0, 0) }
                if lt(frameparam(0x09, s), state) { revert(0, 0) }
            }

            function validateRound(s, root) {
                checkWords(s, 26)
                let tag := w(s, 12)
                let denomination := w(s, 13)
                let destination := w(s, 14)
                let fee := w(s, 15)
                let tagOut := w(s, 16)
                if iszero(eq(tag, ETH_TAG())) { revert(0, 0) }
                if or(shr(160, destination), shr(160, tagOut)) { revert(0, 0) }
                if iszero(tagOut) { revert(0, 0) }
                if or(iszero(denomination), shr(64, denomination)) { revert(0, 0) }
                if gt(fee, mul(4, denomination)) { revert(0, 0) }
                if lt(fee, txparam(0x06)) { revert(0, 0) }
                let prev := 0
                for { let i := 0 } lt(i, 4) { i := add(i, 1) } {
                    let n := fw(s, i)
                    if i { if iszero(gt(n, prev)) { revert(0, 0) } }
                    prev := n
                    mstore(add(0x420, shl(5, i)), n)
                }
                checkKeys(4)

                // The round proof against its sixteen inputs.
                let p := 0x80
                framedatacopy(p, add(0x84, shl(5, 18)), 256, s)
                mstore(add(p, 0x100), root)
                mstore(add(p, 0x120), denomination)
                mstore(add(p, 0x140), tag)
                for { let i := 0 } lt(i, 12) { i := add(i, 1) } {
                    mstore(add(p, add(0x160, shl(5, i))), fw(s, i))
                }
                framedatacopy(0x600, add(0x84, shl(5, 14)), 128, s)
                mstore(add(p, 0x2e0), shr(8, keccak256(0x600, 128)))
                verify(V_ROUND(), p, 0x300)

                let exec := add(add(FLOOR_SPEND(), FLOOR_EXPORT()), mul(4, add(COMPLETE_EXECUTION(), mul(2, LEAF_EXECUTION()))))
                let state := mul(add(3, mul(8, LEAF_SLOTS())), SLOT_STATE())
                if lt(frameparam(0x01, s), exec) { revert(0, 0) }
                if lt(frameparam(0x09, s), state) { revert(0, 0) }
            }

            function validateClaim(s) {
                checkWords(s, 13)
                let id := w(s, 0)
                let partial := fw(s, 1)
                let tagOut := w(s, 2)
                let value := w(s, 3)
                if shr(160, tagOut) { revert(0, 0) }
                if shr(64, value) { revert(0, 0) }
                mstore(0x300, partial)
                mstore(0x320, value)
                mstore(0x340, tagOut)
                if iszero(eq(id, keccak256(0x300, 0x60))) { revert(0, 0) }
                if iszero(eq(sload(mapslot(id, 7)), 1)) { revert(0, 0) }
                mstore(0x420, id)
                checkKeys(1)

                let p := 0x80
                framedatacopy(p, add(0x84, shl(5, 5)), 256, s)
                mstore(add(p, 0x100), partial)
                mstore(add(p, 0x120), tagOut)
                mstore(add(p, 0x140), value)
                mstore(add(p, 0x160), fw(s, 4))
                verify(V_IMPORT(), p, 0x180)

                if lt(frameparam(0x01, s), add(FLOOR_SPEND(), LEAF_EXECUTION())) { revert(0, 0) }
                if lt(frameparam(0x09, s), mul(LEAF_SLOTS(), SLOT_STATE())) { revert(0, 0) }
            }

            // advanceRoot(w): w's length at 0x24, its words from 0x44.
            function validateBatch(s) {
                if iszero(eq(MODE(), 1)) { revert(0, 0) }
                if iszero(eq(framedataload(0x04, s), 0x20)) { revert(0, 0) }
                if iszero(eq(framedataload(0x24, s), 18)) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, s), add(0x44, shl(5, 18)))) { revert(0, 0) }
                let start := framedataload(0x44, s)
                let newRoot := framedataload(0x64, s)
                if iszero(lt(newRoot, FIELD())) { revert(0, 0) }
                // The next batch, complete, and not so far behind that its checkpoints are gone.
                if iszero(eq(start, sload(1))) { revert(0, 0) }
                let count := sload(0)
                if lt(count, add(start, 8)) { revert(0, 0) }
                if gt(sub(count, start), 120) { revert(0, 0) }
                // The leaves are the accumulator's, from the checkpoint before them to the one after.
                let b := shr(3, start)
                let c := sload(add(0x200, and(b, 15)))
                for { let i := 0 } lt(i, 8) { i := add(i, 1) } {
                    let leaf := framedataload(add(0x84, shl(5, i)), s)
                    if iszero(lt(leaf, FIELD())) { revert(0, 0) }
                    mstore(0, c)
                    mstore(0x20, leaf)
                    c := keccak256(0, 0x40)
                }
                if iszero(eq(c, sload(add(0x200, and(add(b, 1), 15))))) { revert(0, 0) }
                mstore(0x420, or(shl(255, 1), start))
                checkKeys(1)

                let p := 0x80
                framedatacopy(p, add(0x44, shl(5, 10)), 256, s)
                mstore(add(p, 0x100), sload(2))
                mstore(add(p, 0x120), newRoot)
                mstore(add(p, 0x140), start)
                framedatacopy(add(p, 0x160), 0x84, 256, s)
                verify(V_BATCH(), p, 0x260)

                if lt(frameparam(0x01, s), FLOOR_BATCH()) { revert(0, 0) }
            }

            // A Groth16 check: the proof and inputs at p, `len` bytes, against verifier `v`.
            // `gas()` is evaluated last, so GAS sits immediately before STATICCALL.
            function verify(v, p, len) {
                if iszero(staticcall(gas(), v, p, len, 0, 0x20)) { revert(0, 0) }
                if iszero(and(eq(returndatasize(), 0x20), eq(mload(0), 1))) { revert(0, 0) }
            }

            // ---- SENDER ----

            function process() {
                // Only a SENDER frame of a transaction this registry approved has it as caller.
                if iszero(eq(caller(), address())) { revert(0, 0) }
                if tload(T_INEXPORT()) { revert(0, 0) }
                switch calldataload(0x24)
                case 1 { spend() }
                case 2 { claimReceipt() }
                case 3 { round() }
                default { revert(0, 0) }
                if tload(T_INSERTED()) { recordRoot(sload(2)) }
                stop()
            }

            function cw(i) -> v { v := calldataload(add(0x84, shl(5, i))) }

            function spend() {
                let nullifier := cw(0)
                let tag := cw(1)
                let amountOut := cw(2)
                let change := cw(3)
                let how := cw(5)
                let to := cw(6)
                let fee := cw(7)
                if change { addLeaf(change) }
                switch how
                case 0 {
                    switch eq(tag, ETH_TAG())
                    case 1 {
                        // A reverting recipient is credited instead, so nothing below can revert.
                        let amount := sub(amountOut, fee)
                        if amount {
                            if iszero(call(PAYOUT_STIPEND(), to, amount, 0, 0, 0, 0)) { credit(to, amount) }
                        }
                    }
                    default {
                        mstore(0, shl(224, 0xa9059cbb))   // transfer(address,uint256)
                        mstore(0x04, to)
                        mstore(0x24, amountOut)
                        if iszero(call(PAYOUT_STIPEND(), tag, 0, 0, 0x44, 0, 0x20)) { revert(0, 0) }
                    }
                }
                default {
                    // exportInner(how, to, amountOut - fee, tagOut, minOut, 1, partial)
                    let ok := export(how, to, sub(amountOut, fee), cw(8), cw(10), 1, add(0x84, shl(5, 9)))
                    if iszero(ok) {
                        let refund := cw(4)
                        addLeaf(refund)
                        mstore(0, refund)
                        log2(0, 0x20, 0x007c875846b687732a7579c19bb1dade66cd14e9f4f809565e2b2b5e76c72b4f, nullifier) // Refunded(bytes32 indexed nullifier, bytes32 refund)
                    }
                }
                mstore(0, tag)
                mstore(0x20, amountOut)
                mstore(0x40, how)
                mstore(0x60, to)
                log2(0, 0x80, 0x8e667e46dcc55e0dfd3884d12e4b3a607c9038daa6a677b1668332f473418526, nullifier) // Spent(bytes32 indexed nullifier, address tag, uint256 amountOut, uint256 how, address to)
            }

            function round() {
                let denomination := cw(13)
                let fee := cw(15)
                let ok := export(1, cw(14), sub(mul(4, denomination), fee), cw(16), cw(17), 4, add(0x84, shl(5, 4)))
                for { let i := 0 } lt(i, 4) { i := add(i, 1) } {
                    let nullifier := cw(i)
                    if iszero(ok) {
                        let refund := cw(add(8, i))
                        addLeaf(refund)
                        mstore(0, refund)
                        log2(0, 0x20, 0x007c875846b687732a7579c19bb1dade66cd14e9f4f809565e2b2b5e76c72b4f, nullifier)
                    }
                    mstore(0, ETH_TAG())
                    mstore(0x20, denomination)
                    mstore(0x40, 1)
                    mstore(0x60, cw(14))
                    log2(0, 0x80, 0x8e667e46dcc55e0dfd3884d12e4b3a607c9038daa6a677b1668332f473418526, nullifier)
                }
            }

            // The export, as a call to this registry that reverts unless the destination came
            // back: the destination's state, the ether sent and any leaf the call-back added all
            // unwind with it. `partials` is where the n partial notes sit in this calldata.
            function export(how, destination, amount, tagOut, minOut, n, partials) -> ok {
                let p := 0x200
                mstore(p, shl(224, 0x04db602d))   // exportInner()
                mstore(add(p, 0x04), how)
                mstore(add(p, 0x24), destination)
                mstore(add(p, 0x44), amount)
                mstore(add(p, 0x64), tagOut)
                mstore(add(p, 0x84), minOut)
                mstore(add(p, 0xa4), n)
                calldatacopy(add(p, 0xc4), partials, shl(5, n))
                // The refund notes' gas is held back, so a destination that burns all it is given
                // still leaves enough to add them.
                let reserve := add(20000, mul(n, LEAF_EXECUTION()))
                if lt(gas(), add(reserve, 100000)) { revert(0, 0) }
                tstore(T_INEXPORT(), 1)
                ok := call(sub(gas(), reserve), address(), 0, p, add(0xc4, shl(5, n)), 0, 0)
                tstore(T_INEXPORT(), 0)
            }

            function exportInner() {
                if iszero(eq(caller(), address())) { revert(0, 0) }
                if iszero(tload(T_INEXPORT())) { revert(0, 0) }
                let how := calldataload(0x04)
                let destination := calldataload(0x24)
                let amount := calldataload(0x44)
                let tagOut := calldataload(0x64)
                let n := calldataload(0xa4)
                tstore(T_EXPECT(), destination)
                tstore(T_HOW(), how)
                tstore(T_TAGOUT(), tagOut)
                tstore(T_MIN(), calldataload(0x84))
                tstore(T_N(), n)
                for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                    tstore(add(T_PARTIAL(), i), calldataload(add(0xc4, shl(5, i))))
                }
                tstore(T_BAL(), balanceOf(tagOut))
                tstore(T_DONE(), 0)

                // onPrivateExport(bytes payload), payload = minOut || how || partial 0
                let p := 0x200
                mstore(p, shl(224, 0x747d295f))
                mstore(add(p, 0x04), 0x20)
                mstore(add(p, 0x24), 0x60)
                mstore(add(p, 0x44), calldataload(0x84))
                mstore(add(p, 0x64), how)
                mstore(add(p, 0x84), calldataload(0xc4))
                if iszero(call(gas(), destination, amount, p, 0xa4, 0, 0)) { revert(0, 0) }
                if iszero(eq(tload(T_DONE()), 1)) { revert(0, 0) }
                tstore(T_EXPECT(), 0)
                stop()
            }

            // How 1: the destination's call-back, once, inside its own export, with the token
            // already paid in. Each of the n partial notes gets value / n.
            function completeImport(value) {
                let tagOut := checkCallback(1, value)
                let n := tload(T_N())
                let share := div(value, n)
                if shr(64, share) { revert(0, 0) }
                for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                    let partial := tload(add(T_PARTIAL(), i))
                    let leaf := hash3(tagOut, partial, share)
                    addLeaf(leaf)
                    mstore(0, share)
                    mstore(0x20, leaf)
                    log2(0, 0x40, 0x546c7fb28d54eda722dcc0e84dc66a5a5a3c954e0683508efd072e400b09eebf, partial) // ImportCompleted(bytes32 indexed partial, uint256 value, bytes32 leaf)
                }
                tstore(T_DONE(), 1)
                stop()
            }

            // How 2: the draft standard's receipt, for one partial note: H(tagOut, innerOut).
            function registerImportReceipt(depositor, value, commitmentHash) {
                let tagOut := checkCallback(2, value)
                if iszero(eq(commitmentHash, tload(T_PARTIAL()))) { revert(0, 0) }
                if shr(64, value) { revert(0, 0) }
                mstore(0x300, commitmentHash)
                mstore(0x320, value)
                mstore(0x340, tagOut)
                let id := keccak256(0x300, 0x60)
                let slot := mapslot(id, 7)
                if sload(slot) { revert(0, 0) }
                sstore(slot, 1)
                mstore(0, value)
                mstore(0x20, commitmentHash)
                // ImportReceiptCreated(bytes32 indexed receiptId, address indexed sourceContract,
                //   address indexed depositor, bytes32 value, bytes32 commitmentHash)
                log4(0, 0x40, 0x297e502adf01e1ce1621428f1043d9359e6a2f7d5a119d76ddf7f7581bc6b82a, id, caller(), depositor)
                tstore(T_DONE(), 1)
                mstore(0, id)
                return(0, 0x20)
            }

            function checkCallback(how, value) -> tagOut {
                if iszero(tload(T_INEXPORT())) { revert(0, 0) }
                if iszero(eq(caller(), tload(T_EXPECT()))) { revert(0, 0) }
                if iszero(eq(tload(T_HOW()), how)) { revert(0, 0) }
                if tload(T_DONE()) { revert(0, 0) }
                if lt(value, tload(T_MIN())) { revert(0, 0) }
                tagOut := tload(T_TAGOUT())
                if lt(sub(balanceOf(tagOut), tload(T_BAL())), value) { revert(0, 0) }
            }

            function claimReceipt() {
                let id := cw(0)
                sstore(mapslot(id, 7), 2)
                let leaf := cw(4)
                addLeaf(leaf)
                mstore(0, leaf)
                log2(0, 0x20, 0x5fe8c6e21967c9ce615cd23e9ec2c6a01599e7d17a6fd793a2baab9160cffd89, id) // ReceiptClaimed(bytes32 indexed receiptId, bytes32 leaf)
            }

            function advance() {
                if iszero(eq(caller(), address())) { revert(0, 0) }
                let start := calldataload(0x44)
                let newRoot := calldataload(0x64)
                sstore(2, newRoot)
                sstore(1, add(start, 8))
                recordRoot(newRoot)
                stop()
            }

            function credit(who, amount) {
                let s := mapslot(who, 6)
                sstore(s, add(sload(s), amount))
            }

            function claim(who) {
                let s := mapslot(who, 6)
                let amount := sload(s)
                sstore(s, 0)
                if iszero(call(gas(), who, amount, 0, 0, 0, 0)) { revert(0, 0) }
                stop()
            }

            // ---- deposits and leaves ----

            function deposit(inner) {
                let value := callvalue()
                if or(iszero(value), shr(64, value)) { revert(0, 0) }
                if iszero(lt(inner, FIELD())) { revert(0, 0) }
                addLeaf(hash3(ETH_TAG(), inner, value))
                if tload(T_INSERTED()) { recordRoot(sload(2)) }
                stop()
            }

            function addLeaf(leaf) {
                let index := sload(0)
                if iszero(lt(index, shl(20, 1))) { revert(0, 0) }
                switch MODE()
                case 0 {
                    // Tornado's MerkleTreeWithHistory._insert.
                    let node := leaf
                    let i := index
                    for { let level := 0 } lt(level, 20) { level := add(level, 1) } {
                        switch and(i, 1)
                        case 0 {
                            sstore(add(0x100, level), node)
                            node := hashLeftRight(node, zero(level))
                        }
                        default {
                            node := hashLeftRight(sload(add(0x100, level)), node)
                        }
                        i := shr(1, i)
                    }
                    sstore(2, node)
                    tstore(T_INSERTED(), 1)
                }
                default {
                    mstore(0, sload(3))
                    mstore(0x20, leaf)
                    let acc := keccak256(0, 0x40)
                    sstore(3, acc)
                    let count := add(index, 1)
                    if iszero(and(count, 7)) { sstore(add(0x200, and(shr(3, count), 15)), acc) }
                }
                sstore(0, add(index, 1))
                mstore(0, leaf)
                mstore(0x20, index)
                log1(0, 0x40, 0x586ff868e93f6e68d3b017e356aa8fc4aadc957e509c327e48e4c75f282a0537) // CommitmentAppended(bytes32 leaf, uint256 index)
            }

            // One MiMC permutation of the deployed hasher: (xL, xR) -> (xL, xR) at 0 and 0x20.
            function permute(xL, xR) {
                mstore(0, shl(224, 0xf47d33b5))   // MiMCSponge(uint256,uint256)
                mstore(0x04, xL)
                mstore(0x24, xR)
                if iszero(staticcall(gas(), HASHER(), 0, 0x44, 0, 0x40)) { revert(0, 0) }
            }
            function hashLeftRight(left, right) -> r {
                permute(left, 0)
                permute(addmod(mload(0), right, FIELD()), mload(0x20))
                r := mload(0)
            }
            // circomlib's MiMCSponge(3, 220, 1), key 0.
            function hash3(a, b, c) -> r {
                permute(a, 0)
                permute(addmod(mload(0), b, FIELD()), mload(0x20))
                permute(addmod(mload(0), c, FIELD()), mload(0x20))
                r := mload(0)
            }

            function balanceOf(tag) -> b {
                switch eq(tag, ETH_TAG())
                case 1 { b := selfbalance() }
                default {
                    mstore(0, shl(224, 0x70a08231))   // balanceOf(address)
                    mstore(0x04, address())
                    if iszero(staticcall(gas(), tag, 0, 0x24, 0, 0x20)) { revert(0, 0) }
                    if lt(returndatasize(), 0x20) { revert(0, 0) }
                    b := mload(0)
                }
            }

            // EIP-8272 write: calldata salt || root, source_id = keccak256(registry || salt).
            function recordRoot(root) {
                mstore(0, SALT())
                mstore(0x20, root)
                if iszero(call(gas(), 0x8272, 0, 0, 0x40, 0, 0)) { revert(0, 0) }
                mstore(0, root)
                mstore(0x20, slotnum())
                log1(0, 0x40, 0x2fd31368794d8179a2869e743a7fb1d8819c4b52d4154ba95ddbba7cf39a8552) // RecentRoot(bytes32 root, uint64 slot)
                tstore(T_INSERTED(), 0)
            }

            // Anyone may publish the current root again, so that a registry with no recent
            // insertion still has a root inside the EIP-8272 window.
            function republish() {
                recordRoot(sload(2))
                stop()
            }

            function sourceId() -> id {
                mstore(0, address())
                mstore(0x20, SALT())
                id := keccak256(12, 52)
            }

            // ---- constants ----

            // Frame floors: what frame 2 must be given so that it cannot run out once its nonce
            // keys are used. Execution: a spend's bookkeeping; an export's call, swap and
            // call-back; a completion's three MiMC permutations; an on-chain insertion. State:
            // a fresh account or slot (EIP-8037).
            function FLOOR_SPEND() -> g { g := 150000 }
            function FLOOR_EXPORT() -> g { g := 400000 }
            function COMPLETE_EXECUTION() -> g { g := 120000 }
            // Adding one leaf: an on-chain insertion (MODE 0), or an accumulator update and at
            // most one checkpoint (MODE 1). Fresh slots: an insertion may write the root and a
            // subtree; an append, a checkpoint.
            function LEAF_EXECUTION() -> g {
                switch MODE()
                case 0 { g := 1200000 }
                default { g := 60000 }
            }
            function LEAF_SLOTS() -> n {
                switch MODE()
                case 0 { n := 2 }
                default { n := 1 }
            }
            function FLOOR_BATCH() -> g { g := 120000 }
            function PAYOUT_STIPEND() -> g { g := 50000 }
            function NEW_ACCOUNT_STATE() -> g { g := 183600 }
            function SLOT_STATE() -> g { g := 97920 }

            // Transient slots for the export in flight.
            function T_INEXPORT() -> t { t := 1 }
            function T_EXPECT() -> t { t := 2 }
            function T_HOW() -> t { t := 3 }
            function T_TAGOUT() -> t { t := 4 }
            function T_MIN() -> t { t := 5 }
            function T_N() -> t { t := 6 }
            function T_BAL() -> t { t := 7 }
            function T_DONE() -> t { t := 8 }
            function T_INSERTED() -> t { t := 9 }
            function T_PARTIAL() -> t { t := 0x10 }

            function ETH_TAG() -> t { t := 0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee }
            // BN254 scalar field, Tornado's FIELD_SIZE.
            function FIELD() -> f { f := 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001 }

            // Constructor words, counted from the end of the code.
            function SALT() -> v { v := word(32) }
            function MODE() -> v { v := word(64) }
            function HASHER() -> v { v := word(96) }
            function V_KERNEL() -> v { v := word(128) }
            function V_IMPORT() -> v { v := word(160) }
            function V_BATCH() -> v { v := word(192) }
            function V_ROUND() -> v { v := word(224) }
            function word(fromEnd) -> v {
                codecopy(0x60, sub(codesize(), fromEnd), 32)
                v := mload(0x60)
            }

            function zero(level) -> z {
                datacopy(0x60, add(dataoffset("zeros"), shl(5, level)), 32)
                z := mload(0x60)
            }

            function mapslot(key, tag) -> s {
                mstore(0, key)
                mstore(0x20, tag)
                s := keccak256(0, 0x40)
            }

            function ret(v) {
                mstore(0, v)
                return(0, 0x20)
            }

            // EIP-8141 opcodes, and EIP-7843 SLOTNUM. verbatim puts its first argument on top.
            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function framedataload(offset, frame) -> v { v := verbatim_2i_1o(hex"b1", offset, frame) }
            function framedatacopy(memOffset, dataOffset, length, frame) {
                verbatim_4i_0o(hex"b2", memOffset, dataOffset, length, frame)
            }
            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
            function slotnum() -> v { v := verbatim_0i_1o(hex"4b") }
        }
        // zeros(0) .. zeros(20) of Tornado's tree, as tornado-core hard-codes them.
        data "zeros" hex"2fe54c60d3acabf3343a35b6eba15db4821b340f76e741e2249685ed4899af6c256a6135777eee2fd26f54b8b7037a25439d5235caee224154186d2b8a52e31d1151949895e82ab19924de92c40a3d6f7bcb60d92b00504b8199613683f0c20020121ee811489ff8d61f09fb89e313f14959a0f28bb428a20dba6b0b068b3bdb0a89ca6ffa14cc462cfedb842c30ed221a50a3d6bf022a6a57dc82ab24c157c924ca05c2b5cd42e890d6be94c68d0689f4f21c9cec9c0f13fe41d566dfb549591ccb97c932565a92c60156bdba2d08f3bf1377464e025cee765679e604a7315c19156fbd7d1a8bf5cba8909367de1b624534ebab4f0f79e003bccdd1b182bdb4261af8c1f0912e465744641409f622d466c3920ac6e5ff37e36604cb11dfff800058459724ff6ca5a1652fcbc3e82b93895cf08e975b19beab3f54c217d1c0071f04ef20dee48d39984d8eabe768a70eafa6310ad20849d4573c3c40c2ad1e301bea3dec5dab51567ce7e200a30f7ba6d4276aeaa53e2686f962a46c66d511e50ee0f941e2da4b9e31c3ca97a40d8fa9ce68d97c084177071b3cb46cd3372f0f1ca9503e8935884501bbaf20be14eb4c46b89772c97b96e3b2ebf3a36a948bbd133a80e30697cd55d8f7d4b0965b7be24057ba5dc3da898ee2187232446cb10813e6d8fc88839ed76e182c2a779af5b2c0da9dd18c90427a644f7e148a6253b61eb16b057a477f4bc8f572ea6bee39561098f78f15bfb3699dcbb7bd8db618540da2cb16a1ceaabf1c16b838f7a9e3f2a3a3088d9e0a6debaa748114620696ea24a3b3d822420b14b5d8cb6c28a574f01e98ea9e940551d2ebd75cee12649f9d198622acbd783d1b0d9064105b1fc8e4d8889de95c4c519b3f635809fe6afc0529d7ed391256ccc3ea596c86e933b89ff339d25ea8ddced975ae2fe30b5296d4"
    }
}
