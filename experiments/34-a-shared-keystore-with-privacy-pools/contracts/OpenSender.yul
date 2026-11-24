// Experiment 34, arm B: the sender of the transactions that carry an ownership dependency. Its
// VERIFY approves any transaction, execution and payment, and it pays from its balance, which the
// dev account funds. Who sends is not what arm B tests; the pool's ownership check is.
object "OpenSender" {
    code {
        datacopy(0, dataoffset("runtime"), datasize("runtime"))
        return(0, datasize("runtime"))
    }
    object "runtime" {
        code {
            if eq(caller(), 0xaa) {
                let frame := verbatim_1i_1o(hex"b0", 0x0a)
                if eq(verbatim_2i_1o(hex"b3", frame, 0x02), 1) { verbatim_3i_0o(hex"aa", 0, 0, 3) }
            }
            stop()
        }
    }
}
